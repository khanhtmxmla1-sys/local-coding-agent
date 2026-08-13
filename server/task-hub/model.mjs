// Local Coding Agent - AI Task Hub core model
// SPDX-License-Identifier: AGPL-3.0-or-later

export const TASK_ROLES = Object.freeze({
  MANAGER: "MANAGER",
  CODING: "CODING",
  BROWSER: "BROWSER",
  REVIEWER: "REVIEWER",
  GITHUB_CI: "GITHUB_CI",
  DEPLOY: "DEPLOY"
});

export const TASK_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  PLANNED: "PLANNED",
  APPROVED: "APPROVED",
  READY: "READY",
  RUNNING: "RUNNING",
  REVIEW: "REVIEW",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  COMMIT_READY: "COMMIT_READY",
  PR_OPEN: "PR_OPEN",
  CI_PENDING: "CI_PENDING",
  MERGE_READY: "MERGE_READY",
  DEPLOYING: "DEPLOYING",
  VERIFYING: "VERIFYING",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
});

export const TASK_PERMISSION_KEYS = Object.freeze([
  "read", "edit", "test", "browser", "commit", "push", "open_pr", "merge", "migrate", "deploy", "production_write"
]);

export const HIGH_IMPACT_PERMISSIONS = Object.freeze([
  "commit", "push", "open_pr", "merge", "migrate", "deploy", "production_write"
]);

const TASK_INPUT_FIELDS = new Set([
  "id", "parent_id", "project_id", "title", "goal", "role", "status", "priority", "depends_on", "scope_in", "scope_out", "acceptance_criteria", "permissions", "result_summary", "blocked_reason"
]);
const ROLE_VALUES = new Set(Object.values(TASK_ROLES));
const STATUS_VALUES = new Set(Object.values(TASK_STATUSES));
const PERMISSION_KEYS = new Set(TASK_PERMISSION_KEYS);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRANSITIONS = new Map([
  [TASK_STATUSES.DRAFT, new Set([TASK_STATUSES.PLANNED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.PLANNED, new Set([TASK_STATUSES.APPROVED, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.APPROVED, new Set([TASK_STATUSES.READY, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.READY, new Set([TASK_STATUSES.RUNNING, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.RUNNING, new Set([TASK_STATUSES.REVIEW, TASK_STATUSES.BLOCKED, TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.REVIEW, new Set([TASK_STATUSES.DONE, TASK_STATUSES.AWAITING_APPROVAL, TASK_STATUSES.BLOCKED, TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.AWAITING_APPROVAL, new Set([TASK_STATUSES.COMMIT_READY, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.COMMIT_READY, new Set([TASK_STATUSES.PR_OPEN, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.PR_OPEN, new Set([TASK_STATUSES.CI_PENDING, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.CI_PENDING, new Set([TASK_STATUSES.MERGE_READY, TASK_STATUSES.BLOCKED, TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.MERGE_READY, new Set([TASK_STATUSES.DEPLOYING, TASK_STATUSES.DONE, TASK_STATUSES.BLOCKED, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.DEPLOYING, new Set([TASK_STATUSES.VERIFYING, TASK_STATUSES.BLOCKED, TASK_STATUSES.FAILED])],
  [TASK_STATUSES.VERIFYING, new Set([TASK_STATUSES.DONE, TASK_STATUSES.BLOCKED, TASK_STATUSES.FAILED])],
  [TASK_STATUSES.BLOCKED, new Set([TASK_STATUSES.READY, TASK_STATUSES.RUNNING, TASK_STATUSES.REVIEW, TASK_STATUSES.AWAITING_APPROVAL, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.FAILED, new Set([TASK_STATUSES.READY, TASK_STATUSES.CANCELLED])],
  [TASK_STATUSES.DONE, new Set()],
  [TASK_STATUSES.CANCELLED, new Set()]
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}
function boundedString(value, label, { required = false, max = 4000 } = {}) {
  if (value == null) { if (required) throw new Error(`${label} is required.`); return null; }
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return trimmed || null;
}
function stringArray(value, label, { maxItems = 100, maxItemLength = 1000 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string.`);
    const trimmed = item.trim();
    if (trimmed.length > maxItemLength) throw new Error(`${label}[${index}] exceeds ${maxItemLength} characters.`);
    return trimmed;
  });
}
function normalizePermissions(input) {
  if (input == null) input = {};
  assertPlainObject(input, "permissions");
  for (const key of Object.keys(input)) {
    if (!PERMISSION_KEYS.has(key)) throw new Error(`Unknown permission field: ${key}`);
    if (typeof input[key] !== "boolean") throw new Error(`permissions.${key} must be boolean.`);
  }
  return Object.fromEntries(TASK_PERMISSION_KEYS.map((key) => [key, input[key] === true]));
}
export function assertTaskId(id, label = "id") {
  if (typeof id !== "string" || !TASK_ID_RE.test(id)) throw new Error(`${label} must match ${TASK_ID_RE}.`);
  return id;
}
export function createTaskRecord(input, { now = Date.now() } = {}) {
  assertPlainObject(input, "task");
  const unknown = Object.keys(input).filter((key) => !TASK_INPUT_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown task field(s): ${unknown.join(", ")}`);
  const id = assertTaskId(input.id);
  const role = input.role ?? TASK_ROLES.CODING;
  const status = input.status ?? TASK_STATUSES.DRAFT;
  if (!ROLE_VALUES.has(role)) throw new Error(`Invalid task role: ${role}`);
  if (!STATUS_VALUES.has(status)) throw new Error(`Invalid task status: ${status}`);
  const priority = input.priority ?? 50;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error("priority must be an integer from 0 to 100.");
  const dependsOn = stringArray(input.depends_on, "depends_on", { maxItems: 100, maxItemLength: 128 });
  dependsOn.forEach((dependencyId, index) => assertTaskId(dependencyId, `depends_on[${index}]`));
  if (dependsOn.includes(id)) throw new Error("Task cannot depend on itself.");
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error("Duplicate task dependency is not allowed.");
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("now must be a finite non-negative timestamp.");
  return {
    id,
    parent_id: input.parent_id == null ? null : assertTaskId(input.parent_id, "parent_id"),
    project_id: boundedString(input.project_id, "project_id", { max: 200 }),
    title: boundedString(input.title, "title", { max: 300 }),
    goal: boundedString(input.goal, "goal", { required: true, max: 4000 }),
    role, status, priority, depends_on: dependsOn,
    scope_in: stringArray(input.scope_in, "scope_in"),
    scope_out: stringArray(input.scope_out, "scope_out"),
    acceptance_criteria: stringArray(input.acceptance_criteria, "acceptance_criteria"),
    permissions: normalizePermissions(input.permissions),
    result_summary: boundedString(input.result_summary, "result_summary", { max: 8000 }),
    blocked_reason: boundedString(input.blocked_reason, "blocked_reason", { max: 2000 }),
    lease_owner: null, lease_proof: null, lease_expires_at: null,
    created_at: timestamp, updated_at: timestamp, version: 1
  };
}
export function canTransition(from, to) {
  if (!STATUS_VALUES.has(from) || !STATUS_VALUES.has(to)) return false;
  return TRANSITIONS.get(from)?.has(to) === true;
}
export function dependenciesSatisfied(task, tasksById) {
  const dependencies = Array.isArray(task?.depends_on) ? task.depends_on : [];
  return dependencies.every((id) => tasksById.get(id)?.status === TASK_STATUSES.DONE);
}
export function hasHighImpactPermission(task) {
  return HIGH_IMPACT_PERMISSIONS.some((permission) => task?.permissions?.[permission] === true);
}
