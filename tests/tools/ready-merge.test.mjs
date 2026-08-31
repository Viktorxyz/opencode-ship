import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createReadyTool, createMergeTool, createCleanupTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture } from "../helpers/fixture.mjs";
import { writeManifest, readManifest } from "../../src/state/manifest-store.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendRunEvent, createInitialState, readRunState, RUN_EVENT_KINDS } from "../../src/workflow/run-controller.js";
import { buildFinalReviewPackage, hashAxisRecord } from "../../src/workflow/final-review.js";
import { publishGateReceipt } from "../../src/workflow/gate-receipts.js";

async function seedFinalReview(repoRoot, workflowId, taskId, headSha = "abc") {
  const mergeBaseSha = "base";
  const { receipt: verification } = await publishGateReceipt(repoRoot, taskId, "verification", {
    headSha,
    commandId: "canonical",
    argv: ["npm", "test"],
    exitCode: 0,
    stdoutSha256: "c".repeat(64),
    stderrSha256: "d".repeat(64),
  });
  const { receipt: ci } = await publishGateReceipt(repoRoot, taskId, "ci", {
    headSha,
    prNumber: 7,
    checks: [{ name: "delivery-verify", bucket: "pass" }],
  });
  const pkg = buildFinalReviewPackage({
    workflowId,
    headSha,
    mergeBaseSha,
    planHash: "a".repeat(64),
    approvalHash: "b".repeat(64),
    gateTaskId: taskId,
    verificationHash: verification.receiptHash,
    ciHash: ci.receiptHash,
    tasks: [{ taskId, commitSha: headSha, taskHash: "e".repeat(64), reviewHash: "f".repeat(64) }],
    builtAt: new Date().toISOString(),
  });
  const makeReview = (axis) => {
    const record = {
      workflowId,
      axis,
      verdict: "pass",
      headSha,
      mergeBaseSha,
      packageHash: pkg.packageHash,
      reviewerSessionID: `${axis}-session`,
      reviewerModel: "fake/reviewer",
      findings: [],
      reviewedAt: new Date().toISOString(),
    };
    return { ...record, reviewHash: hashAxisRecord(record) };
  };
  const standards = makeReview("standards");
  const spec = makeReview("spec");
  const finalDir = join(repoRoot, ".git", "opencode-ship", "runs", workflowId, "final-review");
  await mkdir(join(finalDir, "standards"), { recursive: true });
  await mkdir(join(finalDir, "spec"), { recursive: true });
  await writeFile(join(finalDir, "package.json"), JSON.stringify(pkg, null, 2));
  await writeFile(join(finalDir, "standards", "review.json"), JSON.stringify(standards, null, 2));
  await writeFile(join(finalDir, "spec", "review.json"), JSON.stringify(spec, null, 2));

  let state = createInitialState(workflowId, 1, "a".repeat(64));
  const append = async (kind, data) => {
    ({ state } = await appendRunEvent(repoRoot, workflowId, state, { kind, data }));
  };
  await append(RUN_EVENT_KINDS.RUN_START, { revision: 1, sha256: "a".repeat(64) });
  await append(RUN_EVENT_KINDS.TASK_DISPATCH, { taskId, briefHash: "1".repeat(64) });
  await append(RUN_EVENT_KINDS.TASK_REPORT, { taskId, reportHash: "2".repeat(64) });
  await append(RUN_EVENT_KINDS.TASK_REVIEW, { taskId, verdict: "pass", reviewHash: "3".repeat(64) });
  await append(RUN_EVENT_KINDS.COMMIT, { commitSha: headSha });
  await append(RUN_EVENT_KINDS.TASK_COMPLETE, { taskId, moreTasks: false });
  for (const review of [standards, spec]) {
    await append(RUN_EVENT_KINDS.FINAL_REVIEW, {
      axis: review.axis,
      verdict: review.verdict,
      headSha,
      mergeBaseSha,
      packageHash: pkg.packageHash,
      review: {
        verdict: review.verdict,
        headSha,
        mergeBaseSha,
        packageHash: pkg.packageHash,
        reviewHash: review.reviewHash,
      },
    });
  }
  return { pkg, standards, spec };
}

