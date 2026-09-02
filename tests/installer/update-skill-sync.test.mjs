/**
 * `opencode-ship update` must call the same `syncSkills` helper
 * `init` uses so a fresh stack skill (e.g. `react` query when
 * the consumer added a React dependency since the last install)
 * lands on disk without a second `init` round-trip.
 *
 * Skill sync failures must NOT cause the update to fail; they
 * surface as a warning in the diagnostics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runUpdate } from "../../src/installer/commands/update.js";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

test("update: calls syncSkills after a successful transaction", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  let calls = 0;
  let receivedRepoRoot = null;
  const syncSkills = async (input) => {
    calls += 1;
    receivedRepoRoot = input?.repoRoot;
    return {
      installed: [{ package: "vercel-labs/agent-skills", skillName: "react-best-practices" }],
      skippedUntrusted: [],
      skippedPolicy: [],
      registryUnavailable: false,
      errors: [],
    };
  };
  const r = await runUpdate({
    rootPath: repoRoot,
    profile: "engineering",
    json: true,
    syncSkills,
  });
  assert.equal(calls, 1, "syncSkills must be called exactly once after a successful transaction");
  assert.equal(receivedRepoRoot, repoRoot, "syncSkills must receive the consumer repo root");
});

test("update: skill sync failure is a warning, not a failed update", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const syncSkills = async () => {
    throw new Error("synthetic skills registry down");
  };
  const r = await runUpdate({
    rootPath: repoRoot,
    profile: "engineering",
    json: true,
    syncSkills,
  });
  // Update must succeed (exitCode 0) even though skill sync threw.
  assert.equal(r.extra?.exitCode, 0);
});

test("update: skill registry unavailable is surfaced in extra.skills", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const syncSkills = async () => ({
    installed: [],
    skippedUntrusted: [],
    skippedPolicy: [],
    registryUnavailable: true,
    errors: ["registry-contract-mismatch"],
  });
  const r = await runUpdate({
    rootPath: repoRoot,
    profile: "engineering",
    json: true,
    syncSkills,
  });
  assert.equal(r.extra?.exitCode, 0);
  assert.equal(r.extra?.skills?.registryUnavailable, true);
});
