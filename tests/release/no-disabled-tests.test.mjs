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
import { execFileSync } from "node:child_process";

function runGrep(pattern) {
  // git ls-files always succeeds; grep returns 1 on no match which
  // is the success case here. Use spawn so we don't throw on
  // exit code 1.
  const cp = execFileSync("bash", ["-c", `git ls-files tests | grep -E '${pattern}' || true`], { encoding: "utf8" });
  return cp;
}

suite("release policy: no filename-disabled tests", { concurrency: false }, () => {
  test("no tracked *.skip.test.mjs files", { serial: true }, () => {
    const stdout = runGrep("\\.skip\\.test\\.mjs$");
    assert.equal(stdout.trim(), "", `filename-disabled tests are forbidden:\n${stdout}`);
  });

  test("no tracked *.core-removed.* files", { serial: true }, () => {
    const stdout = runGrep("\\.core-removed\\.");
    assert.equal(stdout.trim(), "", `core-removed test markers are forbidden:\n${stdout}`);
  });

  test("test runner discovers every tracked test file", { serial: true }, () => {
    const tracked = execFileSync("git", ["ls-files", "tests"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.endsWith(".test.mjs"))
      .sort();
    assert.ok(tracked.length > 0, "no tracked test files");
  });
});
