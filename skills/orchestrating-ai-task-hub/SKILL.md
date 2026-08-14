---
name: orchestrating-ai-task-hub
description: Use when one user request must be coordinated across multiple coding, browser, review, CI, or deploy workers or sessions with dependencies, durable status, evidence, and approval gates.
---

# Orchestrating AI Task Hub

## Overview

Use a **Manager + Task Hub + specialized workers** model for work that spans multiple roles, sessions, or approval gates. The Manager owns decomposition and user communication; the Task Hub owns coordination state; Git, tests, CI, browser evidence, and deployed SHA remain the sources of truth for execution evidence.

Do not assume ChatGPT tabs can message each other directly. A worker is only `RUNNING` when a real runtime has claimed its task.

## When to Use

Use this skill when work needs two or more of these:
- coding + browser verification + review;
- dependencies between tasks or sessions;
- parallel independent work;
- commit, PR, merge, migration, or deploy approval gates;
- durable status so the user does not manually shuttle instructions between tabs.

For a simple single-agent edit, use the normal development workflow instead.

## Roles

- **Manager:** decomposes work into a dependency graph, decides readiness, gathers evidence, asks for required approvals, and reports the final status.
- **Coding Worker:** source audit, implementation, tests, diff evidence.
- **Browser Worker:** E2E, responsive, accessibility, screenshots, read-only smoke checks.
- **Reviewer Worker:** independent findings with severity and file/line evidence.
- **GitHub/CI Worker:** PR/check/review state; never bypasses required checks.
- **Deploy Worker:** target-SHA verification, migration/deploy, smoke and rollback evidence after explicit permission.

## Task Contract

Every orchestrated task has:
`id`, `parent_id`, `goal`, `role`, `status`, `priority`, `depends_on[]`, `scope_in[]`, `scope_out[]`, `acceptance_criteria[]`, `permissions`, `evidence[]`, `blockers[]`, timestamps.

Default-deny permissions for `commit`, `push`, `merge`, `migrate`, `deploy`, and `production_write` until the user has granted the relevant approval.

Recommended lifecycle:

`DRAFT → PLANNED → APPROVED → READY → RUNNING → REVIEW → AWAITING_APPROVAL → COMMIT_READY → PR_OPEN → CI_PENDING → MERGE_READY → DEPLOYING → VERIFYING → DONE`

Exceptions: `BLOCKED`, `FAILED`, `CANCELLED`.

## Coordination Rules

1. A task becomes `READY` only when dependencies and mandatory gates are satisfied.
2. Independent read-only audit/planning/reviewer tasks may run in parallel on the same repository.
3. Concurrent writable CODING tasks must never share the same working tree or writable root. Give each task its own Git worktree, branch, Task Hub project/workspace mapping, and later its own PR.
4. Treat **one task = one worktree = one branch = one PR** as the default delivery unit. Record the task's base SHA before coding and its scoped/planned touched paths as evidence.
5. Before dispatch, compare active tasks for exact file/path overlap and semantic overlap such as shared APIs, schemas, types, migrations, routes, config, reusable components, generated contracts, or shared state. If one task depends on another, encode `depends_on` or serialize the work.
6. Coding may be parallel, but integration of related work is serialized. After PR A merges, any related PR B verified against the old base must sync with the new `main` before merge.
7. A changed base invalidates `MERGE_READY` for related downstream work. Rebase or merge latest `main`, resolve conflicts, then rerun relevant tests, independent review, security checks, and CI before restoring merge readiness.
8. Never resolve conflicts mechanically with `ours`/`theirs`. Preserve the intent and acceptance criteria of both tasks and review the combined behavior.
9. Check for semantic conflicts even when Git reports no textual conflict. A clean merge does not prove API/schema/permission/UI compatibility.
10. Reviewer tasks require implementation diff plus verification evidence.
11. Failed or blocked dependencies block downstream tasks.
12. Evidence, not narrative confidence, advances gates.
13. Never store secrets or sensitive payloads in task/evidence records.
14. Commit, push, PR creation, merge, migration, deploy, and production writes remain approval-gated even when tasks run in parallel.
15. Cleanup branches/worktrees only after the exact merged `main` SHA passes required smoke/E2E verification.

Until runtime workspace-write locking and overlap detection are implemented, the Manager must enforce these rules before dispatching writable workers.

## Required Companion Skills

- **REQUIRED:** Use `planning-and-task-breakdown` to define the DAG and acceptance criteria.
- Use `dispatching-parallel-agents` only for genuinely independent work.
- Use `subagent-driven-development` when executing bounded tasks through subagents.
- Use `git-workflow-and-versioning` for branch/commit/PR work.
- **REQUIRED before claiming completion:** Use `verification-before-completion`.
- Use `security-and-hardening` for authentication, secrets, production, or destructive actions.

## Runtime Boundary

Without a persistent Task Hub runtime, apply this skill as an orchestration contract within the current session and local task files. Do **not** simulate background execution, leases, heartbeats, or cross-tab delivery.

For the full persistent Task Hub data model, MCP API contract, leases, worker adapters, security, and phased implementation, read `REFERENCE.md` in this skill directory.

## Hard Stops

Stop rather than advance when an approval is missing, a dependency is incomplete, auth/secret access is missing, verification fails, CI/review has unresolved blocking findings, the production target SHA is unknown, or unrelated dirty work may be overwritten.
