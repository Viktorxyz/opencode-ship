import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { readRunState } from "./run-controller.js";
import { bindFinalReview, hashAxisRecord, hashFinalReviewPackage } from "./final-review.js";
import { readGateReceipt } from "./gate-receipts.js";

export async function readFinalReviewEvidence(repoRoot, workflowId) {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const root = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review");
  const paths = {
    package: join(root, "package.json"),
    standards: join(root, "standards", "review.json"),
    spec: join(root, "spec", "review.json"),
  };
  for (const [kind, path] of Object.entries(paths)) {
    if (!existsSync(path)) throw new Error(`canonical final review ${kind} record is missing`);
  }
  const [pkg, standards, spec, runState] = await Promise.all([
    readJson(paths.package),
    readJson(paths.standards),
    readJson(paths.spec),
    readRunState(repoRoot, workflowId),
  ]);
  if (hashFinalReviewPackage(pkg) !== pkg.packageHash) {
    throw new Error("canonical final review package hash is invalid");
  }
  const [verification, ci] = await Promise.all([
    readGateReceipt(repoRoot, pkg.gateTaskId, "verification", pkg.verificationHash),
    readGateReceipt(repoRoot, pkg.gateTaskId, "ci", pkg.ciHash),
  ]);
  if (!verification || verification.headSha !== pkg.headSha || verification.exitCode !== 0) {
    throw new Error("canonical verification receipt does not match the final review package");
  }
  if (!ci || ci.headSha !== pkg.headSha || ci.checks?.some((check) => check.bucket !== "pass")) {
    throw new Error("canonical CI receipt does not match the final review package");
  }
  for (const [axis, record] of [["standards", standards], ["spec", spec]]) {
    if (record.axis !== axis || hashAxisRecord(record) !== record.reviewHash) {
      throw new Error(`canonical ${axis} review record hash is invalid`);
    }
    if (record.packageHash !== pkg.packageHash || record.headSha !== pkg.headSha || record.mergeBaseSha !== pkg.mergeBaseSha) {
      throw new Error(`canonical ${axis} review does not match the final review package`);
    }
  }
  const binding = bindFinalReview(standards, spec);
  if (!binding.ok) throw new Error(`canonical final review is not passing: ${binding.reason}`);
  if (!runState || !["ready-pending", "ready", "merged", "done"].includes(runState.state)) {
    throw new Error(`workflow is not final-review complete (state=${runState?.state ?? "missing"})`);
  }
  const summary = runState.finalReview;
  if (
    summary?.packageHash !== pkg.packageHash
    || summary?.headSha !== pkg.headSha
    || summary?.mergeBaseSha !== pkg.mergeBaseSha
    || summary?.standards?.reviewHash !== standards.reviewHash
    || summary?.spec?.reviewHash !== spec.reviewHash
  ) {
    throw new Error("workflow final-review summary does not match immutable review records");
  }
  return { package: pkg, standards, spec, verification, ci, runState };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
