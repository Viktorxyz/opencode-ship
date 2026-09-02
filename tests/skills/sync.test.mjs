import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncSkills } from "../../src/skills/sync.js";

test("syncSkills init: installs trusted, skips untrusted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ship-sync-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { react: "19.0.0" },
  }));
  const installed = [];
  const r = await syncSkills({
    repoRoot: root,
    mode: "init",
    listSkillsFn: async () => ({
      ok: true,
      candidates: [
        { package: "vercel-labs/agent-skills", skill: "react-best-practices", installs: 5000 },
        { package: "random-user/react-hack", skill: "react-hack", installs: 12 },
      ],
    }),
    installFn: async (input) => {
      installed.push(input.skillName);
      return { ok: true };
    },
    policy: {
      trustedOwners: ["vercel-labs"],
      minInstalls: 1000,
      blocklist: [],
      maxTrustedPerRun: 5,
    },
  });
  assert.deepEqual(installed, ["react-best-practices"]);
  assert.equal(r.skippedUntrusted.length, 1);
  assert.equal(r.registryUnavailable, false);
});

test("syncSkills: registry down is not thrown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ship-sync-off-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "1" } }));
  const r = await syncSkills({
    repoRoot: root,
    mode: "init",
    listSkillsFn: async () => { throw new Error("offline"); },
    installFn: async () => ({ ok: true }),
  });
  assert.equal(r.registryUnavailable, true);
  assert.equal(r.installed.length, 0);
});

test("syncSkills: caps at 5 installs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ship-sync-cap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    dependencies: { react: "1", next: "1", express: "1", vitest: "1", playwright: "1" },
  }));
  let n = 0;
  const r = await syncSkills({
    repoRoot: root,
    mode: "init",
    listSkillsFn: async ({ query }) => ({
      ok: true,
      candidates: [{ package: "vercel-labs/agent-skills", skill: `skill-${query}`, installs: 9000 }],
    }),
    installFn: async () => { n += 1; return { ok: true }; },
    policy: { trustedOwners: ["vercel-labs"], minInstalls: 1000, blocklist: [], maxTrustedPerRun: 5 },
  });
  assert.ok(n <= 5);
  assert.ok(r.installed.length <= 5);
});
