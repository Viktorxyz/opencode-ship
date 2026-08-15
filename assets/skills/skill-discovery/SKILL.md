---
name: skill-discovery
description: Discover and conditionally install skills from the open agent skills ecosystem before non-trivial work. Use when the parent agent is starting a new task and wants to ensure the most relevant public skills (React, testing, deployment, etc.) are available to the cheap builder.
---

# skill-discovery

Discover skills from the open agent skills ecosystem (`npx skills`) that match the current task objective, then install the trusted ones locally. The hard rule is that this skill is **suggest-first, install-conditionally**: trusted sources may auto-install; everything else must be approved by the user.

## When you trigger

- The parent agent (typically `ship-deliver` or `ship-task-builder`) is about to dispatch a new task.
- The task objective references a domain where a public skill likely exists (web frameworks, testing, deployment, design, etc.).
- The user has not yet opted out of skill discovery for this session.

Do **not** trigger on:

- Trivial edits, doc rewrites, single-line fixes
- Tasks that are already covered by a vendored skill from the engineering catalog

## Procedure

### 1. Extract a discovery query

From the current task brief (interfaces, files, technology stack), build one short query string (2–5 words). Example: `react testing`, `docker deploy`, `postgres migrations`, `tailwind components`.

### 2. Search the skills ecosystem

```bash
npx skills find "<query>"
```

The CLI returns candidates with source repo, install count, and skill name. Parse the output, do not transcribe it.

### 3. Score and filter

The install allowlist and quality threshold live in `ship.config.json` under `skillDiscovery`:

```json
{
  "skillDiscovery": {
    "trustedOwners": [
      "vercel-labs",
      "anthropics",
      "obra",
      "mattpocock",
      "ComposioHQ"
    ],
    "minInstalls": 1000,
    "blocklist": ["known-bad-owner/example"]
  }
}
```

**Auto-install** is allowed only if all of the following are true:

- source owner is in `trustedOwners`
- install count >= `minInstalls` (default 1000)
- skill name does not conflict with a managed `opencode-ship` skill
- the user has not previously blocked this skill in this repo

Otherwise:

- If the source is untrusted but the skill looks relevant, present 1–3 candidates to the user and wait for a yes/no.
- If no candidates match, continue without installation.

### 4. Install project-locally

Auto-approved candidates install to `.opencode/skills/<skill>/SKILL.md` (project-local). The typed tool `ship_skill_install` records every install in the run ledger so `doctor` and `uninstall` can audit it.

Manual install if the user prefers global:

```bash
npx skills add <owner/repo@skill> -g -y
```

Prefer project-local unless the user explicitly asks for global.

### 5. Report

After discovery, emit a one-line summary in the run:

```text
Skill discovery: <n> candidates, <m> installed (<owner/skill list>).
```

If 0 installed, say `Skill discovery: 0 installed, continuing with catalog skills only.`

## Hard rules

- Never run `npx skills add` for an untrusted source without explicit user approval.
- Never install a skill that shadows a managed opencode-ship skill (name collision).
- Never run discovery when offline or when the registry is unreachable. Warn and continue.
- Never install more than 5 skills in one discovery pass.
- Never persist discovery results to `ship.config.json`. The discovery is per-task, not per-repo.

## Permissions

This skill expects the following bash allowances on the host (configured in `ship-controller` frontmatter):

- `npx skills find *`
- `npx skills add *`
- `ls .opencode/skills`
- `cat .opencode/skills/*/SKILL.md`
