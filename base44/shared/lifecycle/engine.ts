// Governed-lifecycle engine — orchestrator.
//
// Wires the injected adapters (persistence, index worker, authorizer, clock,
// id-gen, policy) into the lifecycle methods MindVault needs. Every method:
//   authorize -> load -> assert legal -> open/advance a LifecycleOperation ->
//   run the fail-closed index sequence -> verify -> on success append a
//   RevisionRecord + AuditRecord and complete; on failure leave units stale and
//   record the failure stage.
//
// NON-NEGOTIABLE SAFETY (enforced here, not configurable):
//   * active content is never edited in place — content changes go through
//     createVersion (a new unverified draft); the active row is untouched.
//   * human verification is required before activate (unless an explicit force
//     flag that policy must also allow).
//   * a draft must be pre-indexed + metadata-verified while inactive before it
//     can be activated.
//   * index_stale is the FINAL commit gate: new active units stay stale through
//     every restamp/verify step and are cleared only as the penultimate action,
//     which is itself verified before the operation completes.
//   * hash equality alone never proves index correctness (planReindex).
//   * the activation cutover performs NO generation.
//   * lifecycle transitions normalize their backing fields (stateMachine).
//   * reconcile is driven by the operation record and never guesses.

import {
  computeFreshness,
  DEFAULT_POLICY,
  type LifecyclePolicy,
} from "./policy.ts";
import {
  compensationKind,
} from "./operationMachine.ts";
import {
  assertTransitionLegal,
  demoteFields,
  deriveLifecycleState,
  newDraftFields,
  normalizeForTransition,
} from "./stateMachine.ts";
import { isIndexNoOp, planReindex } from "./verification.ts";
import type {
  Authorizer,
  Clock,
  EngineResult,
  IdGen,
  IndexWorker,
  LifecycleOperation,
  LifecycleState,
  LifecycleTransition,
  Mismatch,
  OpAction,
  OpStatus,
  PersistenceAdapter,
  ResourceVersion,
  RevisionRecord,
  AuditCode,
} from "./types.ts";
import { StaleSeqError } from "./types.ts";

export interface EngineDeps {
  persistence: PersistenceAdapter;
  indexWorker: IndexWorker;
  authorizer: Authorizer;
  clock: Clock;
  idGen: IdGen;
  policy?: LifecyclePolicy;
  redact?: (s: unknown) => string;
}

type Actor = { id?: string | null; role?: string | null } | null | undefined;

export interface MetadataPatch {
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  scopeKey?: string;
  // opaque binding fields (authority, process link, department, cadence…)
  denorm?: Record<string, unknown>;
  passthrough?: Partial<ResourceVersion>;
}

const REDACT_FALLBACK = (s: unknown) => String(s ?? "").slice(0, 800);

