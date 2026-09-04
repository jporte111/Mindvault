// Phase 9 P9-2 — shape a bounded set of KnowledgeHealthSnapshot rows (one exact
// client_scope) into per-dimension chronological series for a compact
// multi-period visual.
//
// Pure: no imports, no LLM, no embeddings, no randomness. NO INTERPOLATION — a
// month with no snapshot is simply absent from the points array; the caller
// renders a gap, never a synthesized value. No composite / health score.

import type { KnowledgeHealthSnapshotRow } from "./snapshotProjection.ts";

export interface TrendSeriesPoint {
  period_key: string;
  value: number;
}

export interface TrendSeries {
  key: string;
  points: TrendSeriesPoint[]; // chronological (oldest -> newest); only real rows
  min: number;
  max: number;
  first: number | null; // oldest value
  last: number | null; // newest value
}

// Leadership-relevant "lower is better" count dimensions (the P9-2 spec set).
export const TREND_SERIES_DIMENSIONS: (keyof KnowledgeHealthSnapshotRow)[] = [
  "processes_at_risk",
  "reviews_overdue",
  "active_not_verified",
  "gaps_open",
  "key_person_high_or_critical",
  "sources_needing_attention",
];

// Optional governance setup dimensions (kept to two to keep the UI simple).
export const TREND_SERIES_GOVERNANCE_DIMENSIONS: (keyof KnowledgeHealthSnapshotRow)[] = [
  "processes_without_owner_or_sme",
  "sources_needing_cadence",
];

export const TREND_SERIES_MAX_PERIODS = 12;

export function buildTrendSeries(
  rows: KnowledgeHealthSnapshotRow[] | null | undefined,
  dimensions: (keyof KnowledgeHealthSnapshotRow)[],
): TrendSeries[] {
  // Sort chronologically by period_key; 'YYYY-MM' sorts correctly as a string.
  const sorted = [...(rows || [])]
    .filter((r) => r && typeof r.period_key === "string")
    .sort((a, b) => (a.period_key < b.period_key ? -1 : a.period_key > b.period_key ? 1 : 0));

  return dimensions.map((key) => {
    const points: TrendSeriesPoint[] = [];
    for (const r of sorted) {
      const v = (r as any)[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        points.push({ period_key: r.period_key, value: v });
      }
    }
    const vals = points.map((p) => p.value);
    return {
      key: String(key),
      points,
      min: vals.length ? Math.min(...vals) : 0,
      max: vals.length ? Math.max(...vals) : 0,
      first: vals.length ? vals[0] : null,
      last: vals.length ? vals[vals.length - 1] : null,
    };
  });
}
