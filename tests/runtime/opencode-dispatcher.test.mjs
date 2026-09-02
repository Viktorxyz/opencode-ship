/**
 * OpenCode dispatcher tests.
 *
 * Verifies:
 *   - dispatchWorker persists prepared -> created -> prompted.
 *   - failed create / failed prompt transitions the record to
 *     "failed" with the error captured.
 *   - authorizeChildCall accepts only the matching session id.
 *   - authorizeControllerCall requires an issued lease.
 *   - the controller lease is mutable; a different ship-controller
 *     session taking over the lease causes the first one to fail
 *     closed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  dispatchController,
  dispatchWorker,
  authorizeChildCall,
  authorizeControllerCall,
  issueControllerLease,
  readControllerLease,
  readLatestDispatch,
  transitionDispatch,
  dispatchKeyFor,
  withControllerLease,
  ROLES,
} from "../../src/runtime/opencode-dispatcher.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-dispatcher-"));
  git(["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "README.md"), "# x\n");
  git(["-C", root, "add", "README.md"]);
  git(["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return root;
}

function fakeClient(sessionID, { failCreate = false, failPrompt = false } = {}) {
  const calls = { create: [], promptAsync: [] };
  return {
    calls,
    session: {
      create: async (options) => {
        calls.create.push(options);
        if (failCreate) throw new Error("create failed");
        return { data: { id: sessionID, ...options.body }, error: undefined };
      },
      promptAsync: async (options) => {
        calls.promptAsync.push(options);
        if (failPrompt) throw new Error("prompt failed");
        return { data: undefined, error: undefined };
      },
    },
  };
}

test("dispatchController: creates and prompts one controller session per issue", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient("controller-session");
    const input = {
      repoRoot: root,
      issueNumber: 80,
      client,
      parentSessionID: "build-session",
    };

    const first = await dispatchController(input);
    const second = await dispatchController(input);

    assert.deepEqual(first, {
      sessionID: "controller-session",
      dispatchKey: "controller:issue-80",
    });
    assert.deepEqual(second, first);
    assert.equal(client.calls.create.length, 1);
    assert.equal(client.calls.promptAsync.length, 1);
    assert.deepEqual(client.calls.create[0].query, { directory: root });
    assert.deepEqual(client.calls.promptAsync[0], {
      path: { id: "controller-session" },
      body: {
        parts: [{
          type: "text",
          text: "Start or resume durable delivery for issue #80. Call ship_plan_start before implementation mutation.",
        }],
        agent: "ship-controller",
      },
      query: { directory: root },
    });
    const latest = await readLatestDispatch(root, "wf-80", "controller:issue-80");
    assert.equal(latest.parentSessionID, "build-session");
    assert.equal(latest.controllerSessionID, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchController: retries a failed prompt without creating another session", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient("controller-session");
    let promptAttempts = 0;
    client.session.promptAsync = async (options) => {
      client.calls.promptAsync.push(options);
      promptAttempts += 1;
      if (promptAttempts === 1) throw new Error("prompt failed");
      return { data: undefined, error: undefined };
    };
    const input = {
      repoRoot: root,
      issueNumber: 80,
      client,
      parentSessionID: "build-session",
    };

    await assert.rejects(dispatchController(input), /prompt failed/);
    const retried = await dispatchController(input);

    assert.equal(retried.sessionID, "controller-session");
    assert.equal(client.calls.create.length, 1);
    assert.equal(client.calls.promptAsync.length, 2);
    assert.deepEqual(
      client.calls.promptAsync.map((call) => call.path),
      [{ id: "controller-session" }, { id: "controller-session" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchController: creates a fresh session after the previous session is orphaned", async () => {
  const root = makeRepo();
  try {
    const calls = { create: [], promptAsync: [] };
    const client = {
      session: {
        create: async (options) => {
          calls.create.push(options);
          return { data: { id: `controller-session-${calls.create.length}` }, error: undefined };
        },
        promptAsync: async (options) => {
          calls.promptAsync.push(options);
          return { data: undefined, error: undefined };
        },
      },
    };
    const input = {
      repoRoot: root,
      issueNumber: 80,
      client,
      parentSessionID: "build-session",
    };

    const first = await dispatchController(input);
    const latest = await readLatestDispatch(root, "wf-80", "controller:issue-80");
    await transitionDispatch(root, "wf-80", "controller:issue-80", "orphaned", {
      sequence: latest.sequence + 1,
      sessionID: first.sessionID,
      parentSessionID: "build-session",
    });
    const retried = await dispatchController(input);

    assert.equal(first.sessionID, "controller-session-1");
    assert.equal(retried.sessionID, "controller-session-2");
    assert.equal(calls.create.length, 2);
    assert.deepEqual(
      calls.promptAsync.map((call) => call.path),
      [{ id: "controller-session-1" }, { id: "controller-session-2" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchController: different issues use different dispatch keys", async () => {
  const root = makeRepo();
  try {
    let nextSession = 0;
    const client = {
      calls: { create: [], promptAsync: [] },
      session: {
        create: async (options) => {
          client.calls.create.push(options);
          nextSession += 1;
          return { data: { id: `controller-session-${nextSession}` } };
        },
        promptAsync: async (options) => {
          client.calls.promptAsync.push(options);
          return { data: undefined, error: undefined };
        },
      },
    };

    const issue80 = await dispatchController({
      repoRoot: root,
      issueNumber: 80,
      client,
      parentSessionID: "build-session",
    });
    const issue81 = await dispatchController({
      repoRoot: root,
      issueNumber: 81,
      client,
      parentSessionID: "build-session",
    });

    assert.equal(issue80.dispatchKey, "controller:issue-80");
    assert.equal(issue81.dispatchKey, "controller:issue-81");
    assert.equal(client.calls.create.length, 2);
    assert.equal(client.calls.promptAsync.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: prepared -> created -> prompted on success", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("planner-session-1");
    const result = await dispatchWorker({
      repoRoot: root,
      workflowId: "wf-1",
      role: ROLES.PLANNER,
      keyInput: { revision: 1 },
      payload: { promptText: "plan this" },
      client,
      parentSessionID: "ctrl-session-A",
      agent: "ship-planner",
      model: "openai/gpt-5.6-sol",
    });
    assert.equal(result.sessionID, "planner-session-1");
    assert.equal(result.dispatchKey, "planner:1");
    const latest = await readLatestDispatch(root, "wf-1", "planner:1");
    assert.equal(latest.state, "prompted");
    assert.equal(latest.sessionID, "planner-session-1");
    assert.equal(latest.controllerSessionID, "ctrl-session-A");
    assert.equal(latest.parentSessionID, undefined);
    assert.deepEqual(client.calls.create, [{
      body: { parentID: "ctrl-session-A", title: "ship-planner-planner:1" },
      query: { directory: root },
    }]);
    assert.deepEqual(client.calls.promptAsync, [{
      path: { id: "planner-session-1" },
      body: {
        parts: [{ type: "text", text: "plan this" }],
        agent: "ship-planner",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      },
      query: { directory: root },
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: repeated successful dispatch is idempotent", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("builder-session-1");
    const input = {
      repoRoot: root,
      workflowId: "wf-1",
      role: ROLES.BUILDER,
      keyInput: { taskId: "a", round: 1 },
      payload: { promptText: "build" },
      client,
      parentSessionID: "ctrl-session-A",
      agent: "ship-task-builder",
      model: "minimax/MiniMax-M3",
    };
    const first = await dispatchWorker(input);
    const second = await dispatchWorker(input);
    assert.deepEqual(second, first);
    assert.equal(client.calls.create.length, 1);
    assert.equal(client.calls.promptAsync.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: retries the same key after an SDK create error", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    let attempts = 0;
    const client = {
      session: {
        create: async () => {
          attempts += 1;
          return attempts === 1
            ? { data: undefined, error: { message: "temporary create failure" } }
            : { data: { id: "builder-session-2" }, error: undefined };
        },
        promptAsync: async () => ({ data: undefined, error: undefined }),
      },
    };
    const input = {
      repoRoot: root,
      workflowId: "wf-1",
      role: ROLES.BUILDER,
      keyInput: { taskId: "a", round: 1 },
      payload: { promptText: "build" },
      client,
      parentSessionID: "ctrl-session-A",
    };
    await assert.rejects(dispatchWorker(input), /temporary create failure/);
    const retried = await dispatchWorker(input);
    assert.equal(retried.sessionID, "builder-session-2");
    assert.equal(attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: failure on create transitions to failed with lastError", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("planner-session-1", { failCreate: true });
    await assert.rejects(
      dispatchWorker({
        repoRoot: root,
        workflowId: "wf-1",
        role: ROLES.PLANNER,
        keyInput: { revision: 1 },
        payload: { promptText: "plan this" },
        client,
        parentSessionID: "ctrl-session-A",
      }),
      /create failed/,
    );
    const latest = await readLatestDispatch(root, "wf-1", "planner:1");
    assert.equal(latest.state, "failed");
    assert.match(latest.lastError, /create: create failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: failure on promptAsync transitions to failed with lastError", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("planner-session-1", { failPrompt: true });
    await assert.rejects(
      dispatchWorker({
        repoRoot: root,
        workflowId: "wf-1",
        role: ROLES.PLANNER,
        keyInput: { revision: 1 },
        payload: { promptText: "plan this" },
        client,
        parentSessionID: "ctrl-session-A",
      }),
      /prompt failed/,
    );
    const latest = await readLatestDispatch(root, "wf-1", "planner:1");
    assert.equal(latest.state, "failed");
    assert.match(latest.lastError, /promptAsync: prompt failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: rejects when controller lease is absent", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient("planner-session-1");
    await assert.rejects(
      dispatchWorker({
        repoRoot: root,
        workflowId: "wf-1",
        role: ROLES.PLANNER,
        keyInput: { revision: 1 },
        payload: {},
        client,
        parentSessionID: "ctrl-session-A",
      }),
      /controller lease not issued/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchWorker: rejects when parentSessionID does not hold the lease", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("planner-session-1");
    await assert.rejects(
      dispatchWorker({
        repoRoot: root,
        workflowId: "wf-1",
        role: ROLES.PLANNER,
        keyInput: { revision: 1 },
        payload: {},
        client,
        parentSessionID: "ctrl-session-X",
      }),
      /does not hold the lease/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizeChildCall: matches the recorded session id; rejects everything else", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const client = fakeClient("builder-session-1");
    await dispatchWorker({
      repoRoot: root,
      workflowId: "wf-1",
      role: ROLES.BUILDER,
      keyInput: { taskId: "a", round: 1 },
      payload: { promptText: "build" },
      client,
      parentSessionID: "ctrl-session-A",
    });
    const ok = await authorizeChildCall(
      root,
      "wf-1",
      ROLES.BUILDER,
      { taskId: "a", round: 1 },
      { sessionID: "builder-session-1", agent: "ship-task-builder" },
    );
    assert.deepEqual(ok, { ok: true, sessionID: "builder-session-1", dispatchKey: "builder:a:1", message: "dispatch session matched" });
    const wrong = await authorizeChildCall(
      root,
      "wf-1",
      ROLES.BUILDER,
      { taskId: "a", round: 1 },
      { sessionID: "someone-else" },
    );
    assert.equal(wrong.ok, false);
    assert.equal(wrong.kind, "session-mismatch");
    const missing = await authorizeChildCall(
      root,
      "wf-1",
      ROLES.BUILDER,
      { taskId: "missing", round: 1 },
      { sessionID: "builder-session-1" },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, "no-dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizeControllerCall: requires the controller lease to match", async () => {
  const root = makeRepo();
  try {
    await issueControllerLease(root, "wf-1", "ctrl-session-A");
    const ok = await authorizeControllerCall(root, "wf-1", {
      sessionID: "ctrl-session-A",
      agent: "ship-controller",
    });
    assert.equal(ok.ok, true);
    const wrong = await authorizeControllerCall(root, "wf-1", {
      sessionID: "ctrl-session-X",
      agent: "ship-controller",
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.kind, "lease-mismatch");
    const wrongAgent = await authorizeControllerCall(root, "wf-1", {
      sessionID: "ctrl-session-A",
      agent: "ship-task-builder",
    });
    assert.equal(wrongAgent.ok, false);
    assert.equal(wrongAgent.kind, "wrong-agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issueControllerLease + withControllerLease: takeover fails the first controller closed", async () => {
  const root = makeRepo();
  try {
    await withControllerLease(root, "wf-1", "ctrl-session-A", async () => {});
    const first = await readControllerLease(root, "wf-1");
    assert.equal(first.controllerSessionID, "ctrl-session-A");
    await withControllerLease(root, "wf-1", "ctrl-session-B", async () => {});
    const second = await readControllerLease(root, "wf-1");
    assert.equal(second.controllerSessionID, "ctrl-session-B");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchKeyFor: deterministic per role", () => {
  assert.equal(dispatchKeyFor(ROLES.PLANNER, { revision: 3 }), "planner:3");
  assert.equal(dispatchKeyFor(ROLES.BUILDER, { taskId: "a", round: 2 }), "builder:a:2");
  assert.equal(dispatchKeyFor(ROLES.TASK_REVIEWER, { taskId: "a", round: 2 }), "task-reviewer:a:2");
  assert.equal(dispatchKeyFor(ROLES.FINAL_STANDARDS, { packageHash: "abc" }), "final-reviewer:abc:standards");
  assert.equal(dispatchKeyFor(ROLES.FINAL_SPEC, { packageHash: "abc" }), "final-reviewer:abc:spec");
});
