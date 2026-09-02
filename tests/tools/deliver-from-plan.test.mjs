import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeliverTool } from "../../src/tools/ship-deliver.js";

function makeRepo({ setupComplete = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-deliver-from-plan-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(join(root, ".opencode", "ship.lock.json"), JSON.stringify({
    manager: { setupComplete },
  }));
  return root;
}

function fakeClient() {
  const calls = { create: [], promptAsync: [] };
  return {
    calls,
    session: {
      create: async (options) => {
        calls.create.push(options);
        return { data: { id: "controller-session" }, error: undefined };
      },
      promptAsync: async (options) => {
        calls.promptAsync.push(options);
        return { data: undefined, error: undefined };
      },
    },
  };
}

test("ship_deliver accepts ship-plan agent context", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient();
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: client,
      ctx: { sessionID: "plan-session", agent: "ship-plan" },
    });
    const result = await tool({ issueNumber: 80 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.kind, "deliver");
    assert.equal(result.data.workflowId, "wf-80");
    assert.match(result.data.progress ?? "", /Track: issue #80\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver still accepts build agent context", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient();
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: client,
      ctx: { sessionID: "build-session", agent: "build" },
    });
    const result = await tool({ issueNumber: 80 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.kind, "deliver");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver still rejects ship-planner agent context", async () => {
  const root = makeRepo();
  try {
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: fakeClient(),
      ctx: { sessionID: "planner-session", agent: "ship-planner" },
    });
    const result = await tool({ issueNumber: 80 });
    assert.equal(result.ok, false);
    assert.match(result.message, /Build or ship-plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver does not double-print Build on dispatch", async () => {
  // The controller prints Build per task. ship_deliver must only
  // surface Track so the chat is not noisy.
  const root = makeRepo();
  try {
    const client = fakeClient();
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: client,
      ctx: { sessionID: "plan-session", agent: "ship-plan" },
    });
    const result = await tool({ issueNumber: 12 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.data.progress, /^Track: issue #12\.$/);
    assert.doesNotMatch(result.data.progress ?? "", /^Build:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
