// Phase 7 — Continuity Snapshot: FOUR independent named dimensions. There is NO
// overall / composite / 0-100 score, and no function that combines the bands.

import type {
  CoverageBand,
  CurrencyBand,
  KeyPersonResilienceBand,
  VerificationBand,
} from "./types.ts";

// --- Coverage (F4: unknown critical coverage excluded from num & denom;
//     completeness guard so a legacy-heavy tenant cannot show "Strong") -------

export interface CoverageBandInput {
  evaluableCritical: number; // in-scope critical processes with CoverageState !== 'unknown'
  coveredCritical: number; // of evaluable, CoverageState === 'documented_verified'
  inScopeCritical: number; // ALL in-scope critical processes
  unknownCritical: number; // in-scope critical with CoverageState === 'unknown'
}

export const COVERAGE_UNKNOWN_RATIO_GUARD = 0.25; // deterministic product constant

export function coverageBand(x: CoverageBandInput): CoverageBand {
  if (x.evaluableCritical < 3) return "Unknown";
  if (
    x.inScopeCritical > 0 &&
    x.unknownCritical / x.inScopeCritical > COVERAGE_UNKNOWN_RATIO_GUARD
  ) {
    return "Unknown";
  }
  const pct = (x.coveredCritical / x.evaluableCritical) * 100;
  if (pct >= 90) return "Strong";
  if (pct >= 60) return "Partial";
  return "Weak";
}

// --- Currency ---------------------------------------------------------

export interface CurrencyBandInput {
  scheduledCount: number; // GAS sources with a resolvable review cadence
  overdueCount: number; // of those, freshness === 'overdue'
}

export function currencyBand(x: CurrencyBandInput): CurrencyBand {
  if (x.scheduledCount < 5) return "Unknown";
  const pct = (x.overdueCount / x.scheduledCount) * 100;
  if (pct === 0) return "Current";
  if (pct <= 15) return "Slipping";
  return "Overdue";
}

// --- Verification (F3: zero verified is KNOWN data -> Review backlog, not
//     Unknown; Unknown only for an insufficient active-source population) -----

export interface VerificationBandInput {
  gasCount: number; // governed-active source population
  verifiedCount: number; // of those, verification_status === 'verified'
}

export function verificationBand(x: VerificationBandInput): VerificationBand {
  if (x.gasCount < 5) return "Unknown";
  const pct = (x.verifiedCount / x.gasCount) * 100;
  if (pct >= 90) return "Confirmed";
  if (pct >= 60) return "Mostly confirmed";
  return "Review backlog";
}

// --- Key-person resilience (ONLY actual key-person dependency findings) -----

export interface KeyPersonResilienceBandInput {
  highOrCriticalKeyPersonProcesses: number; // M6
}

export function keyPersonResilienceBand(
  x: KeyPersonResilienceBandInput,
): KeyPersonResilienceBand {
  const n = x.highOrCriticalKeyPersonProcesses;
  if (n === 0) return "Resilient";
  if (n <= 2) return "Watch";
  return "Exposed";
}
