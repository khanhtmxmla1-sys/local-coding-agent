import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverDir = dirname(fileURLToPath(import.meta.url));

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Candidate server exited before startup (code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Candidate server did not become ready: ${url}`);
}

async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function read(relativePath) {
  return readFile(join(serverDir, relativePath), "utf8");
}

function assertAbsent(source, forbidden, sourceName) {
  for (const token of forbidden) {
    assert.equal(
      source.includes(token),
      false,
      `${sourceName} must not contain ${JSON.stringify(token)}`,
    );
  }
}

test("candidate server omits Task Hub while preserving core tools and generic agent APIs", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "task-hub-removal-"));
  const workspace = join(root, "workspace");
  const privateState = join(root, "private-state");
  const port = 19120;
  const dashboardPort = 19121;
  await mkdir(workspace, { recursive: true });

  const child = spawn(process.execPath, [join(serverDir, "server.mjs")], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_PORT: String(dashboardPort),
      AGENT_WORKSPACE: workspace,
      AGENT_PRIVATE_STATE_DIR: privateState,
      AGENT_APPROVALS_DIR: join(privateState, "approvals"),
      AGENT_EXTRA_ROOTS_JSON: "[]",
      AGENT_POLICY: "strict",
      MCP_AUTH_TOKEN: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${port}/healthz`, child).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });

  const client = new Client({ name: "task-hub-removal-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  t.after(() => client.close());

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(names.some((name) => name.startsWith("task_hub_")), false);
  for (const name of [
    "workspace_info",
    "workspace_bootstrap",
    "read_file",
    "run_command",
    "create_local_task",
    "list_local_tasks",
    "request_approval",
  ]) {
    assert.ok(names.includes(name), `core tool missing: ${name}`);
  }

  const dashboard = await (await fetch(`http://127.0.0.1:${dashboardPort}/`)).text();
  assert.equal(dashboard.includes('data-view="tasks"'), false);
  for (const label of ["Phê duyệt", "Tệp &amp; Diff", "/api/approvals", "/api/diff"]) {
    assert.ok(dashboard.includes(label), `dashboard surface missing: ${label}`);
  }

  const agentsResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/agents`);
  assert.equal(agentsResponse.status, 200);
  const agents = await agentsResponse.json();
  assert.equal(agents.enabled, true);
  assert.ok(Array.isArray(agents.agents));
  assert.equal(agents.roles.includes("coding_worker"), false);
  assert.equal(agents.roles.includes("reviewer_worker"), false);

  assert.equal(
    (await fetch(`http://127.0.0.1:${dashboardPort}/api/agent?id=invalid`)).status,
    400,
  );
});

test("Task Hub server and MCP surface is removed", async () => {
  const source = await read("server.mjs");

  assertAbsent(
    source,
    [
      "task_hub_",
      "TaskHubStore",
      "TaskHubDispatcher",
      "registerTaskHubTools",
      "registerTaskHubWorkerTools",
      "AGENT_TASK_HUB_",
    ],
    "server/server.mjs",
  );
});

test("Task Hub-only worker roles are removed", async () => {
  const source = await read("agent-manager.mjs");

  assertAbsent(
    source,
    ["coding_worker", "reviewer_worker", "isTaskHubManagedRole"],
    "server/agent-manager.mjs",
  );
});

test("Task Hub package script and implementation directory are removed", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    Object.hasOwn(packageJson.scripts ?? {}, "test:task-hub"),
    false,
    "server/package.json must not expose test:task-hub",
  );

  await assert.rejects(
    access(join(serverDir, "task-hub")),
    { code: "ENOENT" },
    "server/task-hub must not exist",
  );
});
