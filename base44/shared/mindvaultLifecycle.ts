// MindVault BINDING for the reusable governed-lifecycle engine.
//
// Supplies the engine's injected adapters over MindVault's Base44 entities and
// the chunkLifecycle helpers. The engine (base44/shared/lifecycle/) knows
// nothing of Training / KnowledgeChunk / RAG — all of that coupling lives here.
//
// Takes the Base44 client as a parameter (no `npm:@base44/sdk` import) so it
// stays node-loadable for tests that stub the client.

import {
  createLifecycleEngine,
  DEFAULT_POLICY,
  DEFAULT_VOCABULARY,
  resolveVocabulary,
  toDisplayState,
  StaleSeqError,
} from "./lifecycle/index.ts";
import type {
  Authorizer,
  Clock,
  IdGen,
  IndexWorker,
  LifecycleOperation,
  PersistenceAdapter,
  ResourceVersion,
  RevisionRecord,
  AuditRecord,
  DisplaySignals,
  LifecyclePolicy,
  Vocabulary,
} from "./lifecycle/index.ts";
import {
  cleanupChunks,
  loadChunks,
  restampChunks,
  setChunksStale,
  stagedBuild,
  verifyChunks,
  verifyStaleCleared,
} from "./chunkLifecycle.ts";

export const MINDVAULT_POLICY: LifecyclePolicy = DEFAULT_POLICY;

// Fields that FEED KnowledgeChunk generation. A patch touching any of these on
// an ACTIVE version must fork a new unverified draft — never edit in place.
export const MINDVAULT_CONTENT_FIELDS = [
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
  "client_segment",
] as const;

// Non-content metadata that MAY mutate the active version in place (via a
// verified restamp) without forking a version or resetting verification.
export const MINDVAULT_INPLACE_METADATA_FIELDS = [
  "effective_from",
  "effective_until",
  "source_authority",
  "operational_process_id",
  "department",
  "source_review_interval_days",
  "knowledge_scope",
  "client_id",
  "client_name",
] as const;

// Superficial, display-only fields. They never feed chunk CONTENT — a title
// rename only re-stamps the denormalized title copy on the chunks and the
// business PDF — so a patch touching ONLY these mutates the ACTIVE version in
// place through the same verified-restamp path as metadata: the new name shows
// immediately, verification is unchanged, and no draft is forked. When such a
// patch also carries a real content field, the rename simply rides along on
// the forked draft. (title stays in MINDVAULT_CONTENT_FIELDS so forked drafts
// and the chunk scope-stamp keep carrying it.)
export const MINDVAULT_SUPERFICIAL_FIELDS = [
  "title",
] as const;

export function classifyEdit(patch: Record<string, unknown>): "content" | "metadata" | "mixed" | "none" {
  const keys = Object.keys(patch || {});
  const sup = MINDVAULT_SUPERFICIAL_FIELDS as readonly string[];
  // A real content field must fork a draft. A superficial rename in the same
  // patch simply rides along on that draft; metadata mixed with content is
  // still refused (split the patch).
  const content = keys.some(
    (k) => (MINDVAULT_CONTENT_FIELDS as readonly string[]).includes(k) && !sup.includes(k),
  );
  const meta = keys.some((k) => (MINDVAULT_INPLACE_METADATA_FIELDS as readonly string[]).includes(k));
  if (content) return meta ? "mixed" : "content";
  if (meta || keys.some((k) => sup.includes(k))) return "metadata";
  return "none";
}

export function scopeKeyOf(t: any): string {
  return `${t?.knowledge_scope || "unclassified"}:${t?.client_id || ""}`;
}

// --- Training <-> ResourceVersion ------------------------------------------

export function trainingToVersion(t: any): ResourceVersion {
  return {
    id: t.id,
    lineageId: t.root_source_id || t.id,
    versionNumber: typeof t.version_number === "number" ? t.version_number : 1,
    isActiveVersion: t.is_active_version !== false,
    verificationStatus: (t.verification_status || "unverified"),
    isArchived: t.is_archived === true,
    effectiveFrom: t.effective_from ?? null,
    effectiveUntil: t.effective_until ?? null,
    reviewRequestedAt: t.review_requested_at ?? null,
    reviewOutcome: t.review_outcome ?? null,
    scopeKey: scopeKeyOf(t),
    lifecycleSeq: typeof t.lifecycle_seq === "number" ? t.lifecycle_seq : 0,
    indexState: t.index_status ?? undefined,
    indexedFingerprint: t.indexed_content_hash ?? null,
    indexedVersionNumber: t.indexed_version_number ?? null,
    lifecycleState: t.lifecycle_state ?? undefined,
  };
}

