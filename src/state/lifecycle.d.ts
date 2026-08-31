/**
 * Type companion for the runtime `src/state/lifecycle.js`.
 *
 * The runtime exports STATES, createManifest, transition, canTransition,
 * isTerminal, mustRerunReview, mustRerunVerifier. This file mirrors
 * those exports so a `tsc --checkJs` consumer sees the same surface
 * the runtime actually exposes.
 */

export type LifecycleState =
  | "issue-linked"
  | "worktree-created"
  | "draft-open"
  | "validating"
  | "ready"
  | "merged"
  | "cleanup-pending"
  | "cleaned"
  | "failed"
  | "aborted";

export const STATES: LifecycleState[];

export interface ManifestInput {
  taskId: string;
  repoIdentity: string;
  issueNumber: number;
  baseBranch: string;
  baseSha: string;
  branch: string;
  owner: string;
  prNumber?: number | null;
  lastPrHeadSha?: string | null;
  lastReviewerSha?: string | null;
  lastVerifierSha?: string | null;
  workflowId?: string | null;
  worktreePath?: string | null;
  now?: () => Date;
}

export interface Manifest {
  schemaVersion: 2;
  taskId: string;
  repoIdentity: string;
  issueNumber: number;
  prNumber: number | null;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string | null;
  lastPrHeadSha: string | null;
  lastReviewerSha: string | null;
  lastVerifierSha: string | null;
  workflowId: string | null;
  owner: string;
  state: LifecycleState;
  transitionLog: Array<{
    from: LifecycleState;
    to: LifecycleState;
    at: number;
    reason?: string;
  }>;
  fatalReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionResult {
  ok: boolean;
  from: LifecycleState;
  to?: LifecycleState;
  attempted?: LifecycleState;
  at?: number;
  reason?: string;
}

export function createManifest(input: ManifestInput): Manifest;

export function transition(
  manifest: Manifest | null | undefined,
  to: LifecycleState,
  opts?: { reason?: string; now?: () => Date },
): TransitionResult;

export function canTransition(from: LifecycleState, to: LifecycleState): boolean;

export function isTerminal(state: LifecycleState): boolean;

export function mustRerunReview(previousSha: string | null, currentSha: string | null): boolean;

export function mustRerunVerifier(previousSha: string | null, currentSha: string | null): boolean;
