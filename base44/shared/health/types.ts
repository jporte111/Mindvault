// Operational Continuity / Knowledge Health — pure primitive types (Phase 7).
//
// This directory (base44/shared/health/) is a REUSABLE primitive layer:
//   - NO Base44 SDK, NO UI, NO embeddings, NO LLM, NO randomness, NO Deno APIs.
//   - Every value is a deterministic function of governed entity fields.
//
// MindVault-specific aggregation (scoped list reads, GAS definition, name
// resolution, the bounded legacy KnowledgeChunk existence lookup) lives in the
// binding: base44/shared/mindvaultHealth.ts + the computeKnowledgeHealth function.

// --- Index / coverage -----------------------------------------------------

export type IndexState =
  | "indexed"
  | "failed"
  | "pending"
  | "indexing"
  | "skipped"
  | "absent" // legacy: absence of chunks PROVEN
  | "unresolved"; // legacy: chunk existence could NOT be established

export type CoverageState =
  | "documented_verified"
  | "documented_unverified"
  | "needs_attention"
  | "unknown"
  | "not_documented";

// A legacy source's chunk-existence answer: true / false / undefined.
export type LegacyChunkAnswer = boolean | undefined;

export interface HealthSourceLike {
  id: string;
  index_status?: string | null;
  knowledge_scope?: string | null;
  is_active_version?: boolean;
  is_archived?: boolean;
  verification_status?: string | null;
  status?: string | null;
  effective_from?: string | null;
  effective_until?: string | null;
}

// --- Freshness ----------------------------------------------------------

export type FreshnessState = "current" | "due_soon" | "overdue" | "unknown";

// --- Continuity exposure ----------------------------------------------

export type ExposureSeverity = "none" | "info" | "moderate" | "severe";

export type ExposureKind =
  | "source_failure"
  | "undocumented_critical"
  | "unverified_docs_critical"
  | "overdue_review_mission_critical"
  | "overdue_review_critical"
  | "legacy_coverage_unresolved"
  | "open_gaps_critical"
  | "missing_owner"
  | "missing_sme"
  | "open_gaps"
  | "overdue_review"
  | "criticality_unset"
  | "missing_review_cadence";

export interface ContinuityExposure {
  kind: ExposureKind;
  severity: ExposureSeverity;
}

// --- Key-person dependency ------------------------------------------

export type KeyPersonLevel =
  | "none"
  | "informational"
  | "elevated"
  | "high"
  | "critical"
  | "unknown";

export type KeyPersonDriver =
  | "sole_sme_no_backup"
  | "owner_is_sole_sme"
  | "gaps_funnel_to_sole_sme"
  | "expertise_concentration";

export interface KeyPersonPerson {
  userId: string;
  role: "sole_sme" | "owner_sme";
}

export interface KeyPersonResult {
  level: KeyPersonLevel;
  drivers: KeyPersonDriver[];
  persons: KeyPersonPerson[];
  amplified: boolean;
}

export interface ConcentrationFinding {
  userId: string;
  level: "high" | "critical";
  criticalProcessIds: string[];
}

// --- Continuity state ---------------------------------------------

export type ContinuityStateValue =
  | "not_documented"
  | "at_risk"
  | "needs_setup"
  | "ready";

// --- Snapshot bands ---------------------------------------------

export type CoverageBand = "Strong" | "Partial" | "Weak" | "Unknown";
export type CurrencyBand = "Current" | "Slipping" | "Overdue" | "Unknown";
export type VerificationBand =
  | "Confirmed"
  | "Mostly confirmed"
  | "Review backlog"
  | "Unknown";
export type KeyPersonResilienceBand = "Resilient" | "Watch" | "Exposed";

// --- Review queue ---------------------------------------------

export type QueueItemKind =
  | "source_failure"
  | "not_documented"
  | "key_person_dependency"
  | "active_not_verified"
  | "promoted_gap"
  | "legacy_coverage_unresolved"
  | "overdue_review"
  | "missing_owner_sme"
  | "no_review_cadence"
  | "changes_requested"
  | "draft_stuck"
  | "awaiting_employee"
  | "expired_active"
  | "open_gap"
  | "other_setup";

export interface QueueItemInput {
  id: string;
  kind: QueueItemKind;
  criticality?: string | null;
  ageMs: number;
  processId?: string | null;
  title: string;
  // Optional routing hints carried by the MindVault binding. The primitive
  // prioritizer ignores them; they only travel through to the payload so the
  // dashboard can offer a "what to do next" link into an existing workflow.
  sourceId?: string | null;
  department?: string | null;
}
