# opencode-ship

> npm-distributed OpenCode installer and delivery plugin: a single command materialises the lifecycle plugin, reviewer/verifier agents, and skills into any consumer repository, with a recoverable lock and never silently overwrites managed files.
>
> **Status:** `1.1.7` is the published stabilization and self-hosting correction. The immutable tag `1.1.6` failed in `pack` before npm publish or GitHub Release; no npm package or GitHub Release was created. `1.1.8` is the unpublished durable-routing correction: Build dispatches `ship_deliver`, schema-v2 execution binds to the linked worktree, and closed unmerged attempts can be abandoned with `delivery_abandon`. See [`docs/release/1.1.6-correction-plan.md`](docs/release/1.1.6-correction-plan.md).
>
> Use an exact package version for reproducible installs and all self-hosting work. Never resolve `@latest` inside an automated release or self-host update. Prerelease candidates publish under `npm dist-tag next` until qualification promotes a stable pin.

---

## Quick start (1.1.0+)

```sh
# 1. Install managed files. No flags required.
pnpm dlx opencode-ship@1.1.5 init

# 2. Restart OpenCode in this repo.

# 3. In chat, run the one-shot setup skill:
/setup-ship-workflow

# 4. The skill asks for:
#    - issue tracker (GitHub / GitLab / local / other)
#    - triage labels (defaults are fine)
#    - domain docs (single-context default)
#    - AI model roles (planner / builder / finalReviewer)
#    - AGENTS.md / CLAUDE.md block

# 5. Start work. The controller drives everything.
Ship issue 1
# or
Ship issue 1   (after opening an issue with a real description)
```

The `init` command succeeds without any model flags. The setup skill writes the per-repo configuration. The controller refuses to dispatch until the setup is complete.

## What this package is

`opencode-ship` is the npm-distributed successor to `opencode-delivery`. From 1.1.0 it bundles:

- a **typed OpenCode plugin** that auto-loads from `.opencode/plugins/opencode-ship.js`;
- **ship agents** (controller, planner, task-builder, task-reviewer, final-standards-reviewer, final-spec-reviewer, reviewer, verifier);
- **ship commands** (`ship-deliver`, `ship-resume`, `ship-status`) plus the one-shot `setup-ship-workflow`;
- **the engineering skill catalog** (ship-workflow, planning-research-checkpoint, the Matt + Superpowers methodology catalog, the new setup-ship-workflow and skill-discovery);
- **setup-ship-workflow skill** that walks the user through tracker / labels / docs / model roles;
- **automatic stack skill discovery** on `init` and `ship_plan_start` that auto-installs trusted-source skills into project-local `.opencode/skills/` with immutable provenance.
- a **lifecycle state machine** for one issue → one worktree → one PR → one merge → one cleanup;
- a **Git worktree driver** (no rebase-after-push, no force-push, no `--force-with-lease`);
- a **GitHub CLI driver** that talks only to typed `gh pr/issue` verbs (never `gh api`);
- a **project adapter** (`.opencode/ship.config.json`) so any project can declare its own verify/bootstrap/CI commands;
- **reviewer** and **verifier** subagents, both with strictly bounded permissions;
- **ship-workflow** skill that drives the canonical lifecycle;
- **planning-research-checkpoint** skill that offers a single, optional Deep Research gate per non-trivial plan;
- a **doctor** that walks every catalog entry to verify install state and lock consistency;
- an **install/doctor/diff/update/uninstall** CLI with stable exit codes and `--json` envelopes;
- a **.opencode/ship.lock.json** install lock that records managed paths, hashes, and the installer-owned root permissions;
- a **.opencode/ship.skills.lock.json** skill inventory that records project-local dynamic skills with immutable provenance;
- **recovery** for interrupted cleanup, half-written state files, and stale worktrees.

The package **does not** own:

- package managers, test commands, linters, docs layout, or CI templates;
- issue-label catalogues, release scripts, or deploy hooks;
- framework- or language-specific expertise.

The only source tree that ships in the npm tarball is `assets/`. Anything copied under `dist/`, `schema/`, `docs/`, or the top-level `THIRD_PARTY_NOTICES.md` is part of the installable distribution. The `assets/` directory is the single canonical managed-asset source for the catalog; nothing else provides packaged agents or skills.

## Distribution

Once `opencode-ship` is published, consumers install with `pnpm dlx` (or `npx`) and never edit the file by hand:

```
pnpm dlx opencode-ship@1.1.5 init      # install managed files
pnpm dlx opencode-ship@1.1.5 update    # apply a packaged upgrade
pnpm dlx opencode-ship@1.1.5 diff      # preview what would change
pnpm dlx opencode-ship@1.1.5 doctor    # environment and lock audit
pnpm dlx opencode-ship@1.1.5 uninstall # remove only the files still matching the lock
```

