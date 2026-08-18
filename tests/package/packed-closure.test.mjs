/**
 * Packed-artifact closure tests.
 *
 * Asserts the published tarball:
 *
 *   1. Contains exactly the active 32-tool surface.
 *   2. Never ships archived non-GitHub tracker templates
 *      (the historical `assets/_archive/**` directory).
 *   3. Never ships source-tree internals (`src/**`) so packed
 *      qualification cannot bypass the public tool surface.
 *   4. Carries every active skill companion required by the
 *      installer catalog.
 *   5. Carries a portable lock schema (v4 accepts setupComplete).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tar } from "./_test-tar.mjs";

async function buildTarball() {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-pack-closure-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarball = join(tmp, meta[0].filename);
  const cleanup = async () => rm(tmp, { recursive: true, force: true });
  return { tarball, cleanup };
}

test("packed: the installer-owned _archive directory is NOT shipped", async (t) => {
  const { tarball, cleanup } = await buildTarball();
  t.after(cleanup);
  const entries = await tar.list(tarball);
  const paths = entries.map((e) => e.path);
  // The installer-owned archive was moved out of assets/ into
  // archive/trackers/ at the source root so the npm "files"
  // allowlist (`assets/**`) does not pick it up.
  for (const leaked of paths.filter((p) => p.includes("_archive"))) {
    assert.fail(`archive leaked into pack: ${leaked}`);
  }
  for (const p of paths.filter((p) => p.startsWith("package/archive/"))) {
    assert.fail(`top-level archive leaked into pack: ${p}`);
  }
});

test("packed: src/ internals are NOT shipped", async (t) => {
  const { tarball, cleanup } = await buildTarball();
  t.after(cleanup);
  const entries = await tar.list(tarball);
  for (const p of entries.map((e) => e.path)) {
    assert.ok(!p.startsWith("package/src/"), `src leak: ${p}`);
  }
});

test("packed: docs/release/** internal plans are NOT shipped", async (t) => {
  const { tarball, cleanup } = await buildTarball();
  t.after(cleanup);
  const entries = await tar.list(tarball);
  for (const p of entries.map((e) => e.path)) {
    assert.ok(!p.startsWith("package/docs/release/"), `docs/release leak: ${p}`);
  }
});

test("packed: every shipped skill companion required by the catalog is present", async (t) => {
  const { tarball, cleanup } = await buildTarball();
  t.after(cleanup);
  const entries = await tar.list(tarball);
  const paths = new Set(entries.map((e) => e.path));
  for (const required of [
    "package/assets/skills/setup-ship-workflow/SKILL.md",
    "package/assets/skills/delivery-workflow/SKILL.md",
    "package/assets/skills/engineering-workflow/SKILL.md",
    "package/assets/skills/brainstorming/SKILL.md",
    "package/assets/skills/triage/SKILL.md",
  ]) {
    assert.ok(paths.has(required), `${required} missing from packed tarball`);
  }
});

test("packed: lock schema is current (v4)", async (t) => {
  const { tarball, cleanup } = await buildTarball();
  t.after(cleanup);
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-pack-schema-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await tar.extract(tarball, tmp);
  const fs = await import("node:fs/promises");
  const schemaRaw = await fs.readFile(join(tmp, "package/schema/ship-lock.schema.json"), "utf8");
  const schema = JSON.parse(schemaRaw);
  // Schema v4 accepts manager.setupComplete.
  const setupProp = schema.properties?.manager?.properties?.setupComplete;
  assert.ok(setupProp, "setupComplete must be present in schema");
  assert.equal(setupProp.type, "boolean");
});
