---
name: setup-ship-workflow
description: First-run setup of opencode-ship. Walks the user through GitHub configuration, triage labels, domain docs, and AI model roles. Run once after `init` with /setup-ship-workflow.
disable-model-invocation: true
---

# Setup Ship Workflow

First-run setup for `opencode-ship@1.1.2`. Run this exactly once after `init`
and before any `ship-deliver`. It is prompt-driven, idempotent, and refuses
to return until every step is committed or explicitly skipped.

The setup contract is GitHub-only. The skill refuses to drive GitLab,
Jira, Linear, or local markdown because the controller's own delivery
tool belt is GitHub-bound. A team that needs a different tracker should
hold off on `opencode-ship@1.1.2` until 1.2 ships the next tracker.

## When you trigger

- The user runs `/setup-ship-workflow` or types "set up ship" / "continue setup".
- The installer creates `.opencode/ship.setup-pending.json` after `init`.
- The controller also routes `ship-deliver` to this skill until the marker is cleared.

Do **not** trigger on a normal planning or delivery request.

## Process

Take the sections in order. Lead every question with a recommended default so
the user can accept in one word. Skip a section only when exploration already
settled it.

### 1. Explore

```bash
git remote -v
gh auth status
git status --short
ls -la AGENTS.md CLAUDE.md docs/ .opencode/ 2>/dev/null || true
cat .opencode/opencode.json 2>/dev/null || true
cat .opencode/ship.config.json 2>/dev/null || true
cat .opencode/ship.lock.json 2>/dev/null || true
opencode models 2>/dev/null || true
```

Also check:

- is `.opencode/ship.setup-pending.json` present? (it makes this run mandatory)
- is the `triage` skill installed? (decides whether Section B runs)
- is the issue tracker a GitHub repo? If not, refuse with the
  GitHub-only contract and stop.

### 2. Section A — GitHub repository

The default is the GitHub repository that owns `git remote`. Confirm the
detected `owner/repo` slug against the user's answer. If the user has
multiple remotes, ask which one is the ship target.

Write `docs/agents/issue-tracker.md` with the resolved `owner/repo`,
`default branch`, and the canonical `gh` commands:

```bash
gh issue list --label needs-triage
gh issue view <number>
gh pr create --base <default-branch> --draft --title <title> --body <body>
gh pr view <number>
gh pr merge <number> --squash --delete-branch
```

If the consumer is not on GitHub, refuse with:

> opencode-ship@1.1.2 is GitHub-only. Re-run on a GitHub repo, or wait
> for 1.2.

Stop the skill. Do not write a `docs/agents/issue-tracker.md` for a
non-GitHub consumer.

### 3. Section B — Triage labels

Only if the `triage` skill is installed. Ask one question:

> Keep the default triage labels? (recommended: yes)
> Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

On **no**, capture the user's overrides so `triage` reuses existing labels
instead of creating duplicates.

Write `docs/agents/triage-labels.md`.

### 4. Section C — Domain docs

Default: **single-context** — one `CONTEXT.md` + `docs/adr/` at the repo root.
Skip the question unless monorepo signals were found.

Write `docs/agents/domain.md`.

### 5. Section D — AI model roles

Three questions, one at a time. Default to `openai/gpt-5.6-sol` and
`minimax/MiniMax-M3`; offer alternative families only when the user
explicitly states they have no credentials for the defaults.

| Role | Default | Suggestion |
|---|---|---|
| planner | `openai/gpt-5.6-sol` | strong model for plan writing |
| builder | `minimax/MiniMax-M3` | cheap/fast model for code |
| finalReviewer | `openai/gpt-5.6-sol` | strong model for final Standards + Spec review |

Alternatives to mention if the user has no OpenAI/MiniMax:

- Anthropic: `anthropic/claude-opus-4.1`, `anthropic/claude-sonnet-4.5`
- Google: `google/gemini-2.5-pro`, `google/gemini-2.5-flash`
- Or any `<provider>/<model>` string the user has credentials for

After the user answers, update `.opencode/ship.config.json`:

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

Then run `opencode-ship update --planner-model <a> --builder-model <b>
--final-reviewer-model <c> --force-config` to write the change with full
transactional coverage.

### 6. Section E — Provider auth probe

```bash
opencode auth list
opencode models openai
opencode models minimax
```

If the planner/builder/finalReviewer names are missing credentials, surface
a warning and tell the user how to log in:

```bash
opencode auth login openai
opencode auth login minimax
```

Do not invent credentials. Do not retry.

### 7. Section F — Permissions sanity

Run `opencode-ship doctor`. If any pointer is missing, prompt the user to
run:

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

This repo uses opencode-ship. Read `.opencode/ship.config.json` for the
active model roles and approval policy. Issues live in GitHub.
See `docs/agents/issue-tracker.md`. Triage labels are documented in
`docs/agents/triage-labels.md`.

For a single-issue delivery, the user invokes `/setup-ship-workflow`
once, then `ship-deliver <issue-number>` (or types "Ship issue N"). The
controller dispatches the planner, builder, and reviewers; no further
user action is required until Ready.
```

Include the `### Triage labels` sub-block only when the `triage` skill is
installed.

### 9. Done

- Run `opencode-ship setup-complete` to commit the lock and clear the
  marker in one transaction.
- Tell the user that everything is ready.
- Print the next-step block below.

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
- Never silently overwrite a user-owned value in `ship.config.json`; always
  show the diff first.
- Never tell the user to "merge it" automatically. The merge step is the
  only autonomy break.
- Never hide step failures. If a write fails, surface the error and stop.
- Do not write any non-GitHub tracker docs. The contract is GitHub-only.
