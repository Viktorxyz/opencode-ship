/**
 * Consumer-fixture type test for opencode-ship.
 *
 * Compiled with `tsc --noEmit -p tests/fixtures/consumer-tsconfig.json`.
 * Fails to typecheck the moment any public value export from
 * src/index.js is missing from src/types.d.ts. That is the point.
 *
 * The fixture imports every named export, then exercises the
 * lifecycle, gates, doctor, and three tool factories with mock
 * driver + adapter deps so the signatures are actually used.
 */

import * as delivery from "../../src/index.js";

const {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_FILENAME,
  LOCK_FILENAME,
  loadAdapter,
  validateAdapter,
  writeLock,
  readLock,
  findOpencodeDir,
  STATES,
  createManifest,
  transition,
  canTransition,
  isTerminal,
  mustRerunReview,
  mustRerunVerifier,
  listManifests,
  readManifest,
  writeManifest,
  deleteManifest,
  WorktreeRecord,
  isInsideWorktree,
  isMainCheckout,
  listWorktrees,
  isWorktreeClean,
  isRebaseInProgress,
  currentBranch,
  revParse,
  fetchBranch,
  remoteExists,
  createWorktree,
  createWorktreeFromLocal,
  worktreeExists,
  branchExistsLocally,
  branchExistsRemotely,
  mergeIntoFeature,
  currentHead,
  push,
  pushForceDisabled,
  defaultBranch,
  mergeBaseRemoteHead,
  createGhDriver,
  createGhStub,
  parseRepoSlug,
  scanRecovery,
  wouldCleanupBeSafe,
  removeManifestIfSafe,
  recoverManifestAfterCrash,
  doctor,
  checkGates,
  gateSnapshot,
  gateFailureEnvelope,
  bucketFor,
  createInspectTool,
  createIssueTool,
  createWorktreeTool,
  createVerifyTool,
  createReviewTool,
  createPrTool,
  createReadyTool,
  createMergeTool,
  createCleanupTool,
  PACKAGE_VERSION,
} = delivery;

const REPO = "acme/widgets" as const;
const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "0000000000000000000000000000000000000000";

const fakeIssue = {
  number: 42,
  url: "https://example.com/issues/42",
  state: "OPEN" as const,
  pullRequest: null,
};

const fakePr = {
  number: 7,
  url: "https://example.com/pr/7",
  baseRefName: "main",
  headRefName: "feature/seed",
  headSha: HEAD_SHA,
  draft: true,
  mergeable: "MERGEABLE" as const,
  mergeStateStatus: "CLEAN",
  merged: false,
  mergedAt: null,
};

const mockDriver: delivery.GithubDriver = {
  ensureIssue: async () => ({ summary: fakeIssue, created: true }),
  openDraftPullRequest: async () => fakePr,
  updatePullRequestBody: async () => undefined,
  markReady: async () => undefined,
  mergePullRequest: async () => fakePr,
  readPullRequest: async () => fakePr,
  readChecks: async () => [{ name: "ci/build", state: "success", bucket: "pass" }],
  comment: async () => undefined,
  refreshHead: async () => HEAD_SHA,
};

