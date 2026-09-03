// Governed-lifecycle engine — abstract types.
//
// This directory (base44/shared/lifecycle/) is a REUSABLE engine: no Base44 SDK,
// no MindVault entity names, no UI, no network, no Deno-only APIs. It contains
// only the abstractions MindVault needs now — it is deliberately NOT a plugin
// SDK, workflow-scripting runtime, or config framework.
//
// MindVault wires it up in base44/shared/mindvaultLifecycle.ts by supplying:
//   - a PersistenceAdapter over its Training / KnowledgeLifecycleOperation /
//     KnowledgeRevision / AuditEvent entities,
//   - an IndexWorker over embedKnowledge,
//   - an Authorizer (admin-only, exactly today's rule),
//   - a Clock + IdGen,
//   - a LifecyclePolicy instance and a Vocabulary map.

export type VerificationStatus = "unverified" | "verified" | "rejected";
export type IndexState = "pending" | "indexing" | "indexed" | "failed" | "skipped";
export type ReviewOutcome =
  | "confirmed_current"
  | "updated"
  | "changes_requested"
  | "archived";

// Derived from a ResourceVersion's OWN fields only (never lineage state).
export type LifecycleState =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "verified"
  | "active"
  | "archived"
  | "rejected";

// Abstract, product-neutral view of one version row in a lineage.
export interface ResourceVersion {
  id: string;
  lineageId: string;
  versionNumber: number;
  isActiveVersion: boolean;
  verificationStatus: VerificationStatus;
  isArchived: boolean;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  reviewRequestedAt?: string | null;
  reviewOutcome?: ReviewOutcome | null;
  // Opaque isolation key the engine denormalizes atomically and never lets lag.
  // MindVault binds it to `${knowledge_scope}:${client_id ?? ""}`.
  scopeKey: string;
  lifecycleSeq: number;
  indexState?: IndexState;
  indexedFingerprint?: string | null;
  indexedVersionNumber?: number | null;
  lifecycleState?: LifecycleState;
  // Metadata the index worker denormalizes onto units and the engine verifies
  // via a binding-supplied projection. Opaque to the engine.
  denormProjection?: Record<string, unknown>;
}

export type LifecycleTransition =
  | "submit"
  | "request_changes"
  | "verify"
  | "reject"
  | "un_reject"
  | "create_version"
  | "activate"
  | "archive"
  | "restore"
  | "set_metadata"
  | "confirm_current";

export type OpAction =
  | "submit"
  | "request_changes"
  | "verify"
  | "reject"
  | "un_reject"
  | "create_version"
  | "build_draft_index"
  | "activate"
  | "supersede"
  | "archive"
  | "restore"
  | "set_effective_dates"
  | "set_authority"
  | "relink_process"
  | "reclassify_scope"
  | "confirm_current"
  | "rollback_activation"
  | "manual_reconcile";

export type OpStatus =
  | "pending"
  | "applying"
  | "indexing"
  | "verifying"
  | "completed"
  | "failed"
  | "compensating";

export type FailureStage =
  | "apply"
  | "index"
  | "verify"
  | "cutover_stalemark"
  | "cutover_flip"
  | "cutover_restamp"
  | "cutover_cleanup"
  | "cutover_stale_clear"
  | "restamp"
  | "restamp_stale_clear"
  | "compensate";

