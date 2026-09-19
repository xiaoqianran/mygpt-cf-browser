import { WorkerEntrypoint } from "cloudflare:workers";
import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  isJSONRPCNotification,
  isJSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { PlaywrightMCP } from "./browser-agent";

export { PlaywrightMCP };

const ORIGIN = "https://browser.202820.xyz";
const MCP_URL = ORIGIN + "/mcp";
const SCOPE = "browser";
const FORM_TTL_SECONDS = 300;
const encoder = new TextEncoder();

interface Env {
  BROWSER: unknown;
  MCP_OBJECT: DurableObjectNamespace<PlaywrightMCP>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_TOKEN: string;
}

interface AuthProps extends Record<string, unknown> {
  userId: string;
  scopes: string[];
}

async function stableMcpFetch(
  request: Request,
  env: Env,
  props: AuthProps,
): Promise<Response> {
  if (request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST, DELETE" },
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  let rawMessage: unknown;
  try {
    rawMessage = await request.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }

  const rawMessages = Array.isArray(rawMessage) ? rawMessage : [rawMessage];
  const messages: Array<ReturnType<typeof JSONRPCMessageSchema.parse>> = [];
  for (const message of rawMessages) {
    const parsed = JSONRPCMessageSchema.safeParse(message);
    if (!parsed.success) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        },
        { status: 400 },
      );
    }
    messages.push(parsed.data);
  }

  const mcpSessionId = `browser-${props.userId}`;
  const durableId = env.MCP_OBJECT.idFromName(mcpSessionId);
  const stub = env.MCP_OBJECT.get(durableId);
  const hasInitialize = messages.some((message) =>
    InitializeRequestSchema.safeParse(message).success,
  );
  const primaryRequest = messages.find(isJSONRPCRequest);

  if (hasInitialize || !(await stub.isInitialized())) {
    await stub._init(props);
    await stub.setInitialized();
  }

  const upgradeUrl = new URL(request.url);
  upgradeUrl.pathname = "/streamable-http";
  let transportResponse: Response;
  try {
    transportResponse = await stub.fetch(
      new Request(upgradeUrl, {
        headers: {
          Upgrade: "websocket",
          "x-partykit-room": mcpSessionId,
        },
      }),
    );
  } catch (error) {
    console.error("stable-mcp:stub-fetch-error", String(error));
    const body = `event: message\r\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: primaryRequest?.id ?? null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    })}\r\n\r\n`;
    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
        "mcp-session-id": mcpSessionId,
      },
    });
  }

  const ws = transportResponse.webSocket;
  if (!ws) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "MCP transport unavailable" },
      },
      { status: 500 },
    );
  }

  ws.accept();

  const requestIds = new Set(
    messages
      .filter(isJSONRPCRequest)
      .map((message) => String(message.id)),
  );

  if (requestIds.size === 0) {
    for (const message of messages) {
      ws.send(JSON.stringify(message));
    }
    ws.close();
    return new Response(null, {
      status: 202,
      headers: { "mcp-session-id": mcpSessionId },
    });
  }

  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for MCP response"));
    }, 30_000);

    ws.addEventListener("message", (event) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const message = JSON.parse(data);
        const id =
          message && typeof message === "object" && "id" in message
            ? String(message.id)
            : undefined;
        if (id !== undefined && requestIds.has(id)) {
          clearTimeout(timeout);
          resolve(message);
          ws.close();
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        ws.close();
      }
    });

    ws.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(event);
    });

    for (const message of messages) {
      if (isJSONRPCNotification(message) || isJSONRPCRequest(message)) {
        ws.send(JSON.stringify(message));
      }
    }
  });

  const body = `event: message\r\ndata: ${JSON.stringify(result)}\r\n\r\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      "mcp-session-id": mcpSessionId,
    },
  });
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    if (!this.ctx.props.scopes.includes(SCOPE)) {
      return new Response("Forbidden", { status: 403 });
    }
    return stableMcpFetch(request, this.env, this.ctx.props);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function authPayload(request: AuthRequest, expiresAt: number): string {
  return JSON.stringify({
    expiresAt,
    responseType: request.responseType,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    codeChallenge: request.codeChallenge ?? null,
    codeChallengeMethod: request.codeChallengeMethod ?? null,
    resource: request.resource ?? null,
    issuer: request.issuer ?? null,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode("browser-mcp-form-signing\0" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signAuthRequest(
  request: AuthRequest,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(authPayload(request, expiresAt)),
  );
  return base64Url(new Uint8Array(signature));
}

async function verifyAuthRequest(
  request: AuthRequest,
  expiresAt: number,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await importHmacKey(secret);
    return crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      encoder.encode(authPayload(request, expiresAt)),
    );
  } catch {
    return false;
  }
}

function authErrorRedirect(
  request: AuthRequest,
  code: string,
  description: string,
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

function authorizationErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    return new Response(error.description, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function authPage(
  request: Request,
  oauthRequest: AuthRequest,
  clientName: string,
  expiresAt: number,
  signature: string,
): Response {
  const requestedScopes = oauthRequest.scope.join(" ");
  const target = new URL(oauthRequest.redirectUri).origin;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Authorize Browser MCP</title>" +
    "<style>" +
    ":root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}" +
    "body{min-height:100vh;margin:0;display:grid;place-items:center;background:Canvas;color:CanvasText}" +
    "main{width:min(420px,calc(100vw - 40px));border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;padding:24px}" +
    "h1{margin:0 0 8px;font-size:20px}p{margin:8px 0;line-height:1.5;opacity:.82}" +
    "dl{margin:18px 0;font-size:13px}dt{opacity:.6;margin-top:10px}dd{margin:2px 0 0;overflow-wrap:anywhere}" +
    "button{width:100%;margin-top:12px;padding:11px 14px;border:0;border-radius:9px;font-weight:650;cursor:pointer}" +
    "</style></head><body><main>" +
    "<h1>Authorize Browser MCP</h1>" +
    "<p>Your Cloudflare account has been verified. Grant this OAuth client access to the Playwright MCP.</p>" +
    "<dl><dt>Client</dt><dd>" + escapeHtml(clientName) + "</dd>" +
    "<dt>Scope</dt><dd>" + escapeHtml(requestedScopes) + "</dd>" +
    "<dt>Redirect</dt><dd>" + escapeHtml(target) + "</dd></dl>" +
    '<form method="post" action="' + escapeHtml(request.url) + '">' +
    '<input type="hidden" name="expires_at" value="' + expiresAt + '">' +
    '<input type="hidden" name="signature" value="' + escapeHtml(signature) + '">' +
    '<button type="submit">Authorize</button></form></main></body></html>';

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Chrome also applies form-action to redirects after form submission.
      // target is safe here because parseAuthRequest validated redirectUri first.
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action ${ORIGIN} ${target}; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest: AuthRequest;

  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authorizationErrorResponse(error);
    }
    throw error;
  }

  if (oauthRequest.scope.length !== 1 || oauthRequest.scope[0] !== SCOPE) {
    return authErrorRedirect(
      oauthRequest,
      "invalid_scope",
      'The only supported scope is "' + SCOPE + '".',
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return new Response("Unknown OAuth client", { status: 400 });
  }

  const clientName = client.clientName ?? client.clientId;

  if (request.method === "GET") {
    const expiresAt = Math.floor(Date.now() / 1000) + FORM_TTL_SECONDS;
    const signature = await signAuthRequest(
      oauthRequest,
      expiresAt,
      env.MCP_TOKEN,
    );
    return authPage(
      request,
      oauthRequest,
      clientName,
      expiresAt,
      signature,
    );
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  }

  const form = await request.formData();
  const signature = String(form.get("signature") ?? "");
  const expiresAt = Number(form.get("expires_at"));
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt > now + FORM_TTL_SECONDS ||
    !(await verifyAuthRequest(
      oauthRequest,
      expiresAt,
      signature,
      env.MCP_TOKEN,
    ))
  ) {
    return new Response("Invalid or expired authorization request", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: "owner",
    metadata: { clientName },
    scope: [SCOPE],
    props: {
      userId: "owner",
      scopes: [SCOPE],
    },
  });

  return Response.redirect(redirectTo, 302);
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/") {
      return Response.json({
        name: "MyGPT Browser MCP",
        mcp: MCP_URL,
        authorization: ORIGIN,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [SCOPE],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  clientRegistrationTTL: 7_776_000,
  allowPlainPKCE: false,
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: MCP_URL,
    authorization_servers: [ORIGIN],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "MyGPT Browser MCP",
  },
});
