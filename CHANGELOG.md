# Changelog

All notable changes to `opencode-ship` are recorded here.

## 1.1.5 — `ship-plan` is product-only

> Branch: `feat/1.1.5-ship-plan-prompt`.

- **`ship-plan` prompt is product-only.** `1.1.4` shipped the `ship-plan` primary agent with a generic "ask clarifying questions when tradeoffs need the user's call" prompt and a "tell the user the file path and ask for confirmation before any edits" step. Both leaked workflow concerns into the chat: the model asked "open GitHub issues 0–6 or first Task 0 (commit /final)", "use this Tab (Build is for implementation)", and surfaced permission-glob internals ("`docs/superpowers/plans/` is deny; allowlist is `.opencode/plans/*.md`"). The Plan tab is the **product** half of the workflow; the user is there to talk about the product, not be taught the workflow. The rewrite replaces those lines with a strict contract: the prompt is allowed to ask only product questions (scope, UX, who it is for, what done looks like) and one final product question ("does the plan match the product you want?") before stopping. The prompt never asks how to run the work (issues vs Task N, subagent vs inline, Tab / Build, `ship-deliver`, "what next"), never mentions permission globs / deny lists / allowlists, never creates GitHub issues, never claims OpenCode's native `plan_exit`, and never offers to implement.
- **Handoff is a file, not a chat menu.** The Plan tab writes `.opencode/plans/<​filename>.md` and stops. A later Build session is told `implement this plan <path>` (or `implement issue N` for the Issue path). The Plan tab does not offer "which approach?" or "subagent vs inline" — those are upstream Superpowers choices that ship does not copy. If a PR needs `Closes #N`, that issue is created by Build (`delivery_issue`), not by Plan.
- **Subagent dispatch is internal.** `ship-plan` keeps its `task: explore` / `general` allowlist so it can dispatch read-only investigators and write scratch notes, but the prompt no longer asks the user whether to use subagents. The decision is made by the planning agent itself from the size of the request.
- **`tests/package/neutral-consumer.test.mjs` regression.** The post-init probe now asserts the new prompt lines are present and the old workflow-leaking lines are absent. The 1.1.3 stale-record removal path is unchanged, so `opencode-ship update` from prior 1.1.x installs still cleans the leftover `*` wildcards the same way it did before this release.

## 1.1.4 — `ship-plan` primary planning agent

> Branch: `feat/1.1.4-ship-plan`.

- **Write-capable `ship-plan` planning agent.** OpenCode's built-in lowercase `plan` Tab injects a read-only reminder (`packages/opencode/src/session/prompt/plan.txt`) that cannot be bypassed by `opencode.json` permissions. The native experimental Plan mode (`OPENCODE_EXPERIMENTAL_PLAN_MODE`) is environment-only, dotenv autoload is disabled in the production binary, and plugins initialise after `RuntimeFlags` is constructed — there is no supported repo-local path to turn on the native workflow. From 1.1.4 the installer installs a new primary agent `ship-plan` (under `.opencode/agents/ship-plan.md`) and sets `agent.plan.disable: true`. `ship-plan` is write-capable but only under `.opencode/plans/*.md` (`edit["*"]: "deny"` with `.opencode/plans/*.md: "allow"` ordered last). Tab cycles to Build / ship-plan; the old read-only Plan identity is disabled so the UX is no longer confusing.
- **`/agent/plan/disable` pointer.** New matrix leaf with `value: true`. Install / update set it; uninstall restores the previous value. The pointer is the single declaration that the installer owns; consumers who explicitly set `plan.disable: false` are surfaced as a conflict and refused.
- **No native `plan_exit` or `Session.plan()` filename.** The replacement is deliberately not the experimental Plan workflow. There is no `plan_exit` tool, no canonical plan filename supplied by OpenCode, and no synthetic build-handoff message. If OpenCode eventually ships the per-agent `plan: true` proposal (`anomalyco/opencode#31868`), this agent can migrate onto the native facility cleanly.

## 1.1.3 — Tool permission regression + setup-ship-workflow loader

> Branch: `fix/1.1.3-tool-permissions`. Hotfix on top of `1.1.2`.

- **Drop the `*` wildcard from the Build / ship-controller tool
  permission map.** `1.1.2` emitted a `permission: { "*": "deny" }`
  leaf at the agent root, and OpenCode's last-match-wins semantics
  masked the consumer-owned built-ins (`read`, `edit`, `bash`,
  `glob`, `grep`, `list`, `skill`, `webfetch`, …). Symptom: the
  Build agent kept only the ship/delivery tool subset, the
  `setup-ship-workflow` skill was never auto-loaded because the
  agent could not read its own `SKILL.md`, and the user was
  prompted with `Skill install blocked: … untrusted-owner` because
  the model tried to reinstall the locally-installed skill via
  `ship_skill_install`. The fix is to deny only the explicit
  `PUBLIC_TOOL_ID` set (plus `allow` / `ask`) and let consumer
  built-ins stay consumer-owned.
- **Drop leftover matrix leaves on install / update.** The
  reconciler now diffs `previousRecords` against the current
  descriptor set and removes pointers that the matrix no longer
  emits (for example the dropped `/agent/build/permission/*`),
  restoring the preinstall `previous` value or the leaf when no
  previous existed. The byte output is updated for both JSON and
  JSONC paths so `opencode-ship update` from `1.1.2` to `1.1.3`
  cleans the orphan pointer on the first run.
- **`/setup-ship-workflow` command is self-loading.** The command
  wrapper now spells out the procedure: read the skill body from
  `.opencode/skills/setup-ship-workflow/SKILL.md` and follow it.
  Do not call `ship_skill_install` for this skill — it is
  installed by `init` and the install path requires a trusted
  npm-owner allowlist that `opencode-ship` does not satisfy.

## 1.1.2 — Stable: Plan Mode write access

> Branch: `release/1.1.2`. Promoted from `1.1.2-rc.4` after dogfood.

- **Plan Mode write access for brainstorming / writing-plans products.**
  The installer now owns two leaf pointers under
  `agent.plan.permission` so OpenCode's Plan mode can write its
  brainstorming / writing-plans / wayfinder output:

  - `/agent/plan/permission/edit/docs/superpowers/**` = `allow`
  - `/agent/plan/permission/edit/.git/opencode-ship/plans/**` = `allow`

  The whole `/agent/plan/permission` block is still consumer-owned;
  the installer only owns these two glob leaves. When the consumer
  previously declared `agent.plan.permission.edit` as a scalar
  string (e.g. `"deny"`), the installer promotes it to
  `{ "*": <scalar>, ... }` on install and records the previous
  scalar so uninstall can restore it byte-for-byte. A consumer
  that explicitly sets `docs/superpowers/**: "deny"` is a
  fail-closed conflict.

