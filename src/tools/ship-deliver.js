/**
 * Build-only durable delivery entrypoint.
 *
 * Dispatches one ship-controller session per issue. The controller then owns
 * workflow creation and must call ship_plan_start before implementation work.
 *
 * Authorization: the ToolContext session id is recorded as the
 * controller lease. Caller agents allowed: `build` (the durable
 * Build session) and `ship-plan` (the conversational planning
 * agent that confirmed the plan and is handing off to the
 * controller in this same chat). Any other agent is rejected.
 */

import { isSetupComplete, readLock } from "../installer/lock.js";
import { dispatchController } from "../runtime/opencode-dispatcher.js";
import { failure, success } from "./envelope.js";
import { nextLine, progressLine } from "../runtime/stages.js";

export function createDeliverTool(deps) {
  return async function deliver(input) {
    const opId = input.operationId ?? `deliver-${Date.now().toString(36)}`;
    const issueNumber = input.issueNumber;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return failure("deliver", "positive issueNumber required", {
        operationId: opId,
        retryable: false,
        details: { workflowId: null, controllerSessionID: null },
      });
    }

    const workflowId = `wf-${issueNumber}`;
    const ctx = deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string" || ctx.sessionID.length === 0) {
      return failure("deliver", "ToolContext.sessionID required (Build or ship-plan session)", {
        operationId: opId,
        retryable: false,
        details: { workflowId, controllerSessionID: null },
      });
    }
    if (ctx.agent !== "build" && ctx.agent !== "ship-plan") {
      return failure("deliver", "ToolContext.agent must be Build or ship-plan", {
        operationId: opId,
        retryable: false,
        details: { workflowId, controllerSessionID: null },
      });
    }

    const client = deps.opencodeClient;
    if (!client || typeof client.session?.create !== "function" || typeof client.session?.promptAsync !== "function") {
      return failure("deliver", "OpenCode client is unavailable", {
        operationId: opId,
        retryable: false,
        details: { workflowId, controllerSessionID: null },
      });
    }

    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("deliver", "setup is not complete; run /setup-ship-workflow first", {
        operationId: opId,
        retryable: false,
        details: { workflowId, controllerSessionID: null },
      });
    }

    try {
      const dispatched = await dispatchController({
        repoRoot: deps.repoRoot,
        issueNumber,
        client,
        parentSessionID: ctx.sessionID,
      });
      // ship_deliver only marks Track; the controller prints Build per task.
      const stage = "track";
      return success("deliver", {
        workflowId,
        controllerSessionID: dispatched.sessionID,
        dispatchKey: dispatched.dispatchKey,
        progress: progressLine(stage, { number: issueNumber }),
        next: nextLine(stage),
      }, { operationId: opId });
    } catch (err) {
      return failure("deliver", String(err?.message ?? err), {
        operationId: opId,
        retryable: true,
        details: { workflowId, controllerSessionID: null },
      });
    }
  };
}
