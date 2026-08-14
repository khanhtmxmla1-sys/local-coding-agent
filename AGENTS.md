# AGENTS.md — setup guide for AI coding agents

If a user asks you (Claude Code, Codex, Cursor, or any LLM agent) to **install
and set up this repo**, follow these steps exactly. Keep the user informed and
ask before anything destructive.

## What this is
A local **MCP server** (`server/server.mjs`, Node.js) that lets ChatGPT Web act
as a coding agent on the user's machine, plus an optional **Windows tray app**
(`tray-app/`) and a **local dashboard** (`http://127.0.0.1:8790/ui`).

## Prerequisites (check first; do not auto-install without asking)
- **Node.js ≥ 18** — `node -v`. If missing, point the user to https://nodejs.org.
- **The OpenAI tunnel client is NOT in this repo** (proprietary). The user must
  obtain it and place it at `tools/tunnel-client.exe` (Windows) or
  `tools/tunnel-client` (macOS/Linux). Never download/commit it.
- (Windows tray app only) **.NET 10 SDK** — `dotnet --version`.
- Optional: **ripgrep** (`rg`) makes search faster; the server auto-detects it.

## Install (one command)
- Windows: `pwsh -File install.ps1`  (or `powershell -ExecutionPolicy Bypass -File install.ps1`)
- macOS/Linux: `bash install.sh`

This runs `npm install` in `server/` and creates `tools/`. It does NOT need sudo.

## Run
1. Decide the **workspace** = the folder the agent may read/write. Confirm it
   with the user.
2. Start the server (pick one):
   - Script: set `AGENT_WORKSPACE` then run `scripts/start-tunnel.ps1` (Windows)
     or `scripts/start-tunnel.sh` (macOS/Linux). It also starts the tunnel.
   - Server only (no tunnel), for a quick check:
     `cd server && AGENT_WORKSPACE=<path> AGENT_MODE=safe npm start`
3. Connect ChatGPT: ChatGPT → Settings → Connectors → enable Developer mode →
   add a custom MCP connector. Paste the tunnel's runtime key when the launcher
   asks (`CONTROL_PLANE_API_KEY`).

## Verify (always do this)
- Health: `curl http://127.0.0.1:8787/healthz` → expect `{"status":"ok",...}`.
- Tools: run `npm run test:agent` from `server/` (exercises all tools).
- End-to-end: ask ChatGPT to "call workspace_info" → it returns `roots` + `mode`.
  Those roots are the exact path ChatGPT reads/writes.

## Key config (env vars, see server/README.md)
`AGENT_WORKSPACE` (root folder), `AGENT_MODE` = `safe`|`full`, `AGENT_EXTRA_ROOTS`
(`;`-sep), `AGENT_EXTRA_ROOTS_JSON` (preferred for paths with separators),
`MCP_AUTH_TOKEN`, `DASHBOARD_PORT` (default 8790), `PORT` (8787).

## Gotchas (read before debugging)
- **Default to `AGENT_MODE=safe`.** `full` lets `run_command` do almost anything
  inside the roots; catastrophic system commands stay blocked regardless.
- **Do NOT use port 8788** for the dashboard — the OpenAI tunnel client binds it.
- **Two-clone trap**: if edits seem to "disappear", the user may have two copies
  of their repo at different paths. `workspace_info` shows the real path in use.
- It is **not a sandbox**. For untrusted workspaces use a VM/container/WSL2.
- Windows PowerShell 5.1 reads `.ps1` as ANSI — keep scripts ASCII-only.

## ChatGPT / Task Hub operator workflow (mandatory)

When a ChatGPT session is used to work on this repository, treat the following
Vietnamese operator commands as approval gates with the exact meanings below.
Do not silently advance to a later gate.

### 1. Audit / planning only

Operator command:

`AUDIT + LÊN PLAN, CHƯA SỬA CODE`

Required behavior:

- Inspect the repository and relevant runtime state using Local Coding Agent / Task Hub.
- Identify affected files, APIs, schemas, types, routes, shared components,
  migrations, permissions, generated contracts, and task dependencies.
- Check active Task Hub work for workspace overlap, project-relative path overlap,
  semantic overlap, explicit dependencies, and base SHA freshness.
- Produce a bounded implementation plan with acceptance criteria and expected
  verification.
- Do not modify source files.
- Do not commit, push, create a PR, merge, migrate, deploy, or write to production.

### 2. Implementation approval

Operator command:

`DUYỆT PLAN – TRIỂN KHAI`

Required behavior:

- Create or use one isolated Git worktree and one dedicated branch for the task.
- Create/use one Task Hub task/project mapping for that writable workspace.
- Record project-relative `planned_paths`, relevant `semantic_keys`, explicit
  `depends_on` relationships, acceptance criteria, and the current base SHA.
- Let Workspace Write Lock, Automatic Overlap Detector, and Base SHA Freshness
  checks fail closed before writable CODING proceeds.
