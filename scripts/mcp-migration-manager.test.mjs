import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMigrationBundle,
  importMcpConfigObject,
  sanitizeUrl,
  writeMigrationArtifacts
} from "./mcp-migration-manager.mjs";

test("sanitizeUrl strips credentials, fragments and secret query values", () => {
  const out = sanitizeUrl("https://user:pass@example.com/mcp?token=super-secret&mode=fast#frag");
  assert.equal(out.url, "https://example.com/mcp?mode=fast");
  assert.equal(out.sanitized, true);
  assert.deepEqual(out.removed_query_keys, ["token"]);
});

test("mcpServers import never carries env/header secret values into the manifest", () => {
  const source = {
    mcpServers: {
      GitHub: {
        url: "https://mcp.example.test/mcp?api_key=TOPSECRET&safe=1",
        headers: { Authorization: "Bearer ABC123", "X-Trace": "trace-value" },
        env: { GITHUB_TOKEN: "ghp_SUPERSECRET", NORMAL_MODE: "safe" }
      },
      Playwright: {
        command: "node",
        args: ["server.mjs", "--token", "ARGSECRET", "--safe"]
      }
    }
  };

  const { connectors, warnings } = importMcpConfigObject(source, { sourceName: "sample.json" });
  const text = JSON.stringify({ connectors, warnings });

  for (const secret of ["TOPSECRET", "ABC123", "ghp_SUPERSECRET", "trace-value", "ARGSECRET"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }

  assert.equal(connectors.length, 2);
  assert.equal(connectors[0].endpoint, "https://mcp.example.test/mcp?safe=1");
  assert.deepEqual(connectors[0].auth.secret_refs.sort(), ["GITHUB_TOKEN", "header:Authorization"].sort());
  assert.deepEqual(connectors[0].env_keys.sort(), ["GITHUB_TOKEN", "NORMAL_MODE"].sort());
  assert.deepEqual(connectors[0].header_keys.sort(), ["Authorization", "X-Trace"].sort());
  assert.deepEqual(connectors[1].args, ["server.mjs", "--token", "<redacted>", "--safe"]);
});

test("buildMigrationBundle classifies healthy and auth-required HTTP MCP endpoints without sending secrets", async () => {
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || null);
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(401);
    res.end("auth required");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const inventory = {
      version: 1,
      connectors: [
        {
          id: "local-coding",
          name: "Local Coding",
          transport: "http",
          endpoint: `http://127.0.0.1:${port}/mcp`,
          health_url: `http://127.0.0.1:${port}/healthz`,
          auth: { type: "bearer", required: true, secret_env: "MCP_AUTH_TOKEN" }
        },
        {
          id: "auth-only",
          name: "Auth Only",
          transport: "http",
          endpoint: `http://127.0.0.1:${port}/mcp`,
          auth: { type: "oauth", required: true, provider: "Example" }
        }
      ]
    };

    const bundle = await buildMigrationBundle({ inventory, checkHealth: true, timeoutMs: 1000 });
    const healthById = new Map(bundle.health.connectors.map((item) => [item.id, item]));
    const manifestById = new Map(bundle.manifest.connectors.map((item) => [item.id, item]));
    assert.equal(healthById.get("local-coding").status, "healthy");
    assert.equal(healthById.get("auth-only").status, "auth_required");
    assert.equal(seenAuth.every((value) => value === null), true, "health probes must not send auth headers");
    assert.deepEqual(manifestById.get("local-coding").auth.secret_refs, ["MCP_AUTH_TOKEN"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("writeMigrationArtifacts creates secret-free manifest, health report and Vietnamese checklist", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "mcp-migration-test-"));
  try {
    const bundle = await buildMigrationBundle({
      inventory: {
        version: 1,
        connectors: [
          {
            id: "github",
            name: "GitHub MCP",
            transport: "http",
            endpoint: "https://example.test/mcp",
            auth: { type: "oauth", required: true, provider: "GitHub" },
            notes: ["Authorize again on the new account"]
          }
        ]
      },
      checkHealth: false
    });

    const paths = writeMigrationArtifacts(bundle, dir);
    const manifest = readFileSync(paths.manifest, "utf8");
    const health = readFileSync(paths.health, "utf8");
    const checklist = readFileSync(paths.checklist, "utf8");

    assert.match(manifest, /GitHub MCP/);
    assert.match(health, /not_checked/);
    assert.match(checklist, /Tài khoản ChatGPT mới/);
    assert.match(checklist, /GitHub MCP/);
    assert.match(checklist, /OAuth/);
    assert.equal(checklist.includes("TOPSECRET"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
