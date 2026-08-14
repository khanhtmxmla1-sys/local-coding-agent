import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = path.resolve("server.mjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function startServer(workspace) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: "0",
      AGENT_HOST: "127.0.0.1",
      AGENT_WORKSPACE: workspace,
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENT_MODE: "safe",
      AGENT_POLICY: "full",
      MCP_AUTH_TOKEN: ""
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await waitFor(`http://127.0.0.1:${port}/healthz`).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  return { child, port };
}

async function connect(port) {
  const client = new Client({ name: "agents-compliance-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || "";
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { isError: Boolean(result.isError), text, json };
}

test("workspace AGENTS.md blocks mutation until bootstrap hash is supplied", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-agents-required-"));
  await writeFile(path.join(workspace, "AGENTS.md"), "# Rules\n\n- Read this before writing.\n", "utf8");
  const { child, port } = await startServer(workspace);
  t.after(async () => {
    await stopServer(child);
    await rm(workspace, { recursive: true, force: true });
  });

  const client = await connect(port);
  t.after(() => client.close());

  const readOnlyGit = await call(client, "git", { args: ["--version"] });
  assert.equal(readOnlyGit.isError, false, readOnlyGit.text);

  const blocked = await call(client, "write_file", { path: "blocked.txt", content: "no" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /workspace_bootstrap|AGENTS\.md/i);
  await assert.rejects(access(path.join(workspace, "blocked.txt")));

  const commandBlocked = await call(client, "run_command", {
    command: "node -e \"require('node:fs').writeFileSync('command-blocked.txt','no')\"",
    cwd: "."
  });
  assert.equal(commandBlocked.isError, true);
  assert.match(commandBlocked.text, /workspace_bootstrap|AGENTS\.md/i);
  await assert.rejects(access(path.join(workspace, "command-blocked.txt")));

  const bootstrap = await call(client, "workspace_bootstrap");
  assert.equal(bootstrap.isError, false);
  assert.equal(bootstrap.json?.required, true);
  assert.equal(bootstrap.json?.path, path.join(workspace, "AGENTS.md"));
  assert.equal(typeof bootstrap.json?.sha256, "string");
  assert.equal(bootstrap.json.sha256.length, 64);
  assert.match(bootstrap.json?.instructions || "", /Read this before writing/);

  const allowed = await call(client, "write_file", {
    path: "allowed.txt",
    content: "yes",
    workspace_rules_sha: bootstrap.json.sha256
  });
  assert.equal(allowed.isError, false, allowed.text);
  assert.equal(await readFile(path.join(workspace, "allowed.txt"), "utf8"), "yes");

  await writeFile(path.join(workspace, "AGENTS.md"), "# Rules\n\n- Updated rules must invalidate old hashes.\n", "utf8");
  const stale = await call(client, "write_file", {
    path: "stale.txt",
    content: "no",
    workspace_rules_sha: bootstrap.json.sha256
  });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /changed|invalid|workspace_bootstrap/i);
  await assert.rejects(access(path.join(workspace, "stale.txt")));

  const refreshed = await call(client, "workspace_bootstrap");
  assert.equal(refreshed.isError, false);
  assert.notEqual(refreshed.json?.sha256, bootstrap.json.sha256);
  const refreshedAllowed = await call(client, "write_file", {
    path: "refreshed.txt",
    content: "yes",
    workspace_rules_sha: refreshed.json.sha256
  });
  assert.equal(refreshedAllowed.isError, false, refreshedAllowed.text);
  assert.equal(await readFile(path.join(workspace, "refreshed.txt"), "utf8"), "yes");
});

test("workspace without AGENTS.md preserves current mutation behavior", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-agents-optional-"));
  const { child, port } = await startServer(workspace);
  t.after(async () => {
    await stopServer(child);
    await rm(workspace, { recursive: true, force: true });
  });

  const client = await connect(port);
  t.after(() => client.close());

  const bootstrap = await call(client, "workspace_bootstrap");
  assert.equal(bootstrap.isError, false);
  assert.equal(bootstrap.json?.required, false);

  const allowed = await call(client, "write_file", { path: "legacy.txt", content: "ok" });
  assert.equal(allowed.isError, false, allowed.text);
  assert.equal(await readFile(path.join(workspace, "legacy.txt"), "utf8"), "ok");
});
