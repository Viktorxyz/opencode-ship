/*
 * Contract tests for the verifier agent.
 *
 * The verifier must explicitly allow ONLY ship_verify. All other
 * ship_* lifecycle tools must be explicitly denied. The agent must instruct
 * itself never to invoke bash directly, never to run the project
 * verification command, and to surface blocked state when the
 * manifest is missing.
 */

import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PATH = "assets/agents/ship-verifier.md";

suite("ship-verifier agent contract", { concurrency: false }, () => {
  test("frontmatter exists", { serial: true }, () => {
    assert.ok(existsSync(PATH));
  });

  test("frontmatter allows only ship_verify, denies all other ship_* lifecycle tools", { serial: true }, () => {
    const src = readFileSync(PATH, "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^\s*ship_verify:\s*allow/m, "ship_verify must be allow");
    for (const tool of [
      "ship_inspect",
      "ship_issue",
      "ship_worktree",
      "ship_review",
      "ship_pr",
      "ship_ready",
      "ship_merge",
      "ship_cleanup",
    ]) {
      assert.match(
        fm,
        new RegExp(`^\\s*${tool}:\\s*deny`, "m"),
        `${tool} must be denied`,
      );
    }
  });

  test("frontmatter denies bash entirely", { serial: true }, () => {
    const src = readFileSync(PATH, "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^\s*bash:\s*deny/m, "bash must be denied for verifier");
  });
});
