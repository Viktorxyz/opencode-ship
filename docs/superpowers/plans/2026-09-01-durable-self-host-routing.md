# Durable Self-Host Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a deterministic schema-v2 self-host delivery path that dispatches the controller, executes workflow tasks in the linked feature worktree, and safely abandons closed unmerged attempts.

**Architecture:** A new Build-callable `ship_deliver` tool idempotently dispatches the `ship-controller`, while `ship_plan_start` remains the only workflow-link authority. A shared workflow-to-worktree resolver becomes the seam used by task execution and final review. A separate `delivery_abandon` tool records immutable intent/completion evidence around fail-closed CAS cleanup.

**Tech Stack:** Node.js 22 ESM, `@opencode-ai/plugin`, Git worktrees, GitHub CLI driver, Node test runner, immutable JSON stores under the Git common directory.

## Global Constraints

- Never relax Ready, merge, dual-axis review, verifier, required-CI, or same-HEAD gates.
- `ship_plan_start` remains callable only by `ship-controller`.
- Schema-v2 implementation mutation requires a non-null durable `workflowId`.
- Planning and approval bind to the base checkout; implementation and final review bind to the linked feature worktree.
- `delivery_abandon` never closes a PR and never accepts an open or merged PR.
- Destructive cleanup requires immutable intent, exact recorded HEAD, a clean published worktree, and compare-and-swap branch deletion.
- Automated install, qualification, and rollout commands use exact package versions, never `@latest`.

---

## File Structure

- `src/tools/ship-deliver.js`: public Build-to-controller dispatch entrypoint.
- `src/runtime/opencode-dispatcher.js`: idempotent controller-session dispatch protocol alongside worker dispatch.
- `src/workflow/worktree-resolver.js`: one workflow/issue/manifest/worktree identity resolver.
- `src/tools/delivery-abandon.js`: closed-unmerged attempt validation and cleanup orchestration.
- `src/state/abandon-store.js`: immutable abandon intent/completion storage.
- `src/tools/delivery-worktree.js`: early schema-v2 workflow-link guard.
- `src/tools/ship-task-start.js`: builder dispatch from linked worktree.
- `src/tools/ship-task-report.js`: task-reviewer dispatch from linked worktree.
- `src/tools/ship-task-commit.js`: commit/trailer verification against linked worktree HEAD.
- `src/tools/ship-task-complete.js`: verifier/CI/final-review package and child dispatch against linked worktree.
- `src/plugin.js`, `src/tools/index.js`, `src/installer/root-permissions.js`: tool registration and permission surface.
- `assets/commands/ship-deliver.md`, `assets/skills/delivery-workflow/SKILL.md`, `assets/agents/ship-controller.md`: shipped orchestration contract.
- `src/types.d.ts`, `tests/fixtures/consumer.ts`: public type contract.
- `tests/tools/ship-deliver.test.mjs`, `tests/workflow/worktree-resolver.test.mjs`, `tests/workflow/task-worktree-routing.test.mjs`, `tests/tools/delivery-abandon.test.mjs`: focused regressions.
- `tests/plugin/expected-tools.mjs`, `tests/plugin/plugin-load.test.mjs`, `tests/installer/root-permission-matrix.test.mjs`, `tests/package/packed-artifact.test.mjs`: plugin and package closure.

---

### Task 1: Deterministic Build-To-Controller Entrypoint

**Files:**
- Create: `src/tools/ship-deliver.js`
- Create: `tests/tools/ship-deliver.test.mjs`
- Modify: `src/runtime/opencode-dispatcher.js`
- Modify: `src/tools/index.js`
- Modify: `src/plugin.js`
- Modify: `src/installer/root-permissions.js`
- Modify: `tests/runtime/opencode-dispatcher.test.mjs`
- Modify: `tests/plugin/expected-tools.mjs`
- Modify: `tests/plugin/plugin-load.test.mjs`
- Modify: `tests/installer/root-permission-matrix.test.mjs`

