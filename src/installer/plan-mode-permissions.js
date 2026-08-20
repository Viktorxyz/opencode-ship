/*
 * Plan Mode permission generator.
 *
 * The Plan Mode sub-agent is a thin role inside opencode.js: it
 * must be able to write a narrow set of plan/spec paths and
 * nothing else. The block is deny-first, then a narrow allow on
 * the plan paths.
 *
 *   {
 *     "bash": "deny",
 *     "edit": {
 *       "*": "deny",
 *       ".git/opencode-ship/plans/**": "allow",
 *       "docs/superpowers/**": "allow"
 *     },
 *     "task": "deny"
 *   }
 *
 * opencode.js evaluates the LAST matching rule, so the broad
 * "deny" entries are the default and the narrow "allow" on
 * `.git/opencode-ship/plans/**` and `docs/superpowers/**` are the
 * only exceptions. The generator returns the block in this exact
 * shape so a consumer's `opencode.json` can include it under
 * `agent.plan.permission`.
 *
 * The renderPlanModeBlock helper emits a JSON-encoded string
 * suitable for direct injection into a consumer's config file.
 *
 * Installer ownership:
 *
 *   From 1.1.2 the installer owns TWO leaf pointers inside
 *   `agent.plan.permission`:
 *
 *     - /agent/plan/permission/edit/docs~1superpowers~1** = "allow"
 *     - /agent/plan/permission/edit/.git~1opencode-ship~1plans~1** = "allow"
 *
 *   The whole `/agent/plan/permission` block is NOT owned; the
 *   consumer may keep / replace / extend any other key. The
 *   pointer is promoted from a string to an object on install
 *   (when the consumer previously declared `edit: "deny"` etc.)
 *   and the promotion record captures the previous scalar value
 *   so uninstall can restore it.
 *
 *   applyPlanModeOwnership() remains for callers that want the
 *   full deny-first block, but the installer does not call it.
 */

export const PLAN_PATH_PREFIX = ".git/opencode-ship/plans";
export const SUPERPOWERS_PATH_PREFIX = "docs/superpowers";

const DENY_DEFAULT = "deny";
const ALLOW_PLANS = "allow";
const PLANS_GLOB = `${PLAN_PATH_PREFIX}/**`;
const SUPERPOWERS_GLOB = `${SUPERPOWERS_PATH_PREFIX}/**`;

export const PLAN_EDIT_GLOB = SUPERPOWERS_GLOB;
export const PLAN_EDIT_PLANS_GLOB = PLANS_GLOB;
export const PLAN_EDIT_GLOB_POINTER = "/agent/plan/permission/edit/docs~1superpowers~1**";
export const PLAN_EDIT_PLANS_GLOB_POINTER = "/agent/plan/permission/edit/.git~1opencode-ship~1plans~1**";
export const PLAN_EDIT_PARENT_POINTER = "/agent/plan/permission/edit";

/**
 * Build the Plan Mode permission object. Returned as a plain
 * object so callers can merge it into a larger config.
 */
export function planModePermissions() {
  return {
    build: {
      bash: DENY_DEFAULT,
      edit: {
        "*": DENY_DEFAULT,
        [PLANS_GLOB]: ALLOW_PLANS,
        [SUPERPOWERS_GLOB]: ALLOW_PLANS,
      },
      webfetch: DENY_DEFAULT,
      task: DENY_DEFAULT,
      delivery_inspect: DENY_DEFAULT,
      delivery_issue: DENY_DEFAULT,
      delivery_worktree: DENY_DEFAULT,
      delivery_verify: DENY_DEFAULT,
      delivery_review: DENY_DEFAULT,
      delivery_pr: DENY_DEFAULT,
      delivery_ready: DENY_DEFAULT,
      delivery_merge: DENY_DEFAULT,
      delivery_cleanup: DENY_DEFAULT,
    },
  };
}

/**
 * Render the Plan Mode block as a JSON-encoded string. The
 * resulting text is suitable for direct concatenation into a
 * consumer's `agent.build.permission` field. Keys are emitted
 * in deterministic order (deny first, then narrow allow) so a
 * reviewer can read the policy top-to-bottom.
 */
export function renderPlanModeBlock() {
  return JSON.stringify(planModePermissions().build, null, 2);
}

/**
 * Return `{ doc, record }` where `doc` is the input with
 * `agent.plan.permission.edit` promoted to an object when the
 * consumer previously declared it as a scalar string, and
 * `record` is the promotion record (when promotion happened) so
 * the reconciler can append it to the lock for uninstall.
 *
 *   undefined              -> no edit; no record (the glob is
 *                             applied into a freshly created
 *                             object underneath)
 *   "deny" / "allow" / ... -> { "*": S, [GLOB]: "allow" };
 *                             record that the parent edit was
 *                             previously this scalar
 *   { "*": S, "...": ... }  -> unchanged; no record (the glob is
 *                             applied into the existing object)
 *   { "docs/superpowers/**": "deny" } -> conflict: glob already
 *                             explicitly denies; return
 *                             { doc, record: { conflict: true } }
 */
export function promotePlanEditIfString(doc) {
  const edit = readPath(doc, ["agent", "plan", "permission", "edit"]);
  if (edit === undefined) {
    return { doc, record: null };
  }
  if (typeof edit === "string") {
    const next = setPath(doc, ["agent", "plan", "permission", "edit"], { "*": edit });
    const record = {
      pointer: PLAN_EDIT_PARENT_POINTER,
      previous: { existed: true, value: edit },
      promotion: true,
    };
    return { doc: next, record };
  }
  if (edit && typeof edit === "object" && !Array.isArray(edit)) {
    if (Object.prototype.hasOwnProperty.call(edit, SUPERPOWERS_GLOB) && edit[SUPERPOWERS_GLOB] === "deny") {
      return { doc, record: { conflict: true, pointer: PLAN_EDIT_GLOB_POINTER } };
    }
    return { doc, record: null };
  }
  return { doc, record: null };
}

function readPath(doc, tokens) {
  let cursor = doc;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[token];
  }
  return cursor;
}

function setPath(doc, tokens, value) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const root = Array.isArray(doc) ? [...doc] : { ...doc };
  let cursor = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const key = tokens[i];
    const next = cursor[key];
    const copy = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    cursor[key] = copy;
    cursor = copy;
  }
  cursor[tokens[tokens.length - 1]] = value;
  return root;
}
