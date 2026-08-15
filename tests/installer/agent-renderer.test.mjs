/*
 * tests/installer/agent-renderer.test.mjs
 *
 * Agent renderer tests: shipped agent templates do not carry hardcoded
 * model ids; the installer fills them in from `workflow.models`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  renderAgentFrontmatter,
  AGENT_ROLE_MAP,
  renderedModelFor,
  computeRenderedAgents,
  buildRenderedOverride,
  modelMarker,
} from "../../src/installer/agent-renderer.js";
import { CATALOG } from "../../src/installer/catalog.js";

test("renderAgentFrontmatter: replaces <model-from-config> placeholder", () => {
  const out = renderAgentFrontmatter("model: <model-from-config>\nname: foo", "openai/gpt-5.6-sol");
  assert.equal(out, "model: openai/gpt-5.6-sol\nname: foo");
});

test("renderAgentFrontmatter: leaves source untouched when no placeholder", () => {
  const src = "model: keep\nname: foo";
  const out = renderAgentFrontmatter(src, "openai/gpt-5.6-sol");
  assert.equal(out, src);
});

test("AGENT_ROLE_MAP: fixed mapping per plan", () => {
  assert.deepEqual([...AGENT_ROLE_MAP.planner], ["ship-planner"]);
  assert.ok(AGENT_ROLE_MAP.builder.includes("ship-controller"));
  assert.ok(AGENT_ROLE_MAP.builder.includes("ship-task-builder"));
  assert.ok(AGENT_ROLE_MAP.builder.includes("ship-task-reviewer"));
  assert.ok(AGENT_ROLE_MAP.finalReviewer.includes("ship-final-standards-reviewer"));
  assert.ok(AGENT_ROLE_MAP.finalReviewer.includes("ship-final-spec-reviewer"));
});

test("renderedModelFor: returns the configured model for each role", () => {
  const models = {
    planner: "openai/gpt-5.6-sol",
    builder: "minimax/MiniMax-M3",
    finalReviewer: "openai/gpt-5.6-sol",
  };
  assert.equal(renderedModelFor({ agentName: "ship-planner", models }), "openai/gpt-5.6-sol");
  assert.equal(renderedModelFor({ agentName: "ship-controller", models }), "minimax/MiniMax-M3");
  assert.equal(renderedModelFor({ agentName: "ship-task-builder", models }), "minimax/MiniMax-M3");
  assert.equal(renderedModelFor({ agentName: "ship-task-reviewer", models }), "minimax/MiniMax-M3");
  assert.equal(renderedModelFor({ agentName: "ship-final-standards-reviewer", models }), "openai/gpt-5.6-sol");
  assert.equal(renderedModelFor({ agentName: "ship-final-spec-reviewer", models }), "openai/gpt-5.6-sol");
});

test("renderedModelFor: returns the placeholder when role is missing", () => {
  assert.equal(renderedModelFor({ agentName: "ship-planner", models: {} }), modelMarker());
});

test("computeRenderedAgents: every workflow agent has no hardcoded model id in the source", () => {
  const agentNames = Object.values(AGENT_ROLE_MAP).flat();
  for (const name of agentNames) {
    const entry = CATALOG.find((c) => c.kind === "agent" && c.path.endsWith(`/${name}.md`));
    assert.ok(entry, `catalog must contain ${name}.md`);
    const src = readFileSync(entry.source, "utf8");
    assert.ok(!/^model:\s*(openai|minimax)\//m.test(src),
      `shipped agent ${name}.md must not carry a hardcoded provider/model id`);
    assert.ok(/^model:\s*<model-from-config>/m.test(src),
      `shipped agent ${name}.md must carry the <model-from-config> placeholder`);
  }
});

test("computeRenderedAgents: returns rendered bytes + sha256 for each role with a model", async () => {
  const models = {
    planner: "openai/gpt-5.6-sol",
    builder: "minimax/MiniMax-M3",
    finalReviewer: "openai/gpt-5.6-sol",
  };
  const out = await computeRenderedAgents({ models, catalog: CATALOG });
  assert.equal(out.length, Object.values(AGENT_ROLE_MAP).flat().length);
  for (const entry of out) {
    const text = entry.bytes.toString("utf8");
    assert.ok(text.includes(models[entry.role]),
      `rendered ${entry.relPath} must carry the configured ${entry.role} model`);
    assert.equal(entry.sha256.length, 64);
  }
});

test("buildRenderedOverride: produces a Map keyed by relPath", async () => {
  const models = {
    planner: "openai/gpt-5.6-sol",
    builder: "minimax/MiniMax-M3",
    finalReviewer: "openai/gpt-5.6-sol",
  };
  const override = await buildRenderedOverride({ models, catalog: CATALOG });
  assert.ok(override.map.size > 0);
  for (const [relPath, entry] of override.map.entries()) {
    assert.equal(relPath, entry.relPath);
    assert.ok(entry.bytes.length > 0);
  }
});

test("computeRenderedAgents: partial models only renders configured roles", async () => {
  const models = { builder: "minimax/MiniMax-M3" };
  const out = await computeRenderedAgents({ models, catalog: CATALOG });
  const rels = out.map((e) => e.relPath);
  assert.ok(rels.some((r) => r.endsWith("/ship-controller.md")));
  assert.ok(rels.some((r) => r.endsWith("/ship-task-builder.md")));
  assert.ok(rels.some((r) => r.endsWith("/ship-task-reviewer.md")));
  assert.ok(!rels.some((r) => r.endsWith("/ship-planner.md")));
  assert.ok(!rels.some((r) => r.endsWith("/ship-final-standards-reviewer.md")));
});

void mkdtempSync;
void join;
void tmpdir;
void writeFileSync;
void existsSync;
void resolve;
void rmSync;
