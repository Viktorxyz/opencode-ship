# Slice report: execute plans through ship_deliver

**Branch:** `feat/named-stages-quiet-chat` (second commit, not pushed)
**Status:** implemented, not pushed

## What landed

- `executing-plans` overwritten: `delivery_issue` then `ship_deliver` only.
  Never implement or commit in session. Never work on `main`.
- `delivery-workflow` description + When you trigger: `"implement this plan"`,
  `"execute the plan"`, `"ok implement"`.
- `subagent-driven-development` description + top redirect to `ship_deliver`
  when `.opencode/plugins/opencode-ship.js` is present.
- `tests/skills/execute-via-ship.test.mjs`
- `vendor/sources.json` `localSha256` for executing-plans and SDD.

## Tests

- `node --test tests/skills/execute-via-ship.test.mjs tests/package/neutral-consumer.test.mjs`: 10 pass
- `npm run verify`: 698 pass, 0 fail

## Concerns

- `writing-plans` still tells agents to use SDD / executing-plans as sub-skills.
- `scripts/vendor-sync.mjs` still lists executing-plans and SDD as `unchanged`.
- SDD body still contains the Superpowers executor; only the top redirect
  stops ship consumers.
