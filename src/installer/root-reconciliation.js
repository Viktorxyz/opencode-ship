/**
 * Root pointer reconciliation.
 *
 * Single source of truth for the three reversible operations on
 * the consumer's `opencode.json`:
 *
 *   - `install`         apply the active profile's pointer set to a
 *                       consumer root config; record the original
 *                       value as `previous` so uninstall can restore;
 *   - `profile-transition`
 *                       apply the new profile's pointer set while
 *                       keeping core pointers untouched and
 *                       engineering pointers either promoted
 *                       (core -> engineering) or reverted
 *                       (engineering -> core);
 *   - `uninstall`       remove every installer-owned pointer and
 *                       restore the originally recorded `previous`
 *                       value so the consumer's root config is
 *                       byte-identical to its preinstall state.
 *
 * Every output pointer record carries `scope: "core" | "engineering"`
 * so the installer's lock can drive reversible transitions and
 * record-only-when-engineering scope decisions downstream.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  POINTER_ENTRIES,
  applyOwnedPointers,
  applyPlanModeOwnership,
  findRootConfig,
  synthesizeDefaultRootConfig,
  formatRootConfig,
  formatRootConfigPreserving,
  parseRootConfigPreservingOrder,
  readRootConfig,
} from "./root-config.js";
import { getPointer, setPointer, removePointer, stableStringify } from "./json-pointer.js";
import { bytesHashString } from "./hash.js";
import { planModePermissions, promotePlanEditIfString, PLAN_EDIT_GLOB_POINTER, PLAN_EDIT_PARENT_POINTER } from "./plan-mode-permissions.js";
import { matrixLeafPointers } from "./root-permissions.js";
import { applyJsoncEdits, diffPointers } from "./jsonc-edit.js";
import { parse as jsoncParse } from "jsonc-parser";

export const PLAN_MODE_POINTER = "/agent/plan/permission";

/**
 * @typedef {"core" | "engineering"} Profile
 */

/**
 * @typedef {Object} RootPointerDescriptor
 * @property {string} pointer
 * @property {"value" | "object-entry" | "array-member"} strategy
 * @property {Profile} scope
 * @property {any} [value] Desired value (for value strategy).
 */

/**
 * @typedef {Object} RootPointerRecord
 * @property {string} pointer
 * @property {"value" | "object-entry" | "array-member"} strategy
 * @property {Profile} scope
 * @property {string} [installedSha256]
 * @property {{ existed: false } | { existed: true, value: unknown }} [previous]
 */

/**
 * Default pointer descriptors per profile.
 *
 * @param {Profile} profile
 * @returns {RootPointerDescriptor[]}
 */
export function desiredPointersForProfile(profile) {
  // From 1.1.0 the active profile is always engineering. Legacy
  // core installs promote to engineering, so all Build-agent
  // permission pointers are engineering-scoped. Legacy core
  // pointer records in existing locks are read-promoted too.
  //
  // The installer owns two leaf pointers inside the consumer's
  // `agent.plan.permission` block:
  //
  //   /agent/plan/permission/edit/docs~1superpowers~1** = "allow"
  //   /agent/plan/permission/edit/.git~1opencode-ship~1plans~1** = "allow"
  //
  // Both globs are required so the OpenCode Plan mode can write
  // brainstorming / writing-plans / wayfinder output. The whole
  // `/agent/plan/permission` block is still consumer-owned; the
  // consumer may keep / replace / extend any other key. When the
  // consumer previously declared `agent.plan.permission.edit` as a
  // scalar string, the installer promotes it to an object on
  // apply and records the previous value so uninstall can restore
  // it.
  //
  // The canonical engineering pointers are the matrix-derived leaf
  // pointers; the legacy delivery_* pointers are folded in for
  // consumers that already adopted opencode-delivery 0.1.x.
  return matrixLeafPointers();
}

/**
 * Compute the set of reconciler operations for the consumer's
 * root config under the three modes. The returned plan includes:
 *
 *   - `edits`: ordered list of pointer-level operations;
 *   - `pointerRecords`: every record that should land in the new
 *     lock (always includes untouched core pointers so uninstall
 *     can restore them);
 *   - `target` / `relPath`: which root file the plan applies to;
 *   - `bytes`: bytes to write to the root file;
 *   - `document`: the parsed document after edits.
 *
 * @param {{
 *   repoRoot: string,
 *   profile: Profile,
 *   mode: "install" | "profile-transition" | "uninstall",
 *   previousRecords?: RootPointerRecord[],
 *   previousDocument?: unknown,
 *   forceRepair?: boolean,
 *   pointerDescriptors?: RootPointerDescriptor[],
 * }} input
 */
