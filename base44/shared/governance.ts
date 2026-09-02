// Pure helpers for the Phase 3 lifecycle gate and governance denormalization
// performed by embedKnowledge. NO Base44 client, NO network, NO Deno-only
// APIs, NO cross-module imports — so the eval harness can exercise them under
// Node against in-memory fixtures.
//
// Retrieval-time governance (base44/shared/retrieval.ts) reads the denormalized
// COPY these helpers stamp onto each chunk — never a live Training /
// OperationalProcess join. The consequence, enforced as a Phase 6 invariant:
// any workflow that changes a source's verification / active-version /
// archive / effective-date state must trigger the matching embedKnowledge
// re-index or chunk cleanup atomically, so the copies never lag the source.

export interface SourceLike {
  is_active_version?: boolean;
  verification_status?: string;
  is_archived?: boolean;
  source_authority?: string;
  ingestion_quality?: string;
  effective_from?: string;
  effective_until?: string;
  version_number?: number;
  operational_process_id?: string;
  department?: string;
}

/**
 * Why embedKnowledge must build NO chunks for this source (and delete any that
 * linger), or null if it is indexable. First match wins, severity order.
 *
 *   is_active_version === false        -> "superseded"
 *   verification_status === 'rejected' -> "rejected"
 *   is_archived === true               -> "archived"
 *
 * `ingestion_quality === 'needs_review'` is deliberately NOT here — it is a
 * retrieval-time flag only, so a later review can make the source retrievable
 * without a re-index.
 */
export function lifecycleSkipReason(
  src: SourceLike,
): "superseded" | "rejected" | "archived" | null {
  if (src.is_active_version === false) return "superseded";
  if (src.verification_status === "rejected") return "rejected";
  if (src.is_archived === true) return "archived";
  return null;
}

/**
 * Governance metadata denormalized onto every KnowledgeChunk at index time.
 * `undefined` means "leave the chunk field unset": missing is pass/neutral at
 * retrieval time, so a legacy source with none of these set produces an
 * all-undefined object and its chunks are unaffected.
 */
export function buildGovFields(
  src: SourceLike,
  processFreshnessStatus?: string | null,
): Record<string, unknown> {
  return {
    source_authority: src.source_authority || undefined,
    verification_status: src.verification_status || undefined,
    ingestion_quality: src.ingestion_quality || undefined,
    is_active_version: src.is_active_version === false ? false : undefined,
    effective_from: src.effective_from || undefined,
    effective_until: src.effective_until || undefined,
    source_is_archived: src.is_archived === true ? true : undefined,
    version_number: typeof src.version_number === "number" ? src.version_number : undefined,
    operational_process_id: src.operational_process_id || undefined,
    department: src.department || undefined,
    process_freshness_status: processFreshnessStatus || undefined,
  };
}