**Interfaces:**
- Produces: `dispatchController({ repoRoot, issueNumber, client, parentSessionID }): Promise<{ sessionID, dispatchKey }>`.
- Produces: `createDeliverTool(deps)`, whose runner accepts `{ issueNumber, operationId? }` and returns a contract-v2 success/failure envelope.
- Permission contract: Build allows `ship_deliver`; `ship-controller` denies recursive `ship_deliver`; `ship_plan_start` stays controller-only.

- [ ] **Step 1: Write failing dispatcher tests**

Add tests proving one issue produces one controller session, retries reuse the recorded session, the OpenCode query directory equals `repoRoot`, and the prompt targets `ship-controller`:

```js
const first = await dispatchController({
  repoRoot: fixture.dir,
  issueNumber: 80,
  client,
  parentSessionID: "build-session",
});
const second = await dispatchController({
  repoRoot: fixture.dir,
  issueNumber: 80,
  client,
  parentSessionID: "build-session",
});
assert.equal(first.sessionID, "controller-session");
assert.deepEqual(second, first);
assert.equal(created.length, 1);
assert.equal(prompted[0].body.agent, "ship-controller");
assert.equal(prompted[0].query.directory, fixture.dir);
```

- [ ] **Step 2: Run the dispatcher test and confirm RED**

Run: `node --test --test-concurrency=1 tests/runtime/opencode-dispatcher.test.mjs`

Expected: FAIL because `dispatchController` is not exported.

- [ ] **Step 3: Implement idempotent controller dispatch**

Add a controller dispatch key `controller:issue-<number>` under `runs/wf-<number>/dispatch/`. Reuse the existing immutable prepared/created/prompted sequence and resource lock, but do not require a controller lease before creating the controller itself.

The public shape must be:

```js
export async function dispatchController({ repoRoot, issueNumber, client, parentSessionID }) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("dispatchController: positive issueNumber required");
  }
  return dispatchSession({
    repoRoot,
    workflowId: `wf-${issueNumber}`,
    dispatchKey: `controller:issue-${issueNumber}`,
    payload: { issueNumber, agent: "ship-controller" },
    client,
    parentSessionID,
    agent: "ship-controller",
    promptText: `Start or resume durable delivery for issue #${issueNumber}. Call ship_plan_start before implementation mutation.`,
    requireControllerLease: false,
  });
}
```

Keep worker authorization unchanged by routing existing `dispatchWorker` calls through the same private `dispatchSession` with `requireControllerLease: true`.

- [ ] **Step 4: Write failing `ship_deliver` tool tests**

Cover setup incomplete, missing Build session identity, unavailable OpenCode client, successful dispatch, and idempotent retry:

```js
const tool = createDeliverTool({
  repoRoot: fixture.dir,
  opencodeClient: client,
  ctx: { sessionID: "build-session", agent: "build" },
});
const result = await tool({ issueNumber: 80, operationId: "deliver-80" });
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.data.workflowId, "wf-80");
assert.equal(result.data.controllerSessionID, "controller-session");
```

- [ ] **Step 5: Run the tool test and confirm RED**

Run: `node --test --test-concurrency=1 tests/tools/ship-deliver.test.mjs`

Expected: FAIL because `createDeliverTool` does not exist.

- [ ] **Step 6: Implement and register `ship_deliver`**

`createDeliverTool` must validate `ctx.sessionID`, require `ctx.agent === "build"`, require setup-complete lock state, call `dispatchController`, and wrap errors through `success("deliver", ...)` / `failure("deliver", ...)`.

Register `ship_deliver` in `src/tools/index.js`, `toolDefs`, `factories`, and the expected plugin tool list. Update the plugin comment/count from 32 to 33. Add `ship_deliver` to public IDs and Build allow permissions only.

- [ ] **Step 7: Run focused plugin and permission tests**

Run: `node --test --test-concurrency=1 tests/tools/ship-deliver.test.mjs tests/runtime/opencode-dispatcher.test.mjs tests/plugin/plugin-load.test.mjs tests/installer/root-permission-matrix.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/tools/ship-deliver.js src/runtime/opencode-dispatcher.js src/tools/index.js src/plugin.js src/installer/root-permissions.js tests/tools/ship-deliver.test.mjs tests/runtime/opencode-dispatcher.test.mjs tests/plugin/expected-tools.mjs tests/plugin/plugin-load.test.mjs tests/installer/root-permission-matrix.test.mjs
git commit -m "fix(workflow): dispatch durable controller entrypoint"
```

---

### Task 2: Workflow Link Guard And Worktree Resolver

**Files:**
- Create: `src/workflow/worktree-resolver.js`
- Create: `tests/workflow/worktree-resolver.test.mjs`
- Modify: `src/tools/delivery-worktree.js`
- Modify: `tests/tools/worktree.test.mjs`

**Interfaces:**
- Consumes: plan/run stores, `listManifests`, and `validateLinkedWorktree`.
- Produces: `resolveWorkflowWorktree(repoRoot, workflowId): Promise<{ workflowId, issueNumber, manifest, worktreePath }>`.

- [ ] **Step 1: Add failing early-guard test**

Update fixture manifests to schema v2 and prove no branch/worktree is created before linkage:

```js
const result = await worktree({
  taskId: "t1",
  branch: "backend/t1",
  worktreeRelativePath: ".worktrees/backend-t1",
});
assert.equal(result.kind, "missing-workflow-link");
assert.equal(git.branchExistsLocally("backend/t1", fixture.dir), false);
```

Then link the manifest with `workflowId: "wf-1"` and preserve the existing success assertions.

- [ ] **Step 2: Run the worktree test and confirm RED**

Run: `node --test --test-concurrency=1 tests/tools/worktree.test.mjs`

Expected: FAIL because worktree creation currently accepts null `workflowId`.

- [ ] **Step 3: Add the schema-v2 guard**

Immediately after manifest/state validation in `delivery-worktree.js`, return:

```js
if (m.schemaVersion >= 2 && !m.workflowId) {
  return { kind: "missing-workflow-link", taskId: m.taskId };
}
```

Keep schema-v1 bootstrap compatibility unchanged.

- [ ] **Step 4: Write failing resolver tests**

Create cases for success and each stable failure kind:

```js
await seedApprovedRun(fixture.dir, { workflowId: "wf-80", issueNumber: 80 });
await writeManifest(fixture.dir, {
  ...schema2Manifest,
  issueNumber: 80,
  workflowId: "wf-80",
  worktreePath,
});
const resolved = await resolveWorkflowWorktree(fixture.dir, "wf-80");
assert.equal(resolved.worktreePath, worktreePath);
```

Required failures: no run/plan, no manifest, duplicate issue manifests, workflow mismatch, null path, and unregistered worktree.

- [ ] **Step 5: Run resolver tests and confirm RED**

Run: `node --test --test-concurrency=1 tests/workflow/worktree-resolver.test.mjs`

Expected: FAIL because the resolver module is absent.

- [ ] **Step 6: Implement the resolver**

Use this ordering so errors are deterministic:

```js
export async function resolveWorkflowWorktree(repoRoot, workflowId) {
  const run = await readRunState(repoRoot, workflowId);
  if (!run) return failureRecord("missing-workflow-run", { workflowId });
  const planRecord = await readPlanRevision(repoRoot, workflowId, run.revision);
  const issueNumber = planRecord?.plan?.source?.issueNumber;
  const matches = (await listManifests(repoRoot)).filter((m) => m.issueNumber === issueNumber);
  if (matches.length !== 1) return failureRecord("ambiguous-workflow-manifest", { issueNumber, count: matches.length });
  const manifest = matches[0];
  if (manifest.workflowId !== workflowId) return failureRecord("workflow-mismatch", { expected: workflowId, received: manifest.workflowId });
  if (!manifest.worktreePath) return failureRecord("missing-worktree-path", { taskId: manifest.taskId });
  const linked = await validateLinkedWorktree(repoRoot, manifest.worktreePath);
  if (!linked.ok) return failureRecord("invalid-worktree", { reason: linked.kind, message: linked.message });
  return { ok: true, workflowId, issueNumber, manifest, worktreePath: linked.path };
}
```

Return structured records instead of throwing for expected state failures.

- [ ] **Step 7: Run focused tests**

Run: `node --test --test-concurrency=1 tests/tools/worktree.test.mjs tests/workflow/worktree-resolver.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/workflow/worktree-resolver.js src/tools/delivery-worktree.js tests/workflow/worktree-resolver.test.mjs tests/tools/worktree.test.mjs
git commit -m "fix(workflow): bind execution to linked worktrees"
```

---

### Task 3: Route Task Execution And Final Review Through The Worktree

**Files:**
- Create: `tests/workflow/task-worktree-routing.test.mjs`
- Modify: `src/tools/ship-task-start.js`
- Modify: `src/tools/ship-task-report.js`
- Modify: `src/tools/ship-task-commit.js`
- Modify: `src/tools/ship-task-complete.js`

**Interfaces:**
- Consumes: `resolveWorkflowWorktree(repoRoot, workflowId)` from Task 2.
- Produces: builder/reviewer/final-review OpenCode sessions whose SDK `query.directory` equals the feature worktree.
- Produces: commit and final package HEAD checks against the feature worktree.

- [ ] **Step 1: Write failing builder/reviewer directory tests**

Seed a base checkout at SHA A and linked worktree at SHA B. Capture SDK calls and assert both worker roles use the worktree:

```js
await taskStart({ workflowId: "wf-80", taskId: "routing", operationId: "start" });
await taskReport({
  workflowId: "wf-80",
  taskId: "routing",
  round: 1,
  summary: "implemented",
  operationId: "report",
});
assert.ok(created.every((call) => call.query.directory === worktreePath));
assert.ok(prompted.every((call) => call.query.directory === worktreePath));
```

- [ ] **Step 2: Write failing commit/final-package HEAD tests**

Create a reviewed commit with required trailers at worktree SHA B while base remains SHA A. Assert `ship_task_commit` accepts B and `ship_task_complete` builds a final package whose `headSha` is B.

- [ ] **Step 3: Run routing tests and confirm RED**

Run: `node --test --test-concurrency=1 tests/workflow/task-worktree-routing.test.mjs`

Expected: FAIL with base-directory dispatch or `HEAD drift` against SHA A.

- [ ] **Step 4: Resolve worktree in builder and reviewer dispatch**

At the start of `ship_task_start` and before reviewer dispatch in `ship_task_report`, call the resolver and return a typed failure when `ok` is false. Pass `resolved.worktreePath` as `repoRoot` to `dispatchWorker`; continue reading durable run/plan state through the original root because both paths share the Git common directory.

- [ ] **Step 5: Resolve worktree in commit verification**

In `ship_task_commit`, use `resolved.worktreePath` for `git rev-parse HEAD` and `git log -1 --format=%B`. Keep durable commit records under the common directory resolved from the original root.

- [ ] **Step 6: Resolve worktree in completion/final review**

Pass the resolved path through trusted gate loading, final package construction, merge-base checks, and final reviewer `dispatchWorker` calls. The final package must still use the approved plan's base SHA and immutable verification/CI receipt hashes.

- [ ] **Step 7: Run workflow regression tests**

Run: `node --test --test-concurrency=1 tests/workflow/task-worktree-routing.test.mjs tests/package/two-task-workflow.test.mjs tests/tools/ready-merge.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/tools/ship-task-start.js src/tools/ship-task-report.js src/tools/ship-task-commit.js src/tools/ship-task-complete.js tests/workflow/task-worktree-routing.test.mjs
git commit -m "fix(workflow): execute durable tasks in feature worktree"
```

---

### Task 4: Audited Closed-PR Abandon Operation

**Files:**
- Create: `src/state/abandon-store.js`
- Create: `src/tools/delivery-abandon.js`
- Create: `tests/tools/delivery-abandon.test.mjs`
- Modify: `src/tools/index.js`
- Modify: `src/plugin.js`
- Modify: `src/installer/root-permissions.js`
- Modify: `src/drivers/gh-cli.js`
- Modify: `src/types.d.ts`
- Modify: `tests/fixtures/consumer.ts`
- Modify: `tests/plugin/expected-tools.mjs`
- Modify: `tests/plugin/plugin-load.test.mjs`
- Modify: `tests/installer/root-permission-matrix.test.mjs`

**Interfaces:**
- Produces: `createAbandonTool(deps)`, runner input `{ taskId, subject, operationId? }`.
- Produces: immutable `intent.json` and `completion.json` under `<git-common-dir>/opencode-ship/delivery/abandoned/<taskId>/`.
- Permission contract: `delivery_abandon` is `ask` for Build and `ship-controller`.

- [ ] **Step 1: Write failing refusal tests**

Cover missing manifest, open PR, merged PR, dirty worktree, rebase in progress, local/manifest head mismatch, remote divergence, unpublished commits, and durable run state `ready`/`merged`.

```js
const result = await abandon({ taskId: "t1", subject: "User approved closing failed acceptance" });
assert.equal(result.kind, "pr-open");
assert.equal(existsSync(worktreePath), true);
assert.ok(await readManifest(fixture.dir, "t1"));
```

- [ ] **Step 2: Run abandon tests and confirm RED**

Run: `node --test --test-concurrency=1 tests/tools/delivery-abandon.test.mjs`

Expected: FAIL because `createAbandonTool` does not exist.

- [ ] **Step 3: Implement immutable abandon store**

Expose:

```js
export async function readAbandon(repoRoot, taskId) {
  return { intent: await readJson(intentPath), completion: await readJson(completionPath) };
}

