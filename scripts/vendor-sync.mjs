#!/usr/bin/env node
/*
 * Vendor manifest builder.
 *
 * One-shot script that:
 *   1. reads the actual upstream bytes from a clone of each pinned
 *      upstream repository (not synthetic summaries);
 *   2. emits an adapted SKILL.md under `assets/skills/<name>/`
 *      for each shipped skill (upstream content + Ship footer);
 *   3. writes a frozen byte-identical snapshot under
 *      `vendor/upstreams/<repo>/<path>` so the package includes the
 *      raw upstream content;
 *   4. regenerates `vendor/sources.json` with the actual SHA-256
 *      of every snapshot, the pinned sourceRef, and the documented
 *      adaptation notes.
 *
 * Run with `node scripts/vendor-sync.mjs`. The output is checked by
 * `tests/package/vendor-closure.test.mjs` and by `npm run prepack`,
 * so the script must be deterministic: same input always produces
 * same output.
 *
 * Upstream repositories are read from `vendor/upstreams-clones/`
 * (one directory per upstream). Clone them with:
 *
 *   git clone https://github.com/mattpocock/skills.git vendor/upstreams-clones/mattpocock
 *   git clone https://github.com/obra/superpowers.git vendor/upstreams-clones/obra
 *
 * then check out the MATT_PIN / SUPER_PIN commits before running
 * this script. The clones themselves are gitignored.
 */

import { writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const CLONES = join(REPO, "vendor", "upstreams-clones");
const UPSTREAMS = join(REPO, "vendor", "upstreams");
const ASSETS = join(REPO, "assets", "skills");
const MANIFEST_PATH = join(REPO, "vendor", "sources.json");

const MATT_PIN = "2ab958093e83e0ec752e6c1c5932da465bf23e0c";
const SUPER_PIN = "44c9b2d6e889982ac18c27d05a19fefe335194e1";

const SHIP_FOOTER_MATT = `## Ship integration

This skill is part of the engineering profile shipped by
\`opencode-ship@1.0\`. The strong planner child session is
configured with \`openai/gpt-5.6-sol\` and the durable workflow
state lives under \`<git-common-dir>/opencode-ship/\`. All
GitHub mutations go through Ship's typed tools; never use
\`gh api\` or raw shell.`;

const SHIP_FOOTER_SUPER = `## Ship integration

This skill is part of the engineering profile shipped by
\`opencode-ship@1.0\`. Execution is driven by the deterministic
Ship controller; the cheap builder (\`minimax/MiniMax-M3\`) cannot
commit, push, mutate GitHub, mark Ready, or merge. The
verification-before-completion rule is enforced by
\`ship_verify\`, not by the model self-asserting completion.`;

/**
 * Map of shipped skill names to:
 *   - upstream repo ("matt" | "obra")
 *   - upstream path relative to the repo root (must exist at the
 *     pinned commit)
 *   - footer ("matt" | "super")
 *   - short description (first non-empty line of the SKILL.md)
 *
 * The upstream path is verified to exist before the snapshot is
 * written; a missing path fails the script with a stable error.
 */
const SKILLS = [
  // Matt Pocock skills (pinned commit MATT_PIN)
  { name: "setup-engineering-workflow", upstream: "matt", upstreamPath: "skills/engineering/setup-matt-pocock-skills/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "engineering-workflow", upstream: "matt", upstreamPath: "skills/engineering/setup-matt-pocock-skills/SKILL.md", footer: "matt", adaptation: "adapted", reuseAs: "setup-engineering-workflow" },
  { name: "grilling", upstream: "matt", upstreamPath: "skills/productivity/grilling/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "domain-modeling", upstream: "matt", upstreamPath: "skills/engineering/domain-modeling/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "grill-with-docs", upstream: "matt", upstreamPath: "skills/engineering/grill-with-docs/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "triage", upstream: "matt", upstreamPath: "skills/engineering/triage/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "to-spec", upstream: "matt", upstreamPath: "skills/engineering/to-spec/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "to-tickets", upstream: "matt", upstreamPath: "skills/engineering/to-tickets/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "wayfinder", upstream: "matt", upstreamPath: "skills/engineering/wayfinder/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "handoff", upstream: "matt", upstreamPath: "skills/productivity/handoff/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "research", upstream: "matt", upstreamPath: "skills/engineering/research/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "prototype", upstream: "matt", upstreamPath: "skills/engineering/prototype/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "codebase-design", upstream: "matt", upstreamPath: "skills/engineering/codebase-design/SKILL.md", footer: "matt", adaptation: "unchanged" },
  { name: "code-review", upstream: "matt", upstreamPath: "skills/engineering/code-review/SKILL.md", footer: "matt", adaptation: "unchanged" },
  // Superpowers skills (pinned commit SUPER_PIN)
  { name: "brainstorming", upstream: "obra", upstreamPath: "skills/brainstorming/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "writing-plans", upstream: "obra", upstreamPath: "skills/writing-plans/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "executing-plans", upstream: "obra", upstreamPath: "skills/executing-plans/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "subagent-driven-development", upstream: "obra", upstreamPath: "skills/subagent-driven-development/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "dispatching-parallel-agents", upstream: "obra", upstreamPath: "skills/dispatching-parallel-agents/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "test-driven-development", upstream: "obra", upstreamPath: "skills/test-driven-development/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "systematic-debugging", upstream: "obra", upstreamPath: "skills/systematic-debugging/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "verification-before-completion", upstream: "obra", upstreamPath: "skills/verification-before-completion/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "requesting-code-review", upstream: "obra", upstreamPath: "skills/requesting-code-review/SKILL.md", footer: "super", adaptation: "unchanged" },
  { name: "receiving-code-review", upstream: "obra", upstreamPath: "skills/receiving-code-review/SKILL.md", footer: "super", adaptation: "unchanged" },
];

const UPSTREAM_REPOS = {
  matt: { name: "mattpocock/skills", pin: MATT_PIN, cloneDir: "mattpocock" },
  obra: { name: "obra/superpowers", pin: SUPER_PIN, cloneDir: "obra" },
};

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function adapt(upstream, footer) {
  const trimmed = upstream.trimEnd();
  return trimmed + "\n\n" + footer + "\n";
}

async function vendorSkill(entry, sources) {
  const repo = UPSTREAM_REPOS[entry.upstream];
  const upstreamDir = join(CLONES, repo.cloneDir, dirname(entry.upstreamPath));
  let skillFiles;
  try {
    skillFiles = await readdir(upstreamDir);
  } catch (e) {
    throw new Error(
      `cannot read upstream skill directory ${repo.name}@${repo.pin} ${upstreamDir}: ${e?.message ?? e}`,
    );
  }
  const footer = entry.footer === "matt" ? SHIP_FOOTER_MATT : SHIP_FOOTER_SUPER;
  const localDir = join(ASSETS, entry.name);
  await mkdir(localDir, { recursive: true });
  for (const file of skillFiles) {
    const upstreamFilePath = join(upstreamDir, file);
    const relPath = relative(upstreamDir, upstreamFilePath);
    let bytes;
    try {
      bytes = await readFile(upstreamFilePath, "utf8");
    } catch {
      continue;
    }
    const upstreamSha = sha256(bytes);
    const frozenDir = join(UPSTREAMS, repo.cloneDir, dirname(entry.upstreamPath));
    await mkdir(frozenDir, { recursive: true });
    const frozenPath = join(UPSTREAMS, repo.cloneDir, entry.upstreamPath, "..", relPath);
    await mkdir(dirname(frozenPath), { recursive: true });
    await writeFile(frozenPath, bytes, "utf8");
    const localFrozenSha = sha256(bytes);
    const isSkill = file === "SKILL.md";
    const adapted = isSkill ? adapt(bytes, footer) : bytes;
    const localTargetName = join(localDir, file);
    await writeFile(localTargetName, adapted, "utf8");
    const localSha = sha256(adapted);
    sources.push({
      skill: entry.name,
      file,
      isSkill,
      repository: repo.name,
      sourceRef: repo.pin,
      upstreamPath: join(dirname(entry.upstreamPath), relPath).split("\\").join("/"),
      sourceSha256: upstreamSha,
      localFrozenPath: relative(REPO, frozenPath).split("\\").join("/"),
      localFrozenSha256: localFrozenSha,
      localTarget: relative(REPO, localTargetName).split("\\").join("/"),
      localSha256: localSha,
      reuseMode: isSkill ? "adapted" : "unchanged",
      license: "MIT",
      adaptationNote: isSkill ? footer : "Vendored companion file shipped verbatim from upstream.",
    });
  }
}

async function main() {
  await rm(UPSTREAMS, { recursive: true, force: true });
  // Only remove vendored skill directories from assets/skills/; the
  // Ship-owned skills (ship-workflow, planning-research-checkpoint)
  // ship verbatim from the repo and must survive a vendor-sync run.
  for (const entry of SKILLS) {
    if (entry.reuseAs) continue;
    await rm(join(ASSETS, entry.name), { recursive: true, force: true });
  }
  await mkdir(UPSTREAMS, { recursive: true });

  const sources = [];
  for (const entry of SKILLS) {
    if (entry.reuseAs) {
      // Alias entries share the bytes and hash of their reuse target.
      const reused = sources.find((s) => s.skill === entry.reuseAs && s.isSkill);
      if (!reused) throw new Error(`reuse target missing: ${entry.reuseAs}`);
      const aliasDir = join(ASSETS, entry.name);
      await mkdir(aliasDir, { recursive: true });
      const sourceDir = join(ASSETS, entry.reuseAs);
      const sourceFiles = await readdir(sourceDir);
      for (const file of sourceFiles) {
        const bytes = await readFile(join(sourceDir, file), "utf8");
        await writeFile(join(aliasDir, file), bytes, "utf8");
      }
      for (const file of sourceFiles) {
        const sourceEntry = sources.find((s) => s.skill === entry.reuseAs && s.file === file);
        if (!sourceEntry) continue;
        sources.push({
          ...sourceEntry,
          skill: entry.name,
          localTarget: `assets/skills/${entry.name}/${file}`,
          reuseAliasOf: entry.reuseAs,
        });
      }
      continue;
    }
    await vendorSkill(entry, sources);
  }
  const manifest = {
    version: 1,
    pins: { matt: MATT_PIN, superpowers: SUPER_PIN },
    sources,
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.error(`vendor-sync: wrote ${sources.length} entries to vendor/sources.json`);
}

main().catch((e) => {
  console.error(`vendor-sync: ${e?.message ?? e}`);
  process.exit(1);
});
