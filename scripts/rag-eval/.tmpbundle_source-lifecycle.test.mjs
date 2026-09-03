// scripts/rag-eval/source-lifecycle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// base44/shared/lifecycle/types.ts
var StaleSeqError = class extends Error {
  constructor(message = "lifecycle_seq moved under this operation") {
    super(message);
    this.name = "StaleSeqError";
  }
};

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

// base44/shared/lifecycle/verification.ts
function isIndexNoOp(x) {
  return x.fingerprintMatches && x.unitSetComplete && x.mismatches.length === 0;
}
function planReindex(x) {
  if (isIndexNoOp(x)) return "no_op";
  if (x.fingerprintMatches && x.unitSetComplete) return "restamp_repair";
  return "full_rebuild";
}

// base44/shared/lifecycle/presentation.ts
var DEFAULT_VOCABULARY = {
  state: {
    draft: "Draft",
    in_review: "Ready for review",
    changes_requested: "Changes requested",
    verified: "Verified",
    published: "Published",
    previous_version: "Previous version",
    outdated: "Outdated",
    indexing: "Indexing",
    needs_attention: "Needs attention",
    archived: "Archived",
    rejected: "Not approved"
  },
  action: {
    edit: "Edit",
    send_for_review: "Send for review",
    request_changes: "Request changes",
    approve: "Approve",
    reject: "Reject",
    publish: "Publish",
    archive: "Archive",
    restore: "Restore",
    reindex: "Re-index",
    view_diagnostics: "View diagnostics",
    force_reconcile: "Run repair",
    roll_back_activation: "Roll back"
  },
  freshness: {
    current: "Up to date",
    due_soon: "Review due soon",
    overdue: "Outdated",
    unknown: "No review schedule"
  }
};
function resolveVocabulary(override) {
  if (!override) return DEFAULT_VOCABULARY;
  return {
    state: { ...DEFAULT_VOCABULARY.state, ...override.state || {} },
    action: { ...DEFAULT_VOCABULARY.action, ...override.action || {} },
    freshness: { ...DEFAULT_VOCABULARY.freshness, ...override.freshness || {} }
  };
}

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
    const fp = await worker.fingerprint(newActive).catch(() => null);
    const fresh = await db.getVersion(newActive.id);
    if (fresh) {
      await db.writeVersion(newActive.id, {
        indexState: "indexed",
        ...fp ? { indexedFingerprint: fp } : {},
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
        const fp = await worker.fingerprint(d);
        d = await db.writeVersion(
          d.id,
          { indexState: "indexed", indexedFingerprint: fp, indexedVersionNumber: d.versionNumber },
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
        const fp = await worker.fingerprint(v);
        const fingerprintMatches = !!v.indexedFingerprint && v.indexedFingerprint === fp;
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

// base44/shared/text.ts
function approxTokens(text) {
  return Math.ceil((text || "").length / 4);
}
async function contentHash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function chunkText(text, { targetTokens = 600, overlapTokens = 90 } = {}) {
  const clean = (text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (approxTokens(clean) <= targetTokens) return [clean];
  const pieces = clean.match(/[^.!?\n]+[.!?]*\n*|\n+/g) || [clean];
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;
  const chunks = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur.length + piece.length > targetChars && cur.trim()) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlapChars));
    }
    cur += piece;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
var STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these they this to was were what when where which who will with you your our we do does did not can could should would may might must about so no yes than too very just also more most such only own same each any all some other".split(" ")
);
function extractKeywords(text, max = 14) {
  const counts = /* @__PURE__ */ new Map();
  for (const raw of (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) || []) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

// base44/shared/governance.ts
function buildGovFields(src, processFreshnessStatus) {
  return {
    source_authority: src.source_authority || void 0,
    verification_status: src.verification_status || void 0,
    ingestion_quality: src.ingestion_quality || void 0,
    is_active_version: src.is_active_version === false ? false : void 0,
    effective_from: src.effective_from || void 0,
    effective_until: src.effective_until || void 0,
    source_is_archived: src.is_archived === true ? true : void 0,
    version_number: typeof src.version_number === "number" ? src.version_number : void 0,
    operational_process_id: src.operational_process_id || void 0,
    department: src.department || void 0,
    process_freshness_status: processFreshnessStatus || void 0,
    // Phase 6: lineage grouping only. NOT index_stale — that flag is managed
    // explicitly by embedKnowledge's mark_stale / clear_stale / build_staged
    // sub-commands so a legacy full reindex never leaves chunks dark.
    root_source_id: src.root_source_id || src.id || void 0
  };
}
function buildScopeFields(src) {
  const scope = src.knowledge_scope || "unclassified";
  return {
    knowledge_scope: scope,
    client_id: scope === "client-specific" ? src.client_id : void 0,
    title: src.title || "",
    topic_category: src.topic_category || src.category || "",
    client_segment: src.client_segment || ""
  };
}
function scopeFieldsDrift(chunk, scopeFields, chunkIndex) {
  const drift = {};
  if ((chunk.knowledge_scope || "") !== scopeFields.knowledge_scope) {
    drift.knowledge_scope = scopeFields.knowledge_scope;
  }
  if ((chunk.client_id || void 0) !== scopeFields.client_id) {
    drift.client_id = scopeFields.client_id ?? null;
  }
  if ((chunk.chunk_index ?? -1) !== chunkIndex) drift.chunk_index = chunkIndex;
  if ((chunk.title || "") !== scopeFields.title) drift.title = scopeFields.title;
  if ((chunk.topic_category || "") !== scopeFields.topic_category) {
    drift.topic_category = scopeFields.topic_category;
  }
  if ((chunk.client_segment || "") !== scopeFields.client_segment) {
    drift.client_segment = scopeFields.client_segment;
  }
  return drift;
}

// base44/shared/chunkLifecycle.ts
var CHUNK_TARGET_TOKENS = 600;
var CHUNK_OVERLAP_TOKENS = 90;
var MAX_TRANSCRIPT_CHARS = 6e4;
function buildDraftChunks(training, transcript) {
  const drafts = [];
  const push = (chunk_type, content) => {
    const text = typeof content === "string" ? content.trim() : "";
    if (text) drafts.push({ chunk_type, content: text });
  };
  push("summary", training.summary);
  for (const part of chunkText(training.ai_knowledge_entry || "", {
    targetTokens: CHUNK_TARGET_TOKENS,
    overlapTokens: CHUNK_OVERLAP_TOKENS
  })) {
    push("ai_knowledge_entry", part);
  }
  for (const t of training.key_takeaways || []) push("key_takeaway", t);
  for (const s of training.sop_steps || []) push("sop_step", s);
  for (const r of training.decision_rules || []) push("decision_rule", r);
  for (const m of training.common_mistakes || []) push("common_mistake", m);
  for (const x of training.exceptions || []) push("exception", x);
  for (const x of training.approvers || []) push("approval", x);
  for (const x of training.escalation_paths || []) push("escalation", x);
  for (const x of training.prerequisites || []) push("required_input", x);
  for (const x of training.prohibited_actions || []) push("prohibited_action", x);
  for (const x of training.verification_checkpoints || []) push("verification", x);
  for (const x of training.roles_involved || []) push("role", x);
  for (const x of training.deadlines || []) push("deadline", x);
  if (transcript) {
    for (const part of chunkText(transcript.slice(0, MAX_TRANSCRIPT_CHARS), {
      targetTokens: CHUNK_TARGET_TOKENS,
      overlapTokens: CHUNK_OVERLAP_TOKENS
    })) {
      push("transcript", part);
    }
  }
  return drafts;
}
async function fetchTranscript(training) {
  const ref = training.transcript;
  if (!ref || typeof ref !== "string") return null;
  if (!ref.startsWith("http")) return ref.trim() || null;
  try {
    const res = await fetch(ref);
    if (!res.ok) return null;
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.length < 20 || trimmed.startsWith("<")) return null;
    return trimmed;
  } catch (_) {
    return null;
  }
}
async function loadChunks(base44, trainingId) {
  return await base44.asServiceRole.entities.KnowledgeChunk.filter(
    { training_id: trainingId },
    null,
    5e3
  );
}
async function setChunksStale(base44, trainingId, value) {
  const chunks = await loadChunks(base44, trainingId);
  let changed = 0;
  for (const c of chunks) {
    if (c.index_stale === true !== (value === true)) {
      await base44.asServiceRole.entities.KnowledgeChunk.update(c.id, {
        index_stale: value ? true : null
      });
      changed++;
    }
  }
  return changed;
}
async function verifyStaleCleared(base44, trainingId) {
  const chunks = await loadChunks(base44, trainingId);
  return chunks.every((c) => c.index_stale !== true);
}
async function computeDesired(base44, training) {
  const transcript = await fetchTranscript(training);
  const drafts = buildDraftChunks(training, transcript);
  const desired = await Promise.all(
    drafts.map(async (d, i) => ({
      chunk_index: i,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: await contentHash(d.content)
    }))
  );
  const fingerprint = await contentHash(desired.map((d) => d.content_hash).join("|"));
  const scopeFields = buildScopeFields(training);
  let processFreshness = "";
  if (training.operational_process_id) {
    const proc = await base44.asServiceRole.entities.OperationalProcess.get(training.operational_process_id).catch(() => null);
    processFreshness = proc?.freshness_status || "";
  }
  const govFields = buildGovFields(training, processFreshness);
  return { desired, fingerprint, scopeFields, govFields };
}
function projectionMismatchFields(chunk, scopeFields, govFields) {
  const out = [];
  const norm = (v) => v === void 0 || v === null || v === "" ? "" : String(v);
  const check = (k, want) => {
    if (norm(chunk[k]) !== norm(want ?? void 0)) out.push(k);
  };
  for (const [k, v] of Object.entries(scopeFields)) check(k, v);
  for (const [k, v] of Object.entries(govFields)) check(k, v);
  return out;
}
async function restampChunks(base44, training) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const existing = await loadChunks(base44, training.id);
  let restamped = 0;
  for (const c of existing) {
    const patch = scopeFieldsDrift(c, scopeFields, c.chunk_index);
    for (const [k, v] of Object.entries(govFields)) {
      const cur = c[k] ?? void 0;
      if (cur !== (v ?? void 0)) patch[k] = v ?? null;
    }
    if (Object.keys(patch).length) {
      await base44.asServiceRole.entities.KnowledgeChunk.update(c.id, patch);
      restamped++;
    }
  }
  const after = await loadChunks(base44, training.id);
  const mismatches = after.map((c) => ({ id: c.id, fields: projectionMismatchFields(c, scopeFields, govFields) })).filter((m) => m.fields.length);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const unit_set_complete = desired.every((d) => after.some((c) => c.content_hash === d.content_hash)) && after.every((c) => desiredHashes.has(c.content_hash));
  return { restamped, mismatches, fingerprint, unit_count: after.length, unit_set_complete };
}
async function cleanupChunks(base44, trainingId) {
  const chunks = await loadChunks(base44, trainingId);
  for (const c of chunks) await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
  return chunks.length;
}
async function verifyChunks(base44, training) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const existing = await loadChunks(base44, training.id);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const existingHashes = new Set(existing.map((c) => c.content_hash));
  const unit_set_complete = desired.every((d) => existingHashes.has(d.content_hash)) && existing.every((c) => desiredHashes.has(c.content_hash));
  const mismatches = existing.map((c) => ({ id: c.id, fields: projectionMismatchFields(c, scopeFields, govFields) })).filter((m) => m.fields.length);
  return { unit_count: existing.length, unit_set_complete, mismatches, fingerprint };
}
async function stagedBuild(base44, training) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const existing = await loadChunks(base44, training.id);
  const existingByHash = /* @__PURE__ */ new Map();
  for (const c of existing) existingByHash.set(c.content_hash, c);
  let created = 0;
  for (const d of desired) {
    const match = existingByHash.get(d.content_hash);
    if (match) {
      const patch = scopeFieldsDrift(match, scopeFields, d.chunk_index);
      for (const [k, v] of Object.entries(govFields)) {
        const cur = match[k] ?? void 0;
        if (cur !== (v ?? void 0)) patch[k] = v ?? null;
      }
      if (match.index_stale !== true) patch.index_stale = true;
      if (Object.keys(patch).length) {
        await base44.asServiceRole.entities.KnowledgeChunk.update(match.id, patch);
      }
      continue;
    }
    await base44.asServiceRole.entities.KnowledgeChunk.create({
      training_id: training.id,
      chunk_index: d.chunk_index,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: d.content_hash,
      token_count: approxTokens(d.content),
      keywords: extractKeywords(d.content),
      embedding_model: "lexical-only",
      index_stale: true,
      ...scopeFields,
      ...govFields
    });
    created++;
  }
  for (const c of existing) {
    if (!desiredHashes.has(c.content_hash)) {
      await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
    }
  }
  return { created, total: desired.length, fingerprint };
}

