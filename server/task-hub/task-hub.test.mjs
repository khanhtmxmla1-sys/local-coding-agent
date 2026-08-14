import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  TASK_ROLES,
  TASK_STATUSES,
  createTaskRecord,
  canTransition,
  dependenciesSatisfied,
  hasHighImpactPermission
} from "./model.mjs";
import { TaskHubStore } from "./store.mjs";

const NOW = Date.parse("2026-08-13T14:00:00.000Z");

function baseTask(overrides = {}) {
  return {
    id: "task-a",
    goal: "Implement bounded Task Hub core",
    role: "CODING",
    status: "READY",
    ...overrides
  };
}

test("task model applies safe defaults and default-deny permissions", () => {
  const task = createTaskRecord(baseTask({ status: "DRAFT" }), { now: NOW });
  assert.equal(task.role, TASK_ROLES.CODING);
  assert.equal(task.status, TASK_STATUSES.DRAFT);
  assert.equal(task.priority, 50);
  assert.deepEqual(task.depends_on, []);
  assert.deepEqual(task.planned_paths, []);
  assert.deepEqual(task.semantic_keys, []);
  assert.equal(task.base_ref, "origin/main");
  assert.equal(task.repository_key, null);
  assert.equal(task.workspace_lock_key, null);
  assert.equal(task.parallel_guard.requires_revalidation, false);
  assert.equal(task.permissions.commit, false);
  assert.equal(task.permissions.push, false);
  assert.equal(task.permissions.merge, false);
  assert.equal(task.permissions.deploy, false);
  assert.equal(task.permissions.production_write, false);
  assert.equal(task.version, 1);
  assert.equal(task.created_at, NOW);
  assert.equal(task.updated_at, NOW);
});

test("task model rejects invalid role/status, self dependency, duplicate dependency, and unknown fields", () => {
  assert.throws(() => createTaskRecord(baseTask({ role: "UNKNOWN" }), { now: NOW }), /role/i);
  assert.throws(() => createTaskRecord(baseTask({ status: "NOPE" }), { now: NOW }), /status/i);
  assert.throws(() => createTaskRecord(baseTask({ depends_on: ["task-a"] }), { now: NOW }), /self/i);
  assert.throws(() => createTaskRecord(baseTask({ depends_on: ["task-b", "task-b"] }), { now: NOW }), /duplicate/i);
  assert.throws(() => createTaskRecord({ ...baseTask(), unexpected_field: "should-not-persist" }, { now: NOW }), /unknown/i);
  assert.throws(() => createTaskRecord(baseTask({ planned_paths: ["C:\\repo\\src\\shared.ts"] }), { now: NOW }), /project-relative|absolute/i);
  assert.throws(() => createTaskRecord(baseTask({ planned_paths: ["../outside.ts"] }), { now: NOW }), /inside the project/i);
});

test("state transitions allow the bounded happy path and reject unsafe skips", () => {
  assert.equal(canTransition("DRAFT", "PLANNED"), true);
  assert.equal(canTransition("PLANNED", "APPROVED"), true);
  assert.equal(canTransition("APPROVED", "READY"), true);
  assert.equal(canTransition("READY", "RUNNING"), true);
  assert.equal(canTransition("RUNNING", "REVIEW"), true);
  assert.equal(canTransition("REVIEW", "DONE"), true);
  assert.equal(canTransition("REVIEW", "AWAITING_APPROVAL"), true);
  assert.equal(canTransition("DRAFT", "RUNNING"), false);
  assert.equal(canTransition("READY", "DONE"), false);
  assert.equal(canTransition("DONE", "RUNNING"), false);
});

test("dependencies must exist and be DONE", () => {
  const task = createTaskRecord(baseTask({ id: "task-c", depends_on: ["task-a", "task-b"] }), { now: NOW });
  const byId = new Map([
    ["task-a", createTaskRecord(baseTask({ id: "task-a", status: "DONE" }), { now: NOW })],
    ["task-b", createTaskRecord(baseTask({ id: "task-b", status: "DONE" }), { now: NOW })]
  ]);
  assert.equal(dependenciesSatisfied(task, byId), true);
  byId.get("task-b").status = "FAILED";
  assert.equal(dependenciesSatisfied(task, byId), false);
  byId.delete("task-b");
  assert.equal(dependenciesSatisfied(task, byId), false);
});

test("high-impact permission detection is conservative", () => {
  const safe = createTaskRecord(baseTask({ status: "DRAFT", permissions: { read: true, test: true } }), { now: NOW });
  const risky = createTaskRecord(baseTask({ id: "task-risk", status: "DRAFT", permissions: { deploy: true } }), { now: NOW });
  assert.equal(hasHighImpactPermission(safe), false);
  assert.equal(hasHighImpactPermission(risky), true);
});