- **Full self-hosting contract corrections** carried over from
  `1.1.2-rc.3`: durable plan store, Plan Mode permission
  consumer-ownership, workflow state machine coverage, parallel
  Standards/Spec Ready gate, trusted-auto skill discovery, and the
  `/setup-ship-workflow` single-skill contract. See the
  `1.1.2-rc.*` entries below for the bounded evidence ledger.

## 1.1.2-rc.3 — Complete contract correction (round 2)

> Branch: `fix/1.1.2-rc.3-contract`.
> Tracker: https://github.com/Viktorxyz/opencode-ship/issues/56.

`1.1.2-rc.2` shipped green CI but its CHANGELOG claimed more than the
codebase delivered: the B2 dispatch work stayed on an unmerged branch,
the B4 matrix was wired but the per-leaf pointer records were not
written by `init`, the B5 setup-complete command cleared the
setup-pending marker BEFORE validating the artifacts (so a failed
validation lost the marker with no compensating lock write), and the
B7 trusted-skill install wrote a placeholder `SKILL.md` whose hash
matched the inventory by construction.

This release corrects those gaps and ships only what is true at the
byte level:

- **`ship_skill_install`** materialises real bytes via the public
  `skills` CLI pinned to a known version, copies them through a
  staging directory, hashes every installed file, and verifies the
  on-disk bytes match the staged bytes before appending to the
  inventory. The tool fails closed when the CLI is unavailable; no
  placeholder `SKILL.md` is ever written.
- The inventory is now append-only schema v2 with a hash-chained
  event log. Install events carry per-file sha256 + provenance
  (registry snapshot, cli package, registryId); uninstall events
  append a tombstone that references the install hash and never
  splices the chain.
- `ship_skill_install` validates the destination worktree via
  `git worktree list --porcelain -z`. It refuses the main checkout,
  unregistered paths, symlink traversal, and any destination whose
  ancestor is a symlink. Paths that lexically contain `..` or
  absolute segments are refused at append time.
- The root permission matrix is the single source of truth.
  `desiredPointersForProfile("engineering")` derives its pointer
  list from `rootPermissionMatrix()` (no parallel `POINTER_ENTRIES`
  list); the wildcard `*` default is never serialised as a literal
  pointer, and bash policy is left to the OpenCode runtime instead
  of being installer-owned state. Empty intermediate containers
  (`agent.<name>.permission: {}`) are pruned on install/uninstall so
  byte-identical restoration holds for empty consumer configs.
- `setup-complete` validates lock, models, docs, and AGENTS.md
  BEFORE any writes. The setup-pending marker is no longer part of
  the gate (it is a chat-time signal, not an artifact). When the
  gate passes, the lock is written with `setupComplete: true` and
  the marker is cleared as part of the same commit. When validation
  fails, no state changes.
- The 32-tool public surface is unchanged. The eight new tools
  (`ship_task_start`, `ship_task_commit`, `ship_task_complete`,
  `ship_final_review`, `ship_skill_discover`, `ship_skill_install`,
  `ship_skill_audit`, `ship_skill_uninstall`) are still first-class.
- Regressions covered by new test suites: `tests/skills/install.test.mjs`,
  `tests/skills/inventory.test.mjs`, `tests/skills/worktree.test.mjs`,
  `tests/installer/root-permission-matrix.test.mjs`,
  `tests/installer/setup-pending.test.mjs` (extended).

## 1.1.2-rc.2 — Rejected, incomplete

`1.1.2-rc.2` is published on npm `next` but is rejected as an
incomplete candidate. The CHANGELOG for that release claimed
behavior the source tree did not contain: the B2 dispatch work
lived only on the unmerged branch `fix/1.1.2-rc.2-contract`, the
root permission matrix was dead-code (POINTER_ENTRIES was the
active source), the setup-complete command cleared the marker
before validating, and `ship_skill_install` wrote a placeholder
`SKILL.md` whose hash matched the inventory by construction. The
published `1.1.2-rc.2` tarball is byte-equivalent to this rejected
release.

> Active stabilization branch: `fix/1.1.2-self-hosting`.
> Parent tracker: https://github.com/Viktorxyz/opencode-ship/issues/56.
> Authoritative plan: docs/release/1.1.2-correction-plan.md.

`1.1.1` and `1.1.2-rc.1` shipped partial contracts: 24 of the 32
promised tools, no real OpenCode dispatch, an executor that conflated
"all three model fields populated" with "setup workflow completed",
a setup skill that left consumers without `docs/agents/**` or an
`AGENTS.md` Ship workflow block, and root permissions that still used
a duplicated pointer list.

This release corrects every one of those gaps:

- 32 typed tools are registered. The previously missing
  `ship_task_start`, `ship_task_commit`, `ship_task_complete`,
  `ship_final_review`, `ship_skill_discover`, `ship_skill_install`,
  `ship_skill_audit`, and `ship_skill_uninstall` are first-class.
- The workflow agents are dispatched through real OpenCode
  sessions via `client.session.create` and `client.session.promptAsync`.
  The controller session id is persisted in dispatch records so
  plan/task/final-review tools can authorize the caller from the
  ToolContext, not from a caller-supplied `submittedBy` string.
- `ship_task_review` authorizes against the configured builder
  model (the task reviewer is rendered with the builder model).
  `ship_final_review` requires the configured finalReviewer model.
  Both gate on the controller session id.
- The setup-complete command is the sole writer of
  `lock.manager.setupComplete: true`. It validates models + docs +
  AGENTS.md + lock BEFORE the lock write, then removes the
  setup-pending marker in the same critical section. A failed
  validation leaves the marker untouched.
- The root permission matrix is the single source of truth. The
  legacy `POINTER_ENTRIES` list is replaced by `rootPermissionMatrix()`.
  `subagent_depth: 2` and the Build → ship-controller delegation
  are wired so the deep plan / build / review chain works without
  manual permission patching.
- JSONC reads and writes use `jsonc-parser`. The apply step merges
  sibling section insertions into a single JSONC edit insert so the
  `applyEdits` call does not throw on overlapping ranges. Plain
  JSON files are preserved key-by-key by the same matrix.
- The `setup-ship-workflow` skill is GitHub-only. The 1.1.2
  controller's delivery tool belt is GitHub-bound; the skill
  refuses to drive GitLab, Jira, Linear, or local markdown.
  The command is a thin wrapper that just invokes the skill.
- Lock schema v4 explicitly accepts `manager.setupComplete` and
  the `support` file kind, and drops `cleanupPending` (its state
  lives under the Git common directory).

## 1.1.2-rc.1 — (incomplete) placeholder

The 1.1.2-rc.1 release shipped with a partial contract and is
deprecated as soon as 1.1.2 stable is published. Upgrade to
1.1.2-rc.2 or later.

## 1.1.1 — Stabilization + first self-hosting release (UNRELEASED)

> Active stabilization branch: `fix/1.1.1-stabilization`.
> Parent tracker: https://github.com/Viktorxyz/opencode-ship/issues/40.
> Authoritative plan: `docs/release/1.1.1-stabilization-plan.md`.

