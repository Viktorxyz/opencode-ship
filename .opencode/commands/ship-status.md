---
description: Read-only view of the durable workflow state. No Git or GitHub mutations.
---

# ship-status

`ship-status <workflow-id>` returns the current durable
workflow state without mutating anything. The output is a
compact object containing:

- workflow id, issue number, PR number (or null),
- lifecycle state, branch, worktree path,
- HEAD SHA, plan path + revision + hash,
- completed tasks as `taskId:commitSha` pairs,
- active task id, state, and round,
- pending gate,
- child session ids and states,
- todos by status,
- last event sequence and hash,
- the exact resume command (`ship-resume <workflow-id>`).

The command never reads chat history. The compact block is
the only authoritative source of truth for the workflow
state; chat history, prior tool outputs, and prior model
prose are never consulted.