export async function publishAbandonIntent(repoRoot, record) {
  const path = intentPathFor(repoRoot, record.taskId);
  await publishImmutableJson(path, record);
  return { path, hash: sha256(canonicalJson(record)) };
}

export async function publishAbandonCompletion(repoRoot, record) {
  await publishImmutableJson(completionPathFor(repoRoot, record.taskId), record);
}
```

Use safe task-id validation before constructing paths.

- [ ] **Step 4: Implement fail-closed validation**

`delivery_abandon` must read `driver.readPullRequest` and require `state === "CLOSED"` and `merged === false`. Extend `PullRequestSummary` with `state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN"` and retain the existing driver field.

Before publishing intent, validate worktree registration, clean status, no rebase, exact local/manifest/PR head equality, remote branch absence-or-equality, no unpublished commits, and no Ready/merged durable run.

- [ ] **Step 5: Implement intent/cleanup/completion recovery**

After intent publication:

1. remove the registered worktree without force;
2. delete the local branch with `git update-ref -d refs/heads/<branch> <expectedHead>`;
3. delete the active manifest;
4. publish completion `{ taskId, intentHash, completedAt }`.

If an intent already exists without completion, skip pre-intent validation that depends on the removed worktree and idempotently resume the remaining steps using values sealed in the intent. If completion exists, return it with `idempotent: true`.

