# Full Mode Approval Bypass and Dashboard Auto-Refresh Design

Date: 2026-08-14
Status: Approved design, pending implementation plan

## Problem

The active Local Coding Agent configuration is `policy=full`, and the primary workspace `C:\quizpro` has the `full_control` permission preset. The generic tool policy already bypasses action approvals in full mode, but Task Hub injects `consumeExactApproval` directly into its transition and project-registration facades. That direct call path can still raise an approval requirement even though `policy_status` reports no approval-required actions.

The dashboard also auto-refreshes only part of its state. Metrics/health poll every 2.5 seconds, v5 panels poll every 5 seconds, and Task lists poll while the Tasks view is active. The Files view still relies on explicit refresh actions, and its current `loadTree()` function resets file/diff state, so simply polling it would be disruptive.

## Goals

1. In `policy=full`, ordinary in-scope operations must not create or consume dashboard approval requests.
2. Keep filesystem root boundaries, deny rules, catastrophic-command protection, and explicit system-power opt-in unchanged.
3. Do not silently expand access outside authorized roots. Path-access grants remain explicit because they change the permission boundary rather than approve an already-authorized operation.
4. Make the dashboard refresh the active view automatically so the operator does not need to press a refresh button for normal status, Task, Files, or Diff updates.
5. Preserve the current user context while refreshing Files: selected file, diff mode, and active navigation should not be reset or flicker unnecessarily.
6. Keep manual refresh controls only as a fallback/debug affordance; normal use must not depend on them.

## Non-goals

- Removing the approval subsystem entirely.
- Changing `balanced` or `strict` semantics.
- Granting access to arbitrary paths outside the configured permission profile.
- Bypassing the Windows tray opt-in for shutdown.
- Replacing polling with WebSockets/SSE in this change.

## Chosen Approach

### 1. Central policy-aware exact-action authorization

Introduce a policy-aware authorization function in `server/server.mjs`, conceptually:

```text
authorizeExactAction(action):
  if AGENT_POLICY == full:
    return
  otherwise:
    consumeExactApproval(action)
```

Use this function everywhere an exact action authorization callback is injected into Task Hub. The existing `consumeExactApproval` remains responsible only for validating and consuming an already-issued approval record.

This keeps the distinction clear:

- `full`: no action-level approval prompt for already-authorized operations.
- `balanced`: exact approvals continue to be required where configured.
- `strict`: existing blocked-operation behavior remains unchanged.
- path authorization: still enforced separately by the permission profile and path-access flow.

This is preferred over changing every Task Hub call site independently because future direct authorization consumers will share the same policy behavior.

### 2. Full-mode approval dashboard behavior

When the dashboard loads pending approvals in full mode, action approvals that are bypassable by full policy should not be presented as work the operator must complete. Existing pending path-access approvals may still be shown because they represent a request to expand the authorized root set.

No broad auto-approval of old records is required. The UI/API can filter bypassed action approvals from the active pending list while keeping the underlying audit files intact.

### 3. Active-view auto-refresh

Keep the existing lightweight polling model and add one active-view refresh coordinator rather than adding more unrelated intervals.

Target cadence:

- Metrics/connection status: existing ~2.5 seconds.
- General v5 panels: existing ~5 seconds.
- Tasks view: refresh every ~5 seconds while active.
- Files view: refresh every ~5 seconds while active.

The Files refresh must be state-preserving:

- Tree refresh updates the directory contents without forcing `diffMode=false`.
- If a file is selected, refresh its content in place and preserve the selection.
- If Git diff mode is active, refresh the diff in place rather than toggling the mode off/on.
- Avoid replacing the tree with a loading placeholder during background refresh unless no tree has been loaded yet.

A small helper such as `refreshActiveView()` should dispatch to `loadAgents()`, a state-preserving file refresh helper, or `loadV5()` according to `activeView`.

### 4. Manual refresh remains optional

The top-level and Files refresh buttons may remain available for troubleshooting or immediate forced refresh, but their existence must not be required for correct live state. Their labels/tooltips can clarify that they are manual fallback actions.

## Affected Areas

Primary expected files:

- `server/server.mjs`
- `server/task-hub/tools.mjs` only if descriptions/tests need to reflect policy-aware approvals
- `server/task-hub/worker-tools.mjs` only if descriptions/tests need to reflect policy-aware approvals
- related server/Task Hub tests

The minimum implementation should keep production logic concentrated in `server/server.mjs` unless a testability concern justifies extracting a helper.

## Error Handling and Safety

- A failed background dashboard refresh should leave the last rendered state visible and mark connection state offline where the existing logic already does so.
- Background Files refresh must not erase the selected path merely because one fetch fails.
- Full-mode bypass must not skip path resolution, root authorization, permission-preset enforcement, freshness gates, Task Hub declared permission gates, or shutdown opt-in checks.
- `balanced` approval consumption must retain its lock and exact-action semantics.

## Testing

Add or update tests to cover at least:

1. `policy=full` Task Hub transition does not require an exact approval callback result for ordinary approval-bearing gates after all other task permission/freshness checks pass.
2. `policy=balanced` continues to require and consume exact approval.
3. Task Hub project registration follows the same policy-aware authorization path.
4. Full mode does not bypass path-access authorization or configured root boundaries.
5. Dashboard script contains an automatic active-view refresh path for Files and Tasks.
6. Files background refresh preserves selected file and diff mode instead of resetting them.
7. Existing tests for policy, approvals, Task Hub freshness, and dashboard/server behavior remain green.

## Acceptance Criteria

The change is complete when all of the following are true:

- With active `policy=full` and `full_control` on `C:\quizpro`, normal Local Coding Agent/Task Hub operations within that root do not ask the operator for approval.
- `policy_status` and observed runtime behavior agree: full mode has no action approvals to complete.
- Requests to add a new unauthorized filesystem root are still explicit permission-boundary changes.
- The dashboard updates live without the operator pressing `Làm mới` for normal operation.
- The Files view refreshes automatically without losing selection or diff state.
- `balanced` and `strict` retain their existing safety behavior.
- Relevant automated tests pass.

## Implementation Preference

Keep the patch small and policy-centric. Do not remove approval infrastructure, do not weaken path boundaries, and do not introduce a new real-time transport. A policy-aware exact-action authorization wrapper plus state-preserving active-view polling is sufficient for this request.
