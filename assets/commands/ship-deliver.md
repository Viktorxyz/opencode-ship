---
description: Start a delivery workflow. First checks the setup-pending marker, then dispatches the durable ship-controller through ship_deliver.
---

# ship-deliver

`ship-deliver <issue-number>` is the canonical entry point
for a delivery workflow.

## Procedure

### 0. Setup gate (mandatory)

Before any plan or task dispatch, check for the setup-pending marker:

```bash
test -f .opencode/ship.setup-pending.json && echo SETUP_PENDING
```

If the marker is present:

- Read `.opencode/opencode.json` and `.opencode/ship.config.json` to confirm what is missing.
- Run the `setup-ship-workflow` skill in chat. Do not silently fill the gaps. Do not proceed to plan.
- After the skill completes and the user has filled in the model roles (and optionally the issue-tracker / triage / domain docs), the skill removes the marker. Re-run `ship-deliver <n>`.

If the marker is absent, continue.

### 1. Dispatch the controller

Call `ship_deliver` with the issue number. Do not implement the issue through the legacy `delivery_issue` / `delivery_worktree` / `delivery_pr` path.

1. Check setup-pending.
2. Call `ship_deliver(issueNumber)`.
3. Surface the controller session and `wf-<issue>` workflow id.
4. Await the explicit plan approval prompt.
5. Resume only through `ship-controller`.

### 2. Plan + approve

The controller starts or resumes durable workflow state, dispatches the planner, and waits for `ship_plan_approve`. Never auto-approve.

### 3. Execute

The controller drives each task through the cheap builder, task reviewer, commit binding, and same-HEAD Standards + Spec + verifier + required CI gates.

### 4. Ready

Stop at Ready. Surface PR URL, worktree path, verifier SHA, and the explicit-merge instruction.

### 5. Merge

On explicit `merge it`: fresh gate recheck, squash merge, and cleanup.

## Hard rules

- **Never skip the setup gate.** If the marker is present, refuse to plan.
- **Never auto-approve a plan.** The user always reviews the plan.
- **Never mark Ready or merge without a passing Standards review, a passing Spec review, a passing verifier run, and a passing required-CI check, all bound to one HEAD.**
- **Never force-push, hard-reset, stash, or `git worktree remove`.**
- **Never use `gh api` or raw shell on GitHub.** Use the typed `delivery_*` tools.
- **Never abandon an attempt without an explicit user request after the PR is closed unmerged.** The controller may then call `delivery_abandon`.

## Stop conditions

- Setup pending: stop, run setup, then re-dispatch.
- Ready reached: stop. Surface the PR URL, the worktree path, the recorded verifier SHA, and the explicit-merge instruction.
- `merge it` requested and gates are fresh: perform the squash merge. Surface the merge SHA.
- Any gate fails after one re-run: stop. Surface the failing tool, the failing input, and the recorded evidence.
