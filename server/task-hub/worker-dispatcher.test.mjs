import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskHubStore } from "./store.mjs";
import { ProjectRegistry } from "./project-registry.mjs";
import { TaskHubDispatcher } from "./worker-dispatcher.mjs";

const NOW = Date.parse("2026-08-14T00:05:00.000Z");

class FakeAgentManager {
  constructor() {
    this.spawnCalls = [];
    this.meta = new Map();
    this.results = new Map();
    this.settleResolvers = new Map();
  }
  async spawn(input) {
    this.spawnCalls.push(input);
    const agent_id = `a_${String(this.spawnCalls.length).padStart(16, "0")}`;
    this.meta.set(agent_id, { agent_id, status: "running", ...input });
    return { agent_id, status: "running", role: input.role };
  }
  get(id) { return this.meta.get(id) || null; }
  async result(id) { return this.results.get(id) || { agent_id: id, status: this.meta.get(id)?.status, summary: "", content: "", error: null }; }
  async settle(id) {
    if (this.meta.get(id)?.status !== "running") return this.meta.get(id);
    await new Promise((resolve) => this.settleResolvers.set(id, resolve));
    return this.meta.get(id);
  }
  finish(id, { ok = true, summary = "verified worker result" } = {}) {
    const meta = this.meta.get(id);
    meta.status = ok ? "done" : "failed";
    meta.error = ok ? null : summary;
    this.results.set(id, { agent_id: id, status: meta.status, summary, content: summary, error: meta.error });
    this.settleResolvers.get(id)?.();
  }
}

