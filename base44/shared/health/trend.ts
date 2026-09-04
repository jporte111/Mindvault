// Phase 9 P9-1 — pure deterministic trend comparison between the current
// KnowledgeHealthSnapshot projection and the latest prior snapshot for the SAME
// client_scope.
//
// No composite score. No weighted score. No percentage score. Every dimension is
// reported independently as improving | stable | deteriorating | unknown, with
// its raw previous / current values. Missing prior, schema-version mismatch, a
// missing field, or an Unknown band on either side all yield 'unknown' — never a
// fabricated direction. Missed monthly periods are labelled by the actual prior
// period_key (periods_elapsed); nothing is interpolated.

import type { KnowledgeHealthSnapshotRow } from "./snapshotProjection.ts";

export type TrendDirection = "improving" | "stable" | "deteriorating" | "unknown";

export interface TrendDimension {
  direction: TrendDirection;
  previous: number | string | { covered: number; evaluable: number } | null;
  current: number | string | { covered: number; evaluable: number } | null;
}

export interface TrendResult {
  previous_period_key: string | null;
  periods_elapsed: number | null;
  comparable: boolean; // false => prior missing or schema mismatch; every dimension 'unknown'
  dimensions: Record<string, TrendDimension>;
}

// --- band ordinals (higher = healthier); Unknown => null => not comparable ---
const BAND_ORDINAL: Record<string, Record<string, number>> = {
  coverage_band: { Weak: 1, Partial: 2, Strong: 3 },
  currency_band: { Overdue: 1, Slipping: 2, Current: 3 },
  verification_band: { "Review backlog": 1, "Mostly confirmed": 2, Confirmed: 3 },
  key_person_resilience_band: { Exposed: 1, Watch: 2, Resilient: 3 },
};

const LOWER_IS_BETTER: (keyof KnowledgeHealthSnapshotRow)[] = [
  "critical_unknown",
  "reviews_overdue",
  "reviews_due_soon",
  "active_not_verified",
  "active_not_verified_critical",
  "gaps_open",
  "gaps_watching",
  "processes_at_risk",
  "key_person_high_or_critical",
  "concentration_people",
  "sources_needing_attention",
  "expired_active",
  "processes_without_owner_or_sme",
  "processes_needing_owner",
  "processes_needing_sme",
  "processes_needing_criticality",
  "sources_needing_cadence",
  "unlinked_sources",
  "unclassified_items",
  "legacy_needing_reindex",
];

const HIGHER_IS_BETTER: (keyof KnowledgeHealthSnapshotRow)[] = ["critical_covered"];

const COVERAGE_MIN_EVALUABLE = 3; // matches the Phase 7 snapshot.ts coverage-band guard

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function countDirection(prev: number | null, curr: number | null, lowerIsBetter: boolean): TrendDirection {
  if (prev === null || curr === null) return "unknown";
  if (prev === curr) return "stable";
  const improved = lowerIsBetter ? curr < prev : curr > prev;
  return improved ? "improving" : "deteriorating";
}

function bandDirection(key: string, prev: unknown, curr: unknown): TrendDirection {
  const table = BAND_ORDINAL[key] || {};
  const po = table[String(prev)] ?? null;
  const co = table[String(curr)] ?? null;
  if (po === null || co === null) return "unknown"; // Unknown on either side
  if (po === co) return "stable";
  return co > po ? "improving" : "deteriorating";
}

/** Months between two 'YYYY-MM' keys; null if either is unparseable. */
export function monthsBetween(fromKey: string, toKey: string): number | null {
  const parse = (k: string) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(k || ""));
    if (!m) return null;
    return Number(m[1]) * 12 + Number(m[2]);
  };
  const a = parse(fromKey);
  const b = parse(toKey);
  if (a === null || b === null) return null;
  return b - a;
}

export function computeTrend(
  current: KnowledgeHealthSnapshotRow,
  prior: KnowledgeHealthSnapshotRow | null | undefined,
): TrendResult {
  const dimensions: Record<string, TrendDimension> = {};

  const allUnknown = (): void => {
    for (const key of Object.keys(BAND_ORDINAL)) {
      dimensions[key] = { direction: "unknown", previous: null, current: (current as any)[key] ?? null };
    }
    for (const key of [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER]) {
      dimensions[key] = { direction: "unknown", previous: null, current: num((current as any)[key]) };
    }
    dimensions.critical_coverage_ratio = {
      direction: "unknown",
      previous: null,
      current: { covered: num(current.critical_covered) ?? 0, evaluable: num(current.critical_evaluable) ?? 0 },
    };
  };

  if (!prior) {
    allUnknown();
    return { previous_period_key: null, periods_elapsed: null, comparable: false, dimensions };
  }

  const periods_elapsed = monthsBetween(prior.period_key, current.period_key);

  if (prior.schema_version !== current.schema_version) {
    allUnknown();
    return { previous_period_key: prior.period_key, periods_elapsed, comparable: false, dimensions };
  }

  // Bands (ordinal).
  for (const key of Object.keys(BAND_ORDINAL)) {
    dimensions[key] = {
      direction: bandDirection(key, (prior as any)[key], (current as any)[key]),
      previous: (prior as any)[key] ?? null,
      current: (current as any)[key] ?? null,
    };
  }

  // Higher-is-better counts.
  for (const key of HIGHER_IS_BETTER) {
    const p = num((prior as any)[key]);
    const c = num((current as any)[key]);
    dimensions[key] = { direction: countDirection(p, c, false), previous: p, current: c };
  }

  // Lower-is-better counts.
  for (const key of LOWER_IS_BETTER) {
    const p = num((prior as any)[key]);
    const c = num((current as any)[key]);
    dimensions[key] = { direction: countDirection(p, c, true), previous: p, current: c };
  }

  // Derived coverage ratio: critical_covered / critical_evaluable.
  {
    const pe = num(prior.critical_evaluable);
    const ce = num(current.critical_evaluable);
    const pc = num(prior.critical_covered);
    const cc = num(current.critical_covered);
    const previous = { covered: pc ?? 0, evaluable: pe ?? 0 };
    const currentV = { covered: cc ?? 0, evaluable: ce ?? 0 };
    let direction: TrendDirection = "unknown";
    if (pe !== null && ce !== null && pc !== null && cc !== null && pe >= COVERAGE_MIN_EVALUABLE && ce >= COVERAGE_MIN_EVALUABLE) {
      const pr = pc / pe;
      const cr = cc / ce;
      direction = pr === cr ? "stable" : cr > pr ? "improving" : "deteriorating";
    }
    dimensions.critical_coverage_ratio = { direction, previous, current: currentV };
  }

  return { previous_period_key: prior.period_key, periods_elapsed, comparable: true, dimensions };
}
