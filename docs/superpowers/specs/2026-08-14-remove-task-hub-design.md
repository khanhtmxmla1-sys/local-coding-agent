# Remove Task Hub Design

**Date:** 2026-08-14
**Status:** Approved design; implementation not started
**Repository:** `khanhtmxmla1-sys/local-coding-agent`
**Branch/worktree:** `chore/remove-task-hub` / `C:\\quizpro\\.worktrees\\remove-task-hub`

## Goal

Remove Task Hub and its dedicated orchestration surface while preserving the Local Coding Agent core, generic local-agent execution, GitHub MCP, GitNexus, installed skills, workspace tools, approval controls, browser tools, and user-owned QuizPro changes.

The selected retention policy is **A1: archive, then remove**.

## Current state

Task Hub is a cross-cutting subsystem rather than a standalone plugin. It currently includes:

- nineteen source and test files under `server/task-hub/`;
- imports, private-state initialization, dispatcher startup, MCP tool registration, policy lists, instructions, and dashboard integration in `server/server.mjs`;
- Task Hub-specific worker roles and result schemas in `server/agent-manager.mjs`;
- the `test:task-hub` package script and Task Hub assertions in core regression tests;
- operator workflow text in the Local Coding Agent `AGENTS.md`;
- mandatory Task Hub guards in the locally modified `C:\\quizpro\\AGENTS.md`;
- durable task/project state under `AGENT_TASK_HUB_DIR` and `AGENT_TASK_HUB_PROJECTS_DIR`, defaulting below the private state directory `%LOCALAPPDATA%\\LocalCodingAgent`.

The current Local Coding Agent implementation worktree is based on `origin/main` SHA `9f24fc26fdf830942a8abc41ca1d514d75a29101`. The QuizPro checkout has five pre-existing user changes that must not be reset, stashed, overwritten, committed, or deleted.

## Design

### 1. Archive before removal

A one-time operator script will:

1. resolve `AGENT_PRIVATE_STATE_DIR`, `AGENT_TASK_HUB_DIR`, and `AGENT_TASK_HUB_PROJECTS_DIR` using the same platform defaults as the server;
2. refuse to follow symlinks/junctions outside the resolved source directories;
3. copy task and project state to `<private-state>/backups/task-hub/<UTC timestamp>/`;
4. create a manifest containing source paths, file count, byte count, SHA-256 for every archived file, runtime version, and archive timestamp;
5. verify copied hashes before allowing active-state removal;
6. omit environment values, auth tokens, and unrelated private state from the manifest;
7. leave the backup untouched during normal uninstall and runtime restart.

If a source directory does not exist, the script records it as absent rather than failing. Any copy or verification mismatch stops the uninstall before deletion.

### 2. Remove Task Hub runtime surface

The implementation will remove:

- Task Hub imports, constants, storage checks, store/registry/dispatcher initialization, freshness/workspace helpers, tool registration, Task Hub instructions, approval-policy entries, and dashboard routes/views from `server/server.mjs`;
- Task Hub-only worker roles, managed-role checks, structured Task Hub output schema, and Task Hub-specific prompt/CLI branches from `server/agent-manager.mjs`;
- all files under `server/task-hub/`;
- the `test:task-hub` script from `server/package.json`;
- Task Hub-specific tests and assertions from shared regression suites;
- Task Hub operator instructions from Local Coding Agent documentation.

Generic local tasks remain available through `create_local_task`, `list_local_tasks`, `get_local_task_status`, `get_local_task_result`, and `cancel_local_task`. Generic agent roles remain intact unless a role exists solely for Task Hub and has no other public use.

### 3. Remove QuizPro enforcement without damaging dirty files

The QuizPro cleanup is a targeted edit, not a reset:

- remove only the section titled `CODING Task Hub is mandatory for coding work`;
- remove only Task Hub steps/references from the required-order and cleanup wording;
- retain plan approval, isolated worktree, GitNexus, TDD, review/verification, commit approval, PR/CI, merge, smoke, and cleanup gates;
- apply the same semantic cleanup to `CLAUDE.md` only where Task Hub-specific wording exists;
- preserve `.mcp-proxy-secrets.json`, the two untracked plan files, and all unrelated edits.

Because these files are already modified, their pre-change contents and diff will be captured before the targeted patch, then compared after the patch to prove no unrelated hunk changed.

### 4. Data removal and rollback

After the archive manifest verifies successfully and the Task Hub-free runtime passes tests:

- stop the old Local Coding Agent process gracefully;
- move active Task Hub state directories to a timestamped quarantine beside the backup;
- activate the Task Hub-free runtime;
- run health, tool-list, workspace, generic local-task, GitHub/GitNexus connectivity, approval, permission, and dashboard smoke checks;
- delete quarantine only after an explicit later cleanup approval.

Rollback restores the previous runtime bundle, restores the quarantined state directories to their original paths, and restarts the previous server. The archive is never used as the first rollback source while quarantine remains available.

### 5. Safety boundaries

The removal must not:

- uninstall the LoCal Coding ChatGPT plugin;
- remove GitHub MCP, GitNexus, Vercel, skills, browser tools, core file/command tools, approvals, permissions, or generic local tasks;
- delete existing QuizPro worktrees automatically;
- reset or clean either repository;
- modify production application code, Cloudflare, D1, Vercel production, deployments, migrations, or secrets;
- commit, push, open a PR, merge, or delete a branch without the matching user approval gate.

## Testing strategy

### RED

Add assertions that the public tool list, dashboard, help/instructions, worker roles, and package scripts no longer expose Task Hub. These tests must fail against the current baseline.

Add archive-script tests for:

- successful copy plus manifest/hash verification;
- absent source directories;
- copy/hash mismatch failure;
- symlink/junction refusal;
- no deletion before verification.

### GREEN and regression

Implement the smallest removal that satisfies the RED tests, then run:

- syntax checks for all changed `.mjs` files;
- focused removal/archive tests;
- `test:hardening`;
- `test:agents`;
- `test:permissions`;
- `test:context`;
- a controlled `test:agent` run with an isolated workspace fixture and correct workspace-rules hash;
- non-destructive security tests with an isolated endpoint;
- dashboard smoke proving the Tasks view is absent while Files/Diff and approvals still work;
- final source search proving no public `task_hub_*`, `TaskHub*`, `AGENT_TASK_HUB_*`, or `test:task-hub` references remain, except migration notes or archive labels intentionally retained.

## Delivery sequence

1. Record exact source/runtime/task-state inventory.
2. Run GitNexus impact analysis for `server.mjs` and `agent-manager.mjs`; stop on HIGH/CRITICAL risk for user confirmation.
3. Add RED tests.
4. Implement archive tooling and verify it on temporary fixtures.
5. Remove runtime, dashboard, worker, tests, and docs.
6. Run focused and full verification plus security/review.
7. Present exact diff and archive evidence; stop before commit.
8. After commit approval, commit only Local Coding Agent changes.
9. After push/PR approval, push and open a PR; wait for CI/review.
10. After merge approval, merge and build a clean runtime bundle.
11. Back up and quarantine live Task Hub state, activate the new runtime, and smoke-test.
12. Apply the targeted local QuizPro `AGENTS.md`/`CLAUDE.md` cleanup with before/after evidence.
13. Retain backup and quarantine until separate cleanup approval.

## Acceptance criteria

- No Task Hub MCP tools, dashboard UI, worker dispatcher, dedicated roles, environment variables, or startup state remain active.
- Task/project data is archived with a verified manifest before active state is quarantined.
- Local Coding Agent core, GitHub MCP, GitNexus, skills, approvals, permissions, dashboard core, browser tools, and generic local tasks remain functional.
- QuizPro's unrelated dirty files and worktrees are preserved.
- No production or deployment resource is changed.
- Rollback is documented and tested before activation.
