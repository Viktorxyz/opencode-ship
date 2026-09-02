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
 *   3. The shipped 34 public tools are all expressed as explicit
 *      permission leaves on the ship-controller agent (no "*"
 *      wildcard sentinel leaks into a literal pointer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  matrixLeafPointers,
  rootPermissionMatrix,
  SUBAGENT_DEPTH,
} from "../../src/installer/root-permissions.js";
import { desiredPointersForProfile } from "../../src/installer/root-reconciliation.js";
import { EXPECTED_OPENCODE_SHIP_TOOL_IDS } from "../plugin/expected-tools.mjs";

test("matrix: rootPermissionMatrix is the canonical source of truth", () => {
  const matrix = rootPermissionMatrix();
  assert.equal(matrix.subagentDepth, SUBAGENT_DEPTH);
  assert.equal(matrix.build.permission.task["ship-controller"], "allow");
  assert.equal(matrix.build.permission.task["ship-reviewer"], "allow");
  assert.equal(matrix.build.permission.task["ship-verifier"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-task-builder"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-verifier"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-final-standards-reviewer"], "allow");
  assert.equal(matrix.shipController.permission.task["ship-final-spec-reviewer"], "allow");
  // Tool-level permissions live under `tools`, not `permission`.
  assert.equal(matrix.shipController.tools.ship_plan_approve, "ask");
  assert.equal(matrix.shipController.tools.delivery_merge, "ask");
  assert.equal(matrix.shipController.tools.ship_merge, "ask");
  assert.equal(matrix.build.tools.ship_deliver, "allow");
  assert.equal(matrix.shipController.tools.ship_deliver, "deny");
  assert.equal(matrix.build.tools.ship_plan_start, "deny");
  assert.equal(matrix.shipController.tools.ship_plan_start, "allow");
  assert.equal(matrix.build.tools.delivery_abandon, "ask");
  assert.equal(matrix.shipController.tools.delivery_abandon, "ask");
  assert.equal(matrix.build.tools.ship_abandon, "ask");
  assert.equal(matrix.shipController.tools.ship_abandon, "ask");
});

test("matrix: shipped controller asset denies recursive ship_deliver", () => {
  const source = readFileSync(resolve("assets/agents/ship-controller.md"), "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.match(frontmatter, /^\s{2}ship_deliver: deny$/m);
  assert.doesNotMatch(frontmatter, /^\s{2}ship_deliver: allow$/m);
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
  assert.ok(byPointer.has("/agent/build/permission/ship_inspect"));
  assert.equal(byPointer.get("/agent/build/permission/ship_inspect").value, "allow");
});

test("matrix: every shipped public tool has an explicit controller permission", () => {
  const tools = rootPermissionMatrix().shipController.tools;
  const explicitTools = Object.keys(tools).filter((tool) => tool !== "*").sort();
  assert.deepEqual(explicitTools, EXPECTED_OPENCODE_SHIP_TOOL_IDS);
  for (const tool of explicitTools) {
    assert.ok(["allow", "ask", "deny"].includes(tools[tool]), `${tool} must have a concrete permission`);
  }
});

test("matrix: task-level wildcard defaults are installed as fail-closed permission leaves", () => {
  const leaves = matrixLeafPointers();
  const byPointer = new Map(leaves.map((leaf) => [leaf.pointer, leaf.value]));
  // The task-level wildcard is the documented boundary for
  // subagent dispatch; the agent-level wildcard is NOT emitted
  // because OpenCode's last-match-wins semantics would otherwise
  // mask consumer-owned built-ins (read, edit, bash, …). Only
  // explicit PUBLIC_TOOL_ID entries ship under the agent root.
  assert.equal(byPointer.get("/agent/build/permission/task/*"), "deny");
  assert.equal(byPointer.get("/agent/ship-controller/permission/task/*"), "deny");
  assert.equal(byPointer.get("/agent/build/permission/*"), undefined,
    "agent.build.permission/* must NOT be emitted — it would mask consumer built-ins");
  assert.equal(byPointer.get("/agent/ship-controller/permission/*"), undefined,
    "agent.ship-controller.permission/* must NOT be emitted for the same reason");
});

test("matrix: shipped public tools are explicitly denied on Build and ship-controller", () => {
  const leaves = matrixLeafPointers();
  const byPointer = new Map(leaves.map((leaf) => [leaf.pointer, leaf.value]));
  for (const tool of EXPECTED_OPENCODE_SHIP_TOOL_IDS) {
    // The public tool ids live under /agent/<name>/permission/<tool>
    // because `toolPermissionMap` no longer emits the wildcard "*"
    // entry; each tool has an explicit scalar leaf.
    const buildPtr = `/agent/build/permission/${tool}`;
    const ctrlPtr = `/agent/ship-controller/permission/${tool}`;
    assert.equal(typeof byPointer.get(buildPtr), "string", `Build must record an explicit permission for ${tool}`);
    assert.equal(typeof byPointer.get(ctrlPtr), "string", `ship-controller must record an explicit permission for ${tool}`);
  }
});

test("matrix: bash policy is installed for Build and the controller", () => {
  const leaves = matrixLeafPointers();
  const buildBash = leaves.filter((leaf) => leaf.pointer.startsWith("/agent/build/permission/bash/"));
  const controllerBash = leaves.filter((leaf) => leaf.pointer.startsWith("/agent/ship-controller/permission/bash/"));
  assert.ok(buildBash.some((leaf) => leaf.value === "deny"));
  assert.ok(buildBash.some((leaf) => leaf.value === "ask"));
  assert.equal(buildBash.some((leaf) => leaf.pointer.endsWith("/bash/*") && leaf.value === "allow"), false,
    "Build must inherit consumer bash defaults instead of installing bash/*=allow");
  assert.ok(controllerBash.some((leaf) => leaf.value === "deny"));
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
