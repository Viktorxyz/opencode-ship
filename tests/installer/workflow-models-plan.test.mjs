import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";
import { previewInstall, commitInstall } from "../../src/installer/executor.js";
import { computeIntegrity } from "../../src/installer/lock.js";

test("update: historical default builder is rewritten; custom planner is not", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const first = await previewInstall({ rootPath: repoRoot, models: {
    planner: "openai/gpt-4.1",
    builder: "minimax/MiniMax-M3",
    finalReviewer: "openai/gpt-5.6-sol",
  }});
  assert.equal(first.ok, true, JSON.stringify(first.error));
  await commitInstall(first, { command: "init" });

  const cfgPath = join(repoRoot, ".opencode/ship.config.json");
  const lockPath = join(repoRoot, ".opencode/ship.lock.json");
  const seeded = JSON.parse(await readFile(cfgPath, "utf8"));
  const deliveryBefore = seeded.delivery;
  const projectBefore = seeded.project;

  const schema4 = JSON.parse(await readFile(lockPath, "utf8"));
  delete schema4.manager.models;
  schema4.contractVersion = 4;
  schema4.manager.schemaVersion = 4;
  schema4.integrity = computeIntegrity(schema4);
  await writeFile(lockPath, JSON.stringify(schema4, null, 2) + "\n");

  const second = await previewInstall({ rootPath: repoRoot });
  const configOp = second.plan.find((op) => op.op === "config");
  assert.equal(configOp.configValue.workflow.models.planner, "openai/gpt-4.1");
  assert.equal(configOp.configValue.workflow.models.builder, "minimax-coding-plan/MiniMax-M3");
  await commitInstall(second, { command: "update" });
  const after = JSON.parse(await readFile(cfgPath, "utf8"));
  assert.deepEqual(after.delivery, deliveryBefore);
  assert.deepEqual(after.project, projectBefore);
  assert.equal(after.workflow.models.planner, "openai/gpt-4.1");
  assert.equal(after.workflow.models.builder, "minimax-coding-plan/MiniMax-M3");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(lock.manager.models.planner.source, "override");
  assert.equal(lock.manager.models.builder.source, "default");
});
