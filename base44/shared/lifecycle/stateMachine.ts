// Governed-lifecycle engine — the per-version state machine.
//
// SAFETY (not configurable):
//   - deriveLifecycleState reads a version's OWN fields only. Lineage facts
//     (superseded, has-open-draft, latest-version) are computed elsewhere for
//     display and never feed this.
//   - Every legal transition normalizes the incompatible backing fields in the
//     same write so a stale field can never make deriveLifecycleState return the
//     prior state.
//   - Policy may narrow the transition graph; it can never widen it.

import type {
  LifecyclePolicy,
} from "./policy.ts";
import type {
  LifecycleState,
  LifecycleTransition,
  ResourceVersion,
} from "./types.ts";

/** Row-local derivation. Order matters; first match wins. */
export function deriveLifecycleState(
  v: Pick<
    ResourceVersion,
    | "isArchived"
    | "verificationStatus"
    | "isActiveVersion"
    | "reviewOutcome"
    | "reviewRequestedAt"
  >,
): LifecycleState {
  if (v.isArchived === true) return "archived";
  if (v.verificationStatus === "rejected") return "rejected";
  if (v.isActiveVersion === true) return "active";
  if (v.reviewOutcome === "changes_requested") return "changes_requested";
  if (v.verificationStatus === "verified") return "verified";
  if (v.reviewRequestedAt) return "in_review";
  return "draft";
}

// From-state -> allowed transitions. `set_metadata` and `confirm_current` are
// only legal on the active version; `create_version` is legal on the active
// version (it forks a new draft, leaving the active row untouched).
const GRAPH: Record<LifecycleState, LifecycleTransition[]> = {
  draft: ["submit", "verify", "reject", "set_metadata", "archive"],
  in_review: ["request_changes", "verify", "reject", "set_metadata"],
  changes_requested: ["submit", "verify", "reject", "set_metadata"],
  verified: ["activate", "reject", "archive", "set_metadata", "submit"],
  active: [
    "create_version",
    "set_metadata",
    "confirm_current",
    "archive",
  ],
  archived: ["restore"],
  rejected: ["un_reject"],
};

export function legalTransitions(
  from: LifecycleState,
  policy: LifecyclePolicy,
): LifecycleTransition[] {
  const disallow = new Set(policy.disallowTransitions);
  return (GRAPH[from] || []).filter((t) => !disallow.has(t));
}

export function assertTransitionLegal(
  from: LifecycleState,
  transition: LifecycleTransition,
  policy: LifecyclePolicy,
): { ok: true } | { ok: false; reason: string } {
  if (policy.disallowTransitions.includes(transition)) {
    return { ok: false, reason: `transition '${transition}' is disabled by policy` };
  }
  if (!(GRAPH[from] || []).includes(transition)) {
    return {
      ok: false,
      reason: `illegal transition '${transition}' from state '${from}'`,
    };
  }
  return { ok: true };
}

export interface NormalizeContext {
  now: string;
  actorId?: string | null;
  note?: string | null;
}

/**
 * The [F3] field-normalization table, as a pure function. Returns the FULL set
 * of field writes for the transition — the primary change plus every
 * incompatible state-driving field cleared/reset — so deriveLifecycleState on
 * the result returns the intended new state and never the prior one.
 *
 * `create_version` is not here: the new draft row's normalized starting fields
 * are produced by newDraftFields().
 */
export function normalizeForTransition(
  transition: LifecycleTransition,
  ctx: NormalizeContext,
): Partial<ResourceVersion> {
  switch (transition) {
    case "submit":
      return {
        reviewRequestedAt: ctx.now,
        reviewOutcome: null,
      };
    case "request_changes":
      return {
        reviewOutcome: "changes_requested",
      };
    case "verify":
      return {
        verificationStatus: "verified",
        reviewOutcome: null,
      };
    case "reject":
      return {
        verificationStatus: "rejected",
        reviewRequestedAt: null,
        reviewOutcome: null,
      };
    case "un_reject":
      // Establish the intended in_review state explicitly.
      return {
        verificationStatus: "unverified",
        reviewRequestedAt: ctx.now,
        reviewOutcome: null,
      };
    case "activate":
      // The promoted row; the demoted row is normalized by demoteFields().
      return {
        isActiveVersion: true,
        reviewOutcome: "confirmed_current",
      };
    case "archive":
      return {
        isArchived: true,
        reviewOutcome: "archived",
      };
    case "restore":
      return {
        isArchived: false,
        reviewRequestedAt: null,
        reviewOutcome: null,
      };
    case "confirm_current":
      return {
        reviewOutcome: "confirmed_current",
        reviewRequestedAt: null,
      };
    case "set_metadata":
      return {}; // metadata patch is supplied by the caller; no review-field change
    case "create_version":
      return {};
    default:
      return {};
  }
}

/** Normalized starting fields for a freshly forked draft (version N+1). */
export function newDraftFields(now: string): Partial<ResourceVersion> {
  return {
    isActiveVersion: false,
    isArchived: false,
    verificationStatus: "unverified",
    reviewRequestedAt: null,
    reviewOutcome: null,
    indexState: "pending",
    indexedFingerprint: null,
    indexedVersionNumber: null,
  };
}

/** Fields written to the OLD active row when a new version is activated. */
export function demoteFields(): Partial<ResourceVersion> {
  return { isActiveVersion: false };
}

/**
 * After any legal transition + its normalization patch, this must hold: no
 * stale backing field can make deriveLifecycleState return `from`. Used by the
 * engine (defensively) and by the test suite (exhaustively).
 */
export function assertNoStaleState(
  from: LifecycleState,
  after: Pick<
    ResourceVersion,
    | "isArchived"
    | "verificationStatus"
    | "isActiveVersion"
    | "reviewOutcome"
    | "reviewRequestedAt"
  >,
): { ok: true } | { ok: false; reason: string } {
  const now = deriveLifecycleState(after);
  if (now === from) {
    return {
      ok: false,
      reason: `post-transition state still derives to '${from}' — a backing field was not normalized`,
    };
  }
  return { ok: true };
}
