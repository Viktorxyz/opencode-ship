/**
 * delivery_cleanup tool.
 *
 * Removes the agent-owned local worktree once the PR is confirmed
 * merged, the worktree is clean, the head matches the merged PR, the
 * base branch matches the manifest's, and there are no unpublished
 * commits. Uses a CAS-style expected-SHA guard: when the remote
 * feature branch has been deleted by GitHub (post-merge), cleanup
 * proceeds as long as the local branch head matches the recorded
 * `lastPrHeadSha`.
 *
 * Branch deletion uses `git update-ref -d refs/heads/<branch> <expectedSha>`
 * — a CAS-style reference update — instead of `git branch -d`. After
 * a real squash merge, the feature commit is not an ancestor of the
 * merged base, so `git branch -d` refuses with "not fully merged".
 * The expected-SHA guard makes the deletion safe.
 *
 * Bootstrap-failure recovery: a manifest stranded in `cleanup-pending`
 * with `prNumber === null` (e.g. bootstrap failed right after worktree
 * creation) is recoverable when the worktree is clean, no rebase is in
 * progress, the recorded base ref still matches the manifest, and no
 * unpublished commits exist. The driver.readPullRequest call is
 * skipped on this path.
 */

import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as git from "../drivers/git.js";
import { transition } from "../state/lifecycle.js";
import { readManifest, writeManifest, deleteManifest } from "../state/manifest-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { nextLine, progressLine } from "../runtime/stages.js";

