// Phase 7 P7-B2 (corrected P7-D1) draft-stuck predicate — extracted in P8-3 so
// Phase 7 health (mindvaultHealth.ts) and Phase 8 notifications share ONE
// definition. Pure: no Base44 SDK, no UI, no embeddings, no LLM, no randomness.
//
// A row is stuck ONLY when ALL hold (age alone is never sufficient):
//   1. isOpenDraftCandidate() — the Phase 6 primitive: inactive, not archived,
//      not rejected, pre-publication workflow state, and NO newer active
//      version in its lineage. That lineage fact is what makes superseded
//      HISTORY safe — it can never be the open draft.
//   2. its row-local derived lifecycle state is draft / in_review /
//      changes_requested (never verified / active / archived / rejected).
//   3. it carries no COMPLETED review outcome (confirmed_current / updated /
//      archived) — only an absent outcome or 'changes_requested' is still open.
// 'changes_requested' is actionable immediately (its own Phase 7 queue kind);
// draft / in_review additionally require age >= DRAFT_STUCK_DAYS.

import {
  deriveLifecycleState,
  isOpenDraftCandidate,
} from "../lifecycle/stateMachine.ts";
import type { LifecycleState } from "../lifecycle/types.ts";

/** A draft revision open (or in review / changes-requested) at least this long
 *  is surfaced as stuck-draft work. Deterministic threshold. */
export const DRAFT_STUCK_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Normalized Phase 6 lifecycle view of a Training-like row. Field defaults are
 * the documented ones (is_active_version absent -> active; version absent -> 1).
 */
export function toLifecycleView(t: any) {
  return {
    id: t.id,
    isActiveVersion: t.is_active_version !== false,
    versionNumber: typeof t.version_number === "number" ? t.version_number : 1,
    isArchived: t.is_archived === true,
    verificationStatus: t.verification_status ?? "unverified",
    reviewOutcome: t.review_outcome ?? null,
    reviewRequestedAt: t.review_requested_at ?? null,
  };
}

export type StuckDraftKind = "draft_stuck" | "changes_requested" | null;

export interface StuckDraftAssessment {
  /** still-open, still-actionable current draft/review revision (gates 1-3 passed) */
  actionable: boolean;
  /** 'draft_stuck' past the threshold; 'changes_requested' immediately; null otherwise */
  kind: StuckDraftKind;
  state: LifecycleState;
  ageMs: number;
}

/** The ONE draft-stuck predicate — reused by Phase 7 health and Phase 8 notifications. */
export function assessStuckDraft(
  row: any,
  lineageRows: readonly any[],
  nowMs: number,
): StuckDraftAssessment {
  const v = toLifecycleView(row);
  const state = deriveLifecycleState(v);
  const lineage = (lineageRows && lineageRows.length ? lineageRows : [row]).map(toLifecycleView);
  if (!isOpenDraftCandidate(v, lineage)) {
    return { actionable: false, kind: null, state, ageMs: 0 };
  }
  if (state !== "draft" && state !== "in_review" && state !== "changes_requested") {
    return { actionable: false, kind: null, state, ageMs: 0 };
  }
  if (row.review_outcome && row.review_outcome !== "changes_requested") {
    return { actionable: false, kind: null, state, ageMs: 0 }; // completed review
  }
  const ref = row.review_requested_at || row.created_date;
  const ageMs = ref ? Math.max(0, nowMs - Date.parse(ref)) : 0;
  if (state === "changes_requested") {
    return { actionable: true, kind: "changes_requested", state, ageMs };
  }
  if (ageMs >= DRAFT_STUCK_DAYS * DAY_MS) {
    return { actionable: true, kind: "draft_stuck", state, ageMs };
  }
  return { actionable: true, kind: null, state, ageMs };
}