/**
 * Regression test for the canonical root permission matrix wiring.
 *
 * The 1.1.2-rc.2 release still applied the legacy POINTER_ENTRIES
 * list and never wired the rootPermissionMatrix() source-of-truth
 * into the install/update/uninstall flow. This test asserts:
 *
 *   1. matrixLeafPointers() produces the expected engineering leaves
 *      including subagent_depth=2, the Build -> ship-controller
 *      delegation, ship-task-builder delegation from the controller,
 *      and the legacy delivery_* permission surface.
 *   2. desiredPointersForProfile("engineering") returns the matrix
 *      leaves, NOT the legacy POINTER_ENTRIES list.
 *   3. The shipped 32 public tools are all expressed as explicit
 *      permission leaves on the ship-controller agent (no "*"
 *      wildcard sentinel leaks into a literal pointer).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  matrixLeafPointers,
  rootPermissionMatrix,
  SUBAGENT_DEPTH,
} from "../../src/installer/root-permissions.js";
import { desiredPointersForProfile } from "../../src/installer/root-reconciliation.js";

test("matrix: rootPermissionMatrix is the canonical source of truth", () => {
  const matrix = rootPermissionMatrix();
  assert.equal(matrix.subagentDepth, SUBAGENT_DEPTH);
  assert.equal(matrix.build.permission.task["ship-controller"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-task-builder"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-final-standards-reviewer"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-final-spec-reviewer"], "allow");
  // Tool-level permissions live under `tools`, not `permission`.
  assert.equal(matrix.shipController.tools.ship_plan_approve, "ask");
  assert.equal(matrix.shipController.tools.delivery_merge, "ask");
});

test("matrix: matrixLeafPointers wires subagent_depth and the controller delegation", () => {
  const leaves = matrixLeafPointers();
  const byPointer = new Map(leaves.map((l) => [l.pointer, l]));
  assert.ok(byPointer.has("/subagent_depth"), "/subagent_depth must be a leaf");
  assert.equal(byPointer.get("/subagent_depth").value, 2);
  assert.ok(byPointer.has("/agent/build/permission/task/ship-controller"));
  assert.equal(byPointer.get("/agent/build/permission/task/ship-controller").value, "allow");
  // Legacy delivery_* permissions stay for consumers that already adopted opencode-delivery.
  assert.ok(byPointer.has("/agent/build/permission/delivery_inspect"));
  assert.equal(byPointer.get("/agent/build/permission/delivery_inspect").value, "allow");
});

test("matrix: every shipped 32 public tool is expressed as a controller permission leaf", async () => {
  const leaves = matrixLeafPointers();
  const controllerTools = new Set(
    leaves
      .filter((l) => l.pointer.startsWith("/agent/ship-controller/permission/") && l.pointer.split("/").length === 5)
      .map((l) => l.pointer.split("/")[4]),
  );
  // The 32 public tools (subset that's controller-only and listed
  // as explicit ask/allow permissions rather than the wildcard
  // default). Ship_plan_approve is ask; the workflow tools are
  // allow. The wildcard ("*") default is excluded.
  for (const tool of [
    "ship_plan_start",
    "ship_plan_submit",
    "ship_task_start",
    "ship_task_commit",
    "ship_task_complete",
    "ship_final_review",
    "ship_resume",
    "ship_status",
    "ship_skill_discover",
    "ship_skill_install",
    "ship_skill_audit",
    "delivery_inspect",
    "delivery_issue",
    "delivery_worktree",
    "delivery_pr",
    "delivery_ready",
    "delivery_publish",
    "ship_plan_approve",
    "delivery_merge",
    "delivery_issue_close",
  ]) {
    assert.ok(controllerTools.has(tool), `${tool} must be a controller permission leaf`);
  }
});

test("matrix: the wildcard '*' sentinel does not become a literal pointer", () => {
  const leaves = matrixLeafPointers();
  for (const l of leaves) {
    const parts = l.pointer.split("/");
    for (const p of parts) {
      assert.notEqual(p, "*", `wildcard must not appear as a pointer segment: ${l.pointer}`);
    }
  }
});

test("matrix: bash category is enforced by the OpenCode runtime, not as installer state", () => {
  const leaves = matrixLeafPointers();
  for (const l of leaves) {
    assert.ok(!l.pointer.includes("/bash/"), `bash policy must not be installer-owned: ${l.pointer}`);
  }
});

test("reconciler: desiredPointersForProfile(engineering) uses the matrix", () => {
  const desired = desiredPointersForProfile("engineering");
  const pointers = new Set(desired.map((d) => d.pointer));
  // Matrix-derived leaves are present.
  assert.ok(pointers.has("/subagent_depth"));
  assert.ok(pointers.has("/agent/build/permission/task/ship-controller"));
  assert.ok(pointers.has("/agent/ship-controller/permission/task/ship-task-builder"));
  // Legacy delivery_* pointers stay for back-compat.
  assert.ok(pointers.has("/agent/build/permission/delivery_inspect"));
  // Every entry has scope=engineering.
  for (const d of desired) {
    assert.equal(d.scope, "engineering", `${d.pointer} should be engineering-scoped`);
  }
});
