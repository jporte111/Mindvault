// scripts/rag-eval/lifecycle-engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/lifecycle/stateMachine.ts
function deriveLifecycleState(v) {
  if (v.isArchived === true) return "archived";
  if (v.verificationStatus === "rejected") return "rejected";
  if (v.isActiveVersion === true) return "active";
  if (v.reviewOutcome === "changes_requested") return "changes_requested";
  if (v.verificationStatus === "verified") return "verified";
  if (v.reviewRequestedAt) return "in_review";
  return "draft";
}
var GRAPH = {
  draft: ["submit", "verify", "reject", "set_metadata", "archive"],
  in_review: ["request_changes", "verify", "reject", "set_metadata"],
  changes_requested: ["submit", "verify", "reject", "set_metadata"],
  verified: ["activate", "reject", "archive", "set_metadata", "submit"],
  active: [
    "create_version",
    "set_metadata",
    "confirm_current",
    "archive"
  ],
  archived: ["restore"],
  rejected: ["un_reject"]
};
function legalTransitions(from, policy) {
  const disallow = new Set(policy.disallowTransitions);
  return (GRAPH[from] || []).filter((t) => !disallow.has(t));
}
function assertTransitionLegal(from, transition, policy) {
  if (policy.disallowTransitions.includes(transition)) {
    return { ok: false, reason: `transition '${transition}' is disabled by policy` };
  }
  if (!(GRAPH[from] || []).includes(transition)) {
    return {
      ok: false,
      reason: `illegal transition '${transition}' from state '${from}'`
    };
  }
  return { ok: true };
}
function normalizeForTransition(transition, ctx2) {
  switch (transition) {
    case "submit":
      return {
        reviewRequestedAt: ctx2.now,
        reviewOutcome: null
      };
    case "request_changes":
      return {
        reviewOutcome: "changes_requested"
      };
    case "verify":
      return {
        verificationStatus: "verified",
        reviewOutcome: null
      };
    case "reject":
      return {
        verificationStatus: "rejected",
        reviewRequestedAt: null,
        reviewOutcome: null
      };
    case "un_reject":
      return {
        verificationStatus: "unverified",
        reviewRequestedAt: ctx2.now,
        reviewOutcome: null
      };
    case "activate":
      return {
        isActiveVersion: true,
        reviewOutcome: "confirmed_current"
      };
    case "archive":
      return {
        isArchived: true,
        reviewOutcome: "archived"
      };
    case "restore":
      return {
        isArchived: false,
        reviewRequestedAt: null,
        reviewOutcome: null
      };
    case "confirm_current":
      return {
        reviewOutcome: "confirmed_current",
        reviewRequestedAt: null
      };
    case "set_metadata":
      return {};
    // metadata patch is supplied by the caller; no review-field change
    case "create_version":
      return {};
    default:
      return {};
  }
}
function newDraftFields(now) {
  return {
    isActiveVersion: false,
    isArchived: false,
    verificationStatus: "unverified",
    reviewRequestedAt: null,
    reviewOutcome: null,
    indexState: "pending",
    indexedFingerprint: null,
    indexedVersionNumber: null
  };
}
function demoteFields() {
  return { isActiveVersion: false };
}
function assertNoStaleState(from, after) {
  const now = deriveLifecycleState(after);
  if (now === from) {
    return {
      ok: false,
      reason: `post-transition state still derives to '${from}' \u2014 a backing field was not normalized`
    };
  }
  return { ok: true };
}

// base44/shared/lifecycle/policy.ts
var DAY_MS = 864e5;
var DEFAULT_POLICY = {
  requireVerifiedToPublish: true,
  allowForceUnverifiedPublish: false,
  disallowTransitions: [],
  stuckAfterMs: 15 * 6e4,
  reconcileMaxAttempts: 3,
  gracePolicyMs: (intervalDays) => Math.min(14 * DAY_MS, Math.max(0, intervalDays) * 0.2 * DAY_MS),
  combinedApproveAndPublish: true
};
function computeFreshness(nextReviewDueAt, intervalDays, nowMs, policy = DEFAULT_POLICY) {
  if (!nextReviewDueAt || !intervalDays || intervalDays <= 0) return "unknown";
  const due = Date.parse(nextReviewDueAt);
  if (Number.isNaN(due)) return "unknown";
  if (nowMs >= due) return "overdue";
  if (nowMs >= due - policy.gracePolicyMs(intervalDays)) return "due_soon";
  return "current";
}

