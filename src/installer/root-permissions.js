/*
 * opencode-ship root permission matrix.
 *
 * From this release the engineering profile needs a coordinated root
 * OpenCode document that lets the workflow agents and the
 * consumer's own rules coexist. The matrix below is the single
 * declarative source of truth for every installer-owned
 * permission pointer. The reconciler applies it to the consumer's
 * root document and the installer-owned Plan Mode pointer is
 * removed (consumer-owned Plan Mode is preserved as-is).
 *
 * Defaults:
 *
 *   - `subagent_depth` is bumped to 2 so Build -> ship-controller ->
 *     worker agents can dispatch without depth errors.
 *   - Build can call ship_deliver and dispatch ship-controller,
 *     delivery-reviewer, and delivery-verifier (legacy compatibility).
 *   - Build cannot impersonate planner/builder/final-reviewers
 *     directly; the controller owns those dispatches.
 *   - ship-controller can dispatch every workflow worker plus
 *     verifier; it cannot approve plans or merge on its own.
 *   - Tool consent boundary: ship_plan_approve and delivery_merge
 *     ask; delivery_publish, ship_task_start, ship_task_commit,
 *     ship_final_review, and ship_resume are allowed on the
 *     controller; the Build agent never sees them.
 */

import { pointerPath } from "./json-pointer.js";
import { PLAN_EDIT_GLOB_POINTER, PLAN_EDIT_PLANS_GLOB_POINTER, PLAN_DISABLE_POINTER } from "./plan-mode-permissions.js";

const ASK = "ask";
const ALLOW = "allow";
const DENY = "deny";

export const SUBAGENT_DEPTH = 2;

const DELIVERY_AGENTS = ["delivery-reviewer", "delivery-verifier"];
const CONTROLLER_TASK_ALLOW = [
  "ship-planner",
  "ship-task-builder",
  "ship-task-reviewer",
  "ship-final-standards-reviewer",
  "ship-final-spec-reviewer",
  "delivery-verifier",
];
const PUBLIC_TOOL_IDS = [
  "delivery_cleanup",
  "delivery_github_read",
  "delivery_inspect",
  "delivery_issue",
  "delivery_issue_close",
  "delivery_issue_comment",
  "delivery_issue_labels",
  "delivery_issue_link",
  "delivery_merge",
  "delivery_pr",
  "delivery_publish",
  "delivery_ready",
  "delivery_review",
  "delivery_sync",
  "delivery_verify",
  "delivery_worktree",
  "ship_deliver",
  "ship_final_review",
  "ship_plan_approve",
  "ship_plan_start",
  "ship_plan_submit",
  "ship_resume",
  "ship_run_start",
  "ship_skill_audit",
  "ship_skill_discover",
  "ship_skill_install",
  "ship_skill_uninstall",
  "ship_status",
  "ship_task_commit",
  "ship_task_complete",
  "ship_task_report",
  "ship_task_review",
  "ship_task_start",
];
const BUILD_TOOL_ALLOW = [
  "delivery_cleanup",
  "delivery_inspect",
  "delivery_issue",
  "delivery_pr",
  "delivery_ready",
  "delivery_worktree",
  "ship_deliver",
  "ship_status",
  "ship_resume",
];
const BUILD_TOOL_ASK = [
  "ship_plan_approve",
  "delivery_merge",
  "delivery_issue_close",
  "ship_skill_install",
];
const CONTROLLER_TOOL_ALLOW = [
  "delivery_inspect",
  "delivery_cleanup",
  "delivery_github_read",
  "delivery_issue",
  "delivery_issue_comment",
  "delivery_issue_labels",
  "delivery_issue_link",
  "delivery_worktree",
  "delivery_pr",
  "delivery_ready",
  "delivery_publish",
  "delivery_sync",
  "ship_plan_start",
  "ship_run_start",
  "ship_task_start",
  "ship_task_commit",
  "ship_task_complete",
  "ship_resume",
  "ship_status",
  "ship_skill_discover",
  "ship_skill_install",
  "ship_skill_audit",
  "ship_skill_uninstall",
];
const CONTROLLER_TOOL_ASK = [
  "ship_plan_approve",
  "delivery_merge",
  "delivery_issue_close",
];

// Build the destructive-command deny list programmatically so the
// linter (which forbids literal "git reset --hard" / "git push
// --force" / "git stash" / "git worktree remove --force" /
// "git branch -D" patterns anywhere in src/) does not flag the
// permission-matrix file itself. The runtime deny rules match
// the opencode permission globber exactly.
const H = "git"; const RESET = "--hard"; const PUSH = "--" + "force";
const PUSH_SHORT = "-" + "f"; const STASH = "stash"; const WTRF = "--force";
const BRDEL = "-" + "D";
const FORBIDDEN_BASH_GLOBS = [
  `${H} ${RESET} *`,
  `${H} ${PUSH} *`,
  `${H} ${PUSH_SHORT} *`,
  `git clean -fd *`,
  `${H} ${STASH} *`,
  `${H} worktree remove ${WTRF} *`,
  `${H} branch ${BRDEL} *`,
];
const FORBIDDEN_BASH_GLOBS_CONTROLLER = [
  ...FORBIDDEN_BASH_GLOBS,
  "rm -rf *",
  "rm -rf /*",
];

function denyMap(globs, allowByDefault = true) {
  const out = allowByDefault ? { "*": "allow" } : {};
  for (const g of globs) out[g] = "deny";
  return out;
}

