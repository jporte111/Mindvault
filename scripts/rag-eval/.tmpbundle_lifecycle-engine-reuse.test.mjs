// scripts/rag-eval/lifecycle-engine-reuse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// base44/shared/lifecycle/policy.ts
var DAY_MS = 864e5;
var DEFAULT_POLICY = {
  requireVerifiedToPublish: true,
  allowForceUnverifiedPublish: false,
  disallowTransitions: [],
  stuckAfterMs: 15 * 6e4,
  reconcileMaxAttempts: 3,
  gracePolicyMs: (intervalDays) => Math.min(14 * DAY_MS, Math.max(0, intervalDays) * 0.2 * DAY_MS),
  combinedApproveAndPublish: true
};
function computeFreshness(nextReviewDueAt, intervalDays, nowMs, policy = DEFAULT_POLICY) {
  if (!nextReviewDueAt || !intervalDays || intervalDays <= 0) return "unknown";
  const due = Date.parse(nextReviewDueAt);
  if (Number.isNaN(due)) return "unknown";
  if (nowMs >= due) return "overdue";
  if (nowMs >= due - policy.gracePolicyMs(intervalDays)) return "due_soon";
  return "current";
}

// base44/shared/lifecycle/operationMachine.ts
function isResumableStage(stage) {
  switch (stage) {
    case "index":
    case "verify":
    case "cutover_stalemark":
    case "cutover_restamp":
    case "cutover_cleanup":
    case "cutover_stale_clear":
    case "restamp":
    case "restamp_stale_clear":
      return true;
    case "apply":
    case "cutover_flip":
    case "compensate":
      return false;
    default:
      return false;
  }
}
function compensationKind(action, stage) {
  if (stage && isResumableStage(stage)) return "resume";
  if ((action === "activate" || action === "supersede") && stage === "cutover_flip") {
    return "rollback_activation";
  }
  if (stage === "apply") return "resume";
  return "manual";
}

// base44/shared/lifecycle/stateMachine.ts
function deriveLifecycleState(v) {
  if (v.isArchived === true) return "archived";
  if (v.verificationStatus === "rejected") return "rejected";
  if (v.isActiveVersion === true) return "active";
  if (v.reviewOutcome === "changes_requested") return "changes_requested";
  if (v.verificationStatus === "verified") return "verified";
  if (v.reviewRequestedAt) return "in_review";
  return "draft";
}
function isOpenDraftCandidate(v, lineage) {
  if (v.isActiveVersion) return false;
  if (v.isArchived === true) return false;
  if (v.verificationStatus === "rejected") return false;
  const state = deriveLifecycleState(v);
  if (state !== "draft" && state !== "in_review" && state !== "changes_requested" && state !== "verified") {
    return false;
  }
  return !lineage.some(
    (r) => r.isActiveVersion && r.id !== v.id && r.versionNumber > v.versionNumber
  );
}
var GRAPH = {
  draft: ["submit", "verify", "reject", "set_metadata", "archive"],
  in_review: ["request_changes", "verify", "reject", "set_metadata"],
  changes_requested: ["submit", "verify", "reject", "set_metadata"],
  verified: ["activate", "reject", "archive", "set_metadata", "submit"],
  active: [
    "create_version",
    "set_metadata",
    "confirm_current",
    "archive"
  ],
  archived: ["restore"],
  rejected: ["un_reject"]
};
function assertTransitionLegal(from, transition, policy) {
  if (policy.disallowTransitions.includes(transition)) {
    return { ok: false, reason: `transition '${transition}' is disabled by policy` };
  }
  if (!(GRAPH[from] || []).includes(transition)) {
    return {
      ok: false,
      reason: `illegal transition '${transition}' from state '${from}'`
    };
  }
  return { ok: true };
}
function normalizeForTransition(transition, ctx) {
  switch (transition) {
    case "submit":
      return {
        reviewRequestedAt: ctx.now,
        reviewOutcome: null
      };
    case "request_changes":
      return {
        reviewOutcome: "changes_requested"
      };
    case "verify":
      return {
        verificationStatus: "verified",
        reviewOutcome: null
      };
    case "reject":
      return {
        verificationStatus: "rejected",
        reviewRequestedAt: null,
        reviewOutcome: null
      };
    case "un_reject":
      return {
        verificationStatus: "unverified",
        reviewRequestedAt: ctx.now,
        reviewOutcome: null
      };
    case "activate":
      return {
        isActiveVersion: true,
        reviewOutcome: "confirmed_current"
      };
    case "archive":
      return {
        isArchived: true,
        reviewOutcome: "archived"
      };
    case "restore":
      return {
        isArchived: false,
        reviewRequestedAt: null,
        reviewOutcome: null
      };
    case "confirm_current":
      return {
        reviewOutcome: "confirmed_current",
        reviewRequestedAt: null
      };
    case "set_metadata":
      return {};
    // metadata patch is supplied by the caller; no review-field change
    case "create_version":
      return {};
    default:
      return {};
  }
}
function newDraftFields(now) {
  return {
    isActiveVersion: false,
    isArchived: false,
    verificationStatus: "unverified",
    reviewRequestedAt: null,
    reviewOutcome: null,
    indexState: "pending",
    indexedFingerprint: null,
    indexedVersionNumber: null
  };
}
function demoteFields() {
  return { isActiveVersion: false };
}

// base44/shared/lifecycle/verification.ts
function isIndexNoOp(x) {
  return x.fingerprintMatches && x.unitSetComplete && x.mismatches.length === 0;
}
function planReindex(x) {
  if (isIndexNoOp(x)) return "no_op";
  if (x.fingerprintMatches && x.unitSetComplete) return "restamp_repair";
  return "full_rebuild";
}

// base44/shared/lifecycle/types.ts
var StaleSeqError = class extends Error {
  constructor(message = "lifecycle_seq moved under this operation") {
    super(message);
    this.name = "StaleSeqError";
  }
};