// base44/shared/lifecycle/verification.ts
function isIndexNoOp(x) {
  return x.fingerprintMatches && x.unitSetComplete && x.mismatches.length === 0;
}
function planReindex(x) {
  if (isIndexNoOp(x)) return "no_op";
  if (x.fingerprintMatches && x.unitSetComplete) return "restamp_repair";
  return "full_rebuild";
}
function assertResourceMatchesIndex(expected, unitProjections) {
  const out = [];
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
function normalize(v) {
  if (v === void 0 || v === null || v === "") return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// base44/shared/lifecycle/operationMachine.ts
function isResumableStage(stage) {
  switch (stage) {
    case "index":
    case "verify":
    case "cutover_stalemark":
    case "cutover_restamp":
    case "cutover_cleanup":
    case "cutover_stale_clear":
    case "restamp":
    case "restamp_stale_clear":
      return true;
    case "apply":
    case "cutover_flip":
    case "compensate":
      return false;
    default:
      return false;
  }
}
function compensationKind(action, stage) {
  if (stage && isResumableStage(stage)) return "resume";
  if ((action === "activate" || action === "supersede") && stage === "cutover_flip") {
    return "rollback_activation";
  }
  if (stage === "apply") return "resume";
  return "manual";
}

// scripts/rag-eval/lifecycle-engine.test.mjs
test("deriveLifecycleState reads only this row's fields (no lineage input)", () => {
  const V = (o) => ({
    isArchived: false,
    verificationStatus: "unverified",
    isActiveVersion: false,
    reviewOutcome: null,
    reviewRequestedAt: null,
    ...o
  });
  assert.equal(deriveLifecycleState(V({})), "draft");
  assert.equal(deriveLifecycleState(V({ reviewRequestedAt: "x" })), "in_review");
  assert.equal(deriveLifecycleState(V({ reviewOutcome: "changes_requested" })), "changes_requested");
  assert.equal(deriveLifecycleState(V({ verificationStatus: "verified" })), "verified");
  assert.equal(deriveLifecycleState(V({ verificationStatus: "verified", reviewRequestedAt: "x" })), "verified");
  assert.equal(deriveLifecycleState(V({ isActiveVersion: true })), "active");
  assert.equal(deriveLifecycleState(V({ isActiveVersion: true, reviewOutcome: "changes_requested" })), "active");
  assert.equal(deriveLifecycleState(V({ verificationStatus: "rejected" })), "rejected");
  assert.equal(deriveLifecycleState(V({ isArchived: true, isActiveVersion: true })), "archived");
  assert.equal(deriveLifecycleState(V({ verificationStatus: "verified", isActiveVersion: false })), "verified");
});
test("transition graph: legal / illegal", () => {
  assert.ok(assertTransitionLegal("draft", "submit", DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal("in_review", "verify", DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal("verified", "activate", DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal("active", "create_version", DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal("archived", "restore", DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal("rejected", "un_reject", DEFAULT_POLICY).ok);
  assert.equal(assertTransitionLegal("draft", "activate", DEFAULT_POLICY).ok, false);
  assert.equal(assertTransitionLegal("archived", "verify", DEFAULT_POLICY).ok, false);
  assert.equal(assertTransitionLegal("active", "activate", DEFAULT_POLICY).ok, false);
});
test("policy can NARROW the graph but not widen it", () => {
  const narrow = { ...DEFAULT_POLICY, disallowTransitions: ["restore"] };
  assert.equal(assertTransitionLegal("archived", "restore", narrow).ok, false);
  assert.equal(legalTransitions("archived", narrow).includes("restore"), false);
  assert.equal(assertTransitionLegal("draft", "activate", narrow).ok, false);
});
var adversarial = {
  isArchived: false,
  verificationStatus: "unverified",
  isActiveVersion: false,
  reviewOutcome: "changes_requested",
  reviewRequestedAt: "2020-01-01T00:00:00Z"
};
var apply = (v, patch) => ({ ...v, ...patch });
var ctx = { now: "2026-09-02T00:00:00Z", actorId: "u1" };
test("submit from changes_requested -> in_review, changes_requested field cleared", () => {
  const after = apply(adversarial, normalizeForTransition("submit", ctx));
  assert.equal(deriveLifecycleState(after), "in_review");
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState("changes_requested", after).ok);
});
test("verify from changes_requested -> verified, not stuck on changes_requested/in_review", () => {
  const after = apply(adversarial, normalizeForTransition("verify", ctx));
  assert.equal(deriveLifecycleState(after), "verified");
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState("changes_requested", after).ok);
  assert.ok(assertNoStaleState("in_review", after).ok);
});
test("request_changes -> changes_requested", () => {
  const seed = { ...adversarial, reviewOutcome: null };
  const after = apply(seed, normalizeForTransition("request_changes", ctx));
  assert.equal(deriveLifecycleState(after), "changes_requested");
  assert.ok(assertNoStaleState("in_review", after).ok);
});
test("un_reject establishes in_review explicitly (not stuck rejected/verified)", () => {
  const seed = { ...adversarial, verificationStatus: "rejected" };
  const after = apply(seed, normalizeForTransition("un_reject", ctx));
  assert.equal(deriveLifecycleState(after), "in_review");
  assert.equal(after.verificationStatus, "unverified");
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState("rejected", after).ok);
});
test("reject -> rejected, review fields cleared", () => {
  const after = apply(adversarial, normalizeForTransition("reject", ctx));
  assert.equal(deriveLifecycleState(after), "rejected");
  assert.equal(after.reviewRequestedAt, null);
  assert.equal(after.reviewOutcome, null);
});
test("archive -> archived; restore -> verified when verified else draft, never changes_requested", () => {
  const arch = apply({ ...adversarial, verificationStatus: "verified" }, normalizeForTransition("archive", ctx));
  assert.equal(deriveLifecycleState(arch), "archived");
  const restored = apply(arch, normalizeForTransition("restore", ctx));
  assert.equal(deriveLifecycleState(restored), "verified");
  assert.equal(restored.reviewOutcome, null);
  const restoredUnverified = apply(
    apply({ ...adversarial }, normalizeForTransition("archive", ctx)),
    normalizeForTransition("restore", ctx)
  );
  assert.equal(deriveLifecycleState(restoredUnverified), "draft");
  assert.ok(assertNoStaleState("changes_requested", restoredUnverified).ok);
});
test("activate normalization -> active; demoteFields -> inactive", () => {
  const promoted = apply(
    { ...adversarial, verificationStatus: "verified" },
    normalizeForTransition("activate", ctx)
  );
  assert.equal(deriveLifecycleState(promoted), "active");
  const demoted = apply({ ...promoted }, demoteFields());
  assert.equal(demoted.isActiveVersion, false);
  assert.equal(deriveLifecycleState(demoted), "verified");
});
test("newDraftFields yields a clean draft regardless of the source row", () => {
  const d = { ...adversarial, verificationStatus: "verified", isActiveVersion: true, ...newDraftFields("2026-09-02T00:00:00Z") };
  assert.equal(deriveLifecycleState(d), "draft");
  assert.equal(d.verificationStatus, "unverified");
  assert.equal(d.isActiveVersion, false);
  assert.equal(d.reviewOutcome, null);
  assert.equal(d.reviewRequestedAt, null);
  assert.equal(d.indexState, "pending");
});
test("isIndexNoOp requires ALL THREE: fingerprint match + complete set + clean projection", () => {
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: true, mismatches: [] }), true);
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: true, mismatches: [{ field: "scopeKey" }] }), false);
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: false, mismatches: [] }), false);
  assert.equal(isIndexNoOp({ fingerprintMatches: false, unitSetComplete: true, mismatches: [] }), false);
});
test("planReindex: hash match + metadata drift -> restamp_repair (never no_op)", () => {
  assert.equal(planReindex({ fingerprintMatches: true, unitSetComplete: true, mismatches: [] }), "no_op");
  assert.equal(
    planReindex({ fingerprintMatches: true, unitSetComplete: true, mismatches: [{ field: "is_active_version" }] }),
    "restamp_repair"
  );
  assert.equal(planReindex({ fingerprintMatches: true, unitSetComplete: false, mismatches: [] }), "full_rebuild");
  assert.equal(planReindex({ fingerprintMatches: false, unitSetComplete: true, mismatches: [] }), "full_rebuild");
});
test("assertResourceMatchesIndex flags every drifted (unit,field)", () => {
  const expected = { scopeKey: "general:", is_active_version: "true", effective_from: "2026-01-01" };
  const units = [
    { unitId: "a", projection: { scopeKey: "general:", is_active_version: "true", effective_from: "2026-01-01" } },
    { unitId: "b", projection: { scopeKey: "client:X", is_active_version: "true", effective_from: "2025-06-01" } }
  ];
  const m = assertResourceMatchesIndex(expected, units);
  assert.deepEqual(m.map((x) => [x.unitId, x.field]).sort(), [["b", "effective_from"], ["b", "scopeKey"]]);
});
test("compensationKind: half-applied cutover flip -> rollback_activation; index steps -> resume", () => {
  assert.equal(compensationKind("activate", "cutover_flip"), "rollback_activation");
  assert.equal(compensationKind("activate", "cutover_restamp"), "resume");
  assert.equal(compensationKind("activate", "cutover_cleanup"), "resume");
  assert.equal(compensationKind("activate", "cutover_stale_clear"), "resume");
  assert.equal(compensationKind("verify", "apply"), "resume");
  assert.equal(compensationKind("activate", "compensate"), "manual");
  assert.equal(isResumableStage("cutover_flip"), false);
  assert.equal(isResumableStage("cutover_restamp"), true);
});
test("computeFreshness: current / due_soon / overdue / unknown", () => {
  const now = Date.parse("2026-09-02T00:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 864e5;
  assert.equal(computeFreshness(null, 30, now), "unknown");
  assert.equal(computeFreshness(iso(now + 30 * DAY), null, now), "unknown");
  assert.equal(computeFreshness(iso(now + 30 * DAY), 30, now), "current");
  assert.equal(computeFreshness(iso(now + 3 * DAY), 30, now), "due_soon");
  assert.equal(computeFreshness(iso(now - DAY), 30, now), "overdue");
});
