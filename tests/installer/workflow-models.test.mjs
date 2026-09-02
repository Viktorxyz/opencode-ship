import test from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkflowModelDefaults,
  resolveWorkflowModels,
} from "../../src/installer/workflow-models.js";

const CURRENT = {
  planner: "openai/gpt-5.6-sol",
  builder: "minimax-coding-plan/MiniMax-M3",
  finalReviewer: "openai/gpt-5.6-sol",
};

test("loadWorkflowModelDefaults: current triple matches v1 spec", () => {
  const loaded = loadWorkflowModelDefaults();
  assert.deepEqual(loaded.current, CURRENT);
  assert.ok(Array.isArray(loaded.history));
});

test("resolve: empty config infers default and fills current", () => {
  const r = resolveWorkflowModels({
    configModels: {},
    lockModels: null,
    cliModels: null,
    current: CURRENT,
    history: [{ planner: "openai/gpt-5.6-sol", builder: "minimax/MiniMax-M3", finalReviewer: "openai/gpt-5.6-sol" }],
  });
  assert.deepEqual(r.models, CURRENT);
  assert.equal(r.provenance.planner.source, "default");
  assert.deepEqual(r.changedRoles.sort(), ["builder", "finalReviewer", "planner"]);
});

test("resolve: historical builder infers default and moves to current", () => {
  const r = resolveWorkflowModels({
    configModels: {
      planner: "openai/gpt-5.6-sol",
      builder: "minimax/MiniMax-M3",
      finalReviewer: "openai/gpt-5.6-sol",
    },
    lockModels: null,
    cliModels: null,
    current: CURRENT,
    history: [{ planner: "openai/gpt-5.6-sol", builder: "minimax/MiniMax-M3", finalReviewer: "openai/gpt-5.6-sol" }],
  });
  assert.equal(r.models.builder, CURRENT.builder);
  assert.equal(r.provenance.builder.source, "default");
  assert.deepEqual(r.changedRoles, ["builder"]);
});

test("resolve: unknown planner infers override and is never rewritten", () => {
  const r = resolveWorkflowModels({
    configModels: {
      planner: "openai/gpt-4.1",
      builder: "minimax-coding-plan/MiniMax-M3",
      finalReviewer: "openai/gpt-5.6-sol",
    },
    lockModels: null,
    cliModels: null,
    current: CURRENT,
    history: [],
  });
  assert.equal(r.models.planner, "openai/gpt-4.1");
  assert.equal(r.provenance.planner.source, "override");
  assert.ok(!r.changedRoles.includes("planner"));
});

test("resolve: lock override stays even when it equals a later package default", () => {
  const r = resolveWorkflowModels({
    configModels: {
      planner: CURRENT.planner,
      builder: CURRENT.builder,
      finalReviewer: CURRENT.finalReviewer,
    },
    lockModels: {
      planner: { source: "override", applied: CURRENT.planner },
      builder: { source: "default", applied: CURRENT.builder },
      finalReviewer: { source: "default", applied: CURRENT.finalReviewer },
    },
    cliModels: null,
    current: CURRENT,
    history: [],
  });
  assert.equal(r.provenance.planner.source, "override");
  assert.equal(r.models.planner, CURRENT.planner);
});

test("resolve: CLI flag sets that role to override only", () => {
  const r = resolveWorkflowModels({
    configModels: CURRENT,
    lockModels: {
      planner: { source: "default", applied: CURRENT.planner },
      builder: { source: "default", applied: CURRENT.builder },
      finalReviewer: { source: "default", applied: CURRENT.finalReviewer },
    },
    cliModels: { planner: "anthropic/claude-sonnet-4" },
    current: CURRENT,
    history: [],
  });
  assert.equal(r.models.planner, "anthropic/claude-sonnet-4");
  assert.equal(r.provenance.planner.source, "override");
  assert.equal(r.provenance.builder.source, "default");
  assert.deepEqual(r.changedRoles, ["planner"]);
});
