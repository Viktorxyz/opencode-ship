/**
 * ship_status tool.
 *
 * Read-only compact workflow state. Returns the plan index,
 * the run record (if any), and the last ledger event.
 */

import { success, failure } from "./envelope.js";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { nextLine, progressLine } from "../runtime/stages.js";

const RUN_STATE_TO_STAGE = {
  drafting: "plan",
  "plan-approved": "approve",
  "issue-linked": "track",
  "running-tasks": "build",
  "all-tasks-done": "verify",
  "final-review": "review",
  "final-review-pass": "verify",
  "final-review-fail": "review",
  ready: "ready",
  merged: "merge",
  cleaned: "cleanup",
  failed: "review",
};

function stageForStatus(index, run, lastEvent) {
  if (run?.state && RUN_STATE_TO_STAGE[run.state]) return RUN_STATE_TO_STAGE[run.state];
  if (index?.state === "drafting") return "plan";
  return "plan";
}

export function createStatusTool(deps) {
  return async function status(input) {
    const opId = input.operationId ?? `status-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId) return failure("status", "workflowId required", { operationId: opId, retryable: false });
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const planRoot = join(opencodeShipStateDir(commonDir), "plans", workflowId);
      const runRoot = join(opencodeShipStateDir(commonDir), "runs", workflowId);
      const indexPath = join(planRoot, "index.json");
      if (!existsSync(indexPath)) return failure("status", "no workflow record", { operationId: opId, retryable: false });
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      let run = null;
      const runPath = join(runRoot, "run.json");
      if (existsSync(runPath)) run = JSON.parse(await readFile(runPath, "utf8"));
      let lastEvent = null;
      const eventsDir = join(runRoot, "events");
      if (existsSync(eventsDir)) {
        const events = await readdir(eventsDir);
        const sorted = events.filter((n) => n.endsWith(".json")).sort();
        if (sorted.length > 0) {
          lastEvent = JSON.parse(await readFile(join(eventsDir, sorted[sorted.length - 1]), "utf8"));
        }
      }
      const stage = stageForStatus(index, run, lastEvent);
      return success("status", {
        workflowId,
        stage,
        index,
        run,
        lastEvent,
        progress: progressLine(stage),
        next: nextLine(stage),
      }, { operationId: opId });
    } catch (err) {
      return failure("status", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
