# Remove Task Hub Implementation Plan

> **For agentic workers:** Execute this plan inline in the existing isolated worktree. Task Hub dispatch is intentionally unavailable for this removal. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive all durable Task Hub state, remove the Task Hub runtime/dashboard/worker surface, and keep every unrelated Local Coding Agent and QuizPro capability working.

**Architecture:** A standalone archive/quarantine utility first protects durable state. TDD then establishes an absence contract for public Task Hub surfaces, after which Task Hub integrations and modules are removed. Activation occurs only after merge and uses backup plus quarantine so rollback does not depend on reconstructing state from scratch.

**Tech Stack:** Node.js 24, ES modules, `node:test`, MCP SDK, PowerShell runtime operations, Git/GitHub PR workflow.

## Global Constraints

- Work only in `C:\quizpro\.worktrees\remove-task-hub` on `chore/remove-task-hub`, based on `origin/main` SHA `9f24fc26fdf830942a8abc41ca1d514d75a29101`.
- The user's dirty `C:\quizpro` checkout must not be reset, stashed, cleaned, or broadly rewritten.
- Preserve Local Coding Agent core tools, approvals, permission profiles, generic local tasks, GitHub MCP, GitNexus, Vercel, skills, browser tooling, ports 8787/8790, and ngrok routing.
- Do not remove existing QuizPro worktrees automatically.
- No Cloudflare, D1, Vercel production, deployment, migration, or production-data operation is in scope.
- No commit, push, PR, merge, runtime cutover, active-state quarantine, or deletion occurs without its explicit gate.
- TDD is mandatory for executable removal and archive behavior.
- GitNexus impact/detect-changes is mandatory when available; a broken remote bridge must use the local CLI. HIGH/CRITICAL impact stops for confirmation.
- Active Task Hub data is never deleted directly. It is hash-verified in backup, then moved to quarantine. Quarantine deletion requires a later approval.
- The approved spec is `docs/superpowers/specs/2026-08-14-remove-task-hub-design.md`.

---

### Task 1: Freeze the inventory and establish the RED absence contract

**Files:**
- Create: `server/task-hub-removal.test.mjs`
- Read: `server/server.mjs`
- Read: `server/agent-manager.mjs`
- Read: `server/package.json`
- Read: `AGENTS.md`
- Read: `server/test-agent.mjs`
- Read: `server/test-hardening.mjs`

**Interfaces:**
- Consumes: current public server source and package scripts.
- Produces: a regression test that fails while any Task Hub public/runtime integration remains.

- [ ] **Step 1: Record the exact starting point**

Run:

```powershell
git status --short --branch
git rev-parse HEAD
git diff --stat
git ls-files server/task-hub
```

Expected: branch `chore/remove-task-hub`, HEAD `9f24fc2...`, only the approved spec/plan are untracked or modified.

- [ ] **Step 2: Run GitNexus pre-change analysis**

Use the indexed `local-coding-agent` repository or local CLI:

```powershell
node .gitnexus/run.cjs analyze
node .gitnexus/run.cjs impact --target server.mjs --direction upstream
node .gitnexus/run.cjs impact --target AgentManager --direction upstream
```

If the local CLI syntax differs, read the checked-in GitNexus skill and use its documented equivalent. Report direct callers, affected processes, and risk. Stop before code edits on HIGH/CRITICAL risk.

- [ ] **Step 3: Add the failing source absence test**

Create `server/task-hub-removal.test.mjs` with an explicit contract:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const absent = async (path) => stat(new URL(path, import.meta.url))
  .then(() => false, (error) => error?.code === "ENOENT");

