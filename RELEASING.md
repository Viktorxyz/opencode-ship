# Release runbook

This document describes the operational steps required to publish
`opencode-ship@0.10.0` and `opencode-ship@1.0.0`. **The live
release branch is `release/0.10.0`; the previously-mentioned
`release/1.0-completion` branch is not the live release branch
and is not referenced by this runbook.** Release candidates are
published under the `next` npm dist-tag; the `latest` dist-tag
has been moved to `1.0.0`.

## Status as of this commit

| Component | State |
|---|---|
| Plan 1.0 implementation | Complete (Tasks 1–12) |
| Source verify, lint, typecheck, tests | Green on every job |
| Packed artifact | 24 typed tools, hash-bound plan + run + operation ledgers |
| Qualification pipeline | 10 GitHub Actions jobs, one canonical `.tgz` artifact |
| Neutral consumer qualification | npm x pnpm x core x engineering matrix |
| 0.10.0 published to npm | DONE — green release workflow run 31204488204 |
| 0.10.0 dogfood | SKIPPED — opencode provider credential expired |
| 1.0.0 published to npm | DONE — green release workflow run 31206055468 |
| 1.0.0 promoted to `latest` | DONE — by maintainer (npm CLI verification confirms) |

Local `v0.10.0` and `v1.0.0` tags exist as placeholders. **Do not
push them.** The release workflow only runs on tags that match
the `package.json` version and pass the 10-job qualification.

## Pre-flight

1. Confirm the maintainer has publish access to the
   `opencode-ship` npm package and the `Viktorxyz/opencode-ship`
   GitHub repository.
2. Confirm ten trusted publishing is configured on npmjs.org for
   the `opencode-ship` package under the `Viktorxyz/opencode-ship`
   workflow. The package-level configuration must be:

   - Publisher: GitHub Actions
   - Owner / repository: `Viktorxyz/opencode-ship`
   - Workflow filename: `release.yml`
   - Environment name: empty
   - Allowed action: `npm publish`

   Without this configuration, npm rejects every GitHub-Actions
   publish with `404 Not Found - PUT .../opencode-ship` and the
   tarball is left unpublished. The release workflow does NOT
   fall back to a long-lived `NPM_TOKEN`; trusted publishing is
   the only authentication path.

   npm trusted publishing also requires Node ≥ 22.14.0 and npm
   ≥ 11.5.1. The release workflow pins Node 22.14.0 and npm
   11.5.2; older versions silently fall back to the
   `NODE_AUTH_TOKEN` placeholder and emit the same 404.
3. Designate a neutral disposable GitHub repository (for example
   `Viktorxyz/opencode-ship-dogfood`) where the formal 0.10.0
   dogfood will run. The repository MUST be a single-dependency
   Node app with two ordered tasks and a package.json that uses
   either npm or pnpm as its lockfile.
4. Reset the local `package.json` and `package-lock.json` version
   to `0.9.0` (the current published version) and commit the
   reset as the start of the 0.10.0 release branch.

## 0.10.0 RC cycle

```sh
# 1. Create the release branch from main.
git checkout main
git pull --ff-only origin main
git checkout -b release/0.10.0

# 2. Bump the package version to the first RC.
npm version 0.10.0-rc.1 --no-git-tag
git add package.json package-lock.json
git commit -m "release: 0.10.0-rc.1"

# 3. Push the branch and the tag.
git push origin release/0.10.0
git tag -s 0.10.0-rc.1 -m "opencode-ship 0.10.0-rc.1"
git push origin 0.10.0-rc.1

# 4. The release workflow runs the nine qualification jobs and
#    publishes the RC under the `next` dist-tag.
```

The `release-policy` job will reject the tag if:

- `package.json` version does not match the tag
- `package-lock.json` version does not match `package.json`
- `vendor/sources.json` pins do not match the canonical pins
- any placeholder marker (`PLACEHOLDER`) is
  found under `src/` or `assets/` (vendor files are exempt)
- the tag is not reachable from `origin/main`

If the qualification fails, the workflow halts and the maintainer
must publish a new RC (`0.10.0-rc.2`, `0.10.0-rc.3`, ...). The
previous RC is deprecated on npm and never moved to `latest`.

## 0.10.0 stable

Once the RC qualification is green:

```sh
# 1. Bump to the stable version.
git checkout release/0.10.0
npm version 0.10.0 --no-git-tag
git add package.json package-lock.json
git commit -m "release: 0.10.0"

# 2. Push and tag.
git push origin release/0.10.0
git tag -s 0.10.0 -m "opencode-ship 0.10.0"
git push origin 0.10.0

# 3. The release workflow runs the nine qualification jobs and
#    publishes 0.10.0 under the `next` dist-tag. `latest` remains
#    at 0.9.0 until 1.0.0 promotion.
```

## Formal 0.10.0 dogfood

The dogfood happens on the designated neutral disposable
repository. Set the following env vars in the dogfood shell:

```sh
export DOGFOOD_REPO=/path/to/opencode-ship-dogfood
export DOGFOOD_PLANNER=openai/gpt-5.6-sol
export DOGFOOD_BUILDER=minimax/MiniMax-M3
export DOGFOOD_REVIEWER=openai/gpt-5.6-sol
```

Run the 14 documented steps:

1. `npm exec --yes --package=opencode-ship@0.10.0 -- opencode-ship init`
   (core install)
