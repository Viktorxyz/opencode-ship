/**
 * delivery_verify tool.
 *
 * Runs the project-owned canonical verification command, records the
 * HEAD SHA, and updates the manifest. The subprocess is spawned with
 * `shell:false` and respects the configured `timeoutMs`. After a
 * successful run the manifest moves to `validating`; failed runs
 * stay in their current state and surface a typed `verify-failed`
 * envelope. `requireCleanDiffAfter` rejects a non-empty working tree
 * so the verifier always records against the exact commit pushed to
 * the PR.
 */

import { spawn } from "node:child_process";
import * as git from "../drivers/git.js";
import { readManifest, writeManifest } from "../state/manifest-store.js";
import { transition } from "../state/lifecycle.js";
import { publishGateReceipt } from "../workflow/gate-receipts.js";
import { createHash } from "node:crypto";

function runCommand(argv, cwd, timeoutMs) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (d) => stdoutChunks.push(d.toString()));
    proc.stderr.on("data", (d) => stderrChunks.push(d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        status: killed ? -1 : code ?? -1,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });
  });
}

export function createVerifyTool(deps) {
  return async function verify(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    const commands = deps.adapter?.verification?.commands ?? [];
    if (commands.length === 0) return { kind: "no-commands" };
    const cmd = input.commandId
      ? commands.find((c) => c.id === input.commandId)
      : commands[0];
    if (!cmd) return { kind: "command-not-found", commandId: input.commandId ?? commands[0]?.id };

    if (!m.worktreePath) {
      return { kind: "manifest-state", state: m.state, reason: "no worktree" };
    }
    if (
      m.state !== "worktree-created" &&
      m.state !== "draft-open" &&
      m.state !== "validating" &&
      m.state !== "ready"
    ) {
      return { kind: "manifest-state", state: m.state };
    }

    if (deps.adapter?.verification?.requireCleanDiffAfter) {
      if (!git.isWorktreeClean(m.worktreePath)) {
        return { kind: "worktree-dirty" };
      }
    }

    const head = git.currentHead(m.worktreePath);
    if (!head) return { kind: "no-head" };

    const timeoutMs = cmd.timeoutMs ?? 1800_000;
    const result = await runCommand(cmd.argv, m.worktreePath, timeoutMs);
    const stdoutTail = result.stdout.slice(-2000);
    const stderrTail = result.stderr.slice(-2000);
    if (result.status !== 0) {
      return {
        kind: "verify-failed",
        commandId: cmd.id,
        status: result.status,
        stdoutTail,
        stderrTail,
        headSha: head,
      };
    }

    const { receipt } = await publishGateReceipt(deps.repoRoot, m.taskId, "verification", {
      headSha: head,
      commandId: cmd.id,
      argv: cmd.argv,
      exitCode: 0,
      stdoutSha256: createHash("sha256").update(result.stdout, "utf8").digest("hex"),
      stderrSha256: createHash("sha256").update(result.stderr, "utf8").digest("hex"),
    });
    const t = transition(
      { ...m, lastVerifierSha: head, lastVerificationHash: receipt.receiptHash },
      "validating",
      { reason: `verify ok (${cmd.id})` },
    );
    if (!t.ok) return { kind: "lifecycle", reason: t.reason };
    const next = {
      ...m,
      lastVerifierSha: head,
      lastVerificationHash: receipt.receiptHash,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason },
      ],
      updatedAt: new Date().toISOString(),
    };
    const manifestPath = await writeManifest(deps.repoRoot, next);

    return {
      contractVersion: 1,
      commandId: cmd.id,
      status: 0,
      stdoutTail,
      stderrTail,
      headSha: head,
      verificationHash: receipt.receiptHash,
      manifestPath,
    };
  };
}
