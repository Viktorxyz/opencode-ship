---
description: Configure the opencode-ship workflow for this repo: issue tracker, triage labels, domain docs, and AI model roles. Run once after `init` with /setup-ship-workflow.
---

# Setup Ship Workflow

First-run setup for `opencode-ship@1.1`. Run this exactly once after `init` and before any `ship-deliver`. It is prompt-driven, idempotent, and refuses to return until every step is committed or explicitly skipped.

## When you trigger

- The user runs `/setup-ship-workflow` or types "set up ship" / "continue ship setup".
- The installer creates `.opencode/ship.setup-pending.json` after `init`; the controller also routes `ship-deliver` here until this skill has cleared the marker.

Do **not** trigger on a normal planning or delivery request.

## Process

Take the sections in order. Lead every question with a recommended default so the user can accept in one word. Skip a section only when exploration already settled it.

### 1. Explore

```bash
git remote -v
git status --short
ls -la AGENTS.md CLAUDE.md docs/ .opencode/ 2>/dev/null || true
cat .opencode/opencode.json 2>/dev/null || true
cat .opencode/ship.config.json 2>/dev/null || true
cat .opencode/ship.lock.json 2>/dev/null || true
cat .opencode/ship.setup-pending.json 2>/dev/null || true
opencode providers list 2>/dev/null || true
```

Also check:

- is `.opencode/ship.setup-pending.json` present? (it makes this run mandatory)
- is the `triage` skill installed? (decides whether Section B runs)
- monorepo signals (`pnpm-workspace.yaml`, `packages/*`)

### 2. Section A — Issue tracker

Default: GitHub (the most common case). If `git remote` points at GitLab, propose GitLab. Otherwise offer:

- GitHub (uses `gh`)
- GitLab (uses `glab`)
- Local markdown (writes under `.scratch/<feature>/`)
- Other (Jira, Linear, etc.) — describe in one paragraph

Write the choice to `docs/agents/issue-tracker.md`. Use the seed template in `assets/skills/setup-engineering-workflow/issue-tracker-<choice>.md` as the starting point.

### 3. Section B — Triage labels

Only if the `triage` skill is installed. Ask one question:

> Keep the default triage labels? (recommended: yes)
> Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

On **no**, capture the user's overrides so `triage` reuses existing labels instead of creating duplicates.

Write `docs/agents/triage-labels.md`.

### 4. Section C — Domain docs

Default: **single-context** — one `CONTEXT.md` + `docs/adr/` at the repo root. Skip the question unless monorepo signals were found.

Write `docs/agents/domain.md`.

### 5. Section D — AI model roles

Three questions, one at a time. Default to `openai/gpt-5.6-sol` and `minimax/MiniMax-M3`; offer alternative families below.

| Role | Default | Suggestion |
|---|---|---|
| planner | `openai/gpt-5.6-sol` | strong model for plan writing |
| builder | `minimax/MiniMax-M3` | cheap/fast model for code |
| finalReviewer | `openai/gpt-5.6-sol` | strong model for final Standards + Spec review |

Alternatives to mention if the user has no OpenAI/MiniMax:

- Anthropic: `anthropic/claude-opus-4.1`, `anthropic/claude-sonnet-4.5`
- Google: `google/gemini-2.5-pro`, `google/gemini-2.5-flash`
- Or any `<provider>/<model>` string the user has credentials for

After the user answers, **update `.opencode/ship.config.json`** so it looks like:

```json
{
  "schemaVersion": 2,
  "profile": "engineering",
  "project": { ... },
  "delivery": { ... },
  "workflow": {
    "models": {
      "planner": "<answer>",
      "builder": "<answer>",
      "finalReviewer": "<answer>"
    },
    "approval": { "mirrorToIssue": true, "maxFailedRounds": 3 }
  }
}
```

Then run `opencode-ship update` to write the change with full transactional coverage.

### 6. Section E — Provider auth probe

```bash
opencode providers list
```

If the planner/builder/finalReviewer names are missing credentials, surface a warning and tell the user how to log in:

```bash
opencode providers login openai
opencode providers login minimax
```

Do not invent credentials. Do not retry.

### 7. Section F — Permissions sanity

Run `opencode-ship doctor`. If any pointer is missing, prompt the user to run:

```bash
opencode-ship update --force-root-config
```

Do not auto-rewrite root configs without consent.

### 8. Section G — AGENTS.md / CLAUDE.md

Pick the file to edit:

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither, ask the user to pick one — never create both.

If an `## Ship workflow` block exists, update in place. Otherwise append:

```markdown
## Ship workflow

This repo uses opencode-ship. Read `.opencode/ship.config.json` for the active model roles and approval policy. Issues live in [tracker]. See `docs/agents/issue-tracker.md`. Triage labels are documented in `docs/agents/triage-labels.md`.

For a single-issue delivery, the user invokes `/setup-ship-workflow` once, then `ship-deliver <issue-number>` (or types "Ship issue N"). The controller dispatches the planner, builder, and reviewers; no further user action is required until Ready.
```

Include the `### Triage labels` sub-block only when the `triage` skill is installed.

### 9. Done

- Delete `.opencode/ship.setup-pending.json`.
- Print the next-step block below.
- Tell the user they can edit `docs/agents/*.md` directly; re-running this skill is only necessary to switch trackers or re-configure models.

## Next steps (always print)

```text
Setup complete.

Next:
1. Restart OpenCode in this repo (if you haven't already).
2. Try: Ship issue 1    (or any issue number)
3. The controller will: plan -> ask approve -> implement -> review -> ready -> wait for "merge it"
```

## Hard rules

- One question per turn. Never batch.
- Re-run safe: skip sections already settled by existing config or docs.
- Never edit the same `docs/agents/*.md` twice in one run.
- Never silently overwrite a user-owned value in `ship.config.json`; always show the diff first.
- Never tell the user to "merge it" automatically. The merge step is the only autonomy break.
- Never hide step failures. If a write fails, surface the error and stop.