const mockAdapter: delivery.Adapter = {
  contractVersion: 1,
  repository: { remote: "origin", defaultBranch: { name: "main" } },
  forge: { driver: "github", issueRequired: true, draftAfterFirstCommit: true },
  worktree: {
    root: ".worktrees",
    branchTemplate: "{actor}/{slug}",
    bootstrap: [],
  },
  verification: {
    commands: [{ id: "lint", argv: ["pnpm", "lint"] }],
    requireCleanDiffAfter: true,
    invalidateOnHeadChange: true,
  },
  review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
  ci: {
    driver: "github-status-checks",
    requiredChecks: ["ci/build"],
    wait: false,
    flakyRetry: 0,
  },
  ready: {
    requires: ["review", "local-verification", "remote-ci"],
    stopAfterReady: true,
  },
  merge: { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
  cleanup: {
    when: "next-task",
    requires: ["pr-merged", "worktree-clean", "no-unpublished-commits"],
  },
};

const fakeRepoRoot = "/tmp/fake-repo-root";

const manifest = createManifest({
  taskId: "seed-task",
  repoIdentity: REPO,
  issueNumber: fakeIssue.number,
  baseBranch: "main",
  baseSha: BASE_SHA,
  branch: "feature/seed",
  workflowId: "workflow-seed",
  owner: "tester",
});
const manifestSchemaVersion: 2 = manifest.schemaVersion;
const manifestWorkflowId: string | null = manifest.workflowId;

const canSelf = canTransition(manifest.state, "issue-linked");
const moved = transition(manifest, "worktree-created", { reason: "fixture" });
const terminal = isTerminal(moved.ok ? moved.to : "aborted");
const needsReview = mustRerunReview(manifest.lastReviewerSha, HEAD_SHA);
const needsVerify = mustRerunVerifier(manifest.lastVerifierSha, HEAD_SHA);
void canSelf;
void terminal;
void needsReview;
void needsVerify;
void manifestSchemaVersion;
void manifestWorkflowId;

const snapshot = gateSnapshot({
  manifest: { ...manifest, adapter: mockAdapter },
  prHead: HEAD_SHA,
  checks: [{ name: "ci/build", state: "success", bucket: "pass" }],
});
const passed = checkGates({
  manifest: {
    ...manifest,
    adapter: mockAdapter,
    lastReviewerSha: HEAD_SHA,
    lastVerifierSha: HEAD_SHA,
  },
  prHead: HEAD_SHA,
  checks: [{ name: "ci/build", state: "success", bucket: "pass" }],
  requires: ["review", "local-verification", "remote-ci"],
});
const failedEnvelope = gateFailureEnvelope({
  reason: "missing-review",
  snapshot,
});
const bucketed = bucketFor({ name: "ci/build", state: "success", bucket: "pass" });
void passed;
void failedEnvelope;
void bucketed;

const doctorReport = await doctor(fakeRepoRoot, PACKAGE_VERSION).catch(() => null);
void doctorReport;

const inspectTool = createInspectTool({
  repoRoot: fakeRepoRoot,
  repoSlug: REPO,
  owner: "tester",
  packageVersion: PACKAGE_VERSION,
  adapter: mockAdapter,
});
const issueTool = createIssueTool({
  repoRoot: fakeRepoRoot,
  repoSlug: REPO,
  owner: "tester",
  driver: mockDriver,
  adapter: mockAdapter,
});
const prTool = createPrTool({
  repoRoot: fakeRepoRoot,
  repoSlug: REPO,
  owner: "tester",
  driver: mockDriver,
  adapter: mockAdapter,
});

const inspectResult = await inspectTool({ taskId: "seed-task" });
const issueResult = await issueTool({
  taskId: "seed-task",
  title: "seed",
  baseBranch: "main",
  branch: "feature/seed",
  body: "fixture",
  labels: ["bug"],
});
const prResult = await prTool({
  taskId: "seed-task",
  title: "seed",
  body: "fixture",
});
void inspectResult;
void issueResult;
void prResult;

const commonDeps = {
  repoRoot: fakeRepoRoot,
  repoSlug: REPO,
  owner: "tester",
  driver: mockDriver,
  adapter: mockAdapter,
};
const worktreeTool = createWorktreeTool({ ...commonDeps, remote: "origin" });
const verifyTool = createVerifyTool(commonDeps);
const reviewTool = createReviewTool(commonDeps);
const readyTool = createReadyTool(commonDeps);
const mergeTool = createMergeTool(commonDeps);
const cleanupTool = createCleanupTool(commonDeps);

const wtResult = await worktreeTool({
  taskId: "seed-task",
  branch: "feature/seed",
  worktreeRelativePath: ".worktrees/seed",
});
const vResult = await verifyTool({ taskId: "seed-task" });
const rResult = await reviewTool({ taskId: "seed-task", status: "pass" });
const ryResult = await readyTool({ taskId: "seed-task" });
const mResult = await mergeTool({ taskId: "seed-task", subject: "feat: seed" });
const cResult = await cleanupTool({ taskId: "seed-task" });
void wtResult;
void vResult;
void rResult;
void ryResult;
void mResult;
void cResult;

const adapterLoad = await loadAdapter(fakeRepoRoot);
const validated = validateAdapter(mockAdapter);
const wroteLock = await writeLock(fakeRepoRoot, "deadbeef");
const readLockResult = await readLock(fakeRepoRoot);
const dir = findOpencodeDir(fakeRepoRoot);
void adapterLoad;
void validated;
void wroteLock;
void readLockResult;
void dir;

const list = await listManifests(fakeRepoRoot);
const read = await readManifest(fakeRepoRoot, "seed-task");
const wrote = await writeManifest(fakeRepoRoot, manifest);
const deleted = await deleteManifest(fakeRepoRoot, "seed-task");
void list;
void read;
void wrote;
void deleted;

const gitList = listWorktrees(fakeRepoRoot);
const gitClean = isWorktreeClean(fakeRepoRoot);
const inside = isInsideWorktree(fakeRepoRoot);
const mainCheckout = isMainCheckout(fakeRepoRoot);
const branch = currentBranch(fakeRepoRoot);
const rev = revParse("HEAD", fakeRepoRoot);
const fetched = fetchBranch("origin", "main", fakeRepoRoot);
const remoteOk = remoteExists("origin", fakeRepoRoot);
const wt = createWorktree({
  cwd: fakeRepoRoot,
  branch: "feature/seed",
  worktreePath: "/tmp/wt",
  base: "main",
});
const wtLocal = createWorktreeFromLocal({
  cwd: fakeRepoRoot,
  branch: "feature/seed",
  worktreePath: "/tmp/wt",
  base: "main",
});
const wtExists = worktreeExists(fakeRepoRoot, "/tmp/wt");
const branchLocal = branchExistsLocally("feature/seed", fakeRepoRoot);
const branchRemote = branchExistsRemotely("origin", "feature/seed", fakeRepoRoot);
const mergedInto = mergeIntoFeature("feature/seed", "main", fakeRepoRoot);
const head = currentHead(fakeRepoRoot);
const pushed = push("origin", "feature/seed", fakeRepoRoot);
const pushForbidden = pushForceDisabled("origin", "feature/seed", fakeRepoRoot);
const defBranch = defaultBranch(fakeRepoRoot);
const baseHead = mergeBaseRemoteHead("origin", "main", fakeRepoRoot);
const rebasing = isRebaseInProgress(fakeRepoRoot);
void gitList;
void gitClean;
void inside;
void mainCheckout;
void branch;
void rev;
void fetched;
void remoteOk;
void wt;
void wtLocal;
void wtExists;
void branchLocal;
void branchRemote;
void mergedInto;
void head;
void pushed;
void pushForbidden;
void defBranch;
void baseHead;
void rebasing;

const ghDriver = createGhDriver();
const ghStub = createGhStub([]);
const repoRef = parseRepoSlug("acme/widgets");
void ghDriver;
void ghStub;
void repoRef;

const scan = await scanRecovery(fakeRepoRoot);
const safe = wouldCleanupBeSafe({
  prMerged: true,
  worktreeClean: true,
  rebaseInProgress: false,
  headMatchesPr: true,
  baseMatches: true,
});
const removed = await removeManifestIfSafe(fakeRepoRoot, "seed-task");
const recovered = recoverManifestAfterCrash(manifest);
void scan;
void safe;
void removed;
void recovered;

const constants = {
  contract: ADAPTER_CONTRACT_VERSION,
  filename: ADAPTER_FILENAME,
  lockName: LOCK_FILENAME,
  version: PACKAGE_VERSION,
  states: STATES,
  worktreeRecord: WorktreeRecord,
};
void constants;
