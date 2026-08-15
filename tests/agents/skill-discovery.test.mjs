/*
 * tests/agents/skill-discovery.test.mjs
 *
 * Skill discovery policy tests: candidate parsing, allowlist
 * filtering, and install threshold enforcement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRUSTED_OWNERS,
  DEFAULT_MIN_INSTALLS,
  MAX_TRUSTED_PER_RUN,
  partitionCandidates,
} from "../../src/tools/skill-discovery.js";
import {
  skillLockPath,
  readSkillLock,
  writeSkillLock,
  findSkill,
  SKILL_LOCK_VERSION,
} from "../../src/installer/skill-lock.js";

test("DEFAULT_TRUSTED_OWNERS contains the canonical allowlist", () => {
  for (const owner of ["vercel-labs", "anthropics", "obra", "mattpocock", "ComposioHQ"]) {
    assert.ok(DEFAULT_TRUSTED_OWNERS.includes(owner));
  }
});

test("DEFAULT_MIN_INSTALLS is non-zero so untrusted owners cannot trivially auto-install", () => {
  assert.ok(DEFAULT_MIN_INSTALLS >= 1000);
});

test("MAX_TRUSTED_PER_RUN is bounded", () => {
  assert.ok(MAX_TRUSTED_PER_RUN >= 1 && MAX_TRUSTED_PER_RUN <= 20);
});

test("partitionCandidates: trusted + threshold passes the policy", () => {
  const candidates = [
    { skill: "ok", package: "vercel-labs/ok", installs: 5000 },
    { skill: "low", package: "vercel-labs/low", installs: 100 },
  ];
  const { auto, needsApproval } = partitionCandidates(candidates, {
    trustedOwners: [...DEFAULT_TRUSTED_OWNERS],
    minInstalls: DEFAULT_MIN_INSTALLS,
    blocklist: [],
  });
  assert.equal(auto.length, 1);
  assert.equal(auto[0].skill, "ok");
  assert.equal(needsApproval.length, 1);
  assert.equal(needsApproval[0].skill, "low");
});

test("partitionCandidates: untrusted owner never auto-installs", () => {
  const candidates = [
    { skill: "x", package: "untrusted/x", installs: 9999 },
  ];
  const { auto, needsApproval } = partitionCandidates(candidates, {
    trustedOwners: [...DEFAULT_TRUSTED_OWNERS],
    minInstalls: DEFAULT_MIN_INSTALLS,
    blocklist: [],
  });
  assert.equal(auto.length, 0);
  assert.equal(needsApproval.length, 1);
});

test("partitionCandidates: blocklist always rejects", () => {
  const candidates = [
    { skill: "x", package: "vercel-labs/x", installs: 9999 },
  ];
  const { auto, needsApproval } = partitionCandidates(candidates, {
    trustedOwners: [...DEFAULT_TRUSTED_OWNERS],
    minInstalls: DEFAULT_MIN_INSTALLS,
    blocklist: ["vercel-labs/x"],
  });
  assert.equal(auto.length, 0);
  assert.equal(needsApproval.length, 0);
});

test("partitionCandidates: caps auto-install count", () => {
  const candidates = Array.from({ length: MAX_TRUSTED_PER_RUN + 3 }, (_, i) => ({
    skill: `s${i}`,
    package: `vercel-labs/s${i}`,
    installs: 9999,
  }));
  const { auto, needsApproval } = partitionCandidates(candidates, {
    trustedOwners: ["vercel-labs"],
    minInstalls: 100,
    blocklist: [],
  });
  assert.equal(auto.length, MAX_TRUSTED_PER_RUN);
  assert.equal(needsApproval.length, candidates.length - MAX_TRUSTED_PER_RUN);
});

test("skill lock: defaults to version 1 with empty skills when absent", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ship-skill-lock-"));
  try {
    const lock = await readSkillLock(dir);
    assert.equal(lock.version, SKILL_LOCK_VERSION);
    assert.deepEqual(lock.skills, []);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill lock: write + read round-trip preserves entries with integrity", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ship-skill-lock-"));
  try {
    const target = skillLockPath(dir);
    const lock = {
      version: SKILL_LOCK_VERSION,
      skills: [
        {
          name: "test-skill",
          package: "vercel-labs/test-skill",
          commit: "abc1234",
          installedAt: new Date().toISOString(),
          files: [{ path: ".opencode/skills/test-skill/SKILL.md", sha256: "f".repeat(64) }],
        },
      ],
    };
    await writeSkillLock(dir, lock);
    const loaded = await readSkillLock(dir);
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, "test-skill");
    assert.equal(loaded.skills[0].commit, "abc1234");
    assert.ok(findSkill(loaded, "test-skill"));
    assert.equal(findSkill(loaded, "missing"), null);
    // integrity field must be present and a 64-hex string.
    const raw = await import("node:fs/promises").then(m => m.readFile(target, "utf8"));
    const parsed = JSON.parse(raw);
    assert.match(parsed.integrity.lockSha256, /^[0-9a-f]{64}$/);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});
