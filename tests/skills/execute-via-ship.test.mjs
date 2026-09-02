import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("executing-plans hands work to ship_deliver and never commits", () => {
  const exec = readFileSync("assets/skills/executing-plans/SKILL.md", "utf8");
  assert.match(exec, /ship_deliver/);
  assert.match(exec, /Never commit/);
  assert.doesNotMatch(exec, /### Step 2: Execute Tasks/);
  assert.doesNotMatch(exec, /Follow each step exactly/);
});

test("subagent-driven-development redirects ship consumers to ship_deliver", () => {
  const sdd = readFileSync("assets/skills/subagent-driven-development/SKILL.md", "utf8");
  assert.match(sdd, /opencode-ship\.js/);
  assert.match(sdd, /ship_deliver/);
});
