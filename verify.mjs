import crypto from "node:crypto";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = "https://browser.202820.xyz";
const mcpUrl = origin + "/mcp";
const password = fs.readFileSync(".mcp-token", "utf8").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formValue(html, name) {
  const pattern =
    'name=["\\\']' +
    name +
    '["\\\'][^>]*value=["\\\']([^"\\\']+)["\\\']';
  const match = html.match(new RegExp(pattern));
  if (!match) throw new Error("Missing form field: " + name);
  return match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
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
  "Missing resource_metadata challenge",
);
console.log("401 challenge OK");

const resourceMeta = await fetch(
  origin + "/.well-known/oauth-protected-resource/mcp",
).then((r) => r.json());
assert(
  resourceMeta.resource === mcpUrl,
  "Protected resource metadata has wrong resource",
);
assert(
  resourceMeta.scopes_supported?.includes("browser"),
  "Protected resource metadata missing browser scope",
);
console.log("protected-resource discovery OK");

const serverMeta = await fetch(
  origin + "/.well-known/oauth-authorization-server",
).then((r) => r.json());
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
    client_name: "mygpt-browser-verify",
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
const clientId = registration.client_id;
assert(clientId, "DCR did not return client_id");
console.log("DCR OK");

const verifier = base64url(crypto.randomBytes(48));
const challengeValue = base64url(
  crypto.createHash("sha256").update(verifier).digest(),
);
const state = base64url(crypto.randomBytes(18));
const authorizeUrl = new URL(origin + "/authorize");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("scope", "browser");
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("code_challenge", challengeValue);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("resource", mcpUrl);

const authorizeGet = await fetch(authorizeUrl);
assert(authorizeGet.ok, "Authorize GET failed: " + authorizeGet.status);
const html = await authorizeGet.text();
const expiresAt = formValue(html, "expires_at");
const signature = formValue(html, "signature");
console.log("signed authorization form OK");

const tamperedUrl = new URL(authorizeUrl);
tamperedUrl.searchParams.set("state", state + "-tampered");
const tamperedPost = await fetch(tamperedUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    password,
    expires_at: expiresAt,
    signature,
  }),
});
assert(
  tamperedPost.status === 302 || tamperedPost.status === 400,
  "Tampered form was not rejected",
);
console.log("tamper rejection OK");

const wrongPasswordPost = await fetch(authorizeUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    password: password + "-wrong",
    expires_at: expiresAt,
    signature,
  }),
});
assert(
  wrongPasswordPost.status === 401,
  "Wrong authorization password was not rejected",
);
console.log("password rejection OK");

const authorizePost = await fetch(authorizeUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    password,
    expires_at: expiresAt,
    signature,
  }),
});
if (authorizePost.status !== 302) {
  throw new Error(
    "Authorize POST failed: " +
      authorizePost.status +
      " " +
      (await authorizePost.text()),
  );
}
const location = authorizePost.headers.get("location");
assert(location, "Authorization redirect missing");
const callback = new URL(location);
assert(
  callback.searchParams.get("state") === state,
  "OAuth state mismatch",
);
const code = callback.searchParams.get("code");
assert(code, "Authorization code missing");
console.log("authorization code OK");

const tokenResponse = await fetch(origin + "/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: mcpUrl,
  }),
});
if (!tokenResponse.ok) {
  throw new Error(
    "Token exchange failed: " +
      tokenResponse.status +
      " " +
      (await tokenResponse.text()),
  );
}
const token = await tokenResponse.json();
assert(token.access_token, "Access token missing");
assert(token.refresh_token, "Refresh token missing");
console.log("access + refresh token OK");

const refreshResponse = await fetch(origin + "/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: token.refresh_token,
    resource: mcpUrl,
  }),
});
if (!refreshResponse.ok) {
  throw new Error(
    "Refresh failed: " +
      refreshResponse.status +
      " " +
      (await refreshResponse.text()),
  );
}
const refreshed = await refreshResponse.json();
assert(refreshed.access_token, "Refreshed access token missing");
console.log("refresh token OK");

const client = new Client({
  name: "mygpt-browser-verify",
  version: "2.0.0",
});
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: {
    headers: {
      Authorization: "Bearer " + refreshed.access_token,
    },
  },
});

await client.connect(transport);

const listed = await client.listTools();
assert(
  listed.tools.some((tool) => tool.name === "browser_navigate"),
  "browser_navigate missing",
);
console.log("listTools OK (" + listed.tools.length + " tools)");

const nav = await client.callTool({
  name: "browser_navigate",
  arguments: { url: "https://example.com" },
});
const navText = JSON.stringify(nav.content);
assert(
  navText.toLowerCase().includes("example"),
  "browser_navigate result did not contain Example",
);
console.log("browser_navigate OK");

await client.close();
console.log("OAuth MCP E2E PASS");