// base44/shared/mindvaultLifecycle.ts
var MINDVAULT_POLICY = DEFAULT_POLICY;
var MINDVAULT_CONTENT_FIELDS = [
  "title",
  "transcript",
  "summary",
  "key_takeaways",
  "sop_steps",
  "decision_rules",
  "common_mistakes",
  "required_inputs",
  "final_output",
  "software_systems",
  "ai_knowledge_entry",
  "exceptions",
  "roles_involved",
  "approvers",
  "escalation_paths",
  "prerequisites",
  "deadlines",
  "verification_checkpoints",
  "prohibited_actions",
  "process_name",
  "topic_category",
  "category",
  "client_segment"
];
var MINDVAULT_INPLACE_METADATA_FIELDS = [
  "effective_from",
  "effective_until",
  "source_authority",
  "operational_process_id",
  "department",
  "source_review_interval_days",
  "knowledge_scope",
  "client_id",
  "client_name"
];
function classifyEdit(patch) {
  const keys = Object.keys(patch || {});
  const content = keys.some((k) => MINDVAULT_CONTENT_FIELDS.includes(k));
  const meta = keys.some((k) => MINDVAULT_INPLACE_METADATA_FIELDS.includes(k));
  if (content && meta) return "mixed";
  if (content) return "content";
  if (meta) return "metadata";
  return "none";
}
function scopeKeyOf(t) {
  return `${t?.knowledge_scope || "unclassified"}:${t?.client_id || ""}`;
}
function trainingToVersion(t) {
  return {
    id: t.id,
    lineageId: t.root_source_id || t.id,
    versionNumber: typeof t.version_number === "number" ? t.version_number : 1,
    isActiveVersion: t.is_active_version !== false,
    verificationStatus: t.verification_status || "unverified",
    isArchived: t.is_archived === true,
    effectiveFrom: t.effective_from ?? null,
    effectiveUntil: t.effective_until ?? null,
    reviewRequestedAt: t.review_requested_at ?? null,
    reviewOutcome: t.review_outcome ?? null,
    scopeKey: scopeKeyOf(t),
    lifecycleSeq: typeof t.lifecycle_seq === "number" ? t.lifecycle_seq : 0,
    indexState: t.index_status ?? void 0,
    indexedFingerprint: t.indexed_content_hash ?? null,
    indexedVersionNumber: t.indexed_version_number ?? null,
    lifecycleState: t.lifecycle_state ?? void 0
  };
}
var V2T = {
  isActiveVersion: "is_active_version",
  verificationStatus: "verification_status",
  isArchived: "is_archived",
  effectiveFrom: "effective_from",
  effectiveUntil: "effective_until",
  reviewRequestedAt: "review_requested_at",
  reviewOutcome: "review_outcome",
  lifecycleState: "lifecycle_state",
  indexState: "index_status",
  indexedFingerprint: "indexed_content_hash",
  indexedVersionNumber: "indexed_version_number",
  versionNumber: "version_number",
  // engine extras (set via Record<string,unknown> casts)
  verifiedBy: "verified_by",
  verifiedAt: "verified_at",
  changesRequestedNote: "changes_requested_note",
  lastReviewedAt: "last_reviewed_at",
  reviewedBy: "reviewed_by",
  index_error: "index_error",
  scopeKey: "__scopeKey"
  // handled specially below
};
function versionPatchToTraining(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "scopeKey") {
      const s = String(v);
      const i = s.indexOf(":");
      out.knowledge_scope = i >= 0 ? s.slice(0, i) : s;
      const cid = i >= 0 ? s.slice(i + 1) : "";
      out.client_id = cid || null;
      continue;
    }
    if (k === "denorm" && v && typeof v === "object") {
      Object.assign(out, v);
      continue;
    }
    const mapped = V2T[k];
    if (mapped && mapped !== "__scopeKey") out[mapped] = v;
    else if (!mapped) out[k] = v;
  }
  return out;
}
function makePersistence(base44) {
  const T = () => base44.asServiceRole.entities.Training;
  const O = () => base44.asServiceRole.entities.KnowledgeLifecycleOperation;
  const R = () => base44.asServiceRole.entities.KnowledgeRevision;
  const A = () => base44.asServiceRole.entities.AuditEvent;
  const opToRow = (op) => ({
    operation_id: op.operationId,
    root_source_id: op.lineageId,
    action: op.action,
    target_training_id: op.targetVersionId,
    prior_active_training_id: op.priorActiveVersionId ?? null,
    expected_lifecycle_seq: op.expectedLifecycleSeq,
    prior_active_lifecycle_seq: op.priorActiveLifecycleSeq ?? null,
    status: op.status,
    failure_stage: op.failureStage ?? null,
    failure_reason: op.failureReason ?? null,
    payload_hash: op.payloadHash,
    resume_count: op.resumeCount,
    started_by: op.startedBy ?? null,
    started_at: op.startedAt,
    completed_at: op.completedAt ?? null
  });
  const rowToOp = (r) => ({
    operationId: r.operation_id,
    lineageId: r.root_source_id,
    action: r.action,
    targetVersionId: r.target_training_id,
    priorActiveVersionId: r.prior_active_training_id ?? null,
    expectedLifecycleSeq: r.expected_lifecycle_seq,
    priorActiveLifecycleSeq: r.prior_active_lifecycle_seq ?? null,
    status: r.status,
    failureStage: r.failure_stage ?? null,
    failureReason: r.failure_reason ?? null,
    payloadHash: r.payload_hash || "",
    resumeCount: r.resume_count || 0,
    startedBy: r.started_by ?? null,
    startedAt: r.started_at,
    completedAt: r.completed_at ?? null
  });
  return {
    async getVersion(id) {
      const t = await T().get(id).catch(() => null);
      return t ? trainingToVersion(t) : null;
    },
    async listLineage(lineageId) {
      const [byRoot, self] = await Promise.all([
        T().filter({ root_source_id: lineageId }, null, 200).catch(() => []),
        T().get(lineageId).catch(() => null)
      ]);
      const map = /* @__PURE__ */ new Map();
      for (const t of byRoot) map.set(t.id, t);
      if (self && !map.has(self.id)) map.set(self.id, self);
      return [...map.values()].map(trainingToVersion);
    },
    async writeVersion(id, patch, expectedSeq) {
      const cur = await T().get(id);
      if (!cur) throw new Error("Training not found: " + id);
      if ((typeof cur.lifecycle_seq === "number" ? cur.lifecycle_seq : 0) !== expectedSeq) {
        throw new StaleSeqError();
      }
      const data = versionPatchToTraining(patch);
      data.lifecycle_seq = expectedSeq + 1;
      await T().update(id, data);
      return trainingToVersion(await T().get(id));
    },
    async createVersionRow(fromVersion, overrides) {
      const src = await T().get(fromVersion.id);
      if (!src) throw new Error("source Training not found");
      const clone = {};
      const CARRY = [
        ...MINDVAULT_CONTENT_FIELDS,
        "knowledge_scope",
        "client_id",
        "client_name",
        "source_type",
        "source_format",
        "source_filename",
        "source_url",
        "department",
        "operational_process_id",
        "source_authority",
        "effective_from",
        "effective_until",
        "video_url",
        "drive_file_id",
        "presenter",
        "duration_minutes",
        "tags",
        "is_eval_fixture",
        "source_review_interval_days"
      ];
      for (const k of CARRY) if (src[k] !== void 0) clone[k] = src[k];
      Object.assign(clone, versionPatchToTraining(overrides));
      clone.status = "ready";
      clone.root_source_id = fromVersion.lineageId;
      clone.supersedes_source_id = fromVersion.id;
      clone.is_active_version = false;
      clone.verification_status = "unverified";
      clone.lifecycle_seq = 0;
      clone.index_status = "pending";
      const created = await T().create(clone);
      return trainingToVersion(created);
    },
    async putOperation(op) {
      const existing = await O().filter({ operation_id: op.operationId }, null, 1).catch(() => []);
      if (existing?.[0]) await O().update(existing[0].id, opToRow(op));
      else await O().create(opToRow(op));
    },
    async getOperation(operationId) {
      const rows = await O().filter({ operation_id: operationId }, null, 1).catch(() => []);
      return rows?.[0] ? rowToOp(rows[0]) : null;
    },
    async listOpenOperations() {
      const rows = await O().filter(
        { status: { $in: ["pending", "applying", "indexing", "verifying", "failed", "compensating"] } },
        "-started_at",
        500
      ).catch(() => []);
      return rows.map(rowToOp);
    },
    async lastCompletedOperation(lineageId, action) {
      const rows = await O().filter(
        { root_source_id: lineageId, action, status: "completed" },
        "-completed_at",
        1
      ).catch(() => []);
      return rows?.[0] ? rowToOp(rows[0]) : null;
    },
    async appendRevision(rec) {
      await R().create({
        root_source_id: rec.lineageId,
        training_id: rec.versionId,
        previous_training_id: rec.previousVersionId ?? null,
        version_number: rec.versionNumber,
        previous_version_number: rec.previousVersionNumber ?? null,
        operation_id: rec.operationId,
        change_source: rec.changeSource || "other",
        change_reason: rec.changeReason ?? null,
        changed_by: rec.changedBy ?? null,
        verified_by: rec.verifiedBy ?? null,
        verification_status: rec.verificationStatus,
        effective_from: rec.effectiveFrom ?? null,
        effective_until: rec.effectiveUntil ?? null,
        content_snapshot: rec.contentSnapshot ?? null,
        field_diff: rec.fieldDiff ?? null
      });
    },
    async appendAudit(rec) {
      await A().create({
        entity: "Training",
        entity_id: rec.versionId,
        action: rec.code.toLowerCase(),
        actor_type: rec.actorType,
        actor_user_id: rec.actorId ?? void 0,
        summary: rec.summary,
        before: rec.before ?? void 0,
        after: rec.after ?? void 0,
        operation_id: rec.operationId ?? void 0
      });
    },
    async auditExists(operationId, code) {
      if (!operationId) return false;
      const rows = await A().filter(
        { operation_id: operationId, action: String(code).toLowerCase() },
        null,
        1
      ).catch(() => []);
      return Array.isArray(rows) && rows.length > 0;
    },
    async revisionExists(operationId, versionId) {
      if (!operationId) return false;
      const rows = await R().filter(
        { operation_id: operationId, training_id: versionId },
        null,
        1
      ).catch(() => []);
      return Array.isArray(rows) && rows.length > 0;
    },
    async markNeedsManualReconciliation(lineageId, reason) {
      const versions = await this.listLineage(lineageId);
      for (const v of versions) {
        await T().update(v.id, {
          index_status: "failed",
          index_error: `manual reconciliation required: ${reason}`.slice(0, 800)
        }).catch(() => {
        });
      }
    }
  };
}
function makeIndexWorker(base44) {
  const T = () => base44.asServiceRole.entities.Training;
  const training = (id) => T().get(id);
  return {
    async build(v) {
      await stagedBuild(base44, await training(v.id));
    },
    async restamp(v) {
      await restampChunks(base44, await training(v.id));
    },
    async cleanup(v) {
      await cleanupChunks(base44, v.id);
    },
    async markStale(ids) {
      for (const id of ids) await setChunksStale(base44, id, true);
    },
    async clearStale(id) {
      await setChunksStale(base44, id, false);
    },
    async verifyStaleCleared(id) {
      return await verifyStaleCleared(base44, id);
    },
    async fingerprint(v) {
      return (await verifyChunks(base44, await training(v.id))).fingerprint;
    },
    async unitSetComplete(v) {
      return (await verifyChunks(base44, await training(v.id))).unit_set_complete;
    },
    async projectionMismatches(v) {
      const { mismatches } = await verifyChunks(base44, await training(v.id));
      return mismatches.flatMap(
        (m) => m.fields.map((f) => ({ field: f, expected: "source", actual: "chunk", unitId: m.id }))
      );
    },
    async unitCount(id) {
      return (await loadChunks(base44, id)).length;
    }
  };
}
function adminOnlyAuthorizer() {
  return {
    authorize(actor) {
      if (actor && actor.role === "admin") return { ok: true };
      return { ok: false, reason: "admin only" };
    }
  };
}
function mindvaultClock() {
  return { now: () => (/* @__PURE__ */ new Date()).toISOString(), nowMs: () => Date.now() };
}
function mindvaultIdGen() {
  return {
    operationId: () => globalThis.crypto?.randomUUID?.() ?? `op_${Date.now()}_${Math.random().toString(16).slice(2)}`
  };
}
function buildMindvaultLifecycle(base44, opts = {}) {
  const engine = createLifecycleEngine({
    persistence: makePersistence(base44),
    indexWorker: makeIndexWorker(base44),
    authorizer: adminOnlyAuthorizer(),
    clock: mindvaultClock(),
    idGen: mindvaultIdGen(),
    policy: MINDVAULT_POLICY,
    redact: opts.redact
  });
  const vocabulary = resolveVocabulary(opts.vocabularyOverride);
  return { engine, vocabulary };
}