export interface LifecycleOperation {
  operationId: string;
  lineageId: string;
  action: OpAction;
  targetVersionId: string;
  priorActiveVersionId?: string | null;
  expectedLifecycleSeq: number;
  priorActiveLifecycleSeq?: number | null;
  status: OpStatus;
  failureStage?: FailureStage | null;
  failureReason?: string | null;
  payloadHash: string;
  resumeCount: number;
  startedBy?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface RevisionRecord {
  lineageId: string;
  versionId: string;
  previousVersionId?: string | null;
  versionNumber: number;
  previousVersionNumber?: number | null;
  operationId: string;
  changeSource: string;
  changeReason?: string | null;
  changedBy?: string | null;
  verifiedBy?: string | null;
  verificationStatus: VerificationStatus;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  contentSnapshot?: string | null;
  fieldDiff?: string | null;
}

// Stable machine codes. The binding maps them to display strings + its own
// audit-entity label.
export type AuditCode =
  | "RESOURCE_SUBMITTED"
  | "CHANGES_REQUESTED"
  | "RESOURCE_VERIFIED"
  | "RESOURCE_REJECTED"
  | "RESOURCE_UNREJECTED"
  | "VERSION_CREATED"
  | "DRAFT_REINDEXED"
  | "VERSION_ACTIVATED"
  | "VERSION_SUPERSEDED"
  | "RESOURCE_ARCHIVED"
  | "RESOURCE_RESTORED"
  | "METADATA_CHANGED"
  | "RESOURCE_REVIEWED"
  | "REINDEX_SUCCEEDED"
  | "REINDEX_FAILED"
  | "LIFECYCLE_RECONCILED"
  | "LIFECYCLE_ROLLED_BACK"
  | "NEEDS_MANUAL_RECONCILIATION";

export interface AuditRecord {
  code: AuditCode;
  lineageId: string;
  versionId: string;
  actorType: "user" | "system";
  actorId?: string | null;
  summary: string;
  before?: string | null;
  after?: string | null;
  at: string;
  // The LifecycleOperation that produced this event. Lets terminal publication
  // records (VERSION_ACTIVATED / VERSION_SUPERSEDED / the completed revision) be
  // written idempotently by both normal activation and forward reconciliation.
  operationId?: string | null;
}

export interface Mismatch {
  field: string;
  expected: unknown;
  actual: unknown;
  unitId?: string;
}

// --- Injected adapters -----------------------------------------------------

export class StaleSeqError extends Error {
  constructor(message = "lifecycle_seq moved under this operation") {
    super(message);
    this.name = "StaleSeqError";
  }
}

export interface PersistenceAdapter {
  getVersion(id: string): Promise<ResourceVersion | null>;
  listLineage(lineageId: string): Promise<ResourceVersion[]>;
  // Applies `patch` iff the row's current lifecycleSeq === expectedSeq, then
  // increments lifecycleSeq. Throws StaleSeqError otherwise. `patch` uses the
  // ResourceVersion field names; the adapter maps them to the concrete entity.
  writeVersion(
    id: string,
    patch: Partial<ResourceVersion>,
    expectedSeq: number,
  ): Promise<ResourceVersion>;
  // Creates a new inactive draft row cloned from `fromVersion` with the given
  // overrides already normalized by the engine. Returns the created row.
  createVersionRow(
    fromVersion: ResourceVersion,
    overrides: Partial<ResourceVersion>,
  ): Promise<ResourceVersion>;
  putOperation(op: LifecycleOperation): Promise<void>;
  getOperation(operationId: string): Promise<LifecycleOperation | null>;
  listOpenOperations(): Promise<LifecycleOperation[]>;
  lastCompletedOperation(
    lineageId: string,
    action: OpAction,
  ): Promise<LifecycleOperation | null>;
  appendRevision(rec: RevisionRecord): Promise<void>;
  appendAudit(rec: AuditRecord): Promise<void>;
  // Idempotency probes for terminal publication records, keyed on the
  // LifecycleOperation. Used so a reconcile retry cannot duplicate a
  // VERSION_ACTIVATED / VERSION_SUPERSEDED audit or the completed revision.
  auditExists(operationId: string, code: AuditCode): Promise<boolean>;
  revisionExists(operationId: string, versionId: string): Promise<boolean>;
  // Sets a durable marker on the lineage for the admin banner. No retrieval
  // effect (retrieval is gated only by unit-level staleness).
  markNeedsManualReconciliation(
    lineageId: string,
    reason: string,
  ): Promise<void>;
}

export interface IndexWorker {
  // Heavy: (re)generate every unit for this version. MUST stamp existing units
  // stale first and leave the new units stale=true (caller clears them).
  build(version: ResourceVersion): Promise<void>;
  // Light: update denormalized metadata on existing units. No generation.
  restamp(version: ResourceVersion): Promise<void>;
  // Delete every unit for this version.
  cleanup(version: ResourceVersion): Promise<void>;
  markStale(versionIds: string[]): Promise<void>;
  clearStale(versionId: string): Promise<void>;
  verifyStaleCleared(versionId: string): Promise<boolean>;
  // Verification inputs for the engine.
  fingerprint(version: ResourceVersion): Promise<string>;
  unitSetComplete(version: ResourceVersion): Promise<boolean>;
  // Every unit's denormalized projection vs the version's expected projection.
  projectionMismatches(version: ResourceVersion): Promise<Mismatch[]>;
  unitCount(versionId: string): Promise<number>;
}

export interface Authorizer {
  authorize(
    actor: { id?: string | null; role?: string | null } | null | undefined,
    action: OpAction | "read",
    version: ResourceVersion | null,
  ): { ok: true } | { ok: false; reason: string };
}

export interface Clock {
  now(): string; // ISO
  nowMs(): number;
}

export interface IdGen {
  operationId(): string;
}

export interface EngineResult {
  ok: boolean;
  operationId?: string;
  displayState?: LifecycleState;
  error?: string;
  reason?: string;
  noOp?: boolean;
  repaired?: boolean;
}
