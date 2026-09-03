// Phase 7 — deterministic review freshness. Date math only. No AI, no answer-
// path effect. "Overdue" means "due for a review", NOT "incorrect".

import type { FreshnessState } from "./types.ts";

const DAY_MS = 86_400_000;

/** Grace window before next_review_due: min(14d, 20% of the interval). */
export function defaultGraceMs(intervalDays: number): number {
  return Math.min(14 * DAY_MS, Math.max(0, intervalDays) * 0.2 * DAY_MS);
}

/** Per-source cadence: source override, else linked process interval, else none. */
export function resolveReviewInterval(
  sourceIntervalDays: number | null | undefined,
  processIntervalDays: number | null | undefined,
): number | null {
  if (typeof sourceIntervalDays === "number" && sourceIntervalDays > 0) {
    return sourceIntervalDays;
  }
  if (typeof processIntervalDays === "number" && processIntervalDays > 0) {
    return processIntervalDays;
  }
  return null;
}

export function computeFreshness(
  nextReviewDueAt: string | null | undefined,
  intervalDays: number | null | undefined,
  nowMs: number,
  graceMs: (intervalDays: number) => number = defaultGraceMs,
): FreshnessState {
  if (!nextReviewDueAt || !intervalDays || intervalDays <= 0) return "unknown";
  const due = Date.parse(nextReviewDueAt);
  if (Number.isNaN(due)) return "unknown";
  if (nowMs >= due) return "overdue";
  if (nowMs >= due - graceMs(intervalDays)) return "due_soon";
  return "current";
}

const WORST_ORDER: Record<FreshnessState, number> = {
  unknown: 0,
  current: 1,
  due_soon: 2,
  overdue: 3,
};

/**
 * The "worst" freshness across a set. Per F4 the binding passes ONLY the
 * freshness of USABLE sources (indexed, effective, governed-active) — an
 * unresolved / not-yet-indexed source's cadence says nothing about continuity.
 * Empty input -> "unknown".
 */
export function worstFreshness(states: FreshnessState[]): FreshnessState {
  let worst: FreshnessState = "unknown";
  for (const s of states || []) {
    if (WORST_ORDER[s] > WORST_ORDER[worst]) worst = s;
  }
  return worst;
}

export function bucketFreshness(
  items: Array<{ nextReviewDueAt?: string | null; intervalDays?: number | null }>,
  nowMs: number,
): { current: number; due_soon: number; overdue: number; unknown: number } {
  const out = { current: 0, due_soon: 0, overdue: 0, unknown: 0 };
  for (const it of items || []) {
    out[computeFreshness(it.nextReviewDueAt, it.intervalDays, nowMs)]++;
  }
  return out;
}
