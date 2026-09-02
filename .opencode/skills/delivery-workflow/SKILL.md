---
name: delivery-workflow
description: Orchestrates the canonical delivery lifecycle from issue creation through Ready PR. Use when the user asks for "implement issue N", "work on ready issues", "delivery", "autonomous delivery", or after a plan-mode session confirms the work scope.
---

# delivery-workflow

You drive the opencode-ship package from a one-line user request to a green, conflict-free, ready-to-merge pull request by dispatching the durable controller.

Never ask how to run the work: no Subagent-Driven vs Inline, no Tab vs
Build, no GitHub issues vs Task N, no "what next", no visual-companion
upsell, no Deep Research unless the user asked to research.
After the user approves a plan, call ship_deliver. Do not offer
execution-mode menus.

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
| 1. Cleanup merged worktrees | `delivery_inspect` / `delivery_cleanup` | Only for provably merged attempts |
| 2. Setup gate | `/ship-deliver` | Refuse if `.opencode/ship.setup-pending.json` exists |
| 3. Dispatch controller | `ship_deliver` | Canonical Build-to-controller entrypoint |
| 4. Plan + approve | controller / `ship_plan_approve` | Never auto-approve |
| 5. Execute in linked worktree | controller | Builder, task review, commit, verifier, CI, dual-axis final review |
| 6. Ready | `delivery_ready` | Controller-owned; same-HEAD gates required |
| 7. Stop at Ready | (this skill) | Do not merge without an explicit user request |
| 8. Merge | `delivery_merge` | Explicit user request only |
| 9. Cleanup | `delivery_cleanup` | After a successful merge |
| 10. Abandon closed unmerged attempts | `delivery_abandon` | Only after the user explicitly closes the PR and requests abandon |

Do not call `delivery_worktree`, `delivery_pr`, `delivery_ready`, or `delivery_merge` from Build to implement an issue. Those mutations belong to `ship-controller` after `ship_deliver`.

## Progress

After each successful tool in the lifecycle, print the matching
`progressLine` as a normal chat sentence. Do not wrap in JSON. Do not
explain the stage.

- Track: after issue ensure — `Track: issue #<number>.`
- Build: per task — `Build: task <k>/<n> <title>.`
- Review: per task — `Review: pass.` or `Review: fail (see notes).`
- Verify: once — `Verify: pass.` or `Verify: fail.`
- Ready — `Ready: PR #<number>.`
- Merge — `Merge: <sha>.`
- Cleanup — `Cleanup: done.`

`shape` and `approve` have no line. Use `progressLine` from
`src/runtime/stages.js`.

## Hard rules

1. Every PR carries a `Closes #N` reference. If the issue does not exist, the controller creates it first.
2. The lifecycle stops at Ready by default. An explicit "merge it" is the only thing that triggers `delivery_merge`.
3. Force-push, hard-reset, stash, and `git worktree remove` are denied. Use typed cleanup/abandon tools.
4. You never edit `main` directly. You never bypass the reviewer/verifier gates.
5. The typed tools are the only sanctioned way to mutate GitHub state. Do not invoke `gh pr merge`, `gh api`, or raw Git plumbing directly.
6. When a gate fails, fix the cause and re-run only the failed gate; never skip.
7. If `delivery_merge` returns a `MergeError`, surface it verbatim. Do not invent a workaround.

## Stop conditions

- Ready reached: stop. Surface the PR URL, the worktree path, the recorded verifier SHA, and the explicit-merge instruction.
- `merge it` requested and gates are fresh: perform the squash merge. Surface the merge SHA.
- Any gate fails after one re-run: stop. Surface the failing tool, the failing input, and the recorded evidence.
- Unexpected lifecycle error (missing-manifest, missing-workflow-link, head-changed, ci-failing): stop. Surface the error envelope.
