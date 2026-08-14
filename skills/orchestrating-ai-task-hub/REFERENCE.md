# AI Task Hub Runtime Reference

## 1. Target architecture

```text
ChatGPT / Manager
       |
       v
Task Hub MCP/API + durable state
       |
       +--> Local Coding Worker
       +--> Browser / Playwright Worker
       +--> Reviewer Worker
       +--> GitHub / CI Worker
       +--> Deploy Worker
       |
       v
Approval Gates --> User
```

The Task Hub coordinates work. It does not replace the execution truth held by Git, tests, CI, browser assertions, or production deployment state.

## 2. Persistent data model

### `tasks`
- `id TEXT PRIMARY KEY`
- `parent_id TEXT NULL`
- `project_id TEXT`
- `title TEXT`
- `goal TEXT`
- `role TEXT`
- `status TEXT`
- `priority INTEGER`
- `scope_in_json TEXT`
- `scope_out_json TEXT`
- `acceptance_json TEXT`
- `permissions_json TEXT`
- `result_summary TEXT NULL`
- `blocked_reason TEXT NULL`
- `lease_owner TEXT NULL`
- `lease_token_hash TEXT NULL`
- `lease_expires_at INTEGER NULL`
- `created_by TEXT`
- `created_at INTEGER`
- `updated_at INTEGER`
- `version INTEGER`

### `task_dependencies`
- `task_id TEXT`
- `depends_on_task_id TEXT`
- composite primary key

### `task_events`
Append-only audit history:
- `id TEXT PRIMARY KEY`
- `task_id TEXT`
- `event_type TEXT`
- `actor_type TEXT`
- `actor_id TEXT`
- `payload_json TEXT`
- `created_at INTEGER`

### `task_evidence`
- `id TEXT PRIMARY KEY`
- `task_id TEXT`
- `kind TEXT`
- `uri TEXT NULL`
- `summary TEXT`
- `sha256 TEXT NULL`
- `metadata_json TEXT`
- `created_at INTEGER`

### `approval_gates`
- `id TEXT PRIMARY KEY`
- `task_id TEXT`
- `gate_type TEXT`
- `status TEXT` (`PENDING|APPROVED|REJECTED|EXPIRED`)
- `requested_by TEXT`
- `decided_by TEXT NULL`
- `decision_note TEXT NULL`
- `created_at INTEGER`
- `decided_at INTEGER NULL`

### `workers`
- `id TEXT PRIMARY KEY`
- `worker_type TEXT`
- `capabilities_json TEXT`
- `status TEXT`
- `last_heartbeat_at INTEGER`
- `metadata_json TEXT`

## 3. MCP/API contract

### Manager-facing tools
- `create_task`
- `create_subtasks`
- `get_task`
- `list_tasks`
- `get_task_graph`
- `request_approval`
- `approve_gate`
- `reject_gate`
- `cancel_task`

### Worker-facing tools
- `register_worker`
- `claim_task`
- `heartbeat_task`
- `update_progress`
- `append_evidence`
- `submit_result`
- `block_task`
- `fail_task`
- `release_task`

### Read-only observability tools
- `list_events`
- `list_evidence`
- `worker_status`
- `task_metrics`

## 4. Claim, lease, and recovery

A worker may claim a task only when:
1. task status is `READY`;
2. all dependencies are `DONE`;
3. worker role/capabilities satisfy task requirements;
4. no mandatory approval gate remains pending;
5. no valid lease exists.

Claim must be atomic. Use a transaction or conditional update on `version`, for example conceptually:

```text
UPDATE tasks
SET status='RUNNING', lease_owner=?, lease_expires_at=?, version=version+1
WHERE id=? AND status='READY' AND version=? AND lease_is_available
```

The caller receives an opaque lease token. Heartbeats extend only the matching active lease. Do not store raw lease tokens.

If a worker disappears, lease expiry recovers the task according to policy. Safe/read-only tasks may return to `READY`. Tasks with potentially non-idempotent side effects should become `BLOCKED` until reconciliation proves whether the action happened.

## 4A. Parallel sessions, worktrees, overlap, and integration freshness

### Read-only parallelism
Audit, planning, and reviewer tasks may run concurrently against the same repository when they are truly read-only. A shared read source does not require a worktree per task.

