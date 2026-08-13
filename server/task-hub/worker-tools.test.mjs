import test from "node:test";
import assert from "node:assert/strict";

import { registerTaskHubWorkerTools, projectRegistrationApprovalAction } from "./worker-tools.mjs";

function fakeRegistry() {
  const projects = new Map();
  return {
    async validate(input) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)) throw new Error("project id invalid");
      if (input.allowed_roles && new Set(input.allowed_roles).size !== input.allowed_roles.length) throw new Error("duplicate allowed_roles");
      return { ...input, allowed_roles: input.allowed_roles || ["CODING", "REVIEWER"] };
    },
    async register(input) { const record = { ...input, created_at: 1, updated_at: 1 }; projects.set(record.id, record); return record; },
    async get(id) { return projects.get(id) || null; },
    async list() { return [...projects.values()]; }
  };
}

function fakeFacade({ resolveRegistrationWorkspace = async (value) => ({ resolved: value }) } = {}) {
  const handlers = new Map();
  const approvals = [];
  const registry = fakeRegistry();
  const dispatcher = {
    async dispatch(id) { return { ok: true, task: { id, status: "RUNNING" }, local_agent_id: "a_0123456789abcdef", adapter: "coding_worker" }; },
    async status(id) { return { task: { id, status: "REVIEW" }, worker: null, reconciliation_required: false }; }
  };
  registerTaskHubWorkerTools(null, {
    reg: (_mcp, name, _def, handler) => handlers.set(name, handler),
    jsonResult: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    registry,
    dispatcher,
    authorizeAction: async (action) => approvals.push(action),
    resolveRegistrationWorkspace
  });
  return { handlers, approvals, registry };
}

function parse(result) { return JSON.parse(result.content[0].text); }

test("project registration consumes exact approval before persisting mapping", async () => {
  const h = fakeFacade();
  const root = process.platform === "win32" ? "C:\\quizpro" : "/tmp/quizpro";
  const result = parse(await h.handlers.get("task_hub_project_register")({ id: "tohieuquiz", workspace_root: root, allowed_roles: ["CODING", "REVIEWER"] }));
  assert.deepEqual(h.approvals, [projectRegistrationApprovalAction("tohieuquiz", root, ["CODING", "REVIEWER"])]);
  assert.equal(result.project.id, "tohieuquiz");
  assert.equal((await h.registry.get("tohieuquiz")).workspace_root, root);
});

test("project registration approval is bound to the normalized allowed roles", async () => {
  const root = process.platform === "win32" ? "C:\\quizpro" : "/tmp/quizpro";
  assert.notEqual(
    projectRegistrationApprovalAction("tohieuquiz", root, ["CODING"]),
    projectRegistrationApprovalAction("tohieuquiz", root, ["CODING", "REVIEWER"])
  );
  assert.equal(
    projectRegistrationApprovalAction("tohieuquiz", root, ["REVIEWER", "CODING"]),
    projectRegistrationApprovalAction("tohieuquiz", root, ["CODING", "REVIEWER"])
  );
});

test("invalid or duplicate registration never consumes an approval", async () => {
  const h = fakeFacade();
  const root = process.platform === "win32" ? "C:\\quizpro" : "/tmp/quizpro";
  await assert.rejects(() => h.handlers.get("task_hub_project_register")({ id: "../bad", workspace_root: root }), /project id/i);
  assert.equal(h.approvals.length, 0);
  await h.registry.register({ id: "tohieuquiz", workspace_root: root, allowed_roles: ["CODING"] });
  await assert.rejects(() => h.handlers.get("task_hub_project_register")({ id: "tohieuquiz", workspace_root: root, allowed_roles: ["CODING"] }), /already exists/i);
  assert.equal(h.approvals.length, 0);
});

test("project reads do not disclose mappings outside the active permission profile", async () => {
  const visibleRoot = process.platform === "win32" ? "C:\\visible" : "/visible";
  const hiddenRoot = process.platform === "win32" ? "D:\\hidden" : "/hidden";
  const h = fakeFacade({
    resolveRegistrationWorkspace: async (value) => {
      if (value === hiddenRoot) throw new Error("outside active roots");
      return { resolved: value };
    }
  });
  await h.registry.register({ id: "visible", workspace_root: visibleRoot, allowed_roles: ["CODING"] });
  await h.registry.register({ id: "hidden", workspace_root: hiddenRoot, allowed_roles: ["REVIEWER"] });
  const listed = parse(await h.handlers.get("task_hub_project_list")({}));
  assert.deepEqual(listed.projects.map((project) => project.id), ["visible"]);
  await assert.rejects(() => h.handlers.get("task_hub_project_get")({ id: "hidden" }), /outside active roots/i);
});

test("worker MCP facade exposes project reads, dispatch and status without lease ids", async () => {
  const h = fakeFacade();
  const root = process.platform === "win32" ? "C:\\quizpro" : "/tmp/quizpro";
  await h.registry.register({ id: "tohieuquiz", workspace_root: root, allowed_roles: ["CODING"] });
  const got = parse(await h.handlers.get("task_hub_project_get")({ id: "tohieuquiz" }));
  assert.equal(got.project.id, "tohieuquiz");
  const listed = parse(await h.handlers.get("task_hub_project_list")({}));
  assert.equal(listed.count, 1);
  const dispatched = parse(await h.handlers.get("task_hub_dispatch")({ id: "task-1" }));
  assert.equal(dispatched.local_agent_id, "a_0123456789abcdef");
  assert.equal("lease_id" in dispatched, false);
  const status = parse(await h.handlers.get("task_hub_worker_status")({ id: "task-1" }));
  assert.equal(status.task.status, "REVIEW");
  assert.equal("lease_id" in status, false);
});
