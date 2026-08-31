import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("prepack fails closed without installing missing build tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-prepack-"));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const sentinel = join(root, "npm-was-called");
    const fakeNpm = join(bin, "npm");
    await Promise.all([mkdir(scripts, { recursive: true }), mkdir(bin, { recursive: true })]);
    await copyFile(join(process.cwd(), "scripts", "prepack.mjs"), join(scripts, "prepack.mjs"));
    await writeFile(fakeNpm, `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 0\n`);
    await chmod(fakeNpm, 0o755);
    const result = spawnSync(process.execPath, [join(scripts, "prepack.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /esbuild missing; run `npm install` first/);
    assert.equal(existsSync(sentinel), false, "prepack must never invoke npm install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
