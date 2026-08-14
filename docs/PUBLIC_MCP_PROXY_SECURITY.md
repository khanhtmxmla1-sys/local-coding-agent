# Public MCP Proxy Security

This profile is for a trusted Windows machine that intentionally exposes high-privilege MCP tools through a public ngrok URL.

## Security boundary

The reverse proxy is the single public authentication gate. Backends such as Local Coding Agent, Filesystem, Git, Playwright, Cloudflare, GitHub and other stdio MCP servers remain local.

Recommended topology:

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

Copy `docs/mcp-proxy-secrets.example.json` to `.mcp-proxy-secrets.json` in the repository root and fill values locally. The real file is gitignored.

At minimum, public mode requires `proxyAuthToken`. The proxy fails closed at startup if authentication is required and no token is configured.

Environment variables override values in the local file. Supported variables include:

- `MCP_PROXY_AUTH_TOKEN`
- `MCP_PROXY_REQUIRE_AUTH` (default `1`)
- `MCP_PROXY_HOST` (default `127.0.0.1`)
- `MCP_PROXY_PORT` (default `8000`)
- `MCP_PROXY_ALLOWED_ORIGINS` (default empty; browser origins are rejected)
- `MCP_PROXY_MAX_BODY_BYTES` (default 2 MiB)
- provider variables such as `FIGMA_API_KEY`, `STITCH_API_KEY`, `NOTION_API_KEY`, `SENTRY_ACCESS_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `FIRECRAWL_API_KEY`, and `CLOUDFLARE_ACCOUNT_ID`.

## Authentication behavior

Every public MCP route requires the same bearer token. The proxy consumes the `Authorization` header and does not forward it to Local Coding Agent or child MCP servers.

SSE `/message` continuation requests are accepted when they reference an active authenticated SSE connection. Connection IDs are generated with cryptographically secure random bytes. Unknown `/message` connections still require the bearer token.

## Hardening behavior

- no wildcard CORS; browser origins must be explicitly configured;
- request bodies sent to SSE child processes are size-limited;
- credentials are no longer hardcoded in the proxy source;
- bearer/cookie headers are stripped before forwarding to Local Coding Agent;
- logs are redacted and request bodies are not logged;
- provider-specific routes fail with `503` when a required local credential is missing;
- the proxy defaults to loopback binding even when ngrok is public.

## ChatGPT migration

When adding each custom MCP connector to another ChatGPT account, use the same endpoint path as before and configure Bearer authentication with the global proxy token. OAuth-based platform connectors such as Gmail/Calendar/Contacts still require separate OAuth authorization.

Do not put the proxy token into `mcp-inventory.local.json`; the Migration Manager should only record that authentication is required.

## Runtime sync rule

The operational install may contain untracked custom proxy/skills/data. Never use `git reset --hard` or `git clean` to update it. Before syncing:

1. back up custom operational files;
2. fetch the user fork;
3. verify the runtime HEAD is an ancestor of the target fork commit;
4. detect untracked files that collide with tracked files in the target;
5. preserve or reconcile those collisions explicitly;
6. fast-forward only after the collision set is resolved;
7. verify exact HEAD, tests, proxy auth smoke and tool health.

Provider credentials should be moved to the local secret store without rotating them during the sync phase. Rotation is a separate approval gate.
