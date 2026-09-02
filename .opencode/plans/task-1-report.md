# Task 1 Report: Packaged Defaults And Pure Resolver

## Status

DONE

## Commit

- Branch: `feat/managed-model-defaults` (created from detached `origin/main` `59a5b5c`)
- Message: `feat(installer): add packaged workflow model defaults and resolver`
- SHA: recorded in the implementer return after `git commit` (this file is included in that commit)

## What shipped

Packaged current + history workflow model defaults, a pure resolver, catalog/prepack/`package.json` wiring, and `engineering-config.js` reading current defaults from the loader instead of a hardcoded `DEFAULTS` table.

Current triple (verbatim):

- planner: `openai/gpt-5.6-sol`
- builder: `minimax-coding-plan/MiniMax-M3`
- finalReviewer: `openai/gpt-5.6-sol`

History (one previous triple): builder `minimax/MiniMax-M3`.

## Files

Created:

- `assets/defaults/workflow-models.json`
- `assets/defaults/workflow-models.history.json`
- `src/installer/workflow-models.js`
- `tests/installer/workflow-models.test.mjs`

Modified:

- `src/installer/engineering-config.js` — deleted local `DEFAULTS`; `packagedDefaults()` returns `loadWorkflowModelDefaults().current`
- `tests/installer/engineering-config.test.mjs` — builder fallback asserts `minimax-coding-plan/MiniMax-M3`
- `src/installer/catalog.js` — `validateCatalog()` calls `loadWorkflowModelDefaults()` after a clean catalog loop
- `package.json` — `files` includes `"assets/defaults"` next to `"assets/agents"`
- `scripts/prepack.mjs` — after catalog check, `statSync` both defaults files and `fail()` if missing or size 0

Not touched (out of scope): lock schema 5, planner patches, doctor, docs.

## Interfaces

- `MODEL_ROLES = ["planner", "builder", "finalReviewer"]`
- `loadWorkflowModelDefaults()` reads both files from `resolvePackageRoot` + `assets/defaults/…`. Throws with `catalogValidation: true` if a file is missing, empty, not JSON, not the expected shape, or missing a role.
- `resolveWorkflowModels({ configModels, lockModels, cliModels, current, history })` returns `{ models, provenance, changedRoles }`
  - `models[role]` is the resolved id string
  - `provenance[role]` is `{ source: "default" | "override", applied: string }`
  - `changedRoles` lists roles whose resolved id differs from `configModels[role]` (missing treated as changed when filled)

Resolver rules (per role, independently):

1. Non-empty `cliModels[role]` → override + that id
2. `lockModels[role].source === "override"` → keep `configModels[role]`, or `lockModels[role].applied` if config is empty; never rewrite
3. `lockModels[role].source === "default"` → write `current[role]`
4. No provenance: empty/missing → default + current; id equals `current[role]` or any `history[*][role]` → default + current; any other id → override + keep

## TDD

1. Wrote `tests/installer/workflow-models.test.mjs` first (plan cases verbatim).
2. Ran it. Failed with `ERR_MODULE_NOT_FOUND` for `src/installer/workflow-models.js`.
3. Added JSON files, loader/resolver, and wiring.
4. Re-ran the required suite. All passed.

## Tests

Command:

```
node --test --test-concurrency=1 --test-reporter=spec tests/installer/workflow-models.test.mjs tests/installer/engineering-config.test.mjs tests/installer/catalog.test.mjs
```

Result: 24 pass, 0 fail.

Cases in `workflow-models.test.mjs`:

- load current triple matches v1 spec
- empty config infers default and fills current
- historical builder infers default and moves to current
- unknown planner infers override and is never rewritten
- lock override stays even when it equals a later package default
- CLI flag sets that role to override only

`engineering-config.test.mjs`: packaged builder default is `minimax-coding-plan/MiniMax-M3`.

`catalog.test.mjs`: `validateCatalog()` still passes on the real catalog (now also loading defaults).

Lint: passed. Typecheck: no new errors (`workflow-models.js` uses the same `/** @type {any} */` catalogValidation cast as `catalog.js`). Pre-existing `jsonc-parser` TS2307 remains in `jsonc-edit.js` / `root-reconciliation.js`.

## Constraints honored

- Default triple unchanged: `openai/gpt-5.6-sol` / `minimax-coding-plan/MiniMax-M3` / `openai/gpt-5.6-sol`
- No consumer PRs
- No `ship.config.json` field management
- No separate overrides file
- `hasCompletedModels` / dispatch-time checks untouched
- Defaults JSON packaged, not copied into the consumer tree
- Did not implement lock schema 5, planner, doctor, or docs
- Did not push; did not amend; did not commit other `.opencode/plans/*`

## Concerns

None for Task 1 scope. Loader throw paths (missing/invalid JSON) are covered by `loadWorkflowModelDefaults` fail-closed behavior and exercised indirectly by `validateCatalog()` on the real files; there is no dedicated negative-path unit test for a broken defaults file.
