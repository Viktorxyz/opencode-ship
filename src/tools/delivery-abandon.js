/**
 * delivery_abandon tool.
 *
 * Explicitly abandons a closed, unmerged delivery attempt. Never
 * closes a PR. Writes immutable intent before cleanup and immutable
 * completion after CAS-safe worktree/branch/manifest removal.
 */

import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import * as git from "../drivers/git.js";
import { readManifest, deleteManifest } from "../state/manifest-store.js";
import {
  readAbandon,
  publishAbandonIntent,
  publishAbandonCompletion,
} from "../state/abandon-store.js";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { validateLinkedWorktree } from "../skills/worktree.js";
import { failure, success } from "./envelope.js";
import { readFile } from "node:fs/promises";

function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function defaultRemoveWorktree(repoRoot, path) {
  return runGit(["worktree", "remove", path], repoRoot);
}

function defaultDeleteBranch(repoRoot, branch, expectedSha) {
  const args = ["update-ref", "-d", `refs/heads/${branch}`];
  if (expectedSha && /^[0-9a-f]{7,}$/i.test(expectedSha)) args.push(expectedSha);
  return runGit(args, repoRoot);
}

function branchExists(repoRoot, branch) {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).status === 0;
}

function remoteBranchHead(repoRoot, remote, branch) {
  const r = runGit(["ls-remote", "--heads", remote, branch], repoRoot);
  if (r.status !== 0) return { ok: false, sha: null, present: false };
  const line = r.stdout.split("\n").find((row) => row.includes(`refs/heads/${branch}`));
  if (!line) return { ok: true, sha: null, present: false };
  return { ok: true, sha: line.split(/\s+/)[0], present: true };
}