test("Task Hub is absent from the public runtime", async () => {
  const [server, agents, pkg] = await Promise.all([
    read("./server.mjs"),
    read("./agent-manager.mjs"),
    read("./package.json"),
  ]);

  for (const token of [
    "task_hub_",
    "TaskHubStore",
    "TaskHubDispatcher",
    "registerTaskHubTools",
    "registerTaskHubWorkerTools",
    "AGENT_TASK_HUB_",
  ]) {
    assert.equal(server.includes(token), false, token);
  }

  assert.equal(agents.includes("coding_worker"), false);
  assert.equal(agents.includes("reviewer_worker"), false);
  assert.equal(agents.includes("isTaskHubManagedRole"), false);
  assert.equal(JSON.parse(pkg).scripts["test:task-hub"], undefined);
  assert.equal(await absent("./task-hub"), true);
});
```

- [ ] **Step 4: Run RED**

Run:

```powershell
node --test task-hub-removal.test.mjs
```

Expected: FAIL on current Task Hub tokens/directory/script. Save the failing output as RED evidence.

---

### Task 2: Build and verify the A1 archive/quarantine utility

**Files:**
- Create: `server/task-hub-archive.mjs`
- Create: `server/task-hub-archive.test.mjs`
- Create: `scripts/archive-task-hub-state.mjs`
- Modify: `server/package.json`

**Interfaces:**
- Produces:
  - `resolveTaskHubStatePaths(env, platform): { privateStateDir, taskDir, projectsDir, backupRoot }`
  - `archiveTaskHubState(options): Promise<{ archiveDir, manifestPath, manifest }>`
  - `quarantineTaskHubState(options): Promise<{ quarantineDir, moved: string[] }>`
  - CLI modes `archive`, `verify`, and `quarantine`.
- Consumes: Task Hub state paths only; never approvals, agent reports, credentials, or unrelated private state.

- [ ] **Step 1: Write archive RED tests**

The tests must use `mkdtemp` and temporary fixtures, never the live private-state directory:

```js
test("archive copies state and writes verified sha256 manifest", async () => {
  const result = await archiveTaskHubState({ taskDir, projectsDir, backupRoot, now: fixedNow });
  assert.equal(result.manifest.verified, true);
  assert.deepEqual(result.manifest.sources.map((x) => x.kind), ["tasks", "projects"]);
  assert.ok(result.manifest.files.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
});

test("archive records absent sources without failing", async () => {
  const result = await archiveTaskHubState({ taskDir: missingA, projectsDir: missingB, backupRoot });
  assert.equal(result.manifest.files.length, 0);
  assert.equal(result.manifest.sources.every((x) => x.status === "absent"), true);
});

test("archive refuses a symlink or junction source", async () => {
  await assert.rejects(
    archiveTaskHubState({ taskDir: linkedDir, projectsDir, backupRoot }),
    /symbolic link|junction|reparse/i,
  );
});

test("quarantine refuses to run without a verified manifest", async () => {
  await assert.rejects(
    quarantineTaskHubState({ taskDir, projectsDir, archiveDir: unverifiedArchive, quarantineRoot }),
    /verified archive/i,
  );
});
```

- [ ] **Step 2: Run archive RED**

Run:

```powershell
node --test task-hub-archive.test.mjs
```

Expected: FAIL because the archive module does not exist.

- [ ] **Step 3: Implement deterministic path resolution**

Use the same defaults formerly used by `server.mjs`:

```js
export function resolveTaskHubStatePaths(env = process.env, platform = process.platform) {
  const home = env.LOCALAPPDATA || env.APPDATA || os.homedir();
  const privateStateDir = path.resolve(
    env.AGENT_PRIVATE_STATE_DIR ||
      (platform === "win32"
        ? path.join(home, "LocalCodingAgent")
        : path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "local-coding-agent"))
  );
  return {
    privateStateDir,
    taskDir: path.resolve(env.AGENT_TASK_HUB_DIR || path.join(privateStateDir, "task-hub", workspaceId)),
    projectsDir: path.resolve(env.AGENT_TASK_HUB_PROJECTS_DIR || path.join(privateStateDir, "task-hub-projects")),
    backupRoot: path.join(privateStateDir, "backups", "task-hub"),
  };
}
```

The CLI must receive or calculate the same workspace ID as the server: SHA-256 of the canonical primary root, first 16 hex characters.

- [ ] **Step 4: Implement archive and verification**

Required manifest shape:

```js
{
  version: 1,
  kind: "local-coding-agent-task-hub-backup",
  created_at: "2026-08-14T00:00:00.000Z",
  runtime_version: "5.0.0",
  workspace_id: "16-hex-chars",
  verified: true,
  sources: [
    { kind: "tasks", original_path: "...", status: "copied" },
    { kind: "projects", original_path: "...", status: "copied" }
  ],
  files: [
    { source: "tasks", relative_path: "tasks/example.json", bytes: 123, sha256: "..." }
  ]
}
```

Copy with `fs.cp` only after `lstat`/realpath safety checks. Re-read every destination file, recompute SHA-256, and set `verified: true` only after all hashes match. Write the manifest last using a temporary file plus atomic rename.

- [ ] **Step 5: Implement quarantine with rollback-safe moves**

`quarantineTaskHubState` must:

1. load a manifest with `verified === true`;
2. verify the archive hashes again;
3. create `<private-state>/quarantine/task-hub/<timestamp>/`;
4. atomically rename each existing active directory into quarantine;
5. write `quarantine-manifest.json` with original and quarantine paths;
6. never remove quarantine.

- [ ] **Step 6: Add package scripts**

Add:

```json
"test:task-hub-removal": "node --test task-hub-removal.test.mjs task-hub-archive.test.mjs",
"task-hub:archive": "node ../scripts/archive-task-hub-state.mjs archive",
"task-hub:verify-archive": "node ../scripts/archive-task-hub-state.mjs verify",
"task-hub:quarantine": "node ../scripts/archive-task-hub-state.mjs quarantine"
```

The archive/quarantine scripts are transitional operator tools. They remain after Task Hub removal so backups can be verified and restored. Quarantine fails closed unless the operator has stopped the runtime and passes `--runtime-stopped`.

- [ ] **Step 7: Run GREEN for archive utility**

Run:

```powershell
node --test --test-name-pattern=archive task-hub-archive.test.mjs
```

Expected: archive tests PASS; absence-contract test still FAILS.

---

### Task 3: Remove Task Hub from server startup, MCP registration, policy, and dashboard

**Files:**
- Modify: `server/server.mjs`
- Modify: `server/test-hardening.mjs`
- Modify: `server/test-agent.mjs`
- Modify: `server/task-hub-removal.test.mjs`

**Interfaces:**
- Removes all `task_hub_*` MCP tools and Tasks dashboard/API.
- Preserves `create_local_task`, generic agent manager, Files/Diff dashboard views, approvals, permission resolver, and workspace bootstrap.

- [ ] **Step 1: Extend RED integration coverage**

In `task-hub-removal.test.mjs`, spawn an isolated server and assert:

```js
const names = tools.tools.map((tool) => tool.name);
assert.equal(names.some((name) => name.startsWith("task_hub_")), false);
for (const name of [
  "workspace_info",
  "workspace_bootstrap",
  "read_file",
  "run_command",
  "create_local_task",
  "list_local_tasks",
  "request_approval",
]) {
  assert.ok(names.includes(name), name);
}
```

Fetch the loopback dashboard HTML/API and assert Task Hub labels/routes are absent while Files, Diff, and Approvals remain.

- [ ] **Step 2: Run integration RED**

Run:

```powershell
node --test task-hub-removal.test.mjs
```

Expected: FAIL because Task Hub tools/dashboard are still registered.

- [ ] **Step 3: Remove Task Hub imports and state initialization**

From `server/server.mjs`, remove imports for:

```js
TaskHubStore
registerTaskHubTools
ProjectRegistry
TaskHubDispatcher
registerTaskHubWorkerTools
inspectGitRepository
isTaskHubManagedRole
```

Remove `TASK_HUB_DIR`, `TASK_HUB_PROJECTS_DIR`, stores, dispatcher startup, registration/dispatch/freshness helpers, Task Hub instructions, Task Hub tool registration calls, policy tool-name entries, and local-task branches that refer users to `task_hub_worker_status`.

- [ ] **Step 4: Remove dashboard Task Hub surfaces**

Remove only Task Hub-specific:

- Tasks navigation/tab;
- Task Hub list/detail/approval controls;
- Task Hub dashboard API routes and serializers;
- automatic polling branches that exist only for the Tasks view.

Retain shared refresh coordination needed by Files/Diff/Approvals. Update hardening expectations from “Task Hub/full-policy behavior” to generic approval and dashboard-refresh behavior.

- [ ] **Step 5: Remove Task Hub test environment variables**

Update `startServer` in `test-hardening.mjs` to remove:

```js
taskHubDir
taskHubProjectsDir
AGENT_TASK_HUB_DIR
AGENT_TASK_HUB_PROJECTS_DIR
```

Delete Task Hub-only hardening assertions. Keep the unrelated full-policy/path-access and Files/Diff sequencing tests.

- [ ] **Step 6: Run focused GREEN**

Run:

```powershell
node --check server.mjs
node test-hardening.mjs
node --test task-hub-removal.test.mjs
```

Expected: syntax PASS, hardening PASS, server/tool/dashboard absence assertions PASS.

---

### Task 4: Remove Task Hub-only worker roles while preserving generic local agents

**Files:**
- Modify: `server/agent-manager.mjs`
- Modify: `server/test-agents.mjs`
- Modify: `server/test-agent.mjs`

**Interfaces:**
- Removes: `coding_worker`, `reviewer_worker`, `isTaskHubManagedRole`, `TASK_HUB_CODEX_RESULT_SCHEMA`, and Task Hub structured-result branches.
- Preserves: generic public agent roles, `AgentManager.spawn`, provider detection, local task status/result/cancel APIs, sandbox constraints, and standard Codex output capture.

- [ ] **Step 1: Add worker-role RED assertions**

Update `test-agents.mjs`:

```js
test("Task Hub-only worker roles are not registered", () => {
  assert.equal("coding_worker" in ROLES, false);
  assert.equal("reviewer_worker" in ROLES, false);
});
```

Keep tests for generic role lookup and sandbox argument generation using a surviving public role such as `bug_fix`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm run test:agents
```

