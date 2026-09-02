---
name: planning-research-checkpoint
description: Optional Deep Research gate before non-trivial plans proceed to implementation. Default is no research. Run research only if the user said "research" or "istrazi". Use when the parent agent has finished the plan-mode brief and the work touches architecture, lifecycle design, or an unfamiliar domain.
---

# planning-research-checkpoint

You trigger exactly once per non-trivial planning session. Trivial sessions (typo fixes, docstring changes, single-file edits, follow-up PRs on already-decided work) skip this gate silently.

Default is no research. Do not ask “Run Deep Research?”.
Run research only if the user said “research” / “istrazi”.

Never ask how to run the work: no Subagent-Driven vs Inline, no Tab vs
Build, no GitHub issues vs Task N, no "what next", no visual-companion
upsell, no Deep Research unless the user asked to research.
After the user approves a plan, call ship_deliver. Do not offer
execution-mode menus.

## When you trigger

- The plan touches architecture, lifecycle, API surface, or test strategy
- The plan consumes external standards (OpenCode, GitHub, Git, package manager, CI)
- The plan mentions an unfamiliar package, language, or framework
- The user explicitly asks for a research pass

Do **not** trigger on:

- Single-file edits and doc fixes
- Implementations of a previously-accepted plan
- PRs that only rename or reformat

## Procedure

1. Read the current session's plan from the parent context. Do **not** ask the user to re-state it.
2. If the user did not say “research” or “istrazi”, proceed with the plan as written. Do not mention research. Do not generate any research prompt.
3. If the user said “research” or “istrazi”:
   - Output a single Markdown block titled "Research checkpoint" containing:
     - The plan summary in <= 3 bullets
     - A **one-line** decision the research is meant to inform
     - A draft Deep Research prompt in a copyable ```text fenced block
   - Run the research. Wait for the result. Persist a concise dated summary into the consumer project's `docs/research/` only if the research materially shapes an ADR or other architectural decision; otherwise treat the result as session-local.
4. Never ask the user to formulate the prompt themselves. The draft is yours to write when they asked to research.
5. Never loop. One outcome, continue.
6. Never persist the full research output. The summary you write must be yours, dated, and bounded.
