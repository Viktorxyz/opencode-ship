import test from "node:test";
import assert from "node:assert/strict";
import { createPlanSubmitTool } from "../../src/tools/ship-plan-submit.js";

test("ship_plan_submit refuses a plan whose embedded workflow identity differs", async () => {
  const tool = createPlanSubmitTool({ repoRoot: process.cwd() });
  const result = await tool({
    workflowId: "wf-a",
    revision: 1,
    plan: { workflowId: "wf-b", revision: 1 },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /plan identity/i);
});
