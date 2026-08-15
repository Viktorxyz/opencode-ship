/*
 * Legacy consumer migration.
 *
 * Detects v0.1.x artifacts and adapts them into a v0.2 installable
 * shape:
 *   1. `.opencode/delivery.json` + `.opencode/delivery.lock.json`
 *      become seeds for the new `ship.config.json` (when missing)
 *      and the new `ship.lock.json` (when no manager version was
 *      previously recorded).
 *   2. A root `opencode.json` plugin entry like
 *      `"https://github.com/Viktorxyz/opencode-delivery#<sha>"`
 *      is removed during migration when the new plugin is being
 *      installed, so we do not double-register.
 *   3. A plugin file `.opencode/plugin/delivery.ts` whose shape
 *      matches the generic nine-tool wrapper is removed when the
 *      bundled `.opencode/plugin/opencode-ship.js` is written.
 *
 * Migration is opt-in (only when the user runs `init`), and
 * destructive actions are gated by the lock: legacy artifacts that
 * have been modified by the user are reported but never deleted.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readLock } from "./lock.js";
import { loadConfig, renderDefaultConfig } from "./config.js";

function legacyAdapterPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "delivery.json");
}

function legacyLockPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "delivery.lock.json");
}

function legacyPluginPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "plugin", "delivery.ts");
}

async function detectLegacyShapes(repoRoot) {
  const out = {
    adapter: false,
    legacyLock: false,
    plugin: false,
    pluginOld: false,
    reviewer: false,
    verifier: false,
  };
  if (existsSync(legacyAdapterPath(repoRoot))) out.adapter = true;
  if (existsSync(legacyLockPath(repoRoot))) out.legacyLock = true;
  if (existsSync(legacyPluginPath(repoRoot))) out.plugin = true;
  if (existsSync(resolve(repoRoot, ".opencode/plugin/opencode-ship.js"))) out.pluginOld = true;
  if (existsSync(resolve(repoRoot, ".opencode/agents/delivery-reviewer.md"))) out.reviewer = true;
  if (existsSync(resolve(repoRoot, ".opencode/agents/delivery-verifier.md"))) out.verifier = true;
  return out;
}

async function readLegacyAdapter(repoRoot) {
  const path = legacyAdapterPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return { path, raw, value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

function isShimPluginEntry(opencodeDoc) {
  const plugin = opencodeDoc?.plugin;
  if (!Array.isArray(plugin)) return null;
  for (const entry of plugin) {
    if (typeof entry === "string" && entry.includes("Viktorxyz/opencode-delivery")) return entry;
  }
  return null;
}

/**
 * Detect legacy shapes and propose migration actions.
 *
 * The function is pure: it never writes to disk. Callers translate
 * the returned `proposedConfigSeed` into a real config-write only
 * when they have confirmed the user is committing (`init`, `update`,
 * or the consumer rebuild). The legacy plugin file is reported for
 * removal only when the new plugin path already exists, so a fresh
 * consumer who never installed a previous release is never asked to
 * remove anything.
 */
export async function migration({ repoRoot, lock, forceRepair, detection = null }) {
  const shapes = await detectLegacyShapes(repoRoot);
  const legacy = await readLegacyAdapter(repoRoot);
  const config = await loadConfig(repoRoot);
  const actions = [];
  let proposedConfigSeed = null;

  if (legacy && !config?.ok) {
    proposedConfigSeed = legacyToShipConfig(legacy.value, detection);
    actions.push({ kind: "candidate-seed-config", from: legacy.path });
  }

  if (legacy && shapes.legacyLock && !lock?.manager) {
    actions.push({ kind: "kept-legacy-lock", path: legacyLockPath(repoRoot) });
  }

  if (shapes.plugin && existsSync(resolve(repoRoot, ".opencode/plugins/opencode-ship.js"))) {
    if (!forceRepair) {
      actions.push({ kind: "candidate-remove-legacy-plugin", path: legacyPluginPath(repoRoot) });
    }
  }
  if (shapes.pluginOld) {
    actions.push({ kind: "candidate-remove-legacy-plugin-path", path: resolve(repoRoot, ".opencode/plugin/opencode-ship.js") });
  }

  return { shapes, actions, legacyPresent: Boolean(legacy), proposedConfigSeed };
}

export function legacyToShipConfig(legacy, detection = null) {
  if (!legacy || typeof legacy !== "object") return renderDefaultConfig(detection ?? {});
  const repoSlug = typeof legacy.repository?.repoSlug === "string"
    ? legacy.repository.repoSlug
    : detection?.repository ?? "owner/repo";
  return {
    schemaVersion: 1,
    project: {
      remote: legacy.repository?.remote ?? detection?.remote ?? "origin",
      repository: repoSlug,
      defaultBranch: legacy.repository?.defaultBranch?.name ?? detection?.defaultBranch ?? "main",
      packageManager: detection?.packageManager ?? "pnpm",
      detectOverrides: false,
    },
    delivery: {
      worktree: {
        root: legacy.worktree?.root ?? ".worktrees",
        branchTemplate: legacy.worktree?.branchTemplate ?? "{actor}/{slug}",
        bootstrap: Array.isArray(legacy.worktree?.bootstrap) && legacy.worktree.bootstrap.length
          ? legacy.worktree.bootstrap
          : [["pnpm", "install", "--frozen-lockfile"]],
      },
      verification: {
        commands: Array.isArray(legacy.verification?.commands) && legacy.verification.commands.length
          ? legacy.verification.commands
          : [{ id: "canonical", argv: ["pnpm", "verify:workspace"], timeoutMs: 1800000 }],
        requireCleanDiffAfter: legacy.verification?.requireCleanDiffAfter ?? true,
        invalidateOnHeadChange: legacy.verification?.invalidateOnHeadChange ?? true,
      },
      review: legacy.review ?? { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
      ci: legacy.ci ?? {
        driver: "github-status-checks",
        requiredChecks: ["delivery-verify"],
        wait: true,
        flakyRetry: 1,
      },
      ready: legacy.ready ?? { requires: ["review", "local-verification", "remote-ci"], stopAfterReady: true },
      merge: legacy.merge ?? { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
      cleanup: legacy.cleanup && typeof legacy.cleanup === "object" && "when" in legacy.cleanup
        ? legacy.cleanup
        : { when: "next-task", requireUnpublishedGuard: true },
    },
    workflow: {
      models: {},
      approval: { mirrorToIssue: true, maxFailedRounds: 3 },
    },
  };
}

export { isShimPluginEntry };