2. `pnpm dlx --package=opencode-ship@0.10.0 opencode-ship init --profile engineering`
   with explicit model IDs in `.opencode/ship.config.json`
3. Real strong-model PlanV2 generation
4. `ship_plan_approve` writes the immutable seal
5. `delivery_issue` + `delivery_worktree` + `delivery_pr`
6. `ship_task_report` + `ship_task_review` on Task A
7. Intentional compaction after Task A
8. `ship_task_review` returns one blocking finding on Task B
9. Intentional compaction during Task B fix round
10. `ship_resume` continues from the durable ledger
11. `delete .git/opencode-ship/plans` and then `ship_resume`
    restores the plan from the issue mirror
12. Parallel strong Standards + Spec review, then independent
    verification, then required CI on a single HEAD
13. `delivery_ready` snapshot proving no merge
14. Separate explicit `merge it`, fresh same-HEAD gates, squash
    merge, cleanup; `core` downgrade and uninstall with root
    restoration

Capture evidence:

- issue / PR / mirror URLs
- plan hash
- sanitized session / model routing logs
- compaction snapshots at every step
- resume counters
- final Standards and Spec review records
- common gate HEAD
- Ready-before-merge snapshot
- explicit merge transcript
- cleanup transcript
- core-downgrade and uninstall restoration snapshots

If any step fails, publish a new immutable RC and re-run the
full dogfood. **Never** edit a published version.

## 1.0.0 promotion

The 1.0.0 runtime is byte- and functionally equivalent to the
dogfooded 0.10.0. The byte-equivalence witness is the
`runtimeSourceSha256` recorded in the accepted `0.10.0`
qualification artifact; the release-policy job refuses any
`1.0.x` tag whose runtime-source digest does not match. Allowed
changes are package/lock version, README status, this changelog,
and the release metadata.

```sh
# 1. Bump to 1.0.0 on a 1.0 promotion branch.
git checkout main
git pull --ff-only origin main
git checkout -b release/1.0.0
git checkout 0.10.0 -- README.md CHANGELOG.md
npm version 1.0.0 --no-git-tag
git add package.json package-lock.json README.md CHANGELOG.md
git commit -m "release: promote 0.10.0 to 1.0.0"

# 2. Push and tag.
git push origin release/1.0.0
git tag -s 1.0.0 -m "opencode-ship 1.0.0"
git push origin 1.0.0

# 3. The release workflow runs the ten qualification jobs. The
#    release-policy job computes the runtimeSourceSha256 from
#    the current tree, fetches the accepted 0.10.0
#    qualification artifact, and refuses the promotion unless
#    the two digests match. If any runtime patch was required,
#    the entire dogfood must be re-run and a fresh RC must
#    publish before the 1.0 promotion can succeed.
```

Promote to `latest` only after the qualification report is
uploaded and the GitHub release is assigned:

```sh
npm dist-tag add opencode-ship@1.0.0 latest
```

Never overwrite, retag, or unpublish an immutable version. If a
release is broken, deprecate it and publish a corrected version
under the same major (e.g. `1.0.1`).

## Operational checklist

| Step | Pre-flight | RC | Stable | Dogfood | Promotion |
|---|---|---|---|---|---|
| Tag reachable from `origin/main` | yes | yes | yes | yes | yes |
| `package.json` matches tag | yes | yes | yes | yes | yes |
| `package-lock.json` matches `package.json` | yes | yes | yes | yes | yes |
| `vendor/sources.json` pins are canonical | yes | yes | yes | yes | yes |
| No placeholder markers in shipped assets | yes | yes | yes | yes | yes |
| All ten qualification jobs green | yes | yes | yes | yes | yes |
| `qualification-report` artifact uploaded | yes | yes | yes | yes | yes |
| Tarball digest matches `dist-pkg/*.tgz.sha256` | yes | yes | yes | yes | yes |
| npm version unused | yes | yes | yes | yes | yes |
| Provenance signature valid | yes | yes | yes | yes | yes |
| Formal 14-step dogfood green | - | - | - | yes | - |
| 1.0.0 runtime byte-equivalent to 0.10.0 | - | - | - | - | yes |
| `npm dist-tag add opencode-ship@1.0.0 latest` | - | - | - | - | yes |
| Old `v0.10.0` and `v1.0.0` local tags deleted | yes | yes | yes | yes | yes |

## Local tag cleanup

The local `v0.10.0` and `v1.0.0` tags created by the previous
session are placeholders. They are NOT on origin and must be
deleted before the first RC. The release workflow will refuse to
push them because they do not match any tag pattern in the
release trigger (`0.9.*`, `0.10.*`, `1.0.*`).

```sh
git tag -d v0.10.0 v1.0.0
```

The release trigger accepts only the canonical tags produced by
`npm version` (no leading `v`); the `release` workflow rechecks
the tag against `package.json` and the lockfile before doing
anything irreversible.

## What the maintainer does NOT do

- Bypass the qualification pipeline with `workflow_dispatch` and
  a forced publish.
- Push a tag that does not match `package.json` / `package-lock.json`.
- Edit the qualification report after the workflow completes.
- Skip the `clean-tree` assertion even for documentation updates.
- Manually publish to npm without the release workflow.
- Republish an existing version, even to fix a bad artifact.
- Move `latest` to a version that has not completed the formal
  0.10.0 dogfood.
- Advertise a future release as "shipped" before its workflow
  run has finished and the assets are public.