- Implement with relevant TDD/tests, then run independent review and security
  checks.
- Stop before commit, push, or PR creation.

Core isolation rule: `1 task = 1 worktree = 1 branch = 1 PR`.

### 3. Commit / push / PR approval

Operator command:

`DUYỆT COMMIT + PUSH + TẠO PR`

Required behavior:

- Recheck status, diff, task scope, base freshness, and required tests.
- Review the staged diff and reject unrelated changes or blocking findings.
- Commit only the approved task scope, push the dedicated branch, and create one
  PR against `main`.
- Wait for CI/review and report branch, commit SHA, PR number, tests, CI state,
  and review findings.
- Do not merge. Merge requires a separate operator approval.

The operator may append a task label to the command, for example
`DUYỆT COMMIT + PUSH + TẠO PR DASHBOARD GIÁO VIÊN`; the approval still applies
only to that bounded task.

### 4. Merge / verify / cleanup approval

Operator command:

`DUYỆT MERGE PR #X + VERIFY + CLEANUP`

Required behavior before merge:

- Refresh the current base branch and verify the exact PR head SHA.
- Enforce Base SHA Freshness Gate and recheck overlap/dependency evidence.
- Require green CI and any required review/security gates.
- If `main` advanced since verification, sync the feature branch with latest
  `main`, inspect textual and semantic conflicts, rerun tests/review/security,
  and require fresh CI before merge.

Required behavior after merge:

- Record and verify the exact merge SHA on `main`.
- Run required post-merge smoke/E2E checks and confirm `HEAD == origin/main`.
- Only after successful verification remove the task worktree and delete the
  local and remote feature branches.
- If post-merge verification fails, keep debugging evidence and stop cleanup.

### Parallel ChatGPT sessions

Multiple ChatGPT tabs may audit, plan, review, or code at the same time, but the
same approval protocol applies independently to each task. Read-only work may
share a repo; writable CODING must use isolated worktrees. Related integration
is serialized: **CODING may run in parallel; integration / merge must be
serialized.** Never treat an old green CI result as current after `main` changes.

Automatic guards are safety controls, not substitutes for task understanding.
The Manager must still provide accurate `planned_paths`, `semantic_keys`,
`depends_on`, scope, and acceptance criteria.

## Parallel task delivery rules (mandatory)

These rules apply whenever one project is being handled from multiple ChatGPT tabs,
Task Hub tasks, or coding workers at the same time.

1. **Read-only work may run in parallel on the same repo.** Audits, planning, and
   reviewer tasks may share a source tree as long as they do not edit files.
2. **Concurrent CODING work must be isolated.** Every writable task gets its own
   Git worktree, branch, Task Hub task/project mapping, and later its own PR. Never
   let two CODING workers write to the same working tree or writable root.
3. **One task = one worktree = one branch = one PR.** Record the task's base SHA
   before coding and keep its scoped/planned touched paths as evidence.
4. **Detect overlap before dispatch.** Compare active tasks for exact file/path
   overlap and for semantic dependencies such as shared APIs, schemas, types,
   migrations, config, reusable components, or generated contracts. If one task
   depends on another, encode `depends_on` or serialize them instead of pretending
   they are independent.
5. **Coding may be parallel; merge is serialized.** Only one related PR should be
   integrated into `main` at a time. After PR A merges, every related PR B that was
   verified against the old base must sync with the new `main` before it can merge.
6. **A changed base invalidates merge readiness.** Rebase or merge the latest
   `main` into the downstream branch, resolve any conflicts, then rerun the
   relevant tests, independent reviewer, security checks, and CI. A previously
   green PR is not automatically still merge-ready after `main` changes.
7. **Do not resolve conflicts mechanically.** Never choose `ours`/`theirs` just to
   make Git clean. Preserve the intent and acceptance criteria of both tasks, and
   explicitly review the combined behavior.
8. **Check semantic conflicts even when Git reports none.** API signature changes,
   shared state, schemas, permissions, routes, generated files, and cross-cutting
   UI components can break another branch without producing a textual conflict.
9. **High-impact actions remain gated.** Commit, push, PR creation, merge,
   migration, deploy, and production writes still require their normal approval
   and verification gates; parallel work never bypasses them.
10. **Cleanup happens only after integration verification.** After merge, verify
    the exact `main` SHA and required smoke/E2E checks before deleting the feature
    branch/worktree.

Task Hub enforces a durable workspace-write lock and automatic overlap check at CODING claim time. The
Manager must still provide accurate project-relative `planned_paths`, `semantic_keys`, dependencies,
and acceptance criteria so relationships that cannot be inferred mechanically remain visible.

## Safety
Read `SECURITY.md`. Prompt injection is real; only connect trusted workspaces.
Never expose the server on a public tunnel without `MCP_AUTH_TOKEN`.