Expected: FAIL because Task Hub roles still exist.

- [ ] **Step 3: Remove dedicated roles and schema branching**

Delete role definitions, Task Hub prompts, managed-role helper, output schema, temporary schema-file behavior, and Task Hub-specific result parsing. Do not change generic `buildCodexExecArgs`, agent lifecycle, process cancellation, or result file behavior beyond removing the special schema branch.

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm run test:agents
node --test task-hub-removal.test.mjs
```

Expected: PASS.

---

### Task 5: Delete Task Hub modules and update package/docs

**Files:**
- Delete: `server/task-hub/` recursively (19 tracked files)
- Modify: `server/package.json`
- Modify: `AGENTS.md`
- Modify if references exist: `README.md`
- Modify if references exist: `server/README.md`
- Modify if references exist: `.env.example`
- Modify if references exist: launcher/startup scripts
- Keep: `server/task-hub-archive.mjs`, `server/task-hub-archive.test.mjs`, `server/task-hub-removal.test.mjs`

**Interfaces:**
- Consumes: successful Tasks 2–4.
- Produces: source tree with no live Task Hub implementation, plus recovery tooling.

- [ ] **Step 1: Delete the tracked subsystem**

Use an exact recursive patch/delete for `server/task-hub`. Confirm the deletion list equals the 19 files recorded in Task 1. Do not delete similarly named archive/removal files outside that directory.

- [ ] **Step 2: Update package scripts**

Remove `test:task-hub`. Retain the transitional archive/removal scripts created in Task 2.

- [ ] **Step 3: Rewrite Local Coding Agent operator rules**

In `AGENTS.md`:

- rename “ChatGPT / Task Hub operator workflow” to “ChatGPT operator workflow”;
- keep all four approval commands;
- replace Task Hub overlap/lease/freshness language with manual isolated-worktree, scoped-diff, and base-freshness checks;
- preserve `1 task = 1 worktree = 1 branch = 1 PR`;
- remove claims that Task Hub enforces locks or overlap.

Do not weaken commit, push, PR, merge, production, or cleanup gates.

- [ ] **Step 4: Remove all remaining public references**

Run:

```powershell
git grep -n -I -E "task_hub_|TaskHub(Store|Dispatcher)|registerTaskHub|AGENT_TASK_HUB_|test:task-hub" -- .
```

Expected matches: only intentional archive/removal test/script/spec/plan labels. Any runtime, public documentation, config, or dashboard match must be removed.

- [ ] **Step 5: Run removal GREEN**

Run:

```powershell
npm run test:task-hub-removal
npm run test:hardening
npm run test:agents
npm run test:permissions
npm run test:context
node --check server.mjs
node --check agent-manager.mjs
```

Expected: all PASS.

---

### Task 6: Full verification, security review, and pre-commit handoff

**Files:**
- Review all changed/deleted files only.
- No new production/runtime changes.

**Interfaces:**
- Produces: verified diff, archive-tool evidence, rollback evidence, and an approval-ready file list.

- [ ] **Step 1: Run a controlled agent smoke fixture**

Create a temporary workspace outside the source tree with a minimal AGENTS.md, call `workspace_bootstrap`, pass its returned hash to mutation calls, and run `test:agent` or an equivalent focused MCP smoke. Clean only that temporary fixture afterward.

Expected: core tools pass and tool list contains no `task_hub_*`.

- [ ] **Step 2: Run isolated security checks**

Start the candidate server on non-live ports with an explicit temporary `TEST_ENDPOINT`, loopback binding, temporary approvals directory, and no public tunnel. Run:

```powershell
npm run test:security
npm run test:security:baseline
```

Expected: PASS; no live ports/processes touched.

- [ ] **Step 3: Run archive dry-run against fixtures**

Run the archive, verify, and quarantine commands against temporary fixture directories. Confirm quarantine restore can move them back to original fixture paths and hashes still match.

- [ ] **Step 4: Run final GitNexus and source review**

Run `detect_changes` against `main`. Review:

```powershell
git diff --check
git diff --stat
git diff --name-status
git diff
git status --short
```

Resolve all P1/P2 findings. Warn and stop on unexpected files or HIGH/CRITICAL impact.

- [ ] **Step 5: Present the approval gate**

Report:

- exact changed/deleted files;
- RED and GREEN evidence;
- full test/security results;
- GitNexus risk/processes;
- archive/quarantine/restore fixture evidence;
- remaining activation risk and rollback;
- explicit confirmation that QuizPro dirty files/worktrees and live runtime are untouched.

Stop before commit and request `DUYỆT COMMIT`.

---

### Task 7: Commit, PR, merge, archive, cutover, and QuizPro rule cleanup

**Files:**
- Commit only files approved in Task 6.
- Operationally modify only the live runtime bundle/private Task Hub state after merge approval.
- Targeted local-only cleanup: `C:\quizpro\AGENTS.md` and `C:\quizpro\CLAUDE.md`.

**Interfaces:**
- Consumes: approved verified code and explicit gates.
- Produces: merged Task Hub-free runtime, verified backup/quarantine, preserved QuizPro working state.

- [ ] **Step 1: Commit only after approval**

Stage exact approved paths and commit:

```powershell
git commit -m "refactor: remove Task Hub orchestration"
```

Do not push.

- [ ] **Step 2: Push and open PR only after separate approval**

Push `chore/remove-task-hub`, open one draft PR against `main`, and include scope, deletions, archive behavior, tests, security, no-production impact, and rollback.

- [ ] **Step 3: Require green CI/review before merge**

Recheck current PR HEAD, base freshness, CI, approvals, unresolved threads, and mergeability. Merge only after explicit merge approval.

- [ ] **Step 4: Build candidate runtime**

Create a clean runtime bundle from the exact merge SHA. Install locked dependencies and rerun focused verification on non-live ports.

- [ ] **Step 5: Archive live state**

Run:

```powershell
npm run task-hub:archive
npm run task-hub:verify-archive
```

Record archive directory and manifest hash. If verification fails, stop; do not stop the live server or move active state.

- [ ] **Step 6: Quarantine and cut over**

Gracefully stop only the verified live Local Coding Agent PID, run `npm run task-hub:quarantine -- --runtime-stopped`, start the candidate bundle on ports 8787/8790 with the same non-Task-Hub settings, and smoke-test health/tools/dashboard/GitHub/GitNexus/generic local tasks.

On failure: stop candidate, restore quarantine to original paths, restart previous runtime, and report rollback.

- [ ] **Step 7: Targeted QuizPro rule cleanup**

Before editing, capture:

```powershell
git -C C:\quizpro status --short
git -C C:\quizpro diff -- AGENTS.md CLAUDE.md
```

Remove only Task Hub-specific wording. Preserve GitNexus, TDD, isolated worktree, approval, PR/CI/merge/smoke/cleanup gates and every unrelated dirty hunk. Show before/after diff.

- [ ] **Step 8: Final report**

Report merge/runtime SHA, backup and quarantine paths, tool absence/preservation smoke, untouched user files/worktrees, and rollback status. Keep archive and quarantine. Their deletion requires a new explicit cleanup approval.
