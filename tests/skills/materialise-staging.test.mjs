/**
 * Skill staging-path tests.
 *
 * The `skills add` CLI materialises into one of three locations
 * depending on version and flags. The installer must find the
 * staged skill no matter where the CLI dropped it:
 *
 *   1. <stage>/.opencode/skills/<skillName>
 *   2. <stage>/.agents/skills/<skillName>
 *   3. <stage>/skills/<skillName>
 *
 * `findStagedSkillDir` is the lookup helper that backs the
 * production materialise function. These tests exercise the
 * helper directly so a future CLI change that moves the
 * staging root can be detected without invoking the live CLI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { findStagedSkillDir } from "../../src/tools/ship-skill-install.js";

function makeStage(skillName) {
  const stage = mkdtempSync(join(tmpdir(), "ship-stage-lookup-"));
  return { stage, skillName };
}

function dropSkill(stage, relativeBase, skillName, body) {
  const dir = join(stage, relativeBase, skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

test("staging-lookup: finds .opencode/skills/<name>", () => {
  const { stage, skillName } = makeStage("alpha");
  try {
    const expected = dropSkill(stage, ".opencode/skills", skillName, "# alpha\n");
    const found = findStagedSkillDir(stage, skillName);
    assert.equal(found, expected);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("staging-lookup: falls back to .agents/skills/<name>", () => {
  const { stage, skillName } = makeStage("beta");
  try {
    const expected = dropSkill(stage, ".agents/skills", skillName, "# beta\n");
    const found = findStagedSkillDir(stage, skillName);
    assert.equal(found, expected);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("staging-lookup: falls back to skills/<name>", () => {
  const { stage, skillName } = makeStage("gamma");
  try {
    const dir = join(stage, "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# gamma\n", "utf8");
    const found = findStagedSkillDir(stage, skillName);
    assert.equal(found, dir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("staging-lookup: returns null when the CLI produced nothing", () => {
  const { stage, skillName } = makeStage("missing");
  try {
    const found = findStagedSkillDir(stage, skillName);
    assert.equal(found, null);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("staging-lookup: prefers .opencode/skills over the other roots", () => {
  const { stage, skillName } = makeStage("delta");
  try {
    const opencodeDir = dropSkill(stage, ".opencode/skills", skillName, "# opencode\n");
    dropSkill(stage, ".agents/skills", skillName, "# agents\n");
    dropSkill(stage, "skills", skillName, "# plain\n");
    const found = findStagedSkillDir(stage, skillName);
    assert.equal(found, opencodeDir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("staging-install: end-to-end install copies .agents/skills bytes into repo", async () => {
  // Confirms that the production install tool copies the
  // staged bytes byte-for-byte even when the CLI materialised
  // into `.agents/skills/<name>` (the second-priority lookup
  // root). This is the path the shipped CLI takes when the
  // agent flag is `--agent opencode` on newer versions.
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-install-agents-"));
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/agent-skills", skill: "vercel-react-best-practices", installs: 684100 }] }),
      materialiseFromSkillsCli: async ({ stageDir, skillName }) => {
        // Simulate the CLI writing into `.agents/skills`.
        dropSkill(stageDir, ".agents/skills", skillName, "# v1\n");
        const found = findStagedSkillDir(stageDir, skillName);
        if (!found) return { ok: false, retryable: false, message: "fake CLI wrote nothing" };
        return {
          ok: true,
          stagedDir: found,
          source: {
            packageSpec: "vercel-labs/agent-skills",
            skillName,
            cliPackage: "skills@1.0.4",
            registryId: `vercel-labs/agent-skills/${skillName}`,
            registrySnapshotHash: createHash("sha256").update("v1").digest("hex"),
          },
        };
      },
    });
    const result = await tool({
      package: "vercel-labs/agent-skills",
      skillName: "vercel-react-best-practices",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const installedPath = join(repo, ".opencode", "skills", "vercel-react-best-practices", "SKILL.md");
    assert.ok(existsSync(installedPath));
    assert.equal(readFileSync(installedPath, "utf8"), "# v1\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("staging-install: end-to-end install copies skills/<name> bytes into repo", async () => {
  // Confirms that the production install tool copies the
  // staged bytes byte-for-byte even when the CLI materialised
  // into the third-priority root.
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-install-plain-"));
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/agent-skills", skill: "vercel-react-best-practices", installs: 684100 }] }),
      materialiseFromSkillsCli: async ({ stageDir, skillName }) => {
        const dir = join(stageDir, "skills", skillName);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), "# plain\n", "utf8");
        const found = findStagedSkillDir(stageDir, skillName);
        if (!found) return { ok: false, retryable: false, message: "fake CLI wrote nothing" };
        return {
          ok: true,
          stagedDir: found,
          source: {
            packageSpec: "vercel-labs/agent-skills",
            skillName,
            cliPackage: "skills@1.0.4",
            registryId: `vercel-labs/agent-skills/${skillName}`,
            registrySnapshotHash: createHash("sha256").update("plain").digest("hex"),
          },
        };
      },
    });
    const result = await tool({
      package: "vercel-labs/agent-skills",
      skillName: "vercel-react-best-practices",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const installedPath = join(repo, ".opencode", "skills", "vercel-react-best-practices", "SKILL.md");
    assert.ok(existsSync(installedPath));
    assert.equal(readFileSync(installedPath, "utf8"), "# plain\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("staging-install: refuses to install when CLI produced nothing in any root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-install-empty-"));
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/agent-skills", skill: "vercel-react-best-practices", installs: 684100 }] }),
      materialiseFromSkillsCli: async ({ stageDir }) => {
        // Simulate the CLI succeeding but writing nothing.
        const found = findStagedSkillDir(stageDir, "vercel-react-best-practices");
        if (!found) {
          return {
            ok: false,
            retryable: false,
            message: `skills CLI did not produce any of: ${stageDir}/.opencode/skills/vercel-react-best-practices, ${stageDir}/.agents/skills/vercel-react-best-practices, ${stageDir}/skills/vercel-react-best-practices`,
          };
        }
        return { ok: true, stagedDir: found, source: {} };
      },
    });
    const result = await tool({
      package: "vercel-labs/agent-skills",
      skillName: "vercel-react-best-practices",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /skills CLI did not produce any of/);
    const dest = join(repo, ".opencode", "skills", "vercel-react-best-practices");
    assert.equal(existsSync(dest), false, "no partial install should land on disk");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("staging: SKILLS_INSTALL_TIMEOUT_MS is at least 60s", async () => {
  const { SKILLS_INSTALL_TIMEOUT_MS } = await import("../../src/skills/registry.js");
  assert.ok(SKILLS_INSTALL_TIMEOUT_MS >= 60_000);
});
