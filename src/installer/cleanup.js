/*
 * Post-merge cleanup helpers.
 *
 * After an authorised `delivery_merge`, the lifecycle reaches the
 * `merged` state. The plugin invokes `tryImmediateCleanup` as soon
 * as it observes that state, so the agent-owned worktree, the local
 * branch, and the manifest are removed without further user action.
 *
 * If a step fails we record the failure under
 * `<git-common-dir>/opencode-ship/cleanup-pending.json` so the
 * next delivery task or plugin startup retries. Cleanup retry state
 * lives in the Git common dir rather than the install lock so the
 * install lock stays a pure install-provenance record and a failed
 * cleanup never dirties a tracked control-plane file.
 *
 * Cleanup is always precondition bound: merged PR, manifest-owned
 * worktree inside the configured root, clean state, expected HEAD,
 * no rebase, no unpublished commits, and worktree path under the
 * configured worktree.root.
 */

import { spawnSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { listManifests, readManifest, writeManifest, deleteManifest } from "../state/manifest-store.js";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

function spawn(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function casDeleteBranch(repoRoot, branch, expectedSha) {
  const argv = ["update-ref", "-d"];
  if (expectedSha && /^[0-9f]{7,}$/i.test(expectedSha)) {
    argv.push(`refs/heads/${branch}`, expectedSha);
  } else {
    argv.push(`refs/heads/${branch}`);
  }
  return spawn(repoRoot, argv).status ?? -1;
}

function safeRemoveWorktree(repoRoot, target) {
  const r = spawn(repoRoot, ["worktree", "remove", target]);
  return { status: r.status, stderr: r.stderr };
}

function worktreeRootOf(adapter) {
  return adapter?.worktree?.root ?? ".worktrees";
}

function cleanupPendingPathSync(repoRoot) {
  const commonDir = pathResolve(repoRoot, ".git");
  if (!existsSync(commonDir)) return null;
  const path = pathResolve(commonDir, "opencode-ship", "cleanup-pending.json");
  return path;
}

async function cleanupPendingPath(repoRoot) {
  const common = await resolveGitCommonDir(repoRoot);
  return pathResolve(opencodeShipStateDir(common), "cleanup-pending.json");
}

async function loadCleanupPending(repoRoot) {
  const path = await cleanupPendingPath(repoRoot);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveCleanupPending(repoRoot, entries) {
  const path = await cleanupPendingPath(repoRoot);
  const dir = pathResolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(dedupePending(entries), null, 2) + "\n", "utf8");
}

function dedupePending(entries) {
  const byTask = new Map();
  for (const e of entries) {
    if (!e || !e.taskId) continue;
    byTask.set(e.taskId, e);
  }
  return [...byTask.values()];
}

async function appendCleanupPending(repoRoot, entry) {
  const current = await loadCleanupPending(repoRoot);
  const next = [...current, entry];
  await saveCleanupPending(repoRoot, next);
  return next;
}

async function clearCleanupPending(repoRoot, taskId) {
  const current = await loadCleanupPending(repoRoot);
  await saveCleanupPending(repoRoot, current.filter((entry) => entry.taskId !== taskId));
}

function reject(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export async function tryImmediateCleanup({ repoRoot, taskId, adapter }) {
  if (!repoRoot || !taskId) return reject("missing-args");
  const m = await readManifest(repoRoot, taskId);
  if (!m) return reject("missing-manifest");
  if (m.state !== "merged" && m.state !== "cleanup-pending") {
    return reject("manifest-state", { state: m.state });
  }
  if (!m.worktreePath) return reject("missing-worktree-path");
  const wtPath = pathResolve(m.worktreePath);
  const mainCwd = pathResolve(repoRoot);
  if (wtPath === mainCwd) return reject("current-checkout", { worktreePath: wtPath });
  const rootAbs = pathResolve(repoRoot, worktreeRootOf(adapter));
  if (!wtPath.startsWith(rootAbs + "/")) {
    return reject("worktree-out-of-root", { expected: rootAbs, got: wtPath });
  }

  const pending = (await loadCleanupPending(repoRoot)).find((entry) => entry.taskId === taskId);
  const stage = pending?.stage ?? "worktree-remove";
  if (!["worktree-remove", "branch-delete", "manifest-seal"].includes(stage)) {
    return reject("cleanup-stage", { stage });
  }
  let headSha = m.lastPrHeadSha ?? "";

  if (stage === "worktree-remove") {
    const status = spawn(wtPath, ["status", "--porcelain"]);
    if (status.status === 0) {
      if (status.stdout.trim().length > 0) return reject("dirty-worktree");
      const rebase = spawn(wtPath, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
      if (rebase.status === 0) return reject("rebase-in-progress");
      const head = spawn(wtPath, ["rev-parse", "HEAD"]);
      if (head.status !== 0) return reject("no-head");
      headSha = head.stdout.trim();
      if (m.lastPrHeadSha && headSha !== m.lastPrHeadSha) {
        return reject("head-mismatch", { expected: m.lastPrHeadSha, actual: headSha });
      }
      const removed = safeRemoveWorktree(repoRoot, wtPath);
      if (removed.status !== 0) {
        await appendCleanupPending(repoRoot, {
          taskId, failedAt: new Date().toISOString(),
          stage: "worktree-remove", reason: removed.stderr ?? "non-zero exit",
        });
        return reject("remove-failed", { detail: removed.stderr });
      }
    } else if (!headSha) {
      return reject("no-head");
    }
    await appendCleanupPending(repoRoot, {
      taskId, failedAt: new Date().toISOString(), stage: "branch-delete", reason: "resume cleanup",
    });
  }

  if (stage !== "manifest-seal") {
    const branchDelete = casDeleteBranch(repoRoot, m.branch, headSha);
    const branchStillThere = spawn(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${m.branch}`]);
    if (branchDelete !== 0 && branchStillThere.status === 0) {
      await appendCleanupPending(repoRoot, {
        taskId, failedAt: new Date().toISOString(),
        stage: "branch-delete", reason: "git update-ref failed",
      });
      return reject("branch-delete-failed");
    }
    await appendCleanupPending(repoRoot, {
      taskId, failedAt: new Date().toISOString(),
      stage: "manifest-seal", reason: "resume cleanup",
    });
  }

  const next = {
    ...m,
    state: "cleaned",
    transitionLog: [
      ...m.transitionLog,
      { from: m.state, to: "cleaned", at: Date.now(), reason: "immediate cleanup" },
    ],
    updatedAt: new Date().toISOString(),
  };
  await writeManifest(repoRoot, next).catch(() => null);
  await deleteManifest(repoRoot, taskId);
  await clearCleanupPending(repoRoot, taskId);
  return { ok: true, removedPath: wtPath, sealed: true };
}

export async function listPending(repoRoot) {
  const all = await listManifests(repoRoot).catch(() => []);
  const manifests = all.filter((m) => m.state === "merged" || m.state === "cleanup-pending");
  const queued = await loadCleanupPending(repoRoot);
  const byTask = new Map(manifests.map((manifest) => [manifest.taskId, manifest]));
  for (const entry of queued) {
    if (!byTask.has(entry.taskId)) byTask.set(entry.taskId, entry);
  }
  return [...byTask.values()];
}
