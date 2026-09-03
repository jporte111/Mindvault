// scripts/rag-eval/lifecycle-presentation.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/lifecycle/presentation.ts
var ADVANCED_ACTIONS = [
  "view_diagnostics",
  "force_reconcile",
  "roll_back_activation"
];
function toDisplayState(s) {
  if (s.needsManualReconciliation || s.indexState === "failed") return "needs_attention";
  if (s.isActiveVersion && s.indexStaleOnActive && !s.anyOpenOperation) return "needs_attention";
  if (s.anyOpenOperation || s.indexState === "indexing") return "indexing";
  if (s.lifecycleState === "archived") return "archived";
  if (s.lifecycleState === "rejected") return "rejected";
  if (s.isActiveVersion && s.indexState === "indexed") {
    return s.freshness === "overdue" ? "outdated" : "published";
  }
  if (s.hasNewerActiveVersion) return "previous_version";
  if (s.lifecycleState === "verified") return "verified";
  if (s.lifecycleState === "changes_requested") return "changes_requested";
  if (s.lifecycleState === "in_review") return "in_review";
  return "draft";
}
function availableActions(state, ctx) {
  const out = [];
  const add = (...a) => {
    for (const x of a) if (!out.includes(x)) out.push(x);
  };
  if (ctx.canWrite) {
    switch (state) {
      case "draft":
        add("edit", "send_for_review", "approve", "reject", "archive");
        break;
      case "in_review":
        add("edit", "approve", "request_changes", "reject");
        break;
      case "changes_requested":
        add("edit", "send_for_review", "approve", "reject");
        break;
      case "verified":
        add("edit", ...ctx.draftIndexReady ? ["publish"] : [], "reject", "archive");
        break;
      case "published":
      case "outdated":
        add("edit", "archive");
        break;
      case "previous_version":
        add("restore");
        break;
      case "archived":
        add("restore");
        break;
      case "rejected":
        add("edit");
        break;
      case "indexing":
        break;
      // no write actions while an operation is in flight
      case "needs_attention":
        add("reindex");
        break;
    }
  }
  if (ctx.advanced) {
    add("view_diagnostics");
    if (state === "needs_attention") add("force_reconcile", "roll_back_activation");
  }
  return out;
}
var DEFAULT_VOCABULARY = {
  state: {
    draft: "Draft",
    in_review: "Ready for review",
    changes_requested: "Changes requested",
    verified: "Verified",
    published: "Published",
    previous_version: "Previous version",
    outdated: "Outdated",
    indexing: "Indexing",
    needs_attention: "Needs attention",
    archived: "Archived",
    rejected: "Not approved"
  },
  action: {
    edit: "Edit",
    send_for_review: "Send for review",
    request_changes: "Request changes",
    approve: "Approve",
    reject: "Reject",
    publish: "Publish",
    archive: "Archive",
    restore: "Restore",
    reindex: "Re-index",
    view_diagnostics: "View diagnostics",
    force_reconcile: "Run repair",
    roll_back_activation: "Roll back"
  },
  freshness: {
    current: "Up to date",
    due_soon: "Review due soon",
    overdue: "Outdated",
    unknown: "No review schedule"
  }
};
function resolveVocabulary(override) {
  if (!override) return DEFAULT_VOCABULARY;
  return {
    state: { ...DEFAULT_VOCABULARY.state, ...override.state || {} },
    action: { ...DEFAULT_VOCABULARY.action, ...override.action || {} },
    freshness: { ...DEFAULT_VOCABULARY.freshness, ...override.freshness || {} }
  };
}

