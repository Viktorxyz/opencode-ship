import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { writeManifest } from "../../src/state/manifest-store.js";
import { publishApproval, publishPlanRevision } from "../../src/workflow/plan-store.js";
import {
  appendRunEvent,
  buildCommitTrailers,
  createInitialState,
  readRunState,
  RUN_EVENT_KINDS,
} from "../../src/workflow/run-controller.js";
import { publishGateReceipt } from "../../src/workflow/gate-receipts.js";
import {
  issueControllerLease,
  prepareDispatch,
  ROLES,
  transitionDispatch,
} from "../../src/runtime/opencode-dispatcher.js";
import { createTaskStartTool } from "../../src/tools/ship-task-start.js";
import { createTaskReportTool } from "../../src/tools/ship-task-report.js";
import { createTaskCommitTool } from "../../src/tools/ship-task-commit.js";
import { createTaskCompleteTool } from "../../src/tools/ship-task-complete.js";
import { cleanupFixture, git, makeFixtureRepo } from "../helpers/fixture.mjs";

const WORKFLOW_ID = "wf-task-routing";
const TASK_ID = "task-1";
const DELIVERY_TASK_ID = "delivery-task-routing";
const ISSUE_NUMBER = 301;
const CONTROLLER_SESSION = "controller-task-routing";
const BUILDER_SESSION = "builder-task-routing";
const REVIEW_HASH = "c".repeat(64);
const MODELS = {
  planner: "fake/planner",
  builder: "fake/builder",
  finalReviewer: "fake/final-reviewer",
};