export function createLifecycleEngine(deps: EngineDeps) {
  const policy = deps.policy || DEFAULT_POLICY;
  const redact = deps.redact || REDACT_FALLBACK;
  const { persistence: db, indexWorker: worker, authorizer, clock, idGen } = deps;

  // --- operation record helpers -----------------------------------------

  async function openOperation(
    action: OpAction,
    target: ResourceVersion,
    payloadHash: string,
    actorId: string | null,
    prior?: ResourceVersion | null,
  ): Promise<LifecycleOperation> {
    const op: LifecycleOperation = {
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
      completedAt: null,
    };
    await db.putOperation(op);
    return op;
  }

  async function advance(op: LifecycleOperation, status: OpStatus): Promise<void> {
    op.status = status;
    if (status === "completed" || status === "failed") op.completedAt = clock.now();
    await db.putOperation(op);
  }

  async function fail(
    op: LifecycleOperation,
    stage: LifecycleOperation["failureStage"],
    err: unknown,
  ): Promise<EngineResult> {
    op.status = "failed";
    op.failureStage = stage;
    op.failureReason = redact(err instanceof Error ? err.message : String(err)).slice(0, 800);
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { ok: false, operationId: op.operationId, error: op.failureReason || "failed" };
  }

  async function guardedWrite(
    v: ResourceVersion,
    patch: Partial<ResourceVersion>,
    op: LifecycleOperation,
    expectedSeq: number,
    stage: LifecycleOperation["failureStage"],
  ): Promise<ResourceVersion> {
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

  // --- shared fail-closed index sequences ------------------------------

  // full_build: stale-mark existing -> generate -> verify set+projection ->
  // clear stale -> verify clear. Used for a draft pre-index and for restore.
  async function runFullBuild(v: ResourceVersion, op: LifecycleOperation): Promise<Mismatch[]> {
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

  // restamp: stale-mark -> update denorm metadata on existing units -> verify ->
  // clear stale -> verify clear. No generation. Brief fail-closed window.
  async function runRestamp(v: ResourceVersion, op: LifecycleOperation): Promise<Mismatch[]> {
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

  async function runCleanup(v: ResourceVersion, op: LifecycleOperation): Promise<void> {
    await advance(op, "indexing");
    await worker.markStale([v.id]);
    await worker.cleanup(v);
    await advance(op, "verifying");
    const n = await worker.unitCount(v.id);
    if (n !== 0) throw new Error(`cleanup left ${n} units`);
  }

  // --- activation-operation recovery (NEVER generates) -----------------
  //
  // Once an activation cutover has begun, neither the cutover nor its recovery
  // may perform extraction / chunk generation — the draft was already
  // successfully pre-indexed. These helpers use ONLY: stale marking, lifecycle-
  // flag restore/complete, restamp, cleanup, projection/unit-set verification,
  // and stale clear. They act on the EXPLICIT recorded versions:
  //   op.targetVersionId          -> the NEW (draft/now-active) version
  //   op.priorActiveVersionId     -> the OLD (demoted) version
  // cleanup during recovery is ALWAYS on priorActiveVersionId, never target.

  async function failClosedLineage(
    op: LifecycleOperation,
    reason: string,
  ): Promise<{ handled: number; manual: number }> {
    // Best-effort but exhaustive: the lineage MUST end fully fail-closed and
    // MUST surface the manual-repair state even if one write fails.
    const lineage = await db.listLineage(op.lineageId).catch(() => []);
    await worker.markStale(lineage.map((r) => r.id)).catch(() => {});
    await db.markNeedsManualReconciliation(op.lineageId, reason).catch(() => {});
    await db.appendAudit({
      code: "NEEDS_MANUAL_RECONCILIATION",
      operationId: op.operationId,
      lineageId: op.lineageId,
      versionId: op.targetVersionId,
      actorType: "system",
      actorId: null,
      summary: `${op.action}/${op.failureStage} ${op.operationId} — ${reason}`,
      at: clock.now(),
    }).catch(() => {});
    op.status = "failed";
    op.completedAt = clock.now();
    await db.putOperation(op).catch(() => {});
    return { handled: 0, manual: 1 };
  }

  // Flip succeeded; the NEW version is the intended active one. Drive forward
  // WITHOUT generation: restamp new -> cleanup OLD -> verify -> clear stale.
  async function completeActivationForward(
    op: LifecycleOperation,
  ): Promise<{ handled: number; manual: number }> {
    const target = await db.getVersion(op.targetVersionId);
    if (!target) return failClosedLineage(op, "activation target version missing");
    const prior = op.priorActiveVersionId ? await db.getVersion(op.priorActiveVersionId) : null;

    // Always return the new units to FULLY fail-closed before working — this is
    // also the "re-establish full stale state" step required for a partial
    // cutover_stale_clear recovery.
    await worker.markStale([target.id]);

    // restamp NEW (no build)
    await worker.restamp(target);
    // cleanup OLD — priorActiveVersionId, NEVER target
    if (prior) await worker.cleanup(prior);

    // verify new set + projection
    const complete = await worker.unitSetComplete(target);
    const mism = await worker.projectionMismatches(target);
    if (!complete || mism.length) {
      return failClosedLineage(op, `recovery verify failed (complete=${complete}, mismatch=${mism.length})`);
    }
    // verify old count 0
    if (prior) {
      const n = await worker.unitCount(prior.id);
      if (n !== 0) return failClosedLineage(op, `prior version still has ${n} units after cleanup`);
    }
    // clear stale on NEW, then verify the clear
    await worker.clearStale(target.id);
    if (!(await worker.verifyStaleCleared(target.id))) {
      return failClosedLineage(op, "stale not cleared on the new active units during recovery");
    }

    // Durable terminal publication history — IDENTICAL to a normal activation
    // (VERSION_SUPERSEDED when prior exists, the completed KnowledgeRevision for
    // the activated version, VERSION_ACTIVATED). Idempotent per op.operationId.
    const targetNow = (await db.getVersion(target.id)) || target;
    await finalizeActivation(op, targetNow, prior, {
      actorId: op.startedBy ?? null,
      previousVersionNumber: prior?.versionNumber ?? null,
    });

    // ...plus the extra recovery event (idempotent).
    if (!(await db.auditExists(op.operationId, "LIFECYCLE_RECONCILED"))) {
      await db.appendAudit({
        code: "LIFECYCLE_RECONCILED",
        operationId: op.operationId,
        lineageId: op.lineageId,
        versionId: target.id,
        actorType: "system",
        actorId: null,
        summary: `resumed ${op.action} forward from ${op.failureStage} (no generation; cleaned prior ${op.priorActiveVersionId ?? "none"})`,
        at: clock.now(),
      });
    }

    op.status = "completed";
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { handled: 1, manual: 0 };
  }

  // Flip not (fully) applied and old units were never cleaned (cleanup is a
  // LATER stage). Deterministically restore the OLD version as active from the
  // recorded ids — WITHOUT generation, because the old units still exist.
  async function rollbackActivation(
    op: LifecycleOperation,
  ): Promise<{ handled: number; manual: number }> {
    const target = await db.getVersion(op.targetVersionId);
    const prior = op.priorActiveVersionId ? await db.getVersion(op.priorActiveVersionId) : null;
    if (!prior) {
      return failClosedLineage(op, "no prior active version to roll back to (first activation of the lineage)");
    }
    if (!target) return failClosedLineage(op, "activation target version missing");

    // stale both while we work
    await worker.markStale([target.id, prior.id]);

    // restore flags deterministically from the recorded versions
    const priorNow = await db.getVersion(prior.id);
    if (priorNow) {
      await db.writeVersion(
        prior.id,
        { isActiveVersion: true, lifecycleState: "active" },
        priorNow.lifecycleSeq,
      ).catch(() => {});
    }
    const targetNow = await db.getVersion(target.id);
    if (targetNow) {
      await db.writeVersion(
        target.id,
        {
          isActiveVersion: false,
          lifecycleState: deriveLifecycleState({ ...targetNow, isActiveVersion: false }),
          indexState: "pending",
        },
        targetNow.lifecycleSeq,
      ).catch(() => {});
    }

    // restamp the restored OLD version's still-present units (no build), verify, clear stale
    const priorAfter = await db.getVersion(prior.id);
    if (priorAfter) await worker.restamp(priorAfter);
    const complete = await worker.unitSetComplete(priorAfter || prior);
    const mism = await worker.projectionMismatches(priorAfter || prior);
    if (!complete || mism.length) {
      return failClosedLineage(op, `rollback verify failed (complete=${complete}, mismatch=${mism.length})`);
    }
    await worker.clearStale(prior.id);
    if (!(await worker.verifyStaleCleared(prior.id))) {
      return failClosedLineage(op, "rollback stale-clear failed on the restored version");
    }
    // the failed NEW version stays inactive + stale + pending -> excluded

    await db.appendAudit({
      code: "LIFECYCLE_ROLLED_BACK",
      lineageId: op.lineageId,
      versionId: target.id,
      actorType: "system",
      actorId: null,
      summary: `rolled back ${op.action} from ${op.failureStage}; restored prior active ${prior.id} (no generation)`,
      at: clock.now(),
    });
    op.status = "completed";
    op.completedAt = clock.now();
    await db.putOperation(op);
    return { handled: 1, manual: 0 };
  }

  // Stage-aware recovery for an activate / supersede operation. NO worker.build.
  async function recoverActivation(
    op: LifecycleOperation,
  ): Promise<{ handled: number; manual: number }> {
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

  async function finishOk(
    op: LifecycleOperation,
    v: ResourceVersion,
    code: AuditCode,
    summary: string,
    revision: Partial<RevisionRecord> | null,
    before?: unknown,
    after?: unknown,
  ): Promise<EngineResult> {
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
        fieldDiff: revision.fieldDiff ?? null,
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
      at: clock.now(),
    });
    await advance(op, "completed");
    return {
      ok: true,
      operationId: op.operationId,
      displayState: deriveLifecycleState(v),
    };
  }

  /**
   * Terminal publication history for an activation — the durable governance
   * record a normal activation writes at its final step. Shared by:
   *   - normal activate() step 9
   *   - successful forward reconciliation (completeActivationForward)
   * so both produce EQUIVALENT terminal history. Every write is idempotent per
   * op.operationId: a reconcile retry re-runs this and adds nothing.
   * Does NOT mark the operation completed — the caller does that after any
   * extra events (e.g. the recovery path's LIFECYCLE_RECONCILED).
   */
  async function finalizeActivation(
    op: LifecycleOperation,
    newActive: ResourceVersion,
    prior: ResourceVersion | null,
    ctx: { actorId: string | null; previousVersionNumber: number | null; linkedGapId?: string },
  ): Promise<void> {
    const actorType: "user" | "system" = ctx.actorId ? "user" : "system";

    // terminal index-state writes (tolerate a concurrent seq move)
    const fp = await worker.fingerprint(newActive).catch(() => null);
    const fresh = await db.getVersion(newActive.id);
    if (fresh) {
      await db.writeVersion(newActive.id, {
        indexState: "indexed",
        ...(fp ? { indexedFingerprint: fp } : {}),
        indexedVersionNumber: fresh.versionNumber,
      }, fresh.lifecycleSeq).catch(() => {});
    }
    if (prior) {
      const p = await db.getVersion(prior.id);
      if (p) await db.writeVersion(prior.id, { indexState: "skipped" }, p.lifecycleSeq).catch(() => {});
    }

    if (prior && !(await db.auditExists(op.operationId, "VERSION_SUPERSEDED"))) {
      await db.appendAudit({
        code: "VERSION_SUPERSEDED",
        operationId: op.operationId,
        lineageId: prior.lineageId,
        versionId: prior.id,
        actorType,
        actorId: ctx.actorId,
        summary: `v${prior.versionNumber} superseded by v${newActive.versionNumber}`,
        at: clock.now(),
      });
    }

    if (ctx.linkedGapId && !(await db.auditExists(op.operationId, "METADATA_CHANGED"))) {
      await db.appendAudit({
        code: "METADATA_CHANGED",
        operationId: op.operationId,
        lineageId: newActive.lineageId,
        versionId: newActive.id,
        actorType: "user",
        actorId: ctx.actorId,
        summary: `source brought into compliance for gap ${ctx.linkedGapId}`,
        at: clock.now(),
      });
    }

    if (!(await db.revisionExists(op.operationId, newActive.id))) {
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
        fieldDiff: null,
      });
    }

    if (!(await db.auditExists(op.operationId, "VERSION_ACTIVATED"))) {
      await db.appendAudit({
        code: "VERSION_ACTIVATED",
        operationId: op.operationId,
        lineageId: newActive.lineageId,
        versionId: newActive.id,
        actorType,
        actorId: ctx.actorId,
        summary: `v${newActive.versionNumber} published`,
        at: clock.now(),
      });
    }
  }

  // --- transition primitives (metadata + verification) -----------------

  async function runTransition(
    actor: Actor,
    versionId: string,
    transition: LifecycleTransition,
    action: OpAction,
    code: AuditCode,
    opts: {
      note?: string | null;
      metadata?: MetadataPatch;
      changeSource?: string;
      needsRestamp: boolean;
      needsCleanup?: boolean;
      needsRebuild?: boolean;
    },
  ): Promise<EngineResult> {
    const v = await db.getVersion(versionId);
    if (!v) return { ok: false, error: "version not found" };
    const authz = authorizer.authorize(actor, action, v);
    if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };

    const from: LifecycleState = deriveLifecycleState(v);
    const legal = assertTransitionLegal(from, transition, policy);
    if (!legal.ok) return { ok: false, error: legal.reason };

    const now = clock.now();
    const norm = normalizeForTransition(transition, { now, actorId: actor?.id ?? null, note: opts.note });
    const patch: Partial<ResourceVersion> = { ...norm };

    if (transition === "verify") {
      (patch as Record<string, unknown>).verifiedBy = actor?.id ?? null;
      (patch as Record<string, unknown>).verifiedAt = now;
    }
    if (transition === "request_changes") {
      (patch as Record<string, unknown>).changesRequestedNote = (opts.note || "").slice(0, 2000);
    }
    if (transition === "verify" || transition === "un_reject") {
      (patch as Record<string, unknown>).changesRequestedNote = null;
    }
    if (transition === "confirm_current") {
      (patch as Record<string, unknown>).lastReviewedAt = now;
      (patch as Record<string, unknown>).reviewedBy = actor?.id ?? null;
    }
    if (transition === "set_metadata" && opts.metadata) {
      if (opts.metadata.effectiveFrom !== undefined) patch.effectiveFrom = opts.metadata.effectiveFrom;
      if (opts.metadata.effectiveUntil !== undefined) patch.effectiveUntil = opts.metadata.effectiveUntil;
      if (opts.metadata.scopeKey !== undefined) patch.scopeKey = opts.metadata.scopeKey;
      if (opts.metadata.passthrough) Object.assign(patch, opts.metadata.passthrough);
      if (opts.metadata.denorm) {
        (patch as Record<string, unknown>).denorm = opts.metadata.denorm;
      }
    }

    // Effective-window validation (write-time; read-time tolerance unchanged).
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
      reviewOutcome: patch.reviewOutcome !== undefined ? patch.reviewOutcome : v.reviewOutcome,
      reviewRequestedAt: patch.reviewRequestedAt !== undefined ? patch.reviewRequestedAt : v.reviewRequestedAt,
    });

    const op = await openOperation(action, v, opts.note ? hash(opts.note) : "", actor?.id ?? null);
    await advance(op, "applying");

    let updated: ResourceVersion;
    try {
      updated = await guardedWrite(v, patch, op, v.lifecycleSeq, "apply");
    } catch (e) {
      if (e instanceof StaleSeqError) {
        return { ok: false, error: "stale_state", operationId: op.operationId };
      }
      return fail(op, "apply", e);
    }

    try {
      let mism: Mismatch[] = [];
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
          "apply",
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
        verifiedBy: transition === "verify" ? (actor?.id ?? null) : null,
      },
      { lifecycleState: from },
      { lifecycleState: updated.lifecycleState },
    );
  }

  // --- public API -----------------------------------------------------

  return {
    policy,

    submit: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "submit", "submit", "RESOURCE_SUBMITTED", { needsRestamp: false }),

    requestChanges: (actor: Actor, versionId: string, note: string) =>
      runTransition(actor, versionId, "request_changes", "request_changes", "CHANGES_REQUESTED", {
        note,
        needsRestamp: false,
      }),

    verify: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "verify", "verify", "RESOURCE_VERIFIED", { needsRestamp: false }),

    reject: (actor: Actor, versionId: string, note?: string) =>
      runTransition(actor, versionId, "reject", "reject", "RESOURCE_REJECTED", {
        note,
        needsRestamp: false,
        needsCleanup: true,
      }),

    unReject: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "un_reject", "un_reject", "RESOURCE_UNREJECTED", {
        needsRestamp: false,
        needsRebuild: true,
      }),

    confirmCurrent: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "confirm_current", "confirm_current", "RESOURCE_REVIEWED", {
        needsRestamp: false,
      }),

    setMetadata: (actor: Actor, versionId: string, metadata: MetadataPatch) =>
      runTransition(actor, versionId, "set_metadata", metadataAction(metadata), "METADATA_CHANGED", {
        metadata,
        needsRestamp: true,
        changeSource: "admin_edit",
      }),

    archive: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "archive", "archive", "RESOURCE_ARCHIVED", {
        needsRestamp: false,
        needsCleanup: true,
      }),

    restore: (actor: Actor, versionId: string) =>
      runTransition(actor, versionId, "restore", "restore", "RESOURCE_RESTORED", {
        needsRestamp: false,
        needsRebuild: true,
      }),

    /** Fork an unverified draft N+1 from the active version. The active row is
     *  NOT touched. `applyContent` mutates the cloned draft with the caller's
     *  content edit before it is persisted. */
    async createVersion(
      actor: Actor,
      activeVersionId: string,
      applyContent: (draft: Partial<ResourceVersion>) => Partial<ResourceVersion>,
      changeSource = "admin_edit",
    ): Promise<EngineResult & { draftId?: string }> {
      const active = await db.getVersion(activeVersionId);
      if (!active) return { ok: false, error: "version not found" };
      const authz = authorizer.authorize(actor, "create_version", active);
      if (!authz.ok) return { ok: false, error: "forbidden", reason: authz.reason };
      const from = deriveLifecycleState(active);
      const legal = assertTransitionLegal(from, "create_version", policy);
      if (!legal.ok) return { ok: false, error: legal.reason };

      const lineage = await db.listLineage(active.lineageId);
      const openDraft = lineage.find(
        (r) => !r.isActiveVersion && !r.isArchived && r.verificationStatus !== "rejected",
      );
      if (openDraft) {
        return { ok: false, error: "open_draft_exists", draftId: openDraft.id };
      }

      const now = clock.now();
      const overrides: Partial<ResourceVersion> = {
        ...newDraftFields(now),
        versionNumber: active.versionNumber + 1,
        lineageId: active.lineageId,
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
          previousVersionNumber: active.versionNumber,
        },
      );
      return { ...res, draftId: draft.id };
    },

    /** Phase I pre-index of an inactive draft. Heavy generation; the draft
     *  stays inactive throughout. */
    async buildDraftIndex(actor: Actor, draftId: string, changeSource = "admin_edit"): Promise<EngineResult> {
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
        d = (await db.getVersion(draftId))!;
        const mism = await runFullBuild(d, op);
        if (mism.length) {
          await db.writeVersion(d.id, { indexState: "failed", index_error: `projection mismatch x${mism.length}` } as Partial<ResourceVersion>, d.lifecycleSeq).catch(() => {});
          return fail(op, "verify", new Error(`projection mismatch x${mism.length}`));
        }
        const fp = await worker.fingerprint(d);
        d = await db.writeVersion(
          d.id,
          { indexState: "indexed", indexedFingerprint: fp, indexedVersionNumber: d.versionNumber },
          d.lifecycleSeq,
        );
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        await db.writeVersion(draftId, { indexState: "failed", index_error: redact(e) } as Partial<ResourceVersion>, d.lifecycleSeq).catch(() => {});
        return fail(op, "index", e);
      }
      return finishOk(op, d, "DRAFT_REINDEXED", `pre-indexed draft v${d.versionNumber}`, {
        changeSource,
      });
    },

    /** The [F1] activation cutover. Precondition: verified (unless forced +
     *  policy allows) AND draft.indexState === 'indexed' AND
     *  indexedVersionNumber === draft.versionNumber. NO generation. */
    async activate(
      actor: Actor,
      draftId: string,
      opts: { force?: boolean; effectiveFromNow?: boolean; linkedGapId?: string } = {},
    ): Promise<EngineResult & { verifiedSourceIds?: string[] }> {
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

      // no other open operation on this lineage
      const open = (await db.listOpenOperations()).filter(
        (o) => o.lineageId === draft.lineageId && o.status !== "completed" && o.status !== "failed",
      );
      if (open.length) return { ok: false, error: "operation_in_flight" };

      const op = await openOperation("activate", draft, "", actor?.id ?? null, priorActive);

      try {
        // 1. stale-mark BOTH sets
        await advance(op, "applying");
        op.failureStage = "cutover_stalemark";
        await db.putOperation(op);
        const staleIds = [draft.id, ...(priorActive ? [priorActive.id] : [])];
        await worker.markStale(staleIds);

        // 2. lifecycle_seq-guarded flip
        op.failureStage = "cutover_flip";
        await db.putOperation(op);
        const newActive = await guardedWrite(
          draft,
          {
            isActiveVersion: true,
            reviewOutcome: "confirmed_current",
            lifecycleState: "active",
            ...(opts.effectiveFromNow ? { effectiveFrom: clock.now() } : {}),
          },
          op,
          draft.lifecycleSeq,
          "cutover_flip",
        );
        let demoted: ResourceVersion | null = null;
        if (priorActive) {
          demoted = await guardedWrite(
            priorActive,
            { ...demoteFields(), lifecycleState: deriveLifecycleState({ ...priorActive, isActiveVersion: false }) },
            op,
            priorActive.lifecycleSeq,
            "cutover_flip",
          );
        }

        // 3. restamp new units (already built) — index_stale STAYS true
        op.failureStage = "cutover_restamp";
        await advance(op, "indexing");
        await worker.restamp(newActive);

        // 4. cleanup old units
        if (demoted) {
          op.failureStage = "cutover_cleanup";
          await db.putOperation(op);
          await worker.cleanup(demoted);
        }

        // 5. verify new set + projection
        op.failureStage = "verify";
        await advance(op, "verifying");
        const complete = await worker.unitSetComplete(newActive);
        const mism = await worker.projectionMismatches(newActive);
        if (!complete || mism.length) {
          return fail(op, "verify", new Error(`new-version verification failed (complete=${complete}, mismatch=${mism.length})`));
        }
        // 6. verify old count 0
        if (demoted) {
          const n = await worker.unitCount(demoted.id);
          if (n !== 0) return fail(op, "verify", new Error(`demoted version still has ${n} units`));
        }

        // 7. ONLY NOW clear stale on the new active units
        op.failureStage = "cutover_stale_clear";
        await db.putOperation(op);
        await worker.clearStale(newActive.id);
        // 8. verify the clear
        const cleared = await worker.verifyStaleCleared(newActive.id);
        if (!cleared) return fail(op, "cutover_stale_clear", new Error("new active units still stale"));

        // 9. commit — the durable terminal publication history. Shared with
        // forward reconciliation via finalizeActivation so both paths write the
        // SAME records (VERSION_SUPERSEDED, completed KnowledgeRevision,
        // VERSION_ACTIVATED), idempotently per op.operationId.
        await finalizeActivation(op, newActive, demoted, {
          actorId: actor?.id ?? null,
          previousVersionNumber: priorActive?.versionNumber ?? null,
          linkedGapId: opts.linkedGapId,
        });
        await advance(op, "completed");
        return {
          ok: true,
          operationId: op.operationId,
          displayState: deriveLifecycleState(newActive),
          verifiedSourceIds: [newActive.id],
        };
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        return fail(op, op.failureStage || "apply", e);
      }
    },

    /** Explicit reindex of a version — applies the [F2] plan. */
    async reindex(actor: Actor, versionId: string): Promise<EngineResult> {
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
        let mism: Mismatch[] = [];
        if (plan === "restamp_repair") mism = await runRestamp(v, op);
        else mism = await runFullBuild(v, op);
        if (mism.length) return fail(op, plan === "full_rebuild" ? "verify" : "restamp", new Error("mismatch after repair"));

        const newFp = await worker.fingerprint(v);
        const updated = await db.writeVersion(
          v.id,
          { indexState: "indexed", indexedFingerprint: newFp, indexedVersionNumber: v.versionNumber },
          v.lifecycleSeq,
        );
        return finishOk(op, updated, "REINDEX_SUCCEEDED", `reindex (${plan})`, null);
      } catch (e) {
        if (e instanceof StaleSeqError) return { ok: false, error: "stale_state", operationId: op.operationId };
        await db.writeVersion(versionId, { indexState: "failed", index_error: redact(e) } as Partial<ResourceVersion>, v.lifecycleSeq).catch(() => {});
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
    async reconcile(actor: Actor): Promise<{ ok: boolean; handled: number; manual: number }> {
      const authz = authorizer.authorize(actor, "manual_reconcile", null);
      if (!authz.ok) return { ok: false, handled: 0, manual: 0 };
      const nowMs = clock.nowMs();
      const ops = await db.listOpenOperations();
      let handled = 0;
      let manual = 0;

      for (const op of ops) {
        const stuck = op.status === "failed" ||
          (["applying", "indexing", "verifying"].includes(op.status) &&
            nowMs - Date.parse(op.startedAt) > policy.stuckAfterMs);
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
            at: clock.now(),
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
          // --- ACTIVATION / SUPERSEDE: stage-aware, NEVER regenerates -------
          // Once the cutover has begun the draft is already pre-indexed, so
          // recovery uses only stale-mark / flag-restore / restamp / cleanup /
          // verify / stale-clear. cleanup during recovery acts on
          // op.priorActiveVersionId (the OLD version), never op.targetVersionId.
          if (op.action === "activate" || op.action === "supersede") {
            const r = await recoverActivation(op);
            handled += r.handled;
            manual += r.manual;
            continue;
          }

          // --- Non-activation operations -----------------------------------
          // A pre-activation build failure (e.g. build_draft_index) legitimately
          // needs a rebuild; a metadata restamp needs a restamp; anything else
          // without a deterministic recovery escalates to manual.
          const kind = compensationKind(op.action, op.failureStage);
          const target = await db.getVersion(op.targetVersionId);
          if (kind === "resume" && target) {
            await worker.markStale([target.id]);
            if (op.failureStage === "restamp" || op.failureStage === "restamp_stale_clear") {
              await worker.restamp(target);
            } else if (op.action === "build_draft_index" || op.failureStage === "index") {
              // pre-activation draft (re)build — generation IS allowed here
              await worker.build(target);
            } else {
              await worker.restamp(target);
            }
            const ok = (await worker.unitSetComplete(target)) &&
              (await worker.projectionMismatches(target)).length === 0;
            if (ok) {
              await worker.clearStale(target.id);
              const fresh = await db.getVersion(target.id);
              if (fresh) {
                await db.writeVersion(
                  target.id,
                  { indexState: "indexed", indexedVersionNumber: fresh.versionNumber },
                  fresh.lifecycleSeq,
                ).catch(() => {});
              }
              await db.appendAudit({
                code: "LIFECYCLE_RECONCILED",
                lineageId: op.lineageId,
                versionId: op.targetVersionId,
                actorType: "system",
                actorId: null,
                summary: `resumed ${op.action} from ${op.failureStage}`,
                at: clock.now(),
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
          // An unexpected throw during recovery must NOT merely mark the
          // operation failed — the lineage may be mid-cutover. Drive it to a
          // surfaced fail-closed state: every unit stale + needs_manual_
          // reconciliation + a NEEDS_MANUAL_RECONCILIATION audit.
          try {
            const r = await failClosedLineage(
              op,
              `unexpected error during recovery: ${redact(recErr)}`,
            );
            manual += r.manual;
          } catch {
            op.status = "failed";
            op.completedAt = clock.now();
            await db.putOperation(op).catch(() => {});
            manual++;
          }
        }
      }
      return { ok: true, handled, manual };
    },

    /** Deterministic freshness for admin / Phase 7 — never an answer-path signal. */
    freshness(nextReviewDueAt: string | null | undefined, intervalDays: number | null | undefined) {
      return computeFreshness(nextReviewDueAt, intervalDays, clock.nowMs(), policy);
    },
  };
}

function metadataAction(m: MetadataPatch): OpAction {
  if (m.effectiveFrom !== undefined || m.effectiveUntil !== undefined) return "set_effective_dates";
  if (m.scopeKey !== undefined) return "reclassify_scope";
  if (m.denorm && ("authority" in m.denorm || "source_authority" in m.denorm)) return "set_authority";
  if (m.denorm && ("operational_process_id" in m.denorm)) return "relink_process";
  return "set_effective_dates";
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
