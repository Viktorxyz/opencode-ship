---
name: delivery-workflow
description: Orchestrates the canonical delivery lifecycle from issue creation through Ready PR. Use when the user asks for "implement issue N", "work on ready issues", "delivery", "autonomous delivery", or after a plan-mode session confirms the work scope.
---

# delivery-workflow

You drive the opencode-ship package from a one-line user request to a green, conflict-free, ready-to-merge pull request.

## When you trigger

- "Implement issue N", "work on issue N", "deliver issue N"
- "Pick the next ready issue and implement it"
- "Open a PR for #N"
- "Mark PR #N ready"
- "Merge PR #N" — only valid if you already created the PR through this workflow
- "Clean up my worktree" / "Tidy old worktrees" — entry point for next-task cleanup

Do **not** trigger on:
- Read-only questions ("explain issue N")
- Plain chat about the project's domain model
- Typo / doc one-liners that do not deserve a PR

## Lifecycle contract

| Step | Tool | Notes |
|---|---|---|
| 1. Cleanup old worktrees | `delivery_inspect` for each manifest, recovery scan, `delivery_cleanup` for provably-merged ones | Runs immediately after a successful merge; retries on next Build task if interrupted |
| 2. Offer research checkpoint | (this skill) | Single-shot per session; offer only if the plan is non-trivial |
| 3. Find or create the issue | `delivery_issue` | Always idempotent; never create a duplicate |
| 4. Create a worktree | `delivery_worktree` | Refuse overwrites; refuse dirty tree |
| 5. Implement | (consumer-owned) | Stay inside the worktree |
| 6. Commit + push | (consumer-owned `git`) | Use Conventional Commits |
| 7. Open draft PR | `delivery_pr` | `Closes #N` is added automatically |
| 8. Sync with default branch | (consumer-owned `git`) | Merge `origin/main` into the feature branch; never rebase a published branch |
| 9. Review | `task reviewer:delivery-reviewer` | Re-run if HEAD changed |
| 10. Verify | `task verifier:delivery-verifier` | Same final HEAD required |
| 11. Mark Ready | `delivery_ready` | Refreshes checks; refuses if any gate is stale |
| 12. Stop at Ready | (this skill) | Do not merge without an explicit user request |
| 13. Merge (only on explicit request) | `delivery_merge` | Re-checks base, head, and mergeability |
| 14. Immediate cleanup | `delivery_cleanup` | Runs automatically right after a successful merge |

## Hard rules

1. Every PR carries a `Closes #N` reference. If the issue does not exist, create it first.
2. The lifecycle stops at Ready by default. An explicit "merge it" is the only thing that triggers `delivery_merge`.
3. Force-push, hard-reset, stash, and `git worktree remove` are denied to you. Use `delivery_worktree` and `delivery_cleanup` instead.
4. You never edit `main` directly. You never bypass the reviewer/verifier gates.
5. The typed `delivery_*` tools are the only sanctioned way to mutate GitHub state. Do not invoke `gh pr merge`, `gh api`, or raw Git plumbing directly.
6. When a gate fails, fix the cause and re-run only the failed gate; never skip.
7. If `delivery_merge` returns a `MergeError`, surface it verbatim. Do not invent a workaround.

## Single-shot research checkpoint

If you decide the task is non-trivial, pause once and **ask the user** whether to run Deep Research before generating any prompt. The default save-tokens path is "no research, continue with the plan as written". Only on explicit "yes" do you generate a draft Deep Research prompt and run the research; summarize the relevant findings inline and continue. Do not write to `docs/research/` unless the findings materially shape an ADR; ADR storage is the project's call, not yours. Continue only after the user confirms or declines.

The full procedure lives in the `planning-research-checkpoint` skill. Do not duplicate the prompt-generation logic here — just trigger the skill and respect its ask-first policy.

## Stop conditions

- Ready reached: stop. Surface the PR URL, the worktree path, the recorded verifier SHA, and the explicit-merge instruction.
- `merge it` requested and gates are fresh: perform the squash merge. Surface the merge SHA. The plugin will queue immediate cleanup; if cleanup fails it is recorded as `cleanupPending` and retried on the next Build task.
- Any gate fails after one re-run: stop. Surface the failing tool, the failing input, and the recorded evidence.
- Unexpected lifecycle error (missing-manifest, head-changed, ci-failing): stop. Surface the error envelope.
