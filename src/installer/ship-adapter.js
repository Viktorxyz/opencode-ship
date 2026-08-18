/*
 * Bridges `.opencode/ship.config.json` to the legacy Adapter shape
 * that the existing core factories consume.
 *
 * The new ship config is nested (`project`, `delivery.worktree`,
 * `delivery.verification`, etc.). The core tools keep using the flat
 * `Adapter` interface unchanged for backward compatibility, so this
 * module is the only place that knows both shapes.
 */

import { resolve } from "node:path";

const REQUIRED_DEFAULTS = {
  review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
  ci: { driver: "github-status-checks", requiredChecks: ["delivery-verify"], wait: true, flakyRetry: 1 },
  ready: { requires: ["review", "local-verification", "remote-ci"], stopAfterReady: true },
  merge: { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
  cleanup: { when: "next-task", requires: ["pr-merged", "worktree-clean", "no-unpublished-commits"] },
  forge: { driver: "github", issueRequired: true, draftAfterFirstCommit: true, issueClosingSyntax: true },
  worktree: { root: ".worktrees", branchTemplate: "{actor}/{slug}", bootstrap: [["npm", "install"]] },
  verification: { commands: [], requireCleanDiffAfter: true, invalidateOnHeadChange: true },
};

export function flattenShipConfig(ship) {
  if (!ship || typeof ship !== "object") return null;
  const adapter = { contractVersion: 1 };
  adapter.repository = {
    remote: ship.project?.remote ?? "origin",
    defaultBranch: ship.project?.defaultBranch
      ? { name: ship.project.defaultBranch }
      : { discover: true },
  };
  adapter.forge = REQUIRED_DEFAULTS.forge;
  adapter.worktree = {
    ...REQUIRED_DEFAULTS.worktree,
    ...(ship.delivery?.worktree ?? {}),
    bootstrap: ship.delivery?.worktree?.bootstrap?.length
      ? ship.delivery.worktree.bootstrap
      : REQUIRED_DEFAULTS.worktree.bootstrap,
  };
  adapter.verification = {
    ...REQUIRED_DEFAULTS.verification,
    ...(ship.delivery?.verification ?? {}),
    commands: ship.delivery?.verification?.commands?.length
      ? ship.delivery.verification.commands.map((c) => ({ id: c.id, argv: c.argv, timeoutMs: c.timeoutMs }))
      : REQUIRED_DEFAULTS.verification.commands,
  };
  adapter.review = { ...REQUIRED_DEFAULTS.review, ...(ship.delivery?.review ?? {}) };
  adapter.ci = { ...REQUIRED_DEFAULTS.ci, ...(ship.delivery?.ci ?? {}) };
  adapter.ready = { ...REQUIRED_DEFAULTS.ready, ...(ship.delivery?.ready ?? {}) };
  adapter.merge = { ...REQUIRED_DEFAULTS.merge, ...(ship.delivery?.merge ?? {}) };
  adapter.cleanup = { ...REQUIRED_DEFAULTS.cleanup, ...(ship.delivery?.cleanup ?? {}) };
  if (ship.delivery?.cleanup?.requireUnpublishedGuard !== undefined) {
    // requireUnpublishedGuard is a UI knob; we keep the existing
    // safety default on the legacy adapter since the runtime guard
    // already enforces it unconditionally.
    void ship.delivery.cleanup.requireUnpublishedGuard;
  }
  return adapter;
}

export function selectRuntimeAdapter({ config, shipAdapter, legacyAdapter }) {
  if (config?.ok) return shipAdapter;
  if (legacyAdapter?.ok) return legacyAdapter.adapter;
  return shipAdapter;
}

export function shipConfigPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "ship.config.json");
}
