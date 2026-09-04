// Phase 9 P9-2 — deterministic "why is this prioritized?" rationale for an
// Address First / Review Queue item.
//
// Pure: no imports, no LLM, no embeddings, no randomness, no employee-behavior
// inference. The rationale is built ONLY from two structured fields the Phase 7
// review-queue item already carries: `kind` (which IS the derived continuity
// exposure / key-person / source-failure / review-state classification) and the
// process `criticality`. Same input -> same string, always.

export interface PriorityRationaleInput {
  kind: string; // QueueItemKind, e.g. 'source_failure' | 'key_person_dependency' | ...
  criticality?: string | null; // OperationalProcess.criticality
}

const CRITICALITY_LABEL: Record<string, string> = {
  mission_critical: "Mission-critical",
  high: "High-criticality",
  medium: "Medium-criticality",
  low: "Low-criticality",
};

export function criticalityPhrase(c?: string | null): string {
  return (c && CRITICALITY_LABEL[c]) || "Unclassified";
}

const TEMPLATES: Record<string, (c: string) => string> = {
  source_failure: (c) => `${c} process — a published source failed to update and needs re-indexing`,
  not_documented: (c) => `${c} process with no documented procedure`,
  key_person_dependency: (c) => `${c} process depends on one expert with no backup`,
  active_not_verified: (c) => `${c} process is answering from knowledge that is not yet verified`,
  promoted_gap: (c) => `${c} process — a recurring question the knowledge base can’t fully answer`,
  legacy_coverage_unresolved: (c) =>
    `${c} process — legacy knowledge needs re-indexing to confirm its documentation status`,
  overdue_review: (c) => `${c} process is overdue for a documentation review`,
  missing_owner_sme: (c) => `${c} process has no owner or subject-matter expert assigned`,
  no_review_cadence: (c) => `${c} process has no review schedule set`,
  changes_requested: (c) => `${c} process — a draft revision has changes requested`,
  draft_stuck: (c) => `${c} process — a draft revision has been open a long time`,
  awaiting_employee: (c) => `${c} process — a clarification thread is waiting on the employee`,
  expired_active: (c) => `${c} process — a published source is past its effective date`,
  open_gap: (c) => `${c} process — an open knowledge gap needs an owner`,
  other_setup: (c) => `${c} process needs governance setup`,
};

export function priorityRationale(input: PriorityRationaleInput): string {
  const c = criticalityPhrase(input?.criticality);
  const t = TEMPLATES[input?.kind];
  return t ? t(c) : `${c} process needs attention`;
}
