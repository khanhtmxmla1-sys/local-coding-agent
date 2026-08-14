# Public MCP Proxy Security

This profile is for a trusted Windows machine that intentionally exposes high-privilege MCP tools through a public ngrok URL.

## Security boundary

The reverse proxy is the single public security boundary. Bearer authentication remains the default and is the recommended mode. `No Auth` is an explicit runtime opt-in for clients that cannot send the configured bearer header; it does **not** make a public high-privilege MCP endpoint private.

Recommended default topology:

```text
ChatGPT / MCP client
        |
        | Authorization: Bearer <global proxy token>
        v
public ngrok URL
        |
        v
127.0.0.1:8000 mcp-reverse-proxy.cjs
        |
        +--> 127.0.0.1:8787 Local Coding Agent
        +--> stdio MCP child processes
```

The proxy binds to `127.0.0.1` by default. ngrok running on the same machine can still forward to it, while other LAN hosts cannot connect directly to port 8000.

## Required local secret store

Copy `docs/mcp-proxy-secrets.example.json` to `.mcp-proxy-secrets.json` in the repository root and fill provider values locally. The real file is gitignored.

Bearer mode requires `proxyAuthToken` (or `MCP_PROXY_AUTH_TOKEN`) and fails closed when no token is configured. No Auth mode is enabled only by explicitly setting `MCP_PROXY_REQUIRE_AUTH=0`; the source default remains authenticated.

Environment variables override values in the local file. Supported proxy variables include:

- `MCP_PROXY_AUTH_TOKEN`
- `MCP_PROXY_REQUIRE_AUTH` (default `1`; set `0` only as an explicit No Auth opt-in)
- `MCP_PROXY_HOST` (default `127.0.0.1`)
- `MCP_PROXY_PORT` (default `8000`)
- `MCP_PROXY_ALLOWED_ORIGINS` (default empty; browser origins are rejected)
- `MCP_PROXY_MAX_BODY_BYTES` (default 2 MiB for SSE `/message` bodies)
- `MCP_PROXY_MAX_LCA_BODY_BYTES` (default 16 MiB before forwarding `/mcp`/LCA POST bodies, matching the Local Coding Agent default contract)
- `MCP_PROXY_RATE_LIMIT_PER_MINUTE` (default `600`, global per proxy process)
- `MCP_PROXY_RATE_WINDOW_MS` (default `60000`)
- `MCP_PROXY_MAX_SSE_CONNECTIONS` (default `32`, global child/SSE cap)
- provider variables such as `FIGMA_API_KEY`, `STITCH_API_KEY`, `NOTION_API_KEY`, `SENTRY_ACCESS_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `FIRECRAWL_API_KEY`, and `CLOUDFLARE_ACCOUNT_ID`.

Invalid numeric hardening values fail at startup instead of silently disabling the guard.

## Authentication behavior

### Bearer mode — default

Every public MCP route requires the same bearer token. The proxy consumes the `Authorization` header and does not forward it to Local Coding Agent or child MCP servers. SSE `/message` continuation requests may continue an already authenticated SSE connection without repeating the token.

### No Auth mode — explicit opt-in

Set `MCP_PROXY_REQUIRE_AUTH=0` only when the MCP client must use `Authentication = No Auth`. The bearer access check is then disabled, but the proxy still strips authorization/cookie material before forwarding, keeps provider credentials in the local secret store, and retains all non-auth hardening controls.

No Auth means anyone who can reach the public ngrok URL can attempt to call the exposed MCP routes. Rate/concurrency limits reduce abuse impact but are **not** an identity boundary and do not replace authentication.

Connection IDs are generated with cryptographically secure random bytes in both modes.

## Hardening behavior

- default source behavior remains fail-closed Bearer authentication;
- no wildcard CORS; browser origins must be explicitly configured;
- a global request budget limits request floods before route handling;
- the number of simultaneously active SSE/child MCP processes is globally bounded;
- `/mcp` POST bodies are buffered only up to the configured outer body limit before Local Coding Agent is contacted;
- request bodies sent to SSE child processes are size-limited;
- credentials are not hardcoded in the proxy source;
- bearer/cookie/proxy-authorization headers are stripped before forwarding to Local Coding Agent;
- logs are redacted and request bodies are not logged;
- child commands stay on a fixed allowlist and launch with `shell:false`;
- provider-specific routes fail with `503` when a required local credential is missing;
- SSE cleanup follows the response lifecycle so closed streams release child processes;
- the proxy defaults to loopback binding even when ngrok is public.

## ChatGPT migration

For clients that support Bearer authentication, keep the default mode and configure the global proxy token.

If a ChatGPT custom MCP UI only offers `No Auth` for the desired server URL, the operator may explicitly set `MCP_PROXY_REQUIRE_AUTH=0` at runtime and configure the corresponding custom connector as `No Auth`. Keep this as a machine-local runtime choice; do not change the repository default to unauthenticated.

During a No Auth cutover, update local migration inventory metadata from `bearer` to `none` only after the live proxy has been intentionally restarted in No Auth mode and verified. OAuth-based platform connectors such as Gmail/Calendar/Contacts still require separate OAuth authorization.

Never put provider credential values or the dormant proxy token into `mcp-inventory.local.json`.

## Runtime sync rule

The operational install may contain untracked custom proxy/skills/data. Never use `git reset --hard` or `git clean` to update it. Before syncing:

1. back up custom operational files;
2. fetch the user fork;
3. verify the runtime HEAD is an ancestor of the target fork commit;
4. detect untracked files that collide with tracked files in the target;
5. preserve or reconcile those collisions explicitly;
6. fast-forward only after the collision set is resolved;
7. verify exact HEAD, tests, proxy-mode smoke and tool health.

Provider credentials should be moved to the local secret store without rotating them during the sync phase. Rotation is a separate approval gate. Live launcher changes, inventory auth-mode changes, and proxy restart/cutover should also remain a separate approval gate.