function unpublishedAhead(repoRoot, remote, branch) {
  const r = runGit(["rev-list", "--count", `${remote}/${branch}..${branch}`], repoRoot);
  if (r.status !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function refuse(opId, kind, extras = {}) {
  return failure("abandon", kind, {
    operationId: opId,
    retryable: false,
    details: { kind, ...extras },
  });
}

async function readRunSnapshot(repoRoot, workflowId) {
  try {
    const common = await resolveGitCommonDir(repoRoot);
    const path = join(opencodeShipStateDir(common), "runs", workflowId, "run.json");
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function validateLiveAttempt({ deps, manifest, subject, opId }) {
  if (!manifest.prNumber) return refuse(opId, "missing-pr");
  if (!manifest.worktreePath) return refuse(opId, "missing-worktree-path");
  const pr = await deps.driver.readPullRequest({
    repo: deps.repoSlug,
    number: manifest.prNumber,
  });
  if (pr.merged || pr.state === "MERGED") return refuse(opId, "pr-merged");
  if (pr.state !== "CLOSED") return refuse(opId, "pr-open");
  if (pr.headRefName && pr.headRefName !== manifest.branch) {
    return refuse(opId, "branch-mismatch", { expected: manifest.branch, received: pr.headRefName });
  }
  if (pr.baseRefName && pr.baseRefName !== manifest.baseBranch) {
    return refuse(opId, "base-mismatch", { expected: manifest.baseBranch, received: pr.baseRefName });
  }
  const linked = await validateLinkedWorktree(deps.repoRoot, manifest.worktreePath);
  if (!linked.ok) {
    return refuse(opId, "invalid-worktree", { reason: linked.kind, message: linked.message });
  }
  if (!git.isWorktreeClean(linked.path)) return refuse(opId, "dirty-worktree");
  if (git.isRebaseInProgress(linked.path)) return refuse(opId, "rebase-in-progress");
  const head = git.currentHead(linked.path);
  if (!head || head !== manifest.lastPrHeadSha || head !== pr.headSha) {
    return refuse(opId, "head-mismatch", {
      local: head ?? "",
      manifest: manifest.lastPrHeadSha ?? "",
      pr: pr.headSha ?? "",
    });
  }
  const remote = deps.remote ?? "origin";
  const remoteHead = remoteBranchHead(linked.path, remote, manifest.branch);
  if (remoteHead.ok && remoteHead.present && remoteHead.sha !== head) {
    return refuse(opId, "remote-diverged", { local: head, remote: remoteHead.sha });
  }
  const ahead = unpublishedAhead(linked.path, remote, manifest.branch);
  if (ahead !== null && ahead > 0) {
    return refuse(opId, "has-unpublished-commits", { ahead, branch: manifest.branch, remote });
  }
  if (manifest.workflowId) {
    const snapshot = await readRunSnapshot(deps.repoRoot, manifest.workflowId);
    if (snapshot?.state === "ready") return refuse(opId, "workflow-ready");
    if (snapshot?.state === "merged") return refuse(opId, "workflow-merged");
  }
  return {
    ok: true,
    intent: {
      schemaVersion: 1,
      taskId: manifest.taskId,
      issueNumber: manifest.issueNumber,
      prNumber: manifest.prNumber,
      branch: manifest.branch,
      worktreePath: linked.path,
      headSha: head,
      workflowId: manifest.workflowId ?? null,
      subject,
      requestedAt: new Date().toISOString(),
    },
  };
}

async function resumeCleanup({ deps, intent, opId }) {
  const removeWorktree = deps.removeWorktree ?? defaultRemoveWorktree;
  const deleteBranch = deps.deleteBranch ?? defaultDeleteBranch;
  const removeManifest = deps.deleteManifest ?? deleteManifest;
  let removedWorktree = !existsSync(intent.worktreePath);
  if (!removedWorktree) {
    let removed;
    try {
      removed = await Promise.resolve(removeWorktree(deps.repoRoot, intent.worktreePath));
    } catch (err) {
      return refuse(opId, "remove-failed", { stderr: String(err?.message ?? err) });
    }
    if (removed?.status !== 0 && existsSync(intent.worktreePath)) {
      return refuse(opId, "remove-failed", { stderr: removed?.stderr ?? "" });
    }
    removedWorktree = !existsSync(intent.worktreePath);
  }
  let deletedBranch = !branchExists(deps.repoRoot, intent.branch);
  if (!deletedBranch) {
    let deleted;
    try {
      deleted = await Promise.resolve(deleteBranch(deps.repoRoot, intent.branch, intent.headSha));
    } catch (err) {
      return refuse(opId, "branch-delete-failed", { stderr: String(err?.message ?? err) });
    }
    if (deleted?.status !== 0 && branchExists(deps.repoRoot, intent.branch)) {
      return refuse(opId, "branch-delete-failed", { stderr: deleted?.stderr ?? "" });
    }
    deletedBranch = !branchExists(deps.repoRoot, intent.branch);
  }
  try {
    await Promise.resolve(removeManifest(deps.repoRoot, intent.taskId));
  } catch (err) {
    return refuse(opId, "manifest-delete-failed", { stderr: String(err?.message ?? err) });
  }
  const remaining = await readManifest(deps.repoRoot, intent.taskId);
  const deletedManifest = remaining === null;
  const completion = {
    schemaVersion: 1,
    taskId: intent.taskId,
    intentHash: intent.intentHash,
    removedWorktree,
    deletedBranch,
    deletedManifest,
    completedAt: new Date().toISOString(),
  };
  const published = await publishAbandonCompletion(deps.repoRoot, completion);
  if (!published.ok) return refuse(opId, published.kind);
  return success("abandon", {
    taskId: intent.taskId,
    intentHash: intent.intentHash,
    removedWorktree,
    deletedBranch,
    deletedManifest,
  }, { operationId: opId, idempotent: published.idempotent === true });
}

export function createAbandonTool(deps) {
  return async function abandon(input) {
    const opId = input.operationId ?? `abandon-${Date.now().toString(36)}`;
    const taskId = String(input.taskId ?? "");
    const subject = String(input.subject ?? "").trim();
    if (!taskId) return refuse(opId, "missing-input", { field: "taskId" });
    if (!subject) return refuse(opId, "missing-input", { field: "subject" });
    const existing = await readAbandon(deps.repoRoot, taskId);
    if (existing.completion) {
      return success("abandon", {
        taskId,
        intentHash: existing.completion.intentHash,
        removedWorktree: existing.completion.removedWorktree,
        deletedBranch: existing.completion.deletedBranch,
        deletedManifest: existing.completion.deletedManifest,
      }, { operationId: opId, idempotent: true });
    }
    if (existing.intent) {
      if (existing.intent.subject !== subject || existing.intent.taskId !== taskId) {
        return refuse(opId, "abandon-conflict");
      }
      return resumeCleanup({ deps, intent: existing.intent, opId });
    }
    const manifest = await readManifest(deps.repoRoot, taskId);
    if (!manifest) return refuse(opId, "missing-manifest", { taskId });
    const validated = await validateLiveAttempt({ deps, manifest, subject, opId });
    if (!validated.ok) return validated;
    const publishedIntent = await publishAbandonIntent(deps.repoRoot, validated.intent);
    if (!publishedIntent.ok) return refuse(opId, publishedIntent.kind);
    return resumeCleanup({ deps, intent: publishedIntent.record, opId });
  };
}
