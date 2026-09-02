/*
 * Canonical opencode-ship tool set.
 *
 * The bundled plugin registers 51 typed tools:
 *   - 17 canonical ship_* lifecycle tools
 *   - 17 delivery_* aliases (same runners; kept for one minor)
 *   - 17 already-canonical ship_* workflow tools
 *
 * This module is the single source of truth for the expected set so:
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
  // 17 delivery_* aliases
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
  // 17 canonical ship_* lifecycle tools
  "ship_abandon",
  "ship_cleanup",
  "ship_github_read",
  "ship_inspect",
  "ship_issue",
  "ship_issue_close",
  "ship_issue_comment",
  "ship_issue_labels",
  "ship_issue_link",
  "ship_merge",
  "ship_pr",
  "ship_publish",
  "ship_ready",
  "ship_review",
  "ship_sync",
  "ship_verify",
  "ship_worktree",
  // 17 already-canonical ship workflow tools
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

export const LIFECYCLE_TOOL_ALIASES = Object.freeze([
  ["ship_inspect", "delivery_inspect"],
  ["ship_issue", "delivery_issue"],
  ["ship_worktree", "delivery_worktree"],
  ["ship_verify", "delivery_verify"],
  ["ship_review", "delivery_review"],
  ["ship_pr", "delivery_pr"],
  ["ship_ready", "delivery_ready"],
  ["ship_merge", "delivery_merge"],
  ["ship_cleanup", "delivery_cleanup"],
  ["ship_abandon", "delivery_abandon"],
  ["ship_github_read", "delivery_github_read"],
  ["ship_issue_comment", "delivery_issue_comment"],
  ["ship_issue_labels", "delivery_issue_labels"],
  ["ship_issue_link", "delivery_issue_link"],
  ["ship_issue_close", "delivery_issue_close"],
  ["ship_sync", "delivery_sync"],
  ["ship_publish", "delivery_publish"],
]);
