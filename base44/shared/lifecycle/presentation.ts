// Governed-lifecycle engine — presentation projection.
//
// Normal product UI shows ONLY a DisplayState and a set of DisplayActions,
// rendered through a Vocabulary map. Implementation concepts (lifecycle_seq,
// index_stale, operation ids, payload hashes, compensation stages, raw
// lifecycle_state / index_status strings) never appear here and never reach a
// normal user — those live in a separate advanced diagnostics view.

export type DisplayState =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "verified"
  | "published"
  | "previous_version"
  | "outdated"
  | "indexing"
  | "needs_attention"
  | "archived"
  | "rejected";

export type DisplayAction =
  | "edit"
  | "send_for_review"
  | "request_changes"
  | "approve"
  | "reject"
  | "publish"
  | "archive"
  | "restore"
  | "reindex"
  // advanced-only — never rendered in the normal panel
  | "view_diagnostics"
  | "force_reconcile"
  | "roll_back_activation";

export const ADVANCED_ACTIONS: DisplayAction[] = [
  "view_diagnostics",
  "force_reconcile",
  "roll_back_activation",
];

export interface DisplaySignals {
  // engine-derived, row-local
  lifecycleState:
    | "draft"
    | "in_review"
    | "changes_requested"
    | "verified"
    | "active"
    | "archived"
    | "rejected";
  isActiveVersion: boolean;
  hasNewerActiveVersion: boolean; // lineage-computed
  indexState: "pending" | "indexing" | "indexed" | "failed" | "skipped";
  anyOpenOperation: boolean;
  indexStaleOnActive: boolean;
  needsManualReconciliation: boolean;
  freshness: "current" | "due_soon" | "overdue" | "unknown";
}

/** Fail-safe first, then workflow. First match wins. */
export function toDisplayState(s: DisplaySignals): DisplayState {
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

export interface ActionContext {
  hasOpenDraftInLineage: boolean;
  draftIndexReady: boolean; // draft indexState 'indexed' AND indexedVersionNumber matches
  canWrite: boolean; // authorizer said yes for write actions
  advanced: boolean; // caller is in the advanced diagnostics view
}

/** Which plain-language actions to offer for a DisplayState. Advanced actions
 *  are only ever included when ctx.advanced is true. */
export function availableActions(
  state: DisplayState,
  ctx: ActionContext,
): DisplayAction[] {
  const out: DisplayAction[] = [];
  const add = (...a: DisplayAction[]) => {
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
        add("edit", ...(ctx.draftIndexReady ? (["publish"] as DisplayAction[]) : []), "reject", "archive");
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
        break; // no write actions while an operation is in flight
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

// --- Vocabulary ----------------------------------------------------------

export interface Vocabulary {
  state: Record<DisplayState, string>;
  action: Record<DisplayAction, string>;
  freshness: Record<"current" | "due_soon" | "overdue" | "unknown", string>;
}

export const DEFAULT_VOCABULARY: Vocabulary = {
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
    rejected: "Not approved",
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
    roll_back_activation: "Roll back",
  },
  freshness: {
    current: "Up to date",
    due_soon: "Review due soon",
    overdue: "Outdated",
    unknown: "No review schedule",
  },
};

/** Merge an optional override (e.g. from AppConfig.lifecycle_vocabulary JSON)
 *  onto the defaults. Presentation only — never affects engine behaviour. */
export function resolveVocabulary(override?: Partial<Vocabulary> | null): Vocabulary {
  if (!override) return DEFAULT_VOCABULARY;
  return {
    state: { ...DEFAULT_VOCABULARY.state, ...(override.state || {}) },
    action: { ...DEFAULT_VOCABULARY.action, ...(override.action || {}) },
    freshness: { ...DEFAULT_VOCABULARY.freshness, ...(override.freshness || {}) },
  };
}
