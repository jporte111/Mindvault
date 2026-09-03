// Phase 7 — ContinuityState. Consumes ONLY: coverageState, keyPersonLevel, the
// single pre-computed highestContinuityExposureSeverity rollup, and four setup
// booleans. It does NOT re-derive individual exposure predicates (F3) — the
// exposure model is the single deterministic source of those semantics.
//
// F4: coverageState === 'unknown' -> needs_setup. Never at_risk, never
// not_documented.

import type {
  ContinuityStateValue,
  CoverageState,
  ExposureSeverity,
  KeyPersonLevel,
} from "./types.ts";

export interface ContinuityStateInput {
  coverageState: CoverageState;
  keyPersonLevel: KeyPersonLevel;
  highestExposureSeverity: ExposureSeverity;
  ownerPresent: boolean;
  smePresent: boolean;
  criticalitySet: boolean;
  reviewCadenceResolved: boolean;
}

export function deriveContinuityState(x: ContinuityStateInput): ContinuityStateValue {
  // 1
  if (x.coverageState === "not_documented") return "not_documented";
  // 2
  if (x.coverageState === "needs_attention") return "at_risk";
  // 3
  if (x.keyPersonLevel === "high" || x.keyPersonLevel === "critical") return "at_risk";
  // 4
  if (x.highestExposureSeverity === "severe") return "at_risk";
  // 5 — F4
  if (x.coverageState === "unknown") return "needs_setup";
  // 6
  if (!x.ownerPresent || !x.smePresent || !x.criticalitySet || !x.reviewCadenceResolved) {
    return "needs_setup";
  }
  // 7
  return "ready";
}
