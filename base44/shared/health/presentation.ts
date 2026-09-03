// Phase 7 — plain-language vocabulary. Normal admin UI renders ONLY these
// strings. No engineering terminology. "Overdue" = "due for review", never
// "incorrect". Nothing here implies "one person knows this" unless a real
// key-person dependency was found.

export const HEALTH_VOCABULARY = {
  coverageState: {
    documented_verified: "Documented & verified",
    documented_unverified: "Documented (not yet verified)",
    needs_attention: "Needs attention",
    unknown: "Documentation status needs confirmation",
    not_documented: "Not documented",
  },
  continuityState: {
    ready: "Ready",
    needs_setup: "Needs setup",
    at_risk: "At risk",
    not_documented: "Not documented",
  },
  keyPersonLevel: {
    none: "No single-person dependency",
    informational: "Minor dependency",
    elevated: "Elevated dependency",
    high: "High key-person dependency",
    critical: "Critical key-person dependency",
    unknown: "Dependency risk unknown — set criticality",
  },
  freshness: {
    current: "Up to date",
    due_soon: "Due for review soon",
    overdue: "Due for review",
    unknown: "No review schedule",
  },
  bands: {
    coverage: { Strong: "Strong", Partial: "Partial", Weak: "Weak", Unknown: "Not enough data yet" },
    currency: { Current: "Current", Slipping: "Slipping", Overdue: "Overdue", Unknown: "Not enough data yet" },
    verification: {
      Confirmed: "Confirmed",
      "Mostly confirmed": "Mostly confirmed",
      "Review backlog": "Review backlog",
      Unknown: "Not enough data yet",
    },
    keyPersonResilience: { Resilient: "Resilient", Watch: "Watch", Exposed: "Exposed" },
  },
  queueKind: {
    source_failure: "A published source failed to update — re-index it",
    not_documented: "No documented procedure for this process",
    key_person_dependency: "This process depends on one person",
    active_not_verified: "Active knowledge not yet verified",
    promoted_gap: "A recurring question this process can’t fully answer",
    legacy_coverage_unresolved:
      "Confirm this process’s documentation status by re-indexing its legacy knowledge",
    overdue_review: "Due for a documentation check-in",
    missing_owner_sme: "Assign an owner and subject-matter expert",
    no_review_cadence: "Set a review schedule",
    changes_requested: "A draft revision has changes requested",
    draft_stuck: "A draft revision has been open a long time",
    awaiting_employee: "A clarification thread is waiting on the employee",
    expired_active: "A published source is past its effective date",
    open_gap: "An open knowledge gap needs an owner",
    other_setup: "Setup task",
  },
  copy: {
    unknownCoverage:
      "Documentation status needs confirmation — some legacy knowledge has not been re-indexed yet.",
    legacyVerificationCaveat:
      "Includes legacy knowledge that predates the verification workflow.",
    freshnessNotCorrectness:
      "“Due for review” means the review cadence has lapsed — it does not mean the content is wrong.",
    gapNotKnowledge:
      "These are questions your team asked that the knowledge base couldn’t fully answer. A gap is a signal to check knowledge — it is not an answer, and nothing here has been added to the knowledge base.",
    legacySetupBanner:
      "legacy knowledge sources still need re-indexing before their documentation status can be confirmed.",
  },
};

// User-facing strings must never contain any of these.
export const BANNED_UI_TOKENS = [
  "lifecycle_seq",
  "lifecycleseq",
  "index_stale",
  "indexstale",
  "operation_id",
  "operationid",
  "payload_hash",
  "payloadhash",
  "failure_stage",
  "failurestage",
  "cutover",
  "compensating",
  "reconcil",
  "chunk",
  "index_status",
  "lifecycle_state",
  "knowledgechunk",
  "knowledgelifecycleoperation",
];

export type HealthVocabulary = typeof HEALTH_VOCABULARY;

/** Shallow per-section merge of an optional override. Presentation only. */
export function resolveHealthVocabulary(
  override?: Partial<HealthVocabulary> | null,
): HealthVocabulary {
  if (!override) return HEALTH_VOCABULARY;
  const merged: any = { ...HEALTH_VOCABULARY };
  for (const k of Object.keys(override) as Array<keyof HealthVocabulary>) {
    const base = (HEALTH_VOCABULARY as any)[k];
    const ov = (override as any)[k];
    merged[k] = base && typeof base === "object" && !Array.isArray(base)
      ? { ...base, ...ov }
      : ov;
  }
  return merged as HealthVocabulary;
}