export async function planRootReconciliation(input) {
  const profile = input.profile;
  const mode = input.mode;
  if (!["core", "engineering"].includes(profile)) {
    throw new Error(`planRootReconciliation: invalid profile ${profile}`);
  }
  if (!["install", "profile-transition", "uninstall"].includes(mode)) {
    throw new Error(`planRootReconciliation: invalid mode ${mode}`);
  }
  const detected = findRootConfig(input.repoRoot);
  const target = detected.path ?? join(input.repoRoot, detected.relative);
  const descriptors = input.pointerDescriptors ?? desiredPointersForProfile(profile);
  const previousRecords = input.previousRecords ?? [];

  if (mode === "uninstall") {
    return planUninstallRoot({
      target,
      relPath: detected.relative,
      previousRecords,
      previousDocument: input.previousDocument,
    });
  }

  const fileMissing = !existsSync(target);
  if (fileMissing && !input.forceRepair) {
    // Profile transition with no root config: still update the
    // lock so engineering-only records are dropped and core
    // records are kept / seeded. The bytes are null because
    // there is no file to write.
    if (mode === "profile-transition") {
      return {
        kind: "noop",
        op: "root-config",
        target,
        relPath: detected.relative,
        reason: "no root opencode.json present",
        edits: [],
        pointerRecords: reconcileRecordsAfterTransition(descriptors, previousRecords),
      };
    }
    return {
      kind: "noop",
      op: "root-config",
      target,
      relPath: detected.relative,
      reason: "no root opencode.json present",
      edits: [],
      pointerRecords: seedPointerRecords(descriptors, previousRecords),
    };
  }

  let doc;
  if (fileMissing && input.forceRepair) {
    doc = synthesizeDefaultRootConfig();
    // From this release the installer does NOT own the Plan Mode
    // permission block. The consumer may configure it through the
    // built-in Plan agent; opencode-ship provides a dedicated
    // ship-planner instead. We only seed Build-agent permissions.
    for (const descriptor of descriptors) {
      doc = setPointer(doc, descriptor.pointer, descriptor.value);
    }
    const bytes = Buffer.from(formatRootConfig(doc), "utf8");
    return {
      kind: "create",
      op: "root-config",
      target,
      relPath: detected.relative,
      bytes,
      desiredSha: bytesHashString(stableStringify(doc)),
      currentSha: null,
      edits: descriptors.map((d) => ({ kind: "create", pointer: d.pointer, value: "(synthesized)" })),
      pointerRecords: seedPointerRecords(descriptors, previousRecords),
      format: "json",
      document: doc,
      reason: "creating root opencode.json with installer-owned Build permissions",
    };
  }

  const docResult = readRootConfig(target);
  if (!docResult.ok) {
    return {
      kind: "noop",
      op: "root-config",
      target,
      relPath: detected.relative,
      reason: `root config ${docResult.error.kind}`,
      edits: [],
      pointerRecords: previousRecords,
    };
  }
  if (mode === "profile-transition") {
    return planProfileTransitionRoot({
      doc: docResult,
      target,
      relPath: detected.relative,
      descriptors,
      previousRecords,
    });
  }
  return planInstallRoot({
    doc: docResult,
    target,
    relPath: detected.relative,
    descriptors,
    previousRecords,
  });
}

function reconcileRecordsAfterTransition(descriptors, previousRecords) {
  const desiredCore = new Set(descriptors.filter((d) => d.scope === "core").map((d) => d.pointer));
  const out = previousRecords.filter((r) => r.scope === "core" || (r.scope === "engineering" && desiredCore.has(r.pointer)));
  const seen = new Set(out.map((r) => r.pointer));
  for (const d of descriptors) {
    if (seen.has(d.pointer)) continue;
    out.push({
      pointer: d.pointer,
      strategy: d.strategy,
      scope: d.scope,
      installedSha256: d.value !== undefined ? bytesHashString(stableStringify(d.value)) : null,
      previous: { existed: false },
    });
  }
  return out;
}

