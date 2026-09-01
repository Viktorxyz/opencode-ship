# Agent Instructions

## Ship workflow

This repository uses `opencode-ship`. Read `.opencode/ship.config.json` for the
active model roles and approval policy. Issues live in GitHub at
`Viktorxyz/opencode-ship`; see `docs/agents/issue-tracker.md`. Triage labels are
documented in `docs/agents/triage-labels.md`.

For a single-issue delivery, run `/setup-ship-workflow` once, then invoke
`ship-deliver <issue-number>` or ask to ship that issue. The controller plans,
asks for plan approval, implements, reviews, verifies, marks the pull request
Ready, and waits for an explicit merge request.

### Triage Labels

Use `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and
`wontfix` as defined in `docs/agents/triage-labels.md`.
