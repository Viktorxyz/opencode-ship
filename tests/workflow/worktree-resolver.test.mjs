import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeManifest, readManifest } from "../../src/state/manifest-store.js";
import { publishPlanRevision } from "../../src/workflow/plan-store.js";
import {
  appendRunEvent,
  createInitialState,
  RUN_EVENT_KINDS,
} from "../../src/workflow/run-controller.js";
import { resolveWorkflowWorktree } from "../../src/workflow/worktree-resolver.js";
import { cleanupFixture, git, makeFixtureRepo } from "../helpers/fixture.mjs";

function planFor(workflowId, issueNumber, revision = 1) {
  return {
    schemaVersion: 2,
    workflowId,
    revision,
    supersedes: null,
    authoredBy: {
      sessionID: "planner-session",
      model: "openai/gpt-5.6-sol",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    source: {
      repository: "owner/repo",
      issueNumber,
      issueUrl: `https://github.com/owner/repo/issues/${issueNumber}`,
      baseBranch: "main",
      baseSha: "0".repeat(40),
    },
    goal: "Resolve the workflow implementation worktree.",
    architecture: { summary: "Use the linked delivery manifest.", decisions: [] },
    constraints: [],
    files: [{ path: "src/example.js", action: "create", responsibility: "Example", taskIds: ["task-1"] }],
    tasks: [{
      id: "task-1",
      ordinal: 1,
      title: "Example",
      objective: "Create the example file.",
      dependsOn: [],
      preconditions: [],
      changes: [{
        path: "src/example.js",
        operation: "create",
        symbols: [],
        instructions: ["Create the file."],
        preserve: ["Existing behavior."],
      }],
      interfaces: [],
      tests: [],
      commands: [],
      acceptance: [{ id: "accept-1", assertion: "The file exists.", evidence: ["Focused test passes."] }],
      commit: { message: "test: create example" },
    }],
    finalAcceptance: [],
    outOfScope: [],
    recovery: [],
  };
}

function manifestFor(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: "task-80",
    issueNumber: 80,
    workflowId: "wf-80",
    worktreePath: null,
    ...overrides,
  };
}

async function seedRun(repoRoot, { workflowId = "wf-80", issueNumber = 80, revision = 1, sha256 } = {}) {
  let planHash = sha256;
  if (!planHash) {
    const published = await publishPlanRevision(repoRoot, planFor(workflowId, issueNumber, revision));
    planHash = published.hash;
  }
  const initial = createInitialState(workflowId, revision, planHash);
  await appendRunEvent(repoRoot, workflowId, initial, {
    kind: RUN_EVENT_KINDS.RUN_START,
    data: { revision, sha256: planHash },
  });
  return planHash;
}

function createLinkedWorktree(repoRoot, name) {
  const path = join(repoRoot, ".worktrees", name);
  const created = git(repoRoot, ["worktree", "add", "-b", name, path]);
  assert.equal(created.status, 0, created.stderr);
  return path;
}

