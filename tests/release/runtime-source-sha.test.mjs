/*
 * Runtime-source digest tests.
 *
 * The `runtimeSourceSha256` is the byte-equivalence witness between
 * the accepted `0.10.0` and the `1.0.0` promotion: any change to
 * the runtime source must change the digest, and any change to
 * release metadata alone must NOT. These tests pin the contract
 * so a future refactor of `scripts/runtime-source-sha.mjs` cannot
 * silently break the promotion gate.
 *
 * The tests use a synthetic fixture tree so the assertions are
 * independent of the package's actual contents and reproduce on
 * any clean checkout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRuntimeSourceSha256,
  RUNTIME_INCLUDE_DIRS,
  RUNTIME_INCLUDE_FILES,
} from "../../scripts/runtime-source-sha.mjs";

async function makeFixture({ version = "1.2.3", src = ["src/index.js"], assets = ["assets/data.txt"], schema = ["schema/foo.json"], vendor = ["vendor/upstreams/a"], scripts = { build: "scripts/build.mjs", prepack: "scripts/prepack.mjs" }, extras = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "oc-runtime-sha-"));
  for (const d of RUNTIME_INCLUDE_DIRS) await mkdir(join(root, d), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const rel of src) {
    const abs = join(root, rel);
    await mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `// ${rel}\n`);
  }
  for (const rel of assets) {
    const abs = join(root, rel);
    await mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `assets: ${rel}\n`);
  }
  for (const rel of schema) {
    const abs = join(root, rel);
    await mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, JSON.stringify({ name: rel }));
  }
  for (const rel of vendor) {
    const abs = join(root, rel);
    await mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `vendor: ${rel}\n`);
  }
  await writeFile(join(root, scripts.build), "// build\n");
  await writeFile(join(root, scripts.prepack), "// prepack\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "oc-runtime-sha-fixture",
      version,
      type: "module",
      bin: { fixture: "./scripts/build.mjs" },
      exports: { ".": "./src/index.js" },
      files: ["dist", "assets"],
      engines: { node: ">=22.6.0" },
      peerDependencies: { "@opencode-ai/plugin": ">=1.15.5 <2" },
      publishConfig: { access: "public", provenance: true },
    }, null, 2) + "\n",
  );
  for (const [rel, content] of Object.entries(extras)) {
    const abs = join(root, rel);
    await mkdir(abs.substring(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

test("runtime-source-sha: digest is deterministic across clean checkouts", async () => {
  const root = await makeFixture();
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: root });
    const b = await computeRuntimeSourceSha256({ repoRoot: root });
    assert.equal(a.digest, b.digest, "digest must be stable for the same tree");
    assert.equal(a.fileCount, b.fileCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-source-sha: includes every runtime-source file", async () => {
  const root = await makeFixture();
  try {
    const r = await computeRuntimeSourceSha256({ repoRoot: root });
    const paths = new Set(r.files.map((f) => f.path));
    for (const rel of RUNTIME_INCLUDE_DIRS) {
      // The fixture puts at least one file under each include dir.
      assert.ok([...paths].some((p) => p.startsWith(`${rel}/`)), `${rel}/* must be in the digest`);
    }
    for (const rel of RUNTIME_INCLUDE_FILES) {
      assert.ok(paths.has(rel), `${rel} must be in the digest`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-source-sha: package.json version bump does not change the digest", async () => {
  const rootA = await makeFixture({ version: "0.10.0-rc.19" });
  const rootB = await makeFixture({ version: "1.0.0" });
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: rootA });
    const b = await computeRuntimeSourceSha256({ repoRoot: rootB });
    assert.equal(a.digest, b.digest, "digest must be identical when only the package.json version changes");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("runtime-source-sha: README/CHANGELOG/doc changes do not change the digest", async () => {
  const rootA = await makeFixture({
    extras: {
      "README.md": "# short\n",
      "CHANGELOG.md": "# changelog\n",
      "RELEASING.md": "# release\n",
      "THIRD_PARTY_NOTICES.md": "third party\n",
      "LICENSE": "MIT\n",
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, name: "x", version: "1.0.0" }),
      "docs/release/1.0.0-execution-plan.md": "# plan\n",
    },
  });
  const rootB = await makeFixture({
    extras: {
      "README.md": "# a much longer readme that shifts every byte\n",
      "CHANGELOG.md": "# changelog\n## 9.9.9\n- many lines\n",
      "RELEASING.md": "# release\n## new section\n",
      "THIRD_PARTY_NOTICES.md": "totally different\n",
      "LICENSE": "Apache-2.0\n",
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, name: "x", version: "9.9.9", packages: { "": { version: "9.9.9" } } }),
      "docs/release/1.0.0-execution-plan.md": "# plan v2\n",
    },
  });
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: rootA });
    const b = await computeRuntimeSourceSha256({ repoRoot: rootB });
    assert.equal(a.digest, b.digest, "digest must ignore release-metadata files");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("runtime-source-sha: changing a runtime source file changes the digest", async () => {
  const rootA = await makeFixture({ src: ["src/foo.js"] });
  const rootB = await makeFixture({ src: ["src/foo.js"] });
  // Mutate one byte in rootB.
  const target = join(rootB, "src", "foo.js");
  const text = await readFile(target, "utf8");
  await writeFile(target, text + "// one more byte\n");
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: rootA });
    const b = await computeRuntimeSourceSha256({ repoRoot: rootB });
    assert.notEqual(a.digest, b.digest, "digest must change when a runtime source file changes");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("runtime-source-sha: changing package.json non-version fields changes the digest", async () => {
  const rootA = await makeFixture();
  const rootB = await makeFixture();
  // Mutate package.json by adding a new top-level field. The
  // version remains identical, so the digest must change because
  // the normalised bytes include every other top-level key.
  const pkgPath = join(rootB, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.engines = { node: ">=24.0.0" };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: rootA });
    const b = await computeRuntimeSourceSha256({ repoRoot: rootB });
    assert.notEqual(a.digest, b.digest, "digest must change when a non-version package.json field changes");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("runtime-source-sha: package.json with no version still produces a digest", async () => {
  // The 1.0.0 promotion policy rejects when the digest is absent
  // or differs, but it does not require package.json to carry a
  // version field. Future maintenance tooling may normalise
  // package.json away from its published form; the digest path
  // must remain stable.
  const root = await makeFixture();
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  delete pkg.version;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  try {
    const r = await computeRuntimeSourceSha256({ repoRoot: root });
    assert.equal(typeof r.digest, "string");
    assert.equal(r.digest.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-source-sha: deterministic across re-runs even when filesystem order differs", async () => {
  // Two fixtures constructed independently from the same recipe
  // must agree. The internal listFiles walk is order-sensitive;
  // the canonical sort must neutralise that.
  const rootA = await makeFixture({ src: ["src/a.js", "src/b.js", "src/c.js"] });
  const rootB = await makeFixture({ src: ["src/c.js", "src/b.js", "src/a.js"] });
  try {
    const a = await computeRuntimeSourceSha256({ repoRoot: rootA });
    const b = await computeRuntimeSourceSha256({ repoRoot: rootB });
    assert.equal(a.digest, b.digest, "digest must be independent of source ordering");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("runtime-source-sha: excludes generated output under dist/ and .tmp/", async () => {
  const root = await makeFixture({
    extras: {
      "dist/plugin.js": "// generated\n",
      "dist/cli.js": "// generated\n",
      ".tmp/garbage.txt": "garbage\n",
      "node_modules/left-pad/index.js": "module.exports = (s, n) => s;\n",
    },
  });
  try {
    const r = await computeRuntimeSourceSha256({ repoRoot: root });
    const paths = new Set(r.files.map((f) => f.path));
    assert.ok(![...paths].some((p) => p.startsWith("dist/")), "dist/** must not appear in the digest");
    assert.ok(![...paths].some((p) => p.startsWith(".tmp/")), ".tmp/** must not appear in the digest");
    assert.ok(![...paths].some((p) => p.startsWith("node_modules/")), "node_modules/** must not appear in the digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-source-sha: file sha256s match the bytes that produced them", async () => {
  const root = await makeFixture();
  try {
    const r = await computeRuntimeSourceSha256({ repoRoot: root });
    for (const f of r.files) {
      if (f.path === "package.json") continue; // package.json is normalised
      const bytes = await readFile(join(root, f.path));
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256").update(bytes).digest("hex");
      assert.equal(f.sha256, expected, `${f.path} sha256 must match the on-disk bytes`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
