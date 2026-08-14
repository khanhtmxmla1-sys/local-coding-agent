import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskHubStore } from "./store.mjs";
import { registerTaskHubTools } from "./tools.mjs";

const NOW = Date.parse("2026-08-14T01:10:00.000Z");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEW_BASE = "c".repeat(40);

function parse(result) { return JSON.parse(result.content[0].text); }

async function harness(checkFreshness) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lca-freshness-"));
  const store = new TaskHubStore({ dir, now: () => NOW });
  const handlers = new Map();
  const approvals = [];
  registerTaskHubTools(null, {
    reg: (_mcp, name, _def, handler) => handlers.set(name, handler),
    store,
    jsonResult: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    authorizeAction: async (action) => approvals.push(action),
    checkFreshness
  });
  return { dir, store, handlers, approvals };
}

test("MERGE_READY gate rejects stale main before consuming merge approval", async () => {
  const h = await harness(async () => ({ fresh: false, reason: "origin/main advanced", base_sha: NEW_BASE, head_sha: HEAD, base_is_ancestor: false }));
  try {
    await h.store.createTask({ id: "task-stale", goal: "Merge safely", status: "CI_PENDING", project_id: "p", permissions: { merge: true } });
    const task = await h.store.getTask("task-stale");
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: task.id, to: "MERGE_READY", expected_version: task.version }),
      /fresh|stale|advanced|sync/i
    );
    assert.equal(h.approvals.length, 0);
    assert.equal((await h.store.getTask(task.id)).status, "CI_PENDING");
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test("fresh MERGE_READY records exact verified base/head SHA", async () => {
  const h = await harness(async () => ({ fresh: true, reason: null, base_sha: BASE, head_sha: HEAD, base_is_ancestor: true }));
  try {
    await h.store.createTask({ id: "task-fresh", goal: "Merge safely", status: "CI_PENDING", project_id: "p", permissions: { merge: true } });
    const task = await h.store.getTask("task-fresh");
    const result = parse(await h.handlers.get("task_hub_transition")({ id: task.id, to: "MERGE_READY", expected_version: task.version }));
    assert.equal(result.task.status, "MERGE_READY");
    assert.equal(result.task.verified_base_sha, BASE);
    assert.equal(result.task.verified_head_sha, HEAD);
    assert.equal(h.approvals.length, 1);
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test("a task already MERGE_READY cannot advance after verified base/head become stale", async () => {
  let phase = "verify";
  const h = await harness(async () => phase === "verify"
    ? ({ fresh: true, reason: null, base_sha: BASE, head_sha: HEAD, base_is_ancestor: true })
    : ({ fresh: false, reason: "verified base changed", base_sha: NEW_BASE, head_sha: HEAD, base_is_ancestor: false }));
  try {
    await h.store.createTask({ id: "task-change", goal: "Merge safely", status: "CI_PENDING", project_id: "p", permissions: { merge: true } });
    let task = await h.store.getTask("task-change");
    await h.handlers.get("task_hub_transition")({ id: task.id, to: "MERGE_READY", expected_version: task.version });
    phase = "changed";
    task = await h.store.getTask(task.id);
    await assert.rejects(
      () => h.handlers.get("task_hub_transition")({ id: task.id, to: "DONE", expected_version: task.version }),
      /fresh|stale|changed|verified/i
    );
    assert.equal((await h.store.getTask(task.id)).status, "MERGE_READY");
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});