function staleRecordsToRemove(previousRecords, descriptors) {
  // A record is stale when its pointer is no longer in the desired
  // descriptor set and the active profile still owns it (so core-
  // scoped records for legacy consumers stay untouched). The
  // reconciler calls this on install and on update so a release
  // that drops a matrix leaf leaves no orphan pointer on disk.
  const desired = new Set(descriptors.map((d) => d.pointer));
  return previousRecords.filter((r) => r.scope === "engineering" && !desired.has(r.pointer));
}

function planInstallRoot({ doc, target, relPath, descriptors, previousRecords }) {
  // Promote `agent.plan.permission.edit` from a scalar string to an
  // object before apply so we can write the new glob underneath it
  // without losing the consumer's original value. A conflict is
  // surfaced when the consumer has explicitly set the glob to
  // "deny" — the installer refuses to overwrite.
  const promotion = promotePlanEditIfString(doc.value);
  if (promotion.record && promotion.record.conflict) {
    return {
      kind: "conflict",
      op: "root-config",
      target,
      relPath,
      reason: `consumer-owned Plan edit glob is set to deny: ${promotion.record.pointer}`,
      edits: [{ kind: "conflict", pointer: promotion.record.pointer, reason: "consumer-denied" }],
      pointerRecords: previousRecords,
      format: doc.format,
      document: doc.value,
    };
  }
  // Drop lock entries whose pointer is no longer in the desired
  // descriptor set. This path removes a matrix leaf on upgrade
  // (for example `/agent/build/permission/*` after the wildcard
  // is dropped from the matrix); the prior value (or a leaf
  // removal when the pointer never existed) restores the byte state.
  const stale = staleRecordsToRemove(previousRecords, descriptors);
  let sourceDoc = promotion.doc;
  const staleEdits = [];
  for (const r of stale) {
    if (r.previous && r.previous.existed) {
      sourceDoc = setPointer(sourceDoc, r.pointer, r.previous.value);
      staleEdits.push({ kind: "restore", pointer: r.pointer, value: r.previous.value });
    } else {
      sourceDoc = removePointer(sourceDoc, r.pointer);
      staleEdits.push({ kind: "remove", pointer: r.pointer });
    }
  }
  // Filter the lock records so the next write does not re-add the
  // stale pointers. `mergePointerRecords` will re-emit only what is
  // still in `descriptors` or what is being applied this run.
  const livePreviousRecords = previousRecords.filter((r) => !stale.some((s) => s.pointer === r.pointer));
  const result = applyOwnedPointers(sourceDoc, {
    pointerEntries: descriptors.map((d) => ({ pointer: d.pointer, strategy: d.strategy, value: d.value })),
    allowEqualValues: true,
  });
  const edits = [...staleEdits];
  for (const a of result.applied) edits.push({ kind: "create", pointer: a.pointer, value: a.value });
  for (const s of result.skipped) {
    if (s.reason === "already equal") continue;
    edits.push({ kind: "conflict", pointer: s.pointer, reason: s.reason, existing: s.existing, desired: s.desired });
  }
  const reorderPointers = equalExceptionsBeforeNewWildcard(sourceDoc, descriptors);
  let docForWrite = result.doc;
  for (const descriptor of reorderPointers) {
    docForWrite = setPointer(removePointer(docForWrite, descriptor.pointer), descriptor.pointer, descriptor.value);
  }
  let bytes;
  try {
    const isJsonc = doc.format === "jsonc";
    if (isJsonc) {
      // JSONC: use jsonc-parser so comments / trailing commas /
      // ordering / line endings survive byte-for-byte.
      const pointerEdits = diffPointers(
        doc.value,
        docForWrite,
        result.applied.map((a) => a.pointer),
      );
      for (const descriptor of reorderPointers) {
        pointerEdits.push({ pointer: descriptor.pointer, op: "delete" });
        pointerEdits.push({ pointer: descriptor.pointer, value: descriptor.value, op: "set" });
      }
      // Replay the promotion as an explicit edit so the consumer's
      // scalar edit is replaced with the object shape that carries
      // the new globs.
      if (promotion.record) {
        pointerEdits.push({ pointer: promotion.record.pointer, op: /** @type {"delete"} */ ("delete") });
        pointerEdits.push({ pointer: promotion.record.pointer, value: promotion.record.previous.value, op: /** @type {"set"} */ ("set") });
      }
      // Surface stale-pointer removals (matrix leaf dropped in the
      // current release) as explicit edits so the byte output drops
      // the orphan keys.
      for (const e of staleEdits) {
        if (e.kind === "restore") {
          pointerEdits.push({ pointer: e.pointer, op: /** @type {"set"} */ ("set"), value: e.value });
        } else {
          pointerEdits.push({ pointer: e.pointer, op: /** @type {"delete"} */ ("delete") });
        }
      }
      bytes = applyJsoncEdits(doc.raw ?? "", pointerEdits);
    } else {
      const { value: sourceValue } = parseRootConfigPreservingOrder(doc.raw ?? "");
      if (sourceValue && typeof sourceValue === "object") {
        docForWrite = sourceValue;
        // Apply stale-pointer removals first so the subsequent
        // setPointer calls for the new descriptors do not resurrect
        // an orphan key that lives under a still-present parent.
        for (const e of staleEdits) {
          if (e.kind === "restore") {
            docForWrite = setPointer(docForWrite, e.pointer, e.value);
          } else {
            docForWrite = removePointer(docForWrite, e.pointer);
          }
        }
        // Apply promotion first so the subsequent setPointer calls
        // for the glob can walk into the parent object.
        if (promotion.record) {
          docForWrite = setPointer(docForWrite, promotion.record.pointer, { "*": promotion.record.previous.value });
        }
        for (const a of result.applied) {
          docForWrite = setPointer(docForWrite, a.pointer, a.value);
        }
        for (const descriptor of reorderPointers) {
          docForWrite = setPointer(removePointer(docForWrite, descriptor.pointer), descriptor.pointer, descriptor.value);
        }
      }
      bytes = Buffer.from(formatRootConfigPreserving(docForWrite), "utf8");
    }
    } catch {
      bytes = Buffer.from(formatRootConfig(result.doc), "utf8");
    }
  const records = mergePointerRecords(descriptors, livePreviousRecords, result, doc.before);
  if (promotion.record) {
    records.push({
      pointer: promotion.record.pointer,
      strategy: "value",
      scope: "engineering",
      installedSha256: null,
      previous: promotion.record.previous,
      promotion: true,
    });
  }
  return {
    kind: edits.some((e) => e.kind === "conflict") ? "conflict" : (edits.length ? "update" : "noop"),
    op: "root-config",
    target,
    relPath,
    bytes,
    desiredSha: bytesHashString(stableStringify(docForWrite)),
    currentSha: doc.sha256 ?? null,
    edits,
    pointerRecords: records,
    format: doc.format,
    document: docForWrite,
    reason: edits.length === 0
      ? "no installer-owned entries missing"
      : `apply ${result.applied.length} / skip ${result.skipped.length}`,
  };
}