This release repairs the consumer-readiness gaps that made
`1.1.0` unsuitable as a self-hosting control plane:

This release repairs the consumer-readiness gaps that made
`1.1.0` unsuitable as a self-hosting control plane:

- Engineering is the only shipped profile. New CLI selection of
  the legacy `core` profile is rejected with exit 2; persisted
  `core` configs and locks migrate to engineering on read.
- Lock schema v4 adds `manager.setupComplete` and removes
  `cleanupPending` from the install lock (cleanup retry now
  lives under the Git common directory).
- Workflow agents carry `<model-from-config>` placeholders; the
  installer renders the configured `workflow.models` at install
  time so a model change updates exactly the affected agent
  files. The lock pins the rendered sha256.
- Default-deny consumers can run the full controller flow
  without manual permission patching. The installer no longer
  owns the Plan Mode permission block; consumers configure it
  via the built-in Plan agent. Subagent depth is pinned to 2.
- The workflow state machine handles every documented event
  kind (including the previously-missing `task-report`,
  `final-review`, `ready-pending`, `all-tasks-done`).
- Engineering Ready requires Standards and Spec final reviews
  bound to the same HEAD and package hash, with `verdict: pass`
  on both axes. Legacy single-review manifests continue to
  fall through to the legacy gate.
- Trusted-auto skill discovery installs from a configurable
  allowlist with immutable provenance; skills land in the
  active issue worktree under `.opencode/skills/<name>/` and
  are recorded in `.opencode/ship.skills.lock.json`.
- The `/setup-ship-workflow` skill is single (the legacy
  duplicate `setup-engineering-workflow` is removed); it is
  GitHub-only in `1.1.1` and routes model selection through
  the existing CLI update transaction.
- Release qualification pipeline runs the packed self-hosting
  E2E end-to-end instead of just extracting the tarball.
- Test contract: zero filename-disabled tests in the test
  runner; tracked `tsconfig.dts.json` removed.

See `docs/release/1.1.1-stabilization-plan.md` for the full plan
and issue #40 for the bounded evidence ledger.

## 1.1.0 — Engineering-only, easy setup, skill discovery (2026-08-08)

> **Known gap:** `1.1.0` is the published `latest` but it does
> not yet pass a real registry dogfood with real OpenCode,
> GitHub, and models; the workflow surface ships in pieces
> (skill discovery is dead code, the dual final review is not
> enforced, and the Plan Mode permission is installer-owned).
> `1.1.1` is the first fully self-hosting release and should be
> preferred once it is on `npm dist-tag latest`. The 1.1.0
> tarball remains available for pinned consumers.

Stable release. Promoted to `npm dist-tag latest` after the
qualification pipeline passed green on every matrix lane
(npm x pnpm, opencode 1.15.5 + 1.18.10) and the runtime-source
digest was preserved between rc.1 and 1.1.0 (only the
`package.json` version, the README "Status" section, and this
changelog header changed).

Distribution:

```text
npm dist-tags
  latest: 1.1.0
  next:   1.0.0
```

Verification:

```text
npm install --prefix /tmp/fresh opencode-ship@latest
node_modules/.bin/opencode-ship --version
# prints: opencode-ship 1.1.0
```

The S5 real 14-step dogfood is still pending a valid OpenAI
provider credential; the 1.0.0 line's published 0.10.0 digest
is the runtime source witness for both 0.10.0 and 1.1.0.

The breaking change set, the engineering-only `init` flow, the
`setup-ship-workflow` skill, the `find-skills` discovery
wiring, and the ask-first deep-research gate all carry forward
unchanged from rc.1; see the rc.1 section below for the full
list.

## 1.1.0-rc.1 — One-liner install, easy setup, skill discovery

### Breaking changes

- **The `core` profile is removed.** `init --profile core` now
  fails with exit 2 and a clear message. Every consumer on the
  `1.1.x` line installs the engineering profile, which is the
  superset of the previous core surface. Existing locks declaring
  `manager.profile: "core"` are upgraded to `engineering` on the
  next `init` or `update`. There is no migration of bytes — the
  engineering catalog is a strict superset of the core catalog.

### Added

- **One-liner install.** `pnpm dlx opencode-ship@latest init` works
  without any flags. The installer writes the full engineering
  catalog and a `ship.config.json` with an empty `workflow.models`
  block. The setup-pending marker
  (`.opencode/ship.setup-pending.json`) is written so the
  controller knows to route the first `ship-deliver` through the
  setup skill.
- **One-shot `setup-ship-workflow` skill.** Run via
  `/setup-ship-workflow` in chat, or automatically by `ship-deliver`
  when the setup-pending marker is present. The skill walks the
  user through:
  1. issue tracker (GitHub / GitLab / local markdown / other);
  2. triage labels (default is `needs-triage`, `needs-info`,
     `ready-for-agent`, `ready-for-human`, `wontfix`);
  3. domain docs (single-context default, multi-context for
     monorepos);
  4. AI model roles (planner / builder / finalReviewer) with
     `openai/gpt-5.6-sol` and `minimax/MiniMax-M3` defaults;
  5. provider auth probe (`opencode providers list`);
  6. permissions sanity (`opencode-ship doctor`);
  7. AGENTS.md / CLAUDE.md block.
  Re-running the skill is safe and idempotent.
- **Skill discovery** (`assets/skills/skill-discovery/SKILL.md` and
  `src/tools/skill-discovery.js`). The controller runs
  `npx skills find <query>` before planning; trusted-source skills
  (default: `vercel-labs`, `anthropics`, `obra`, `mattpocock`,
  `ComposioHQ`) auto-install project-locally. Non-trusted
  candidates are presented to the user. Allowlist and
  `minInstalls` threshold are configurable via
  `ship.config.json#skillDiscovery`.
- **Ask-first deep-research gate.** The
  `planning-research-checkpoint` skill now asks the user one
  question before generating any research prompt. Default path
  is "no research, continue with the plan as written", saving
  tokens. The research prompt is only generated on explicit
  consent.

### Changed

- `init` no longer requires `--planner-model` / `--builder-model`
  / `--final-reviewer-model` flags. The flags remain available as
  overrides for users who know exactly which models they want.
- `ship.config.json#workflow.models` is now optional at install
  time. The ship controller refuses to dispatch
  (`ship-deliver`) until all three role ids are populated, or
  routes through `/setup-ship-workflow` automatically.
- `ship.config.json#profile` is the engineering profile. The CLI
  still accepts `--profile engineering` (no-op) but rejects
  `--profile core` with a helpful error.
