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
  id?: string;
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
  // Phase 6: denormalized for lineage grouping in history / health views only.
  root_source_id?: string;
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
    // Phase 6: lineage grouping only. NOT index_stale — that flag is managed
    // explicitly by embedKnowledge's mark_stale / clear_stale / build_staged
    // sub-commands so a legacy full reindex never leaves chunks dark.
    root_source_id: src.root_source_id || src.id || undefined,
  };
}

// --- Scope denormalization (embedKnowledge -> KnowledgeChunk) ---------------
//
// The RAG scope gate reads ONLY each chunk's last-indexed knowledge_scope /
// client_id copy. These helpers build that copy from the SOURCE Training
// record and re-stamp drifted chunks, so the source of truth is always the
// Training entity and never the derived chunk rows. Pure — the eval harness
// exercises them directly.

export interface ScopeSourceLike {
  knowledge_scope?: string;
  client_id?: string | null;
  title?: string;
  topic_category?: string;
  category?: string;
  client_segment?: string;
}

/**
 * Scope fields stamped onto every chunk built from this source. `client_id` is
 * set ONLY for client-specific sources; `undefined` elsewhere means "leave the
 * chunk field unset". Missing scope falls back to "unclassified" — which
 * embedKnowledge refuses to index, and retrieval drops in every context.
 */
export function buildScopeFields(src: ScopeSourceLike): {
  knowledge_scope: string;
  client_id: string | null | undefined;
  title: string;
  topic_category: string;
  client_segment: string;
} {
  const scope = src.knowledge_scope || "unclassified";
  return {
    knowledge_scope: scope,
    client_id: scope === "client-specific" ? src.client_id : undefined,
    title: src.title || "",
    topic_category: src.topic_category || src.category || "",
    client_segment: src.client_segment || "",
  };
}

/**
 * Fields that drifted between an existing (reused) chunk and what a re-index
 * of the same content should carry now. Returns {} when the chunk is already
 * correctly stamped (idempotent re-index writes nothing). A client-specific
 * chunk whose client_id was lost/blanked is re-stamped with the source's
 * client_id — never nulled — and a general chunk holding a stale client_id
 * has it cleared.
 */
export function scopeFieldsDrift(
  chunk: Record<string, unknown>,
  scopeFields: ReturnType<typeof buildScopeFields>,
  chunkIndex: number,
): Record<string, unknown> {
  const drift: Record<string, unknown> = {};
  if ((chunk.knowledge_scope || "") !== scopeFields.knowledge_scope) {
    drift.knowledge_scope = scopeFields.knowledge_scope;
  }
  if ((chunk.client_id || undefined) !== scopeFields.client_id) {
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