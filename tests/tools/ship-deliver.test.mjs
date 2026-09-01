import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeliverTool } from "../../src/tools/ship-deliver.js";

function makeRepo({ setupComplete = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-deliver-"));
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

test("ship_deliver refuses an invalid issue number", async () => {
  const tool = createDeliverTool({
    repoRoot: process.cwd(),
    opencodeClient: fakeClient(),
    ctx: { sessionID: "build-session", agent: "build" },
  });

  const result = await tool({ issueNumber: 0, operationId: "invalid-issue" });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "deliver");
  assert.equal(result.operationId, "invalid-issue");
  assert.match(result.message, /issueNumber/);
});

test("ship_deliver refuses a missing or non-Build caller", async () => {
  const root = makeRepo();
  try {
    const missing = createDeliverTool({
      repoRoot: root,
      opencodeClient: fakeClient(),
    });
    const wrong = createDeliverTool({
      repoRoot: root,
      opencodeClient: fakeClient(),
      ctx: { sessionID: "controller-session", agent: "ship-controller" },
    });

    const missingResult = await missing({ issueNumber: 80 });
    const wrongResult = await wrong({ issueNumber: 80 });

    assert.equal(missingResult.ok, false);
    assert.match(missingResult.message, /ToolContext\.sessionID/);
    assert.equal(wrongResult.ok, false);
    assert.match(wrongResult.message, /Build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver refuses an unavailable OpenCode client", async () => {
  const root = makeRepo();
  try {
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: null,
      ctx: { sessionID: "build-session", agent: "build" },
    });

    const result = await tool({ issueNumber: 80 });

    assert.equal(result.ok, false);
    assert.match(result.message, /OpenCode client/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver refuses incomplete setup", async () => {
  const root = makeRepo({ setupComplete: false });
  try {
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: fakeClient(),
      ctx: { sessionID: "build-session", agent: "build" },
    });

    const result = await tool({ issueNumber: 80 });

    assert.equal(result.ok, false);
    assert.match(result.message, /setup is not complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ship_deliver returns the workflow and reuses its controller session", async () => {
  const root = makeRepo();
  try {
    const client = fakeClient();
    const tool = createDeliverTool({
      repoRoot: root,
      opencodeClient: client,
      ctx: { sessionID: "build-session", agent: "build" },
    });

    const first = await tool({ issueNumber: 80, operationId: "deliver-80" });
    const second = await tool({ issueNumber: 80, operationId: "deliver-80-retry" });

    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.kind, "deliver");
    assert.equal(first.operationId, "deliver-80");
    assert.equal(first.data.workflowId, "wf-80");
    assert.equal(first.data.controllerSessionID, "controller-session");
    assert.equal(first.data.dispatchKey, "controller:issue-80");
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.data.controllerSessionID, "controller-session");
    assert.equal(client.calls.create.length, 1);
    assert.equal(client.calls.promptAsync.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
