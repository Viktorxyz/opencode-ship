/**
 * Lifecycle state machine for one issue → one worktree → one PR → one merge → one cleanup.
 *
 * State transitions are explicit, idempotent, and recoverable after a
 * crash. Each transition records a monotonic counter so that the
 * manifest can be replayed deterministically.
 *
 * The transition table:
 *
 *   issue-linked      -> worktree-created, failed, aborted
 *   worktree-created  -> draft-open, validating, failed, aborted
 *   draft-open        -> validating, failed, aborted
 *   validating        -> ready, draft-open, failed, aborted
 *   ready             -> merged, validating, failed, aborted
 *   merged            -> cleanup-pending, failed, aborted
 *   cleanup-pending   -> cleaned, failed, aborted
 *   cleaned           -> (terminal)
 *   failed            -> aborted
 *   aborted           -> (terminal)
 *
 * Idempotent self-transitions are allowed and recorded as a no-op
 * entry in the transition log so callers that re-enter a tool don't
 * have to special-case the "already here" state.
 */

export const STATES = [
  "issue-linked",
  "worktree-created",
  "draft-open",
  "validating",
  "ready",
  "merged",
  "cleanup-pending",
  "cleaned",
  "failed",
  "aborted",
];

const TERMINAL = new Set(["cleaned", "aborted"]);

const NEXT = {
  "issue-linked": ["issue-linked", "worktree-created", "aborted", "failed"],
  "worktree-created": ["worktree-created", "draft-open", "validating", "aborted", "failed"],
  "draft-open": ["draft-open", "validating", "aborted", "failed"],
  "validating": ["validating", "ready", "draft-open", "aborted", "failed"],
  "ready": ["ready", "merged", "validating", "aborted", "failed"],
  "merged": ["merged", "cleanup-pending", "aborted", "failed"],
  "cleanup-pending": ["cleanup-pending", "cleaned", "aborted", "failed"],
  "cleaned": ["cleaned"],
  "failed": ["failed", "aborted"],
  "aborted": ["aborted"],
};

export function transition(m, to, opts) {
  opts = opts ?? {};
  if (!m || typeof m !== "object") {
    return { ok: false, from: undefined, attempted: to, reason: "manifest is missing" };
  }
  if (!STATES.includes(m.state)) {
    return { ok: false, from: m.state, attempted: to, reason: `manifest state ${m.state} is not recognised` };
  }
  if (!STATES.includes(to)) {
    return { ok: false, from: m.state, attempted: to, reason: `target state ${to} is not recognised` };
  }
  const allowed = NEXT[m.state];
  if (!allowed.includes(to)) {
    return { ok: false, from: m.state, attempted: to, reason: `transition from ${m.state} to ${to} is not permitted` };
  }
  const now = (opts.now ?? (() => new Date()))();
  const at = now.getTime();
  const entry = { from: m.state, to, at };
  if (opts.reason !== undefined) entry.reason = opts.reason;
  const next = {
    ...m,
    state: to,
    transitionLog: [...m.transitionLog, entry],
    updatedAt: now.toISOString(),
  };
  if (to === "failed") {
    next.fatalReason = opts.reason ?? "unspecified";
  }
  return { ok: true, from: m.state, to, at, reason: opts.reason };
}

export function createManifest(input) {
  const now = (input.now ?? (() => new Date()))();
  return {
    schemaVersion: 2,
    taskId: input.taskId,
    repoIdentity: input.repoIdentity,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber ?? null,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    branch: input.branch,
    worktreePath: input.worktreePath ?? null,
    lastPrHeadSha: input.lastPrHeadSha ?? null,
    lastReviewerSha: input.lastReviewerSha ?? null,
    lastVerifierSha: input.lastVerifierSha ?? null,
    workflowId: input.workflowId ?? null,
    owner: input.owner,
    state: "issue-linked",
    transitionLog: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function canTransition(from, to) {
  return NEXT[from]?.includes(to) === true;
}

export function isTerminal(s) {
  return TERMINAL.has(s);
}

export function mustRerunReview(previousSha, currentSha) {
  return previousSha !== currentSha;
}

export function mustRerunVerifier(previousSha, currentSha) {
  return previousSha !== currentSha;
}