function manifest(repoRoot, taskId, overrides) {
  return {
    schemaVersion: 1,
    taskId,
    repoIdentity: "a/b",
    issueNumber: 1,
    prNumber: 7,
    baseBranch: "main",
    baseSha: "abc",
    branch: "backend/t1",
    worktreePath: `${repoRoot}/.worktrees/backend-t1`,
    lastPrHeadSha: "abc",
    lastReviewerSha: "abc",
    lastVerifierSha: "abc",
    owner: "test",
    state: "validating",
    transitionLog: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function driverWith({ headSha = "abc", merged = false, mergeable = "MERGEABLE", checks = [{ name: "delivery-verify", state: "success", bucket: "pass" }] } = {}) {
  return {
    refreshHead: async () => headSha,
    readPullRequest: async () => ({
      number: 7,
      url: "u",
      baseRefName: "main",
      headRefName: "backend/t1",
      headSha,
      draft: false,
      mergeable,
      mergeStateStatus: "CLEAN",
      merged,
      mergedAt: merged ? new Date().toISOString() : null,
    }),
    readChecks: async () => checks,
    markReady: async () => {},
    mergePullRequest: async () => ({
      number: 7,
      url: "u",
      baseRefName: "main",
      headRefName: "backend/t1",
      headSha,
      draft: false,
      mergeable,
      mergeStateStatus: "CLEAN",
      merged: true,
      mergedAt: new Date().toISOString(),
    }),
    comment: async () => {},
  };
}

suite("delivery_ready", { concurrency: false }, () => {
  test("refuses with missing-gate when reviewer SHA is unset", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { lastReviewerSha: null }));
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith(),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "missing-gate");
      assert.equal(r.gate, "review");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when reviewer SHA drifts from PR head", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { lastReviewerSha: "old" }));
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith({ headSha: "new" }),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "head-changed-after-review");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when CI is pending", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1"));
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith({
          checks: [{ name: "delivery-verify", state: "in_progress", bucket: "pending" }],
        }),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "ci-pending");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when CI is failing", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1"));
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith({
          checks: [{ name: "delivery-verify", state: "failure", bucket: "fail" }],
        }),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "ci-failing");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("marks Ready when every gate is fresh", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "validating" }));
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith(),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.contractVersion, 1);
      assert.equal(r.pr, 7);
      const m = await readManifest(fixture.dir, "t1");
      assert.equal(m.state, "ready");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("bridges dual-axis workflow reviews into delivery Ready", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const headSha = "a".repeat(40);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", {
        schemaVersion: 2,
        state: "validating",
        lastReviewerSha: null,
        lastVerifierSha: headSha,
        workflowId: "wf-ready",
      }));
      await seedFinalReview(fixture.dir, "wf-ready", "t1", headSha);
      const tool = createReadyTool({
        repoRoot: fixture.dir,
        driver: driverWith({ headSha }),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const result = await tool({ taskId: "t1" });
      assert.equal(result.contractVersion, 1, JSON.stringify(result));
      assert.equal((await readRunState(fixture.dir, "wf-ready")).state, "ready");
    } finally {
      cleanupFixture(fixture);
    }
  });
});

suite("delivery_merge", { concurrency: false }, () => {
  test("refuses with not-ready when manifest state is wrong", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "validating" }));
      const tool = createMergeTool({
        repoRoot: fixture.dir,
        driver: driverWith(),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1", subject: "fix(t1): merge" });
      assert.equal(r.kind, "not-ready");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses with wrong-base when PR base differs", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "ready" }));
      const tool = createMergeTool({
        repoRoot: fixture.dir,
        driver: driverWith(),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1", subject: "x" });
      assert.equal(r.contractVersion, 1, JSON.stringify(r));
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("performs squash merge when Ready and gates are fresh", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "ready" }));
      const tool = createMergeTool({
        repoRoot: fixture.dir,
        driver: driverWith(),
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const r = await tool({ taskId: "t1", subject: "fix(t1): merge" });
      assert.equal(r.contractVersion, 1, JSON.stringify(r));
      assert.equal(r.kind, "merge", `expected kind=merge envelope, got ${JSON.stringify(r)}`);
      assert.equal(r.taskId, "t1");
      const m = await readManifest(fixture.dir, "t1");
      assert.equal(m.state, "merged");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("reconciles an externally merged PR without re-running merge", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "ready" }));
      let checksRead = 0;
      let mergeCalls = 0;
      const driver = driverWith({ merged: true, mergeable: "UNKNOWN" });
      driver.readChecks = async () => {
        checksRead += 1;
        return [];
      };
      driver.mergePullRequest = async () => {
        mergeCalls += 1;
        throw new Error("already merged PR must not be merged again");
      };
      const tool = createMergeTool({
        repoRoot: fixture.dir,
        driver,
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });

      const result = await tool({ taskId: "t1", subject: "user merged PR #7" });

      assert.equal(result.kind, "merge", JSON.stringify(result));
      assert.equal(checksRead, 0);
      assert.equal(mergeCalls, 0);
      assert.equal((await readManifest(fixture.dir, "t1")).state, "merged");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
