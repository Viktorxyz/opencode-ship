---
description: Start a delivery workflow. First checks the setup-pending marker, runs skill discovery, then triggers planning with the same-HEAD Ready and merge gates.
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

### 1. Skill discovery (mandatory)

Before dispatching the planner, run the `skill-discovery` skill:

```text
npx skills find "<query from issue/plan>"
```

Auto-install trusted sources (see `ship.config.json#skillDiscovery.trustedOwners`); present non-trusted candidates to the user. Limit to 5 auto-installs per dispatch.

### 2. Plan + approve

1. Resolve or restore workflow state from `<git-common-dir>/opencode-ship/`.
2. Dispatch the strong planner (`openai/gpt-5.6-sol` by default) to produce a PlanV2 contract.
3. Wait for `ship_plan_approve` from the user. Never auto-approve.
4. Mirror the plan to the issue.

### 3. Execute

Drive each task through:

- cheap builder (`minimax/MiniMax-M3` by default) — implement + report
- task reviewer (Spec + Quality) — verdict
- controller commit + push
- same-HEAD gate: Standards + Spec final reviews, verifier, required CI

### 4. Ready

Stop at Ready. Surface PR URL, worktree path, verifier SHA, and the explicit-merge instruction.

### 5. Merge

On explicit `merge it`: fresh gate recheck, squash merge, cleanup, core downgrade, uninstall, root-config byte restoration.

## Hard rules

- **Never skip the setup gate.** If the marker is present, refuse to plan.
- **Never skip skill discovery.** The discovery is part of the autonomous-uplift contract.
- **Never auto-approve a plan.** The user always reviews the plan.
- **Never mark Ready or merge without a passing Standards review, a passing Spec review, a passing verifier run, and a passing required-CI check, all bound to one HEAD.**
- **Never force-push, hard-reset, stash, or `git worktree remove`.**
- **Never use `gh api` or raw shell on GitHub.** Use the typed `delivery_*` tools.

## Single-shot research checkpoint

If you decide the task is non-trivial, pause once and **ask the user** whether to run Deep Research before generating any prompt. The default save-tokens path is "no research, continue with the plan as written". Only on explicit "yes" do you generate a draft Deep Research prompt and run the research; summarize the relevant findings inline and continue. Do not write to `docs/research/` unless the findings materially shape an ADR; ADR storage is the project's call, not yours. Continue only after the user confirms or declines.

The full procedure lives in the `planning-research-checkpoint` skill. Do not duplicate the prompt-generation logic here — just trigger the skill and respect its ask-first policy.

## Stop conditions

- Setup pending: stop, run setup, then re-dispatch.
- Ready reached: stop. Surface the PR URL, the worktree path, the recorded verifier SHA, and the explicit-merge instruction.
- `merge it` requested and gates are fresh: perform the squash merge. Surface the merge SHA. The plugin will queue immediate cleanup; if cleanup fails it is recorded as `cleanupPending` and retried on the next Build task.
- Any gate fails after one re-run: stop. Surface the failing tool, the failing input, and the recorded evidence.
- Unexpected lifecycle error (missing-manifest, head-changed, ci-failing): stop. Surface the error envelope.