// scripts/rag-eval/lifecycle-presentation.test.mjs
var BANNED = [
  "lifecycle_seq",
  "lifecycleSeq",
  "index_stale",
  "indexStale",
  "operation_id",
  "operationId",
  "payload_hash",
  "payloadHash",
  "compensat",
  "reconcil",
  "lifecycle_state",
  "lifecycleState",
  "index_status",
  "indexState",
  "cutover",
  "stale_clear",
  "failure_stage",
  "failureStage",
  "KnowledgeChunk",
  "KnowledgeLifecycleOperation",
  "Training."
];
var bannedHit = (s) => BANNED.find((b) => String(s).toLowerCase().includes(b.toLowerCase()));
var ALL_DISPLAY_STATES = [
  "draft",
  "in_review",
  "changes_requested",
  "verified",
  "published",
  "previous_version",
  "outdated",
  "indexing",
  "needs_attention",
  "archived",
  "rejected"
];
test("no DisplayState value contains a backend identifier", () => {
  for (const s of ALL_DISPLAY_STATES) {
    assert.equal(bannedHit(s), void 0, `DisplayState "${s}" leaks a backend token`);
  }
});
test("no NORMAL DisplayAction value or label leaks a backend identifier (advanced actions exempt \u2014 diagnostics-only)", () => {
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.action)) {
    if (ADVANCED_ACTIONS.includes(k)) continue;
    assert.equal(bannedHit(k), void 0, `action key "${k}" leaks`);
    assert.equal(bannedHit(v), void 0, `action label "${v}" leaks`);
  }
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.state)) {
    assert.equal(bannedHit(k), void 0, `state key "${k}" leaks`);
    assert.equal(bannedHit(v), void 0, `state label "${v}" leaks`);
  }
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.freshness)) {
    assert.equal(bannedHit(k), void 0, `freshness key "${k}" leaks`);
    assert.equal(bannedHit(v), void 0, `freshness label "${v}" leaks`);
  }
});
test("toDisplayState priority ladder: fail-safe states beat workflow states", () => {
  const base = {
    lifecycleState: "active",
    isActiveVersion: true,
    hasNewerActiveVersion: false,
    indexState: "indexed",
    anyOpenOperation: false,
    indexStaleOnActive: false,
    needsManualReconciliation: false,
    freshness: "current"
  };
  assert.equal(toDisplayState(base), "published");
  assert.equal(toDisplayState({ ...base, freshness: "overdue" }), "outdated");
  assert.equal(toDisplayState({ ...base, needsManualReconciliation: true }), "needs_attention");
  assert.equal(toDisplayState({ ...base, indexState: "failed" }), "needs_attention");
  assert.equal(toDisplayState({ ...base, indexStaleOnActive: true }), "needs_attention");
  assert.equal(toDisplayState({ ...base, anyOpenOperation: true }), "indexing");
});
test("toDisplayState workflow states for inactive versions", () => {
  const draft = {
    lifecycleState: "draft",
    isActiveVersion: false,
    hasNewerActiveVersion: false,
    indexState: "pending",
    anyOpenOperation: false,
    indexStaleOnActive: false,
    needsManualReconciliation: false,
    freshness: "unknown"
  };
  assert.equal(toDisplayState(draft), "draft");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "in_review" }), "in_review");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "changes_requested" }), "changes_requested");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "verified" }), "verified");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "verified", hasNewerActiveVersion: true }), "previous_version");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "archived" }), "archived");
  assert.equal(toDisplayState({ ...draft, lifecycleState: "rejected" }), "rejected");
});
test("availableActions: advanced actions ONLY appear when ctx.advanced", () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: true, canWrite: true, advanced: false };
  for (const s of ALL_DISPLAY_STATES) {
    const acts = availableActions(s, ctx);
    for (const adv of ADVANCED_ACTIONS) {
      assert.equal(acts.includes(adv), false, `advanced action "${adv}" leaked into normal actions for "${s}"`);
    }
  }
  const advActs = availableActions("needs_attention", { ...ctx, advanced: true });
  assert.ok(advActs.includes("view_diagnostics"));
  assert.ok(advActs.includes("force_reconcile"));
});
test("availableActions: no write actions offered when canWrite is false", () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: true, canWrite: false, advanced: false };
  for (const s of ALL_DISPLAY_STATES) {
    assert.deepEqual(availableActions(s, ctx), [], `"${s}" offered actions without write permission`);
  }
});
test("availableActions: publish only offered on verified when the draft is pre-indexed", () => {
  const ready = { hasOpenDraftInLineage: true, draftIndexReady: true, canWrite: true, advanced: false };
  const notReady = { ...ready, draftIndexReady: false };
  assert.ok(availableActions("verified", ready).includes("publish"));
  assert.equal(availableActions("verified", notReady).includes("publish"), false);
});
test("availableActions: no write actions while indexing", () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: false, canWrite: true, advanced: false };
  assert.deepEqual(availableActions("indexing", ctx), []);
});
test("resolveVocabulary merges an override without losing keys or leaking tokens", () => {
  const v = resolveVocabulary({ state: { published: "Live" } });
  assert.equal(v.state.published, "Live");
  assert.equal(v.state.draft, "Draft");
  for (const label of Object.values(v.state)) assert.equal(bannedHit(label), void 0);
});