If you want to try a pre-release tarball locally without publishing to npm:

```bash
pnpm dlx --package=/absolute/path/opencode-ship-0.3.0.tgz opencode-ship init
```

The plugin auto-discovers from `.opencode/plugins/opencode-ship.js`; the consumer does not add a plugin entry to `opencode.json`. The installer merges only Build-agent permissions into the root `opencode.json` (or `.jsonc`); all other root-config fields remain owned by the user. Use `--force-root-config` on `init` to create a minimal `opencode.json` if the consumer has none.

### Managed file layout

```
.opencode/plugins/opencode-ship.js
.opencode/agents/ship-reviewer.md
.opencode/agents/ship-verifier.md
.opencode/skills/ship-workflow/SKILL.md
.opencode/skills/planning-research-checkpoint/SKILL.md
.opencode/ship.config.json     # user-owned except packaged workflow.models defaults
.opencode/ship.lock.json       # installer-managed; drives update + uninstall
```

These seven files (five managed plus two generated) form the default `core` install footprint. The opt-in `engineering` profile installs additional assets through the same catalog; the installer’s catalog and doctor both read from `assets/` so adding new managed files never requires rewriting the doctor or installer entry points. v0.3 ships the `core` profile only.

### Schema files

These JSON Schemas are published and discoverable through the `exports` map:

- `opencode-ship/schema/project-adapter.schema.json`
- `opencode-ship/schema/ship-config.schema.json`
- `opencode-ship/schema/ship-lock.schema.json`

### Legacy migration

Existing consumers of `opencode-delivery@0.1.x` (commit-pinned shim) can run `pnpm dlx opencode-ship@1.1.5 init` from the same checkout. Migration recognises `.opencode/delivery.json`, `.opencode/delivery.lock.json`, the two canonical agents, and the generic plugin `.opencode/plugin/delivery.ts`, and adopts them when their bytes match. Legacy artifacts are preserved on disk so a downgrade remains possible; the installer does NOT modify Leo or any other consumer.

`diff` is now strictly read-only; it reports every change but never writes to disk, even when the migration phase has a candidate seed-config to plant.

## Lifecycle

1. Begin a Build task: the delivery plugin immediately runs any queued post-merge cleanups. Failed cleanups are recorded under `<git-common-dir>/opencode-ship/cleanup-pending.json` and retried at the next delivery task or plugin startup.
2. Optional Deep Research checkpoint for non-trivial plans.
3. Find or create exactly one issue per PR.
4. Discover the default branch and fetch it.
5. Create a dedicated worktree and branch.
6. Run the project adapter's bootstrap command.
7. Implement and commit.
8. Push and open a draft PR linked to the issue (`Closes #N`).
9. Continue commits/pushes on the same branch.
10. Merge latest default branch into the feature branch before final review.
11. Run independent reviewer on the final HEAD.
12. Run canonical local verification.
13. Push and wait for required remote CI checks.
14. Mark the PR Ready and stop.
15. Explicit "merge it" re-runs the freshness checks and performs the squash merge.
16. The plugin immediately invokes `ship_cleanup`; failures persist their next cleanup stage in the Git common dir for the next session. `delivery_*` tool ids remain aliases for one minor.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | success / no-op |
| `1` | expected negative result (`diff` saw changes; `doctor` unhealthy) |
| `2` | invalid input, unsupported project, ambiguous detection |
| `3` | ownership / hash / structural conflict |
| `4` | filesystem, staging, rollback, or transaction failure; also surfaced when a catalog source is missing |
| `5` | unsupported lock/config schema |

## Development

`npm run verify` runs `format:check`, `lint`, `typecheck`, `build`, and the auto-discovered test suite. The tests cover the installer CLI, the lock and root-config planners, the catalog validator, the schema validator, agents, the packed-artifact smoke check, the transaction-recovery contract, the profile-resolution precedence chain, the catalog profile filter, the order-preserving root-config merge, the engineering↔core transition, the durable plan artifact, the Plan Mode permission integration, the M3 task loop contract (run store + task brief + Spec/Quality verdicts + 3-round breaker + commit binding + compaction context), the Ready gate (parallel GPT Standards/Spec + verifier + CI on one HEAD; Build cannot self-record), the transition matrix smoke (core omits engineering, engineering adds engineering, lock tracks the active profile), the static release-policy tests (Node matrix wiring, prerelease metadata, runtime-source digest wiring, 1.0 promotion policy), the runtime-source digest algorithm tests (deterministic across clean checkouts; ignores version and release-metadata changes; tracks every runtime-source modification), and the OpenCode live-server discovery smoke (32-tool canonical set exposed via `/experimental/tool/ids` on a real `opencode serve` instance for both `core` and `engineering` fixtures). The suite count and per-test count are derived from the test runner at qualification time; this README intentionally does not lock in a specific test-count baseline.