async function harness({ role = "CODING", permissions = { read: true, edit: true, test: true }, allowed_roles = ["CODING", "REVIEWER"], enforceParallelGuards = false, prepareClaimContext = null } = {}) {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "lca-dispatch-store-"));
  const registryDir = await mkdtemp(path.join(os.tmpdir(), "lca-dispatch-registry-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "lca-dispatch-workspace-"));
  let leaseNo = 0;
  const store = new TaskHubStore({ dir: storeDir, now: () => NOW, idFactory: () => `lease-${++leaseNo}`, enforceParallelGuards });
  const registry = new ProjectRegistry({ dir: registryDir, now: () => NOW });
  await registry.register({ id: "tohieuquiz", workspace_root: workspace, allowed_roles });
  await store.createTask({ id: "task-1", project_id: "tohieuquiz", goal: "Do bounded work", role, status: "READY", permissions });
  const agentManager = new FakeAgentManager();
  let workerNo = 0;
  const dispatcher = new TaskHubDispatcher({
    store,
    registry,
    agentManager,
    providerAvailable: () => true,
    prepareClaimContext,
    resolveWorkspace: async (project, task) => ({
      resolved: path.resolve(project.workspace_root),
      can_write: task.role === "CODING",
      has_deny_rules: false,
      permission_profile: "test-profile",
      permission_roots: [{ path: path.resolve(project.workspace_root), preset: task.role === "CODING" ? "develop" : "observe", filesystem: task.role === "CODING" ? "write" : "read", commands: task.role === "CODING" ? "full" : "safe" }]
    }),
    idFactory: () => `worker-${++workerNo}`,
    maxRuntimeMs: 300_000,
    leaseMs: 360_000
  });
  return { storeDir, registryDir, workspace, store, registry, agentManager, dispatcher };
}

async function cleanup(h) {
  await Promise.all([
    rm(h.storeDir, { recursive: true, force: true }),
    rm(h.registryDir, { recursive: true, force: true }),
    rm(h.workspace, { recursive: true, force: true })
  ]);
}

test("dispatcher launches real coding adapter only after READY claim and reconciles DONE to REVIEW", async () => {
  const h = await harness();
  try {
    const dispatched = await h.dispatcher.dispatch("task-1");
    assert.equal(dispatched.task.status, "RUNNING");
    assert.match(dispatched.local_agent_id, /^a_/);
    assert.equal("lease_id" in dispatched, false);
    assert.equal(h.agentManager.spawnCalls.length, 1);
    assert.equal(h.agentManager.spawnCalls[0].role, "coding_worker");
    assert.equal(h.agentManager.spawnCalls[0].provider, "codex_cli");
    assert.equal(h.agentManager.spawnCalls[0].sandbox_mode, "workspace-write");
    assert.deepEqual(h.agentManager.spawnCalls[0].writable_roots, []);
    assert.match(h.agentManager.spawnCalls[0].task, /do not commit|never commit/i);

    const marker = "fixture-private-value";
    const sensitiveField = ["to", "ken"].join("");
    h.agentManager.finish(dispatched.local_agent_id, { summary: `tests passed; {\"${sensitiveField}\":\"${marker}\"}; diff reviewed` });
    await h.dispatcher.settle("task-1");
    const task = await h.store.getTask("task-1");
    assert.equal(task.status, "REVIEW");
    assert.match(task.result_summary, /tests passed/i);
    assert.doesNotMatch(task.result_summary, new RegExp(marker));
    assert.equal(task.lease_owner, null);
  } finally { await cleanup(h); }
});

test("reviewer adapter is forced read-only", async () => {
  const h = await harness({ role: "REVIEWER", permissions: { read: true } });
  try {
    const dispatched = await h.dispatcher.dispatch("task-1");
    assert.equal(h.agentManager.spawnCalls[0].role, "reviewer_worker");
    assert.equal(h.agentManager.spawnCalls[0].sandbox_mode, "read-only");
    assert.deepEqual(h.agentManager.spawnCalls[0].writable_roots, []);
    h.agentManager.finish(dispatched.local_agent_id, { summary: "0 P1/P2 findings" });
    await h.dispatcher.settle("task-1");
    assert.equal((await h.store.getTask("task-1")).status, "REVIEW");
  } finally { await cleanup(h); }
});

test("reviewer refuses project roots with deny rules before claim", async () => {
  const h = await harness({ role: "REVIEWER", permissions: { read: true } });
  try {
    h.dispatcher.resolveWorkspace = async () => ({ resolved: path.resolve(h.workspace), can_write: false, has_deny_rules: true });
    await assert.rejects(() => h.dispatcher.dispatch("task-1"), /deny rules.*cannot enforce|cannot.*deny rules/i);
    assert.equal((await h.store.getTask("task-1")).status, "READY");
    assert.equal(h.agentManager.spawnCalls.length, 0);
  } finally { await cleanup(h); }
});

test("browser role fails closed before claiming because no real browser worker adapter exists", async () => {
  const h = await harness({ role: "BROWSER", permissions: { read: true, browser: true }, allowed_roles: ["BROWSER"] });
  try {
    await assert.rejects(() => h.dispatcher.dispatch("task-1"), /browser.*unavailable|unsupported.*browser/i);
    assert.equal((await h.store.getTask("task-1")).status, "READY");
    assert.equal(h.agentManager.spawnCalls.length, 0);
  } finally { await cleanup(h); }
});

test("dispatcher rejects unknown project, missing permissions and unavailable provider before claim", async () => {
  const h = await harness({ permissions: { read: true } });
  try {
    await assert.rejects(() => h.dispatcher.dispatch("task-1"), /edit permission/i);
    assert.equal((await h.store.getTask("task-1")).status, "READY");

    const task2 = await h.store.createTask({ id: "task-unknown", project_id: "missing", goal: "No project", role: "CODING", status: "READY", permissions: { read: true, edit: true } });
    assert.equal(task2.status, "READY");
    await assert.rejects(() => h.dispatcher.dispatch("task-unknown"), /project.*not registered/i);

    await h.store.createTask({ id: "task-provider", project_id: "tohieuquiz", goal: "Provider guard", role: "CODING", status: "READY", permissions: { read: true, edit: true } });
    h.dispatcher.providerAvailable = () => false;
    await assert.rejects(() => h.dispatcher.dispatch("task-provider"), /codex.*unavailable/i);
    assert.equal((await h.store.getTask("task-provider")).status, "READY");
  } finally { await cleanup(h); }
});

test("dispatcher passes automatic parallel guard context into durable CODING claim", async () => {
  const guard = {
    workspaceLockKey: "workspace-test",
    repositoryKey: "repo-test",
    observedBaseSha: "a".repeat(40),
    observedHeadSha: "b".repeat(40),
    baseIsAncestor: true
  };
  const h = await harness({ enforceParallelGuards: true, prepareClaimContext: async () => guard });
  try {
    const dispatched = await h.dispatcher.dispatch("task-1");
    assert.equal(dispatched.task.status, "RUNNING");
    assert.equal("workspace_lock_key" in dispatched.task, false);
    assert.equal("repository_key" in dispatched.task, false);
    const persisted = await h.store.getTask("task-1");
    assert.equal(persisted.repository_key, "repo-test");
    assert.equal(persisted.workspace_lock_key, "workspace-test");
    assert.equal(persisted.base_sha, guard.observedBaseSha);
    assert.equal(persisted.dispatch_head_sha, guard.observedHeadSha);
    h.agentManager.finish(dispatched.local_agent_id, { summary: "guarded worker complete" });
    await h.dispatcher.settle("task-1");
  } finally { await cleanup(h); }
});

test("failed worker is reconciled to BLOCKED without exposing the lease", async () => {
  const h = await harness();
  try {
    const dispatched = await h.dispatcher.dispatch("task-1");
    h.agentManager.finish(dispatched.local_agent_id, { ok: false, summary: "worker failed safely" });
    await h.dispatcher.settle("task-1");
    const status = await h.dispatcher.status("task-1");
    assert.equal(status.task.status, "BLOCKED");
    assert.match(status.task.blocked_reason, /worker failed safely/i);
    assert.equal("lease_id" in status, false);
  } finally { await cleanup(h); }
});
