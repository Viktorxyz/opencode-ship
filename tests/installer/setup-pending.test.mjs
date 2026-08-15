/*
 * Unit tests for src/installer/setup-pending.js.
 *
 * Verifies the setup-pending marker is detected, read, written, and
 * cleared from the consumer's .opencode directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSetupPending,
  readSetupPending,
  writeSetupPending,
  clearSetupPending,
  setupPendingPath,
  SETUP_PENDING_REL_PATH,
} from "../../src/installer/setup-pending.js";

test("setup-pending: path resolves under .opencode", () => {
  assert.equal(SETUP_PENDING_REL_PATH, ".opencode/ship.setup-pending.json");
  const root = "/tmp/whatever";
  assert.equal(setupPendingPath(root), join(root, ".opencode", "ship.setup-pending.json"));
});

test("setup-pending: round-trip writes, reads, clears", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-setup-pending-"));
  try {
    assert.equal(isSetupPending(root), false);
    assert.equal(readSetupPending(root), null);

    await writeSetupPending(root, {
      profile: "engineering",
      reason: "unit test",
      createdAt: new Date().toISOString(),
    });
    assert.equal(isSetupPending(root), true);
    const payload = readSetupPending(root);
    assert.equal(payload.profile, "engineering");
    assert.equal(payload.reason, "unit test");

    assert.equal(clearSetupPending(root), true);
    assert.equal(isSetupPending(root), false);
    assert.equal(clearSetupPending(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