function equalExceptionsBeforeNewWildcard(doc, descriptors) {
  const wildcardParents = new Set();
  for (const descriptor of descriptors) {
    if (!descriptor.pointer.endsWith("/*") || getPointer(doc, descriptor.pointer) !== undefined) continue;
    wildcardParents.add(descriptor.pointer.slice(0, descriptor.pointer.lastIndexOf("/")));
  }
  return descriptors.filter((descriptor) => {
    if (descriptor.pointer.endsWith("/*")) return false;
    const parent = descriptor.pointer.slice(0, descriptor.pointer.lastIndexOf("/"));
    if (!wildcardParents.has(parent)) return false;
    const existing = getPointer(doc, descriptor.pointer);
    return existing !== undefined && stableStringify(existing) === stableStringify(descriptor.value);
  });
}

function planProfileTransitionRoot({ doc, target, relPath, descriptors, previousRecords }) {
  // Profile transitions:
  //   core -> engineering: apply engineering descriptors; keep core
  //                         records' `previous` value untouched.
  //   engineering -> core: drop every engineering-scoped pointer
  //                         and restore the prior value (or remove
  //                         the pointer entirely if it never existed).
  const desired = descriptors;

  // Promote Plan edit scalar -> object before apply.
  const promotion = promotePlanEditIfString(doc.value);
  if (promotion.record && promotion.record.conflict) {
    return {
      kind: "conflict",
      op: "root-config",
      target,
      relPath,
      reason: `consumer-owned Plan edit glob is set to deny: ${promotion.record.pointer}`,
      edits: [{ kind: "conflict", pointer: promotion.record.pointer, reason: "consumer-denied" }],
      pointerRecords: previousRecords,
      format: doc.format,
      document: doc.value,
    };
  }

  // Fail-closed drift check: every pointer we are about to remove
  // must still match the `installedSha256` recorded at install time.
  // If the consumer has modified a managed pointer since the last
  // write, refuse the transition so the operation does not silently
  // restore a stale `previous` value on top of the user's edit.
  const drift = [];
  for (const rec of previousRecords) {
    const stillDesired = desired.some((d) => d.pointer === rec.pointer && d.scope === rec.scope);
    if (stillDesired) continue;
    if (typeof rec.installedSha256 !== "string" || rec.installedSha256.length === 0) continue;
    const currentValue = getPointer(doc.value, rec.pointer);
    if (currentValue === undefined) {
      // Pointer was removed by the consumer; remove-record path
      // will not touch the document. Allow the transition.
      continue;
    }
    const currentHash = bytesHashString(stableStringify(currentValue));
    if (currentHash !== rec.installedSha256) {
      drift.push({ pointer: rec.pointer, recorded: rec.installedSha256, current: currentHash });
    }
  }
  if (drift.length > 0) {
    return {
      kind: "conflict",
      op: "root-config",
      target,
      relPath,
      reason: `installed pointer drift: ${drift.map((d) => `${d.pointer} (recorded ${d.recorded.slice(0, 8)}…, current ${d.current.slice(0, 8)}…)`).join("; ")}`,
      edits: drift.map((d) => ({ kind: "conflict", pointer: d.pointer, reason: "installed-pointer-drift" })),
      pointerRecords: previousRecords,
    };
  }

  let next = JSON.parse(JSON.stringify(promotion.doc));
  const edits = [];
  const mergedRecords = previousRecords.map((r) => ({ ...r }));
  const recordIndex = new Map(mergedRecords.map((r, idx) => [r.pointer, idx]));

  // 1. Remove engineering-scoped pointers that are no longer desired
  //    OR are not in the new profile's descriptor set. Restore the
  //    prior value when the record's `previous` says it existed; if
  //    it never existed, drop the pointer entirely.
  for (let i = mergedRecords.length - 1; i >= 0; i--) {
    const rec = mergedRecords[i];
    const isStillDesired = desired.some((d) => d.pointer === rec.pointer && d.scope === rec.scope);
    if (isStillDesired) continue;
    // This pointer is leaving the lock.
    if (rec.previous && rec.previous.existed) {
      next = setPointer(next, rec.pointer, rec.previous.value);
      edits.push({ kind: "restore", pointer: rec.pointer, value: rec.previous.value });
    } else {
      // Remove the pointer entirely. The JSON pointer layer
      // collapses the parent to an empty object when its last
      // child is removed, so the uninstall plan can be cleaned up
      // by the byte-restore step below.
      if (getPointer(next, rec.pointer) !== undefined) {
        next = removePointer(next, rec.pointer);
        edits.push({ kind: "remove", pointer: rec.pointer });
      }
    }
    mergedRecords.splice(i, 1);
    recordIndex.delete(rec.pointer);
  }

  // 2. Apply every desired pointer (creates or updates).
  for (const d of desired) {
    const existing = getPointer(next, d.pointer);
    if (existing === d.value) {
      // Already equal; record stays in the lock with the same
      // previous value, but bump installedSha256.
      const idx = recordIndex.get(d.pointer);
      if (idx != null) {
        mergedRecords[idx] = {
          ...mergedRecords[idx],
          scope: d.scope,
          installedSha256: bytesHashString(stableStringify(d.value)),
        };
      } else {
        mergedRecords.push({
          pointer: d.pointer,
          strategy: d.strategy,
          scope: d.scope,
          installedSha256: bytesHashString(stableStringify(d.value)),
          previous: { existed: existing !== undefined, value: existing ?? null },
        });
      }
      continue;
    }
    if (existing === undefined) {
      next = setPointer(next, d.pointer, d.value);
      edits.push({ kind: "create", pointer: d.pointer, value: d.value });
      const idx = recordIndex.get(d.pointer);
      if (idx != null) {
        mergedRecords[idx] = {
          ...mergedRecords[idx],
          scope: d.scope,
          installedSha256: bytesHashString(stableStringify(d.value)),
          previous: { existed: false },
        };
      } else {
        mergedRecords.push({
          pointer: d.pointer,
          strategy: d.strategy,
          scope: d.scope,
          installedSha256: bytesHashString(stableStringify(d.value)),
          previous: { existed: false },
        });
      }
    } else {
      // Conflict: the user has a different value than what we want
      // to install at this pointer. Surface it as a conflict; the
      // installer refuses to overwrite.
      edits.push({
        kind: "conflict",
        pointer: d.pointer,
        reason: "different existing value",
        existing,
        desired: d.value,
      });
    }
  }

  let docForWrite = next;
  let bytes;
  try {
    const isJsonc = doc.format === "jsonc";
    if (isJsonc) {
      /** @type {Array<{ pointer: string, value?: unknown, op: "set" | "delete" }>} */
      const pointerEdits = [];
      for (const e of edits) {
        if (e.kind === "create" || e.kind === "restore") {
          pointerEdits.push({ pointer: e.pointer, value: e.value, op: /** @type {"set"} */ ("set") });
        } else if (e.kind === "remove") {
          pointerEdits.push({ pointer: e.pointer, op: /** @type {"delete"} */ ("delete") });
        }
      }
      if (promotion.record) {
        pointerEdits.push({ pointer: promotion.record.pointer, op: /** @type {"delete"} */ ("delete") });
        pointerEdits.push({ pointer: promotion.record.pointer, value: promotion.record.previous.value, op: /** @type {"set"} */ ("set") });
      }
      bytes = applyJsoncEdits(doc.raw ?? "", pointerEdits);
      const reparsed = jsoncParse(bytes.toString("utf8"), undefined, { allowTrailingComma: true });
      docForWrite = collapseEmptyAncestors(reparsed) ?? reparsed;
    } else {
      const { value: sourceValue } = parseRootConfigPreservingOrder(doc.raw ?? "");
      if (sourceValue && typeof sourceValue === "object") {
        docForWrite = sourceValue;
        if (promotion.record) {
          docForWrite = setPointer(docForWrite, promotion.record.pointer, { "*": promotion.record.previous.value });
        }
        for (const e of edits) {
          if (e.kind === "create" || e.kind === "restore") {
            docForWrite = setPointer(docForWrite, e.pointer, e.value);
          } else if (e.kind === "remove") {
            docForWrite = removePointer(docForWrite, e.pointer);
          }
        }
      }
      docForWrite = collapseEmptyAncestors(docForWrite) ?? docForWrite;
      bytes = Buffer.from(formatRootConfigPreserving(docForWrite), "utf8");
    }
  } catch {
    bytes = Buffer.from(formatRootConfig(collapseEmptyAncestors(next) ?? next), "utf8");
  }
  if (promotion.record) {
    if (!recordIndex.has(promotion.record.pointer)) {
      mergedRecords.push({
        pointer: promotion.record.pointer,
        strategy: "value",
        scope: "engineering",
        installedSha256: null,
        previous: promotion.record.previous,
        promotion: true,
      });
    }
  }
  return {
    kind: edits.some((e) => e.kind === "conflict") ? "conflict" : (edits.some((e) => e.kind === "create" || e.kind === "remove" || e.kind === "restore") ? "update" : "noop"),
    op: "root-config",
    target,
    relPath,
    bytes,
    desiredSha: bytesHashString(stableStringify(docForWrite)),
    currentSha: doc.sha256 ?? null,
    edits,
    pointerRecords: mergedRecords,
    format: doc.format,
    document: docForWrite,
    reason: "profile transition reconciliation",
  };
}

