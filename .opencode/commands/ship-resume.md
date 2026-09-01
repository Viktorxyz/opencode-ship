---
description: Restore the durable workflow state, reconcile the live Git state, and continue the active task from the exact round.
---

# ship-resume

`ship-resume <workflow-id>` restores the durable workflow
state from `<git-common-dir>/opencode-ship/` and continues
the active task from the exact round. The controller:

1. Loads the manifest, run, plan, approval, events, todos,
   and current Git HEAD.
2. Restores any missing local plan/approval from the issue
   mirror when the issue mirror is reachable.
3. Reconstructs completed tasks from commit trailers when
   the run scratch is missing.
4. Reconciles a commit-pending crash (commit landed but
   scratch never recorded it) so the next dispatch is not
   duplicated.
5. Reuses any recorded child session id or dispatch id.
6. Selects only the first incomplete task; completed tasks
   are never redispatched.
7. Refuses to continue when the plan hash, ledger hash, or
   Git identity disagrees with the durable state.

The command never reads chat summaries and never relies on
the consumer's user Build model. The compact resume block
is the only contract between sessions.