// ResourceVersion patch field names (+ the engine's ad-hoc extras) -> Training.
const V2T: Record<string, string> = {
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
  scopeKey: "__scopeKey", // handled specially below
};

export function versionPatchToTraining(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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
      Object.assign(out, v as Record<string, unknown>);
      continue;
    }
    const mapped = V2T[k];
    if (mapped && mapped !== "__scopeKey") out[mapped] = v;
    else if (!mapped) out[k] = v; // passthrough already-snake keys
  }
  return out;
}

// --- Adapters -------------------------------------------------------------

export function makePersistence(base44: any): PersistenceAdapter {
  const T = () => base44.asServiceRole.entities.Training;
  const O = () => base44.asServiceRole.entities.KnowledgeLifecycleOperation;
  const R = () => base44.asServiceRole.entities.KnowledgeRevision;
  const A = () => base44.asServiceRole.entities.AuditEvent;

  const opToRow = (op: LifecycleOperation) => ({
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
    completed_at: op.completedAt ?? null,
  });
  const rowToOp = (r: any): LifecycleOperation => ({
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
    completedAt: r.completed_at ?? null,
  });

  return {
    async getVersion(id) {
      const t = await T().get(id).catch(() => null);
      return t ? trainingToVersion(t) : null;
    },
    async listLineage(lineageId) {
      // lineage = root_source_id === lineageId  OR  id === lineageId (v1 self)
      const [byRoot, self] = await Promise.all([
        T().filter({ root_source_id: lineageId }, null, 200).catch(() => []),
        T().get(lineageId).catch(() => null),
      ]);
      const map = new Map<string, any>();
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
      const data = versionPatchToTraining(patch as Record<string, unknown>);
      data.lifecycle_seq = expectedSeq + 1;
      await T().update(id, data);
      return trainingToVersion(await T().get(id));
    },
    async createVersionRow(fromVersion, overrides) {
      const src = await T().get(fromVersion.id);
      if (!src) throw new Error("source Training not found");
      const clone: Record<string, unknown> = {};
      const CARRY = [
        ...MINDVAULT_CONTENT_FIELDS,
        "knowledge_scope", "client_id", "client_name",
        "source_type", "source_format", "source_filename", "source_url",
        "department", "operational_process_id", "source_authority",
        "effective_from", "effective_until", "video_url", "drive_file_id",
        "presenter", "duration_minutes", "tags", "is_eval_fixture",
        "source_review_interval_days",
      ];
      for (const k of CARRY) if (src[k] !== undefined) clone[k] = src[k];
      Object.assign(clone, versionPatchToTraining(overrides as Record<string, unknown>));
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
        500,
      ).catch(() => []);
      return rows.map(rowToOp);
    },
    async lastCompletedOperation(lineageId, action) {
      const rows = await O().filter(
        { root_source_id: lineageId, action, status: "completed" },
        "-completed_at",
        1,
      ).catch(() => []);
      return rows?.[0] ? rowToOp(rows[0]) : null;
    },
    async appendRevision(rec: RevisionRecord) {
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
        field_diff: rec.fieldDiff ?? null,
      });
    },
    async appendAudit(rec: AuditRecord) {
      await A().create({
        entity: "Training",
        entity_id: rec.versionId,
        action: rec.code.toLowerCase(),
        actor_type: rec.actorType,
        actor_user_id: rec.actorId ?? undefined,
        summary: rec.summary,
        before: rec.before ?? undefined,
        after: rec.after ?? undefined,
        operation_id: rec.operationId ?? undefined,
      });
    },
    async auditExists(operationId: string, code) {
      if (!operationId) return false;
      const rows = await A().filter(
        { operation_id: operationId, action: String(code).toLowerCase() },
        null,
        1,
      ).catch(() => []);
      return Array.isArray(rows) && rows.length > 0;
    },
    async revisionExists(operationId: string, versionId: string) {
      if (!operationId) return false;
      const rows = await R().filter(
        { operation_id: operationId, training_id: versionId },
        null,
        1,
      ).catch(() => []);
      return Array.isArray(rows) && rows.length > 0;
    },
    async markNeedsManualReconciliation(lineageId, reason) {
      const versions = await this.listLineage(lineageId);
      for (const v of versions) {
        await T().update(v.id, {
          index_status: "failed",
          index_error: `manual reconciliation required: ${reason}`.slice(0, 800),
        }).catch(() => {});
      }
    },
  };
}

