import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupComplete } from "../../src/installer/setup-state.js";

test("setup state: current validated lock is required", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-ship-setup-state-"));
  try {
    await mkdir(join(root, "docs", "agents"), { recursive: true });
    for (const name of ["issue-tracker.md", "domain.md", "triage-labels.md"]) {
      await writeFile(join(root, "docs", "agents", name), "# configured\n");
    }
    await writeFile(join(root, "AGENTS.md"), "## Ship workflow\n");
    const state = await setupComplete(root, {
      workflow: { models: { planner: "p/m", builder: "b/m", finalReviewer: "f/m" } },
    });
    assert.equal(state.ok, false);
    assert.equal(state.config.lock.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
