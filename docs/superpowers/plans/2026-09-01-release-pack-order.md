# Release Pack Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the failed `1.1.6` correction safely as `1.1.7` by preserving build dependencies between the final release-ref checkout and `npm pack`.

**Architecture:** Keep the existing immutable-ref validation and clean final checkout. Reorder only the pack job so lockfile-pinned dependencies are installed after that checkout, and guard the sequence with a static workflow test. Advance package metadata and truthful release documentation to `1.1.7`; never move or reuse the failed `1.1.6` tag.

**Tech Stack:** GitHub Actions YAML, Node.js test runner, npm lockfile, Markdown release documentation.

## Global Constraints

- The existing `1.1.6` tag remains immutable and is never deleted, moved, or reused.
- `opencode-ship@1.1.6` was not published; the correction version is exactly `1.1.7`.
- `scripts/prepack.mjs` remains fail-closed and must not install dependencies.
- Release automation never uses `@latest` for install, update, or publish inputs.
- All qualification, provenance, GitHub Release, dual-review, verifier, CI, same-HEAD, explicit-merge, and cleanup gates remain mandatory.

---

### Task 1: Preserve Dependencies Across The Final Checkout

**Files:**
- Modify: `tests/release/release-metadata.test.mjs`
- Modify: `.github/workflows/release.yml:76-143`

**Interfaces:**
- Consumes: the existing `pack` job's named `checkout release ref`, `install dependencies`, and `pack` steps.
- Produces: a stable ordering contract: final checkout index `<` install index `<` pack index.

- [ ] **Step 1: Write the failing workflow-order test**

Add this test after the existing release publish metadata test:

```js
test("release.yml: pack installs dependencies after the final release-ref checkout", () => {
  const yaml = readText(".github/workflows/release.yml");
  const packJob = yaml.slice(yaml.indexOf("  pack:"), yaml.indexOf("  consumer-install:"));
  const checkoutAt = packJob.indexOf("name: checkout release ref");
  const installAt = packJob.indexOf("name: install dependencies");
  const packAt = packJob.indexOf("name: pack");

  assert.ok(checkoutAt >= 0, "pack job must check out the resolved release ref");
  assert.ok(installAt > checkoutAt, "pack job must install dependencies after the final checkout");
  assert.ok(packAt > installAt, "pack job must install dependencies before npm pack");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
node --test tests/release/release-metadata.test.mjs
```

Expected: FAIL at `pack job must install dependencies after the final checkout`, because the current job runs `npm ci` before `checkout release ref`.

- [ ] **Step 3: Move dependency installation after the final checkout**

In `.github/workflows/release.yml`, remove the existing `install dependencies` step before `resolve ref` and insert the unchanged step immediately after `checkout release ref`:

```yaml
      - name: checkout release ref
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true
          ref: ${{ steps.refs.outputs.ref }}
      - name: install dependencies
        env:
          NPM_CONFIG_PRODUCTION: "false"
          NODE_ENV: development
        run: |
          if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ] || [ -f yarn.lock ]; then
            npm ci --no-audit --no-fund --include=dev
          else
            echo "::error::No dependency lockfile. Commit package-lock.json."
            exit 1
          fi
```

- [ ] **Step 4: Run the focused release tests and verify GREEN**

Run:

```sh
node --test tests/release/release-metadata.test.mjs tests/release/prepack-fail-closed.test.mjs
```

Expected: all tests pass; the fail-closed test still confirms prepack never runs an implicit install.

- [ ] **Step 5: Commit the workflow correction**

```sh
git add .github/workflows/release.yml tests/release/release-metadata.test.mjs
git commit -m "fix(release): install dependencies after checkout"
```

---

### Task 2: Advance The Unpublished Correction To 1.1.7

**Files:**
- Modify: `tests/release/release-metadata.test.mjs`
- Modify: `package.json:3`
- Modify: `package-lock.json:3,9`
- Modify: `THIRD_PARTY_NOTICES.md:3`
- Modify: `README.md:5-7`
- Modify: `CHANGELOG.md:5-35`

**Interfaces:**
- Consumes: the package version consistency tests and the approved `docs/release/1.1.6-correction-plan.md` authority.
- Produces: one consistent unpublished package version `1.1.7` and truthful documentation of the failed `1.1.6` qualification attempt.

- [ ] **Step 1: Change the active-line test to require 1.1.7 truth**

Replace the current active `1.1.6` documentation test with:

```js
test("docs: live README/CHANGELOG declare 1.1.7 as the active correction line", () => {
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");
  for (const [name, text] of [["CHANGELOG.md", changelog], ["README.md", readme]]) {
    assert.ok(
      /1\.1\.7/.test(text) && /correction|stabilization/i.test(text),
      `${name} must reference the active 1.1.7 correction line`,
    );
    assert.ok(
      /1\.1\.6/.test(text) && /failed|unpublished|not published/i.test(text),
      `${name} must record that 1.1.6 failed before publication`,
    );
  }
});
```

- [ ] **Step 2: Run the metadata test and verify RED**

Run:

```sh
node --test tests/release/release-metadata.test.mjs
```

Expected: FAIL because README and CHANGELOG still call `1.1.6` the active correction line and do not record the failed tag attempt.

- [ ] **Step 3: Update package metadata to exactly 1.1.7**

Set these three values to `1.1.7`:

```json
// package.json
"version": "1.1.7"

// package-lock.json
"version": "1.1.7"
"packages": { "": { "version": "1.1.7" } }
```

Change the notices lead to:

```md
`opencode-ship@1.1.7` ships the complete Matt Pocock and Superpowers
```

- [ ] **Step 4: Make README and CHANGELOG evidence-bound**

Keep `1.1.5` as the current verified stable pin. State that tag `1.1.6` failed in `pack` before npm publish or GitHub Release, remains immutable, and `1.1.7` is the active unpublished correction. Keep the authoritative plan link at `docs/release/1.1.6-correction-plan.md`.

Use these changelog headings:

```md
## 1.1.7 — Stabilization and self-hosting (unreleased)

## 1.1.6 — Qualification failed before publication
```

The `1.1.6` entry must link workflow run `33495352417` and say no npm package or GitHub Release was created.

- [ ] **Step 5: Run metadata, pack, and prepack tests**

Run:

```sh
node --test tests/release/release-metadata.test.mjs tests/release/prepack-fail-closed.test.mjs tests/package/packed-artifact.test.mjs
```

Expected: all tests pass and the packed artifact reports version `1.1.7`.

- [ ] **Step 6: Commit the version correction**

```sh
git add package.json package-lock.json THIRD_PARTY_NOTICES.md README.md CHANGELOG.md tests/release/release-metadata.test.mjs
git commit -m "chore(release): advance correction to 1.1.7"
```

---

### Task 3: Verify And Prepare The Corrective PR

**Files:**
- Verify only; no additional source files.

**Interfaces:**
- Consumes: Tasks 1 and 2 commits.
- Produces: a clean exact HEAD with local verifier, dual review, required CI, and Ready evidence for issue `#74`.

- [ ] **Step 1: Run canonical verification**

```sh
npm run verify
```

Expected: format, lint, typecheck, build, and all discovered tests pass with a clean worktree after generated outputs are ignored.

- [ ] **Step 2: Push and open the draft PR**

Push `fix/1.1.7-release-pack-order` without force and open a draft PR containing `Closes #74`, the failed run URL, root cause, immutable-tag decision, and canonical verification result.

- [ ] **Step 3: Bind all final gates to one HEAD**

Run independent Standards and Spec reviews, canonical delivery verification, and required GitHub CI against the exact PR HEAD. Any source change invalidates all prior evidence.

- [ ] **Step 4: Mark Ready and stop**

Use `delivery_ready` only after all gates pass. Stop at Ready and request explicit merge approval; do not create tag `1.1.7` before the merged `main` commit exists.

---

### Task 4: Post-Merge Immutable Release

**Files:**
- Operational release only; no source edits.

**Interfaces:**
- Consumes: the implementation PR for issue `#74` and its merged `origin/main` SHA.
- Produces: npm/GitHub/qualification evidence for exact `opencode-ship@1.1.7`.

- [ ] **Step 1: Create the immutable tag**

After explicit merge approval and merge completion, create lightweight tag `1.1.7` at the exact merged `origin/main` SHA, matching the existing `1.1.x` repository convention, and push only that tag.

- [ ] **Step 2: Require the full release workflow to pass**

Watch the tag-triggered `release.yml` run through source verification, pack, consumer matrices, workflow E2E, OpenCode discovery/compatibility, Node compatibility, release policy, qualification report, provenance publish, and GitHub Release.

- [ ] **Step 3: Compare immutable evidence**

Download the qualification and pack artifacts. Confirm the pack SHA-256 equals the GitHub Release tarball SHA-256 and npm's published tarball/integrity metadata identifies version `1.1.7`.

- [ ] **Step 4: Promote only verified 1.1.7**

After every prior check is green, run:

```sh
npm dist-tag add opencode-ship@1.1.7 latest
```

Then verify `npm view opencode-ship dist-tags --json` reports `latest: 1.1.7`. Do not promote on partial or mismatched evidence.
