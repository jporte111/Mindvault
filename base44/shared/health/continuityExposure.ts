// Phase 7 — Continuity Exposure (F3 + F4). GENERAL continuity risk, kept
// separate from actual key-person dependency. Feeds ContinuityState (via the
// single `highestContinuityExposureSeverity` rollup) and the Review Queue.
//
// F4: an `unknown` CoverageState produces at most `moderate` here — it never
// independently drives `at_risk`.

import type {
  ContinuityExposure,
  CoverageState,
  ExposureSeverity,
  FreshnessState,
} from "./types.ts";

const SEV_ORDER: Record<ExposureSeverity, number> = {
  none: 0,
  info: 1,
  moderate: 2,
  severe: 3,
};

/** none < info < moderate < severe. Empty -> "none". */
export function highestContinuityExposureSeverity(
  exposures: ContinuityExposure[],
): ExposureSeverity {
  let max: ExposureSeverity = "none";
  for (const e of exposures || []) {
    if (SEV_ORDER[e.severity] > SEV_ORDER[max]) max = e.severity;
  }
  return max;
}

export interface ContinuityExposureInput {
  criticality?: string | null; // 'low' | 'medium' | 'high' | 'mission_critical' | undefined
  coverageState: CoverageState;
  // worst freshness across USABLE sources only (F4). '' / 'unknown' when none.
  worstUsableFreshness: FreshnessState;
  ownerPresent: boolean;
  smePresent: boolean;
  openGapCount: number;
  hasPromotedGap: boolean;
  reviewCadenceResolved: boolean;
}

export function assessContinuityExposure(
  x: ContinuityExposureInput,
): ContinuityExposure[] {
  const out: ContinuityExposure[] = [];
  const critical = x.criticality === "high" || x.criticality === "mission_critical";
  const mc = x.criticality === "mission_critical";
  const push = (kind: ContinuityExposure["kind"], severity: ExposureSeverity) =>
    out.push({ kind, severity });

  if (x.coverageState === "needs_attention") push("source_failure", "severe");
  if (x.coverageState === "not_documented" && critical) {
    push("undocumented_critical", "severe");
  }
  if (x.coverageState === "documented_unverified" && critical) {
    push("unverified_docs_critical", "severe");
  }
  // F4: unknown coverage is a confirmation task, never severe.
  if (x.coverageState === "unknown") {
    push("legacy_coverage_unresolved", critical ? "moderate" : "info");
  }

  if (x.worstUsableFreshness === "overdue") {
    if (mc) push("overdue_review_mission_critical", "severe");
    else if (x.criticality === "high") push("overdue_review_critical", "moderate");
    else push("overdue_review", "info");
  }

  if (x.openGapCount >= 1) {
    if (critical) {
      push("open_gaps_critical", x.hasPromotedGap ? "severe" : "moderate");
    } else {
      push("open_gaps", "info");
    }
  }

  if (!x.ownerPresent) push("missing_owner", "moderate");
  if (!x.smePresent) push("missing_sme", "moderate");
  if (!x.criticality) push("criticality_unset", "info");
  if (!x.reviewCadenceResolved) push("missing_review_cadence", "info");

  return out;
}
