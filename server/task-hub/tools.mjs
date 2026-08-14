// Local Coding Agent - AI Task Hub MCP tool facade
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { TASK_PERMISSION_KEYS, TASK_ROLES, TASK_STATUSES, canTransition } from "./model.mjs";

const ROLE_VALUES = Object.values(TASK_ROLES);
const STATUS_VALUES = Object.values(TASK_STATUSES);
const PERMISSION_SHAPE = Object.fromEntries(TASK_PERMISSION_KEYS.map((key) => [key, z.boolean().optional()]));
const GATE_PERMISSIONS = Object.freeze({
  COMMIT_READY: ["commit"],
  PR_OPEN: ["push", "open_pr"],
  MERGE_READY: ["merge"],
  DEPLOYING: ["deploy"]
});

export function publicTask(task) {
  if (!task) return null;
  const copy = JSON.parse(JSON.stringify(task));
  delete copy.lease_proof;
  delete copy.workspace_lock_key;
  delete copy.repository_key;
  return copy;
}

export function taskHubApprovalAction(task, to) {
  return `task_hub_transition:${task.id}:${task.status}->${to}:v${task.version}`;
}

function requiredGatePermissions(task, to) {
  const required = GATE_PERMISSIONS[to] || [];
  const missing = required.filter((permission) => task?.permissions?.[permission] !== true);
  if (missing.length) {
    throw new Error(`Task ${task.id} cannot enter ${to}: required permission(s) not declared: ${missing.join(", ")}.`);
  }
}

function transitionNeedsApproval(task, to) {
  if (task.status === TASK_STATUSES.PLANNED && to === TASK_STATUSES.APPROVED) return true;
  return (GATE_PERMISSIONS[to] || []).length > 0;
}