- [ ] **Step 6: Add success, retry, and partial-failure tests**

Inject cleanup operations so tests can fail after intent, after worktree removal, and after branch deletion. Each retry must converge to one completion and no active manifest/worktree/branch.

- [ ] **Step 7: Register tool, permissions, and types**

Add `delivery_abandon` to `src/tools/index.js`, plugin definitions/factory, expected tool IDs, and public declarations. Update count comments/assertions from 33 to 34. Add `delivery_abandon: ask` for Build and controller; do not add it to allow lists.

- [ ] **Step 8: Run focused abandon/plugin tests**

Run: `node --test --test-concurrency=1 tests/tools/delivery-abandon.test.mjs tests/plugin/plugin-load.test.mjs tests/installer/root-permission-matrix.test.mjs tests/drivers/github-driver.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/state/abandon-store.js src/tools/delivery-abandon.js src/tools/index.js src/plugin.js src/installer/root-permissions.js src/drivers/gh-cli.js src/types.d.ts tests/fixtures/consumer.ts tests/tools/delivery-abandon.test.mjs tests/plugin/expected-tools.mjs tests/plugin/plugin-load.test.mjs tests/installer/root-permission-matrix.test.mjs tests/drivers/github-driver.test.mjs
git commit -m "feat(delivery): abandon closed attempts safely"
```

---

### Task 5: Shipped Orchestration Contract And Corrective Package

**Files:**
- Modify: `assets/commands/ship-deliver.md`
- Modify: `assets/skills/delivery-workflow/SKILL.md`
- Modify: `assets/agents/ship-controller.md`
- Modify: `tests/installer/engineering-routing.test.mjs`
- Modify: `tests/package/packed-artifact.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ship_deliver`, `delivery_abandon`, and corrected 34-tool plugin surface.
- Produces: exact package version `1.1.8` with corrected command/skill/agent assets.

