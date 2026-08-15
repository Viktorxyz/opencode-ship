/*
 * opencode-ship asset catalog.
 *
 * The catalog is the single source of truth for every managed file
 * the installer can install, upgrade, downgrade, or remove. Each
 * entry fixes:
 *
 *   - id           a stable string used in lock metadata and tests
 *   - kind         plugin | agent | skill | support
 *   - path         the on-disk target inside the consumer repo
 *   - source       the absolute source path inside this package
 *   - mode         the unix permission enforced on install
 *
 * The catalog is immutable at runtime; `validateCatalog` confirms
 * every source exists, every path is `.opencode/-rooted`, and every
 * id is unique so the planner/executor/doctor layers can trust the
 * table without further validation. The catalog validator runs in
 * `init`, `diff`, and `update` and refuses to proceed when a source
 * is missing instead of silently producing an empty file.
 */

import { resolve, relative, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { resolvePackageRoot } from "./package-root.js";
import { PACKAGE_VERSION, TEMPLATE_SET } from "../version.js";
import { PROFILES, isValidProfile, DEFAULT_PROFILE } from "../profile.js";

export { PACKAGE_VERSION };
export const TEMPLATE_SET_ID = TEMPLATE_SET;

const packageRoot = resolvePackageRoot(import.meta.url);

/**
 * The full asset catalog. Every entry declares which profile(s)
 * it belongs to via the `profiles` array. The "core" profile is
 * the baseline (all current v0.3 entries); "engineering" is the
 * opt-in extension that adds Matt + Superpowers workflow assets.
 *
 * Entries can belong to multiple profiles (e.g., a delivery
 * helper that core and engineering both consume).
 */
const MATT_SKILLS = [
  "setup-engineering-workflow",
  "engineering-workflow",
  "grilling",
  "domain-modeling",
  "grill-with-docs",
  "triage",
  "to-spec",
  "to-tickets",
  "wayfinder",
  "handoff",
  "research",
  "prototype",
  "codebase-design",
  "code-review",
];

const SUPER_SKILLS = [
  "brainstorming",
  "writing-plans",
  "executing-plans",
  "subagent-driven-development",
  "dispatching-parallel-agents",
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
  "requesting-code-review",
  "receiving-code-review",
];

const ENGINEERING_AGENTS = [
  "ship-controller",
  "ship-planner",
  "ship-task-builder",
  "ship-task-reviewer",
  "ship-final-standards-reviewer",
  "ship-final-spec-reviewer",
];

const ENGINEERING_COMMANDS = [
  "ship-deliver",
  "ship-resume",
  "ship-status",
];

export const CATALOG = [
  {
    id: "plugin:opencode-ship",
    kind: "plugin",
    path: ".opencode/plugins/opencode-ship.js",
    source: resolve(packageRoot, "dist/plugin.js"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  {
    id: "agent:delivery-reviewer",
    kind: "agent",
    path: ".opencode/agents/delivery-reviewer.md",
    source: resolve(packageRoot, "assets/agents/delivery-reviewer.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  {
    id: "agent:delivery-verifier",
    kind: "agent",
    path: ".opencode/agents/delivery-verifier.md",
    source: resolve(packageRoot, "assets/agents/delivery-verifier.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  ...ENGINEERING_AGENTS.map((name) => ({
    id: `agent:${name}`,
    kind: "agent",
    path: `.opencode/agents/${name}.md`,
    source: resolve(packageRoot, `assets/agents/${name}.md`),
    mode: 0o644,
    profiles: ["engineering"],
  })),
  ...ENGINEERING_COMMANDS.map((name) => ({
    id: `command:${name}`,
    kind: "support",
    path: `.opencode/commands/${name}.md`,
    source: resolve(packageRoot, `assets/commands/${name}.md`),
    mode: 0o644,
    profiles: ["engineering"],
  })),
  {
    id: "skill:delivery-workflow",
    kind: "skill",
    path: ".opencode/skills/delivery-workflow/SKILL.md",
    source: resolve(packageRoot, "assets/skills/delivery-workflow/SKILL.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  {
    id: "skill:planning-research-checkpoint",
    kind: "skill",
    path: ".opencode/skills/planning-research-checkpoint/SKILL.md",
    source: resolve(packageRoot, "assets/skills/planning-research-checkpoint/SKILL.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  ...MATT_SKILLS.map((name) => ({
    id: `skill:matt:${name}`,
    kind: "skill",
    path: `.opencode/skills/${name}/SKILL.md`,
    source: resolve(packageRoot, `assets/skills/${name}/SKILL.md`),
    mode: 0o644,
    profiles: ["engineering"],
  })),
  ...SUPER_SKILLS.map((name) => ({
    id: `skill:super:${name}`,
    kind: "skill",
    path: `.opencode/skills/${name}/SKILL.md`,
    source: resolve(packageRoot, `assets/skills/${name}/SKILL.md`),
    mode: 0o644,
    profiles: ["engineering"],
  })),
  {
    id: "skill:setup-ship-workflow",
    kind: "skill",
    path: ".opencode/skills/setup-ship-workflow/SKILL.md",
    source: resolve(packageRoot, "assets/skills/setup-engineering-workflow/SKILL.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  {
    id: "skill:skill-discovery",
    kind: "skill",
    path: ".opencode/skills/skill-discovery/SKILL.md",
    source: resolve(packageRoot, "assets/skills/skill-discovery/SKILL.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
  {
    id: "command:setup-ship-workflow",
    kind: "support",
    path: ".opencode/commands/setup-ship-workflow.md",
    source: resolve(packageRoot, "assets/commands/setup-ship-workflow.md"),
    mode: 0o644,
    profiles: ["engineering"],
  },
];

/**
 * Return only the catalog entries that ship under the given
 * profile. From 1.1.0 only `engineering` is shipped; the legacy
 * `core` value is mapped to `engineering` so persisted config/lock
 * files load through the read path.
 */
export function filterCatalogByProfile(catalog, profile) {
  const effective = profile === undefined || profile === null
    ? DEFAULT_PROFILE
    : isValidProfile(profile)
      ? profile
      : profile === "core"
        ? DEFAULT_PROFILE
        : null;
  if (effective === null) {
    throw new Error(
      `filterCatalogByProfile: unknown profile '${profile}' (expected one of: ${PROFILES.join(", ")})`,
    );
  }
  return catalog.filter((entry) => Array.isArray(entry.profiles) && entry.profiles.includes(effective));
}

const ALLOWED_KINDS = new Set(["plugin", "agent", "skill", "support"]);

/**
 * Fail-closed catalog validation. Throws when any entry is malformed
 * or when any source file does not exist on disk. The caller decides
 * whether to surface this as the installer's exit code 4 (installer
 * surface) or as a packaging failure (prepack).
 *
 * The validator is intentionally strict: silent missing sources have
 * already produced consumer installs whose managed file was an empty
 * placeholder (see v0.2.0 lock schema requiring 64-hex hash but the
 * planner returning null on a missing source). Tight validation here
 * is the boundary the installer never crosses.
 */
export function validateCatalog({ catalog = CATALOG } = {}) {
  const seenIds = new Set();
  const seenPaths = new Set();
  const issues = [];

  for (const entry of catalog) {
    if (!entry || typeof entry !== "object") {
      issues.push({ id: null, kind: "shape", message: "catalog entry is not an object" });
      continue;
    }
    const { id, kind, path, source, mode } = entry;

    if (typeof id !== "string" || id.length === 0) {
      issues.push({ id: null, kind: "id", message: `entry id missing: ${JSON.stringify(entry)}` });
    } else if (seenIds.has(id)) {
      issues.push({ id, kind: "duplicate-id", message: `duplicate catalog id: ${id}` });
    } else {
      seenIds.add(id);
    }

    if (typeof path !== "string" || !path.startsWith(".opencode" + sep)) {
      issues.push({ id, kind: "path", message: `path must be rooted under .opencode/: ${path}` });
    }
    if (seenPaths.has(path)) {
      issues.push({ id, kind: "duplicate-path", message: `duplicate target path: ${path}` });
    } else {
      seenPaths.add(path);
    }

    if (!ALLOWED_KINDS.has(kind)) {
      issues.push({ id, kind: "kind", message: `unsupported entry kind: ${kind}` });
    }

    if (typeof source !== "string" || source.length === 0) {
      issues.push({ id, kind: "source", message: `source path missing: ${id}` });
    } else if (!existsSync(source)) {
      issues.push({ id, kind: "source-missing", message: `source file not found: ${source}` });
    } else {
      try {
        const stats = statSync(source);
        if (!stats.isFile()) {
          issues.push({ id, kind: "source-not-file", message: `source is not a regular file: ${source}` });
        } else if (stats.size === 0) {
          issues.push({ id, kind: "source-empty", message: `source file is empty: ${source}` });
        }
      } catch (e) {
        issues.push({ id, kind: "source-stat", message: `unable to stat source: ${e?.message ?? e}` });
      }
      const rel = relative(packageRoot, source);
      if (rel.startsWith("..")) {
        issues.push({ id, kind: "source-out-of-package", message: `source escapes package root: ${source}` });
      }
    }

    if (mode !== 0o644) {
      issues.push({ id, kind: "mode", message: `mode must be 0o644: ${id}` });
    }

    if (!Array.isArray(entry.profiles) || entry.profiles.length === 0) {
      issues.push({ id, kind: "profiles", message: `profiles must be a non-empty array: ${id}` });
    } else {
      for (const p of entry.profiles) {
        if (!isValidProfile(p)) {
          issues.push({ id, kind: "profiles", message: `unknown profile in profiles[${entry.profiles.indexOf(p)}]: ${p} (expected one of: ${PROFILES.join(", ")})` });
        }
      }
    }
  }

  if (issues.length > 0) {
    const summary = issues.map((i) => i.message).join("; ");
    const err = new Error(`opencode-ship catalog validation failed: ${summary}`);
    /** @type {any} */ (err).issues = issues;
    /** @type {any} */ (err).catalogValidation = true;
    throw err;
  }
  return catalog;
}

// Validate from the installer's dispatch boundary. The CLI commands
// (`init`, `diff`, `update`) and `prepack` invoke `validateCatalog()`
// before any filesystem change so a broken package state surfaces as
// the installer's exit code 4 rather than as an empty managed file.