test("resolver returns the exact manifest and canonical registered worktree from the primary checkout", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    const worktreePath = createLinkedWorktree(fixture.dir, "workflow-80");
    const manifest = manifestFor({ worktreePath });
    await writeManifest(fixture.dir, manifest);

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: true,
      workflowId: "wf-80",
      issueNumber: 80,
      manifest,
      worktreePath: realpathSync(worktreePath),
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver returns the registered feature worktree when invoked from that worktree", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    const worktreePath = createLinkedWorktree(fixture.dir, "workflow-80");
    const manifest = manifestFor({ worktreePath });
    await writeManifest(fixture.dir, manifest);

    const result = await resolveWorkflowWorktree(worktreePath, "wf-80");

    assert.deepEqual(result, {
      ok: true,
      workflowId: "wf-80",
      issueNumber: 80,
      manifest,
      worktreePath: realpathSync(worktreePath),
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects a missing durable run before reading workflow identity", async () => {
  const fixture = makeFixtureRepo();
  try {
    const result = await resolveWorkflowWorktree(fixture.dir, "wf-missing");

    assert.deepEqual(result, {
      ok: false,
      kind: "missing-workflow-run",
      workflowId: "wf-missing",
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects a missing exact plan revision", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir, { revision: 2, sha256: "a".repeat(64) });

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: false,
      kind: "missing-workflow-plan",
      workflowId: "wf-80",
      revision: 2,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects a plan whose hash does not match the durable run", async () => {
  const fixture = makeFixtureRepo();
  try {
    const published = await publishPlanRevision(fixture.dir, planFor("wf-80", 80));
    const expected = "b".repeat(64);
    await seedRun(fixture.dir, { sha256: expected });

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: false,
      kind: "workflow-plan-mismatch",
      workflowId: "wf-80",
      revision: 1,
      expected,
      received: published.hash,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects a plan without a positive source issue number", async () => {
  const fixture = makeFixtureRepo();
  try {
    const workflowId = "wf-80";
    const hash = "c".repeat(64);
    const planDir = join(fixture.dir, ".git", "opencode-ship", "plans", workflowId, "revisions", "000001");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.json"), JSON.stringify({
      plan: { source: { issueNumber: 0 } },
      hash,
      publishedAt: "2026-09-02T00:00:00.000Z",
    }));
    await seedRun(fixture.dir, { workflowId, sha256: hash });

    const result = await resolveWorkflowWorktree(fixture.dir, workflowId);

    assert.deepEqual(result, {
      ok: false,
      kind: "missing-workflow-issue",
      workflowId,
      revision: 1,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects zero manifests for the workflow issue", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: false,
      kind: "ambiguous-workflow-manifest",
      issueNumber: 80,
      count: 0,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects duplicate manifests for the workflow issue", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    await writeManifest(fixture.dir, manifestFor({ taskId: "task-80-a" }));
    await writeManifest(fixture.dir, manifestFor({ taskId: "task-80-b" }));

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: false,
      kind: "ambiguous-workflow-manifest",
      issueNumber: 80,
      count: 2,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects schema and workflow identity mismatches", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    await writeManifest(fixture.dir, manifestFor({ schemaVersion: 1 }));

    const schemaMismatch = await resolveWorkflowWorktree(fixture.dir, "wf-80");
    assert.deepEqual(schemaMismatch, {
      ok: false,
      kind: "workflow-mismatch",
      expectedSchema: 2,
      receivedSchema: 1,
    });

    await writeManifest(fixture.dir, manifestFor({ workflowId: "wf-other" }));
    const workflowMismatch = await resolveWorkflowWorktree(fixture.dir, "wf-80");
    assert.deepEqual(workflowMismatch, {
      ok: false,
      kind: "workflow-mismatch",
      expected: "wf-80",
      received: "wf-other",
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects the real primary checkout as a workflow worktree", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    const manifest = manifestFor({ worktreePath: fixture.dir });
    await writeManifest(fixture.dir, manifest);

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.equal(result.ok, false);
    assert.equal(result.kind, "invalid-worktree");
    assert.equal(result.reason, "main");
    assert.deepEqual(await readManifest(fixture.dir, manifest.taskId), manifest);
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver rejects a linked manifest without a worktree path", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    await writeManifest(fixture.dir, manifestFor());

    const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

    assert.deepEqual(result, {
      ok: false,
      kind: "missing-worktree-path",
      taskId: "task-80",
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("resolver maps invalid linked-worktree paths without mutating manifests", async () => {
  const fixture = makeFixtureRepo();
  try {
    await seedRun(fixture.dir);
    const unregisteredPath = join(fixture.dir, ".worktrees", "unregistered");
    mkdirSync(unregisteredPath, { recursive: true });
    const linkedPath = createLinkedWorktree(fixture.dir, "workflow-80");
    const aliasPath = join(fixture.dir, ".worktrees", "workflow-80-alias");
    symlinkSync(linkedPath, aliasPath);
    const cases = [
      [join(fixture.dir, ".worktrees", "missing"), "missing"],
      [unregisteredPath, "unlinked"],
      [aliasPath, "ancestor-symlink"],
    ];

    for (const [worktreePath, reason] of cases) {
      const manifest = manifestFor({ worktreePath });
      await writeManifest(fixture.dir, manifest);

      const result = await resolveWorkflowWorktree(fixture.dir, "wf-80");

      assert.equal(result.ok, false);
      assert.equal(result.kind, "invalid-worktree");
      assert.equal(result.reason, reason);
      assert.equal(typeof result.message, "string");
      assert.deepEqual(await readManifest(fixture.dir, manifest.taskId), manifest);
    }
  } finally {
    cleanupFixture(fixture);
  }
});
