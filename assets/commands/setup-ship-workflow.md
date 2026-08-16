---
description: Configure the opencode-ship workflow for this repo: GitHub tracker, triage labels, domain docs, and AI model roles. Run once after `init` with /setup-ship-workflow.
---

# Setup Ship Workflow

This command is a thin wrapper around the canonical
`setup-ship-workflow` skill. OpenCode will load the skill
and follow its procedure.

To run the skill from this command, the user types
`/setup-ship-workflow` in OpenCode. The CLI's
`setup-complete` command is the transactional gate that
commits the lock flip and clears the marker once the skill
has produced every artifact.
