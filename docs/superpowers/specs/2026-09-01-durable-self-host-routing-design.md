# Durable Self-Host Routing Correction

**Status:** Approved
**Issue:** #80
**Release target:** 1.1.8

## Context

The `opencode-ship@1.1.7` self-host acceptance created issue #78 and draft PR
#79 through the shipped `delivery-workflow` skill. The skill still directs the
Build agent through the legacy `delivery_*` lifecycle. That path can create a
schema-v2 manifest and reach validation without calling `ship_plan_start`, so
the manifest has no durable `workflowId`. `delivery_ready` correctly rejects
that state with `missing-workflow-link`.

The same acceptance review found a second boundary error. Durable task tools
use the plugin's base `repoRoot` for builder dispatch, commit verification, and
final review. Delivery implementation lives in the linked feature worktree, so
those operations must resolve and use that worktree after planning.

The correction must preserve the existing fail-closed Ready, review, verifier,
CI, and same-HEAD guarantees. It must not make #79 Ready by editing durable
state or trusting evidence that the workflow did not produce.

## Goals

- Give the Build agent one deterministic entrypoint that dispatches the
  `ship-controller` for an issue.
- Require durable workflow linkage before implementation worktree creation.
- Resolve every implementation-phase workflow operation to one validated
  linked worktree.
- Provide an explicit, audited operation for abandoning a closed, unmerged
  delivery attempt without weakening merge cleanup.
- Fail early with specific envelopes when workflow or worktree invariants are
  absent.
- Ship regression coverage in both source tests and packaged assets.

## Non-Goals

- Relaxing Ready, merge, dual-axis review, verifier, CI, or same-HEAD gates.
- Retrofitting unreviewed commits into a durable workflow.
- Automatically closing or deleting open PRs.
- Supporting multiple delivery manifests for one active workflow.
- Making `ship_plan_start` callable by arbitrary agents.

## Architecture

### Deterministic delivery entrypoint

Add a Build-callable `ship_deliver` plugin tool. Its public input is an issue
number plus an optional operation id. The tool validates setup and dispatches a
`ship-controller` child session in the current repository. It does not create
plans, approve plans, mutate GitHub, or execute tasks itself.

The shipped `/ship-deliver` command and `delivery-workflow` skill must direct
the Build agent to this tool. The skill must no longer describe a legacy
issue/worktree/PR sequence as the canonical implementation path.

`ship_plan_start` remains controller-only. It continues to derive `wf-<issue>`
and links the single manifest for that issue before dispatching the planner.

### Workflow-to-worktree seam

Introduce one shared resolver with this conceptual contract:

```text
resolveWorkflowWorktree(repoRoot, workflowId)
  -> { issueNumber, manifest, worktreePath }
```

The resolver reads the approved workflow source, finds exactly one schema-v2
manifest for its issue, requires the manifest's `workflowId` to match, and
validates that `worktreePath` is a registered linked worktree for the same Git
common directory. Ambiguous, missing, unregistered, or mismatched identity
fails closed. Individual operations enforce clean/dirty state only when their
own transition requires it; task review must be able to inspect builder edits
before they are committed.

Planning, approval, and `ship_run_start` remain based on the base checkout and
approved base SHA. After worktree creation, these operations use the resolved
worktree:

- builder and task-review child-session dispatch;
- reviewed-path and commit HEAD verification;
- canonical verifier execution;
- PR-head and required-CI binding;
- final Standards and Spec review package construction and dispatch.

Durable plans, leases, run events, and receipts remain under the shared Git
common directory, so controller resume works from either checkout.

### Early lifecycle guard

`delivery_worktree` must reject a schema-v2 manifest whose `workflowId` is
missing. The expected sequence is therefore:

1. find or create issue and manifest;
2. call `ship_plan_start`, which links the workflow;
3. submit and approve the plan;
4. create the linked implementation worktree;
5. execute durable tasks in that worktree.

This moves an orchestration error from the final Ready transition to the first
implementation mutation.

### Explicit abandon operation

Add `delivery_abandon`, separate from merged cleanup. It requires an explicit
user-approved subject and only accepts an attempt when all of these are true:

- the PR exists, is closed, and is not merged;
- the worktree is clean and no rebase is in progress;
- local HEAD equals the manifest's recorded PR head;
- remote branch HEAD is absent or equals that same recorded head;
- no unpublished commits exist;
- no durable run is Ready or merged.

Before cleanup it writes an immutable abandon intent containing task id, issue,
PR, branch, head SHA, subject, and timestamp. It then removes the worktree,
deletes the branch with a compare-and-swap ref update, deletes the active
manifest, and writes an immutable completion record linked to the intent hash.
Retries that find an intent without completion resume only the missing
idempotent cleanup steps; retries after completion return the recorded result.

The operation never closes a PR itself. Closing #79 remains an explicit user
action before abandonment.

## Failure Handling

All new failures use typed, non-throwing envelopes with stable kinds. Required
kinds include `missing-workflow-link`, `workflow-mismatch`,
`missing-worktree-path`, `ambiguous-workflow-manifest`, `invalid-worktree`,
`pr-open`, `pr-merged`, `head-mismatch`, `dirty-worktree`, and
`has-unpublished-commits`.

No failure path edits a manifest, removes a worktree, marks a PR Ready, or
changes a GitHub issue/PR state.

## Test Strategy

Regression tests must prove:

- `ship_deliver` is registered, Build-callable, setup-gated, and dispatches one
  idempotent `ship-controller` session for an issue;
- the shipped command and skill name `ship_deliver` as the canonical entrypoint
  and do not instruct Build to execute the legacy lifecycle;
- schema-v2 worktree creation without a workflow link fails before mutation;
- `ship_plan_start` links the one matching manifest;
- workflow resolution rejects absent, duplicate, cross-repository,
  unregistered, and workflow-mismatched worktrees;
- builder/reviewer dispatch receives the linked worktree directory;
- commit and final-review HEAD checks read the feature worktree, not base HEAD;
- abandon refuses open, merged, dirty, diverged, unpublished, Ready, or merged
  attempts;
- successful abandon writes immutable intent and completion records around
  CAS-safe cleanup and resumes safely after a partial failure;
- the package tarball contains the corrected tools, command, skill, agent
  permissions, and type declarations.

Canonical verification and required CI must pass at one corrective PR HEAD.

## Delivery And Recovery

Because this defect breaks its own canonical routing, issue #80 is delivered as
a controlled break-glass PR: isolated worktree, TDD, independent Standards and
Spec review, canonical verifier, required CI, and explicit merge approval. No
Ready or merge gate is bypassed in product code.

After the corrective release:

1. publish and qualify exact `opencode-ship@1.1.8` before promotion;
2. update the clean self-host checkout with exact `1.1.8` and restart OpenCode;
3. explicitly close draft PR #79 without merging it;
4. run `delivery_abandon` for `deterministic-lock-tests` and retain its
   tombstone;
5. restart issue #78 through `ship_deliver` from the beginning;
6. require task review, verifier, CI, Standards review, Spec review, and Ready
   at one HEAD;
7. merge only on explicit user request and immediately clean the worktree;
8. treat that completed lifecycle as the release acceptance result.
