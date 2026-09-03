// Governed-lifecycle engine — index correctness checks.
//
// SAFETY (not configurable):
//   - Content-hash equality proves CONTENT IDENTITY ONLY. A no-op additionally
//     requires a complete unit set AND a clean denormalized projection.
//   - If the fingerprint matches but the unit set is incomplete or the
//     projection is dirty, the caller must repair (restamp / targeted rebuild)
//     and re-verify before returning success — never a bare no-op.

import type { Mismatch } from "./types.ts";

export interface NoOpInputs {
  fingerprintMatches: boolean;
  unitSetComplete: boolean;
  mismatches: Mismatch[];
}

/** The [F2] three-part test. All three must hold. */
export function isIndexNoOp(x: NoOpInputs): boolean {
  return x.fingerprintMatches && x.unitSetComplete && x.mismatches.length === 0;
}

export type ReindexPlan = "no_op" | "restamp_repair" | "full_rebuild";

/**
 * Given the three signals, what must a reindex do?
 *   - all clean                         -> no_op
 *   - content identical, only metadata
 *     drifted / units complete          -> restamp_repair
 *   - content changed OR units missing  -> full_rebuild
 * Every non-no_op path ends with a verification step (enforced in engine.ts).
 */
export function planReindex(x: NoOpInputs): ReindexPlan {
  if (isIndexNoOp(x)) return "no_op";
  if (x.fingerprintMatches && x.unitSetComplete) return "restamp_repair";
  return "full_rebuild";
}

/**
 * Compare a version's expected denormalized projection against what each unit
 * actually carries. Pure — the caller (or the IndexWorker) gathers the unit
 * projections. Returns one Mismatch per (unit, field) disagreement.
 */
export function assertResourceMatchesIndex(
  expected: Record<string, unknown>,
  unitProjections: Array<{ unitId?: string; projection: Record<string, unknown> }>,
): Mismatch[] {
  const out: Mismatch[] = [];
  const keys = Object.keys(expected);
  for (const u of unitProjections) {
    for (const k of keys) {
      const want = normalize(expected[k]);
      const got = normalize(u.projection[k]);
      if (want !== got) {
        out.push({ field: k, expected: expected[k], actual: u.projection[k], unitId: u.unitId });
      }
    }
  }
  return out;
}

function normalize(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