### Writable isolation
Every concurrent CODING task must have a distinct writable root. The default mapping is:

```text
Task A -> worktree A -> branch A -> PR A
Task B -> worktree B -> branch B -> PR B
```

Do not let two active CODING workers claim the same working tree or writable root. Task Hub now enforces this inside the durable claim transaction: the resolved writable workspace is converted to a private `workspace_lock_key`, and a second active CODING claim for the same key fails before a lease is issued. The raw workspace lock key is internal and is not returned by public task tools.

### Overlap and dependency detection
Before dispatching a writable task, Task Hub compares it with active CODING siblings that belong to the same Git repository identity. Linked worktrees share a repository identity derived from Git's common directory while retaining different workspace lock keys. Detection uses:
- textual/path overlap: `planned_paths` plus path-like literals inferred from `scope_in`; exact or ancestor/descendant path overlap is a hard conflict and blocks the second claim;
- semantic overlap: `semantic_keys` plus structured literals such as `api:`, `route:`, `schema:`, `type:`, `component:`, `migration:`, `config:`, `state:`, `contract:`, and `permission:`. Semantic-only overlap may run in separate worktrees but is persisted as `parallel_guard.requires_revalidation=true`.

If B requires A's output, still encode `B depends_on A`. Automatic overlap detection is conservative and cannot replace explicit dependency modeling.

### Merge serialization
Coding may happen in parallel, but related integration is serialized. After PR A merges, PR B is not allowed to merge merely because it was green earlier. If B's verification base is older than current `main`, its previous merge readiness is stale.

Required downstream flow:

```text
A merge -> main advances
          |
          v
B syncs latest main
  -> resolve textual conflicts if any
  -> inspect semantic conflicts even if Git reports none
  -> rerun relevant tests
  -> rerun independent reviewer/security checks
  -> rerun CI
  -> restore MERGE_READY only when evidence is green
```

Never resolve a conflict mechanically with `ours` or `theirs`. The combined result must preserve the intent and acceptance criteria of both tasks.

### Freshness rule
For related writable tasks, `MERGE_READY` is valid only for the exact verified base/head relationship. Task Hub's Base SHA Freshness Gate refreshes the configured base ref (default `origin/main`) before entering or advancing from `MERGE_READY`, verifies that the refreshed base is an ancestor of the task branch HEAD, and records `verified_base_sha` plus `verified_head_sha`. If either SHA changes afterward, the next gated transition fails until the branch is synchronized and verification evidence is re-established. The freshness check runs before merge approval is consumed, so a stale task cannot waste or bypass an approval.

### Cleanup rule
Delete feature branches and worktrees only after the merged `main` SHA is known and required post-merge smoke/E2E verification succeeds. Failed post-merge verification blocks cleanup that would destroy useful debugging evidence.

## 5. Idempotency

Every external side effect should carry an idempotency key derived from the task and action, especially:
- commit creation;
- PR creation;
- migrations;
- deploys;
- production writes.

Retrying a task must never silently create a duplicate destructive action.

## 6. Permission model

Task permissions should be explicit capabilities, such as:
- `read`
- `edit`
- `test`
- `browser`
- `commit`
- `push`
- `open_pr`
- `merge`
- `migrate`
- `deploy`
- `production_write`

Default deny the high-impact capabilities. Approval gates can authorize a bounded action, not grant permanent broad rights to a worker.

## 7. Worker adapters

### Local Coding Worker
Uses existing Local Coding Agent tools for:
- workspace discovery;
- file/code navigation;
- read/write/patch;
- tests, lint, typecheck, build;
- Git status/diff/worktree operations;
- code intelligence tools available in the connected project.

The adapter should receive a bounded task packet instead of unrestricted natural-language authority.

### Browser Worker
Uses Playwright/browser tools for:
- E2E assertions;
- responsive verification;
- accessibility checks;
- screenshots and console/network evidence;
- read-only production smoke tests.

### Reviewer Worker
Input should include goal, approved plan, scoped diff, test evidence, and acceptance criteria. Output should use a stable schema such as:
- severity (`P1|P2|P3`);
- file/line or artifact reference;
- impact;
- rationale;
- suggested remediation.

