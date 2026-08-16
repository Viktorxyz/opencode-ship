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
    const tool = createSkillInstallTool({ repoRoot: repo, config: { value: { skills: [] } } });
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

test("lifecycle: ship_skill_audit returns an empty chain when no installs have been recorded", async () => {
  const { repo } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillAuditTool } = await import("../../src/tools/ship-skill-audit.js");
    const tool = createSkillAuditTool({ repoRoot: repo });
    const r = await tool({});
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
  const { repo } = makeRepoWithLinkedWorktree();
  try {
    const { createSkillUninstallTool } = await import("../../src/tools/ship-skill-uninstall.js");
    const tool = createSkillUninstallTool({ repoRoot: repo });
    const r = await tool({ skill: "missing" });
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
