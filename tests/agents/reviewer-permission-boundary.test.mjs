import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

/**
 * Regression test for ship-reviewer agent permission boundary.
 *
 * The reviewer frontmatter must isolate typed mutation tools. The
 * contract test asserts the frontmatter explicitly allows only
 * `ship_review` and denies every other lifecycle `ship_*` tool.
 */

suite("ship-reviewer agent permission boundary", { concurrency: false }, () => {
  test("frontmatter allows only ship_review, denies all other ship_* lifecycle tools", { serial: true }, async () => {
    const path = "assets/agents/ship-reviewer.md";
    assert.ok(existsSync(path), `${path} must exist`);
    const src = readFileSync(path, "utf8");
    assert.match(src, /^---\n([\s\S]*?)\n---/, "frontmatter must exist");
    const fm = src.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.ok(
      /ship_review:\s*["']?allow["']?/.test(fm),
      "ship_review permission must be explicitly allow",
    );
    const mutationTools = [
      "ship_inspect",
      "ship_issue",
      "ship_worktree",
      "ship_verify",
      "ship_pr",
      "ship_ready",
      "ship_merge",
      "ship_cleanup",
    ];
    for (const tool of mutationTools) {
      assert.match(
        fm,
        new RegExp(`${tool}:\\s*["']?deny["']?`),
        `${tool} must be explicitly denied`,
      );
    }
  });

  test("frontmatter still instructs ship_review on pass with headSha", { serial: true }, async () => {
    const path = "assets/agents/ship-reviewer.md";
    const src = readFileSync(path, "utf8");
    assert.match(src, /ship_review/, "must reference ship_review");
    assert.match(src, /head[Ss]ha|head_ref_oid|headRefOid/, "must reference the head SHA");
    assert.match(src, /pass/i, "must mention the pass verdict");
    assert.match(
      src,
      /refuse.+fail|refuse.+blocked|refuse.+partial|do not call.+ship_review|do not silently record/i,
      "must instruct the reviewer to refuse non-pass verdicts",
    );
  });
});
