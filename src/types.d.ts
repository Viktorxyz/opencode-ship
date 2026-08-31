/**
 * Public type declarations for the opencode-ship package.
 *
 * The package ships plain JavaScript ESM sources; this declaration
 * file gives TypeScript consumers the surface they need to typecheck
 * `import` statements without falling back to `any`. Every public
 * value export from `src/index.js` is declared here; the consumer
 * fixture under `tests/fixtures/consumer.ts` enforces that.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Sha = string;
export type Branch = string;
export type RepoSlug = `${string}/${string}`;
export type IssueNumber = number;
export type PullRequestNumber = number;

export type ContractVersion = 1;

export interface AdapterLock {
  contractVersion: ContractVersion;
  adapterSha256: Sha;
  writtenAt: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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

export interface LifecycleTransition {
  from: LifecycleState;
  to: LifecycleState;
  at: number;
  reason?: string;
}

export interface Manifest {
  schemaVersion: 2;
  taskId: string;
  repoIdentity: RepoSlug;
  issueNumber: IssueNumber | null;
  prNumber: PullRequestNumber | null;
  baseBranch: Branch;
  baseSha: Sha;
  branch: Branch;
  worktreePath: string | null;
  lastPrHeadSha: Sha | null;
  lastReviewerSha: Sha | null;
  lastVerifierSha: Sha | null;
  workflowId: string | null;
  owner: string;
  state: LifecycleState;
  transitionLog: LifecycleTransition[];
  fatalReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManifestInput {
  taskId: string;
  repoIdentity: RepoSlug;
  issueNumber: IssueNumber | null;
  baseBranch: Branch;
  baseSha: Sha;
  branch: Branch;
  owner: string;
  prNumber?: PullRequestNumber | null;
  lastPrHeadSha?: Sha | null;
  workflowId?: string | null;
}

export interface IssueSummary {
  number: IssueNumber;
  url: string;
  state: "OPEN" | "CLOSED";
  pullRequest: PullRequestSummary | null;
}

export interface PullRequestSummary {
  number: PullRequestNumber;
  url: string;
  baseRefName: Branch;
  headRefName: Branch;
  headSha: Sha;
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  merged: boolean;
  mergedAt: string | null;
}

export interface CheckSummary {
  name: string;
  state: "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled" | "timed_out" | "action_required" | "stale" | "queued" | "in_progress" | "requested";
  bucket: "pass" | "fail" | "pending" | "skip" | "neutral";
}

export interface EnsureIssueResult {
  summary: IssueSummary;
  created: boolean;
}

export interface GithubDriver {
  ensureIssue(args: { repo: RepoSlug; title: string; body: string; labels: readonly string[] }): Promise<EnsureIssueResult>;
  openDraftPullRequest(args: { repo: RepoSlug; head: Branch; base: Branch; title: string; body: string; issueNumber: IssueNumber }): Promise<PullRequestSummary>;
  updatePullRequestBody(args: { repo: RepoSlug; number: PullRequestNumber; body: string }): Promise<void>;
  markReady(args: { repo: RepoSlug; number: PullRequestNumber }): Promise<void>;
  mergePullRequest(args: { repo: RepoSlug; number: PullRequestNumber; subject: string }): Promise<PullRequestSummary>;
  readPullRequest(args: { repo: RepoSlug; number: PullRequestNumber }): Promise<PullRequestSummary>;
  readChecks(args: { repo: RepoSlug; sha?: Sha; number?: PullRequestNumber; branch?: Branch; required: readonly string[] }): Promise<CheckSummary[]>;
  comment(args: { repo: RepoSlug; number: PullRequestNumber; body: string }): Promise<void>;
  refreshHead(args: { repo: RepoSlug; number: PullRequestNumber }): Promise<Sha>;
}

export interface CreateGhDriverOptions {
  runner?: (args: readonly string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type GhRunner = (args: readonly string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

export interface GhStubHandle {
  driver: GithubDriver;
  queue: Array<{ match: (args: readonly string[]) => boolean; status?: number; stdout?: string; stderr?: string }>;
}

export interface RepoRef {
  owner: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface Adapter {
  contractVersion: 1;
  repository: {
    remote: string;
    defaultBranch?: { discover?: boolean; name?: Branch };
  };
  forge?: {
    driver: "github";
    issueRequired?: boolean;
    draftAfterFirstCommit?: boolean;
    issueClosingSyntax?: boolean;
  };
  worktree?: {
    root: string;
    branchTemplate: string;
    bootstrap?: readonly (readonly string[])[];
  };
  verification?: {
    commands: readonly { id: string; argv: readonly string[]; timeoutMs?: number }[];
    requireCleanDiffAfter?: boolean;
    invalidateOnHeadChange?: boolean;
  };
  review?: {
    agent: string;
    required: boolean;
    invalidateOnHeadChange: boolean;
  };
  ci?: {
    driver: "github-status-checks";
    requiredChecks: readonly string[];
    wait: boolean;
    flakyRetry: 0 | 1;
  };
  ready?: {
    requires: readonly ("review" | "local-verification" | "remote-ci")[];
    stopAfterReady: boolean;
  };
  merge?: {
    strategy: "squash";
    policy: "explicit-user-request-only";
    requireFreshGates: boolean;
  };
  cleanup?: {
    when: "next-task";
    requires: readonly ("pr-merged" | "worktree-clean" | "no-unpublished-commits")[];
  };
}

export type AdapterLoadResult =
  | { ok: true; adapter: Adapter; path: string; sha256: Sha }
  | { ok: false; error: { kind: "missing" | "parse" | "contract"; path: string; message?: string; issues?: readonly string[] } };

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  contractVersion: 1;
  adapterPath: string | null;
  adapterSha256: Sha | null;
  lockPath: string | null;
  lockSha256: Sha | null;
  packageVersion: string | null;
  nodeVersion: string;
  ghVersion: string | null;
  gitVersion: string | null;
  checks: DoctorCheck[];
}

export type TransitionResult =
  | { ok: true; from: LifecycleState; to: LifecycleState; at: number; reason?: string }
  | { ok: false; from: LifecycleState; attempted: LifecycleState; reason: string };

export interface GateSnapshot {
  prHead: Sha | null;
  reviewerSha: Sha | null;
  verifierSha: Sha | null;
  checks: readonly CheckSummary[];
  missingChecks: readonly string[];
  failingChecks: readonly string[];
  pendingChecks: readonly string[];
}

export interface GateCheck {
  ok: boolean;
  reason?: string;
  snapshot: GateSnapshot;
}

export interface RecoveryReport {
  total: number;
  pendingCleanup: number;
  orphanWorktrees: number;
  cleaned: number;
  notes: string[];
}

export interface WorktreeRecordShape {
  path: string;
  branch: string;
  head: Sha;
}

export type RunCommandResult =
  | { ok: true; status: number; stdout: string; stderr: string }
  | { ok: false; error: Error };

// ---------------------------------------------------------------------------
// Tool factory deps shapes
// ---------------------------------------------------------------------------

export interface BaseToolDeps {
  driver: GithubDriver;
  repoRoot: string;
  repoSlug: RepoSlug;
  owner: string;
  adapter: Adapter;
  remote?: string;
  packageVersion?: string;
}

export interface InspectToolDeps {
  driver?: GithubDriver;
  repoRoot: string;
  repoSlug: RepoSlug;
  owner?: string;
  adapter?: Adapter | null;
  packageVersion: string;
  remote?: string;
}

export interface IssueToolInput {
  taskId: string;
  title: string;
  body?: string;
  baseBranch: string;
  baseSha?: string;
  branch: string;
  labels?: readonly string[];
}

export interface WorktreeToolInput {
  taskId: string;
  branch: string;
  worktreeRelativePath: string;
}

export interface VerifyToolInput {
  taskId: string;
  commandId?: string;
}

export interface ReviewToolInput {
  taskId: string;
  status: "pass" | "fail" | "blocked" | "partial";
  headSha?: Sha;
  findings?: unknown;
  envelope?: unknown;
}

export interface PrToolInput {
  taskId: string;
  title: string;
  body: string;
}

export interface ReadyToolInput {
  taskId: string;
}

export interface MergeToolInput {
  taskId: string;
  subject: string;
}

export interface CleanupToolInput {
  taskId: string;
}

export type Envelope<TKind extends string, TData> = { kind: TKind } & TData;

// ---------------------------------------------------------------------------
// Envelope shapes (mirror the runtime tool returns)
// ---------------------------------------------------------------------------

export type IssueEnvelope = Envelope<
  "issue",
  {
    contractVersion: 1;
    created: boolean;
    issueNumber: IssueNumber;
    issueUrl: string;
    manifestPath: string;
  }
>;

export type MissingManifestEnvelope = Envelope<"missing-manifest", { taskId: string }>;
export type ManifestStateEnvelope = Envelope<"manifest-state", { state: LifecycleState }>;
export type MissingWorktreePathEnvelope = Envelope<"missing-worktree-path", Record<string, never>>;
export type MissingPrEnvelope = Envelope<"missing-pr", Record<string, never>>;
export type WorktreeExistsEnvelope = Envelope<"worktree-exists", Record<string, never>>;
export type BranchExistsLocallyEnvelope = Envelope<"branch-exists-locally", { branch: Branch }>;
export type BranchExistsRemotelyEnvelope = Envelope<"branch-exists-remotely", { branch: Branch }>;
export type RemoteFetchEnvelope = Envelope<"remote-fetch", { stderr: string }>;
export type CreateFailedEnvelope = Envelope<"create-failed", { stderr: string }>;
export type HeadChangedAfterVerifierEnvelope = Envelope<"head-changed-after-verifier", { headSha: Sha; verifierSha: Sha }>;
export type HeadChangedAfterReviewEnvelope = Envelope<"head-changed-after-review", { headSha: Sha; reviewSha: Sha }>;
export type MissingGateEnvelope = Envelope<"missing-gate", { gate: "review" | "local-verification" | "remote-ci" }>;
export type CiFailingEnvelope = Envelope<"ci-failing", { failing: readonly string[] }>;
export type CiPendingEnvelope = Envelope<"ci-pending", { pending: readonly string[] }>;
export type NotReadyEnvelope = Envelope<"not-ready", { state: LifecycleState }>;
export type WrongBaseEnvelope = Envelope<"wrong-base", { base: Branch }>;
export type HeadChangedEnvelope = Envelope<"head-changed", { headSha: Sha; manifestSha: Sha }>;
export type NotMergeableEnvelope = Envelope<"not-mergeable", { reason: string }>;
export type DirtyWorktreeEnvelope = Envelope<"dirty-worktree", Record<string, never>>;
export type RebaseInProgressEnvelope = Envelope<"rebase-in-progress", Record<string, never>>;
export type HeadMismatchEnvelope = Envelope<"head-mismatch", { headSha: Sha; manifestSha: Sha }>;
export type CurrentCheckoutEnvelope = Envelope<"current-checkout", { worktreePath: string }>;
export type UnmergedEnvelope = Envelope<"unmerged", { headSha: Sha; manifestSha: Sha }>;
export type BaseMismatchEnvelope = Envelope<"base-mismatch", { manifestBase: Branch; prBase: Branch }>;
export type HasUnpublishedCommitsEnvelope = Envelope<"has-unpublished-commits", { ahead: number }>;
export type RemoveFailedEnvelope = Envelope<"remove-failed", { stderr: string }>;
export type UnsafeCleanupEnvelope = Envelope<"unsafe-cleanup", { signals: readonly string[] }>;
export type VerifyFailedEnvelope = Envelope<"verify-failed", { commandId: string; status: number; headSha: Sha | null }>;
export type PathEscapeEnvelope = Envelope<"path-escape", { resolvedPath: string }>;
export type BootstrapFailedEnvelope = Envelope<"bootstrap-failed", { stderr: string; argv: readonly string[] }>;

// ---------------------------------------------------------------------------
// Value export declarations. The runtime values live in plain JS modules;
// these declarations are the contract that consumers rely on.
// ---------------------------------------------------------------------------

export declare const ADAPTER_CONTRACT_VERSION: ContractVersion;
export declare const ADAPTER_FILENAME: string;
export declare const LOCK_FILENAME: string;
export declare const PACKAGE_VERSION: string;
export declare const STATES: readonly LifecycleState[];

export declare const WorktreeRecord: WorktreeRecordShape;

export declare function validateAdapter(value: unknown): {
  ok: boolean;
  issues?: readonly string[];
  adapter?: Adapter;
};
export declare function loadAdapter(repoRoot: string): Promise<AdapterLoadResult>;
export declare function writeLock(repoRoot: string, adapterSha256: Sha): Promise<string>;
export declare function readLock(repoRoot: string): Promise<AdapterLock | null>;
export declare function findOpencodeDir(start: string): string | null;

export declare function createManifest(input: CreateManifestInput): Manifest;
export declare function transition(
  manifest: Manifest,
  to: LifecycleState,
  opts?: { reason?: string; now?: () => Date },
): TransitionResult;
export declare function canTransition(from: LifecycleState, to: LifecycleState): boolean;
export declare function isTerminal(state: LifecycleState): boolean;
export declare function mustRerunReview(previousSha: Sha | null, currentSha: Sha): boolean;
export declare function mustRerunVerifier(previousSha: Sha | null, currentSha: Sha): boolean;

export declare function writeManifest(repoRoot: string, manifest: Manifest): Promise<string>;
export declare function readManifest(repoRoot: string, taskId: string): Promise<Manifest | null>;
export declare function listManifests(repoRoot: string): Promise<Manifest[]>;
export declare function deleteManifest(repoRoot: string, taskId: string): Promise<void>;

export declare function isInsideWorktree(cwd: string): boolean;
export declare function isMainCheckout(cwd: string): boolean;
export declare function listWorktrees(cwd: string): WorktreeRecordShape[];
export declare function isWorktreeClean(cwd: string): boolean;
export declare function isRebaseInProgress(cwd: string): boolean;
export declare function currentBranch(cwd: string): Branch | null;
export declare function revParse(ref: string, cwd: string): Sha | null;
export declare function fetchBranch(remote: string, branch: Branch, cwd: string): { status: number; stderr: string };
export declare function remoteExists(remote: string, cwd: string): boolean;
export declare function createWorktree(opts: { cwd: string; branch: Branch; worktreePath: string; base: string }): { status: number; stderr: string };
export declare function createWorktreeFromLocal(opts: { cwd: string; branch: Branch; worktreePath: string; base: string }): { status: number; stderr: string };
export declare function worktreeExists(cwd: string, path: string): boolean;
export declare function branchExistsLocally(branch: Branch, cwd: string): boolean;
export declare function branchExistsRemotely(remote: string, branch: Branch, cwd: string): boolean;
export declare function mergeIntoFeature(branch: Branch, base: Branch, cwd: string): { status: number; stderr: string };
export declare function currentHead(cwd: string): Sha | null;
export declare function push(remote: string, branch: Branch, cwd: string): { status: number; stderr: string };
export declare function pushForceDisabled(remote: string, branch: Branch, cwd: string): { status: number; stderr: string };
export declare function defaultBranch(cwd: string): Branch | null;
export declare function mergeBaseRemoteHead(remote: string, branch: Branch, cwd: string): Sha | null;

export declare function createGhDriver(opts?: CreateGhDriverOptions): GithubDriver;
export declare function createGhStub(
  responses: Array<{
    match: (args: readonly string[]) => boolean;
    status?: number;
    stdout?: string;
    stderr?: string;
  }>,
): GhStubHandle;
export declare function parseRepoSlug(slug: string): RepoRef | null;

export declare function scanRecovery(repoRoot: string): Promise<RecoveryReport>;
export declare function wouldCleanupBeSafe(args: {
  prMerged: boolean;
  worktreeClean: boolean;
  rebaseInProgress: boolean;
  headMatchesPr: boolean;
  baseMatches: boolean;
}): boolean;
export declare function removeManifestIfSafe(repoRoot: string, taskId: string): Promise<boolean>;
export declare function recoverManifestAfterCrash(manifest: Manifest): Manifest;

export declare function doctor(repoRoot: string, packageVersion: string | null, adapter?: Adapter | null): Promise<DoctorReport>;

export declare function bucketFor(check: CheckSummary | undefined | null): "pass" | "fail" | "pending" | "skip" | "neutral";
export declare function gateSnapshot(args: {
  manifest: { adapter?: Adapter | null; lastReviewerSha?: Sha | null; lastVerifierSha?: Sha | null };
  prHead: Sha | null;
  checks: readonly CheckSummary[];
}): GateSnapshot;
export declare function checkGates(args: {
  manifest: { adapter?: Adapter | null; lastReviewerSha?: Sha | null; lastVerifierSha?: Sha | null };
  prHead: Sha | null;
  checks: readonly CheckSummary[];
  requires: readonly ("review" | "local-verification" | "remote-ci")[];
}): GateCheck;
export declare function gateFailureEnvelope(result: { reason: string; snapshot: GateSnapshot }):
  | MissingGateEnvelope
  | HeadChangedAfterReviewEnvelope
  | HeadChangedAfterVerifierEnvelope
  | Envelope<"ci-missing", { missing: readonly string[] }>
  | Envelope<"ci-failing", { failing: readonly string[] }>
  | Envelope<"ci-pending", { pending: readonly string[] }>
  | Envelope<"gate-failed", { reason: string }>;

export declare function createInspectTool(deps: InspectToolDeps): (input: { taskId: string }) => Promise<{
  contractVersion: 1;
  manifest: Manifest | null;
  doctor: DoctorReport;
}>;

export declare function createIssueTool(deps: BaseToolDeps): (input: IssueToolInput) => Promise<IssueEnvelope | Envelope<"missing-input", { field: string }> | Envelope<"lifecycle", { reason: string }>>;

export declare function createWorktreeTool(deps: BaseToolDeps): (input: WorktreeToolInput) => Promise<
  | Envelope<"worktree", { contractVersion: 1; branch: Branch; worktreePath: string; headSha: Sha; manifestPath: string }>
  | MissingManifestEnvelope
  | ManifestStateEnvelope
  | Envelope<"missing-input", { field: string }>
  | RemoteFetchEnvelope
  | BranchExistsLocallyEnvelope
  | BranchExistsRemotelyEnvelope
  | WorktreeExistsEnvelope
  | CreateFailedEnvelope
  | Envelope<"missing-base-sha", Record<string, never>>
  | Envelope<"bootstrap-invalid", { bootstrap: unknown }>
  | BootstrapFailedEnvelope
  | PathEscapeEnvelope
  | Envelope<"lifecycle", { reason: string }>
>;

export declare function createVerifyTool(deps: BaseToolDeps): (input: VerifyToolInput) => Promise<
  | Envelope<"verify", { contractVersion: 1; commandId: string; status: 0; stdoutTail: string; stderrTail: string; headSha: Sha; manifestPath: string }>
  | MissingManifestEnvelope
  | ManifestStateEnvelope
  | Envelope<"no-commands", Record<string, never>>
  | Envelope<"command-not-found", { commandId: string }>
  | Envelope<"worktree-dirty", Record<string, never>>
  | Envelope<"no-head", Record<string, never>>
  | VerifyFailedEnvelope
  | Envelope<"lifecycle", { reason: string }>
>;

export declare function createReviewTool(deps: BaseToolDeps): (input: ReviewToolInput) => Promise<
  | Envelope<"review", { contractVersion: 1; pr: PullRequestNumber; reviewerSha: Sha; manifestPath: string }>
  | MissingManifestEnvelope
  | MissingPrEnvelope
  | ManifestStateEnvelope
  | Envelope<"review-not-pass", { status: string; headSha: Sha; recordedReviewerSha: Sha | null }>
  | HeadMismatchEnvelope
>;

export declare function createPrTool(deps: BaseToolDeps): (input: PrToolInput) => Promise<
  | Envelope<"pr", { contractVersion: 1; pr: PullRequestSummary; manifestPath: string }>
  | MissingManifestEnvelope
  | ManifestStateEnvelope
  | Envelope<"lifecycle", { reason: string }>
>;

export declare function createReadyTool(deps: BaseToolDeps): (input: ReadyToolInput) => Promise<
  | Envelope<"ready", { contractVersion: 1; manifestPath: string; pr: PullRequestNumber }>
  | MissingManifestEnvelope
  | MissingPrEnvelope
  | MissingGateEnvelope
  | HeadChangedAfterReviewEnvelope
  | HeadChangedAfterVerifierEnvelope
  | Envelope<"ci-missing", { missing: readonly string[] }>
  | Envelope<"ci-failing", { failing: readonly string[] }>
  | Envelope<"ci-pending", { pending: readonly string[] }>
>;

export declare function createMergeTool(deps: BaseToolDeps): (input: MergeToolInput) => Promise<
  | Envelope<"merge", { contractVersion: 1; manifestPath: string; pr: PullRequestNumber }>
  | MissingManifestEnvelope
  | MissingPrEnvelope
  | NotReadyEnvelope
  | WrongBaseEnvelope
  | HeadChangedEnvelope
  | NotMergeableEnvelope
  | MissingGateEnvelope
  | HeadChangedAfterReviewEnvelope
  | HeadChangedAfterVerifierEnvelope
  | Envelope<"ci-missing", { missing: readonly string[] }>
  | Envelope<"ci-failing", { failing: readonly string[] }>
  | Envelope<"ci-pending", { pending: readonly string[] }>
>;

export declare function createCleanupTool(deps: BaseToolDeps): (input: CleanupToolInput) => Promise<
  | Envelope<"cleanup", { contractVersion: 1; manifestPath: string | null; removedPath: string }>
  | MissingManifestEnvelope
  | ManifestStateEnvelope
  | MissingWorktreePathEnvelope
  | MissingPrEnvelope
  | CurrentCheckoutEnvelope
  | DirtyWorktreeEnvelope
  | RebaseInProgressEnvelope
  | HeadMismatchEnvelope
  | UnmergedEnvelope
  | BaseMismatchEnvelope
  | HasUnpublishedCommitsEnvelope
  | RemoveFailedEnvelope
  | Envelope<"branch-delete-failed", { stderr: string }>
  | Envelope<"unsafe-cleanup", { signals: readonly string[] }>
>;
