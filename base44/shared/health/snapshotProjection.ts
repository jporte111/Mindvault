// Phase 9 P9-1 — pure projection of the Phase 7 current-health payload into the
// minimal KnowledgeHealthSnapshot aggregate row.
//
// It ONLY reads fields the Phase 7 computeKnowledgeHealth payload already
// computed. It NEVER re-derives a health semantic, reads an entity, calls an
// LLM / embeddings, or touches randomness. `processes_total` / `processes_at_risk`
// are plain counts over the payload's own processRows — not a recalculation of
// continuity state.
//
// Output carries NO person data: no client_id, no user ids, no reporter data,
// no names, no titles, no raw questions. Only counts and enum bands.

/** Bump when the projected field set changes; computeTrend refuses to compare across a mismatch. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotMeta {
  period_key: string; // 'YYYY-MM'
  schema_version?: number;
}

export interface KnowledgeHealthSnapshotRow {
  period_key: string;
  client_scope: string; // 'general' | 'client:<id>'
  schema_version: number;

  coverage_band: string;
  currency_band: string;
  verification_band: string;
  key_person_resilience_band: string;

  critical_covered: number;
  critical_evaluable: number;
  critical_unknown: number;

  reviews_overdue: number;
  reviews_due_soon: number;

  active_not_verified: number;
  active_not_verified_critical: number;

  gaps_open: number;
  gaps_watching: number;

  processes_total: number;
  processes_at_risk: number;
  key_person_high_or_critical: number;
  concentration_people: number;

  sources_needing_attention: number;
  expired_active: number;

  processes_without_owner_or_sme: number;

  processes_needing_owner: number;
  processes_needing_sme: number;
  processes_needing_criticality: number;
  sources_needing_cadence: number;
  unlinked_sources: number;
  unclassified_items: number;
  legacy_needing_reindex: number;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Canonical scope string, derived from the payload's own scope — never a caller value. */
export function clientScopeOf(payload: any): string {
  const s = payload?.scope;
  return s && s.kind === "client" && s.clientId ? `client:${s.clientId}` : "general";
}

export function snapshotFromHealthPayload(
  payload: any,
  meta: SnapshotMeta,
): KnowledgeHealthSnapshotRow {
  const snap = payload?.snapshot ?? {};
  const m = payload?.metrics ?? {};
  const setup = payload?.setup ?? {};
  const rows: any[] = Array.isArray(payload?.processRows) ? payload.processRows : [];

  return {
    period_key: meta.period_key,
    client_scope: clientScopeOf(payload),
    schema_version: meta.schema_version ?? SNAPSHOT_SCHEMA_VERSION,

    coverage_band: String(snap?.coverage?.band ?? "Unknown"),
    currency_band: String(snap?.currency?.band ?? "Unknown"),
    verification_band: String(snap?.verification?.band ?? "Unknown"),
    key_person_resilience_band: String(snap?.keyPersonResilience?.band ?? "Resilient"),

    critical_covered: n(m?.criticalCoverage?.covered),
    critical_evaluable: n(m?.criticalCoverage?.evaluable),
    critical_unknown: n(m?.criticalCoverage?.unknown),

    reviews_overdue: n(m?.knowledgeNeedingReview?.overdue),
    reviews_due_soon: n(m?.knowledgeNeedingReview?.due_soon),

    active_not_verified: n(m?.activeNotVerified?.total),
    active_not_verified_critical: n(m?.activeNotVerified?.criticalLinked),

    gaps_open: n(m?.openGaps?.open),
    gaps_watching: n(m?.openGaps?.watching),

    processes_total: rows.length,
    processes_at_risk: rows.filter((r) => r?.continuityState === "at_risk").length,
    key_person_high_or_critical: n(m?.keyPersonDependencyRisk?.processes),
    concentration_people: n(m?.keyPersonDependencyRisk?.concentrationPeople),

    sources_needing_attention: n(m?.sourcesNeedingAttention),
    expired_active: n(m?.effectiveDateExposure?.expiredActive),

    processes_without_owner_or_sme: n(m?.processesWithoutOwnerOrSme),

    processes_needing_owner: n(setup?.processesNeedingOwner),
    processes_needing_sme: n(setup?.processesNeedingSme),
    processes_needing_criticality: n(setup?.processesNeedingCriticality),
    sources_needing_cadence: n(setup?.sourcesNeedingCadence),
    unlinked_sources: n(setup?.unlinkedSources),
    unclassified_items: n(setup?.unclassifiedItems),
    legacy_needing_reindex: n(setup?.legacyNeedingReindex),
  };
}
