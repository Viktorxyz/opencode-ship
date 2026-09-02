/**
 * Packed public-tool-only two-task workflow qualification.
 *
 * This test is the rc.3 contract: the packed `dist/plugin.js`
 * must drive a two-task workflow end-to-end through the public
 * tool surface alone. No imports from `src/workflow/**` or
 * `src/state/**`. The plugin is the runtime; the test is the
 * harness.
 *
 * The journey:
 *
 *   1. Engineering init in a fresh consumer repo.
 *   2. ship_plan_start (controller dispatch).
 *   3. ship_plan_submit + ship_plan_approve (planner + controller).
 *   4. ship_run_start (controller).
 *   5. ship_task_start / report / review / commit / complete
 *      for Task A (passes cleanly).
 *   6. ship_task_start / report / review / commit / complete
 *      for Task B with one blocking task-review finding that
 *      drives a fix round, then a second pass.
 *   7. ship_final_review for both Standards and Spec axes.
 *   8. delivery_verify records immutable evidence and
 *      delivery_ready consumes immutable review + CI receipts.
 *   9. ship_status reflects Ready with both reviews on
 *      the same package hash, HEAD, and merge-base.
 *
 * The test does NOT execute `delivery_merge`; Ready + the
 * final-review gate alone prove the controller wiring. The
 * merge step is exercised through a real OpenCode restart in
 * the formal dogfood (Gate 3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tar } from "./_test-tar.mjs";

const PKG_ROOT = process.cwd();
const CONTROLLER_SESSION = "ctrl-1";
const PLANNER_SESSION = "plan-1";
const BUILDER_A = "builder-a-1";
const REVIEWER_A = "reviewer-a-1";
const BUILDER_B = "builder-b-1";
const BUILDER_B_RETRY = "builder-b-2";
const REVIEWER_B = "reviewer-b-1";
const REVIEWER_B_RETRY = "reviewer-b-2";
const FINAL_STANDARDS = "final-standards-1";
const FINAL_SPEC = "final-spec-1";

async function packAndExtract() {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-qual-"));
  let tarballPath = process.env.OPENCODE_SHIP_TARBALL;
  if (!tarballPath) {
    const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
      cwd: PKG_ROOT, encoding: "utf8",
    });
    assert.equal(pack.status, 0, pack.stderr);
    const meta = JSON.parse(pack.stdout);
    tarballPath = join(tmp, meta[0].filename);
  }
  assert.ok(existsSync(tarballPath), `tarball must exist: ${tarballPath}`);
  const consumer = join(tmp, "consumer");
  await mkdir(consumer, { recursive: true });
  await tar.extract(tarballPath, consumer);
  return { tmp, consumer, packageDir: join(consumer, "package"), tarballPath };
}

async function makeBareOrigin() {
  const dir = await mkdtemp(join(tmpdir(), "ocd-bare-"));
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main"], { cwd: dir, encoding: "utf8" });
  return dir;
}

async function makeConsumerRepo(origin) {
  const dir = await mkdtemp(join(tmpdir(), "ocd-consumer-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@local" };
  spawnSync("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }, null, 2));
  await writeFile(join(dir, "README.md"), "# consumer\n");
  spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-m", "init"], { env, encoding: "utf8" });
  spawnSync("git", ["-C", dir, "remote", "add", "origin", origin], { encoding: "utf8" });
  return dir;
}

async function runCli(packageDir, cwd, args, env = {}) {
  const cli = join(packageDir, "dist", "cli.js");
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function loadPlugin(packageDir) {
  // The packed plugin is ESM; import the entry directly.
  const pluginUrl = new URL(`file://${join(packageDir, "dist/plugin.js")}`);
  const mod = await import(pluginUrl.href);
  return mod.default || mod;
}

test("packed: two-task workflow through public tool surface only", async (t) => {
  const { tmp, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  // 1. Engineering init. We pass model flags so the engineering
  //    profile completes without prompting for setup.
  const init = await runCli(packageDir, repo, [
    "init", "--json", "--profile", "engineering", "--root", repo,
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config", "--force-root-config",
  ]);
  assert.equal(init.status, 0, init.stderr || init.stdout);

  // 1a. Mark setup complete so the controller refuses to dispatch
  //     until the chat-only setup workflow has run. The packed
  //     two-task qualification exercises the controller contract;
  //     the explicit setup gate is exercised in the formal
  //     registry dogfood (Gate 3). We seed the minimum setup
  //     artifacts the gate requires.
  await mkdir(join(repo, "docs/agents"), { recursive: true });
  await writeFile(join(repo, "docs/agents/issue-tracker.md"), "# issue tracker\n");
  await writeFile(join(repo, "docs/agents/domain.md"), "# domain\n");
  await writeFile(join(repo, "docs/agents/triage-labels.md"), "# triage\n");
  await writeFile(join(repo, "AGENTS.md"), "## Ship workflow\n");
  const setup = await runCli(packageDir, repo, [
    "setup-complete", "--json", "--root", repo,
  ]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const shipConfigPath = join(repo, ".opencode", "ship.config.json");
  const shipConfig = JSON.parse(await readFile(shipConfigPath, "utf8"));
  shipConfig.delivery.verification.commands = [{ id: "canonical", argv: [process.execPath, "-e", "process.exit(0)"] }];
  shipConfig.delivery.verification.requireCleanDiffAfter = false;
  await writeFile(shipConfigPath, JSON.stringify(shipConfig, null, 2) + "\n");
  const featureRepo = join(repo, ".worktrees", "feature-rc3");
  const worktree = spawnSync("git", ["-C", repo, "worktree", "add", "-b", "feature/rc3", featureRepo], { encoding: "utf8" });
  assert.equal(worktree.status, 0, worktree.stderr);
  const manifestDir = join(repo, ".git", "opencode-ship", "delivery", "manifests");
  await mkdir(manifestDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(manifestDir, "delivery-1.json"), JSON.stringify({
    schemaVersion: 2,
    taskId: "delivery-1",
    repoIdentity: "owner/repo",
    issueNumber: 1,
    prNumber: 7,
    baseBranch: "main",
    baseSha: spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    branch: "feature/rc3",
    worktreePath: featureRepo,
    lastPrHeadSha: null,
    lastReviewerSha: null,
    lastVerifierSha: null,
    lastVerificationHash: null,
    workflowId: null,
    owner: "test",
    state: "draft-open",
    transitionLog: [],
    createdAt: now,
    updatedAt: now,
  }, null, 2));

  // 2. Load the packed plugin and build a real ToolContext the
  //    plugin can authorize against. The plugin is called with a
  //    fake OpenCode client whose `session.create` and
  //    `session.promptAsync` return deterministic session IDs so
  //    the planner / builder / reviewer / final-reviewer
  //    dispatches produce real dispatch records.
  let taskBBuilderDispatches = 0;
  let taskAReviewerDispatches = 0;
  const promptCalls = [];
  const fakeClient = {
    session: {
      create: async ({ body: { parentID, title } }) => {
        let id = null;
        if (title === "ship-planner-wf-1") id = PLANNER_SESSION;
        else if (title === "ship-task-builder-wf-1-a") id = BUILDER_A;
        else if (title === "ship-task-builder-wf-1-b") {
          taskBBuilderDispatches += 1;
          id = taskBBuilderDispatches === 1 ? BUILDER_B : BUILDER_B_RETRY;
        } else if (title === "ship-task-reviewer-wf-1-a-1") {
          taskAReviewerDispatches += 1;
          if (taskAReviewerDispatches === 1) {
            return { data: undefined, error: { message: "temporary reviewer create failure" } };
          }
          id = REVIEWER_A;
        }
        else if (title === "ship-task-reviewer-wf-1-b-1") id = REVIEWER_B;
        else if (title === "ship-task-reviewer-wf-1-b-2") id = REVIEWER_B_RETRY;
        else if (title === "ship-final-standards-wf-1") id = FINAL_STANDARDS;
        else if (title === "ship-final-spec-wf-1") id = FINAL_SPEC;
        return { data: { id, parentID, title }, error: undefined };
      },
      promptAsync: async (options) => {
        promptCalls.push(options);
        return { data: undefined, error: undefined };
      },
    },
  };
  let markedReady = false;
  const fakeDriver = {
    refreshHead: async () => spawnSync("git", ["-C", featureRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    readChecks: async () => [{ name: "delivery-verify", state: "success", bucket: "pass" }],
    markReady: async () => { markedReady = true; },
  };
  const plugin = await loadPlugin(packageDir);
  const result = await plugin({
    worktree: repo,
    project: {},
    client: fakeClient,
    driver: fakeDriver,
    directory: repo,
  });
  assert.ok(result?.tool, "packed plugin must expose the 34-tool surface");
  const toolIds = Object.keys(result.tool).sort();
  for (const required of [
    "ship_plan_start", "ship_plan_submit", "ship_plan_approve", "ship_run_start",
    "ship_task_start", "ship_task_report", "ship_task_review", "ship_task_commit", "ship_task_complete",
    "ship_final_review", "ship_resume", "ship_status", "delivery_ready",
  ]) {
    assert.ok(toolIds.includes(required), `packed plugin missing ${required}`);
  }

  const call = async (id, args, ctx) => {
    const text = await result.tool[id].execute(args, ctx);
    return JSON.parse(text);
  };

  const controllerCtx = { sessionID: CONTROLLER_SESSION, agent: "ship-controller" };

  // 3. ship_plan_start — controller leases and dispatches planner.
  const planStart = await call("ship_plan_start", {
    issueNumber: 1,
    operationId: "plan-start-1",
  }, controllerCtx);
  assert.equal(planStart.ok, true, JSON.stringify(planStart));
  assert.equal(planStart.data.plannerSessionID, PLANNER_SESSION);

  const plannerCtx = { sessionID: PLANNER_SESSION, agent: "ship-planner" };

  // 4. ship_plan_submit + ship_plan_approve.
  const baseSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const planJson = {
    schemaVersion: 2,
    workflowId: "wf-1",
    revision: 1,
    supersedes: null,
    authoredBy: { sessionID: PLANNER_SESSION, model: "fake/strong-planner", createdAt: new Date().toISOString() },
    source: { repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", baseBranch: "main", baseSha },
    goal: "Two-task journey",
    architecture: { summary: "stub", decisions: [] },
    constraints: [],
    files: [
      { path: "src/a.ts", action: "create", responsibility: "Task A", taskIds: ["a"] },
      { path: "src/b.ts", action: "create", responsibility: "Task B", taskIds: ["b"] },
    ],
    tasks: [
      { id: "a", ordinal: 1, title: "Task A", objective: "implement A", dependsOn: [],
        preconditions: [{ kind: "head-is", value: baseSha }],
        changes: [{ path: "src/a.ts", operation: "create", symbols: [], instructions: ["create"], preserve: ["license header"] }],
        interfaces: [], tests: [], commands: [], acceptance: [{ id: "a1", assertion: "file exists", evidence: ["fs.exists"] }],
        commit: { message: "feat: add a" } },
      { id: "b", ordinal: 2, title: "Task B", objective: "implement B", dependsOn: ["a"],
        preconditions: [{ kind: "file-exists", value: "src/a.ts" }],
        changes: [{ path: "src/b.ts", operation: "create", symbols: [], instructions: ["create"], preserve: ["license header"] }],
        interfaces: [], tests: [], commands: [], acceptance: [{ id: "b1", assertion: "file exists", evidence: ["fs.exists"] }],
        commit: { message: "feat: add b" } },
    ],
    finalAcceptance: [], outOfScope: [], recovery: [],
  };
  const planSubmit = await call("ship_plan_submit", {
    workflowId: "wf-1",
    revision: 1,
    plan: planJson,
    operationId: "plan-submit-1",
  }, plannerCtx);
  assert.equal(planSubmit.ok, true, JSON.stringify(planSubmit));
  const planHash = planSubmit.data.sha256;

  const planApprove = await call("ship_plan_approve", {
    workflowId: "wf-1",
    revision: 1,
    sha256: planHash,
    subject: "explicit user approval",
    models: { planner: "fake/strong-planner", builder: "fake/cheap-builder", finalReviewer: "fake/strong-reviewer" },
    operationId: "plan-approve-1",
  }, controllerCtx);
  assert.equal(planApprove.ok, true, JSON.stringify(planApprove));

  // 5. ship_run_start.
  const runStart = await call("ship_run_start", {
    workflowId: "wf-1",
    revision: 1,
    sha256: planHash,
    operationId: "run-start-1",
  }, controllerCtx);
  assert.equal(runStart.ok, true, JSON.stringify(runStart));

  // 6. Task A — passes cleanly.
  const taskAStart = await call("ship_task_start", {
    workflowId: "wf-1",
    taskId: "a",
    briefHash: "a".repeat(64),
    operationId: "task-a-start-1",
  }, controllerCtx);
  assert.equal(taskAStart.ok, true, JSON.stringify(taskAStart));
  assert.equal(taskAStart.data.builderSessionID, BUILDER_A);

  const builderACtx = { sessionID: BUILDER_A, agent: "ship-task-builder" };
  const taskAReportInput = {
    workflowId: "wf-1",
    taskId: "a",
    round: 1,
    summary: "Task A implemented",
    operationId: "task-a-report-1",
  };
  const failedReviewerDispatch = await call("ship_task_report", taskAReportInput, builderACtx);
  assert.equal(failedReviewerDispatch.ok, true, JSON.stringify(failedReviewerDispatch));
  assert.match(failedReviewerDispatch.data.reviewerDispatchError, /temporary reviewer create failure/);
  const taskAReport = await call("ship_task_report", {
    ...taskAReportInput,
    operationId: "task-a-report-retry-1",
  }, builderACtx);
  assert.equal(taskAReport.ok, true, JSON.stringify(taskAReport));
  assert.equal(taskAReport.data.reviewerSessionID, REVIEWER_A);
  const reviewerASessionId = taskAReport.data.reviewerSessionID;

  const reviewerACtx = { sessionID: reviewerASessionId, agent: "ship-task-reviewer" };
  const taskAReview = await call("ship_task_review", {
    workflowId: "wf-1",
    taskId: "a",
    round: 1,
    spec: { verdict: "pass" },
    quality: { verdict: "pass" },
    operationId: "task-a-review-1",
  }, reviewerACtx);
  assert.equal(taskAReview.ok, true, JSON.stringify(taskAReview));
  assert.equal(taskAReview.data.state, "commit-pending");
  const taskAReviewHash = taskAReview.data.reviewHash;
  assert.match(taskAReviewHash, /^[0-9a-f]{64}$/);

  // 7. ship_task_commit for Task A. We commit a file in the
  //    consumer repo so the tool's HEAD check succeeds.
  spawnSync("git", ["-C", repo, "config", "user.email", "t@local"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "t"]);
  await mkdir(join(featureRepo, "src"), { recursive: true });
  await writeFile(join(featureRepo, "src/a.ts"), "// a\n");
  const trailers = [
    `Opencode-Ship-Workflow: wf-1`,
    `Opencode-Ship-Plan: ${planHash}`,
    `Opencode-Ship-Task: a`,
    `Opencode-Ship-Review: ${taskAReviewHash}`,
    `Opencode-Ship-Round: 1`,
  ].join("\n");
  spawnSync("git", ["-C", featureRepo, "add", "src/a.ts"], { encoding: "utf8" });
  spawnSync("git", ["-C", featureRepo, "commit", "-m", "feat: add a", `-m`, trailers], { encoding: "utf8" });
  const headA = spawnSync("git", ["-C", featureRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const taskACommit = await call("ship_task_commit", {
    workflowId: "wf-1",
    taskId: "a",
    expectedHead: headA,
    commitSha: headA,
    planHash,
    reviewHash: taskAReviewHash,
    round: 1,
    operationId: "task-a-commit-1",
  }, controllerCtx);
  assert.equal(taskACommit.ok, true, JSON.stringify(taskACommit));

  const taskAComplete = await call("ship_task_complete", {
    workflowId: "wf-1",
    taskId: "a",
    moreTasks: true,
    nextTaskId: "b",
    operationId: "task-a-complete-1",
  }, controllerCtx);
  assert.equal(taskAComplete.ok, true, JSON.stringify(taskAComplete));

  // 8. Task B — first review fails, second passes.
  const taskBStart = await call("ship_task_start", {
    workflowId: "wf-1",
    taskId: "b",
    briefHash: "b".repeat(64),
    operationId: "task-b-start-1",
  }, controllerCtx);
  assert.equal(taskBStart.ok, true, JSON.stringify(taskBStart));

  const builderBCtx = { sessionID: BUILDER_B, agent: "ship-task-builder" };
  const taskBReport1 = await call("ship_task_report", {
    workflowId: "wf-1",
    taskId: "b",
    round: 1,
    summary: "Task B implementation attempt 1",
    operationId: "task-b-report-1",
  }, builderBCtx);
  assert.equal(taskBReport1.ok, true, JSON.stringify(taskBReport1));
  assert.equal(taskBReport1.data.reviewerSessionID, REVIEWER_B);
  const reviewerBSessionId = taskBReport1.data.reviewerSessionID;

  const reviewerBCtx = { sessionID: reviewerBSessionId, agent: "ship-task-reviewer" };
  const taskBReview1 = await call("ship_task_review", {
    workflowId: "wf-1",
    taskId: "b",
    round: 1,
    spec: { verdict: "fail", notes: "missing tests" },
    quality: { verdict: "fail", notes: "lint errors" },
    operationId: "task-b-review-1",
  }, reviewerBCtx);
  assert.equal(taskBReview1.ok, true, JSON.stringify(taskBReview1));
  assert.equal(taskBReview1.data.state, "fix-pending");

  // 8a. Re-dispatch Task B for the fix round.
  const taskBStart2 = await call("ship_task_start", {
    workflowId: "wf-1",
    taskId: "b",
    briefHash: "b".repeat(64),
    operationId: "task-b-start-2",
  }, controllerCtx);
  assert.equal(taskBStart2.ok, true, JSON.stringify(taskBStart2));

  const builderBCtxRetry = { sessionID: BUILDER_B_RETRY, agent: "ship-task-builder" };
  const taskBReport2 = await call("ship_task_report", {
    workflowId: "wf-1",
    taskId: "b",
    round: 2,
    summary: "Task B implementation attempt 2 (fix)",
    operationId: "task-b-report-2",
  }, builderBCtxRetry);
  assert.equal(taskBReport2.ok, true, JSON.stringify(taskBReport2));
  assert.equal(taskBReport2.data.reviewerSessionID, REVIEWER_B_RETRY);
  const reviewerBSessionIdRetry = taskBReport2.data.reviewerSessionID;

  const reviewerBCtxRetry = { sessionID: reviewerBSessionIdRetry, agent: "ship-task-reviewer" };
  const taskBReview2 = await call("ship_task_review", {
    workflowId: "wf-1",
    taskId: "b",
    round: 2,
    spec: { verdict: "pass" },
    quality: { verdict: "pass" },
    operationId: "task-b-review-2",
  }, reviewerBCtxRetry);
  assert.equal(taskBReview2.ok, true, JSON.stringify(taskBReview2));
  assert.equal(taskBReview2.data.state, "commit-pending");
  const taskBReviewHash = taskBReview2.data.reviewHash;
  assert.match(taskBReviewHash, /^[0-9a-f]{64}$/);

  // 8b. ship_task_commit for Task B. We touch src/b.ts and commit.
  await writeFile(join(featureRepo, "src/b.ts"), "// b\n");
  const trailersB = [
    `Opencode-Ship-Workflow: wf-1`,
    `Opencode-Ship-Plan: ${planHash}`,
    `Opencode-Ship-Task: b`,
    `Opencode-Ship-Review: ${taskBReviewHash}`,
    `Opencode-Ship-Round: 2`,
  ].join("\n");
  spawnSync("git", ["-C", featureRepo, "add", "src/b.ts"], { encoding: "utf8" });
  spawnSync("git", ["-C", featureRepo, "commit", "-m", "feat: add b", `-m`, trailersB], { encoding: "utf8" });
  const headB = spawnSync("git", ["-C", featureRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

  const taskBCommit = await call("ship_task_commit", {
    workflowId: "wf-1",
    taskId: "b",
    expectedHead: headB,
    commitSha: headB,
    planHash,
    reviewHash: taskBReviewHash,
    round: 2,
    operationId: "task-b-commit-1",
  }, controllerCtx);
  assert.equal(taskBCommit.ok, true, JSON.stringify(taskBCommit));

  const verification = await call("delivery_verify", {
    taskId: "delivery-1",
    operationId: "verify-final-head",
  }, { sessionID: "verifier-1", agent: "delivery-verifier" });
  assert.equal(verification.ok, true, JSON.stringify(verification));
  assert.equal(verification.data.headSha, headB);
  assert.match(verification.data.verificationHash, /^[0-9a-f]{64}$/);

  const taskBComplete = await call("ship_task_complete", {
    workflowId: "wf-1",
    taskId: "b",
    moreTasks: false,
    expectedHead: headB,
    operationId: "task-b-complete-1",
  }, controllerCtx);
  assert.equal(taskBComplete.ok, true, JSON.stringify(taskBComplete));
  assert.equal(taskBComplete.data.finalReview.standardsSessionID, FINAL_STANDARDS);
  assert.equal(taskBComplete.data.finalReview.specSessionID, FINAL_SPEC);
  assert.equal(taskBComplete.data.finalReview.headSha, headB);
  assert.equal(taskBComplete.data.finalReview.mergeBaseSha, baseSha);
  const packageHash = taskBComplete.data.finalReview.packageHash;
  assert.match(packageHash, /^[0-9a-f]{64}$/);

  // 9. ship_final_review for both axes on the same package hash.
  const finalStandardsCtx = { sessionID: FINAL_STANDARDS, agent: "ship-final-standards-reviewer" };
  const finalStandards = await call("ship_final_review", {
    workflowId: "wf-1",
    axis: "standards",
    verdict: "pass",
    headSha: headB,
    mergeBaseSha: baseSha,
    packageHash,
    operationId: "final-standards-1",
  }, finalStandardsCtx);
  assert.equal(finalStandards.ok, true, JSON.stringify(finalStandards));

  const finalSpecCtx = { sessionID: FINAL_SPEC, agent: "ship-final-spec-reviewer" };
  const finalSpec = await call("ship_final_review", {
    workflowId: "wf-1",
    axis: "spec",
    verdict: "pass",
    headSha: headB,
    mergeBaseSha: baseSha,
    packageHash,
    operationId: "final-spec-1",
  }, finalSpecCtx);
  assert.equal(finalSpec.ok, true, JSON.stringify(finalSpec));

  const ready = await call("delivery_ready", {
    taskId: "delivery-1",
    operationId: "ready-1",
  }, controllerCtx);
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(markedReady, true);

  // 10. ship_status reflects Ready with both axes.
  const status = await call("ship_status", {
    workflowId: "wf-1",
    operationId: "status-1",
  }, controllerCtx);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.data.run.state, "ready");
  assert.ok(status.data.run.finalReview?.standards);
  assert.ok(status.data.run.finalReview?.spec);
  assert.deepEqual(
    new Set(promptCalls.map((call) => call.body.agent)),
    new Set([
      "ship-planner",
      "ship-task-builder",
      "ship-task-reviewer",
      "ship-final-standards-reviewer",
      "ship-final-spec-reviewer",
    ]),
  );

  assert.ok(promptCalls.some((call) => JSON.stringify(call.body.parts).includes("Approved task brief")));
  assert.ok(promptCalls.some((call) => JSON.stringify(call.body.parts).includes("Implementer report")));
});
