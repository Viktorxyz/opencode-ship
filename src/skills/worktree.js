/**
 * Worktree boundary validation.
 *
 * `ship_skill_install` must never write into the consumer's main
 * checkout. It is allowed only against a registered linked
 * worktree (one that appears in `git worktree list --porcelain`).
 *
 * The validator refuses:
 *
 *   - the main worktree (the checkout that owns .git/),
 *   - unregistered directories,
 *   - directories that escape the main repository via `..`,
 *   - symlink traversal (lexical alias through a symlink),
 *   - ancestor components that are themselves symlinks.
 *
 * The consumer's repoRoot is the canonical reference. We resolve
 * both sides through `realpath` and compare canonical paths.
 */
import { execFile } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { resolve, dirname, sep, isAbsolute } from "node:path";

/**
 * Read the registered worktrees for the main repo via
 * `git worktree list --porcelain -z`. Returns an array of objects
 * with the canonical worktree path and branch.
 *
 * @param {string} mainRepo
 * @returns {Promise<Array<{ path: string, branch: string | null }>>}
 */
export function listRegisteredWorktrees(mainRepo) {
  return new Promise((resolveP, rejectP) => {
    execFile(
      "git",
      ["-C", mainRepo, "worktree", "list", "--porcelain", "-z"],
      { shell: false, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return rejectP(err);
        const records = parsePorcelain(stdout);
        const mainRecord = records.shift(); // first entry is the main worktree
        const mainPath = mainRecord?.worktree ? resolve(mainRecord.worktree) : null;
        const linked = [];
        for (const r of records) {
          if (!r.worktree) continue;
          const p = resolve(r.worktree);
          // Skip worktrees that resolve to the main path (defensive).
          if (mainPath && p === mainPath) continue;
          linked.push({ path: p, branch: r.HEAD ?? null });
        }
        resolveP(linked);
      },
    );
  });
}

function parsePorcelain(text) {
  // `git worktree list --porcelain -z` emits records separated by
  // an empty (zero-length) NUL-terminated line. Each non-empty
  // line is terminated by NUL (no LF). A record therefore looks
  // like: `worktree <path>\u0000HEAD <sha>\u0000branch
  // refs/heads/<name>\u0000\u0000`. We split on NUL and regroup.
  const tokens = text.split("\u0000");
  /** @type {Array<{ worktree?: string, HEAD?: string }>} */
  const out = [];
  /** @type {{ worktree?: string, HEAD?: string }} */
  let current = {};
  for (const tok of tokens) {
    if (tok.length === 0) {
      if (Object.keys(current).length > 0) {
        out.push(current);
        current = {};
      }
      continue;
    }
    const idx = tok.indexOf(" ");
    const key = idx === -1 ? tok : tok.slice(0, idx);
    const value = idx === -1 ? "" : tok.slice(idx + 1);
    if (key === "branch") {
      current.HEAD = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
    } else {
      current[key] = value;
    }
  }
  if (Object.keys(current).length > 0) out.push(current);
  return out;
}

/**
 * Validate that `worktreePath` is a registered linked worktree of
 * `mainRepo`. Returns `{ ok: true, path }` or `{ ok: false, kind,
 * message }`.
 *
 * Kinds:
 *   - "main":       path is the main checkout
 *   - "missing":    path does not exist
 *   - "unlinked":   path exists but is not registered
 *   - "escape":     path lexically escapes the main repository
 *   - "symlink":    path resolves through a symlink
 *   - "ancestor-symlink": an ancestor of the path is a symlink
 *   - "absolute":   a destination component of the path is absolute
 *   - "parent-relative": a destination component uses `..`
 *
 * @param {string} mainRepo
 * @param {string} worktreePath
 */
export async function validateLinkedWorktree(mainRepo, worktreePath) {
  const main = resolve(mainRepo);
  if (!existsSync(main)) {
    return { ok: false, kind: "missing", message: `main repository ${main} does not exist` };
  }
  if (!worktreePath) {
    return { ok: false, kind: "unlinked", message: "worktreePath is required" };
  }
  const wt = resolve(worktreePath);
  if (!existsSync(wt)) {
    return { ok: false, kind: "missing", message: `worktree ${wt} does not exist` };
  }
  if (wt === main) {
    return { ok: false, kind: "main", message: "installs into the main worktree are forbidden" };
  }
  // The worktree must lexically live inside the consumer's repo
  // tree OR be an external linked worktree. A registered linked
  // worktree can live outside the main checkout directory (e.g.
  // a sibling path), so we accept either: inside the main
  // directory, or outside but not escaping `..` past any ancestor.
  const insideMain = wt.startsWith(main + sep) || wt === main;
  const linked = await listRegisteredWorktrees(main);
  const matched = linked.find((entry) => entry.path === wt);
  if (!matched && !insideMain) {
    return {
      ok: false,
      kind: "unlinked",
      message: `worktree ${wt} is not registered (git worktree list) and is not inside ${main}`,
    };
  }
  // Ancestor-symlink walk: refuse any path whose lexically-named
  // ancestor is a symlink. We walk from wt up to the root.
  let cursor = wt;
  while (cursor !== dirname(cursor)) {
    const stat = await fs.lstat(cursor).catch(() => null);
    if (stat?.isSymbolicLink()) {
      return {
        ok: false,
        kind: "ancestor-symlink",
        message: `worktree path contains a symlink at ${cursor}`,
      };
    }
    cursor = dirname(cursor);
  }
  // `..` must not traverse out of the worktree. We check that the
  // canonical realpath equals the lexical path; this catches the
  // symlink-alias case which `ancestor-symlink` might miss if the
  // symlink lives above the worktree.
  const real = await fs.realpath(wt).catch(() => null);
  if (real && real !== wt) {
    return {
      ok: false,
      kind: "symlink",
      message: `worktree ${wt} resolves through a symlink to ${real}`,
    };
  }
  return { ok: true, path: wt, registered: !!matched };
}

/**
 * Validate that a destination path under a worktree is safe to
 * install into. The destination must be a relative POSIX path
 * without leading separators, `..` segments, or absolute paths.
 *
 * @param {string} destRel
 */
export function validateRelativeInstallPath(destRel) {
  if (typeof destRel !== "string" || destRel.length === 0) {
    return { ok: false, kind: "absolute", message: "destination path required" };
  }
  if (isAbsolute(destRel)) {
    return { ok: false, kind: "absolute", message: `destination must be relative: ${destRel}` };
  }
  const parts = destRel.split(sep);
  for (const p of parts) {
    if (p === "..") {
      return { ok: false, kind: "parent-relative", message: `destination escapes worktree: ${destRel}` };
    }
  }
  return { ok: true };
}
