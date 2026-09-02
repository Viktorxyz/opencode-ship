import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { createGhDriver, createGhStub } from "../../src/drivers/gh-cli.js";
import { parseRepoSlug } from "../../src/drivers/github.js";

function recorder(runner) {
  const calls = [];
  const wrapped = async (args) => {
    calls.push(args);
    return runner(args);
  };
  return { run: wrapped, calls };
}

suite("github driver", { concurrency: false }, () => {
  test("parseRepoSlug accepts owner/name and rejects malformed", { serial: true }, () => {
    assert.deepEqual(parseRepoSlug("a/b"), { owner: "a", name: "b" });
    assert.equal(parseRepoSlug("a"), null);
    assert.equal(parseRepoSlug("a/"), null);
    assert.equal(parseRepoSlug("/b"), null);
    assert.equal(parseRepoSlug(""), null);
  });

  test("createGhDriver returns a well-formed driver", { serial: true }, () => {
    const d = createGhDriver({ runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
    for (const k of [
      "ensureIssue",
      "openDraftPullRequest",
      "updatePullRequestBody",
      "markReady",
      "mergePullRequest",
      "readPullRequest",
      "readChecks",
      "comment",
      "refreshHead",
    ]) {
      assert.equal(typeof d[k], "function");
    }
  });

  test("gh-cli does not request the removed `merged` field", { serial: true }, async () => {
    const { defaultRunner } = await import("../../src/drivers/gh-cli.js");
    void defaultRunner;
    const r = recorder(async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        const jsonArg = args[args.indexOf("--json") + 1] ?? "";
        // Assert the field set never includes `merged` as a top-level field.
        assert.equal(jsonArg.includes("\"merged\","), false,
          `viewFields unexpectedly contains merged: ${jsonArg}`);
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 1, url: "u", baseRefName: "main", headRefName: "f",
            headRefOid: "abc", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", state: "MERGED", mergedAt: "now",
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const d = createGhDriver({ runner: r.run });
    const pr = await d.readPullRequest({ repo: "a/b", number: 1 });
    assert.equal(pr.merged, true);
    assert.equal(pr.mergedAt, "now");
    assert.equal(pr.state, "MERGED");
  });

  test("readPullRequest maps OPEN and CLOSED states", { serial: true }, async () => {
    const replies = [
      { state: "OPEN", mergedAt: null },
      { state: "CLOSED", mergedAt: null },
    ];
    const r = recorder(async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        const next = replies.shift();
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 1, url: "u", baseRefName: "main", headRefName: "f",
            headRefOid: "abc", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", ...next,
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const d = createGhDriver({ runner: r.run });
    const open = await d.readPullRequest({ repo: "a/b", number: 1 });
    assert.equal(open.state, "OPEN");
    assert.equal(open.merged, false);
    const closed = await d.readPullRequest({ repo: "a/b", number: 1 });
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.merged, false);
  });

  test("ensureIssue reuses an existing open issue when title matches", { serial: true }, async () => {
    const r = recorder(async (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify([{ number: 7, title: "Existing", state: "OPEN", url: "u" }]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const d = createGhDriver({ runner: r.run });
    const out = await d.ensureIssue({ repo: "a/b", title: "Existing", body: "b", labels: [] });
    assert.equal(out.created, false);
    assert.equal(out.summary.number, 7);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].slice(0, 4), ["issue", "list", "--repo", "a/b"]);
  });

  test("ensureIssue creates an issue when no match exists", { serial: true }, async () => {
    const r = recorder(async (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "create") {
        return { status: 0, stdout: "https://github.com/a/b/issues/42\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const d = createGhDriver({ runner: r.run });
    const out = await d.ensureIssue({
      repo: "a/b",
      title: "New",
      body: "body",
      labels: ["enhancement"],
    });
    assert.equal(out.created, true);
    assert.equal(out.summary.number, 42);
  });

  test("ensureIssue rejects malformed repo slug", { serial: true }, async () => {
    const d = createGhDriver({ runner: async () => ({ status: 0, stdout: "", stderr: "" }) });
    await assert.rejects(() =>
      d.ensureIssue({ repo: "nope", title: "t", body: "b", labels: [] }),
    );
  });

  test("readChecks marks missing required checks as pending", { serial: true }, async () => {
    const r = recorder(async () => ({
      status: 0,
      stdout: JSON.stringify([{ name: "lint", state: "success", bucket: "pass" }]),
      stderr: "",
    }));
    const d = createGhDriver({ runner: r.run });
    const out = await d.readChecks({
      repo: "a/b",
      sha: "abc",
      required: ["lint", "delivery-verify"],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "lint");
    assert.equal(out[0].bucket, "pass");
    assert.equal(out[1].name, "delivery-verify");
    assert.equal(out[1].bucket, "pending");
  });

  test("readChecks treats empty gh output as empty list", { serial: true }, async () => {
    const r = recorder(async () => ({ status: 0, stdout: "", stderr: "" }));
    const d = createGhDriver({ runner: r.run });
    const out = await d.readChecks({ repo: "a/b", sha: "abc", required: ["lint"] });
    assert.deepEqual(out, [{ name: "lint", state: "pending", bucket: "pending" }]);
  });

  test("mergePullRequest rejects with stderr detail on non-zero exit", { serial: true }, async () => {
    const r = recorder(async () => ({ status: 1, stdout: "", stderr: "oh no" }));
    const d = createGhDriver({ runner: r.run });
    await assert.rejects(
      () => d.mergePullRequest({ repo: "a/b", number: 1, subject: "x" }),
      /oh no/,
    );
  });

  test("openDraftPullRequest appends Closes #N when missing", { serial: true }, async () => {
    const r = recorder(async (args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return { status: 0, stdout: "https://github.com/a/b/pull/3\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 3,
            url: "u",
            baseRefName: "main",
            headRefName: "feature",
            headRefOid: "abc",
            isDraft: true,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            merged: false,
            mergedAt: null,
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const d = createGhDriver({ runner: r.run });
    const pr = await d.openDraftPullRequest({
      repo: "a/b",
      head: "feature",
      base: "main",
      title: "T",
      body: "Body",
      issueNumber: 9,
    });
    assert.equal(pr.number, 3);
    assert.equal(pr.headSha, "abc");
    assert.equal(pr.draft, true);
    const createCall = r.calls.find((c) => c[0] === "pr" && c[1] === "create");
    const fullBody = createCall.slice(createCall.indexOf("--body") + 1).join("\n");
    assert.match(fullBody, /Body/);
    assert.match(fullBody, /Closes #9/);
  });

  test("createGhStub pops queued responses in order", { serial: true }, async () => {
    const stub = createGhStub([
      { match: (a) => a[0] === "pr" && a[1] === "view", stdout: JSON.stringify({ number: 1, url: "u", baseRefName: "main", headRefName: "f", headRefOid: "abc", isDraft: true, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: false, mergedAt: null }) },
      { match: (a) => a[0] === "pr" && a[1] === "view", stdout: JSON.stringify({ number: 1, url: "u", baseRefName: "main", headRefName: "f", headRefOid: "abc", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: true, mergedAt: "now" }) },
      { match: (a) => a[0] === "pr" && a[1] === "merge", stdout: "ok\n" },
    ]);
    await stub.driver.readPullRequest({ repo: "a/b", number: 1 });
    await stub.driver.mergePullRequest({ repo: "a/b", number: 1, subject: "x" });
    await assert.rejects(() =>
      stub.driver.mergePullRequest({ repo: "a/b", number: 1, subject: "x" }),
      /no response queued/,
    );
  });
});
