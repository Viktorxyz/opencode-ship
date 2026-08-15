/*
 * opencode-ship root permission matrix.
 *
 * From 1.1.1 the engineering profile needs a coordinated root
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
 *   - Build can dispatch ship-controller, delivery-reviewer, and
 *     delivery-verifier (legacy compatibility).
 *   - Build cannot impersonate planner/builder/final-reviewers
 *     directly; the controller owns those dispatches.
 *   - ship-controller can dispatch every workflow worker plus
 *     verifier; it cannot approve plans or merge on its own.
 *   - Tool consent boundary: ship_plan_approve and delivery_merge
 *     ask; delivery_publish, ship_task_start, ship_task_commit,
 *     ship_final_review, and ship_resume are allowed on the
 *     controller; the Build agent never sees them.
 */

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
const BUILD_TOOL_ALLOW = [
  "delivery_inspect",
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
  "delivery_issue",
  "delivery_worktree",
  "delivery_pr",
  "delivery_ready",
  "delivery_publish",
  "ship_plan_start",
  "ship_plan_submit",
  "ship_run_start",
  "ship_task_start",
  "ship_task_commit",
  "ship_task_complete",
  "ship_final_review",
  "ship_resume",
  "ship_status",
  "ship_skill_discover",
  "ship_skill_install",
  "ship_skill_audit",
];
const CONTROLLER_TOOL_ASK = [
  "ship_plan_approve",
  "delivery_merge",
  "delivery_issue_close",
];

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
          "*": "allow",
          "rm *": "ask",
          "git reset --hard *": "deny",
          "git push --force *": "deny",
          "git push -f *": "deny",
          "git clean -fd *": "deny",
          "git stash *": "deny",
          "git worktree remove --force *": "deny",
          "git branch -D *": "deny",
        },
      },
      tools: {
        "*": "deny",
        ...Object.fromEntries(BUILD_TOOL_ALLOW.map((t) => [t, "allow"])),
        ...Object.fromEntries(BUILD_TOOL_ASK.map((t) => [t, "ask"])),
      },
    },
    shipController: {
      permission: {
        task: {
          "*": "deny",
          ...Object.fromEntries(CONTROLLER_TASK_ALLOW.map((t) => [t, "allow"])),
        },
        bash: {
          "*": "allow",
          "rm -rf *": "deny",
          "rm -rf /*": "deny",
          "git reset --hard *": "deny",
          "git push --force *": "deny",
          "git push -f *": "deny",
          "git clean -fd *": "deny",
          "git stash *": "deny",
          "git worktree remove --force *": "deny",
          "git branch -D *": "deny",
        },
      },
      tools: {
        "*": "deny",
        ...Object.fromEntries(CONTROLLER_TOOL_ALLOW.map((t) => [t, "allow"])),
        ...Object.fromEntries(CONTROLLER_TOOL_ASK.map((t) => [t, "ask"])),
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

void ASK;
void ALLOW;
void DENY;