export function registerTaskHubTools(mcp, { reg, store, jsonResult, authorizeAction, checkFreshness = null, prepareClaimContext = null } = {}) {
  if (typeof reg !== "function") throw new Error("Task Hub tool registration requires reg().");
  if (!store) throw new Error("Task Hub tool registration requires a store.");
  if (typeof jsonResult !== "function") throw new Error("Task Hub tool registration requires jsonResult().");
  if (typeof authorizeAction !== "function") throw new Error("Task Hub tool registration requires authorizeAction().");

  reg(mcp, "task_hub_create", {
    title: "Create Task Hub task",
    description: "Create a durable orchestration task. New tasks always start in DRAFT; callers cannot choose an initial status.",
    inputSchema: {
      id: z.string().min(1).max(128), parent_id: z.string().min(1).max(128).optional(), project_id: z.string().max(200).optional(),
      title: z.string().max(300).optional(), goal: z.string().min(1).max(4000), role: z.enum(ROLE_VALUES).optional(),
      priority: z.number().int().min(0).max(100).optional(), depends_on: z.array(z.string().min(1).max(128)).max(100).optional(),
      scope_in: z.array(z.string().min(1).max(1000)).max(100).optional(), scope_out: z.array(z.string().min(1).max(1000)).max(100).optional(),
      acceptance_criteria: z.array(z.string().min(1).max(1000)).max(100).optional(),
      planned_paths: z.array(z.string().min(1).max(1000)).max(200).optional(), semantic_keys: z.array(z.string().min(1).max(300)).max(200).optional(),
      base_ref: z.string().min(1).max(200).optional(), permissions: z.object(PERMISSION_SHAPE).optional()
    }
  }, async (args) => {
    const task = await store.createTask({
      id: args.id, parent_id: args.parent_id, project_id: args.project_id, title: args.title, goal: args.goal, role: args.role,
      priority: args.priority, depends_on: args.depends_on, scope_in: args.scope_in, scope_out: args.scope_out,
      acceptance_criteria: args.acceptance_criteria, planned_paths: args.planned_paths, semantic_keys: args.semantic_keys, base_ref: args.base_ref,
      permissions: args.permissions, status: TASK_STATUSES.DRAFT
    });
    return jsonResult({ ok: true, task: publicTask(task) });
  });

  reg(mcp, "task_hub_get", { title: "Get Task Hub task", description: "Read one durable Task Hub task. Lease proofs are never exposed.", inputSchema: { id: z.string().min(1).max(128) } }, async ({ id }) => {
    const task = await store.getTask(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    return jsonResult({ task: publicTask(task) });
  });

  reg(mcp, "task_hub_list", {
    title: "List Task Hub tasks", description: "List durable Task Hub tasks with optional project, role, or status filters.",
    inputSchema: { project_id: z.string().max(200).optional(), role: z.enum(ROLE_VALUES).optional(), status: z.enum(STATUS_VALUES).optional(), limit: z.number().int().min(1).max(200).optional() }
  }, async ({ project_id, role, status, limit = 100 }) => {
    let tasks = await store.listTasks();
    if (project_id != null) tasks = tasks.filter((task) => task.project_id === project_id);
    if (role != null) tasks = tasks.filter((task) => task.role === role);
    if (status != null) tasks = tasks.filter((task) => task.status === status);
    tasks.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || Number(a.created_at || 0) - Number(b.created_at || 0));
    return jsonResult({ count: Math.min(tasks.length, limit), tasks: tasks.slice(0, limit).map(publicTask) });
  });

  reg(mcp, "task_hub_transition", {
    title: "Transition Task Hub task", description: "Move a non-running task through the explicit lifecycle using optimistic version checks. Uses the server's active policy-aware exact-action authorization for approval-bearing gates.",
    inputSchema: { id: z.string().min(1).max(128), to: z.enum(STATUS_VALUES), expected_version: z.number().int().min(1), blocked_reason: z.string().max(2000).optional() }
  }, async ({ id, to, expected_version, blocked_reason }) => {
    const task = await store.getTask(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    if (Number(task.version) !== expected_version) throw new Error(`Task ${id} version conflict: expected ${expected_version}, current ${task.version}.`);
    if (to === TASK_STATUSES.RUNNING) throw new Error(`Task ${id} must enter RUNNING through task_hub_claim so the worker receives an active lease.`);
    if (task.status === TASK_STATUSES.RUNNING) throw new Error(`Task ${id} is RUNNING; use task_hub_submit_result with the active lease instead of a generic transition.`);
    if (!canTransition(task.status, to)) throw new Error(`Invalid task transition: ${task.status} -> ${to}.`);
    requiredGatePermissions(task, to);
    let freshness = null;
    if (to === TASK_STATUSES.MERGE_READY || task.status === TASK_STATUSES.MERGE_READY) {
      if (typeof checkFreshness !== "function") throw new Error(`Task ${id} cannot prove merge freshness in this runtime.`);
      freshness = await checkFreshness(task, { refreshBase: true, requireVerified: task.status === TASK_STATUSES.MERGE_READY });
      if (!freshness?.fresh) throw new Error(`Task ${id} merge freshness check failed: ${freshness?.reason || "base/head freshness could not be proven"}.`);
    }
    if (transitionNeedsApproval(task, to)) await authorizeAction(taskHubApprovalAction(task, to));
    const updated = await store.transitionTask(id, to, { expectedVersion: expected_version, blockedReason: blocked_reason, freshness });
    return jsonResult({ ok: true, task: publicTask(updated) });
  });

  reg(mcp, "task_hub_claim", {
    title: "Claim ready Task Hub task", description: "Atomically claim one READY task for a worker lease. The raw lease id is returned only to the claimant and is never persisted.",
    inputSchema: { id: z.string().min(1).max(128), worker_id: z.string().min(1).max(200), lease_ms: z.number().int().min(1000).max(3600000).optional() }
  }, async ({ id, worker_id, lease_ms = 30_000 }) => {
    const task = await store.getTask(id);
    if (!task) throw new Error(`Task ${id} not found.`);
    const guardContext = typeof prepareClaimContext === "function" ? await prepareClaimContext(task) : null;
    const claimed = await store.claimTask(id, worker_id, lease_ms, guardContext);
    return jsonResult({ lease_id: claimed.lease_id, task: publicTask(claimed.task) });
  });

  reg(mcp, "task_hub_heartbeat", {
    title: "Heartbeat Task Hub lease", description: "Extend the matching active worker lease. lease_id is a credential and must not be logged or shared.",
    inputSchema: { id: z.string().min(1).max(128), worker_id: z.string().min(1).max(200), lease_id: z.string().min(1).max(300), lease_ms: z.number().int().min(1000).max(3600000).optional() }
  }, async ({ id, worker_id, lease_id, lease_ms = 30_000 }) => jsonResult({ ok: true, task: publicTask(await store.heartbeatTask(id, worker_id, lease_id, lease_ms)) }));

  reg(mcp, "task_hub_submit_result", {
    title: "Submit Task Hub worker result", description: "Submit a worker result with the matching active lease. A valid submission clears the lease and moves RUNNING to REVIEW.",
    inputSchema: { id: z.string().min(1).max(128), worker_id: z.string().min(1).max(200), lease_id: z.string().min(1).max(300), result_summary: z.string().min(1).max(8000), expected_version: z.number().int().min(1).optional() }
  }, async ({ id, worker_id, lease_id, result_summary, expected_version }) => jsonResult({ ok: true, task: publicTask(await store.submitResult(id, worker_id, lease_id, result_summary, { expectedVersion: expected_version })) }));
}
