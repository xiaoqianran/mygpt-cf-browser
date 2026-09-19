# mygpt-cf-browser

Cloudflare-hosted Playwright MCP for ChatGPT and other remote MCP clients.

## Architecture

```text
ChatGPT / MCP Client
        |
        | OAuth 2.1 + PKCE S256
        v
Cloudflare Worker
        |
        +-- @cloudflare/workers-oauth-provider
        |     +-- OAuth discovery
        |     +-- authorization code
        |     +-- access / refresh tokens
        |     +-- CIMD
        |     +-- DCR fallback
        |     \-- OAUTH_KV
        |
        +-- @cloudflare/playwright-mcp
              |
              v
        Durable Object
              |
              v
      Cloudflare Browser Run
```

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

`MCP_TOKEN` is used only as the single-user authorization password and as the root secret for signing the authorization form. It is not used as a permanent MCP Bearer token.

## Verification

```bash
node verify.mjs
```

The verification flow checks OAuth discovery, DCR, PKCE, authorization, access and refresh tokens, MCP tool listing, and a live `browser_navigate` call.

## Secrets

Never commit:

- `.mcp-token`
- `.dev.vars`
- `.env*`
- `.wrangler/`
- `node_modules/`
