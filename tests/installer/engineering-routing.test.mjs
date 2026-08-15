/*
 * Engineering config v2 + role-routed CLI flags.
 *
 * Engineering profile is opt-in and requires all three
 * model roles to be resolvable. The CLI may synthesise a
 * missing role with `--planner-model`, `--builder-model`,
 * `--final-reviewer-model`; the resulting ship.config.json
 * is the only authoritative source for the next run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as fs from "node:fs/promises";
import { parseCommand, parseFlags, helpText } from "../../src/installer/cli-args.js";
import { resolveModelRoles, validateEngineeringConfig } from "../../src/installer/engineering-config.js";
import { isValidProfile, DEFAULT_PROFILE } from "../../src/profile.js";

test("parseFlags: --profile accepts every profile", () => {
  for (const p of ["core", "engineering"]) {
    const r = parseFlags(["--profile", p]);
    assert.equal(r.profile, p);
  }
});

test("parseFlags: rejects unknown profile", () => {
  const r = parseFlags(["--profile", "practices"]);
  assert.equal(r.error, "unknown profile 'practices' (expected one of: core, engineering)");
});

test("parseFlags: --planner-model accepts a <provider>/<model> id", () => {
  const r = parseFlags(["--planner-model", "openai/gpt-5.6-sol"]);
  assert.equal(r.plannerModel, "openai/gpt-5.6-sol");
});

test("parseFlags: --builder-model accepts a <provider>/<model> id", () => {
  const r = parseFlags(["--builder-model", "minimax/MiniMax-M3"]);
  assert.equal(r.builderModel, "minimax/MiniMax-M3");
});

test("parseFlags: --final-reviewer-model accepts a <provider>/<model> id", () => {
  const r = parseFlags(["--final-reviewer-model", "openai/gpt-5.6-sol"]);
  assert.equal(r.finalReviewerModel, "openai/gpt-5.6-sol");
});

test("parseFlags: --planner-model rejects malformed ids", () => {
  const r = parseFlags(["--planner-model", "gpt-5.6-sol"]);
  assert.ok(r.error && r.error.includes("planner-model"));
});

test("parseFlags: --builder-model rejects empty value", () => {
  const r = parseFlags(["--builder-model"]);
  assert.ok(r.error && r.error.includes("requires a value"));
});

test("parseFlags: rejects unknown flag", () => {
  const r = parseFlags(["--unknown"]);
  assert.equal(r.error, "unknown flag --unknown");
});

test("parseCommand: ship-deliver routes to the controller command", () => {
  const r = parseCommand(["init", "--json"]);
  assert.equal(r.command, "init");
  assert.equal(r.options.json, true);
});

test("helpText: lists the engineering model flags", () => {
  const t = helpText();
  assert.match(t, /--planner-model/);
  assert.match(t, /--builder-model/);
  assert.match(t, /--final-reviewer-model/);
});

test("validateEngineeringConfig: empty config is valid (engineering opt-in)", () => {
  const r = validateEngineeringConfig(null);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "empty");
});

test("validateEngineeringConfig: rejects a model id that does not match <provider>/<model>", () => {
  const r = validateEngineeringConfig({ models: { planner: "gpt-5.6-sol" } });
  assert.equal(r.ok, false);
  assert.match(r.kind, /shape/);
});

test("validateEngineeringConfig: accepts three valid model ids", () => {
  const r = validateEngineeringConfig({
    models: {
      planner: "openai/gpt-5.6-sol",
      builder: "minimax/MiniMax-M3",
      finalReviewer: "openai/gpt-5.6-sol",
    },
  });
  assert.equal(r.ok, true);
});

test("resolveModelRoles: strict=true throws when any role is missing", () => {
  assert.throws(() => resolveModelRoles({ models: { planner: "openai/gpt-5.6-sol" } }, { strict: true }), /builder/);
  assert.throws(() => resolveModelRoles({ models: { planner: "openai/gpt-5.6-sol", builder: "minimax/MiniMax-M3" } }, { strict: true }), /finalReviewer/);
});

test("resolveModelRoles: strict=true accepts all three roles", () => {
  const r = resolveModelRoles({
    models: {
      planner: "openai/gpt-5.6-sol",
      builder: "minimax/MiniMax-M3",
      finalReviewer: "openai/gpt-5.6-sol",
    },
  }, { strict: true });
  assert.equal(r.planner, "openai/gpt-5.6-sol");
  assert.equal(r.builder, "minimax/MiniMax-M3");
  assert.equal(r.finalReviewer, "openai/gpt-5.6-sol");
});

test("DEFAULT_PROFILE: is core", () => {
  assert.equal(DEFAULT_PROFILE, "core");
  assert.ok(isValidProfile("core"));
  assert.ok(isValidProfile("engineering"));
});

test("Config V2: engineering profile requires explicit workflow.models", async () => {
  const { loadConfig } = await import("../../src/installer/config.js");
  const dir = await mkdtemp(resolve(tmpdir(), "ocd-cfg-"));
  try {
    const cfgDir = resolve(dir, ".opencode");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(resolve(cfgDir, "ship.config.json"), JSON.stringify({
      schemaVersion: 2,
      profile: "engineering",
    }));
    const r = await loadConfig(dir);
    assert.equal(r.ok, false, "engineering without workflow.models must fail closed");
    assert.ok(/workflow|model/i.test(JSON.stringify(r.error ?? {})), `unexpected error: ${JSON.stringify(r.error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Config V2: engineering with explicit models passes", async () => {
  const { loadConfig } = await import("../../src/installer/config.js");
  const dir = await mkdtemp(resolve(tmpdir(), "ocd-cfg-"));
  try {
    const cfgDir = resolve(dir, ".opencode");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(resolve(cfgDir, "ship.config.json"), JSON.stringify({
      schemaVersion: 2,
      profile: "engineering",
      workflow: {
        models: {
          planner: "openai/gpt-5.6-sol",
          builder: "minimax/MiniMax-M3",
          finalReviewer: "openai/gpt-5.6-sol",
        },
        approval: {
          mirrorToIssue: true,
          maxFailedRounds: 3,
        },
      },
    }));
    const r = await loadConfig(dir);
    assert.equal(r.ok, true, `engineering with explicit models must load: ${JSON.stringify(r.error)}`);
    assert.equal(r.value.workflow.models.planner, "openai/gpt-5.6-sol");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Config V2: core profile does not require workflow block", async () => {
  const { loadConfig } = await import("../../src/installer/config.js");
  const dir = await mkdtemp(resolve(tmpdir(), "ocd-cfg-"));
  try {
    const cfgDir = resolve(dir, ".opencode");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(resolve(cfgDir, "ship.config.json"), JSON.stringify({
      schemaVersion: 2,
      profile: "core",
    }));
    const r = await loadConfig(dir);
    assert.equal(r.ok, true, `core without workflow must load: ${JSON.stringify(r.error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Config V2: schema rejects a malformed model id", async () => {
  const { loadConfig } = await import("../../src/installer/config.js");
  const dir = await mkdtemp(resolve(tmpdir(), "ocd-cfg-"));
  try {
    const cfgDir = resolve(dir, ".opencode");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(resolve(cfgDir, "ship.config.json"), JSON.stringify({
      schemaVersion: 2,
      profile: "engineering",
      workflow: {
        models: {
          planner: "not-a-valid-model-id",
          builder: "minimax/MiniMax-M3",
          finalReviewer: "openai/gpt-5.6-sol",
        },
      },
    }));
    const r = await loadConfig(dir);
    assert.equal(r.ok, false, "malformed model id must fail closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
