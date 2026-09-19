# mygpt-cf-browser

Remote browser automation for ChatGPT and other MCP clients, powered by Cloudflare Browser Rendering.

## Architecture

```text
ChatGPT / MCP Client
        |
        | OAuth 2.1 + PKCE S256
        v
Cloudflare Worker
        |
        +-- OAuth discovery / token endpoints
        |
        +-- /authorize
        |      |
        |      v
        |   Cloudflare Access
        |      |
        |      +-- Cloudflare account login
        |      +-- Account Member policy
        |      \-- consent-only Authorize
        |
        +-- @cloudflare/workers-oauth-provider
        |      +-- authorization code
        |      +-- access / refresh tokens
        |      +-- CIMD
        |      +-- DCR fallback
        |      \-- OAUTH_KV
        |
        \-- @cloudflare/playwright-mcp
               |
               v
         Durable Object
               |
               v
       Cloudflare Browser Rendering
```

Only `/authorize` is protected by Cloudflare Access. The MCP endpoint, OAuth discovery endpoints, and token endpoint remain machine-accessible so remote MCP clients can complete OAuth discovery and token exchange.

## Production endpoint

```text
https://browser.202820.xyz/mcp
```

The deployed Cloudflare Worker currently keeps the existing Worker name `mygpt-browser-mcp` so the production custom domain remains unchanged.

## Setup

```bash
npm install
npx wrangler kv namespace create OAUTH_KV
npx wrangler secret put MCP_TOKEN
npx wrangler deploy
```

Update the `OAUTH_KV` namespace ID in `wrangler.toml` after creating a namespace.

Configure Cloudflare Access for the `/authorize` path with:

- Cloudflare as the identity provider
- `restrict_to_account_members = true`
- an Allow policy using the Cloudflare Account Member selector
- automatic redirect to the Cloudflare identity provider

`MCP_TOKEN` is an internal signing secret used only to protect the consent form against tampering. Users never enter it, and it is never used as a permanent MCP Bearer token.

## Verification

```bash
node verify.mjs
```

The smoke test checks the MCP OAuth challenge, protected-resource discovery, authorization-server discovery, DCR, PKCE construction, and that only `/authorize` is intercepted by Cloudflare Access.

The final authorization-code and token flow is intentionally interactive because Cloudflare Access verifies the user's Cloudflare account before the consent page is shown.

## Secrets

Never commit:

- `.mcp-token`
- `.dev.vars`
- `.env*`
- `.wrangler/`
- `node_modules/`