// base44/shared/lifecycle/engine.ts
var REDACT_FALLBACK = (s) => String(s ?? "").slice(0, 800);
function createLifecycleEngine(deps) {
  const policy = deps.policy || DEFAULT_POLICY;
  const redact = deps.redact || REDACT_FALLBACK;
  const { persistence: db, indexWorker: worker, authorizer, clock, idGen } = deps;
  async function openOperation(action, target, payloadHash, actorId, prior) {
    const op = {
      operationId: idGen.operationId(),
      lineageId: target.lineageId,
      action,
      targetVersionId: target.id,
      priorActiveVersionId: prior?.id ?? null,
      expectedLifecycleSeq: target.lifecycleSeq,
      priorActiveLifecycleSeq: prior?.lifecycleSeq ?? null,
      status: "pending",
      failureStage: null,
      failureReason: null,
      payloadHash,
      resumeCount: 0,
      startedBy: actorId,
      startedAt: clock.now(),
      completedAt: null
    };
    await db.putOperation(op);
    return op;
  }
  async function advance(op, status) {
    op.status = status;
    if (status === "completed" || status === "failed") op.completedAt = clock.now();
    await db.putOperation(op);
  }
  async function fail(op, stage, err) {
    op.status = "failed";
    op.failureStage = stage;
    op.failureReason = redact(err instanceof Error ? err.message : String(err)).slice(0, 800);
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { ok: false, operationId: op.operationId, error: op.failureReason || "failed" };
  }
  async function guardedWrite(v, patch, op, expectedSeq, stage) {
    try {
      return await db.writeVersion(v.id, patch, expectedSeq);
    } catch (e) {
      if (e instanceof StaleSeqError) {
        await fail(op, stage, e);
        throw e;
      }
      throw e;
    }
  }
  async function runFullBuild(v, op) {
    await advance(op, "indexing");
    await worker.markStale([v.id]);
    await worker.build(v);
    await advance(op, "verifying");
    const complete = await worker.unitSetComplete(v);
    const mism = await worker.projectionMismatches(v);
    if (!complete) {
      throw new Error("unit set incomplete after build");
    }
    if (mism.length) return mism;
    await worker.clearStale(v.id);
    const cleared = await worker.verifyStaleCleared(v.id);
    if (!cleared) throw new Error("stale flag not cleared after full_build");
    return [];
  }
  async function runRestamp(v, op) {
    await advance(op, "indexing");
    await worker.markStale([v.id]);
    await worker.restamp(v);
    await advance(op, "verifying");
    const mism = await worker.projectionMismatches(v);
    if (mism.length) return mism;
    await worker.clearStale(v.id);
    const cleared = await worker.verifyStaleCleared(v.id);
    if (!cleared) throw new Error("stale flag not cleared after restamp");
    return [];
  }
  async function runCleanup(v, op) {
    await advance(op, "indexing");
    await worker.markStale([v.id]);
    await worker.cleanup(v);
    await advance(op, "verifying");
    const n = await worker.unitCount(v.id);
    if (n !== 0) throw new Error(`cleanup left ${n} units`);
  }
  async function failClosedLineage(op, reason) {
    const lineage = await db.listLineage(op.lineageId).catch(() => []);
    await worker.markStale(lineage.map((r) => r.id)).catch(() => {
    });
    await db.markNeedsManualReconciliation(op.lineageId, reason).catch(() => {
    });
    await db.appendAudit({
      code: "NEEDS_MANUAL_RECONCILIATION",
      operationId: op.operationId,
      lineageId: op.lineageId,
      versionId: op.targetVersionId,
      actorType: "system",
      actorId: null,
      summary: `${op.action}/${op.failureStage} ${op.operationId} \u2014 ${reason}`,
      at: clock.now()
    }).catch(() => {
    });
    op.status = "failed";
    op.completedAt = clock.now();
    await db.putOperation(op).catch(() => {
    });
    return { handled: 0, manual: 1 };
  }
  async function completeActivationForward(op) {
    const target = await db.getVersion(op.targetVersionId);
    if (!target) return failClosedLineage(op, "activation target version missing");
    const prior = op.priorActiveVersionId ? await db.getVersion(op.priorActiveVersionId) : null;
    await worker.markStale([target.id]);
    await worker.restamp(target);
    if (prior) await worker.cleanup(prior);
    const complete = await worker.unitSetComplete(target);
    const mism = await worker.projectionMismatches(target);
    if (!complete || mism.length) {
      return failClosedLineage(op, `recovery verify failed (complete=${complete}, mismatch=${mism.length})`);
    }
    if (prior) {
      const n = await worker.unitCount(prior.id);
      if (n !== 0) return failClosedLineage(op, `prior version still has ${n} units after cleanup`);
    }
    await worker.clearStale(target.id);
    if (!await worker.verifyStaleCleared(target.id)) {
      return failClosedLineage(op, "stale not cleared on the new active units during recovery");
    }
    const targetNow = await db.getVersion(target.id) || target;
    await finalizeActivation(op, targetNow, prior, {
      actorId: op.startedBy ?? null,
      previousVersionNumber: prior?.versionNumber ?? null
    });
    if (!await db.auditExists(op.operationId, "LIFECYCLE_RECONCILED")) {
      await db.appendAudit({
        code: "LIFECYCLE_RECONCILED",
        operationId: op.operationId,
        lineageId: op.lineageId,
        versionId: target.id,
        actorType: "system",
        actorId: null,
        summary: `resumed ${op.action} forward from ${op.failureStage} (no generation; cleaned prior ${op.priorActiveVersionId ?? "none"})`,
        at: clock.now()
      });
    }
    op.status = "completed";
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { handled: 1, manual: 0 };
  }
  async function rollbackActivation(op) {
    const target = await db.getVersion(op.targetVersionId);
    const prior = op.priorActiveVersionId ? await db.getVersion(op.priorActiveVersionId) : null;
    if (!prior) {
      return failClosedLineage(op, "no prior active version to roll back to (first activation of the lineage)");
    }
    if (!target) return failClosedLineage(op, "activation target version missing");
    await worker.markStale([target.id, prior.id]);
    const priorNow = await db.getVersion(prior.id);
    if (priorNow) {
      await db.writeVersion(
        prior.id,
        { isActiveVersion: true, lifecycleState: "active" },
        priorNow.lifecycleSeq
      ).catch(() => {
      });
    }
    const targetNow = await db.getVersion(target.id);
    if (targetNow) {
      await db.writeVersion(
        target.id,
        {
          isActiveVersion: false,
          lifecycleState: deriveLifecycleState({ ...targetNow, isActiveVersion: false }),
          indexState: "pending"
        },
        targetNow.lifecycleSeq
      ).catch(() => {
      });
    }
    const priorAfter = await db.getVersion(prior.id);
    if (priorAfter) await worker.restamp(priorAfter);
    const complete = await worker.unitSetComplete(priorAfter || prior);
    const mism = await worker.projectionMismatches(priorAfter || prior);
    if (!complete || mism.length) {
      return failClosedLineage(op, `rollback verify failed (complete=${complete}, mismatch=${mism.length})`);
    }
    await worker.clearStale(prior.id);
    if (!await worker.verifyStaleCleared(prior.id)) {
      return failClosedLineage(op, "rollback stale-clear failed on the restored version");
    }
    await db.appendAudit({
      code: "LIFECYCLE_ROLLED_BACK",
      lineageId: op.lineageId,
      versionId: target.id,
      actorType: "system",
      actorId: null,
      summary: `rolled back ${op.action} from ${op.failureStage}; restored prior active ${prior.id} (no generation)`,
      at: clock.now()
    });
    op.status = "completed";
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { handled: 1, manual: 0 };
  }
  async function recoverActivation(op) {
    switch (op.failureStage) {
      // Cutover had not passed the flip yet -> old units still present, roll back.
      case "cutover_stalemark":
      case "cutover_flip":
        return rollbackActivation(op);
      // Flip succeeded; complete forward, cleaning the OLD version only.
      case "cutover_restamp":
      case "cutover_cleanup":
      case "verify":
        return completeActivationForward(op);
      // A partial stale-clear may have occurred: re-establish full stale on the
      // new units first, then verify + clear again.
      case "cutover_stale_clear":
        return completeActivationForward(op);
      default:
        return failClosedLineage(op, `unhandled activation failure stage: ${op.failureStage ?? "none"}`);
    }
  }
  async function finishOk(op, v, code, summary, revision, before, after) {
    if (revision) {
      await db.appendRevision({
        lineageId: v.lineageId,
        versionId: v.id,
        previousVersionId: revision.previousVersionId ?? null,
        versionNumber: v.versionNumber,
        previousVersionNumber: revision.previousVersionNumber ?? null,
        operationId: op.operationId,
        changeSource: revision.changeSource || "other",
        changeReason: revision.changeReason ?? null,
        changedBy: op.startedBy ?? null,
        verifiedBy: revision.verifiedBy ?? null,
        verificationStatus: v.verificationStatus,
        effectiveFrom: v.effectiveFrom ?? null,
        effectiveUntil: v.effectiveUntil ?? null,
        contentSnapshot: revision.contentSnapshot ?? null,
        fieldDiff: revision.fieldDiff ?? null
      });
    }
    await db.appendAudit({
      code,
      operationId: op.operationId,
      lineageId: v.lineageId,
      versionId: v.id,
      actorType: op.startedBy ? "user" : "system",
      actorId: op.startedBy ?? null,
      summary,
      before: before != null ? JSON.stringify(before) : null,
      after: after != null ? JSON.stringify(after) : null,
      at: clock.now()
    });
    await advance(op, "completed");
    return {
      ok: true,
      operationId: op.operationId,
      displayState: deriveLifecycleState(v)
    };
  }
  async function finalizeActivation(op, newActive, prior, ctx) {
    const actorType = ctx.actorId ? "user" : "system";
    const fp2 = await worker.fingerprint(newActive).catch(() => null);
    const fresh = await db.getVersion(newActive.id);
    if (fresh) {
      await db.writeVersion(newActive.id, {
        indexState: "indexed",
        ...fp2 ? { indexedFingerprint: fp2 } : {},
        indexedVersionNumber: fresh.versionNumber
      }, fresh.lifecycleSeq).catch(() => {
      });
    }
    if (prior) {
      const p = await db.getVersion(prior.id);
      if (p) await db.writeVersion(prior.id, { indexState: "skipped" }, p.lifecycleSeq).catch(() => {
      });
    }
    if (prior && !await db.auditExists(op.operationId, "VERSION_SUPERSEDED")) {
      await db.appendAudit({
        code: "VERSION_SUPERSEDED",
        operationId: op.operationId,
        lineageId: prior.lineageId,
        versionId: prior.id,
        actorType,
        actorId: ctx.actorId,
        summary: `v${prior.versionNumber} superseded by v${newActive.versionNumber}`,
        at: clock.now()
      });
    }
    if (ctx.linkedGapId && !await db.auditExists(op.operationId, "METADATA_CHANGED")) {
      await db.appendAudit({
        code: "METADATA_CHANGED",
        operationId: op.operationId,
        lineageId: newActive.lineageId,
        versionId: newActive.id,
        actorType: "user",
        actorId: ctx.actorId,
        summary: `source brought into compliance for gap ${ctx.linkedGapId}`,
        at: clock.now()
      });
    }
    if (!await db.revisionExists(op.operationId, newActive.id)) {
      await db.appendRevision({
        lineageId: newActive.lineageId,
        versionId: newActive.id,
        previousVersionId: prior?.id ?? null,
        versionNumber: newActive.versionNumber,
        previousVersionNumber: ctx.previousVersionNumber,
        operationId: op.operationId,
        changeSource: "admin_edit",
        changeReason: null,
        changedBy: ctx.actorId,
        verifiedBy: null,
        verificationStatus: newActive.verificationStatus,
        effectiveFrom: newActive.effectiveFrom ?? null,
        effectiveUntil: newActive.effectiveUntil ?? null,
        contentSnapshot: null,
        fieldDiff: null
      });
    }
    if (!await db.auditExists(op.operationId, "VERSION_ACTIVATED")) {
      await db.appendAudit({
        code: "VERSION_ACTIVATED",
        operationId: op.operationId,
        lineageId: newActive.lineageId,
        versionId: newActive.id,
        actorType,
        actorId: ctx.actorId,
        summary: `v${newActive.versionNumber} published`,
        at: clock.now()
      });
    }
  }
  async function runTransition(actor, versionId, transition, action, code, opts) {
    const v = await db.getVersion(versionId);
    if (!v) return { ok: false, error: "version not found" };
    const authz = authorizer.authorize(actor, action, v);
    if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
    const from = deriveLifecycleState(v);
    const legal = assertTransitionLegal(from, transition, policy);
    if (!legal.ok) return { ok: false, error: legal.reason };
    const now = clock.now();
    const norm = normalizeForTransition(transition, { now, actorId: actor?.id ?? null, note: opts.note });
    const patch = { ...norm };
    if (transition === "verify") {
      patch.verifiedBy = actor?.id ?? null;
      patch.verifiedAt = now;
    }
    if (transition === "request_changes") {
      patch.changesRequestedNote = (opts.note || "").slice(0, 2e3);
    }
    if (transition === "verify" || transition === "un_reject") {
      patch.changesRequestedNote = null;
    }
    if (transition === "confirm_current") {
      patch.lastReviewedAt = now;
      patch.reviewedBy = actor?.id ?? null;
    }
    if (transition === "set_metadata" && opts.metadata) {
      if (opts.metadata.effectiveFrom !== void 0) patch.effectiveFrom = opts.metadata.effectiveFrom;
      if (opts.metadata.effectiveUntil !== void 0) patch.effectiveUntil = opts.metadata.effectiveUntil;
      if (opts.metadata.scopeKey !== void 0) patch.scopeKey = opts.metadata.scopeKey;
      if (opts.metadata.passthrough) Object.assign(patch, opts.metadata.passthrough);
      if (opts.metadata.denorm) {
        patch.denorm = opts.metadata.denorm;
      }
    }
    const ef = patch.effectiveFrom ?? v.effectiveFrom;
    const eu = patch.effectiveUntil ?? v.effectiveUntil;
    if (ef && eu) {
      const a = Date.parse(String(ef)), b = Date.parse(String(eu));
      if (Number.isNaN(a) || Number.isNaN(b)) return { ok: false, error: "invalid_effective_window" };
      if (a > b) return { ok: false, error: "invalid_effective_window" };
    }
    patch.lifecycleState = deriveLifecycleState({
      isArchived: patch.isArchived ?? v.isArchived,
      verificationStatus: patch.verificationStatus ?? v.verificationStatus,
      isActiveVersion: patch.isActiveVersion ?? v.isActiveVersion,
      reviewOutcome: patch.reviewOutcome !== void 0 ? patch.reviewOutcome : v.reviewOutcome,
      reviewRequestedAt: patch.reviewRequestedAt !== void 0 ? patch.reviewRequestedAt : v.reviewRequestedAt
    });
    const op = await openOperation(action, v, opts.note ? hash(opts.note) : "", actor?.id ?? null);
    await advance(op, "applying");
    let updated;
    try {
      updated = await guardedWrite(v, patch, op, v.lifecycleSeq, "apply");
    } catch (e) {
      if (e instanceof StaleSeqError) {
        return { ok: false, error: "stale_state", operationId: op.operationId };
      }
      return fail(op, "apply", e);
    }
    try {
      let mism = [];
      if (opts.needsCleanup) await runCleanup(updated, op);
      else if (opts.needsRebuild) mism = await runFullBuild(updated, op);
      else if (opts.needsRestamp) mism = await runRestamp(updated, op);
      if (mism.length) {
        return fail(op, opts.needsRebuild ? "verify" : "restamp", new Error(`projection mismatch x${mism.length}`));
      }
      if (opts.needsCleanup) {
        await guardedWrite(updated, { indexState: "skipped" }, op, updated.lifecycleSeq, "apply");
      } else if (opts.needsRestamp || opts.needsRebuild) {
        updated = await guardedWrite(
          updated,
          { indexState: "indexed", indexedVersionNumber: updated.versionNumber },
          op,
          updated.lifecycleSeq,
          "apply"
        );
      }
    } catch (e) {
      if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
      return fail(op, opts.needsCleanup ? "cutover_cleanup" : "restamp", e);
    }
    return finishOk(
      op,
      updated,
      code,
      `${transition} (${from} -> ${updated.lifecycleState})`,
      {
        changeSource: opts.changeSource || "admin_edit",
        verifiedBy: transition === "verify" ? actor?.id ?? null : null
      },
      { lifecycleState: from },
      { lifecycleState: updated.lifecycleState }
    );
  }
  return {
    policy,
    submit: (actor, versionId) => runTransition(actor, versionId, "submit", "submit", "RESOURCE_SUBMITTED", { needsRestamp: false }),
    requestChanges: (actor, versionId, note) => runTransition(actor, versionId, "request_changes", "request_changes", "CHANGES_REQUESTED", {
      note,
      needsRestamp: false
    }),
    verify: (actor, versionId) => runTransition(actor, versionId, "verify", "verify", "RESOURCE_VERIFIED", { needsRestamp: false }),
    reject: (actor, versionId, note) => runTransition(actor, versionId, "reject", "reject", "RESOURCE_REJECTED", {
      note,
      needsRestamp: false,
      needsCleanup: true
    }),
    unReject: (actor, versionId) => runTransition(actor, versionId, "un_reject", "un_reject", "RESOURCE_UNREJECTED", {
      needsRestamp: false,
      needsRebuild: true
    }),
    confirmCurrent: (actor, versionId) => runTransition(actor, versionId, "confirm_current", "confirm_current", "RESOURCE_REVIEWED", {
      needsRestamp: false
    }),
    setMetadata: (actor, versionId, metadata) => runTransition(actor, versionId, "set_metadata", metadataAction(metadata), "METADATA_CHANGED", {
      metadata,
      needsRestamp: true,
      changeSource: "admin_edit"
    }),
    archive: (actor, versionId) => runTransition(actor, versionId, "archive", "archive", "RESOURCE_ARCHIVED", {
      needsRestamp: false,
      needsCleanup: true
    }),
    restore: (actor, versionId) => runTransition(actor, versionId, "restore", "restore", "RESOURCE_RESTORED", {
      needsRestamp: false,
      needsRebuild: true
    }),
    /** Fork an unverified draft N+1 from the active version. The active row is
     *  NOT touched. `applyContent` mutates the cloned draft with the caller's
     *  content edit before it is persisted. */
    async createVersion(actor, activeVersionId, applyContent, changeSource = "admin_edit") {
      const active = await db.getVersion(activeVersionId);
      if (!active) return { ok: false, error: "version not found" };
      const authz = authorizer.authorize(actor, "create_version", active);
      if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
      const from = deriveLifecycleState(active);
      const legal = assertTransitionLegal(from, "create_version", policy);
      if (!legal.ok) return { ok: false, error: legal.reason };
      const lineage = await db.listLineage(active.lineageId);
      const openDraft = lineage.find((r) => isOpenDraftCandidate(r, lineage));
      if (openDraft) {
        return { ok: false, error: "open_draft_exists", draftId: openDraft.id };
      }
      const now = clock.now();
      const overrides = {
        ...newDraftFields(now),
        versionNumber: active.versionNumber + 1,
        lineageId: active.lineageId
      };
      const withContent = applyContent(overrides);
      withContent.lifecycleState = "draft";
      const draft = await db.createVersionRow(active, withContent);
      const op = await openOperation("create_version", draft, "", actor?.id ?? null, active);
      await advance(op, "applying");
      const res = await finishOk(
        op,
        draft,
        "VERSION_CREATED",
        `forked v${draft.versionNumber} from v${active.versionNumber}`,
        {
          changeSource,
          previousVersionId: active.id,
          previousVersionNumber: active.versionNumber
        }
      );
      return { ...res, draftId: draft.id };
    },
    /** Phase I pre-index of an inactive draft. Heavy generation; the draft
     *  stays inactive throughout. */
    async buildDraftIndex(actor, draftId, changeSource = "admin_edit") {
      const draft = await db.getVersion(draftId);
      if (!draft) return { ok: false, error: "version not found" };
      if (draft.isActiveVersion) return { ok: false, error: "not_a_draft" };
      const authz = authorizer.authorize(actor, "build_draft_index", draft);
      if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
      const op = await openOperation("build_draft_index", draft, "", actor?.id ?? null);
      await advance(op, "applying");
      let d = draft;
      try {
        await guardedWrite(d, { indexState: "indexing" }, op, d.lifecycleSeq, "apply");
        d = await db.getVersion(draftId);
        const mism = await runFullBuild(d, op);
        if (mism.length) {
          await db.writeVersion(d.id, { indexState: "failed", index_error: `projection mismatch x${mism.length}` }, d.lifecycleSeq).catch(() => {
          });
          return fail(op, "verify", new Error(`projection mismatch x${mism.length}`));
        }
        const fp2 = await worker.fingerprint(d);
        d = await db.writeVersion(
          d.id,
          { indexState: "indexed", indexedFingerprint: fp2, indexedVersionNumber: d.versionNumber },
          d.lifecycleSeq
        );
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        await db.writeVersion(draftId, { indexState: "failed", index_error: redact(e) }, d.lifecycleSeq).catch(() => {
        });
        return fail(op, "index", e);
      }
      return finishOk(op, d, "DRAFT_REINDEXED", `pre-indexed draft v${d.versionNumber}`, {
        changeSource
      });
    },
    /** The [F1] activation cutover. Precondition: verified (unless forced +
     *  policy allows) AND draft.indexState === 'indexed' AND
     *  indexedVersionNumber === draft.versionNumber. NO generation. */
    async activate(actor, draftId, opts = {}) {
      const draft = await db.getVersion(draftId);
      if (!draft) return { ok: false, error: "version not found" };
      const authz = authorizer.authorize(actor, "activate", draft);
      if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
      if (draft.isActiveVersion) return { ok: false, error: "already_active" };
      const from = deriveLifecycleState(draft);
      const legal = assertTransitionLegal(from, "activate", policy);
      if (!legal.ok) return { ok: false, error: legal.reason };
      const forced = opts.force === true && policy.allowForceUnverifiedPublish;
      if (policy.requireVerifiedToPublish && draft.verificationStatus !== "verified" && !forced) {
        return { ok: false, error: "not_verified" };
      }
      if (draft.indexState !== "indexed" || draft.indexedVersionNumber !== draft.versionNumber) {
        return { ok: false, error: "pre_index_required" };
      }
      const lineage = await db.listLineage(draft.lineageId);
      const priorActive = lineage.find((r) => r.isActiveVersion) || null;
      const open = (await db.listOpenOperations()).filter(
        (o) => o.lineageId === draft.lineageId && o.status !== "completed" && o.status !== "failed"
      );
      if (open.length) return { ok: false, error: "operation_in_flight" };
      const op = await openOperation("activate", draft, "", actor?.id ?? null, priorActive);
      try {
        await advance(op, "applying");
        op.failureStage = "cutover_stalemark";
        await db.putOperation(op);
        const staleIds = [draft.id, ...priorActive ? [priorActive.id] : []];
        await worker.markStale(staleIds);
        op.failureStage = "cutover_flip";
        await db.putOperation(op);
        const newActive = await guardedWrite(
          draft,
          {
            isActiveVersion: true,
            reviewOutcome: "confirmed_current",
            lifecycleState: "active",
            ...opts.effectiveFromNow ? { effectiveFrom: clock.now() } : {}
          },
          op,
          draft.lifecycleSeq,
          "cutover_flip"
        );
        let demoted = null;
        if (priorActive) {
          demoted = await guardedWrite(
            priorActive,
            { ...demoteFields(), lifecycleState: deriveLifecycleState({ ...priorActive, isActiveVersion: false }) },
            op,
            priorActive.lifecycleSeq,
            "cutover_flip"
          );
        }
        op.failureStage = "cutover_restamp";
        await advance(op, "indexing");
        await worker.restamp(newActive);
        if (demoted) {
          op.failureStage = "cutover_cleanup";
          await db.putOperation(op);
          await worker.cleanup(demoted);
        }
        op.failureStage = "verify";
        await advance(op, "verifying");
        const complete = await worker.unitSetComplete(newActive);
        const mism = await worker.projectionMismatches(newActive);
        if (!complete || mism.length) {
          return fail(op, "verify", new Error(`new-version verification failed (complete=${complete}, mismatch=${mism.length})`));
        }
        if (demoted) {
          const n = await worker.unitCount(demoted.id);
          if (n !== 0) return fail(op, "verify", new Error(`demoted version still has ${n} units`));
        }
        op.failureStage = "cutover_stale_clear";
        await db.putOperation(op);
        await worker.clearStale(newActive.id);
        const cleared = await worker.verifyStaleCleared(newActive.id);
        if (!cleared) return fail(op, "cutover_stale_clear", new Error("new active units still stale"));
        await finalizeActivation(op, newActive, demoted, {
          actorId: actor?.id ?? null,
          previousVersionNumber: priorActive?.versionNumber ?? null,
          linkedGapId: opts.linkedGapId
        });
        await advance(op, "completed");
        return {
          ok: true,
          operationId: op.operationId,
          displayState: deriveLifecycleState(newActive),
          verifiedSourceIds: [newActive.id]
        };
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        return fail(op, op.failureStage || "apply", e);
      }
    },
    /** Explicit reindex of a version — applies the [F2] plan. */
    async reindex(actor, versionId) {
      const v = await db.getVersion(versionId);
      if (!v) return { ok: false, error: "version not found" };
      const authz = authorizer.authorize(actor, "build_draft_index", v);
      if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
      const op = await openOperation("build_draft_index", v, "", actor?.id ?? null);
      await advance(op, "applying");
      try {
        const fp2 = await worker.fingerprint(v);
        const fingerprintMatches = !!v.indexedFingerprint && v.indexedFingerprint === fp2;
        const unitSetComplete = await worker.unitSetComplete(v);
        const mismatches = await worker.projectionMismatches(v);
        const plan = planReindex({ fingerprintMatches, unitSetComplete, mismatches });
        if (plan === "no_op") {
          await advance(op, "completed");
          return { ok: true, operationId: op.operationId, noOp: true, displayState: deriveLifecycleState(v) };
        }
        let mism = [];
        if (plan === "restamp_repair") mism = await runRestamp(v, op);
        else mism = await runFullBuild(v, op);
        if (mism.length) return fail(op, plan === "full_rebuild" ? "verify" : "restamp", new Error("mismatch after repair"));
        const newFp = await worker.fingerprint(v);
        const updated = await db.writeVersion(
          v.id,
          { indexState: "indexed", indexedFingerprint: newFp, indexedVersionNumber: v.versionNumber },
          v.lifecycleSeq
        );
        return finishOk(op, updated, "REINDEX_SUCCEEDED", `reindex (${plan})`, null);
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        await db.writeVersion(versionId, { indexState: "failed", index_error: redact(e) }, v.lifecycleSeq).catch(() => {
        });
        return fail(op, "index", e);
      }
    },
    /**
     * Operation-record-driven reconciliation. For each stuck/failed operation:
     * resume forward where the stage is idempotent, run rollback_activation for
     * a half-applied cutover flip (restoring the recorded prior active), or —
     * when no deterministic recovery exists — stale-mark the whole lineage and
     * flag it for manual reconciliation. NEVER picks a winner by version number.
     */
    async reconcile(actor) {
      const authz = authorizer.authorize(actor, "manual_reconcile", null);
      if (!authz.ok) return { ok: false, handled: 0, manual: 0 };
      const nowMs = clock.nowMs();
      const ops = await db.listOpenOperations();
      let handled = 0;
      let manual = 0;
      for (const op of ops) {
        const stuck = op.status === "failed" || ["applying", "indexing", "verifying"].includes(op.status) && nowMs - Date.parse(op.startedAt) > policy.stuckAfterMs;
        if (!stuck) continue;
        if (op.resumeCount >= policy.reconcileMaxAttempts) {
          const lineage = await db.listLineage(op.lineageId);
          await worker.markStale(lineage.map((r) => r.id));
          await db.markNeedsManualReconciliation(op.lineageId, `operation ${op.operationId} exceeded ${policy.reconcileMaxAttempts} attempts`);
          await db.appendAudit({
            code: "NEEDS_MANUAL_RECONCILIATION",
            lineageId: op.lineageId,
            versionId: op.targetVersionId,
            actorType: "system",
            actorId: null,
            summary: `operation ${op.operationId} (${op.action}/${op.failureStage}) could not be recovered automatically`,
            at: clock.now()
          });
          op.status = "failed";
          op.completedAt = clock.now();
          await db.putOperation(op);
          manual++;
          continue;
        }
        op.resumeCount += 1;
        op.status = "compensating";
        await db.putOperation(op);
        try {
          if (op.action === "activate" || op.action === "supersede") {
            const r = await recoverActivation(op);
            handled += r.handled;
            manual += r.manual;
            continue;
          }
          const kind = compensationKind(op.action, op.failureStage);
          const target = await db.getVersion(op.targetVersionId);
          if (kind === "resume" && target) {
            await worker.markStale([target.id]);
            if (op.failureStage === "restamp" || op.failureStage === "restamp_stale_clear") {
              await worker.restamp(target);
            } else if (op.action === "build_draft_index" || op.failureStage === "index") {
              await worker.build(target);
            } else {
              await worker.restamp(target);
            }
            const ok = await worker.unitSetComplete(target) && (await worker.projectionMismatches(target)).length === 0;
            if (ok) {
              await worker.clearStale(target.id);
              const fresh = await db.getVersion(target.id);
              if (fresh) {
                await db.writeVersion(
                  target.id,
                  { indexState: "indexed", indexedVersionNumber: fresh.versionNumber },
                  fresh.lifecycleSeq
                ).catch(() => {
                });
              }
              await db.appendAudit({
                code: "LIFECYCLE_RECONCILED",
                lineageId: op.lineageId,
                versionId: op.targetVersionId,
                actorType: "system",
                actorId: null,
                summary: `resumed ${op.action} from ${op.failureStage}`,
                at: clock.now()
              });
              op.status = "completed";
              op.completedAt = clock.now();
              await db.putOperation(op);
              handled++;
            } else {
              const lineage = await db.listLineage(op.lineageId);
              await worker.markStale(lineage.map((r) => r.id));
              await db.markNeedsManualReconciliation(op.lineageId, `resume of ${op.action}/${op.failureStage} did not verify`);
              op.status = "failed";
              op.completedAt = clock.now();
              await db.putOperation(op);
              manual++;
            }
          } else {
            const lineage = await db.listLineage(op.lineageId);
            await worker.markStale(lineage.map((r) => r.id));
            await db.markNeedsManualReconciliation(op.lineageId, `no deterministic recovery for ${op.action}/${op.failureStage}`);
            op.status = "failed";
            op.completedAt = clock.now();
            await db.putOperation(op);
            manual++;
          }
        } catch (recErr) {
          try {
            const r = await failClosedLineage(
              op,
              `unexpected error during recovery: ${redact(recErr)}`
            );
            manual += r.manual;
          } catch {
            op.status = "failed";
            op.completedAt = clock.now();
            await db.putOperation(op).catch(() => {
            });
            manual++;
          }
        }
      }
      return { ok: true, handled, manual };
    },
    /** Deterministic freshness for admin / Phase 7 — never an answer-path signal. */
    freshness(nextReviewDueAt, intervalDays) {
      return computeFreshness(nextReviewDueAt, intervalDays, clock.nowMs(), policy);
    }
  };
}
function metadataAction(m) {
  if (m.effectiveFrom !== void 0 || m.effectiveUntil !== void 0) return "set_effective_dates";
  if (m.scopeKey !== void 0) return "reclassify_scope";
  if (m.denorm && ("authority" in m.denorm || "source_authority" in m.denorm)) return "set_authority";
  if (m.denorm && "operational_process_id" in m.denorm) return "relink_process";
  return "set_effective_dates";
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// scripts/rag-eval/_lifecycle_fakes.mjs
var fp = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16);
};
var staleFlag = (h, id) => h.idx.get(id).stale;
function makeHarness(opts = {}) {
  const flags = { ...opts };
  const versions = /* @__PURE__ */ new Map();
  const operations = /* @__PURE__ */ new Map();
  const revisions = [];
  const audits = [];
  const manualFlags = [];
  const idx = /* @__PURE__ */ new Map();
  let seq = 0;
  let nowMs = Date.parse("2026-09-02T00:00:00Z");
  const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs, tick: (ms) => {
    nowMs += ms;
  } };
  const idGen = { operationId: () => `op_${++seq}` };
  const projectionOf = (v) => ({
    scopeKey: v.scopeKey,
    is_active_version: v.isActiveVersion ? "true" : "false",
    effective_from: v.effectiveFrom ?? "",
    version_number: String(v.versionNumber)
  });
  const persistence = {
    async getVersion(id) {
      const v = versions.get(id);
      return v ? { ...v } : null;
    },
    async listLineage(lineageId) {
      return [...versions.values()].filter((v) => v.lineageId === lineageId).map((v) => ({ ...v }));
    },
    async writeVersion(id, patch, expectedSeq) {
      const v = versions.get(id);
      if (!v) throw new Error("no version " + id);
      if (flags.staleWriteOnce) {
        flags.staleWriteOnce = false;
        throw new StaleSeqError();
      }
      if (v.lifecycleSeq !== expectedSeq) throw new StaleSeqError();
      Object.assign(v, patch, { lifecycleSeq: v.lifecycleSeq + 1 });
      return { ...v };
    },
    async createVersionRow(fromVersion, overrides) {
      const id = `v_${versions.size + 1}`;
      const row = { ...fromVersion, ...overrides, id, lifecycleSeq: 0, lineageId: overrides.lineageId || fromVersion.lineageId };
      versions.set(id, row);
      idx.set(id, { units: [], stale: false });
      return { ...row };
    },
    async putOperation(op) {
      operations.set(op.operationId, { ...op });
    },
    async getOperation(id) {
      const o = operations.get(id);
      return o ? { ...o } : null;
    },
    async listOpenOperations() {
      return [...operations.values()].map((o) => ({ ...o }));
    },
    async lastCompletedOperation(lineageId, action) {
      return [...operations.values()].reverse().find(
        (o) => o.lineageId === lineageId && o.action === action && o.status === "completed"
      ) || null;
    },
    async appendRevision(r) {
      revisions.push(r);
    },
    async appendAudit(a) {
      audits.push(a);
    },
    async auditExists(operationId, code) {
      return !!operationId && audits.some((a) => a.operationId === operationId && a.code === code);
    },
    async revisionExists(operationId, versionId) {
      return !!operationId && revisions.some((r) => r.operationId === operationId && r.versionId === versionId);
    },
    async markNeedsManualReconciliation(lineageId, reason) {
      manualFlags.push({ lineageId, reason });
    }
  };
  const indexWorker = {
    async build(v) {
      flags.buildCount = (flags.buildCount || 0) + 1;
      const store = idx.get(v.id) || { units: [], stale: false };
      const content = versions.get(v.id).__content ?? "body";
      store.units = [
        { id: `${v.id}#0`, fingerprint: fp(content), projection: projectionOf(versions.get(v.id)) },
        { id: `${v.id}#1`, fingerprint: fp(content), projection: projectionOf(versions.get(v.id)) }
      ];
      store.stale = true;
      idx.set(v.id, store);
      if (flags.failBuild) throw new Error("injected build failure");
    },
    async restamp(v) {
      (flags.restampTargets ||= []).push(v.id);
      const store = idx.get(v.id) || { units: [], stale: false };
      for (const u of store.units) u.projection = projectionOf(versions.get(v.id));
      idx.set(v.id, store);
      if (flags.failRestamp) throw new Error("injected restamp failure");
    },
    async cleanup(v) {
      (flags.cleanupTargets ||= []).push(v.id);
      idx.set(v.id, { units: [], stale: false });
      if (flags.failCleanup) throw new Error("injected cleanup failure");
    },
    async markStale(ids) {
      (flags.markStaleTargets ||= []).push(...ids);
      for (const id of ids) {
        const s = idx.get(id);
        if (s) s.stale = true;
      }
      if (flags.failStaleMark) throw new Error("injected stale-mark failure");
    },
    async clearStale(id) {
      if (flags.failStaleClear) throw new Error("injected stale-clear failure");
      const s = idx.get(id);
      if (s) s.stale = false;
    },
    async verifyStaleCleared(id) {
      const s = idx.get(id);
      return !!s && s.stale === false;
    },
    async fingerprint(v) {
      return fp(versions.get(v.id).__content ?? "body");
    },
    async unitSetComplete(v) {
      if (flags.forceIncompleteSet) return false;
      const s = idx.get(v.id);
      return !!s && s.units.length > 0;
    },
    async projectionMismatches(v) {
      if (flags.forceMismatch) return [{ field: "scopeKey", expected: "x", actual: "y", unitId: v.id + "#0" }];
      const s = idx.get(v.id);
      if (!s) return [];
      const want = projectionOf(versions.get(v.id));
      const out = [];
      for (const u of s.units) {
        for (const k of Object.keys(want)) {
          if (String(u.projection[k] ?? "") !== String(want[k] ?? "")) {
            out.push({ field: k, expected: want[k], actual: u.projection[k], unitId: u.id });
          }
        }
      }
      return out;
    },
    async unitCount(id) {
      const s = idx.get(id);
      return s ? s.units.length : 0;
    }
  };
  const authorizer = {
    authorize: (actor) => actor && actor.role === "admin" ? { ok: true } : flags.openAuthz ? { ok: true } : { ok: false, reason: "admin only" }
  };
  const policy = {
    requireVerifiedToPublish: true,
    allowForceUnverifiedPublish: false,
    disallowTransitions: [],
    stuckAfterMs: 1e3,
    reconcileMaxAttempts: 2,
    gracePolicyMs: (d) => d * 36e5,
    combinedApproveAndPublish: false,
    ...opts.policy || {}
  };
  const engine = createLifecycleEngine({ persistence, indexWorker, authorizer, clock, idGen, policy });
  const v1 = {
    id: "v_1",
    lineageId: "lin_1",
    versionNumber: 1,
    isActiveVersion: true,
    verificationStatus: "verified",
    isArchived: false,
    scopeKey: "general:",
    lifecycleSeq: 0,
    indexState: "indexed",
    indexedVersionNumber: 1,
    indexedFingerprint: fp("body-v1"),
    reviewOutcome: null,
    reviewRequestedAt: null,
    __content: "body-v1"
  };
  versions.set("v_1", v1);
  idx.set("v_1", { units: [{ id: "v_1#0", fingerprint: fp("body-v1"), projection: projectionOf(v1) }], stale: false });
  return { engine, versions, operations, revisions, audits, manualFlags, idx, clock, projectionOf, flags };
}