- [ ] **Step 1: Write failing shipped-asset tests**

Assert the command and skill explicitly invoke `ship_deliver`, prohibit direct legacy implementation flow, and document explicit abandonment:

```js
assert.match(deliverySkill, /ship_deliver/);
assert.doesNotMatch(deliverySkill, /\| 3\. Find or create the issue \| `delivery_issue`/);
assert.match(controllerAgent, /delivery_abandon/);
```

Update packed artifact assertions to require `ship_deliver`, `delivery_abandon`, corrected skill bytes, and version `1.1.8`.

- [ ] **Step 2: Run asset/package tests and confirm RED**

Run: `node --test --test-concurrency=1 tests/installer/engineering-routing.test.mjs tests/package/packed-artifact.test.mjs`

Expected: FAIL on legacy skill content and version `1.1.7`.

- [ ] **Step 3: Rewrite command and skill around the canonical entrypoint**

The command procedure must be:

```text
1. Check setup-pending.
2. Call ship_deliver(issueNumber).
3. Surface the controller session/workflow id.
4. Await the explicit plan approval prompt.
5. Resume only through ship-controller.
```

The `delivery-workflow` skill must delegate implementation requests to `ship_deliver` and must not directly call `delivery_worktree`, `delivery_pr`, `delivery_ready`, or `delivery_merge`. Keep read-only inspect/status and explicit post-merge cleanup guidance.

Add `delivery_abandon` to the controller agent's ask-permission surface and document that the controller may call it only after the user explicitly closes/abandons the PR.

- [ ] **Step 4: Bump package metadata and release notes**

Set both `package.json` and root `package-lock.json` version to `1.1.8`. Add a `1.1.8` changelog section describing deterministic controller dispatch, linked-worktree execution, early workflow-link refusal, and audited abandonment. Update README tool count and lifecycle entrypoint examples.

- [ ] **Step 5: Run package closure tests**

Run: `npm run build && node --test --test-concurrency=1 tests/installer/engineering-routing.test.mjs tests/plugin/plugin-load.test.mjs tests/package/packed-artifact.test.mjs tests/package/packed-closure.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run canonical verification**

Run: `npm run verify`

Expected: all tests pass, lint/typecheck/format/package checks succeed, and the worktree has no generated diff beyond intended tracked files.

- [ ] **Step 7: Commit Task 5**

```bash
git add assets/commands/ship-deliver.md assets/skills/delivery-workflow/SKILL.md assets/agents/ship-controller.md tests/installer/engineering-routing.test.mjs tests/package/packed-artifact.test.mjs README.md CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): prepare 1.1.8 routing correction"
```

---

## Break-Glass Delivery And Acceptance Checklist

- [ ] Inspect `git status`, full diff from `origin/main`, and commit history; confirm only issue #80 files changed.
- [ ] Push with exact HEAD verification and open a draft PR containing `Closes #80` and a break-glass rationale.
- [ ] Run independent Standards and Spec reviews against the same final HEAD.
- [ ] Run canonical verifier and record its SHA/result.
- [ ] Wait for required `opencode-ship-verify` CI at the same HEAD.
- [ ] Do not call the broken schema-v2 `delivery_ready`; surface the complete evidence and request explicit merge approval.
- [ ] After explicit approval, squash merge the corrective PR and record the merge SHA.
- [ ] Tag exact merged SHA as `1.1.8`; publish under `next`; qualify tarball hash, provenance, install/update/doctor/diff, plugin discovery, and Node matrix.
- [ ] Promote exact `opencode-ship@1.1.8` to `latest` only after qualification.
- [ ] Update `/tmp/opencode/opencode-ship-main` with exact `1.1.8` and restart OpenCode.
- [ ] Ask for explicit permission to close draft PR #79, then call `delivery_abandon` for `deterministic-lock-tests`.
- [ ] Re-run issue #78 through `ship_deliver`; require approved plan, task review, verifier, CI, Standards, Spec, Ready, explicit merge, and cleanup.
- [ ] Record that completed issue #78 lifecycle as the `1.1.8` self-host acceptance.
