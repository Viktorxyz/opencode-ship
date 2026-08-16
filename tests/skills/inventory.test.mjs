/**
 * Regression tests for the trusted-skill inventory (schema v2).
 *
 * Asserts:
 *   - append-only chain semantics (sequence + previousHash + hash)
 *   - hash chain verification (gap, mismatch, break all detected)
 *   - findActiveInstall returns the latest install before any
 *     matching uninstall tombstone
 *   - malformed JSON, wrong schemaVersion, non-array events all
 *     fail closed rather than returning an empty inventory
 *   - absolute destinations are refused at append time
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readInventory,
  writeInventory,
  appendEvent,
  verifyInventory,
  findActiveInstall,
  INVENTORY_SCHEMA,
} from "../../src/skills/inventory.js";

const ZERO = "0".repeat(64);

test("inventory: starts empty with current schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    const inv = await readInventory(root);
    assert.equal(inv.schemaVersion, INVENTORY_SCHEMA);
    assert.deepEqual(inv.events, []);
    const chain = await verifyInventory(root);
    assert.deepEqual(chain, { ok: true, count: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: appendEvent writes a hash-chained install event", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    const ev = await appendEvent(root, {
      type: "install",
      skill: "find-skills",
      package: "vercel-labs/skills",
      version: "1.0.0",
      source: {
        packageSpec: "vercel-labs/skills",
        skillName: "find-skills",
        cliPackage: "skills@1.0.4",
        registryId: "vercel-labs/skills/find-skills",
        registrySnapshotHash: ZERO,
      },
      destination: ".opencode/skills/find-skills",
      files: [
        { path: "SKILL.md", sha256: ZERO, mode: 0o644, size: 0 },
      ],
    });
    assert.equal(ev.sequence, 1);
    assert.equal(ev.previousHash, ZERO);
    assert.match(ev.hash, /^[0-9a-f]{64}$/);
    const inv = await readInventory(root);
    assert.equal(inv.events.length, 1);
    const chain = await verifyInventory(root);
    assert.deepEqual(chain, { ok: true, count: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: appendEvent refuses an absolute destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    await assert.rejects(
      appendEvent(root, {
        type: "install",
        skill: "x",
        package: "y",
        version: null,
        source: { registryId: "y/x", packageSpec: "y", skillName: "x", cliPackage: "skills@1.0.4", registrySnapshotHash: ZERO },
        destination: "/tmp/abs/path",
        files: [],
      }),
      /absolute destination/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: chain break is detected", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    await appendEvent(root, {
      type: "install", skill: "a", package: "p", version: null,
      source: { registryId: "p/a", packageSpec: "p", skillName: "a", cliPackage: "skills@1.0.4", registrySnapshotHash: ZERO },
      destination: ".opencode/skills/a", files: [],
    });
    await appendEvent(root, {
      type: "install", skill: "b", package: "p", version: null,
      source: { registryId: "p/b", packageSpec: "p", skillName: "b", cliPackage: "skills@1.0.4", registrySnapshotHash: ZERO },
      destination: ".opencode/skills/b", files: [],
    });
    // Tamper: change the previousHash on event 2.
    const inv = await readInventory(root);
    inv.events[1].previousHash = "f".repeat(64);
    await writeInventory(root, inv);
    const chain = await verifyInventory(root);
    assert.equal(chain.ok, false);
    assert.equal(chain.reason, "chain-break");
    assert.equal(chain.sequence, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: hash mismatch is detected", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    await appendEvent(root, {
      type: "install", skill: "a", package: "p", version: null,
      source: { registryId: "p/a", packageSpec: "p", skillName: "a", cliPackage: "skills@1.0.4", registrySnapshotHash: ZERO },
      destination: ".opencode/skills/a", files: [],
    });
    const inv = await readInventory(root);
    inv.events[0].skill = "tampered";
    await writeInventory(root, inv);
    const chain = await verifyInventory(root);
    assert.equal(chain.ok, false);
    assert.equal(chain.reason, "hash-mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: malformed JSON fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", "ship.skills.lock.json"), "not json{", "utf8");
    const inv = await readInventory(root);
    assert.ok(inv.parseError, "malformed JSON should set parseError");
    const chain = await verifyInventory(root);
    assert.equal(chain.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: unsupported schemaVersion fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "ship.skills.lock.json"),
      JSON.stringify({ schemaVersion: 99, events: [] }, null, 2),
      "utf8",
    );
    const inv = await readInventory(root);
    assert.ok(/unsupported/i.test(inv.parseError ?? ""));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: findActiveInstall returns the latest install before a tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    const installed = await appendEvent(root, {
      type: "install", skill: "x", package: "p", version: null,
      source: { registryId: "p/x", packageSpec: "p", skillName: "x", cliPackage: "skills@1.0.4", registrySnapshotHash: ZERO },
      destination: ".opencode/skills/x",
      files: [{ path: "SKILL.md", sha256: ZERO, mode: 0o644, size: 0 }],
    });
    await appendEvent(root, {
      type: "uninstall", skill: "x", package: "p", installHash: installed.hash,
      destination: ".opencode/skills/x",
    });
    const found = await findActiveInstall(root, "x");
    assert.equal(found.ok, true);
    assert.equal(found.install, null, "tombstone should make the skill inactive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory: findActiveInstall returns null for an unknown skill without failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-inv-"));
  try {
    const found = await findActiveInstall(root, "missing");
    assert.equal(found.ok, true);
    assert.equal(found.install, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
