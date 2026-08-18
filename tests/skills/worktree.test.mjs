/**
 * Regression tests for the worktree-boundary validator used by
 * `ship_skill_install`. The validator must refuse the main
 * checkout, unregistered paths, symlink traversal, absolute
 * destinations, and parent-relative paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  listRegisteredWorktrees,
  validateLinkedWorktree,
  validateRelativeInstallPath,
  validateInstallDestination,
} from "../../src/skills/worktree.js";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("validateLinkedWorktree: refuses the main checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", root]);
    const r = await validateLinkedWorktree(root, root);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateLinkedWorktree: accepts a registered linked worktree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "# x\n");
    git(["-C", repo, "add", "README.md"]);
    git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const linked = join(repo, ".worktrees", "issue-1");
    mkdirSync(linked, { recursive: true });
    git(["-C", repo, "worktree", "add", "-b", "issue-1", linked]);
    const r = await validateLinkedWorktree(repo, linked);
    assert.equal(r.ok, true);
    assert.equal(r.registered, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("validateLinkedWorktree: refuses a non-registered path outside the main repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "# x\n");
    git(["-C", repo, "add", "README.md"]);
    git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const outside = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
    try {
      const r = await validateLinkedWorktree(repo, outside);
      assert.equal(r.ok, false);
      assert.equal(r.kind, "unlinked");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("validateLinkedWorktree: refuses a non-registered directory inside the main repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", repo]);
    const fake = join(repo, ".worktrees", "not-registered");
    mkdirSync(fake, { recursive: true });
    const r = await validateLinkedWorktree(repo, fake);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "unlinked");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("validateLinkedWorktree: refuses an ancestor symlink alias", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "# x\n");
    git(["-C", repo, "add", "README.md"]);
    git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const linked = join(repo, ".worktrees", "issue-1");
    mkdirSync(linked, { recursive: true });
    git(["-C", repo, "worktree", "add", "-b", "issue-1", linked]);
    const alias = join(repo, ".worktrees", "alias");
    symlinkSync(linked, alias);
    try {
      const r = await validateLinkedWorktree(repo, alias);
      assert.equal(r.ok, false);
      // The validator detects either the ancestor-symlink walk or
      // the realpath drift; both are valid refusals.
      assert.ok(r.kind === "ancestor-symlink" || r.kind === "symlink", `unexpected kind: ${r.kind}`);
    } finally {
      rmSync(alias, { recursive: false, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("validateRelativeInstallPath: refuses absolute paths", () => {
  const r = validateRelativeInstallPath("/abs/path");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "absolute");
});

test("validateRelativeInstallPath: refuses parent-relative escapes", () => {
  const r = validateRelativeInstallPath(".opencode/skills/../escape");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parent-relative");
});

test("validateRelativeInstallPath: accepts a clean relative path", () => {
  const r = validateRelativeInstallPath(".opencode/skills/find-skills");
  assert.equal(r.ok, true);
});

test("validateInstallDestination: refuses a symlinked destination ancestor", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "opencode-ship-dest-"));
  const outside = mkdtempSync(join(tmpdir(), "opencode-ship-dest-out-"));
  try {
    mkdirSync(join(worktree, ".opencode"), { recursive: true });
    symlinkSync(outside, join(worktree, ".opencode", "skills"));
    const r = await validateInstallDestination(worktree, ".opencode/skills/example");
    assert.equal(r.ok, false);
    assert.equal(r.kind, "symlink");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("listRegisteredWorktrees: returns linked worktrees excluding the main", async () => {
  const repo = mkdtempSync(join(tmpdir(), "opencode-ship-wt-"));
  try {
    git(["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "# x\n");
    git(["-C", repo, "add", "README.md"]);
    git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const linked = join(repo, ".worktrees", "issue-2");
    mkdirSync(linked, { recursive: true });
    git(["-C", repo, "worktree", "add", "-b", "issue-2", linked]);
    const list = await listRegisteredWorktrees(repo);
    assert.equal(list.length, 1);
    assert.equal(list[0].branch, "refs/heads/issue-2");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
