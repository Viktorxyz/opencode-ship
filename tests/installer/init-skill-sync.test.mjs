import test from "node:test";
import assert from "node:assert/strict";
import { runInit } from "../../src/installer/commands/init.js";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("init: reports skill sync in extra (stubbed)", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({
    name: "fixture", version: "0.0.0", private: true,
    dependencies: { react: "19.0.0" },
    scripts: { verify: "node -e \"console.log('ok')\"", typecheck: "node -e \"console.log('ok')\"" },
  }));
  const r = await runInit({
    rootPath: repoRoot,
    json: true,
    syncSkills: async () => ({
      installed: [],
      skippedUntrusted: [],
      registryUnavailable: false,
      errors: [],
    }),
  });
  assert.ok(r.extra?.skills, "init must attach extra.skills");
  assert.equal(typeof r.extra.skills.registryUnavailable, "boolean");
});
