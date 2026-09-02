/*
 * Canonical opencode-ship tool set.
 *
 * The bundled plugin registers exactly 34 typed tools (17
 * delivery + 17 ship). This module is the
 * single source of truth for the expected set so:
 *
 *   - the in-process plugin-load test asserts the contract at the
 *     plugin boundary;
 *   - the opencode-discovery smoke test asserts the contract at
 *     the runtime boundary by polling a real opencode server;
 *   - the release workflow can fail fast if a future change adds
 *     or removes a tool without updating both consumers.
 *
 * Changing this set is a contract change. Both the in-process
 * test and the live-server test must continue to agree.
 */

export const EXPECTED_OPENCODE_SHIP_TOOLS = Object.freeze([
  // 17 delivery tools
  "delivery_abandon",
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
  // 17 ship tools
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
]);

/**
 * Frozen set, sorted lexicographically. The plugin-load and
 * opencode-discovery tests both compare against this exact set.
 */
export const EXPECTED_OPENCODE_SHIP_TOOL_IDS = Object.freeze(
  [...EXPECTED_OPENCODE_SHIP_TOOLS].sort(),
);

export const OPENCODE_SHIP_TOOL_COUNT = EXPECTED_OPENCODE_SHIP_TOOLS.length;