function planUninstallRoot({ target, relPath, previousRecords, previousDocument }) {
  // Uninstall restores the preinstall state: every recorded
  // pointer gets its `previous.value` (or is removed when it never
  // existed). The result is the original consumer document, not
  // the installer-managed one.
  if (previousRecords.length === 0) {
    return {
      kind: "noop",
      op: "root-config",
      target,
      relPath,
      reason: "no installer-owned pointers recorded",
      edits: [],
      pointerRecords: [],
    };
  }
  const docResult = readRootConfig(target);
  if (!docResult.ok) {
    return {
      kind: "noop",
      op: "root-config",
      target,
      relPath,
      reason: `root config ${docResult.error.kind}`,
      edits: [],
      pointerRecords: previousRecords,
    };
  }

  // Fail-closed drift check: refuse to uninstall when an
  // installer-recorded pointer has been edited by the consumer
  // since the last install. Silently restoring the original
  // `previous` value would erase the user's edit, so the whole
  // transaction must abort and require explicit user intervention.
  const drift = [];
  for (const rec of previousRecords) {
    if (typeof rec.installedSha256 !== "string" || rec.installedSha256.length === 0) continue;
    const currentValue = getPointer(docResult.value, rec.pointer);
    if (currentValue === undefined) continue;
    const currentHash = bytesHashString(stableStringify(currentValue));
    if (currentHash !== rec.installedSha256) {
      drift.push({ pointer: rec.pointer, recorded: rec.installedSha256, current: currentHash });
    }
  }
  if (drift.length > 0) {
    return {
      kind: "conflict",
      op: "root-config",
      target,
      relPath,
      reason: `installed pointer drift: ${drift.map((d) => `${d.pointer} (recorded ${d.recorded.slice(0, 8)}…, current ${d.current.slice(0, 8)}…)`).join("; ")}`,
      edits: drift.map((d) => ({ kind: "conflict", pointer: d.pointer, reason: "installed-pointer-drift" })),
      pointerRecords: previousRecords,
    };
  }

  let doc = docResult.value;
  const edits = [];
  // Sort records by depth descending so deeply-nested leaves are
  // removed before their intermediate parents are restored. The
  // pointer layer would otherwise crash / silently corrupt a
  // restored scalar parent over the still-present child keys.
  const sortedRecords = [...previousRecords].sort((a, b) => {
    return b.pointer.split("/").length - a.pointer.split("/").length;
  });
  for (const rec of sortedRecords) {
    if (rec.previous && rec.previous.existed) {
      doc = setPointer(doc, rec.pointer, rec.previous.value);
      edits.push({ kind: "restore", pointer: rec.pointer, value: rec.previous.value });
    } else {
      const current = getPointer(doc, rec.pointer);
      if (current !== undefined) {
        doc = removePointer(doc, rec.pointer);
        edits.push({ kind: "remove", pointer: rec.pointer });
      }
    }
  }
  let docForWrite = doc;
  let bytes;
  try {
    const isJsonc = docResult.format === "jsonc";
    if (isJsonc) {
      /** @type {Array<{ pointer: string, value?: unknown, op: "set" | "delete" }>} */
      const collapsed = collapseEmptyAncestors(doc) ?? doc;
      const prunePointers = new Set();
      for (const e of edits) {
        if (e.kind !== "remove") continue;
        const tokens = e.pointer.split("/").slice(1);
        for (let i = tokens.length - 1; i > 0; i--) {
          const ancestor = `/${tokens.slice(0, i).join("/")}`;
          if (getPointer(collapsed, ancestor) === undefined) prunePointers.add(ancestor);
        }
      }
      const topPrunes = [...prunePointers]
        .sort((a, b) => a.length - b.length)
        .filter((pointer, index, all) => !all.slice(0, index).some((parent) => pointer.startsWith(`${parent}/`)));
      const pointerEdits = [];
      for (const e of edits) {
        if (e.kind === "restore") {
          pointerEdits.push({ pointer: e.pointer, value: e.value, op: /** @type {"set"} */ ("set") });
        } else if (e.kind === "remove" && !topPrunes.some((parent) => e.pointer === parent || e.pointer.startsWith(`${parent}/`))) {
          pointerEdits.push({ pointer: e.pointer, op: /** @type {"delete"} */ ("delete") });
        }
      }
      for (const pointer of topPrunes) {
        pointerEdits.push({ pointer, op: /** @type {"delete"} */ ("delete") });
      }
      bytes = applyJsoncEdits(docResult.raw ?? "", pointerEdits);
      docForWrite = jsoncParse(bytes.toString("utf8"), undefined, { allowTrailingComma: true });
    } else {
      const { value: sourceValue } = parseRootConfigPreservingOrder(docResult.raw ?? "");
      if (sourceValue && typeof sourceValue === "object") {
        docForWrite = sourceValue;
        for (const e of edits) {
          if (e.kind === "restore") {
            docForWrite = setPointer(docForWrite, e.pointer, e.value);
          } else if (e.kind === "remove") {
            docForWrite = removePointer(docForWrite, e.pointer);
          }
        }
      }
      docForWrite = collapseEmptyAncestors(docForWrite) ?? docForWrite;
      bytes = Buffer.from(formatRootConfigPreserving(docForWrite), "utf8");
    }
  } catch {
    bytes = Buffer.from(formatRootConfig(collapseEmptyAncestors(doc)), "utf8");
  }
  return {
    kind: edits.length ? "update" : "noop",
    op: "root-config",
    target,
    relPath,
    bytes,
    desiredSha: bytesHashString(stableStringify(docForWrite)),
    currentSha: docResult.sha256 ?? null,
    edits,
    pointerRecords: [],
    format: docResult.format,
    document: docForWrite,
    reason: "uninstall restores the preinstall root config",
  };
}