test("store persists tasks across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const storeA = new TaskHubStore({ dir, now: () => NOW });
    await storeA.createTask(baseTask({ status: "DRAFT" }));
    const storeB = new TaskHubStore({ dir, now: () => NOW + 1000 });
    const loaded = await storeB.getTask("task-a");
    assert.equal(loaded.id, "task-a");
    assert.equal(loaded.goal, "Implement bounded Task Hub core");
    assert.equal(loaded.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claim is atomic across concurrent store instances and active lease blocks another worker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const storeA = new TaskHubStore({ dir, now: () => NOW, idFactory: () => "lease-a" });
    const storeB = new TaskHubStore({ dir, now: () => NOW, idFactory: () => "lease-b" });
    await storeA.createTask(baseTask());
    const results = await Promise.allSettled([
      storeA.claimTask("task-a", "worker-a", 30_000),
      storeB.claimTask("task-a", "worker-b", 30_000)
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const task = await storeA.getTask("task-a");
    assert.equal(task.status, "RUNNING");
    assert.ok(["worker-a", "worker-b"].includes(task.lease_owner));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat extends only the matching active lease", async () => {
  let now = NOW;
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const store = new TaskHubStore({ dir, now: () => now, idFactory: () => "lease-1" });
    await store.createTask(baseTask());
    const claimed = await store.claimTask("task-a", "worker-a", 10_000);
    assert.equal(claimed.lease_id, "lease-1");
    assert.equal("lease_id" in (await store.getTask("task-a")), false);
    now += 2_000;
    const heartbeated = await store.heartbeatTask("task-a", "worker-a", "lease-1", 20_000);
    assert.equal(heartbeated.lease_expires_at, now + 20_000);
    await assert.rejects(() => store.heartbeatTask("task-a", "worker-b", "lease-1", 20_000), /lease/i);
    await assert.rejects(() => store.heartbeatTask("task-a", "worker-a", "wrong-lease", 20_000), /lease/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired low-risk lease can be reclaimed but expired high-impact lease cannot", async () => {
  let now = NOW;
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    let leaseCounter = 0;
    const store = new TaskHubStore({ dir, now: () => now, idFactory: () => `lease-${++leaseCounter}` });
    await store.createTask(baseTask({ id: "safe-task" }));
    await store.claimTask("safe-task", "worker-a", 1_000);
    now += 2_000;
    const reclaimed = await store.claimTask("safe-task", "worker-b", 5_000);
    assert.equal(reclaimed.task.lease_owner, "worker-b");

    await store.createTask(baseTask({ id: "risky-task", permissions: { deploy: true } }));
    await store.claimTask("risky-task", "worker-a", 1_000);
    now += 2_000;
    await assert.rejects(() => store.claimTask("risky-task", "worker-b", 5_000), /reconciliation|high-impact|blocked/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store claim enforces dependency completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => "lease-dependency" });
    await store.createTask(baseTask({ id: "dep-failed", status: "FAILED" }));
    await store.createTask(baseTask({ id: "blocked-child", depends_on: ["dep-failed"] }));
    await assert.rejects(() => store.claimTask("blocked-child", "worker-a", 5_000), /dependencies/i);

    await store.createTask(baseTask({ id: "dep-done", status: "DONE" }));
    await store.createTask(baseTask({ id: "ready-child", depends_on: ["dep-done"] }));
    const claimed = await store.claimTask("ready-child", "worker-a", 5_000);
    assert.equal(claimed.task.status, "RUNNING");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idFactory is reserved for lease ids, not persistence temp files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    let counter = 0;
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => `lease-${++counter}` });
    await store.createTask(baseTask());
    const claimed = await store.claimTask("task-a", "worker-a", 5_000);
    assert.equal(claimed.lease_id, "lease-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store rejects missing parent task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const store = new TaskHubStore({ dir, now: () => NOW });
    await assert.rejects(
      () => store.createTask(baseTask({ id: "child-task", parent_id: "missing-parent", status: "DRAFT" })),
      /parent.*not found|missing parent/i
    );
    assert.equal(await store.getTask("child-task"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store rejects missing dependencies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-"));
  try {
    const store = new TaskHubStore({ dir, now: () => NOW });
    await assert.rejects(
      () => store.createTask(baseTask({ id: "orphan-task", depends_on: ["missing-task"] })),
      /dependency.*not found|missing dependency/i
    );
    assert.equal(await store.getTask("orphan-task"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claim is atomic across separate Node processes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-xproc-"));
  try {
    const store = new TaskHubStore({ dir });
    await store.createTask(baseTask());

    const workerPath = path.join(dir, "claim-worker.mjs");
    const storeModuleUrl = new URL("./store.mjs", import.meta.url).href;
    await writeFile(
      workerPath,
      `import { TaskHubStore } from ${JSON.stringify(storeModuleUrl)};\n` +
        `const [dir, worker] = process.argv.slice(2);\n` +
        `const store = new TaskHubStore({ dir });\n` +
        `try { await store.claimTask("task-a", worker, 30000); process.exit(0); } catch { process.exit(2); }\n`,
      "utf8"
    );

    const runWorker = (worker) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, dir, worker], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => runWorker(`worker-${index + 1}`))
    );
    assert.equal(results.filter((code) => code === 0).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

