// Phase 7 — Review Queue prioritization. Deterministic ordering. Authority plays
// no role. "Thin" is not a reason.
//
// Critical-process kind order (F4 places legacy_coverage_unresolved at rank 6):
//   1 source_failure
//   2 not_documented (proven)
//   3 key_person_dependency (high/critical)
//   4 active_not_verified
//   5 promoted_gap
//   6 legacy_coverage_unresolved
//   7 overdue_review
//   8 missing_owner_sme
//   9 other setup (no_review_cadence / open_gap / changes_requested / draft_stuck / awaiting_employee / expired_active)
//  10 other_setup
// then repeat by lower criticality tier.

import type { QueueItemInput, QueueItemKind } from "./types.ts";

const KIND_RANK: Record<QueueItemKind, number> = {
  source_failure: 1,
  not_documented: 2,
  key_person_dependency: 3,
  active_not_verified: 4,
  promoted_gap: 5,
  legacy_coverage_unresolved: 6,
  overdue_review: 7,
  missing_owner_sme: 8,
  no_review_cadence: 9,
  open_gap: 9,
  changes_requested: 9,
  draft_stuck: 9,
  awaiting_employee: 9,
  expired_active: 9,
  other_setup: 10,
};

function criticalityTier(c?: string | null): number {
  if (c === "mission_critical") return 0;
  if (c === "high") return 1;
  if (c === "medium") return 2;
  if (c === "low") return 3;
  return 4; // unset
}

export function queueSortKey(item: QueueItemInput): number {
  return criticalityTier(item.criticality) * 100 + KIND_RANK[item.kind];
}

/** Deterministic: by (criticality tier, kind rank), then oldest first. */
export function prioritizeQueue(items: QueueItemInput[]): QueueItemInput[] {
  return [...(items || [])].sort((a, b) => {
    const ka = queueSortKey(a);
    const kb = queueSortKey(b);
    if (ka !== kb) return ka - kb;
    if (b.ageMs !== a.ageMs) return b.ageMs - a.ageMs; // larger age (older) first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable final tiebreak
  });
}

/** Overview "Address first" — the top N of the prioritized queue. */
export function topAddressFirst(items: QueueItemInput[], n = 10): QueueItemInput[] {
  return prioritizeQueue(items).slice(0, n);
}
