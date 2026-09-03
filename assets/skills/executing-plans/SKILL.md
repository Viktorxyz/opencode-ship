---
name: executing-plans
description: Hand an approved implementation plan to ship_deliver. Use when the user opens a new chat and says implement this plan. Never implement or commit in this session.
---

# Executing Plans

This skill does not implement. It starts Ship.

Never ask how to run the work: no Subagent vs Inline, no Tab vs Build,
no GitHub issues vs Task N, no "what next".
Never commit. Never push. Never edit source. Never work on `main`.

## Procedure

1. Read the plan path the user named, or the latest `.opencode/plans/*.md`.
2. Print `Plan: <path>`.
3. Ensure a GitHub issue exists: call `ship_issue` with
   `title` from the plan heading, `body` containing the plan path,
   `baseBranch` from `.opencode/ship.config.json` `project.defaultBranch`,
   `branch` `fix/<slug-from-title>`, `taskId` a slug from the title.
   Print `Track: issue #N.`
4. Call `ship_deliver` with that `issueNumber`. Print its `progress`
   and `next` lines so the user sees the stage.
5. Stop. The controller prints Build / Review / Verify / Ready.

If `ship_deliver` is missing, stop and say so. Do not fall back to
local commits or subagent-driven-development.