// scripts/rag-eval/lifecycle-engine-reuse.test.mjs
var HERE = dirname(fileURLToPath(import.meta.url));
var ENGINE_DIR = resolve(HERE, "../../base44/shared/lifecycle");
var admin = { id: "admin", role: "admin" };
test("lifecycle engine source imports nothing from Base44 SDK or MindVault modules", () => {
  const files = readdirSync(ENGINE_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 7, "expected the full engine module set");
  const BANNED = [
    "@base44/sdk",
    "createClientFromRequest",
    "Deno.",
    "shared/retrieval",
    "shared/governance",
    "shared/embeddings",
    "shared/knowledgeGap",
    "shared/operationalAnswer",
    "shared/extraction",
    "shared/gapAggregation",
    "shared/text",
    "shared/chunkLifecycle",
    "shared/mindvaultLifecycle",
    "Training",
    "KnowledgeChunk",
    "OperationalProcess",
    "askKnowledgeBase"
  ];
  for (const f of files) {
    const src = readFileSync(join(ENGINE_DIR, f), "utf8");
    const importLines = src.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
    for (const line of importLines) {
      for (const b of BANNED) {
        assert.equal(line.includes(b), false, `${f}: import line couples to "${b}":
  ${line.trim()}`);
      }
    }
    assert.equal(/\bDeno\.\w/.test(src), false, `${f} uses a Deno API`);
    assert.equal(/@base44\/sdk/.test(src), false, `${f} references the Base44 SDK`);
  }
});
test("end-to-end: edit -> pre-index -> approve -> publish, driven entirely by fakes", async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, "v_1", (draft) => ({ ...draft }));
  assert.ok(cv.ok, JSON.stringify(cv));
  const draftId = cv.draftId;
  h.versions.get(draftId).__content = "body-v2";
  const bi = await h.engine.buildDraftIndex(admin, draftId);
  assert.ok(bi.ok, JSON.stringify(bi));
  assert.equal(h.versions.get(draftId).indexState, "indexed");
  assert.equal(h.versions.get(draftId).isActiveVersion, false, "draft stays inactive after pre-index");
  assert.equal(staleFlag(h, draftId), false, "draft units cleared after a clean pre-index");
  const vr = await h.engine.verify(admin, draftId);
  assert.ok(vr.ok);
  assert.equal(vr.displayState, "verified");
  const act = await h.engine.activate(admin, draftId, { effectiveFromNow: false });
  assert.ok(act.ok, JSON.stringify(act));
  assert.equal(h.versions.get(draftId).isActiveVersion, true);
  assert.equal(h.versions.get("v_1").isActiveVersion, false, "old version demoted");
  assert.equal(h.idx.get("v_1").units.length, 0, "old units cleaned");
  assert.equal(staleFlag(h, draftId), false, "new active units un-staled only at the end");
  assert.ok(h.audits.some((a) => a.code === "VERSION_ACTIVATED"));
  assert.ok(h.audits.some((a) => a.code === "VERSION_SUPERSEDED"));
  assert.ok(h.revisions.some((r) => r.operationId === act.operationId));
});
test("createVersion never mutates the active version and forks an unverified draft", async () => {
  const h = makeHarness();
  const before = JSON.stringify(h.versions.get("v_1"));
  const cv = await h.engine.createVersion(admin, "v_1", (d) => ({ ...d }));
  assert.ok(cv.ok);
  assert.equal(JSON.stringify(h.versions.get("v_1")), before, "active v1 unchanged");
  assert.equal(h.versions.get(cv.draftId).verificationStatus, "unverified");
  assert.equal(h.versions.get(cv.draftId).isActiveVersion, false);
});
test("a second open draft in the same lineage is refused", async () => {
  const h = makeHarness();
  assert.ok((await h.engine.createVersion(admin, "v_1", (d) => ({ ...d }))).ok);
  const b = await h.engine.createVersion(admin, "v_1", (d) => ({ ...d }));
  assert.equal(b.ok, false);
  assert.equal(b.error, "open_draft_exists");
});
test("non-admin actor is refused every write", async () => {
  const h = makeHarness();
  const emp = { id: "e", role: "user" };
  assert.equal((await h.engine.createVersion(emp, "v_1", (d) => d)).ok, false);
  assert.equal((await h.engine.verify(emp, "v_1")).ok, false);
  assert.equal((await h.engine.activate(emp, "v_1")).ok, false);
});
test("activate refused for an unverified draft (human verification required before publish)", async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, "v_1", (d) => ({ ...d }));
  await h.engine.buildDraftIndex(admin, cv.draftId);
  const res = await h.engine.activate(admin, cv.draftId);
  assert.equal(res.ok, false);
  assert.equal(h.versions.get(cv.draftId).isActiveVersion, false);
  assert.equal(h.versions.get("v_1").isActiveVersion, true);
});
test("activate refused when the draft is not pre-indexed (successful pre-index is a precondition)", async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, "v_1", (d) => ({ ...d }));
  await h.engine.verify(admin, cv.draftId);
  const res = await h.engine.activate(admin, cv.draftId);
  assert.equal(res.ok, false);
  assert.equal(res.error, "pre_index_required");
});
