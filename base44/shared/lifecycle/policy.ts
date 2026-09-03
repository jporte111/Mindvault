// Governed-lifecycle engine — policy knobs.
//
// The ONLY configurable surface: presentation labels live in presentation.ts;
// this file is the small set of behavioural tunables MindVault needs. Policy may
// NARROW the transition graph (forbid an action) and adjust timing/heuristics —
// it can never relax a safety invariant (see stateMachine.ts / engine.ts).

import type { LifecycleTransition } from "./types.ts";

export interface LifecyclePolicy {
  // Publish (activate) requires the target draft to be verificationStatus
  // 'verified'. Always true for MindVault; an explicit per-call force flag is
  // the only bypass and is itself gated by allowForceUnverifiedPublish.
  requireVerifiedToPublish: boolean;
  allowForceUnverifiedPublish: boolean;
  // Transitions removed from the graph entirely (e.g. a deployment that never
  // allows 'restore'). Cannot ADD transitions.
  disallowTransitions: LifecycleTransition[];
  // ms before an in-flight operation is considered stuck and eligible for
  // reconcile resume/compensation.
  stuckAfterMs: number;
  // How many times reconcile will resume/compensate one operation before it
  // gives up, stale-marks the whole lineage, and flags manual reconciliation.
  reconcileMaxAttempts: number;
  // Review-cadence grace: how long before next_review_due the state flips to
  // 'due_soon'. Pure function of the interval; no global hard-coded literal in
  // engine logic.
  gracePolicyMs: (intervalDays: number) => number;
  // Whether a single "Approve & Publish" call is offered as one step (a UI
  // convenience that still runs verify then activate as separate primitives).
  combinedApproveAndPublish: boolean;
}

const DAY_MS = 86_400_000;

export const DEFAULT_POLICY: LifecyclePolicy = {
  requireVerifiedToPublish: true,
  allowForceUnverifiedPublish: false,
  disallowTransitions: [],
  stuckAfterMs: 15 * 60_000,
  reconcileMaxAttempts: 3,
  gracePolicyMs: (intervalDays: number) =>
    Math.min(14 * DAY_MS, Math.max(0, intervalDays) * 0.2 * DAY_MS),
  combinedApproveAndPublish: true,
};

// Deterministic freshness from dates alone — no AI, no answer-path effect.
export type FreshnessState = "current" | "due_soon" | "overdue" | "unknown";

export function computeFreshness(
  nextReviewDueAt: string | null | undefined,
  intervalDays: number | null | undefined,
  nowMs: number,
  policy: LifecyclePolicy = DEFAULT_POLICY,
): FreshnessState {
  if (!nextReviewDueAt || !intervalDays || intervalDays <= 0) return "unknown";
  const due = Date.parse(nextReviewDueAt);
  if (Number.isNaN(due)) return "unknown";
  if (nowMs >= due) return "overdue";
  if (nowMs >= due - policy.gracePolicyMs(intervalDays)) return "due_soon";
  return "current";
}