```
npm ci
npm run build
npm run verify
```

The shipped artifact is built by esbuild (`scripts/build.mjs`); self-contained `dist/*.d.ts` are emitted by `tsc` from the in-package `src/plugin.ts`, `src/cli.ts`, and `src/core.ts` entry points. The `prepack` script fails closed if `esbuild` or `tsc` is missing or any required build artifact is absent. The temporary config lives at `.tmp/tsconfig.dts.json`, under the gitignored `.tmp/` directory, so a tracked config file is never accidentally committed.

## Status and licensing

- **License:** MIT. See `LICENSE`.
- **Versioning:** SemVer. v0.2.0 is the first npm-distributed release. v0.3.0 is the installer foundation. v0.4.0 adds the profile-aware installer foundation (`--profile` flag, lock schema v2, profile precedence) that issue #18 requires. v0.5.0 ships the engineering profile content (triage + grill-with-docs SKILL.md placeholders) required by issue #20. v0.6.0 ships the durable plan artifact + Plan Mode permission integration required by issue #21. v0.7.0 ships the M3 task loop contract (run store, task brief, Spec/Quality verdicts, 3-round breaker, commit binding, compaction context) required by issue #22. v0.8.0 ships the Ready gate contract (parallel Standards/Spec + verifier + CI on one HEAD) required by issue #23. v0.9.0 ships the transition matrix smoke (engineering installs all assets, lock tracks the active profile) required by issue #24. v1.0.0 promotes the dogfooded 0.10.0 to stable. v1.1.0 removes the legacy core profile and ships the one-liner init + setup-ship-workflow skill. v1.1.1 began the self-hosting correction line; the immutable `1.1.6` failed before publication, `1.1.7` is the published stabilization correction, and `1.1.8` is the unpublished durable-routing correction (see `docs/release/1.1.6-correction-plan.md`).
- **Compatibility:** the bundled plugin targets `@opencode-ai/plugin >= 1.15.5 < 2` and OpenCode `>= 1.15.5`.

## FAQ

**Is the package on npm?**

Yes, `opencode-ship` is published as a public npm package. The release workflow at `.github/workflows/release.yml` validates the tag against `package.json`, packs a single tarball, publishes that tarball to npm (`--access public --provenance`), and uploads the same tarball as the GitHub Release asset. Consumers who cannot reach npm can run from the GitHub tarball URL shown in the release body.

**Where is the `@opencode-ai/plugin` dependency?**

The plugin is bundled (`scripts/build.mjs` does not externalize it). Consumers do not need to install `@opencode-ai/plugin` themselves; the runtime is self-contained. The package still declares a peer dependency so consumers who also use the opencode runtime are not given duplicate copies.

**What does `init` actually write?**

It writes (or refreshes) five managed files in `.opencode/`, plus the user-owned `ship.config.json` and integrity-hashed `ship.lock.json`. `init` fills `workflow.models` from packaged defaults (`openai/gpt-5.6-sol` / `minimax-coding-plan/MiniMax-M3` / `openai/gpt-5.6-sol`). `update` rewrites a role only when its provenance is `default` (or a historical default); `--planner-model` / `--builder-model` / `--final-reviewer-model` mark that role as an override. Other `ship.config.json` fields stay user-owned. It also merges eleven JSON-pointer values into the root `opencode.json` (or `.jsonc`) without overwriting unrelated keys. By default it does not create `opencode.json` — pass `--force-root-config` to do so. The catalog validator runs first and exits `4` if a packaged source is missing, so the installer refuses to materialise a half-built state.

**Where does the lock live and how is it integrity-checked?**

`.opencode/ship.lock.json`. Every recorded file path, sha256, and pointer hash is rolled up into `integrity.lockSha256`. The installer refuses to write or apply updates against a tampered or schema-incompatible lock (`exit 3` for tampering, `exit 5` for an unsupported schema). Downgrading the schema is non-trivial; the lock schema version is part of the contract.

**What is the canonical source tree?**

`assets/` is the only path that ends up in the npm tarball alongside `dist/`, `schema/`, `docs/`, and `THIRD_PARTY_NOTICES.md`. The packaged plugin reads agent and skill bytes from `assets/agents/` and `assets/skills/`; the catalog declares these paths up front, and the doctor walks the catalog to verify install state. Anything copied under root `agents/` or `skills/` during local development is a build convenience, not part of the installable distribution.
