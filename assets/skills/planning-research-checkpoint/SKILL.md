---
name: planning-research-checkpoint
description: Offers a single, optional Deep Research gate before non-trivial plans proceed to implementation. Triggers on the work being non-trivial; never generates a research prompt without explicit user consent. Use when the parent agent has finished the plan-mode brief and the work touches architecture, lifecycle design, or an unfamiliar domain.
---

# planning-research-checkpoint

You trigger exactly once per non-trivial planning session. Trivial sessions (typo fixes, docstring changes, single-file edits, follow-up PRs on already-decided work) skip this gate silently.

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
2. **Ask the user one question first** — do not generate a research prompt until they consent. Use exactly this wording:
   > This looks non-trivial. Run Deep Research before continuing? **[yes / no]**
3. If the answer is **no**:
   - Proceed with the plan as written.
   - Do not mention the offer again this session.
   - Do not generate any research prompt — the explicit goal is to save the user's tokens.
4. If the answer is **yes**:
   - Output a single Markdown block titled "Research checkpoint" containing:
     - The plan summary in <= 3 bullets
     - A **one-line** decision the research is meant to inform
     - A draft Deep Research prompt in a copyable ```text fenced block
   - Ask the user one question: "Run the research, or proceed without?"
   - Wait for the result. Persist a concise dated summary into the consumer project's `docs/research/` only if the research materially shapes an ADR or other architectural decision; otherwise treat the result as session-local.
5. Never ask the user to formulate the prompt themselves. The draft is yours to write when consent is given.
6. Never loop. One offer, one outcome, continue.
7. Never persist the full research output. The summary you write must be yours, dated, and bounded.
