import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskHubStore } from "./store.mjs";
import { TASK_STATUSES } from "./model.mjs";
import { registerTaskHubTools, taskHubApprovalAction } from "./tools.mjs";

const NOW = Date.parse("2026-08-13T16:30:00.000Z");

function fakeRegistry() {
  const handlers = new Map();
  const defs = new Map();
  return {
    handlers,
    defs,
    reg(_mcp, name, def, handler) {
      handlers.set(name, handler);
      defs.set(name, def);
    }
  };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-task-hub-tools-"));
  let leaseCounter = 0;
  const store = new TaskHubStore({
    dir,
    now: () => NOW,
    idFactory: () => `lease-${++leaseCounter}`
  });
  const registry = fakeRegistry();
  const approvals = [];
  registerTaskHubTools(null, {
    reg: registry.reg,
    store,
    jsonResult: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    authorizeAction: async (action) => approvals.push(action)
  });
  return { dir, store, approvals, ...registry };
}

test("task_hub_create forces DRAFT and never exposes lease proof", async () => {
  const h = await harness();
  try {
    const result = parse(await h.handlers.get("task_hub_create")({
      id: "task-safe",
      goal: "Implement MCP facade safely",
      role: "CODING",
      status: "DONE",
      permissions: { read: true, commit: true }
    }));
    assert.equal(result.task.status, TASK_STATUSES.DRAFT);
    assert.equal(result.task.permissions.commit, true);
    assert.equal("lease_proof" in result.task, false);
    const persisted = await h.store.getTask("task-safe");
    assert.equal(persisted.status, TASK_STATUSES.DRAFT);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("task_hub_transition requires exact approval for approval-bearing gates", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-gate", goal: "Gate transition", status: "PLANNED" });
    const before = await h.store.getTask("task-gate");
    const result = parse(await h.handlers.get("task_hub_transition")({
      id: "task-gate",
      to: "APPROVED",
      expected_version: before.version
    }));
    assert.deepEqual(h.approvals, [taskHubApprovalAction(before, "APPROVED")]);
    assert.equal(result.task.status, "APPROVED");
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("invalid transition never consumes an approval", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-invalid-gate", goal: "Do not consume approval", status: "DRAFT", permissions: { commit: true } });
    const task = await h.store.getTask("task-invalid-gate");
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: task.id, to: "COMMIT_READY", expected_version: task.version }),
      /invalid task transition/i
    );
    assert.equal(h.approvals.length, 0);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("task_hub_transition rejects high-impact gate when permission was not declared", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-commit", goal: "No commit permission", status: "AWAITING_APPROVAL" });
    const task = await h.store.getTask("task-commit");
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: task.id, to: "COMMIT_READY", expected_version: task.version }),
      /permission.*commit|commit.*permission/i
    );
    assert.equal(h.approvals.length, 0);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("claim returns raw lease only once while get/list hide lease proof", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-claim", goal: "Claim safely", status: "READY" });
    const claimed = parse(await h.handlers.get("task_hub_claim")({ id: "task-claim", worker_id: "worker-a", lease_ms: 30_000 }));
    assert.equal(claimed.lease_id, "lease-1");
    assert.equal("lease_proof" in claimed.task, false);

    const got = parse(await h.handlers.get("task_hub_get")({ id: "task-claim" }));
    assert.equal("lease_proof" in got.task, false);
    assert.equal("lease_id" in got.task, false);

    const listed = parse(await h.handlers.get("task_hub_list")({}));
    assert.equal(listed.tasks.length, 1);
    assert.equal("lease_proof" in listed.tasks[0], false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("submit_result requires matching active lease and moves RUNNING to REVIEW", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-result", goal: "Submit verified work", status: "READY" });
    const claimed = parse(await h.handlers.get("task_hub_claim")({ id: "task-result", worker_id: "worker-a", lease_ms: 30_000 }));
    await assert.rejects(
      () => h.handlers.get("task_hub_submit_result")({
        id: "task-result",
        worker_id: "worker-a",
        lease_id: "wrong",
        result_summary: "done"
      }),
      /lease/i
    );
    const submitted = parse(await h.handlers.get("task_hub_submit_result")({
      id: "task-result",
      worker_id: "worker-a",
      lease_id: claimed.lease_id,
      result_summary: "Focused tests passed"
    }));
    assert.equal(submitted.task.status, "REVIEW");
    assert.equal(submitted.task.result_summary, "Focused tests passed");
    assert.equal(submitted.task.lease_owner, null);
    assert.equal("lease_proof" in submitted.task, false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("generic transition cannot bypass the RUNNING lease/result path", async () => {
  const h = await harness();
  try {
    await h.store.createTask({ id: "task-ready-bypass", goal: "No claim bypass", status: "READY" });
    const ready = await h.store.getTask("task-ready-bypass");
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: ready.id, to: "RUNNING", expected_version: ready.version }),
      /claim|lease/i
    );
    assert.equal((await h.store.getTask(ready.id)).status, "READY");

    await h.store.createTask({ id: "task-running", goal: "No result bypass", status: "READY" });
    await h.store.claimTask("task-running", "worker-a", 30_000);
    const running = await h.store.getTask("task-running");
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: running.id, to: "REVIEW", expected_version: running.version }),
      /submit_result|lease/i
    );
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