- The release qualification workflow now publishes under the
  `candidate` dist-tag for 1.1.x and `next` for 0.10.x. 1.1.0 is
  promoted to `latest` after the formal S5 dogfood passes (or after
  a maintainer-approved exception is recorded in issue #37).
- README, RELEASING, and this changelog are rewritten for the
  one-liner install + setup-skill flow.

### Fixed

- WP0.1: the duplicate skill frontmatter `name: setup-matt-pocock-skills`
  (set on both `setup-engineering-workflow` and
  `engineering-workflow` SKILL.md files) is fixed; the
  setup skill is now `setup-ship-workflow` and the workflow
  reference is `engineering-workflow`.
- The installer previously refused to commit if
  `workflow.models` was incomplete. The new flow accepts the
  empty-models state and relies on the setup skill to populate
  them. Existing 1.0.x locks continue to work.

## Unreleased

- `1.0.0` is on `npm dist-tag latest`; `0.10.0` stable is on
  `npm dist-tag next`. The `release/0.10.0` branch is the live
  release branch for both releases; the `1.0.0` tag was promoted
  from the same runtime source as `0.10.0` so the
  version-independent `runtimeSourceSha256` digest is preserved
  across both releases (CI-reported digest
  c750d709dd68dc3663eef3890d5b9d8f8a1ec3b14eae011382e151874cb50c89).
- The S5 real 14-step dogfood was skipped because the OpenAI
  OAuth credential in `~/.local/share/opencode/auth.json`
  expired (48 days ago) and the opencode CLI 1.18.15 cannot
  dispatch to `openai/gpt-5.6-sol` or `minimax/MiniMax-M3`.
  The dogfood fixture is preserved at
  `https://github.com/Viktorxyz/opencode-ship-dogfood` for
  re-execution once a valid provider credential is supplied.
  The npm CLI verification (`npm install opencode-ship@latest`
  + `node_modules/.bin/opencode-ship --version`) prints
  `1.0.0`, confirming the published artefact is reachable.
- See `docs/release/1.0.0-execution-plan.md` for the authoritative
  execution plan and issue #37 for the bounded evidence ledger.

### Release-qualification gaps closed (S1)

These changes close the S1 release-qualification gaps on the
`release/0.10.0` branch:

- **Real Node compatibility lanes.** The `node-compat` job's
  `setup-node` step now drives from `${{ matrix.node }}` for each
  matrix row (`22.6.0`, current `22`, `24`); the trusted-publishing
  `publish` job remains the only place that pins `22.14.0`. The
  per-row observed `node --version` output is uploaded and
  aggregated into the qualification report by
  `scripts/compose-node-versions.mjs`.
- **Real OpenCode startup and discovery smoke.** A new
  `tests/release/opencode-discovery.test.mjs` boots a real
  `opencode serve` instance against a packed-tarball fixture
  with both `core` and `engineering` profiles, polls
  `/global/health`, reads `/experimental/tool/ids`, and asserts
  the canonical 24-tool set exported from
  `tests/plugin/expected-tools.mjs`. The canonical set is the
  single source of truth shared by the in-process plugin-load
  test and the live-server smoke.
- **Correct prerelease metadata.** The publish job now resolves a
  `prerelease` flag from a dedicated step that delegates to
  `scripts/is-prerelease.mjs`. SemVer prereleases (`-rc.N`,
  `-alpha.N`, `-beta.N`) become `prerelease: true`; stable
  versions become `prerelease: false`.
- **Version-independent runtimeSourceSha256.** A new
  `scripts/runtime-source-sha.mjs` computes a deterministic
  digest over `src/**`, `assets/**`, `schema/**`, `vendor/**`,
  `scripts/build.mjs`, `scripts/prepack.mjs`, and a normalised
  `package.json` with the top-level `version` field removed.
  The qualification report carries `runtimeSourceSha256`, and the
  release-policy job refuses any `1.0.x` tag whose digest does
  not match the accepted `0.10.0` qualification artifact
  (via `scripts/promote-1.0-policy.mjs`).
- **Truthful documentation.** README, CHANGELOG, and this file
  no longer claim `release/1.0-completion` is the live branch,
  no longer assert a stale test-count baseline, and no longer
  promise a promotion rule that depends on equal source SHAs
  between `0.10.0` and `1.0.0`.
- **Stronger neutral-consumer assertions.**
  `tests/package/neutral-consumer.test.mjs` now requires explicit
  model IDs before any engineering install writes, asserts the
  engineering install's exit code is `0` before doctor runs, and
  covers the engineering-init-without-models failure path.

### Shipped source on `release/0.10.0` (not yet released)

These changes are present in source on the `release/0.10.0`
branch but are not production-ready until the formal registry
dogfood on the npm-published `0.10.0` succeeds. Items will move
to a dated release header only after that step completes.

- Crash-safe Git-common storage: link()-based atomic publication
  with rename() fallback, SHA-256 hashed resource locks, explicit
  legacy migration from the `opencode-delivery/` path to
  `opencode-ship/delivery/`, fail-closed transaction recovery.
- Fail-closed profile transitions and uninstall: pointer
  `installedSha256` verification refuses to overwrite user edits;
  transactional `--purge-config`; doctor's installed-hash and
  root-pointer checks are scoped to the active profile.
- Engineering profile requires explicit
  `workflow.models.{planner,builder,finalReviewer}` and
  `workflow.approval.{mirrorToIssue:true, maxFailedRounds:3}`
  before any write; CLI `--planner-model`/`--builder-model`/
  `--final-reviewer-model` flags are forwarded into the
  planner.
- Real upstream vendoring: 24 SKILL.md files plus companion
  files from the pinned
  `mattpocock/skills@2ab958093e83e0ec752e6c1c5932da465bf23e0c`
  and `obra/superpowers@44c9b2d6e889982ac18c27d05a19fefe335194e1`
  commits, frozen byte-identical under `vendor/upstreams/`.
  `scripts/verify-vendor.mjs` is the read-only CI verifier.
- Config V2 schema with allOf enforcement; lock V3 schema
  requires scope, installedSha256, and previous for every
  pointer.
- 24 typed tools: 9 existing delivery tools + 7 Git/GitHub
  control-plane tools + 8 workflow tools (`ship_plan_*`,
  `ship_run_*`, `ship_task_*`, `ship_resume`, `ship_status`).
  The plugin wraps V1 envelopes at the boundary so every tool
  returns contract-version-2.
- Contract-version-2 envelope + immutable GitHub operation
  store with safe-id operationId validation.
- Deterministic run reducer + controller with hash-chained
  events and commit trailers.
- Per-run resume lock + crash reconciliation + mirror
  restoration.
- Same-HEAD gate across final Standards/Spec reviews,
  verification, CI, PR, and Ready.
- Agent permissions: controller permission block removes raw
  `gh`, push, reset, stash, worktree remove, tag, and
  self-review/approvals.
- Two-task workflow qualification with fake GitHub/model
  harness.
- Ten-job release qualification pipeline
  (`.github/workflows/release.yml`): source-verify, pack,
  consumer-install (npm x pnpm x core x engineering), consumer-
  transitions, workflow-e2e, opencode-compat (matrix 1.15.5 +
  1.18.10), node-compat (matrix 22.6.0 + 22 + 24), release-
  policy, qualification-report, publish.
- `publish` uses `--tag next` for 0.10.x RCs and stable,
  `--tag candidate` for 1.0.x. Post-publish npm install
  smoke verifies the registry artifact.
- SP DX 2.3 SBOM, base64 npm integrity, and sha256:hex asset
  digest in the qualification report.

### Planned (not yet shipped)

These changes are present in source on the `release/0.10.0` branch but are not production-ready and have not been published. Items will move to a dated release header only after the relevant plan task is verified end-to-end and the formal registry dogfood passes.

- Lock schema v3 with a `scope` field per root pointer record (core | engineering) and byte-stable hash identity.
- `src/state/git-common-dir.js` and `src/state/durable-store.js` for the shared crash-safe storage under the resolved Git common directory.
- `src/installer/root-reconciliation.js` as the single source of truth for `install`, `profile-transition`, and `uninstall` root-config edits; the engineering → core transition removes the Plan Mode block and restores the prior values byte-for-byte.
- `scripts/vendor-sync.mjs` vendoring 14 mattpocock and 10 obra/superpowers skills with immutable commit pins, MIT license files, and adapted integration footers.
- New agents: `ship-controller`, `ship-planner`, `ship-task-builder`, `ship-task-reviewer`, `ship-final-standards-reviewer`, `ship-final-spec-reviewer`. New commands: `ship-deliver`, `ship-resume`, `ship-status`.
- New CLI flags: `--planner-model`, `--builder-model`, `--final-reviewer-model` for missing-config synthesis.
- `src/workflow/plan.js` and `src/workflow/plan-store.js` for immutable PlanV2 and approvals under `<git-common-dir>/opencode-ship/plans/`.
- `src/workflow/workspace.js`, `task-review.js`, `three-round-breaker.js`, and `commit-gate.js` for the deterministic task controller.
- `src/workflow/compaction.js` for the bounded 4 KiB compaction block; `src/workflow/final-review.js` for binding Standards and Spec axes to one HEAD + package hash.
- `src/tools/envelope.js` as the contract-version-2 success/failure envelope; `src/drivers/github-command-policy.js` as the fixed `gh` allowlist.
- `src/state/github-operation-store.js` for typed GitHub operation records with idempotency.
- `scripts/qualify.mjs` for a machine-readable qualification report (gates, pins, tarball digest) suitable for uploading to a GitHub Release.

## 0.9.1 — Restore a truthful green baseline

- `src/installer/plan-mirror.js` documents its options through a JSDoc typedef and rejects unknown options.
- `mirrorPlanToIssue` now defaults to the typed `ghDriverClient`, which wraps `createGhDriver().comment()`. The runtime no longer shells out to `gh api`.
- `previewUninstall` is now called with its supported signature; `runUninstall` no longer passes a `profile` argument.
- `README.md` and `CHANGELOG.md` no longer claim the M3 task loop, parallel Standards/Spec Ready gate, or vendored Matt/Superpowers workflows are end-to-end shipped; those contracts remain source-only modules.

## 0.9.0 — Complete engineering profile publish

`opencode-ship@0.9.0` ships the transition matrix smoke required by issue #24 (Task 10 in approved plan). The smoke covers the core↔engineering transition shape — core omits engineering-only files, engineering installs them, and the lock's `manager.profile` field tracks the active profile across upgrades. The full E2E install (`pnpm dlx opencode-ship@latest`) continues to be exercised by the existing installer-cli tests; the new module focuses on the local-dev file set so the smoke runs in the default `npm run verify` pipeline.

### Verification

- `npm run verify` exits `0` with 320 tests across 34 suites on the v0.9 HEAD.

### Added

- **Transition matrix smoke.** `tests/package/transition-matrix.test.mjs` covers the core omits engineering, engineering adds engineering, and the lock `manager.profile` tracks the active profile across upgrades. The module is gated by `OPENCODE_SHIP_SMOKE_FULL=1` for the full E2E run; the lite version always runs and asserts the local-dev file set.

## 0.8.0 — Ready gate (parallel GPT Standards/Spec + verifier + CI on one HEAD)

`opencode-ship@0.8.0` ships the Ready gate contract required by issue #23 (Task 9 in approved plan). The final review is the merge-base-to-HEAD review package; the GPT Standards and Spec reviewers inspect it in parallel; the verifier executes the canonical consumer verification command independently; and the gate refuses any record that is not on the current HEAD. Build cannot self-record both the final review and the verifier — the boundary is enforced by the same-runId check on the runId separate from Build's.

### Verification

- `npm run verify` exits `0` with 317 tests across 34 suites on the v0.8 HEAD.

### Added

- **Final review package + axes.** `src/installer/final-review.js` exposes `buildFinalReviewPackage` (merge-base-to-HEAD), `emitStandardsVerdict` and `emitSpecVerdict` (parallel, separate findings with `standardsKind` / `specKind` discriminators), `shouldRecordFinalReview` (pass only when both axes are non-blocking AND HEAD is current), `isReviewStale` (Ready gate staleness check), `READY_GATE_STATES` (the documented transition set: REVIEW_IN_PROGRESS, STANDARDS_PENDING, SPEC_PENDING, BOTH_PENDING, BOTH_PASSED, BLOCKING_FINDINGS, READY).
- **Ready gate.** `src/installer/ready-gate.js` exposes `recordVerifierOutput` (binds the verifier output to the current HEAD; verifier runs in its own runId separate from Build's), `isVerifierStale` (same staleness rule as final review), `buildCannotSelfRecord` (refuses when the final review and the verifier share a runId — Build cannot self-verify), `isReady` (only true when Standards + Spec verdicts are non-blocking AND the verifier exited 0 AND CI is "pass" — all on the same HEAD), `recordReady` (stamps the Ready state on the consumer's HEAD).

## 0.7.0 — M3 task loop contract

`opencode-ship@0.7.0` ships the M3 task loop contract required by issue #22 (Task 7 in approved plan). The run store persists task state under `.git/opencode-ship/runs/<taskId>/`; the task brief extractor surfaces only the active task plus the plan header; the task reviewer emits separate Spec and Quality verdicts; the build-side commit ownership returns true only when the immutable review package is sealed and the plan hash still matches; the three-round breaker routes a failed third round back to the GPT planning role for a revision; the commit binding appends the immutable range to the run ledger; and the compaction context builder emits the short pointer set the chat hook injects when the context overflows. No plan body, no report body, and no commit diffs ever enter the chat.

### Verification

- `npm run verify` exits `0` with 302 tests across 34 suites on the v0.7 HEAD.

### Added

- **Run store.** `src/installer/run-store.js` exposes `ensureRunDir`, `writeProgress`, `readProgress`, `recordCommitRange` (append-only, dedup-rejected), `readCommitRanges`. Persists run state under `.git/opencode-ship/runs/<taskId>/` with the progress.md / ledger.json / reports/ layout.
- **Task brief + compact context.** `src/installer/task-brief.js` exposes `buildTaskBrief` (extracts the active task from a multi-task plan plus the plan header) and `renderCompactContext` (emits the short pointer set the compaction hook injects into chat).
- **Task reviewer.** `src/installer/task-reviewer.js` exposes `emitSpecVerdict`, `emitQualityVerdict` (separate verdicts with `specKind` / `qualityKind` discriminators), `shouldCommit` (only non-blocking on both sides), `assembleReviewPackage` (writes the immutable package to `reports/review-package.json`), `readReviewPackage`.
- **Build-side commit ownership.** `src/installer/build-ownership.js` returns true only when both verdicts are non-blocking AND the sealed review package is on disk AND the plan hash still matches.
- **Three-round breaker.** `src/installer/three-round-breaker.js` exposes `MAX_FIX_ROUNDS = 3` and `shouldRequestPlanRevision` (returns true only when `fixRound >= 3`).
- **Compaction context.** `src/installer/compaction.js` exposes `buildCompactionContext` and `compactContextForRun` (reads the ledger entry count from disk and merges it with the caller-supplied pointer set).
- **Commit binding.** `src/installer/commit-binding.js` re-exports the run-store `recordCommitRange` as `recordApprovedCommit` so Build can call one name per role.

## 0.6.0 — Durable plan artifact + Plan Mode integration

`opencode-ship@0.6.0` ships the durable plan artifact and the Plan Mode permission integration required by issue #21. The runtime now supports the GPT-to-MiniMax handoff end-to-end: a planning sub-agent can write a hash-verified plan to `.git/opencode-ship/plans/<slug>/revision-NNNN.json`, mirror it to the parent issue as a marked comment, and run with a deny-first, narrow-allow permission block that prevents it from touching source/config/docs.

### Verification

- `npm run verify` exits `0` with 283 tests across 34 suites on the v0.6 HEAD.

### Added

- **Plan artifact.** `src/installer/plan.js` declares the plan schema (version, revision, parentIssue, baseSha, architecture, global constraints, file responsibilities, ordered tasks with interfaces / testSeams / commands / expectedEvidence, acceptance, out of scope, recovery). `validatePlan` is fail-closed; `computePlanHash` produces a stable SHA-256 over the canonical content; `canRevise` enforces the append-only N+1 rule; `planNeedsPlaceholderReview` flags any `<placeholder>` marker so a final-reviewer can refuse approval.
- **Plan persistence.** `src/installer/plan-store.js` writes, reads, and lists plan revisions under `.git/opencode-ship/plans/<planSlug>/revision-NNNN.json`. The store refuses to overwrite or skip revisions.
- **Plan issue mirror.** `src/installer/plan-mirror.js` posts the approved plan to the parent issue as a marked comment with the stable `opencode-ship-execution-handoff:v1` marker, the plan hash, and the revision. Retries with linear backoff. The client is injectable so tests run without `gh`.
- **Engineering config.** `src/installer/engineering-config.js` validates the user config (`models.{planner,builder,finalReviewer}` and `plans.{root,mirrorToIssue}`) and resolves model roles with documented defaults. Strict mode throws on missing roles.
- **Plan Mode permission block.** `src/installer/plan-mode-permissions.js` produces the deny-first, narrow-allow permission set documented in the approved plan: bash / webfetch / task.plan-agent / task.build-agent deny, edit / write allow only `.git/opencode-ship/plans/**`.
- **OpenCode config integration.** `src/installer/root-config.js` gains `applyPlanModeOwnership` which injects the Plan Mode block under `agent.plan.permission` on the consumer's `opencode.json` when the active profile is `engineering`. Captures the previous value so uninstall can restore it.
- **Executor wiring.** `src/installer/executor.js` and `planner.js` thread the active profile through to the planner so core consumers never see the Plan Mode block.

## 0.5.0 — Engineering profile content

`opencode-ship@0.5.0` ships the engineering profile content required by issue #20. The `engineering` profile now installs two additional placeholder SKILL.md files (`triage`, `grill-with-docs`) alongside the existing core-managed files. The real SKILL.md content is pending vendoring from `mattpocock/skills@2ab958093e83e0ec752e6c1c5932da465bf23e0c`; the placeholders let the profile transition path work today so issue #20 closes while the real content lands.

### Verification

- `npm run verify` exits `0` with 242 tests across 34 suites on the v0.5 HEAD.

### Changed

- **Catalog gains two engineering-only entries.** `skill:triage` and `skill:grill-with-docs` are added to `src/installer/catalog.js` with `profiles: ["engineering"]`. `core` consumers never see them; `init --profile engineering` installs both.
- **Manifest records the new entries.** `vendor/sources.json` gains two entries pointing at `assets/skills/triage/SKILL.md` and `assets/skills/grill-with-docs/SKILL.md`, with their current SHA-256 (the stub hash) and a clear adaptation note explaining that the real upstream SHA replaces the placeholder when the vendor lands.
- **THIRD_PARTY_NOTICES.md surfaces the attribution.** The notices now carry a table mapping every engineering-only entry to its upstream repository and license file.

### Added

- **`assets/skills/triage/SKILL.md` and `assets/skills/grill-with-docs/SKILL.md`.** Two placeholder files describing the vendored contract. `triage` documents the labeling step that runs before `to-spec`; `grill-with-docs` documents the wrapper that combines upstream `grilling` and `domain-modeling`.

## 0.4.0 — Profile-aware installer foundation

`opencode-ship@0.4.0` adds the profile-aware installer foundation that issue #18 requires. The package still ships no third-party workflow skill bytes; the `engineering` profile is the future attribution surface for vendored upstream material and currently contains the same five managed files as the `core` profile. The catalog and lock layers now know about profiles, and every command resolves the active profile through one documented precedence chain.

### Verification

- `npm run verify` exits `0` with 226 tests across 34 suites on the v0.4 HEAD.

### Added

- **Profile model.** `src/profile.js` declares `PROFILES = ["core", "engineering"]` and exports `resolveProfile({ cli, config, lock })` for the documented precedence (CLI > ship.config > lock > default). Unknown profiles throw a descriptive `Error` so the CLI can surface them as `exit 2`.
- **`--profile` CLI flag.** Every subcommand (`init`, `diff`, `update`, `doctor`, `uninstall`) accepts `--profile <name>`; parse errors emit to `stderr` and return `exit 2`.
- **Lock schema v2.** `CURRENT_LOCK_SCHEMA` is bumped to 2. Newly written locks always carry `manager.profile`; v1 locks (no profile field) still validate as legacy core so v0.3 consumers can upgrade without manual migration. The `ship-lock.schema.json` `enum` allows `[1, 2]` for both `contractVersion` and `manager.schemaVersion`.
- **`ship.config.json .profile`.** The user config schema accepts an optional `profile` enum (`core | engineering`). The profile is loaded by the same precedence chain as the lock.
- **Profile-aware catalog.** Every `CATALOG` entry declares a `profiles` array. `filterCatalogByProfile(catalog, profile)` returns the subset that ships under the active profile; `validateCatalog` rejects entries that reference unknown profiles.
- **Profile-aware doctor.** The new `profile footprint` check scopes asset presence to the active profile; `package integrity` continues to check the full catalog so the maintainer can still see drift in the other profile.
- **Error to `stderr`.** CLI argument-parsing errors are now written to `stderr` (was `stdout`) so consumers can detect parse failures by exit code alone.

## 0.3.0 — Installer hardening and release pipeline

`opencode-ship@0.3.0` hardens the installer for the public registry. This is the v0.3 installer foundation with the `core` profile only; it carries no third-party workflow skill bytes. The package is now fully consumable from npm with provenance. The catalog installs the five managed files plus the two generated artifacts (`ship.config.json`, `ship.lock.json`), and adds tighter guards around every existing one. The plugin target is `.opencode/plugins/opencode-ship.js` so OpenCode auto-loads it from the plural directory; root-config pointer ownership is recorded for every installer-owned entry so the future v0.4 opt-in `engineering` profile can restore previous values on uninstall. v0.3 is the approved slice shipped by parent spec `Viktorxyz/opencode-ship#16` and plan revision `f85bae931d9eed7763e2f6f4dc68e5fad71bdd38c8a667fc9ffe78b5290200be`.

### Verification

- `npm run verify` exits `0` with 190 tests across 34 suites on the v0.3 HEAD.
- `npm pack` and the extracted-tarball smoke both succeed; the bundled plugin registers the canonical nine `delivery_*` tools.

### Changed

- **Single-source version.** `src/version.js` is the canonical home for `PACKAGE_VERSION` and `TEMPLATE_SET`. It reads `package.json` directly when running from source and falls back to the esbuild-inlined `process.env.OPENCODE_SHIP_VERSION` for the bundled CLI.
- **Robust package root resolution.** `src/installer/package-root.js` walks upward from `import.meta.url` until it finds a `package.json` whose `name` is `opencode-ship`, so the catalog resolves the correct source path whether the installer is loaded from `src/installer/` or from the bundled `dist/cli.js` / `dist/plugin.js`.
- **Catalog-driven installer.** `src/installer/catalog.js` declares a stable `id` for every managed asset (`plugin:opencode-ship`, `agent:delivery-reviewer`, `agent:delivery-verifier`, `skill:delivery-workflow`, `skill:planning-research-checkpoint`), each with a `.opencode/`-rooted target path and a `mode: 0o644` policy. `validateCatalog()` checks unique IDs, unique paths, source existence, non-empty file size, allowed kind set, source containment within the package root, and uniform mode; the planner and doctor consume the same array, so adding a managed file is a one-line catalog change.
- **Fail-closed on missing source.** `init`, `diff`, and `update` invoke `validateCatalog()` and translate any failure to `exit 4`. The installer no longer produces a zero-byte placeholder when an asset source is missing.
- **Lock validator.** `src/installer/lock.js` exposes `validateLock()` and `readValidatedLock()`. The lock schema version is enforced (`CURRENT_LOCK_SCHEMA = 1`); an unsupported `manager.schemaVersion` or `contractVersion` returns `kind: "schema"` for the installer to map to `exit 5`; an integrity mismatch maps to `kind: "integrity"`; a malformed shape maps to `kind: "shape"`. `init`, `diff`, `update`, and `uninstall` now route through `readValidatedLock()` so an invalid or unsupported lock can never be silently treated as a fresh install.
- **Read-only `diff`.** The migration detector in `src/installer/migration.js` returns a `proposedConfigSeed` instead of writing to disk; `planConfigSynthesis()` consumes the seed only when `init`/`update` actually commit.
- **Delete operations reach the transaction layer.** `stageFiles()` in `src/installer/executor.js` forwards `delete` plans to `executePlan()`. The transaction layer journals and rolls back deletes so a downgrade or asset removal produces an honest, recoverable change.
- **Real transaction recovery.** `src/installer/transaction.js` writes a sibling backup of every target before promoting a staged file, journals the backup path only, and rolls back in reverse on failure. Recovery on startup replays the same journal so a crash mid-transaction is recovered automatically.
- **Root-config pointer ownership.** Every installer-owned JSON pointer is recorded in the lock under `manager.rootDocuments[].pointers[]`, including equal-existing leaves. v0.3 records ownership; v0.4 restores the previous values on uninstall.
- **Doctor is catalog-driven.** `src/installer/commands/doctor.js` walks `CATALOG` instead of hard-coded paths and adds a `package integrity` check that re-runs `validateCatalog()`. Drift and missing assets are reported once per asset. Exit codes now distinguish `3` for lock integrity/shape, `4` for package integrity, `5` for an unsupported lock schema.
- **Version fallbacks centralised.** `src/version.js` resolves from `package.json` for source-tree callers and from the esbuild-inlined `process.env.OPENCODE_SHIP_VERSION` for the bundled CLI.
- **Build hygiene.** `scripts/build.mjs` writes the temporary `tsconfig.dts.json` under `.tmp/`, removes it in `finally`, and runs `rm -rf .tmp/` at the end. The previously tracked `tsconfig.dts.json` is removed from the working tree and appended to `.gitignore`.
- **Lint and format-check roots.** `scripts/lint.mjs` and `scripts/format-check.mjs` scan `assets/` instead of the legacy root `agents/` and `skills/` directories. The `assets/` tree is the only place bundled agents and skills live.
- **Release workflow.** `.github/workflows/release.yml` validates that the tag matches `package.json#version`, validates `package-lock.json` and `package.json` carry the same version, refuses to republish an existing npm version, renames the tarball to `opencode-ship-<tag>.tgz`, and gates publication on `npm run verify`. The trusted-publisher identity is `Viktorxyz/opencode-ship`; `id-token: write` is granted to the job.
- **Repository identity.** Schema `$id` URLs, the package homepage, repository URL, and bugs URL all point at `https://github.com/Viktorxyz/opencode-ship/…`. The previously published `0.2.0` and `0.2.1` were produced from the `Viktorxyz/opencode-delivery` GitHub repo; v0.3.0 is the first release from `Viktorxyz/opencode-ship`.
- **Publishing policy.** `publishConfig.access = "public"` and `publishConfig.provenance = true` are set in `package.json`.
- **Removal of unused CLI flag.** The unset `--config` flag is removed from `cli-args.js`; the planned v0.4 profile flag will be added to a released version with the documented behavior.

### Added

- `src/version.js` centralises `PACKAGE_VERSION` and `TEMPLATE_SET`.
- `src/installer/package-root.js` resolves the package root independently of the source/bundle dichotomy.
- `src/installer/catalog.js#validateCatalog()` is the new fail-closed validation surface; the thrown error carries structured `issues` and a `catalogValidation` flag.
- `src/installer/lock.js#validateLock()` and `readValidatedLock()` distinguish "fresh install", "supported lock", "unsupported schema", "tampered lock", and "malformed lock".
- `src/installer/migration.js` returns a `proposedConfigSeed`; `planConfigSynthesis()` consumes it instead of branching on legacy state.
- `tests/installer/catalog.test.mjs`, `tests/installer/lock-validation.test.mjs`, `tests/installer/root-config.test.mjs`, `tests/installer/migration-pure.test.mjs`, and `tests/release/release-metadata.test.mjs` exercise the new contracts.
- `tests/package/packed-artifact.test.mjs` extracts the npm tarball into a clean directory and runs its bundled CLI to `init` a fresh Git repository, asserting the plugin path, the five managed files, the lock, and the pointer records.
- `THIRD_PARTY_NOTICES.md` records that v0.3 contains no third-party skill bytes and reserves the attribution surface for the v0.4 `engineering` profile that introduces them.
- `scripts/prepack.mjs` runs `validateCatalog()` and verifies every required packaged artifact before publishing.

### Fixed

- `packed-artifact` smoke test now runs `init --force-root-config` end-to-end from the extracted tarball.
- `diff` against a v0.2.1 consumer briefly wrote `ship.config.json` to disk; `diff` is now strictly read-only even when the migration detector would have seeded one.
- The legacy migration seed now emits a config that matches the canonical consumer shape (`Viktorxyz/leo`, `pnpm`, `pnpm verify:workspace`, the v0.3 cleanup shape) instead of `"origin"` / `"npm"` / legacy `cleanup.requires`.
- Lock entries with `sha256: null` no longer reach `writeLock`; the planner/executor no longer produce a lock whose integrity digest silently mismatches its declared hashes.
- Stale `tsconfig.dts.json` no longer gets tracked; the build artifact is now confined to `.tmp/`, which is gitignored.
- The plugin target is pluralized to `.opencode/plugins/opencode-ship.js` so OpenCode auto-loads it from the default project plugin directory; the previously-tracked singular directory is removed.

## 0.2.0 — npm-distributed installer release

`opencode-ship@0.2.0` replaces the v0.1.x copy-the-shim workflow. The package is now an npm-distributed CLI plus a self-contained OpenCode plugin. Run `pnpm dlx opencode-ship@latest init` from any consumer repo to materialise everything needed for the delivery workflow.

### Changed

- **Package name and public API.** The package is now `opencode-ship` (was `opencode-delivery`). The package root exports the bundled OpenCode plugin; the previous library surface is still reachable through `opencode-ship/core`.
- **`pnpm dlx opencode-ship@latest <command>`.** Five idempotent subcommands: `init`, `diff`, `update`, `doctor`, `uninstall`. Manual copying is no longer required.
- **Self-contained plugin.** `dist/plugin.js` is a single ESM bundle that inlines `@opencode-ai/plugin`. The nine `delivery_*` tools are registered against the bundled tool helper, no consumer-side wrapper is needed.
- **User-owned config + managed lock.** `.opencode/ship.config.json` is user-owned and preserved across updates; `.opencode/ship.lock.json` records installed version, schema version, managed paths, SHA-256 hashes, and an integrity digest.
- **Hash-based reconciliation.** Every managed file's previous lock hash, current disk hash, and desired hash determine the action. Modified managed files are refused with a precise conflict report, never silently overwritten.
- **Recoverable multi-file transactions.** Staged writes, sibling temporary files, journaled backups, and atomic rename per file. Pre-commit failures roll back in reverse order. The lock is promoted last as the commit marker.
- **Build permissions only.** `init` merges only Build-agent delivery permissions into the root `opencode.json` (or `.jsonc`); everything else is preserved untouched.
- **`init` auto-runs `doctor`.** After a successful commit, `init` runs the doctor checks and embeds the result in the JSON envelope (`doctor`, `doctorChecks`). Pass `--strict-doctor` to fail init when the doctor reports unhealthy checks.
- **Post-merge cleanup is immediate.** Successful merge triggers `delivery_cleanup` automatically. Failures persist `cleanupPending` in the lock; the next delivery task or plugin startup retries the queue.
- **Verifier permission isolation.** The verifier's frontmatter now explicitly allows only `delivery_verify` and denies every other `delivery_*` tool, mirroring the reviewer.
- **Models.** Agents inherit the consumer's default model; no hardcoded provider/model pin.
- **Schema files published.** `project-adapter.schema.json`, `ship-config.schema.json`, and `ship-lock.schema.json` are accessible through `opencode-ship/schema/*` exports.
- **Reviewer change-of-SHA guard.** Reviewer must capture the PR head SHA before recording; mismatch returns `head-mismatch` and `missing-head-sha`.
- **`gh pr view` no longer requests the unsupported `merged` field.** `merged` is now derived from `state === "MERGED"` (falling back to a non-null `mergedAt`), so the merge path is portable across `gh` 2.x versions where the field may be missing.
- **Verification pipeline.** `npm run verify` runs `format:check`, `lint`, `typecheck`, `build`, and the auto-discovered test suite against all `tests/**/*.test.mjs`.
- **Packed-artifact smoke test.** `tests/package/packed-artifact.test.mjs` runs `npm pack`, inspects the file list, extracts the tarball, copies the bundled plugin into an isolated consumer with no `node_modules`, and asserts that the plugin loads with exactly nine tool definitions.
- **Fail-closed `prepack`.** `scripts/prepack.mjs` requires `esbuild` and `tsc`, builds the project, and verifies every required build artifact before publishing.

### Added

- **Install manifests and commands.** `init`, `diff`, `update`, `doctor`, `uninstall` CLI commands; exit codes 0–5.
- **JSON-pointer ownership** for the Build-agent permission block; the installer's edits are reversible from the lock.
- **`--force-root-config`** flag that synthesises a minimal `opencode.json` with installer-owned permissions when the consumer has none.
- **`--strict-doctor`** flag that turns doctor issues into a hard init failure.
- **`ship.config.json`** with a nested shape (`project`, `delivery`) and a flat legacy-adapter compatibility layer in `src/installer/ship-adapter.js`.
- **Migration** from legacy v0.1.x consumers (`.opencode/delivery.json`, `.opencode/delivery.lock.json`, generic `delivery.ts` shim). Migration does not delete legacy artifacts and refuses destructive changes when customised.
- **Agent and skill discovery** tests (`tests/agents/delivery-reviewer-contract.test.mjs`, `tests/agents/delivery-verifier-contract.test.mjs`, `tests/agents/reviewer-permission-boundary.test.mjs`, `tests/agents/skill-discovery.test.mjs`).
- **Installer plugin-load smoke test** (`tests/plugin/plugin-load.test.mjs`) that imports the bundled artifact and asserts exactly nine tool definitions.

### Fixed

- The legacy v0.1.x commit-pinned shim left consumers reading `opencode-delivery` from a vendored `.opencode/plugin/delivery.ts`; v0.2.0 removes that requirement and centralises everything in `dist/plugin.js`.