function planFor(baseSha) {
  return {
    schemaVersion: 2,
    workflowId: WORKFLOW_ID,
    revision: 1,
    supersedes: null,
    authoredBy: {
      sessionID: "planner-task-routing",
      model: MODELS.planner,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    source: {
      repository: "owner/repo",
      issueNumber: ISSUE_NUMBER,
      issueUrl: `https://github.com/owner/repo/issues/${ISSUE_NUMBER}`,
      baseBranch: "main",
      baseSha,
    },
    goal: "Route durable task execution through the feature worktree.",
    architecture: { summary: "Resolve the linked delivery manifest.", decisions: [] },
    constraints: [],
    files: [{ path: "task.txt", action: "create", responsibility: "Task output", taskIds: [TASK_ID] }],
    tasks: [{
      id: TASK_ID,
      ordinal: 1,
      title: "Route task execution",
      objective: "Use the linked worktree.",
      dependsOn: [],
      preconditions: [{ kind: "head-is", value: baseSha }],
      changes: [{
        path: "task.txt",
        operation: "create",
        symbols: [],
        instructions: ["Create task output."],
        preserve: ["Durable state."],
      }],
      interfaces: [],
      tests: [],
      commands: [],
      acceptance: [{ id: "route-1", assertion: "Execution uses the feature worktree.", evidence: ["Focused test passes."] }],
      commit: { message: "test: route task" },
    }],
    finalAcceptance: [],
    outOfScope: [],
    recovery: [],
  };
}

function manifestFor(baseSha, worktreePath) {
  return {
    schemaVersion: 2,
    taskId: DELIVERY_TASK_ID,
    repoIdentity: "owner/repo",
    issueNumber: ISSUE_NUMBER,
    prNumber: 7,
    baseBranch: "main",
    baseSha,
    branch: "feature/task-routing",
    worktreePath,
    lastPrHeadSha: null,
    lastReviewerSha: null,
    lastVerifierSha: null,
    lastVerificationHash: null,
    workflowId: WORKFLOW_ID,
    owner: "test",
    state: "draft-open",
    transitionLog: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

function fakeClient() {
  const createCalls = [];
  const promptCalls = [];
  return {
    createCalls,
    promptCalls,
    client: {
      session: {
        create: async (options) => {
          createCalls.push(options);
          const title = options.body.title;
          const id = title.includes("builder")
            ? BUILDER_SESSION
            : title.includes("task-reviewer")
              ? "reviewer-task-routing"
              : title.includes("standards")
                ? "standards-task-routing"
                : "spec-task-routing";
          return { data: { id } };
        },
        promptAsync: async (options) => {
          promptCalls.push(options);
          return { data: undefined };
        },
      },
    },
  };
}

async function setupFixture() {
  const fixture = makeFixtureRepo();
  const baseSha = git(fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
  const worktreePath = join(fixture.dir, ".worktrees", "feature-task-routing");
  const created = git(fixture.dir, ["worktree", "add", "-b", "feature/task-routing", worktreePath]);
  assert.equal(created.status, 0, created.stderr);
  await writeFile(join(fixture.dir, ".opencode", "ship.lock.json"), JSON.stringify({
    manager: { setupComplete: true },
  }));
  const { hash: planHash } = await publishPlanRevision(fixture.dir, planFor(baseSha));
  const initial = createInitialState(WORKFLOW_ID, 1, planHash);
  await appendRunEvent(fixture.dir, WORKFLOW_ID, initial, {
    kind: RUN_EVENT_KINDS.RUN_START,
    data: { revision: 1, sha256: planHash },
  });
  const manifest = manifestFor(baseSha, worktreePath);
  await writeManifest(fixture.dir, manifest);
  await issueControllerLease(fixture.dir, WORKFLOW_ID, CONTROLLER_SESSION);
  return {
    fixture,
    baseSha,
    planHash,
    manifest,
    worktreePath: realpathSync(worktreePath),
  };
}

async function append(repoRoot, kind, data) {
  const state = await readRunState(repoRoot, WORKFLOW_ID);
  return appendRunEvent(repoRoot, WORKFLOW_ID, state, { kind, data });
}

async function authorizeBuilder(repoRoot) {
  await prepareDispatch(repoRoot, WORKFLOW_ID, ROLES.BUILDER, { taskId: TASK_ID, round: 1 }, {});
  await transitionDispatch(repoRoot, WORKFLOW_ID, "builder:task-1:1", "created", {
    sequence: 1,
    sessionID: BUILDER_SESSION,
    controllerSessionID: CONTROLLER_SESSION,
  });
  await transitionDispatch(repoRoot, WORKFLOW_ID, "builder:task-1:1", "prompted", {
    sequence: 2,
    sessionID: BUILDER_SESSION,
    controllerSessionID: CONTROLLER_SESSION,
  });
}

async function prepareReviewedTask(setup, { trailers = true } = {}) {
  await append(setup.fixture.dir, RUN_EVENT_KINDS.TASK_DISPATCH, {
    taskId: TASK_ID,
    briefHash: "b".repeat(64),
  });
  await append(setup.fixture.dir, RUN_EVENT_KINDS.TASK_REPORT, {
    taskId: TASK_ID,
    reportHash: "d".repeat(64),
  });
  await append(setup.fixture.dir, RUN_EVENT_KINDS.TASK_REVIEW, {
    taskId: TASK_ID,
    verdict: "pass",
    reviewHash: REVIEW_HASH,
  });
  await writeFile(join(setup.worktreePath, "task.txt"), "feature task\n");
  assert.equal(git(setup.worktreePath, ["add", "task.txt"]).status, 0);
  const args = ["commit", "-m", "test: feature task"];
  if (trailers) {
    args.push("-m", buildCommitTrailers({
      workflowId: WORKFLOW_ID,
      planHash: setup.planHash,
      taskId: TASK_ID,
      round: 1,
      reviewHash: REVIEW_HASH,
    }).join("\n"));
  }
  const committed = git(setup.worktreePath, args);
  assert.equal(committed.status, 0, committed.stderr);
  return git(setup.worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
}

function controllerInput(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    taskId: TASK_ID,
    ctx: { sessionID: CONTROLLER_SESSION, agent: "ship-controller" },
    ...overrides,
  };
}

function toolDeps(setup, client = null) {
  return {
    repoRoot: setup.fixture.dir,
    repoSlug: "owner/repo",
    adapter: setup.fixture.adapter,
    config: { workflow: { models: MODELS } },
    opencodeClient: client,
  };
}

test("task start dispatches builder SDK requests from the linked feature worktree", async () => {
  const setup = await setupFixture();
  try {
    const sdk = fakeClient();
    const result = await createTaskStartTool(toolDeps(setup, sdk.client))(controllerInput());

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sdk.createCalls[0].query.directory, setup.worktreePath);
    assert.equal(sdk.promptCalls[0].query.directory, setup.worktreePath);
    assert.equal(git(setup.fixture.dir, ["rev-parse", "HEAD"]).stdout.trim(), setup.baseSha);
  } finally {
    cleanupFixture(setup.fixture);
  }
});

test("task report dispatches reviewer SDK requests from the linked feature worktree", async () => {
  const setup = await setupFixture();
  try {
    await authorizeBuilder(setup.fixture.dir);
    await append(setup.fixture.dir, RUN_EVENT_KINDS.TASK_DISPATCH, {
      taskId: TASK_ID,
      briefHash: "b".repeat(64),
    });
    const sdk = fakeClient();
    const result = await createTaskReportTool(toolDeps(setup, sdk.client))({
      workflowId: WORKFLOW_ID,
      taskId: TASK_ID,
      round: 1,
      summary: "Implemented in the feature worktree.",
      ctx: { sessionID: BUILDER_SESSION, agent: "ship-task-builder" },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sdk.createCalls[0].query.directory, setup.worktreePath);
    assert.equal(sdk.promptCalls[0].query.directory, setup.worktreePath);
  } finally {
    cleanupFixture(setup.fixture);
  }
});

test("resolver failures stop builder and reviewer dispatch without creating child sessions", async () => {
  const startSetup = await setupFixture();
  try {
    await writeManifest(startSetup.fixture.dir, {
      ...startSetup.manifest,
      worktreePath: startSetup.fixture.dir,
    });
    const startSdk = fakeClient();
    const start = await createTaskStartTool(toolDeps(startSetup, startSdk.client))(controllerInput());
    assert.equal(start.ok, false);
    assert.equal(start.retryable, false);
    assert.equal(start.details.kind, "invalid-worktree");
    assert.equal(start.details.reason, "main");
    assert.equal(startSdk.createCalls.length, 0);
  } finally {
    cleanupFixture(startSetup.fixture);
  }

  const reportSetup = await setupFixture();
  try {
    await authorizeBuilder(reportSetup.fixture.dir);
    await append(reportSetup.fixture.dir, RUN_EVENT_KINDS.TASK_DISPATCH, {
      taskId: TASK_ID,
      briefHash: "b".repeat(64),
    });
    await writeManifest(reportSetup.fixture.dir, {
      ...reportSetup.manifest,
      worktreePath: reportSetup.fixture.dir,
    });
    const reportSdk = fakeClient();
    const report = await createTaskReportTool(toolDeps(reportSetup, reportSdk.client))({
      workflowId: WORKFLOW_ID,
      taskId: TASK_ID,
      round: 1,
      summary: "Must not dispatch.",
      ctx: { sessionID: BUILDER_SESSION, agent: "ship-task-builder" },
    });
    assert.equal(report.ok, false);
    assert.equal(report.retryable, false);
    assert.equal(report.details.kind, "invalid-worktree");
    assert.equal(report.details.reason, "main");
    assert.equal(reportSdk.createCalls.length, 0);
  } finally {
    cleanupFixture(reportSetup.fixture);
  }
});

test("task commit accepts feature SHA B while the primary checkout remains at SHA A", async () => {
  const setup = await setupFixture();
  try {
    const headB = await prepareReviewedTask(setup);
    const result = await createTaskCommitTool(toolDeps(setup))(controllerInput({
      expectedHead: headB,
      commitSha: headB,
      planHash: setup.planHash,
      reviewHash: REVIEW_HASH,
      round: 1,
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(headB, setup.baseSha);
    assert.equal(git(setup.fixture.dir, ["rev-parse", "HEAD"]).stdout.trim(), setup.baseSha);
  } finally {
    cleanupFixture(setup.fixture);
  }
});

test("task commit still rejects missing trailers and the wrong feature HEAD", async () => {
  const missingSetup = await setupFixture();
  try {
    const headB = await prepareReviewedTask(missingSetup, { trailers: false });
    const missing = await createTaskCommitTool(toolDeps(missingSetup))(controllerInput({
      expectedHead: headB,
      commitSha: headB,
      planHash: missingSetup.planHash,
      reviewHash: REVIEW_HASH,
      round: 1,
    }));
    assert.equal(missing.ok, false);
    assert.equal(missing.retryable, false);
    assert.match(missing.message, /missing trailer/);
  } finally {
    cleanupFixture(missingSetup.fixture);
  }

  const driftSetup = await setupFixture();
  try {
    const headB = await prepareReviewedTask(driftSetup);
    assert.notEqual(headB, driftSetup.baseSha);
    const drift = await createTaskCommitTool(toolDeps(driftSetup))(controllerInput({
      expectedHead: driftSetup.baseSha,
      commitSha: driftSetup.baseSha,
      planHash: driftSetup.planHash,
      reviewHash: REVIEW_HASH,
      round: 1,
    }));
    assert.equal(drift.ok, false);
    assert.equal(drift.retryable, false);
    assert.match(drift.message, /HEAD drift/);
  } finally {
    cleanupFixture(driftSetup.fixture);
  }
});

async function prepareCommittedTask(setup) {
  const headB = await prepareReviewedTask(setup);
  const committed = await createTaskCommitTool(toolDeps(setup))(controllerInput({
    expectedHead: headB,
    commitSha: headB,
    planHash: setup.planHash,
    reviewHash: REVIEW_HASH,
    round: 1,
  }));
  assert.equal(committed.ok, true, JSON.stringify(committed));
  await publishApproval(setup.fixture.dir, {
    workflowId: WORKFLOW_ID,
    revision: 1,
    decision: "approved",
    sessionID: CONTROLLER_SESSION,
    approvedBy: "test",
    approvedAt: "2026-09-02T00:00:00.000Z",
    chunkIds: [],
    chunkHashes: [],
    baseSha: setup.baseSha,
    models: MODELS,
    sha256: setup.planHash,
  });
  const { receipt } = await publishGateReceipt(setup.fixture.dir, DELIVERY_TASK_ID, "verification", {
    headSha: headB,
    commandId: "canonical",
    argv: ["node", "--test"],
    exitCode: 0,
    stdoutSha256: "e".repeat(64),
    stderrSha256: "f".repeat(64),
  });
  setup.manifest = {
    ...setup.manifest,
    lastVerifierSha: headB,
    lastVerificationHash: receipt.receiptHash,
  };
  await writeManifest(setup.fixture.dir, setup.manifest);
  return headB;
}

function passingDriver(headSha) {
  return {
    refreshHead: async () => headSha,
    readChecks: async () => [{ name: "delivery-verify", state: "success", bucket: "pass" }],
  };
}

test("task complete builds and dispatches final review at feature SHA B despite primary HEAD drift", async () => {
  const setup = await setupFixture();
  try {
    const headB = await prepareCommittedTask(setup);
    await writeFile(join(setup.fixture.dir, "base-drift.txt"), "primary drift\n");
    assert.equal(git(setup.fixture.dir, ["add", "base-drift.txt"]).status, 0);
    assert.equal(git(setup.fixture.dir, ["commit", "-m", "test: drift primary"]).status, 0);
    const primaryHead = git(setup.fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(primaryHead, setup.baseSha);
    assert.notEqual(primaryHead, headB);

    const sdk = fakeClient();
    const result = await createTaskCompleteTool({
      ...toolDeps(setup, sdk.client),
      driver: passingDriver(headB),
    })(controllerInput({ moreTasks: false, expectedHead: headB }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.finalReview.headSha, headB);
    assert.equal(result.data.finalReview.mergeBaseSha, setup.baseSha);
    assert.equal(sdk.createCalls.length, 2);
    assert.ok(sdk.createCalls.every((call) => call.query.directory === setup.worktreePath));
    assert.ok(sdk.promptCalls.every((call) => call.query.directory === setup.worktreePath));
    const packagePath = join(
      setup.fixture.dir,
      ".git",
      "opencode-ship",
      "runs",
      WORKFLOW_ID,
      "final-review",
      "package.json",
    );
    const finalPackage = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(finalPackage.headSha, headB);
    assert.equal(finalPackage.mergeBaseSha, setup.baseSha);
  } finally {
    cleanupFixture(setup.fixture);
  }
});

test("task complete fails closed when feature HEAD drifts after verification", async () => {
  const setup = await setupFixture();
  try {
    const headB = await prepareCommittedTask(setup);
    await writeFile(join(setup.worktreePath, "feature-drift.txt"), "feature drift\n");
    assert.equal(git(setup.worktreePath, ["add", "feature-drift.txt"]).status, 0);
    assert.equal(git(setup.worktreePath, ["commit", "-m", "test: drift feature"]).status, 0);
    const sdk = fakeClient();

    const result = await createTaskCompleteTool({
      ...toolDeps(setup, sdk.client),
      driver: passingDriver(headB),
    })(controllerInput({ moreTasks: false, expectedHead: headB }));

    assert.equal(result.ok, false);
    assert.match(result.message, /HEAD drift before final review/);
    assert.equal(sdk.createCalls.length, 0);
  } finally {
    cleanupFixture(setup.fixture);
  }
});
