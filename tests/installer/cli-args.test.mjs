/*
 * Unit tests for src/installer/cli-args.js.
 *
 * Verifies the CLI flag parser recognises --profile and rejects
 * unknown profiles and the removed 'core' profile with the
 * documented exit code 2 contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, parseFlags } from "../../src/installer/cli-args.js";

test("parseFlags: returns profile=null when --profile absent", () => {
  const r = parseFlags(["--json"]);
  assert.equal(r.profile, null);
  assert.equal(r.error, undefined);
});

test("parseFlags: accepts --profile engineering", () => {
  const r = parseFlags(["--profile", "engineering"]);
  assert.equal(r.profile, "engineering");
});

test("parseFlags: rejects --profile core (removed in 1.1.0)", () => {
  const r = parseFlags(["--profile", "core"]);
  assert.match(r.error ?? "", /core/);
  assert.match(r.error ?? "", /removed/i);
});

test("parseFlags: rejects unknown profile with an error", () => {
  const r = parseFlags(["--profile", "practices"]);
  assert.match(r.error ?? "", /profile/i);
  assert.match(r.error ?? "", /practices/);
});

test("parseFlags: --planner-model accepts a <provider>/<model> id", () => {
  const r = parseFlags(["--planner-model", "openai/gpt-5.6-sol"]);
  assert.equal(r.plannerModel, "openai/gpt-5.6-sol");
});

test("parseFlags: --planner-model rejects malformed ids", () => {
  const r = parseFlags(["--planner-model", "gpt-5.6-sol"]);
  assert.match(r.error ?? "", /provider/i);
});

test("parseCommand: propagates profile through init/diff/update", () => {
  for (const cmd of ["init", "diff", "update", "doctor", "uninstall"]) {
    const r = parseCommand([cmd, "--profile", "engineering"]);
    assert.equal(r.command, cmd);
    assert.equal(r.options.profile, "engineering");
  }
});

test("parseCommand: profile is optional (defaults to null)", () => {
  const r = parseCommand(["init"]);
  assert.equal(r.command, "init");
  assert.equal(r.options.profile, null);
});
