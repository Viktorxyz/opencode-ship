/*
 * Unit tests for the engineering workflow config in ship-config.
 *
 * The installer ships an optional engineering profile that
 * configures three model roles (planner, builder, final-reviewer)
 * and the plan artifact path + mirror policy. Tests assert the
 * loader/validator contract and the priority rules.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateEngineeringConfig, resolveModelRoles } from "../../src/installer/engineering-config.js";

test("validateEngineeringConfig: accepts a fully populated config", () => {
  const cfg = {
    models: {
      planner: "openai/gpt-5.6-sol",
      builder: "minimax/MiniMax-M3",
      finalReviewer: "openai/gpt-5.6-sol",
    },
    plans: {
      root: ".git/opencode-ship/plans",
      mirrorToIssue: true,
    },
  };
  const r = validateEngineeringConfig(cfg);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("validateEngineeringConfig: accepts an absent config (engineering profile disabled)", () => {
  assert.equal(validateEngineeringConfig(undefined).ok, true);
  assert.equal(validateEngineeringConfig({}).ok, true);
});

test("validateEngineeringConfig: rejects an unknown model id", () => {
  const r = validateEngineeringConfig({ models: { planner: "wat" } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("validateEngineeringConfig: rejects a plan root that escapes the repo", () => {
  const r = validateEngineeringConfig({ plans: { root: "/etc/passwd" } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("validateEngineeringConfig: rejects mirrorToIssue=false (currently mandatory)", () => {
  const r = validateEngineeringConfig({ plans: { mirrorToIssue: false } });
  assert.equal(r.ok, false);
});

test("resolveModelRoles: prefers explicit config, falls back to defaults", () => {
  const r = resolveModelRoles({ models: { planner: "minimax/MiniMax-M3" } });
  assert.equal(r.planner, "minimax/MiniMax-M3");
  assert.equal(r.builder, "minimax-coding-plan/MiniMax-M3");
  assert.ok(r.finalReviewer);
});

test("resolveModelRoles: throws when required role is empty and no default", () => {
  assert.throws(() => resolveModelRoles({ models: { planner: "" } }, { strict: true }));
});