Reviewer output is evidence, not automatic authorization to merge or deploy.

### GitHub / CI Worker
May:
- create/read PRs when permitted;
- read required check status;
- read review state;
- append PR/CI evidence.

It must not merge while required checks are pending/failing or blocking findings remain unresolved.

### Deploy Worker
May run only after an explicit deployment gate. It must:
- verify target environment and exact SHA;
- perform migration preflight when relevant;
- execute the bounded deploy;
- record deployment evidence;
- run smoke verification;
- surface rollback criteria/results.

## 8. State transitions

Recommended happy path:

```text
DRAFT
  -> PLANNED
  -> APPROVED
  -> READY
  -> RUNNING
  -> REVIEW
  -> AWAITING_APPROVAL
  -> COMMIT_READY
  -> PR_OPEN
  -> CI_PENDING
  -> MERGE_READY
  -> DEPLOYING
  -> VERIFYING
  -> DONE
```

Exceptional states:
- `BLOCKED`
- `FAILED`
- `CANCELLED`

Not every task needs every happy-path state. A read-only audit may finish after `REVIEW`. Transitions that are N/A should be explicit rather than silently skipped in aggregate workflow reporting.

## 9. Security requirements

- Authenticate Manager and worker callers with scoped identities/tokens.
- Capability allowlist each worker type.
- Never store API keys, auth cookies, private SSH keys, or raw access tokens in task/evidence payloads.
- Redact sensitive user/student data before crossing an external reviewer boundary.
- Keep `task_events` append-only.
- Require explicit approval for production/destructive operations.
- Rate-limit mutation and claim endpoints.
- Preserve Local Coding Agent's existing workspace confinement and command policy; Task Hub must not become an arbitrary-shell bypass.
- Validate all task-supplied paths against configured workspace roots.

## 10. Observability

Minimum metrics:
- queue depth by role/status;
- task throughput;
- time in each status;
- blocked duration;
- retry count;
- lease expiry/recovery count;
- worker heartbeat health;
- verification/review failure rate;
- approval wait duration;
- CI pass/fail;
- deploy success/rollback rate.

Logs and metrics should correlate by `task_id`, `event_id`, `worker_id`, and where relevant commit/PR/deploy SHA.

## 11. Recommended implementation phases for Local Coding Agent

### Phase 0 — Skill + architecture contract
Current step. Add the global orchestration skill and this reference. No MCP runtime behavior changes.

### Phase 1 — Task domain module + local persistence
Prefer a separate module rather than growing `server/server.mjs` indefinitely, for example:

```text
server/
  task-hub/
    model.mjs
    store.mjs
    state-machine.mjs
    permissions.mjs
```

Add tests for valid/invalid transitions, dependency readiness, permissions, event append behavior, and optimistic concurrency.

Start with local durable storage compatible with the server's current deployment model. Avoid introducing remote infrastructure before the contract is proven locally.

### Phase 2 — MCP Task Hub tools
Expose Manager and Worker tools through the existing MCP server. Add schema validation, authorization, audit events, and contract tests.

### Phase 3 — Claim/lease worker loop
Implement worker registration, atomic claims, heartbeats, lease expiry, safe recovery, idempotency rules, and concurrency tests proving one task cannot be claimed twice.

### Phase 4 — Specialized adapters
Add bounded adapters for Local Coding, browser, reviewer, and GitHub/CI. Keep their permissions separate.

### Phase 5 — Deploy + dashboard + hardening
Add production gates, deploy reconciliation, Task Hub dashboard, worker health, metrics, rate limits, audit integrity checks, and failure/chaos tests.

## 12. Acceptance scenario

Input to Manager:

```text
Audit random question behavior. Fix if necessary, run browser regression,
get an independent review, and stop before commit.
```

Expected orchestration:

```text
Parent task
├─ Coding audit/fix task
├─ Browser verification task
└─ Reviewer task (depends on Coding + Browser)
```

The system must collect real evidence and stop at `AWAITING_APPROVAL` before commit. The user should not need to copy instructions manually between tabs.

If a worker dies, the lease model must recover safely. If CI fails or reviewer finds unresolved P1/P2 issues, merge/deploy must remain locked.
