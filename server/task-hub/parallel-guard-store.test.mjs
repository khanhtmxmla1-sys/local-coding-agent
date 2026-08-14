import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskHubStore } from "./store.mjs";

const NOW = Date.parse("2026-08-14T01:00:00.000Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function guard(overrides = {}) {
  return {
    workspaceLockKey: "workspace-a",
    repositoryKey: "repo-1",
    observedBaseSha: SHA_A,
    observedHeadSha: SHA_A,
    baseIsAncestor: true,
    ...overrides
  };
}

async function createCoding(store, id, overrides = {}) {
  return store.createTask({
    id,
    project_id: `project-${id}`,
    goal: `Work ${id}`,
    role: "CODING",
    status: "READY",
    planned_paths: [`src/${id}.ts`],
    permissions: { read: true, edit: true, test: true },
    ...overrides
  });
}

test("workspace write lock blocks a second CODING claim for the same writable root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-lock-"));
  try {
    let lease = 0;
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => `lease-${++lease}`, enforceParallelGuards: true });
    await createCoding(store, "task-a");
    await createCoding(store, "task-b");
    await store.claimTask("task-a", "worker-a", 30_000, guard());
    await assert.rejects(
      () => store.claimTask("task-b", "worker-b", 30_000, guard({ observedHeadSha: SHA_B })),
      /workspace.*lock|write lock/i
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("exact path overlap blocks concurrent CODING even across separate worktrees of one repo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-overlap-"));
  try {
    let lease = 0;
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => `lease-${++lease}`, enforceParallelGuards: true });
    await createCoding(store, "task-a", { planned_paths: ["src/shared.ts"] });
    await createCoding(store, "task-b", { planned_paths: ["src/shared.ts"] });
    await store.claimTask("task-a", "worker-a", 30_000, guard({ workspaceLockKey: "workspace-a" }));
    await assert.rejects(
      () => store.claimTask("task-b", "worker-b", 30_000, guard({ workspaceLockKey: "workspace-b", observedHeadSha: SHA_B })),
      /overlap|shared\.ts/i
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("path overlap with a completed CODING lease is retained as revalidation evidence without blocking the next worktree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-review-overlap-"));
  try {
    let lease = 0;
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => `lease-${++lease}`, enforceParallelGuards: true });
    await createCoding(store, "task-a", { planned_paths: ["src/shared.ts"] });
    await createCoding(store, "task-b", { planned_paths: ["src/shared.ts"] });
    const first = await store.claimTask("task-a", "worker-a", 30_000, guard({ workspaceLockKey: "workspace-a" }));
    await store.submitResult("task-a", "worker-a", first.lease_id, "implementation ready for review");
    const second = await store.claimTask("task-b", "worker-b", 30_000, guard({ workspaceLockKey: "workspace-b", observedHeadSha: SHA_B }));
    assert.equal(second.task.status, "RUNNING");
    assert.equal(second.task.parallel_guard.requires_revalidation, true);
    assert.equal(second.task.parallel_guard.overlaps[0].task_id, "task-a");
    assert.equal(second.task.parallel_guard.overlaps[0].task_status, "REVIEW");
    assert.deepEqual(second.task.parallel_guard.overlaps[0].path_matches, ["src/shared.ts"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("semantic-only overlap is allowed but persisted as requiring revalidation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-semantic-"));
  try {
    let lease = 0;
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => `lease-${++lease}`, enforceParallelGuards: true });
    await createCoding(store, "task-a", { planned_paths: ["src/teacher.ts"], semantic_keys: ["api:/api/results"] });
    await createCoding(store, "task-b", { planned_paths: ["src/student.ts"], semantic_keys: ["api:/api/results"] });
    await store.claimTask("task-a", "worker-a", 30_000, guard({ workspaceLockKey: "workspace-a" }));
    const second = await store.claimTask("task-b", "worker-b", 30_000, guard({ workspaceLockKey: "workspace-b", observedHeadSha: SHA_B }));
    assert.equal(second.task.status, "RUNNING");
    assert.equal(second.task.parallel_guard.requires_revalidation, true);
    assert.equal(second.task.parallel_guard.overlaps[0].task_id, "task-a");
    assert.deepEqual(second.task.parallel_guard.overlaps[0].semantic_matches, ["api:/api/results"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("guarded writable CODING cannot bypass workspace locking without a project mapping", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-no-project-"));
  try {
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => "lease-1", enforceParallelGuards: true });
    await store.createTask({ id: "task-no-project", goal: "No project bypass", role: "CODING", status: "READY", permissions: { read: true, edit: true } });
    await assert.rejects(
      () => store.claimTask("task-no-project", "worker-a", 30_000, null),
      /project_id|project mapping/i
    );
    assert.equal((await store.getTask("task-no-project")).status, "READY");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stale base blocks CODING dispatch before a worker lease is issued", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-stale-"));
  try {
    const store = new TaskHubStore({ dir, now: () => NOW, idFactory: () => "lease-1", enforceParallelGuards: true });
    await createCoding(store, "task-a");
    await assert.rejects(
      () => store.claimTask("task-a", "worker-a", 30_000, guard({ baseIsAncestor: false })),
      /stale|sync.*main|base/i
    );
    assert.equal((await store.getTask("task-a")).status, "READY");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