export function makeIndexWorker(base44: any): IndexWorker {
  const T = () => base44.asServiceRole.entities.Training;
  const training = (id: string) => T().get(id);
  return {
    async build(v) { await stagedBuild(base44, await training(v.id)); },
    async restamp(v) { await restampChunks(base44, await training(v.id)); },
    async cleanup(v) { await cleanupChunks(base44, v.id); },
    async markStale(ids) { for (const id of ids) await setChunksStale(base44, id, true); },
    async clearStale(id) { await setChunksStale(base44, id, false); },
    async verifyStaleCleared(id) { return await verifyStaleCleared(base44, id); },
    async fingerprint(v) { return (await verifyChunks(base44, await training(v.id))).fingerprint; },
    async unitSetComplete(v) { return (await verifyChunks(base44, await training(v.id))).unit_set_complete; },
    async projectionMismatches(v) {
      const { mismatches } = await verifyChunks(base44, await training(v.id));
      return mismatches.flatMap((m: any) =>
        (m.fields as string[]).map((f) => ({ field: f, expected: "source", actual: "chunk", unitId: m.id }))
      );
    },
    async unitCount(id) { return (await loadChunks(base44, id)).length; },
  };
}

export function adminOnlyAuthorizer(): Authorizer {
  return {
    authorize(actor) {
      if (actor && actor.role === "admin") return { ok: true };
      return { ok: false, reason: "admin only" };
    },
  };
}

export function mindvaultClock(): Clock {
  return { now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

export function mindvaultIdGen(): IdGen {
  return {
    operationId: () =>
      (globalThis.crypto?.randomUUID?.() ?? `op_${Date.now()}_${Math.random().toString(16).slice(2)}`),
  };
}

// --- One-call engine construction --------------------------------------

export function buildMindvaultLifecycle(
  base44: any,
  opts: { redact?: (s: unknown) => string; vocabularyOverride?: Partial<Vocabulary> | null } = {},
) {
  const engine = createLifecycleEngine({
    persistence: makePersistence(base44),
    indexWorker: makeIndexWorker(base44),
    authorizer: adminOnlyAuthorizer(),
    clock: mindvaultClock(),
    idGen: mindvaultIdGen(),
    policy: MINDVAULT_POLICY,
    redact: opts.redact,
  });
  const vocabulary = resolveVocabulary(opts.vocabularyOverride);
  return { engine, vocabulary };
}

// --- Presentation helper for the admin panel --------------------------

export function displayFor(
  training: any,
  lineage: any[],
  opts: { anyOpenOperation: boolean; indexStaleOnActive: boolean; needsManualReconciliation: boolean; freshness: DisplaySignals["freshness"] },
): { displayState: ReturnType<typeof toDisplayState>; signals: DisplaySignals } {
  const v = trainingToVersion(training);
  const activeInLineage = lineage.find((t) => t.is_active_version !== false);
  const hasNewerActiveVersion = !!activeInLineage &&
    !v.isActiveVersion &&
    (activeInLineage.version_number || 1) > v.versionNumber;
  const signals: DisplaySignals = {
    lifecycleState: (v.lifecycleState || "draft") as DisplaySignals["lifecycleState"],
    isActiveVersion: v.isActiveVersion,
    hasNewerActiveVersion,
    indexState: (v.indexState || "skipped") as DisplaySignals["indexState"],
    anyOpenOperation: opts.anyOpenOperation,
    indexStaleOnActive: opts.indexStaleOnActive,
    needsManualReconciliation: opts.needsManualReconciliation,
    freshness: opts.freshness,
  };
  return { displayState: toDisplayState(signals), signals };
}

export { DEFAULT_VOCABULARY };