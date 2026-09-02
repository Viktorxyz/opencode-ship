# Slice report: named stages + quiet chat

**Branch:** `feat/named-stages-quiet-chat` (from `origin/main`)
**Status:** implemented, not pushed

## What landed

- `src/runtime/stages.js` — twelve canonical stage ids and `progressLine`.
- `tests/runtime/stages.test.mjs` — one assert per stage string (TDD: fail then pass).
- Quiet-chat: writing-plans / executing-plans / brainstorming /
  planning-research-checkpoint / wayfinder / engineering-workflow /
  setup-ship-workflow / delivery-workflow, plus ship-deliver and
  ship-controller. `.opencode/skills` counterparts copied.
- Neutral-consumer: writing-plans has no `Which approach` /
  `Subagent-Driven`, and mentions `ship_deliver`.
- `vendor/sources.json` `localSha256` updated for the four adapted
  vendored skills (wayfinder, brainstorming, writing-plans,
  executing-plans).

## Non-goals held

- `delivery_*` tools not renamed.
- Skill registry sync not touched.
- Default models not changed.

## Concerns

- writing-plans quiet-chat line says "Subagent vs Inline" (not
  `Subagent-Driven`) so the consumer assertion can pass.
- `.opencode/skills/delivery-workflow` was a stale pre-controller
  copy; it now matches assets.
- Progress lines are prompt instructions, not runtime prints.
