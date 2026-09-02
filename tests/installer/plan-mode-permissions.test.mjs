/*
 * Unit tests for src/installer/plan-mode-permissions.js.
 *
 * The Plan Mode sub-agent has the broadest-deny-then-narrowest-allow
 * shape that opencode.js expects: deny every default permission
 * for the Plan agent except the narrowest allow on
 * `.git/opencode-ship/plans/**` and `docs/superpowers/**`. Tests
 * assert the merge shape (deny-wins, allow is a narrow exception)
 * and the consumer can read this back from the rendered config.
 *
 * `promotePlanEditIfString` is the collaborator that reconciles
 * the consumer's previous `agent.plan.permission.edit` value
 * (which may be a scalar string) with the new object shape that
 * carries the upgrade's installed globs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  planModePermissions,
  renderPlanModeBlock,
  PLAN_PATH_PREFIX,
  PLAN_EDIT_GLOB,
  PLAN_EDIT_PLANS_GLOB,
  PLAN_EDIT_GLOB_POINTER,
  PLAN_EDIT_PLANS_GLOB_POINTER,
  PLAN_EDIT_PARENT_POINTER,
  promotePlanEditIfString,
} from "../../src/installer/plan-mode-permissions.js";

const PLANS_GLOB = `${PLAN_PATH_PREFIX}/**`;

test("planModePermissions: returns a deny-first shape", () => {
  const perms = planModePermissions();
  const block = perms.build;
  assert.equal(block.bash, "deny");
  assert.equal(block.webfetch, "deny");
  assert.equal(block.task, "deny");
  for (const tool of [
    "delivery_inspect",
    "delivery_issue",
    "delivery_worktree",
    "delivery_verify",
    "delivery_review",
    "delivery_pr",
    "delivery_ready",
    "delivery_merge",
    "delivery_cleanup",
    "ship_inspect",
    "ship_issue",
    "ship_worktree",
    "ship_verify",
    "ship_review",
    "ship_pr",
    "ship_ready",
    "ship_merge",
    "ship_cleanup",
  ]) {
    assert.equal(block[tool], "deny", `${tool} must be denied in Plan Mode`);
  }
  assert.equal(block.edit["*"], "deny", "all edit paths must be denied by default");
  assert.equal(block.edit[PLANS_GLOB], "allow", "plans path must be the only internal edit allow");
  assert.equal(block.edit[PLAN_EDIT_GLOB], "allow", "docs/superpowers/** must be allowed for Plan mode");
});

test("planModePermissions: places the deny block before the allow so the allow is a real exception", () => {
  const block = planModePermissions().build;
  const keys = Object.keys(block);
  const denyIdx = keys.indexOf("bash");
  const allowIdx = keys.findIndex((k) => k === "edit");
  assert.ok(denyIdx >= 0);
  assert.ok(allowIdx > denyIdx, "edit permission block must appear after the broad deny");
});

test("PLAN_PATH_PREFIX: matches the docs plan in the approved plan", () => {
  assert.equal(PLAN_PATH_PREFIX, ".git/opencode-ship/plans");
});

test("pointer constants: encode the glob paths in RFC 6901 form", () => {
  assert.equal(PLAN_EDIT_GLOB, "docs/superpowers/**");
  assert.equal(PLAN_EDIT_PLANS_GLOB, ".git/opencode-ship/plans/**");
  assert.equal(PLAN_EDIT_GLOB_POINTER, "/agent/plan/permission/edit/docs~1superpowers~1**");
  assert.equal(PLAN_EDIT_PLANS_GLOB_POINTER, "/agent/plan/permission/edit/.git~1opencode-ship~1plans~1**");
  assert.equal(PLAN_EDIT_PARENT_POINTER, "/agent/plan/permission/edit");
});

test("renderPlanModeBlock: returns a single key-value block ready for the consumer opencode.json", () => {
  const json = renderPlanModeBlock();
  const parsed = JSON.parse(json);
  assert.equal(parsed.bash, "deny");
  assert.equal(parsed.edit["*"], "deny");
  assert.equal(parsed.edit[PLANS_GLOB], "allow");
  assert.equal(parsed.edit[PLAN_EDIT_GLOB], "allow");
});

test("promotePlanEditIfString: undefined edit returns the doc unchanged with no record", () => {
  const before = {};
  const { doc, record } = promotePlanEditIfString(before);
  assert.equal(doc, before, "no edit => no copy");
  assert.equal(record, null);
});

test("promotePlanEditIfString: scalar edit is promoted to { '*': scalar } with a record", () => {
  const before = { agent: { plan: { permission: { edit: "deny" } } } };
  const { doc, record } = promotePlanEditIfString(before);
  assert.notEqual(doc, before, "scalar must produce a new object");
  assert.equal(doc.agent.plan.permission.edit["*"], "deny");
  assert.equal(record.pointer, PLAN_EDIT_PARENT_POINTER);
  assert.deepEqual(record.previous, { existed: true, value: "deny" });
  assert.equal(record.promotion, true);
});

test("promotePlanEditIfString: scalar edit accepts allow / ask", () => {
  for (const scalar of ["allow", "ask", "deny"]) {
    const before = { agent: { plan: { permission: { edit: scalar } } } };
    const { doc, record } = promotePlanEditIfString(before);
    assert.equal(doc.agent.plan.permission.edit["*"], scalar, `scalar ${scalar} must round-trip`);
    assert.equal(record.previous.value, scalar);
  }
});

test("promotePlanEditIfString: object edit is left untouched with no record", () => {
  const before = { agent: { plan: { permission: { edit: { "docs/plans/**": "allow" } } } } };
  const { doc, record } = promotePlanEditIfString(before);
  assert.equal(doc, before, "object edit must not be cloned when it has no glob denial");
  assert.equal(record, null);
});

test("promotePlanEditIfString: object edit that explicitly denies the glob flags a conflict", () => {
  const before = { agent: { plan: { permission: { edit: { [PLAN_EDIT_GLOB]: "deny" } } } } };
  const { doc, record } = promotePlanEditIfString(before);
  assert.equal(doc, before, "conflict path must not mutate the doc");
  assert.equal(record.conflict, true);
  assert.equal(record.pointer, PLAN_EDIT_GLOB_POINTER);
});

test("promotePlanEditIfString: object edit that allowlists the glob is fine", () => {
  const before = { agent: { plan: { permission: { edit: { [PLAN_EDIT_GLOB]: "allow" } } } } };
  const { doc, record } = promotePlanEditIfString(before);
  assert.equal(doc, before);
  assert.equal(record, null);
});

test("promotePlanEditIfString: nested agents outside plan are preserved", () => {
  const before = {
    agent: {
      build: { permission: { delivery_inspect: "allow" } },
      plan: { permission: { edit: "deny" } },
    },
  };
  const { doc } = promotePlanEditIfString(before);
  assert.equal(doc.agent.build.permission.delivery_inspect, "allow");
  assert.equal(doc.agent.plan.permission.edit["*"], "deny");
});