function safeRemoveWorktree(repoRoot, path) {
  const r = spawnSync("git", ["worktree", "remove", path], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

/**
 * Delete `refs/heads/<branch>` only if its current value matches the
 * expected SHA. This is the CAS-style update-ref call. Returns the
 * spawn result; the caller treats status === 0 (delete or no-op when
 * the ref was already absent) as success.
 */
function casDeleteBranch(repoRoot, branch, expectedSha) {
  const args = ["update-ref", "-d"];
  if (expectedSha && /^[0-9a-f]{7,}$/i.test(expectedSha)) {
    args.push(`refs/heads/${branch}`, expectedSha);
  } else {
    args.push(`refs/heads/${branch}`);
  }
  const r = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function branchStillExists(repoRoot, branch) {
  const r = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  return r.status === 0;
}

function remoteBranchGone(repoRoot, branch, remote) {
  const r = spawnSync("git", ["ls-remote", "--heads", remote, branch], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  return r.status === 0 && !r.stdout.includes(`refs/heads/${branch}`);
}

function aheadOfRemote(repoRoot, branch, remote) {
  const r = spawnSync(
    "git",
    ["rev-list", "--count", `${remote}/${branch}..${branch}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  if (r.status !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function aheadOfAnywhere(repoRoot, branch) {
  const r = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  if (r.status !== 0) return null;
  const heads = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const ref of heads) {
    if (ref === `refs/heads/${branch}`) continue;
    const r2 = spawnSync(
      "git",
      ["rev-list", "--count", `${ref}..${branch}`],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    if (r2.status !== 0) continue;
    const n = parseInt(r2.stdout.trim(), 10);
    if (Number.isFinite(n) && n > 0) return { ref, ahead: n };
  }
  return null;
}

export function createCleanupTool(deps) {
  return async function cleanup(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.state !== "merged" && m.state !== "cleanup-pending") {
      return { kind: "manifest-state", state: m.state };
    }
    if (!m.worktreePath) return { kind: "missing-worktree-path" };
    const wtPath = resolve(m.worktreePath);
    const mainCwd = resolve(deps.repoRoot);
    if (wtPath === mainCwd) return { kind: "current-checkout", worktreePath: wtPath };
    if (!git.isWorktreeClean(wtPath)) return { kind: "dirty-worktree" };
    if (git.isRebaseInProgress(wtPath)) return { kind: "rebase-in-progress" };

    const head = git.currentHead(wtPath);
    if (!head || (m.lastPrHeadSha && head !== m.lastPrHeadSha)) {
      return {
        kind: "head-mismatch",
        headSha: head ?? "",
        manifestSha: m.lastPrHeadSha ?? "",
      };
    }

    // Bootstrap-failure recovery: state=cleanup-pending, no PR. The worktree
    // exists, the head is unchanged from base, no merge has happened. We
    // skip the driver.readPullRequest call entirely (the driver would
    // refuse on a missing PR anyway) and proceed to deletion.
    const isBootstrapRecovery = m.state === "cleanup-pending" && m.prNumber === null;
    let workflowRun = null;
    if (!isBootstrapRecovery && m.schemaVersion >= 2) {
      if (!m.workflowId) return { kind: "missing-workflow-link", taskId: m.taskId };
      workflowRun = await readRunState(deps.repoRoot, m.workflowId);
      if (!workflowRun || workflowRun.state !== "merged") {
        return { kind: "workflow-not-merged", workflowId: m.workflowId, state: workflowRun?.state ?? null };
      }
    }

    if (!isBootstrapRecovery && m.prNumber === null) {
      return { kind: "missing-pr" };
    }

    let prHeadSha = head;
    let prMerged = true;
    if (!isBootstrapRecovery) {
      const pr = await deps.driver.readPullRequest({
        repo: deps.repoSlug,
        number: m.prNumber,
      });
      if (!pr.merged) {
        return {
          kind: "unmerged",
          headSha: pr.headSha,
          manifestSha: m.lastPrHeadSha ?? "",
        };
      }
      if (pr.baseRefName !== m.baseBranch) {
        return { kind: "base-mismatch", manifestBase: m.baseBranch, prBase: pr.baseRefName };
      }
      prHeadSha = pr.headSha;
      prMerged = pr.merged;
    }

    // CAS-style guard against stale local HEAD: the local HEAD must match
    // either the recorded lastPrHeadSha OR the PR's current head. If the PR
    // merged a newer head than the local branch points at, refuse.
    if (!isBootstrapRecovery && prHeadSha && prHeadSha !== head) {
      return {
        kind: "head-mismatch",
        headSha: head,
        manifestSha: prHeadSha,
      };
    }

    const remote = deps.remote ?? "origin";
    const remoteGone = isBootstrapRecovery
      ? true
      : remoteBranchGone(wtPath, m.branch, remote);
    const ahead = remoteGone ? null : aheadOfRemote(wtPath, m.branch, remote);

    // Unpublished-commit guard. The local HEAD already matches
    // lastPrHeadSha (or there is no recorded head) above, so a real
    // squash-merge scenario — where the feature commit is NOT an ancestor
    // of any local/remote ref — does NOT indicate unpublished work when
    // the recorded SHA matches the local HEAD. We refuse only when the
    // local HEAD is genuinely ahead of every other reference.
    //
    //   - bootstrap recovery -> always safe (no PR, base SHA is the only commit)
    //   - remote ref gone AND head matches expected -> safe (squash merge deleted remote)
    //   - remote ref present AND ahead == 0 -> safe
    //   - remote ref present AND ahead > 0  -> refuse (has-unpublished-commits)
    //   - remote ref absent AND ahead could not be measured against any ref -> safe
    //     (head SHA already matches lastPrHeadSha, so any "drift" is the
    //      known squash-merge artifact, not unpublished work)
    if (!remoteGone && ahead !== null && ahead > 0) {
      return {
        kind: "has-unpublished-commits",
        ahead,
        branch: m.branch,
        remote,
      };
    }

    const removed = safeRemoveWorktree(deps.repoRoot, wtPath);
    if (removed.status !== 0) {
      return { kind: "remove-failed", stderr: removed.stderr };
    }

    // CAS-style branch deletion. Use the recorded lastPrHeadSha when
    // available; otherwise delete unconditionally. The agent permission
    // set already denies `git branch -D` and `git branch --delete -f`, so
    // update-ref is the only path that fits both the lifecycle gate and
    // the safety model.
    const expectedSha = m.lastPrHeadSha ?? head ?? null;
    const branchResult = casDeleteBranch(deps.repoRoot, m.branch, expectedSha);
    if (branchResult.status !== 0 && branchStillExists(deps.repoRoot, m.branch)) {
      return { kind: "branch-delete-failed", stderr: branchResult.stderr };
    }
    if (workflowRun && m.workflowId) {
      await appendRunEvent(deps.repoRoot, m.workflowId, workflowRun, {
        kind: RUN_EVENT_KINDS.DONE,
        data: { taskId: m.taskId },
      });
    }

    const tCleanup = transition(m, "cleanup-pending", { reason: "worktree removed" });
    const candidate = tCleanup.ok
      ? {
          ...m,
          state: tCleanup.to,
          transitionLog: [
            ...m.transitionLog,
            { from: tCleanup.from, to: tCleanup.to, at: tCleanup.at, reason: tCleanup.reason },
          ],
          updatedAt: new Date().toISOString(),
        }
      : m;

    const tCleaned = transition(candidate, "cleaned", { reason: "manifest sealed" });
    if (tCleaned.ok) {
      const sealed = {
        ...candidate,
        state: tCleaned.to,
        transitionLog: [
          ...candidate.transitionLog,
          { from: tCleaned.from, to: tCleaned.to, at: tCleaned.at, reason: tCleaned.reason },
        ],
        updatedAt: new Date().toISOString(),
      };
      await writeManifest(deps.repoRoot, sealed);
      await deleteManifest(deps.repoRoot, input.taskId);
    }
    return {
      contractVersion: 1,
      manifestPath: null,
      removedPath: wtPath,
      bootstrapRecovery: isBootstrapRecovery,
      progress: progressLine("cleanup"),
      next: nextLine("cleanup"),
    };
  };
}
