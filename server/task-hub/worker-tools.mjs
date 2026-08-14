// Local Coding Agent - AI Task Hub worker/registry MCP facade
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

const PROJECT_ROLE_VALUES = ["CODING", "REVIEWER", "BROWSER"];

export function projectRegistrationApprovalAction(id, workspaceRoot, allowedRoles = []) {
  const roles = [...allowedRoles].map(String).sort().join(",");
  return `task_hub_project_register:${id}:${workspaceRoot}:roles=${roles}`;
}

export function registerTaskHubWorkerTools(mcp, { reg, jsonResult, registry, dispatcher, authorizeAction, resolveRegistrationWorkspace } = {}) {
  if (typeof reg !== "function") throw new Error("Task Hub worker tool registration requires reg().");
  if (typeof jsonResult !== "function") throw new Error("Task Hub worker tool registration requires jsonResult().");
  if (!registry) throw new Error("Task Hub worker tool registration requires a project registry.");
  if (typeof authorizeAction !== "function") throw new Error("Task Hub worker tool registration requires authorizeAction().");
  if (typeof resolveRegistrationWorkspace !== "function") throw new Error("Task Hub worker tool registration requires resolveRegistrationWorkspace().");

  reg(mcp, "task_hub_project_register", {
    title: "Register Task Hub project",
    description: "Register an immutable project_id to an allowed local workspace. This authority-bearing mapping uses the server's active policy-aware exact-action authorization.",
    inputSchema: {
      id: z.string().min(1).max(128),
      workspace_root: z.string().min(1).max(2000),
      allowed_roles: z.array(z.enum(PROJECT_ROLE_VALUES)).min(1).max(3).optional()
    }
  }, async ({ id, workspace_root, allowed_roles }) => {
    const resolved = await resolveRegistrationWorkspace(workspace_root);
    if (!resolved?.resolved) throw new Error("Project workspace could not be resolved.");
    const candidate = await registry.validate({ id, workspace_root: resolved.resolved, allowed_roles });
    if (await registry.get(candidate.id)) throw new Error(`Project ${candidate.id} already exists.`);
    await authorizeAction(projectRegistrationApprovalAction(candidate.id, candidate.workspace_root, candidate.allowed_roles));
    const project = await registry.register(candidate);
    return jsonResult({ ok: true, project });
  });

  reg(mcp, "task_hub_project_get", {
    title: "Get Task Hub project",
    description: "Read one registered Task Hub project mapping.",
    inputSchema: { id: z.string().min(1).max(128) }
  }, async ({ id }) => {
    const project = await registry.get(id);
    if (!project) throw new Error(`Project ${id} is not registered.`);
    await resolveRegistrationWorkspace(project.workspace_root);
    return jsonResult({ project });
  });

  reg(mcp, "task_hub_project_list", {
    title: "List Task Hub projects",
    description: "List registered Task Hub project mappings.",
    inputSchema: {}
  }, async () => {
    const projects = [];
    for (const project of await registry.list()) {
      try {
        await resolveRegistrationWorkspace(project.workspace_root);
        projects.push(project);
      } catch {
        // Do not disclose project paths outside the active permission profile.
      }
    }
    return jsonResult({ count: projects.length, projects });
  });

  reg(mcp, "task_hub_dispatch", {
    title: "Dispatch ready Task Hub task",
    description: "Dispatch one READY Task Hub task to a real supported local worker adapter. CODING and REVIEWER use the local Codex worker; BROWSER fails closed until a browser-capable worker exists.",
    inputSchema: { id: z.string().min(1).max(128) }
  }, async ({ id }) => {
    if (!dispatcher) throw new Error("Task Hub worker dispatcher is unavailable in compatibility mode.");
    return jsonResult(await dispatcher.dispatch(id));
  });

  reg(mcp, "task_hub_worker_status", {
    title: "Get Task Hub worker status",
    description: "Read the compact Task Hub/local-worker status. Raw Task Hub lease credentials are never returned.",
    inputSchema: { id: z.string().min(1).max(128) }
  }, async ({ id }) => {
    if (!dispatcher) throw new Error("Task Hub worker dispatcher is unavailable in compatibility mode.");
    return jsonResult(await dispatcher.status(id));
  });
}
