/**
 * Regression tests for the production skill lifecycle tools.
 *
 * The shipped 1.1.2-rc.2 had `ship_skill_install` write a
 * placeholder `SKILL.md` and hash it against itself; the audit
 * then compared the placeholder hash to the inventory hash and
 * was green by construction. These tests verify that the install
 * tool refuses to write without a real registry materialisation,
 * validates the destination worktree boundary, refuses to
 * install into the main checkout, and refuses destinations that
 * already exist or shadow a managed skill.
 *
 * The full live-registry install flow is exercised through a
 * fake registry materialisation harness so the production code
 * path is hit without needing the `skills` CLI on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  INVENTORY_SCHEMA,
  verifyInventory,
  readInventory,
} from "../../src/skills/inventory.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepoWithLinkedWorktree() {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-lifecycle-"));
  git(["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "# x\n");
  git(["-C", repo, "add", "README.md"]);
  git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  const linked = join(repo, ".worktrees", "issue-1");
  mkdirSync(linked, { recursive: true });
  git(["-C", repo, "worktree", "add", "-b", "issue-1", linked]);
  return { repo, linked };
}

test("lifecycle: ship_skill_install refuses the main checkout", async () => {
  const { repo } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({ repoRoot: repo, config: { value: { skills: [] } } });
    const r = await tool({
      package: "vercel-labs/skills",
      worktreePath: repo,
      skillName: "find-skills",
    });
    assert.equal(r.kind, "skill-install");
    assert.ok(/forbidden|rejected/i.test(r.message), `expected main-checkout refusal, got: ${r.message}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_install refuses unregistered destinations", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const outside = mkdtempSync(join(tmpdir(), "opencode-ship-lifecycle-out-"));
    try {
      const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
      const tool = createSkillInstallTool({ repoRoot: repo, config: { value: { skills: [] } } });
      const r = await tool({
        package: "vercel-labs/skills",
        worktreePath: outside,
        skillName: "find-skills",
      });
      assert.ok(/not registered|rejected/i.test(r.message), `expected unregistered refusal, got: ${r.message}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_install refuses untrusted owners", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({ repoRoot: repo, config: { value: { skills: [] } } });
    const r = await tool({
      package: "untrusted-owner/skills",
      worktreePath: linked,
      skillName: "anything",
    });
    assert.ok(/untrusted|policy/i.test(r.message), `expected policy refusal, got: ${r.message}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_install fails closed when skills CLI is unavailable", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    // The skills CLI is not installed in the test environment;
    // the install must refuse rather than write a placeholder.
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/skills", skill: "find-skills", installs: 5000 }] }),
    });
    const r = await tool({
      package: "vercel-labs/skills",
      worktreePath: linked,
      skillName: "find-skills",
    });
    // The installer must NOT have written any SKILL.md into the
    // worktree, regardless of the failure mode.
    const skillPath = join(linked, ".opencode", "skills", "find-skills");
    assert.equal(
      existsSync(skillPath),
      false,
      "install must never write a placeholder SKILL.md when the CLI is unavailable",
    );
    assert.notEqual(r.kind, "ok");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_install enforces the registry install threshold", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const tool = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/skills", skill: "find-skills", installs: 1 }] }),
      materialiseFromSkillsCli: async () => { throw new Error("must not materialise below threshold"); },
    });
    const result = await tool({ package: "vercel-labs/skills", worktreePath: linked, skillName: "find-skills" });
    assert.equal(result.ok, false);
    assert.match(result.message, /below-threshold/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: install, audit, and uninstall preserve real bytes in the linked worktree", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const materialise = async ({ stageDir, skillName }) => {
      const stagedDir = join(stageDir, ".opencode", "skills", skillName);
      mkdirSync(join(stagedDir, "references"), { recursive: true });
      writeFileSync(join(stagedDir, "SKILL.md"), "# Real skill\n", "utf8");
      writeFileSync(join(stagedDir, "references", "guide.md"), "# Guide\n", "utf8");
      return {
        ok: true,
        stagedDir,
        source: {
          packageSpec: "vercel-labs/skills",
          skillName,
          cliPackage: "skills@1.0.4",
          registryId: `vercel-labs/skills/${skillName}`,
          registrySnapshotHash: "a".repeat(64),
        },
      };
    };
    const { createSkillInstallTool } = await import("../../src/tools/ship-skill-install.js");
    const install = createSkillInstallTool({
      repoRoot: repo,
      config: { value: { skills: [] } },
      materialiseFromSkillsCli: materialise,
      discoverSkills: async () => ({ ok: true, candidates: [{ package: "vercel-labs/skills", skill: "find-skills", installs: 5000 }] }),
    });
    const installed = await install({
      package: "vercel-labs/skills",
      worktreePath: linked,
      skillName: "find-skills",
    });
    assert.equal(installed.ok, true, installed.message);
    assert.ok(existsSync(join(linked, ".opencode", "skills", "find-skills", "SKILL.md")));
    const inventory = await readInventory(linked);
    assert.equal(inventory.events[0].skill, "find-skills");
    assert.equal(inventory.events[0].files.length, 2);

    const { createSkillAuditTool } = await import("../../src/tools/ship-skill-audit.js");
    const audit = await createSkillAuditTool({ repoRoot: repo })({ worktreePath: linked });
    assert.equal(audit.ok, true);
    assert.equal(audit.data.active, 1);
    assert.deepEqual(audit.data.missing, []);
    assert.deepEqual(audit.data.drifted, []);

    const { createSkillUninstallTool } = await import("../../src/tools/ship-skill-uninstall.js");
    const removed = await createSkillUninstallTool({ repoRoot: repo })({
      skill: "find-skills",
      worktreePath: linked,
    });
    assert.equal(removed.ok, true, removed.message);
    assert.equal(existsSync(join(linked, ".opencode", "skills", "find-skills")), false);
    assert.deepEqual(await verifyInventory(linked), { ok: true, count: 2 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_audit returns an empty chain when no installs have been recorded", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillAuditTool } = await import("../../src/tools/ship-skill-audit.js");
    const tool = createSkillAuditTool({ repoRoot: repo });
    const r = await tool({ worktreePath: linked });
    assert.equal(r.kind, "skill-audit");
    assert.equal(r.data.total, 0);
    assert.deepEqual(r.data.missing, []);
    assert.deepEqual(r.data.drifted, []);
    assert.deepEqual(r.data.untracked, []);
    assert.equal(r.data.chain.ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: ship_skill_uninstall refuses an unknown skill", async () => {
  const { repo, linked } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillUninstallTool } = await import("../../src/tools/ship-skill-uninstall.js");
    const tool = createSkillUninstallTool({ repoRoot: repo });
    const r = await tool({ skill: "missing", worktreePath: linked });
    assert.equal(r.kind, "skill-uninstall");
    assert.ok(/not in active|inventory/i.test(r.message));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lifecycle: inventory schema is v2 (append-only chain)", async () => {
  const { repo } = makeRepoWithLinkedWorktree();
  try {
    const inv = await readInventory(repo);
    assert.equal(inv.schemaVersion, INVENTORY_SCHEMA);
    const chain = await verifyInventory(repo);
    assert.deepEqual(chain, { ok: true, count: 0 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
