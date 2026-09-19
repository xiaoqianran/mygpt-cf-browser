import crypto from "node:crypto";

const origin = "https://browser.202820.xyz";
const mcpUrl = origin + "/mcp";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

const challengeResponse = await fetch(mcpUrl, { method: "POST" });
assert(
  challengeResponse.status === 401,
  "Expected /mcp 401, got " + challengeResponse.status,
);
const challenge = challengeResponse.headers.get("www-authenticate") ?? "";
assert(
  challenge.includes("resource_metadata="),
  "Missing OAuth resource_metadata challenge",
);
assert(
  !challenge.includes("Cloudflare-Access"),
  "/mcp must not be protected by Cloudflare Access",
);
console.log("MCP OAuth challenge OK");

const resourceMetaResponse = await fetch(
  origin + "/.well-known/oauth-protected-resource/mcp",
);
assert(resourceMetaResponse.ok, "Protected-resource discovery failed");
const resourceMeta = await resourceMetaResponse.json();
assert(
  resourceMeta.resource === mcpUrl,
  "Protected resource metadata has wrong resource",
);
assert(
  resourceMeta.scopes_supported?.includes("browser"),
  "Protected resource metadata missing browser scope",
);
console.log("protected-resource discovery OK");

const serverMetaResponse = await fetch(
  origin + "/.well-known/oauth-authorization-server",
);
assert(serverMetaResponse.ok, "Authorization-server discovery failed");
const serverMeta = await serverMetaResponse.json();
assert(
  serverMeta.authorization_endpoint === origin + "/authorize",
  "Wrong authorization endpoint",
);
assert(
  serverMeta.token_endpoint === origin + "/oauth/token",
  "Wrong token endpoint",
);
assert(
  serverMeta.registration_endpoint === origin + "/oauth/register",
  "DCR endpoint missing",
);
assert(
  serverMeta.code_challenge_methods_supported?.includes("S256"),
  "PKCE S256 missing",
);
assert(
  serverMeta.scopes_supported?.includes("browser"),
  "Authorization metadata missing browser scope",
);
console.log("authorization-server discovery OK");

const redirectUri = "http://127.0.0.1/callback";
const registrationResponse = await fetch(origin + "/oauth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "mygpt-cf-browser-verify",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
if (!registrationResponse.ok) {
  throw new Error(
    "DCR failed: " +
      registrationResponse.status +
      " " +
      (await registrationResponse.text()),
  );
}
const registration = await registrationResponse.json();
assert(registration.client_id, "DCR did not return client_id");
console.log("DCR OK");

const verifier = base64url(crypto.randomBytes(48));
const challengeValue = base64url(
  crypto.createHash("sha256").update(verifier).digest(),
);
const state = base64url(crypto.randomBytes(18));
const authorizeUrl = new URL(origin + "/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", registration.client_id);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("scope", "browser");
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("code_challenge", challengeValue);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("resource", mcpUrl);

const authorizeResponse = await fetch(authorizeUrl, {
  redirect: "manual",
});
assert(
  authorizeResponse.status === 302,
  "Expected Cloudflare Access redirect, got " + authorizeResponse.status,
);
const accessLocation = authorizeResponse.headers.get("location") ?? "";
const accessChallenge =
  authorizeResponse.headers.get("www-authenticate") ?? "";
assert(
  accessLocation.includes("cloudflareaccess.com/cdn-cgi/access/login"),
  "Authorization endpoint did not redirect to Cloudflare Access",
);
assert(
  accessChallenge.includes("Cloudflare-Access"),
  "Authorization endpoint missing Cloudflare Access challenge",
);
console.log("Cloudflare Access boundary OK");

console.log("OAuth + Cloudflare Access smoke PASS");
console.log(
  "Interactive token issuance is completed by signing in with the Cloudflare account and pressing Authorize.",
);