function collapseEmptyAncestors(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  // First recurse into children so the leafmost empty shells are
  // dropped before we try to drop their parents.
  const out = {};
  for (const k of Object.keys(doc)) {
    if (k === "__sourceOrder__") continue;
    const collapsed = collapseEmptyAncestors(doc[k]);
    // Drop keys whose value collapsed to undefined (empty shells).
    if (collapsed === undefined) continue;
    out[k] = collapsed;
  }
  // Re-emit the source order for stable serialization.
  if (Array.isArray(doc.__sourceOrder__)) {
    out.__sourceOrder__ = doc.__sourceOrder__.filter((k) => k in out);
  }
  // Drop the key entirely when the remaining value is an empty
  // object (i.e. every child was removed). We do not drop arrays,
  // primitives, or non-empty objects.
  const remainingKeys = Object.keys(out).filter((k) => k !== "__sourceOrder__");
  if (remainingKeys.length === 0) return undefined;
  return out;
}

function seedPointerRecords(descriptors, previousRecords) {
  const out = previousRecords.map((r) => ({ ...r }));
  const seen = new Set(out.map((r) => r.pointer));
  for (const d of descriptors) {
    if (seen.has(d.pointer)) continue;
    out.push({
      pointer: d.pointer,
      strategy: /** @type {any} */ (d.strategy),
      scope: d.scope,
      installedSha256: d.value !== undefined ? bytesHashString(stableStringify(d.value)) : null,
      previous: { existed: false },
    });
  }
  return out;
}

