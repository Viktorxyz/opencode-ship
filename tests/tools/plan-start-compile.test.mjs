/**
 * ship_plan_start must not pay for GPT twice on an approved
 * markdown plan.
 *
 * When the issue body contains an approved plan path
 * (`.opencode/plans/<file>.md`), the planner child is dispatched
 * on `models.builder` (cheap MiniMax) with a compile prompt that
 * reads the markdown bytes and produces a PlanV2 mirroring the
 * markdown tasks. The cheap model must not redesign the product.
 *
 * When the issue body has no approved plan path, the planner is
 * dispatched on `models.planner` (strong GPT) and the prompt is
 * the legacy "Plan issue #N" path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlanStartTool } from "../../src/tools/ship-plan-start.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-plan-start-compile-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(join(root, ".opencode", "ship.lock.json"), JSON.stringify({
    manager: { setupComplete: true },
  }));
  writeFileSync(join(root, "README.md"), "# x\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return root;
}

function fakeDispatchWorkerRecorder() {
  const calls = [];
  return {
    dispatchWorker: async (input) => {
      calls.push({
        agent: input.agent,
        model: input.model,
        promptText: input.payload?.promptText ?? "",
      });
      return { sessionID: "planner-session", dispatchKey: `planner:1` };
    },
    calls,
  };
}

const MODELS = {
  planner: "openai/gpt-5.6-sol",
  builder: "minimax-coding-plan/MiniMax-M3",
  finalReviewer: "openai/gpt-5.6-sol",
};

test("plan-start: approved markdown is compiled on the cheap builder model", async () => {
  const fixture = makeRepo();
  try {
    const planPath = ".opencode/plans/2026-09-02-guide-cheap-skills.md";
    mkdirSync(join(fixture, ".opencode", "plans"), { recursive: true });
    writeFileSync(join(fixture, planPath), "# approved plan\n", "utf8");
    const recorder = fakeDispatchWorkerRecorder();
    const issueBody = `Approved plan lives at ${planPath}. Implement it.`;
    const tool = createPlanStartTool({
      repoRoot: fixture,
      repoSlug: "owner/repo",
      ctx: { sessionID: "ctrl", agent: "ship-controller" },
      config: { workflow: { models: MODELS } },
      syncSkills: async () => ({ installed: [], skippedUntrusted: [], registryUnavailable: false, errors: [] }),
      dispatchWorker: recorder.dispatchWorker,
      readIssue: async () => ({ title: "ship it", body: issueBody }),
      opencodeClient: { session: { create: async () => ({ data: { id: "x" } }), promptAsync: async () => ({ data: undefined }) } },
    });
    const r = await tool({ issueNumber: 7 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(recorder.calls.length, 1);
    const call = recorder.calls[0];
    assert.equal(call.agent, "ship-planner");
    assert.equal(call.model, MODELS.builder, "compile prompt must use the cheap builder model");
    assert.match(call.promptText, /Compile PlanV2 from the approved markdown/);
    assert.match(call.promptText, new RegExp(planPath.replace(/[/.]/g, "\\$&")));
    assert.doesNotMatch(call.promptText, /^Plan issue #7$/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("plan-start: no approved markdown keeps today's strong planner path", async () => {
  const fixture = makeRepo();
  try {
    const recorder = fakeDispatchWorkerRecorder();
    const tool = createPlanStartTool({
      repoRoot: fixture,
      repoSlug: "owner/repo",
      ctx: { sessionID: "ctrl", agent: "ship-controller" },
      config: { workflow: { models: MODELS } },
      syncSkills: async () => ({ installed: [], skippedUntrusted: [], registryUnavailable: false, errors: [] }),
      dispatchWorker: recorder.dispatchWorker,
      readIssue: async () => ({ title: "ship it", body: "No markdown attached." }),
      opencodeClient: { session: { create: async () => ({ data: { id: "x" } }), promptAsync: async () => ({ data: undefined }) } },
    });
    const r = await tool({ issueNumber: 8 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(recorder.calls.length, 1);
    const call = recorder.calls[0];
    assert.equal(call.agent, "ship-planner");
    assert.equal(call.model, MODELS.planner, "issue-only path keeps the strong planner");
    assert.match(call.promptText, /Plan issue #8/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("plan-start: missing markdown file on disk falls back to the strong planner", async () => {
  const fixture = makeRepo();
  try {
    const recorder = fakeDispatchWorkerRecorder();
    const tool = createPlanStartTool({
      repoRoot: fixture,
      repoSlug: "owner/repo",
      ctx: { sessionID: "ctrl", agent: "ship-controller" },
      config: { workflow: { models: MODELS } },
      syncSkills: async () => ({ installed: [], skippedUntrusted: [], registryUnavailable: false, errors: [] }),
      dispatchWorker: recorder.dispatchWorker,
      readIssue: async () => ({ title: "ship it", body: "Plan at .opencode/plans/missing.md but the file does not exist" }),
      opencodeClient: { session: { create: async () => ({ data: { id: "x" } }), promptAsync: async () => ({ data: undefined }) } },
    });
    const r = await tool({ issueNumber: 9 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(recorder.calls.length, 1);
    const call = recorder.calls[0];
    assert.equal(call.model, MODELS.planner, "missing plan file must fall back to strong planner");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
