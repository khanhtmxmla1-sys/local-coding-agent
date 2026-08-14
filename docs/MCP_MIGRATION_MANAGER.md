# MCP Migration Manager

MCP Migration Manager creates a **secret-free migration pack** for moving MCP
connectors to another ChatGPT account or MCP client.

It does **not** read or modify the ChatGPT account itself. ChatGPT does not expose
a safe local API for exporting custom connector configuration. Instead, the
manager keeps one local inventory and can import common JSON configs containing
an `mcpServers` object.

## What it produces

Running `audit` creates:

- `mcp-migration-manifest.json` — connector names, transports, endpoints and
  secret *reference names* only;
- `mcp-migration-health.json` — endpoint/command reachability without sending
  authentication headers;
- `mcp-migration-checklist.md` — Vietnamese migration checklist for the new
  ChatGPT account.

Secret values are never intentionally exported. URL credentials, secret query
parameters, header values, environment values and secret CLI arguments are
removed/redacted.

## Quick start

```powershell
node scripts\mcp-migration-manager.mjs init
```

This creates `mcp-inventory.local.json` (gitignored). Edit connector metadata,
but keep tokens/passwords/API keys in environment variables or your secret
manager.

For Local Coding Agent, set the public MCP endpoint only for the current shell:

```powershell
$env:MCP_MIGRATION_LOCAL_CODING_ENDPOINT = "https://YOUR-DOMAIN.example/mcp"
node scripts\mcp-migration-manager.mjs audit
```

Outputs are written to `mcp-migration-output\` (also gitignored).

## Import an existing MCP JSON config

The manager accepts JSON containing either this tool's `connectors[]` format or
a common `mcpServers{}` object:

```powershell
node scripts\mcp-migration-manager.mjs audit `
  --inventory .\mcp-inventory.local.json `
  --import C:\path\to\another-mcp-config.json
```

For imported `mcpServers` entries:

- `env` values are discarded; only variable names remain;
- `headers` values are discarded; only header names remain;
- URL username/password, fragments and query keys such as `token`, `api_key`,
  `secret`, `password`, `signature` are stripped;
- arguments following flags such as `--token` or `--api-key` are redacted.

## Inventory schema

```json
{
  "version": 1,
  "connectors": [
    {
      "id": "local-coding-agent",
      "name": "Local Coding Agent",
      "transport": "http",
      "endpoint_env": "MCP_MIGRATION_LOCAL_CODING_ENDPOINT",
      "health_url": "http://127.0.0.1:8787/healthz",
      "auth": {
        "type": "bearer",
        "required": true,
        "secret_env": "MCP_AUTH_TOKEN"
      }
    },
    {
      "id": "github-mcp",
      "name": "GitHub MCP",
      "transport": "http",
      "endpoint": "https://example.invalid/mcp",
      "auth": {
        "type": "oauth",
        "required": true,
        "provider": "GitHub"
      }
    }
  ]
}
```

Supported transports are `http` and `stdio`.

## Health behavior

The health checker deliberately sends **no Authorization header and no secret**.
For HTTP connectors it checks `health_url` when provided, otherwise `endpoint`.
A `401` or `403` is classified as `auth_required` (reachable, but authentication
is needed). For stdio connectors it checks whether the configured command is
available.

Skip health checks when preparing an offline package:

```powershell
node scripts\mcp-migration-manager.mjs audit --no-health
```

## Recommended migration flow

1. Maintain one `mcp-inventory.local.json` on the machine hosting your MCPs.
2. Run `audit` before switching ChatGPT accounts.
3. Open `mcp-migration-checklist.md`.
4. Add each connector to the new account.
5. Re-authorize OAuth connectors on the new account.
6. Resolve bearer/API-key references from your secret manager/environment.
7. Scan tools and run a read-only smoke test first.
8. Only then enable/write-test higher-risk connectors such as Local Coding Agent.

Never commit `mcp-inventory.local.json`, generated migration output, tokens,
API keys, OAuth credentials, tunnel credentials, or authorization headers.
