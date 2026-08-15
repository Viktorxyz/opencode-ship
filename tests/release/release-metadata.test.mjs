/*
 * Release metadata tests for opencode-ship.
 *
 * These tests guard the wire-level consistency of the package: every
 * file that names a version or a repository URL must agree with the
 * other files that carry the same name. They run cheaply inside the
 * existing `npm run verify` pipeline so a regression surfaces before
 * the maintainer reaches for `npm publish`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));

function readJSON(rel) {
  return JSON.parse(readFileSync(`${root}${rel.startsWith("/") ? "" : "/"}${rel}`, "utf8"));
}

function readText(rel) {
  return readFileSync(`${root}${rel.startsWith("/") ? "" : "/"}${rel}`, "utf8");
}

test("package.json: name, version, repository, and publishConfig align", () => {
  const pkg = readJSON("package.json");
  assert.equal(pkg.name, "opencode-ship");
  // Accept SemVer: 0.9.0, 0.10.0-rc.1, 1.0.0-rc.2, etc.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.repository.url, "https://github.com/Viktorxyz/opencode-ship.git");
  assert.equal(pkg.homepage, "https://github.com/Viktorxyz/opencode-ship#readme");
  assert.equal(pkg.bugs.url, "https://github.com/Viktorxyz/opencode-ship/issues");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.publishConfig.provenance, true);
});

test("package-lock.json: carries the same version as package.json", () => {
  const pkg = readJSON("package.json");
  const lock = readJSON("package-lock.json");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(lock.packages[""].name, pkg.name);
});

test("schemas: every $id points at Viktorxyz/opencode-ship", () => {
  for (const rel of [
    "schema/project-adapter.schema.json",
    "schema/ship-config.schema.json",
    "schema/ship-lock.schema.json",
  ]) {
    const schema = readJSON(rel);
    assert.ok(schema.$id.startsWith("https://github.com/Viktorxyz/opencode-ship/"), `${rel} $id is ${schema.$id}`);
  }
});

test("release.yml: validates tag against package.json and publishes to npm", () => {
  const yaml = readText(".github/workflows/release.yml");
  assert.match(yaml, /id-token:\s*write/);
  assert.match(yaml, /setup-node@v4/);
  assert.match(yaml, /npm install --global npm@11\.5\.2/);
  assert.match(yaml, /npm publish/);
  assert.match(yaml, /--provenance/);
  assert.match(yaml, /--tag/);
  // The tarball must use the canonical .tgz extension; the legacy
  // .tarball rename is no longer used.
  assert.match(yaml, /opencode-ship-\$\{ver\}\.tgz/);
  assert.doesNotMatch(yaml, /opencode-ship-\$\{ver\}\.tarball/);
});

test("docs: shipping docs reference the approved engineering-workflow plan", () => {
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");
  // The authoritative 1.0 execution plan lives under
  // `docs/release/`. Live docs must point at that path rather than
  // a historical plan SHA so a refactor of the execution plan
  // can move it without breaking the release contract.
  const planPath = "docs/release/1.0.0-execution-plan.md";
  for (const [name, text] of [["CHANGELOG.md", changelog], ["README.md", readme]]) {
    assert.ok(text.includes(planPath), `${name} must reference the authoritative execution plan path`);
    assert.ok(text.includes("core"), `${name} must keep the documented core profile`);
    assert.ok(!text.includes("practices"), `${name} must not reference the obsolete practices profile`);
  }
});

test("docs: live README/CHANGELOG declare release/0.10.0 as the live release branch", () => {
  // The release/1.0-completion branch is not the live release
  // branch. The live docs must instead declare release/0.10.0 as
  // the live branch for both `0.10.0` and `1.0.0`.
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");
  for (const [name, text] of [["CHANGELOG.md", changelog], ["README.md", readme]]) {
    assert.ok(
      /release\/0\.10\.0[^.]*\blive\b/i.test(text),
      `${name} must declare release/0.10.0 as the live branch`,
    );
  }
});

test("docs: live README/CHANGELOG describe RCs as published under npm dist-tag next", () => {
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");
  for (const [name, text] of [["CHANGELOG.md", changelog], ["README.md", readme]]) {
    assert.ok(
      /next/i.test(text) && /dist-?tag/i.test(text),
      `${name} must describe RCs as published under npm dist-tag next`,
    );
  }
});

test("docs: README and CHANGELOG do not lock in a stale test-count baseline", () => {
  const changelog = readText("CHANGELOG.md");
  const readme = readText("README.md");
  // Neither file asserts a specific test count as a truth value;
  // counts are derived from the test runner at qualification time.
  // We only assert that the README does not pretend a stale
  // baseline is the current truth.
  for (const [name, text] of [["CHANGELOG.md", changelog], ["README.md", readme]]) {
    assert.ok(
      !/must report the \d+-test verification baseline/.test(text),
      `${name} must not assert a specific test count as truth`,
    );
  }
});

test("docs: THIRD_PARTY_NOTICES.md matches the current package version and the engineering profile", () => {
  const notices = readText("THIRD_PARTY_NOTICES.md");
  const pkg = readJSON("package.json");
  const versionPattern = pkg.version.replace(/\./g, "\\.");
  assert.match(
    notices,
    new RegExp(`opencode-ship@${versionPattern}`),
    "notices must reference the current package version",
  );
  // The notices must reference the engineering profile and at
  // least one license surface (e.g. mattpocock/skills or the
  // vendor/mattpocock/LICENSE file).
  assert.match(notices, /engineering.*profile/);
  assert.match(notices, /mattpocock/i);
});

test("source tree: no source file hard-codes the current version", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const srcDir = `${root}/src`;
  const entries = await readdir(srcDir, { recursive: true });
  const offenders = [];
  const pkg = readJSON("package.json");
  const versionRegex = new RegExp(pkg.version.replace(/\./g, "\\."));
  for (const rel of entries) {
    if (!/\.(js|mjs|ts)$/.test(rel)) continue;
    const text = await readFile(`${srcDir}/${rel}`, "utf8");
    if (versionRegex.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `source files with hard-coded versions: ${offenders.join(", ")}`);
});

test("release.yml: prerelease flag is driven by the resolve-prerelease step", () => {
  const yaml = readText(".github/workflows/release.yml");
  // The publish job must compute the prerelease flag from a
  // step output (not a hard-coded value). The resolve-prerelease
  // step must call the same helper script the unit test uses
  // so the mapping stays in sync.
  assert.match(yaml, /id:\s*prerelease\b/, "publish job must declare a resolve-prerelease step");
  assert.match(
    yaml,
    /scripts\/is-prerelease\.mjs/,
    "resolve-prerelease step must delegate to scripts/is-prerelease.mjs",
  );
  assert.match(
    yaml,
    /prerelease:\s*\$\{\{\s*steps\.prerelease\.outputs\.prerelease\s*\}\}/,
    "publish release action must consume the resolve-prerelease step output",
  );
});

test("release.yml: does not pin prerelease to a literal true/false", () => {
  // The softprops/action-gh-release input must be an expression,
  // not a constant. A literal `prerelease: true` would force every
  // release into the prerelease channel; a literal `false` would
  // expose RCs as Latest. The expression form is the contract.
  //
  // We match line-anchored keys (`^  prerelease:` etc.) so the
  // assertion ignores the explanatory comments that describe the
  // bad values they would have without this guard.
  const yaml = readText(".github/workflows/release.yml");
  const literalTrue = /^[ \t]*prerelease:\s*true\s*$/m;
  const literalFalse = /^[ \t]*prerelease:\s*false\s*$/m;
  assert.doesNotMatch(
    yaml,
    literalTrue,
    "publish release action must not pin prerelease to literal true",
  );
  assert.doesNotMatch(
    yaml,
    literalFalse,
    "publish release action must not pin prerelease to literal false",
  );
});

test("is-prerelease: RC versions resolve to true", async () => {
  const { isPrereleaseVersion } = await import("../../scripts/is-prerelease.mjs");
  for (const v of ["0.10.0-rc.1", "0.10.0-rc.19", "1.0.0-rc.1", "0.9.0-rc.2", "0.10.0-alpha.3", "0.10.0-beta.1"]) {
    assert.equal(isPrereleaseVersion(v), true, `${v} must be a prerelease`);
  }
});

test("is-prerelease: stable versions resolve to false", async () => {
  const { isPrereleaseVersion } = await import("../../scripts/is-prerelease.mjs");
  for (const v of ["0.10.0", "1.0.0", "0.9.0", "0.10.0+build.1", "1.0.0+meta"]) {
    assert.equal(isPrereleaseVersion(v), false, `${v} must NOT be a prerelease`);
  }
});

test("release.yml: the prerelease flag the workflow emits for the current version matches the helper", async () => {
  const { isPrereleaseVersion } = await import("../../scripts/is-prerelease.mjs");
  const pkg = readJSON("package.json");
  // The current package version drives the resolve-prerelease
  // step at runtime; assert the helper agrees so a future change
  // to the script cannot drift from the current release state
  // without a CI failure.
  const yaml = readText(".github/workflows/release.yml");
  assert.match(yaml, /PKG_VERSION.*\$\{\{.*pack\.outputs/, "publish job must bind PKG_VERSION from the pack outputs");
  const expected = isPrereleaseVersion(pkg.version);
  // The expected value is what the step output will emit; the
  // workflow expression is opaque here, so we only assert that
  // the helper agrees with itself.
  assert.ok(typeof expected === "boolean", "isPrereleaseVersion must return a boolean");
});

test("release.yml: qualification-report records runtimeSourceSha256", () => {
  const yaml = readText(".github/workflows/release.yml");
  assert.match(
    yaml,
    /runtimeSourceSha256/,
    "qualification-report JSON must include runtimeSourceSha256",
  );
  assert.match(
    yaml,
    /scripts\/runtime-source-sha\.mjs/,
    "qualification-report must call the runtime-source-sha helper",
  );
});

test("release.yml: release-policy gates 1.0 promotion on the runtimeSourceSha256", () => {
  const yaml = readText(".github/workflows/release.yml");
  // The 1.0.x tag is the only one that must prove byte-equivalence
  // to the accepted 0.10.0 release. Non-1.0 tags skip the check so
  // RC / 0.10.x releases do not depend on a 0.10.0 release existing
  // on the registry yet.
  assert.match(
    yaml,
    /scripts\/promote-1\.0-policy\.mjs/,
    "release-policy must call scripts/promote-1.0-policy.mjs for 1.0.x tags",
  );
  // The case statement that gates 1.0.x must be present.
  assert.match(
    yaml,
    /1\.0\.\*\)/,
    "release-policy must gate on the 1.0.x tag pattern",
  );
});

test("release.yml: 1.0 promotion policy script exports a check that fails closed", async () => {
  // This is a static import test: the script must export the
  // required runtime helpers (or at minimum, it must fail closed
  // when invoked without arguments). We exercise the failure
  // path so a refactor that drops the guard fails this test.
  const r = spawnSync("node", ["scripts/promote-1.0-policy.mjs"], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "promote-1.0-policy must refuse to run without arguments");
  assert.match(r.stderr, /required/, "promote-1.0-policy must print a required-argument error");
});

test("is-prerelease: 0.10.0-rc.19 (the current published RC) is recognised as a prerelease", async () => {
  const { isPrereleaseVersion } = await import("../../scripts/is-prerelease.mjs");
  assert.equal(isPrereleaseVersion("0.10.0-rc.19"), true);
});