// scripts/rag-eval/source-lifecycle.test.mjs
var repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var readEntity = (n) => JSON.parse(readFileSync(resolve(repo, `base44/entities/${n}.jsonc`), "utf8").replace(/^\s*\/\/.*$/gm, ""));
test("classifyEdit: content fields fork; metadata fields restamp; mixed is refused", () => {
  assert.equal(classifyEdit({ summary: "x" }), "content");
  assert.equal(classifyEdit({ sop_steps: [] }), "content");
  assert.equal(classifyEdit({ title: "x" }), "content");
  assert.equal(classifyEdit({ effective_from: "x" }), "metadata");
  assert.equal(classifyEdit({ source_authority: "policy" }), "metadata");
  assert.equal(classifyEdit({ operational_process_id: "p1" }), "metadata");
  assert.equal(classifyEdit({ summary: "x", effective_from: "y" }), "mixed");
  assert.equal(classifyEdit({ presenter: "x" }), "none");
});
test("content and metadata field lists do not overlap", () => {
  const c = new Set(MINDVAULT_CONTENT_FIELDS);
  for (const m of MINDVAULT_INPLACE_METADATA_FIELDS) assert.equal(c.has(m), false, `${m} is in both lists`);
});
test("trainingToVersion: missing values map to safe defaults (v1, active, unverified)", () => {
  const v = trainingToVersion({ id: "t1", title: "x" });
  assert.equal(v.lineageId, "t1");
  assert.equal(v.versionNumber, 1);
  assert.equal(v.isActiveVersion, true);
  assert.equal(v.verificationStatus, "unverified");
  assert.equal(v.isArchived, false);
  assert.equal(v.lifecycleSeq, 0);
  assert.equal(v.scopeKey, "unclassified:");
});
test("scopeKeyOf composes knowledge_scope + client_id", () => {
  assert.equal(scopeKeyOf({ knowledge_scope: "general" }), "general:");
  assert.equal(scopeKeyOf({ knowledge_scope: "client-specific", client_id: "C1" }), "client-specific:C1");
});
test("versionPatchToTraining maps engine field names + splits scopeKey", () => {
  const t = versionPatchToTraining({
    isActiveVersion: true,
    verificationStatus: "verified",
    reviewOutcome: null,
    verifiedBy: "u1",
    changesRequestedNote: null,
    indexState: "indexed",
    scopeKey: "client-specific:C9",
    denorm: { source_authority: "approved_sop" }
  });
  assert.equal(t.is_active_version, true);
  assert.equal(t.verification_status, "verified");
  assert.equal(t.verified_by, "u1");
  assert.equal(t.changes_requested_note, null);
  assert.equal(t.index_status, "indexed");
  assert.equal(t.knowledge_scope, "client-specific");
  assert.equal(t.client_id, "C9");
  assert.equal(t.source_authority, "approved_sop");
});
function stubBase44() {
  const store = { Training: /* @__PURE__ */ new Map(), KnowledgeChunk: /* @__PURE__ */ new Map(), KnowledgeLifecycleOperation: /* @__PURE__ */ new Map(), KnowledgeRevision: [], AuditEvent: [], OperationalProcess: /* @__PURE__ */ new Map(), AppConfig: /* @__PURE__ */ new Map() };
  let n = 0;
  const coll = (name) => ({
    async get(id) {
      return store[name].get(id) ? { ...store[name].get(id) } : null;
    },
    async create(data) {
      const id = data.id || `${name}_${++n}`;
      const row = { ...data, id, created_date: (/* @__PURE__ */ new Date()).toISOString() };
      store[name].set ? store[name].set(id, row) : store[name].push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = store[name].get(id);
      Object.assign(row, patch);
      return { ...row };
    },
    async delete(id) {
      store[name].delete(id);
    },
    async filter(q) {
      const rows = store[name].set ? [...store[name].values()] : store[name];
      return rows.filter((r) => Object.entries(q).every(([k, val]) => {
        if (val && typeof val === "object" && "$in" in val) return val.$in.includes(r[k]);
        return r[k] === val;
      }));
    }
  });
  const arrColl = (name) => ({
    async create(data) {
      const id = `${name}_${++n}`;
      const row = { ...data, id, created_date: (/* @__PURE__ */ new Date()).toISOString() };
      store[name].push(row);
      return { ...row };
    },
    async filter(q) {
      return store[name].filter((r) => Object.entries(q).every(([k, v]) => r[k] === v));
    }
  });
  const entities = {
    Training: coll("Training"),
    KnowledgeChunk: coll("KnowledgeChunk"),
    KnowledgeLifecycleOperation: coll("KnowledgeLifecycleOperation"),
    KnowledgeRevision: arrColl("KnowledgeRevision"),
    AuditEvent: arrColl("AuditEvent"),
    OperationalProcess: coll("OperationalProcess"),
    AppConfig: coll("AppConfig")
  };
  return { asServiceRole: { entities }, __store: store };
}
test("full governed cycle: fork draft -> pre-index -> verify -> activate; active v1 untouched until publish", async () => {
  const base44 = stubBase44();
  await base44.asServiceRole.entities.Training.create({
    id: "T1",
    title: "Bank rec SOP",
    summary: "reconcile the bank statement monthly",
    knowledge_scope: "general",
    status: "ready",
    version_number: 1,
    is_active_version: true,
    verification_status: "verified",
    index_status: "indexed",
    indexed_version_number: 1,
    lifecycle_seq: 0
  });
  await base44.asServiceRole.entities.KnowledgeChunk.create({
    id: "T1c0",
    training_id: "T1",
    content: "reconcile the bank statement monthly",
    content_hash: "h0",
    knowledge_scope: "general",
    index_stale: null
  });
  const { engine } = buildMindvaultLifecycle(base44);
  const admin = { id: "admin", role: "admin" };
  const v1Before = JSON.stringify(base44.__store.Training.get("T1"));
  const cv = await engine.createVersion(admin, "T1", (d) => ({ ...d, summary: "reconcile the bank statement AND the sub-ledger monthly" }));
  assert.ok(cv.ok, JSON.stringify(cv));
  assert.equal(JSON.stringify(base44.__store.Training.get("T1")), v1Before, "active v1 unchanged by createVersion");
  const draft = base44.__store.Training.get(cv.draftId);
  assert.equal(draft.is_active_version, false);
  assert.equal(draft.verification_status, "unverified");
  assert.equal(draft.version_number, 2);
  assert.equal(draft.root_source_id, "T1");
  const bi = await engine.buildDraftIndex(admin, cv.draftId);
  assert.ok(bi.ok, JSON.stringify(bi));
  assert.equal(base44.__store.Training.get(cv.draftId).index_status, "indexed");
  const draftChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === cv.draftId);
  assert.ok(draftChunks.length >= 1);
  assert.equal(base44.__store.Training.get("T1").is_active_version, true, "v1 still active during pre-index");
  const vr = await engine.verify(admin, cv.draftId);
  assert.ok(vr.ok);
  const act = await engine.activate(admin, cv.draftId);
  assert.ok(act.ok, JSON.stringify(act));
  assert.equal(base44.__store.Training.get(cv.draftId).is_active_version, true);
  assert.equal(base44.__store.Training.get("T1").is_active_version, false, "v1 demoted");
  const oldChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === "T1");
  assert.equal(oldChunks.length, 0);
  const newChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === cv.draftId);
  assert.ok(newChunks.every((c) => c.index_stale !== true), "new active chunks not stale after commit");
  assert.ok(base44.__store.KnowledgeRevision.some((r) => r.operation_id === act.operationId));
  assert.ok(base44.__store.AuditEvent.some((a) => a.action === "version_activated"));
});
test("metadata-only edit restamps the active version in place, verification unchanged", async () => {
  const base44 = stubBase44();
  await base44.asServiceRole.entities.Training.create({
    id: "T2",
    title: "x",
    summary: "a body here",
    knowledge_scope: "general",
    status: "ready",
    is_active_version: true,
    verification_status: "verified",
    version_number: 1,
    lifecycle_seq: 0,
    index_status: "indexed"
  });
  await base44.asServiceRole.entities.KnowledgeChunk.create({
    id: "T2c0",
    training_id: "T2",
    content: "a body here",
    content_hash: "h",
    knowledge_scope: "general"
  });
  const { engine } = buildMindvaultLifecycle(base44);
  const r = await engine.setMetadata({ id: "admin", role: "admin" }, "T2", { effectiveFrom: "2026-01-01T00:00:00Z" });
  assert.ok(r.ok, JSON.stringify(r));
  const t = base44.__store.Training.get("T2");
  assert.equal(t.effective_from, "2026-01-01T00:00:00Z");
  assert.equal(t.verification_status, "verified", "metadata change does not reset verification");
  assert.equal(t.version_number, 1, "no new version for a metadata change");
});
test("invalid effective window is refused at write time", async () => {
  const base44 = stubBase44();
  await base44.asServiceRole.entities.Training.create({
    id: "T3",
    title: "x",
    knowledge_scope: "general",
    status: "ready",
    is_active_version: true,
    verification_status: "verified",
    version_number: 1,
    lifecycle_seq: 0
  });
  const { engine } = buildMindvaultLifecycle(base44);
  const r = await engine.setMetadata({ id: "admin", role: "admin" }, "T3", {
    effectiveFrom: "2027-01-01T00:00:00Z",
    effectiveUntil: "2026-01-01T00:00:00Z"
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_effective_window");
});
test("KnowledgeRevision + KnowledgeLifecycleOperation: admin-only RLS, no answer-like fields", () => {
  for (const name of ["KnowledgeRevision", "KnowledgeLifecycleOperation"]) {
    const s = readEntity(name);
    for (const op of ["create", "read", "update", "delete"]) {
      assert.deepEqual(s.rls[op], { user_condition: { role: "admin" } }, `${name}.rls.${op}`);
    }
    const src = JSON.stringify(s);
    assert.equal(/proposed_answer|corrected_answer|answer_text|correct_text/.test(src), false, `${name} must carry no answer-like field`);
  }
});
test("KnowledgeRevision is append-only by contract: no Phase 6 function updates/deletes it", () => {
  const fns = [
    "reviewKnowledgeSource",
    "updateKnowledgeSource",
    "reindexKnowledgeSource",
    "reconcileSourceLifecycle",
    "computeSourceFreshness",
    "listKnowledgeSourceHistory"
  ];
  for (const f of fns) {
    const src = readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), "utf8");
    assert.equal(/KnowledgeRevision\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete KnowledgeRevision`);
    assert.equal(/AuditEvent\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete AuditEvent`);
  }
});
test("the engine never writes AuditEvent.update/delete or KnowledgeRevision.update/delete", () => {
  const eng = readFileSync(resolve(repo, "base44/shared/lifecycle/engine.ts"), "utf8");
  assert.equal(/appendAudit|appendRevision/.test(eng), true, "engine appends audit/revision records");
  assert.equal(/\.(update|delete)Audit|updateRevision|deleteRevision/.test(eng), false);
});
var VERIF_WRITE = /verification_status\s*[:=]\s*['"](verified|rejected)['"]|is_active_version\s*[:=]\s*true/;
test("Phase 5 + analyzeTraining never set verification_status verified/rejected or is_active_version true", () => {
  const files = [
    "base44/functions/submitKnowledgeFeedback/entry.ts",
    "base44/functions/logKnowledgeGap/entry.ts",
    "base44/functions/reviewKnowledgeGap/entry.ts",
    "base44/functions/respondToClarification/entry.ts",
    "base44/functions/replyToClarification/entry.ts",
    "base44/shared/gapAggregation.ts"
  ];
  for (const f of files) {
    const src = readFileSync(resolve(repo, f), "utf8");
    assert.equal(VERIF_WRITE.test(src), false, `${f} must not promote content (verification/active flags)`);
  }
});
test("analyzeTraining guards SERVED governed sources (state-based, both flag values) and sets no verification/active flags", () => {
  const src = readFileSync(resolve(repo, "base44/functions/analyzeTraining/entry.ts"), "utf8");
  assert.ok(src.includes("classifyReanalysisTarget"), "analyzeTraining must decide from served STATE");
  assert.ok(src.includes("governed_source") && src.includes("lifecycle_disabled"), "refuses in BOTH flag states");
  assert.equal(VERIF_WRITE.test(src), false, "analyzeTraining must not set verification/active flags itself");
});
test("only reviewKnowledgeSource / updateKnowledgeSource reach the lifecycle engine", () => {
  const build = "buildMindvaultLifecycle";
  const users = [
    "reviewKnowledgeSource",
    "updateKnowledgeSource",
    "reindexKnowledgeSource",
    "reconcileSourceLifecycle",
    "listKnowledgeSourceHistory"
  ];
  for (const f of users) {
    assert.ok(
      readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), "utf8").includes(build),
      `${f} should construct the engine via the binding`
    );
  }
  for (const f of ["submitKnowledgeFeedback", "logKnowledgeGap", "askKnowledgeBaseV2"]) {
    assert.equal(
      readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), "utf8").includes(build),
      false,
      `${f} must not touch the lifecycle engine`
    );
  }
});
