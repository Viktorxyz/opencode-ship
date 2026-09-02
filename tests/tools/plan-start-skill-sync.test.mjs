import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanStartTool } from "../../src/tools/ship-plan-start.js";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-plan-start-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(join(root, ".opencode", "ship.lock.json"), JSON.stringify({
    manager: { setupComplete: true },
  }));
  writeFileSync(join(root, "README.md"), "# x\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return root;
}

test("plan-start: calls syncSkills before lease", async () => {
  const fixture = makeRepo();
  try {
    const order = [];
    const tool = createPlanStartTool({
      repoRoot: fixture,
      ctx: { sessionID: "ctrl", agent: "ship-controller" },
      config: { workflow: { models: {
        planner: "openai/gpt-5.6-sol",
        builder: "minimax-coding-plan/MiniMax-M3",
        finalReviewer: "openai/gpt-5.6-sol",
      }}},
      syncSkills: async () => {
        order.push("sync");
        return { installed: [], skippedUntrusted: [], registryUnavailable: false, errors: [] };
      },
      opencodeClient: null,
    });
    await tool({ issueNumber: 1 });
    assert.ok(order.includes("sync"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
