/*
 * Unit tests for src/installer/config.js.
 *
 * Verifies the default config emitted by 1.1.0+ is the engineering
 * profile with an empty workflow.models block (so the user fills
 * the model ids through the setup-ship-workflow skill). Also
 * verifies hasCompletedModels returns true only when all three
 * roles are populated with a valid <provider>/<model> id.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderDefaultConfig, hasCompletedModels } from "../../src/installer/config.js";

test("renderDefaultConfig: 1.1 emits engineering profile with empty workflow.models", () => {
  const cfg = renderDefaultConfig({});
  assert.equal(cfg.profile, "engineering");
  assert.ok(cfg.workflow);
  assert.ok(cfg.workflow.models);
  assert.deepEqual(cfg.workflow.models, {});
  assert.equal(cfg.workflow.approval.mirrorToIssue, true);
  assert.equal(cfg.workflow.approval.maxFailedRounds, 3);
});

test("renderDefaultConfig: respects detection overrides", () => {
  const cfg = renderDefaultConfig({
    packageManager: "pnpm",
    repository: "owner/foo",
    remote: "upstream",
    defaultBranch: "develop",
    worktreeRoot: ".trees",
  });
  assert.equal(cfg.project.packageManager, "pnpm");
  assert.equal(cfg.project.repository, "owner/foo");
  assert.equal(cfg.project.remote, "upstream");
  assert.equal(cfg.project.defaultBranch, "develop");
  assert.equal(cfg.delivery.worktree.root, ".trees");
});

test("hasCompletedModels: empty models returns false", () => {
  assert.equal(hasCompletedModels({}), false);
  assert.equal(hasCompletedModels({ workflow: {} }), false);
  assert.equal(hasCompletedModels({ workflow: { models: {} } }), false);
});

test("hasCompletedModels: partial models returns false", () => {
  assert.equal(
    hasCompletedModels({ workflow: { models: { planner: "openai/gpt-5.6-sol" } } }),
    false
  );
  assert.equal(
    hasCompletedModels({
      workflow: {
        models: {
          planner: "openai/gpt-5.6-sol",
          builder: "minimax/MiniMax-M3",
        },
      },
    }),
    false
  );
});

test("hasCompletedModels: invalid id returns false", () => {
  assert.equal(
    hasCompletedModels({
      workflow: {
        models: {
          planner: "gpt-5.6-sol",
          builder: "minimax/MiniMax-M3",
          finalReviewer: "openai/gpt-5.6-sol",
        },
      },
    }),
    false
  );
});

test("hasCompletedModels: all three ids return true", () => {
  assert.equal(
    hasCompletedModels({
      workflow: {
        models: {
          planner: "openai/gpt-5.6-sol",
          builder: "minimax/MiniMax-M3",
          finalReviewer: "openai/gpt-5.6-sol",
        },
      },
    }),
    true
  );
});
