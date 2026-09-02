---
name: skill-discovery
description: Documentation for automatic stack skill discovery. Discovery runs inside init and ship_plan_start via syncSkills; do not treat this skill as a step the model must remember.
---

# skill-discovery

Trusted stack skills are discovered and installed by `syncSkills`, not by remembering to run `npx skills find`. `init` runs the pipeline after a successful commit. `ship_plan_start` runs the same pipeline before creating a workflow, so discovery cannot be skipped.

This skill is documentation only. Do not run a separate discovery pass unless the user asks.

## What the pipeline does

1. Map `package.json` dependencies to 1–5 short queries (`react`, `nextjs`, `vitest`, …).
2. On `ship_plan_start`, append extra queries from issue text without replacing the stack.
3. Query the public skills registry and partition with `isAutoInstallable`.
4. Auto-install trusted owners (`vercel-labs`, `anthropics`, `obra`, `mattpocock`, `ComposioHQ`) with `minInstalls >= 1000`, max 5 per pass, into `.opencode/skills/<name>/`.
5. Skip untrusted owners, managed-skill name collisions, existing destinations, and policy rejects.

## Untrusted candidates

- `init`: print untrusted package/skill names; do not wait.
- `ship_plan_start`: return them on the success envelope as `skills.skippedUntrusted`. Ask the user yes/no before any extra install.

## Hard rules

- Never auto-install an untrusted owner.
- Never shadow a managed opencode-ship skill.
- Never overwrite an existing `.opencode/skills/<name>` directory.
- Never install more than 5 skills in one discovery pass.
- Registry / `skills` CLI failure is a warning. Continue with catalog skills only.
- Prefer project-local `.opencode/skills` unless the user explicitly asks for `~/.config/opencode`.
