/**
 * Deterministic in-process test helpers.
 *
 * Each test runs inside its own scratch git repository rooted at a
 * unique temporary directory. The fixture writes `.opencode/delivery.json`,
 * makes one initial commit on `main`, and exposes cleanup to the caller
 * so the test harness can remove the directory at teardown.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readManifest, writeManifest } from "../../src/state/manifest-store.js";

export function git(cwd, args, env = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

export function makeFixtureRepo(adapterOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-ship-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  mkdirSync(join(dir, ".opencode"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  const adapter = {
    contractVersion: 1,
    repository: { remote: "origin", defaultBranch: { name: "main" } },
    forge: { driver: "github" },
    worktree: { root: ".worktrees", branchTemplate: "{actor}/{slug}", bootstrap: [] },
    verification: {
      commands: [{ id: "canonical", argv: ["true"], timeoutMs: 5000 }],
      requireCleanDiffAfter: true,
      invalidateOnHeadChange: true,
    },
    review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
    ci: {
      driver: "github-status-checks",
      requiredChecks: ["delivery-verify"],
      wait: false,
      flakyRetry: 0,
    },
    ready: {
      requires: ["review", "local-verification", "remote-ci"],
      stopAfterReady: true,
    },
    merge: {
      strategy: "squash",
      policy: "explicit-user-request-only",
      requireFreshGates: true,
    },
    cleanup: {
      when: "next-task",
      requires: ["pr-merged", "worktree-clean", "no-unpublished-commits"],
    },
    ...adapterOverrides,
  };
  writeFileSync(join(dir, ".opencode", "delivery.json"), JSON.stringify(adapter, null, 2));
  return { dir, adapter };
}

export async function linkWorkflow(repoRoot, taskId, workflowId = "wf-1") {
  const manifest = await readManifest(repoRoot, taskId);
  if (!manifest) throw new Error(`linkWorkflow: missing manifest ${taskId}`);
  await writeManifest(repoRoot, { ...manifest, workflowId });
}

export function cleanupFixture(repo) {
  try {
    rmSync(repo.dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