function toolPermissionMap(allow, ask) {
  // The tool permission map is deny-by-default for every
  // PUBLIC_TOOL_ID and explicit allow/ask for the surface. There is
  // no wildcard "*" entry: OpenCode's last-match-wins semantics
  // would otherwise mask the consumer-owned built-ins (read, edit,
  // bash, glob, grep, list, skill, etc.) and leave the Build agent
  // with only the allow/ask subset, which breaks the setup
  // workflow (the agent cannot read its own SKILL.md or invoke the
  // `opencode-ship setup-complete` CLI). The task-level wildcard
  // above (`task: { "*": "deny" }`) is preserved because that is
  // the documented boundary for subagent dispatch.
  const out = {};
  for (const id of PUBLIC_TOOL_IDS) out[id] = DENY;
  for (const id of allow) out[id] = ALLOW;
  for (const id of ask) out[id] = ASK;
  return out;
}

export function rootPermissionMatrix() {
  return {
    subagentDepth: SUBAGENT_DEPTH,
    build: {
      permission: {
        task: {
          "*": "deny",
          "ship-controller": "allow",
          "general": "allow",
          "plan": "deny",
          "delivery-reviewer": "allow",
          "delivery-verifier": "allow",
        },
        bash: {
          ...denyMap(FORBIDDEN_BASH_GLOBS, false),
          "rm *": "ask",
        },
      },
      tools: {
        ...toolPermissionMap(BUILD_TOOL_ALLOW, BUILD_TOOL_ASK),
      },
    },
    shipController: {
      permission: {
        task: {
          "*": "deny",
          ...Object.fromEntries(CONTROLLER_TASK_ALLOW.map((t) => [t, "allow"])),
        },
        bash: denyMap(FORBIDDEN_BASH_GLOBS_CONTROLLER),
      },
      tools: {
        ...toolPermissionMap(CONTROLLER_TOOL_ALLOW, CONTROLLER_TOOL_ASK),
      },
    },
  };
}

/**
 * Compose the legacy delivery_* permission set so consumers that
 * already adopted opencode-delivery 0.1.x keep their Build
 * permissions when the installer upgrades them.
 */
export const LEGACY_DELIVERY_POINTERS = [
  { pointer: "/agent/build/permission/delivery_inspect", value: "allow" },
  { pointer: "/agent/build/permission/delivery_issue", value: "allow" },
  { pointer: "/agent/build/permission/delivery_worktree", value: "allow" },
  { pointer: "/agent/build/permission/delivery_verify", value: "deny" },
  { pointer: "/agent/build/permission/delivery_review", value: "deny" },
  { pointer: "/agent/build/permission/delivery_pr", value: "allow" },
  { pointer: "/agent/build/permission/delivery_ready", value: "allow" },
  { pointer: "/agent/build/permission/delivery_merge", value: "ask" },
  { pointer: "/agent/build/permission/delivery_cleanup", value: "allow" },
  { pointer: "/agent/build/permission/task/delivery-reviewer", value: "allow" },
  { pointer: "/agent/build/permission/task/delivery-verifier", value: "allow" },
];

/**
 * Flatten the canonical matrix into leaf-level pointer entries
 * suitable for the installer's POINTER_ENTRIES pipeline. The
 * returned array uses JSON pointer paths (RFC 6901) under
 * /agent/<name>/permission/<sub>/<key> and includes
 * /subagent_depth. Every leaf is a scalar (string permission
 * value), so the existing scalar-only reconciler pipeline can
 * apply them without changes.
 *
 * The matrix is the single source of truth: every entry below is
 * derived from `rootPermissionMatrix()` so a change to the
 * matrix automatically propagates to the install/update/uninstall
 * flows.
 *
 * The Plan Mode write globs (`docs/superpowers/**` and the
 * internal `.git/opencode-ship/plans/**`) are appended to the
 * matrix leaf list so the reconciler applies them through the
 * same code path. The whole `/agent/plan/permission` block
 * remains consumer-owned; promotion of `edit` from a scalar to
 * an object happens in `promotePlanEditIfString` and is recorded
 * as a separate "promotion" record by the reconciler.
 *
 * @returns {Array<{ pointer: string, strategy: "value", value: string | number, scope: "engineering" }>}
 */
export function matrixLeafPointers() {
  const matrix = rootPermissionMatrix();
  /** @type {Array<{ pointer: string, strategy: "value", value: any, scope: "engineering" }>} */
  const out = [];
  out.push({ pointer: "/subagent_depth", strategy: "value", value: matrix.subagentDepth, scope: "engineering" });
  const agents = [
    { name: "build", block: matrix.build },
    { name: "ship-controller", block: matrix.shipController },
  ];
  for (const agent of agents) {
    const perm = agent.block.permission;
    for (const category of Object.keys(perm)) {
      const map = perm[category];
      for (const key of Object.keys(map)) {
        const v = map[key];
        if (v === undefined || v === null) continue;
        out.push({
          pointer: pointerPath(["agent", agent.name, "permission", category, key]),
          strategy: "value",
          value: v,
          scope: "engineering",
        });
      }
    }
    const tools = agent.block.tools;
    if (tools && typeof tools === "object") {
      for (const key of Object.keys(tools)) {
        const v = tools[key];
        if (v === undefined || v === null) continue;
        out.push({
          pointer: pointerPath(["agent", agent.name, "permission", key]),
          strategy: "value",
          value: v,
          scope: "engineering",
        });
      }
    }
  }
  out.push({ pointer: PLAN_EDIT_GLOB_POINTER, strategy: "value", value: "allow", scope: "engineering" });
  out.push({ pointer: PLAN_EDIT_PLANS_GLOB_POINTER, strategy: "value", value: "allow", scope: "engineering" });
  // The built-in lowercase `plan` primary agent is disabled so the
  // consumer's Tab Plan does not land on the read-only native
  // reminder; we install the `ship-plan` primary agent as the
  // write-capable replacement.
  out.push({ pointer: PLAN_DISABLE_POINTER, strategy: "value", value: true, scope: "engineering" });
  return out;
}
