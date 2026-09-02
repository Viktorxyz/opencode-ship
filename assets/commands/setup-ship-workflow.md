---
description: Configure the opencode-ship workflow for this repo: GitHub tracker, triage labels, domain docs, and AI model roles. Run once after `init` with /setup-ship-workflow.
---

# Setup Ship Workflow

This command is a thin wrapper around the canonical
`setup-ship-workflow` skill. The skill file is written to disk by
`opencode-ship init` at `.opencode/skills/setup-ship-workflow/SKILL.md`
in the consumer repo and in every issue worktree.

## When the user types `/setup-ship-workflow`

1. **Read** the skill body from
   `.opencode/skills/setup-ship-workflow/SKILL.md` in the current
   worktree (or the consumer repo root if no worktree is open).
   Do NOT call `ship_skill_install` for this skill: it is already
   on disk from `init` and the install path requires a trusted
   npm-owner allowlist that the `opencode-ship` publisher does
   not satisfy.
2. **Follow** the procedure in the skill body. `init` already
   populated `workflow.models` from packaged defaults; the skill
   only asks if the user wants a per-role override. The skill
   still writes the four required artifacts
   (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`,
   `docs/agents/domain.md`, `AGENTS.md`) and runs the
   `opencode-ship setup-complete` CLI to flip
   `lock.manager.setupComplete` to `true`.

If the skill file is missing (for example the consumer skipped
`init`), fall back to running `opencode-ship init --root "$PWD"`
from a `bash` block first, then read the freshly written skill and
continue. Do not silently invent the setup procedure; the CLI is
the single source of truth for the artifact list and the model
names that the controller will dispatch.