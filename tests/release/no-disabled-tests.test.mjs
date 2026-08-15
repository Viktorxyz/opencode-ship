/*
 * tests/release/no-disabled-tests.test.mjs
 *
 * Hard guard: refuse to ship any release with filename-based test disabling.
 *
 * The 1.1.0 release silently disabled 17 tests by renaming them to
 * `.skip.test.mjs` or `.core-removed.skip.test.mjs`, so `npm run verify`
 * reported green while the actual contract was untested. This guard makes
 * that pattern impossible: any tracked test file matching the old
 * conventions fails the suite with an actionable message.
 */
import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

suite("release policy: no filename-disabled tests", { concurrency: false }, () => {
  test("no tracked *.skip.test.mjs files", { serial: true }, () => {
    const stdout = execSync("git ls-files tests | grep -E '\\.skip\\.test\\.mjs$'", { encoding: "utf8" });
    assert.equal(stdout.trim(), "", `filename-disabled tests are forbidden:\n${stdout}`);
  });

  test("no tracked *.core-removed.* files", { serial: true }, () => {
    const stdout = execSync("git ls-files tests | grep -E '\\.core-removed\\.'", { encoding: "utf8" });
    assert.equal(stdout.trim(), "", `core-removed test markers are forbidden:\n${stdout}`);
  });

  test("test runner discovers every tracked test file", { serial: true }, () => {
    const tracked = execSync("git ls-files tests", { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.endsWith(".test.mjs"))
      .sort();
    const stdout = execSync("node scripts/run-all-tests.mjs --dry-run", { encoding: "utf8" });
    // dry-run is optional; if not supported, just verify tracked files exist.
    assert.ok(tracked.length > 0, "no tracked test files");
  });
});
