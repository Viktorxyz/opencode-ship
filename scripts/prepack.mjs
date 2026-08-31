#!/usr/bin/env node
/* npm `prepack` hook: build first, validate catalog, fail closed if any
 * required artifact is missing. */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function fail(msg) {
  process.stderr.write(`prepack: ${msg}\n`);
  process.exit(1);
}

function findTool(candidates) {
  for (const rel of candidates) {
    const abs = resolve(root, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

const esbuildBin = findTool([
  "node_modules/.bin/esbuild",
  "node_modules/esbuild/bin/esbuild",
  "node_modules/esbuild/lib/main.js",
]);

if (!esbuildBin) {
  fail("esbuild missing; run `npm install` first");
}

const tscBin = findTool([
  "node_modules/.bin/tsc",
  "node_modules/typescript/bin/tsc",
]);

if (!tscBin) {
  fail("typescript missing; run `npm install` first");
}

const build = spawnSync("node", [resolve(root, "scripts/build.mjs")], { stdio: "inherit" });
if (build.status !== 0) {
  fail(`build failed with exit ${build.status ?? "?"}`);
}

const catalogCheck = spawnSync("node", [
  "--input-type=module",
  "--no-warnings",
  "-e",
  `import { validateCatalog } from ${JSON.stringify(resolve(root, "src/installer/catalog.js"))};`
  + "(async () => { try { validateCatalog(); } catch (e) { process.stderr.write('validateCatalog: ' + (e?.message ?? e) + '\\n'); process.exit(2); } })();",
], { stdio: "inherit" });
if (catalogCheck.status !== 0) {
  fail(`catalog validation failed with exit ${catalogCheck.status ?? "?"}`);
}

for (const path of [
  "dist/plugin.js",
  "dist/cli.js",
  "dist/core.js",
  "dist/plugin.d.ts",
  "dist/cli.d.ts",
  "dist/core.d.ts",
  "assets/agents/delivery-reviewer.md",
  "assets/agents/delivery-verifier.md",
  "assets/skills/delivery-workflow/SKILL.md",
  "assets/skills/planning-research-checkpoint/SKILL.md",
  "schema/project-adapter.schema.json",
  "schema/ship-config.schema.json",
  "schema/ship-lock.schema.json",
  "vendor/sources.json",
  "vendor/mattpocock/LICENSE",
  "vendor/superpowers/LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
]) {
  if (!existsSync(resolve(root, path))) {
    fail(`expected packaged artifact missing: ${path}`);
  }
}

// Verify that every vendored engineering skill is present and
// has a non-empty body. The closure test in
// `tests/package/vendor-closure.test.mjs` re-validates the full
// manifest; this loop is a fast guard against an empty
// `scripts/vendor-sync.mjs` run leaking into a published tarball.
const skillNames = [
  "setup-ship-workflow", "engineering-workflow", "grilling",
  "domain-modeling", "grill-with-docs", "triage", "to-spec", "to-tickets",
  "wayfinder", "handoff", "research", "prototype", "codebase-design", "code-review",
  "brainstorming", "writing-plans", "executing-plans", "subagent-driven-development",
  "dispatching-parallel-agents", "test-driven-development", "systematic-debugging",
  "verification-before-completion", "requesting-code-review", "receiving-code-review",
];
for (const name of skillNames) {
  const p = resolve(root, "assets", "skills", name, "SKILL.md");
  if (!existsSync(p)) fail(`expected engineering skill missing: ${p}`);
  const st = statSync(p);
  if (st.size < 200) fail(`engineering skill body is suspiciously small: ${p}`);
}

// Verify the vendor manifest is well-formed. An empty manifest is
// valid (the package ships no third-party content yet); a
// non-empty manifest must reference a sourceRef for every entry
// and the local file must hash to sourceSha256.
const manifestPath = resolve(root, "vendor/sources.json");
if (existsSync(manifestPath)) {
  const manifestScript = `
    import { loadManifest, verifyManifestIntegrity } from ${JSON.stringify(resolve(root, "src/installer/manifest.js"))};
    (async () => {
      const r = await loadManifest(${JSON.stringify(manifestPath)});
      if (!r) { console.error('no manifest'); return; }
      if (r.kind !== 'ok') { console.error('manifest: ' + r.kind + ': ' + r.issues.join('; ')); process.exit(3); }
      const v = await verifyManifestIntegrity(r.manifest, ${JSON.stringify(root)});
      if (!v.ok) {
        if (v.missing.length) console.error('manifest: missing files: ' + v.missing.join(', '));
        if (v.mismatches.length) console.error('manifest: hash mismatches: ' + v.mismatches.map((m) => m.target + ' (expected ' + m.expected + ', got ' + m.actual + ')').join('; '));
        process.exit(4);
      }
      console.error('manifest: ok (' + r.manifest.sources.length + ' sources)');
    })().catch((e) => { console.error('manifest: ' + (e?.message ?? e)); process.exit(5); });
  `;
  const manifestCheck = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", manifestScript], { stdio: "inherit" });
  if (manifestCheck.status !== 0) {
    fail(`vendor manifest check failed with exit ${manifestCheck.status ?? "?"}`);
  }
}
