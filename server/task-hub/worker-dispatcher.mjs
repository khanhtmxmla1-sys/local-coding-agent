// Local Coding Agent - AI Task Hub worker adapters/dispatcher
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { redactSecrets } from "../agent-manager.mjs";
import { TASK_ROLES, TASK_STATUSES } from "./model.mjs";

const ADAPTERS = Object.freeze({
  [TASK_ROLES.CODING]: { agent_role: "coding_worker", sandbox_mode: "workspace-write" },
  [TASK_ROLES.REVIEWER]: { agent_role: "reviewer_worker", sandbox_mode: "read-only" }
});

function publicTask(task) {
  if (!task) return null;
  const copy = JSON.parse(JSON.stringify(task));
  delete copy.lease_proof;
  return copy;
}

function compactError(value) {
  return redactSecrets(String(value?.message || value || "worker failed")).replace(/\s+/g, " ").trim().slice(0, 1000);
}

export function buildWorkerPrompt(task) {
  const scopeIn = (task.scope_in || []).length ? task.scope_in.map((item) => `- ${item}`).join("\n") : "- Use only files needed for the stated goal.";
  const scopeOut = (task.scope_out || []).length ? task.scope_out.map((item) => `- ${item}`).join("\n") : "- No unrelated refactors.";
  const criteria = (task.acceptance_criteria || []).length ? task.acceptance_criteria.map((item) => `- ${item}`).join("\n") : "- Produce verifiable evidence for the stated goal.";
  const reviewer = task.role === TASK_ROLES.REVIEWER;
  return [
    `Task Hub task ${task.id} (${task.role}).`,
    `Goal: ${task.goal}`,
    "",
    reviewer
      ? "Act as an independent read-only reviewer. Do not edit files. Report findings by severity with file:line evidence and verification gaps."
      : "Implement the bounded task in the assigned workspace. Keep changes minimal and run relevant tests/checks.",
    "Never commit, push, open a PR, merge, migrate, deploy, or write to production. Those actions remain under Task Hub approval gates.",
    "Do not read or modify files outside the assigned project workspace.",
    "Do not copy credentials, tokens, lease ids, or secret values into reports.",
    "",
    "Scope in:", scopeIn,
    "Scope out:", scopeOut,
    "Acceptance criteria:", criteria,
    "",
    "Finish with a concise evidence summary suitable for Task Hub REVIEW."
  ].join("\n");
}