function mergePointerRecords(descriptors, previousRecords, result, beforeSnapshot) {
  const out = previousRecords.map((r) => ({ ...r }));
  // Index tracks what is already in `out` (including prior records
  // and any applied pointers we added). Used to prevent duplicate
  // records when the desired list contains the same pointer twice
  // (e.g. the matrix leaf and a legacy pointer entry both targeting
  // `/agent/build/permission/delivery_inspect: allow`).
  const index = new Map(out.map((r, idx) => [r.pointer, idx]));
  for (const a of result.applied) {
    const previousEntry = beforeSnapshot?.[a.pointer];
    // Omit the `value` field entirely when the previous entry is
    // undefined so the JSON encoding stays stable (JSON.stringify
    // drops `undefined` fields, so storing them would change the
    // hash after a round-trip).
    const previous = previousEntry === undefined
      ? { existed: false }
      : { existed: true, value: previousEntry };
    const next = {
      pointer: a.pointer,
      strategy: "value",
      scope: descriptors.find((d) => d.pointer === a.pointer)?.scope ?? "core",
      installedSha256: bytesHashString(stableStringify(a.value)),
      previous,
    };
    if (index.has(a.pointer)) {
      // Preserve the original `previous` value; only update scope
      // and installedSha256.
      const idx = index.get(a.pointer);
      out[idx] = {
        ...out[idx],
        scope: next.scope,
        installedSha256: next.installedSha256,
        // If the lock already had a record, keep its previous value
        // verbatim so uninstall restores the original pre-install
        // state even after multiple in-place updates.
        previous: out[idx].previous ?? next.previous,
      };
    } else {
      out.push(next);
      index.set(a.pointer, out.length - 1);
    }
  }
  for (const s of result.skipped) {
    if (s.reason !== "already equal") continue;
    if (index.has(s.pointer)) continue;
    // Capture the existing user value as `previous` so uninstall
    // can restore it byte-for-byte. The value is omitted entirely
    // when the existing pointer is undefined so the JSON encoding
    // stays stable (undefined fields are dropped by JSON.stringify).
    const existing = beforeSnapshot?.[s.pointer];
    const previous = existing === undefined
      ? { existed: false }
      : { existed: true, value: existing };
    out.push({
      pointer: s.pointer,
      strategy: "value",
      scope: descriptors.find((d) => d.pointer === s.pointer)?.scope ?? "core",
      installedSha256: bytesHashString(stableStringify(existing ?? null)),
      previous,
    });
    index.set(s.pointer, out.length - 1);
  }
  return out;
}