export class TaskHubDispatcher {
  constructor({ store, registry, agentManager, resolveWorkspace, providerAvailable, idFactory = randomUUID, maxRuntimeMs = 300_000, leaseMs = 360_000 } = {}) {
    if (!store || !registry || !agentManager) throw new Error("TaskHubDispatcher requires store, registry, and agentManager.");
    if (typeof resolveWorkspace !== "function") throw new Error("TaskHubDispatcher requires resolveWorkspace().");
    if (typeof providerAvailable !== "function") throw new Error("TaskHubDispatcher requires providerAvailable().");
    if (typeof idFactory !== "function") throw new Error("TaskHubDispatcher idFactory must be a function.");
    if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1000 || maxRuntimeMs > 600_000) throw new Error("maxRuntimeMs must be 1000..600000.");
    if (!Number.isInteger(leaseMs) || leaseMs <= maxRuntimeMs || leaseMs > 3_600_000) throw new Error("leaseMs must exceed maxRuntimeMs and be <= 3600000.");
    this.store = store;
    this.registry = registry;
    this.agentManager = agentManager;
    this.resolveWorkspace = resolveWorkspace;
    this.providerAvailable = providerAvailable;
    this.idFactory = idFactory;
    this.maxRuntimeMs = maxRuntimeMs;
    this.leaseMs = leaseMs;
    this.sessions = new Map();
  }

  async dispatch(taskId) {
    if (this.sessions.has(taskId)) throw new Error(`Task ${taskId} already has a dispatcher session.`);
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (task.status !== TASK_STATUSES.READY) throw new Error(`Task ${taskId} is not READY.`);
    if (!task.project_id) throw new Error(`Task ${taskId} has no project_id.`);

    const project = await this.registry.get(task.project_id);
    if (!project) throw new Error(`Project ${task.project_id} is not registered.`);
    if (!project.allowed_roles.includes(task.role)) throw new Error(`Project ${project.id} does not allow role ${task.role}.`);
    if (task.role === TASK_ROLES.BROWSER) throw new Error("Browser worker adapter is unavailable; no Task Hub claim was created.");
    const adapter = ADAPTERS[task.role];
    if (!adapter) throw new Error(`Unsupported Task Hub worker role: ${task.role}.`);
    if (task.permissions?.read !== true) throw new Error(`Task ${task.id} requires read permission before dispatch.`);
    if (task.role === TASK_ROLES.CODING && task.permissions?.edit !== true) throw new Error(`Task ${task.id} requires edit permission for the coding adapter.`);
    if (!this.providerAvailable("codex_cli")) throw new Error("codex_cli provider is unavailable; task was not claimed.");

    const workspace = await this.resolveWorkspace(project, task);
    if (!workspace?.resolved) throw new Error(`Project ${project.id} workspace could not be resolved.`);
    if (workspace.has_deny_rules === true) {
      throw new Error(`Project ${project.id} cannot use a raw Codex worker because its permission root has deny rules that the Codex sandbox cannot enforce.`);
    }
    if (task.role === TASK_ROLES.CODING && workspace.can_write !== true) throw new Error(`Project ${project.id} workspace is not writable for the coding adapter.`);

    const workerId = `taskhub-${String(this.idFactory())}`.slice(0, 200);
    const claimed = await this.store.claimTask(task.id, workerId, this.leaseMs);
    let spawned;
    try {
      spawned = await this.agentManager.spawn({
        role: adapter.agent_role,
        title: task.title || task.id,
        task: buildWorkerPrompt(task),
        provider: "codex_cli",
        workspace_root: workspace.resolved,
        max_runtime_ms: this.maxRuntimeMs,
        dry_run: false,
        sandbox_mode: adapter.sandbox_mode,
        writable_roots: [],
        permission_profile: workspace.permission_profile || null,
        permission_roots: Array.isArray(workspace.permission_roots) ? workspace.permission_roots : []
      });
    } catch (error) {
      await this.store.releaseClaim(task.id, workerId, claimed.lease_id).catch(() => {});
      throw error;
    }

    const session = { task_id: task.id, worker_id: workerId, lease_id: claimed.lease_id, local_agent_id: spawned.agent_id, role: task.role, watch: null, error: null };
    this.sessions.set(task.id, session);
    session.watch = this.watchSession(session)
      .catch(async (error) => {
        session.error = compactError(error);
        await this.store.blockClaim(session.task_id, session.worker_id, session.lease_id, `Dispatcher reconciliation failed: ${session.error}`).catch(() => {});
      })
      .finally(() => this.sessions.delete(session.task_id));
    return { ok: true, task: publicTask(claimed.task), local_agent_id: spawned.agent_id, adapter: adapter.agent_role };
  }

  async watchSession(session) {
    const settled = await this.agentManager.settle(session.local_agent_id);
    const status = settled?.status || this.agentManager.get(session.local_agent_id)?.status;
    if (status === "done") {
      const result = await this.agentManager.result(session.local_agent_id, 8000);
      const summary = redactSecrets(String(result?.summary || result?.content || "Worker completed with no summary.")).trim().slice(0, 8000);
      await this.store.submitResult(session.task_id, session.worker_id, session.lease_id, summary || "Worker completed.");
    } else {
      const result = await this.agentManager.result(session.local_agent_id, 2000).catch(() => null);
      const reason = compactError(result?.summary || result?.error || settled?.error || `worker ended with status ${status || "unknown"}`);
      await this.store.blockClaim(session.task_id, session.worker_id, session.lease_id, `Worker ${status || "failed"}: ${reason}`);
    }
  }

  async settle(taskId) {
    const session = this.sessions.get(taskId);
    if (session?.watch) await session.watch;
    return this.status(taskId);
  }

  async status(taskId) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    const session = this.sessions.get(taskId);
    const meta = session ? this.agentManager.get(session.local_agent_id) : null;
    return {
      task: publicTask(task),
      worker: session ? { local_agent_id: session.local_agent_id, role: session.role, status: meta?.status || "unknown", error: session.error } : null,
      reconciliation_required: !session && task.status === TASK_STATUSES.RUNNING
    };
  }
}
