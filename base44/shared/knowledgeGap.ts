// Pure helpers for MindVault's Phase 5 feedback / knowledge-gap aggregation.
// NO Base44 client, NO network, NO Deno APIs, NO cross-module imports, NO
// embeddings — the eval harness loads this directly under Node against
// fixtures, and gap de-duplication must work with zero embeddings credits.
//
// A KnowledgeGap is EVIDENCE that the organization's documented knowledge is
// incomplete / unclear / disputed / insufficient for a real operational
// question. It is NOT knowledge. Nothing here proposes an answer; nothing here
// mutates a source.

// --- Tunables. Centralized so they can be adjusted without touching logic. ---
// Pure lexical overlap on short paraphrased questions is inherently lossy;
// near-exact repeats dedupe reliably, loose paraphrases may not (an SME can
// `merge` two gaps, and semantic clustering arrives in Phase 9). The threshold
// is deliberately moderate and paired with client-scope + process guards.
// 0.5 is the INITIAL Phase 5 rollout value — inspect the live smoke for false
// merges and tune from there.
export const GAP_DEDUP_JACCARD = 0.5;
export const GAP_OPEN_MIN_ASKED = 3;
export const GAP_OPEN_MIN_REPORTERS = 2;
export const FEEDBACK_RATE_PER_HOUR = 20;
export const EXAMPLE_QUESTIONS_CAP = 5;
export const REPORTER_HMACS_CAP = 20;
export const RELATED_SOURCES_CAP = 40;
export const FREE_TEXT_MAX = 500;
export const CLARIFICATION_MESSAGE_MAX = 2000;

export const FEEDBACK_TYPES = [
  "helpful",
  "didnt_answer",
  "missing_detail",
  "incorrect_or_outdated",
  "still_need_help",
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const GAP_ORIGINS = [
  "explicit_feedback",
  "answer_status_partial",
  "answer_status_insufficient",
  "clarification",
  "manual",
] as const;
export type GapOrigin = (typeof GAP_ORIGINS)[number];

export const GAP_STATUSES = [
  "candidate",
  "open",
  "under_review",
  "resolved",
  "not_applicable",
] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const RESOLUTION_TYPES = [
  "source_updated",
  "new_source_added",
  "clarified_no_change",
  "duplicate",
  "not_applicable",
  "deferred",
] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

// Feedback types that should accrue gap evidence when submitted.
const GAP_ACCRUING_FEEDBACK = new Set<FeedbackType>([
  "didnt_answer",
  "missing_detail",
  "incorrect_or_outdated",
]);

export function feedbackAccruesGap(t: string): boolean {
  return GAP_ACCRUING_FEEDBACK.has(t as FeedbackType);
}

// --- Topic normalization: deterministic lexical signature, no embeddings. ---

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i if in into is it its of on or off " +
    "that the their them then there these they this to was were what when where which who via per " +
    "will with you your our we do does did done not can cannot could should would may might must about " +
    "so no yes than too very just also more most such only own same each any all some other new " +
    "get got getting need needs needed want wants please thanks thank tell show give me my mine our ours us " +
    "here now still again already ever whether question answer info information detail details")
    .split(" "),
);

/** Very light stemmer — enough to collapse obvious inflections for Jaccard. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.endsWith("edly")) w = w.slice(0, -4);
  else if (w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("es")) w = w.slice(0, -2);
  else if (w.endsWith("tion")) w = w.slice(0, -3); // -tion -> -t
  else if (w.endsWith("sion")) w = w.slice(0, -4) + "s";
  else if (w.endsWith("ency")) w = w.slice(0, -4) + "ent"; // emergency -> emergent
  else if (w.endsWith("ancy")) w = w.slice(0, -4) + "ant";
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // NB: deliberately NOT stripping -ment (payment -> pay would be wrong)
  // strip a trailing derivational suffix once more (approval -> approv, safely -> safe)
  if (w.length > 5) {
    if (w.endsWith("al")) w = w.slice(0, -2);
    else if (w.endsWith("ly")) w = w.slice(0, -2);
    else if (w.endsWith("ity")) w = w.slice(0, -3);
    else if (w.endsWith("ance") || w.endsWith("ence")) w = w.slice(0, -4);
  }
  return w;
}

/**
 * Sorted, de-duplicated, stemmed, stopword-filtered keyword set for a question.
 * This is the ONLY dedup signal in Phase 5.
 */
export function topicKeywords(text: string): string[] {
  const set = new Set<string>();
  for (const raw of (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) || []) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length >= 3 && !STOPWORDS.has(s)) set.add(s);
  }
  return [...set].sort();
}

/** The keyword set joined with spaces — a stable human-readable signature. */
export function normalizeTopic(text: string): string {
  return topicKeywords(text).join(" ");
}

/** Deterministic short hash of a normalized topic (FNV-1a, 32-bit, hex). */
export function topicSignature(normalizedTopic: string): string {
  let h = 0x811c9dc5;
  const s = normalizedTopic || "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function jaccard(a: string[], b: string[]): number {
  if (!a?.length && !b?.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function parseClientScope(scope: string | null | undefined): { clientId: string | null } {
  if (typeof scope === "string" && scope.startsWith("client:")) {
    return { clientId: scope.slice("client:".length) || null };
  }
  return { clientId: null };
}

export interface GapMatchInput {
  clientScope: string; // "general" | "client:<id>"  — verbatim from the answer
  normalizedTopic: string;
  signature: string; // stored for indexing; NOT trusted for dedupe on its own
  keywords: string[];
  processId: string | null;
}
export interface GapRowLike {
  client_scope?: string;
  normalized_topic?: string;
  topic_signature?: string;
  topic_keywords?: string[];
  operational_process_id?: string | null;
  status?: string;
}

/**
 * Whether an incoming feedback/answer event is the SAME gap as an existing row.
 *
 *  - Partitioned strictly by client_scope: a "general" gap and a "client:A" gap
 *    on the same topic never merge.
 *  - Exact-match fast path: the two NORMALIZED TOPIC STRINGS are equal. A
 *    topic_signature collision alone can NEVER cause dedupe — the signature is
 *    only a stored index hint; the string comparison is the gate.
 *  - Otherwise: fuzzy match via Jaccard of the keyword sets.
 *  - Process-compatible: same process id, or either side unset.
 */
export function shouldDedupe(
  incoming: GapMatchInput,
  gap: GapRowLike,
  jaccardThreshold: number = GAP_DEDUP_JACCARD,
): boolean {
  if (incoming.clientScope !== (gap.client_scope || "")) return false;

  const exactMatch =
    !!incoming.normalizedTopic &&
    incoming.normalizedTopic === (gap.normalized_topic || "");
  const fuzzyMatch =
    jaccard(incoming.keywords, gap.topic_keywords || []) >= jaccardThreshold;
  if (!exactMatch && !fuzzyMatch) return false;

  const gp = gap.operational_process_id || null;
  const processCompatible = !incoming.processId || !gp || incoming.processId === gp;
  return processCompatible;
}

/** candidate until enough distinct reporters AND enough asks; then open. */
export function promotionState(
  timesAsked: number,
  distinctReporters: number,
  minAsked: number = GAP_OPEN_MIN_ASKED,
  minReporters: number = GAP_OPEN_MIN_REPORTERS,
): "candidate" | "open" {
  return timesAsked >= minAsked && distinctReporters >= minReporters ? "open" : "candidate";
}

function unionCap(existing: string[], incoming: string[], cap: number): string[] {
  const out = [...(existing || [])];
  const seen = new Set(out);
  for (const v of incoming || []) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
      if (out.length >= cap) break;
    }
  }
  return out;
}

export interface GapAggregationEvent {
  origin: GapOrigin;
  sourceIds?: string[];
  missingFacets?: string[];
  reporterHmac: string;
  exampleQuestion?: string | null; // pre-gated: null unless answer_logging_enabled
  now: string; // ISO
}

/**
 * The patch to apply to an existing gap for a new matching event. Never
 * downgrades status; only promotes candidate -> open. Caps every growing array.
 */
export function mergeGapUpdate(
  gap: {
    times_asked?: number;
    distinct_reporters?: number;
    reporter_hmacs?: string[];
    related_source_ids?: string[];
    missing_facets?: string[];
    origins?: string[];
    example_questions?: string[];
    status?: string;
  },
  event: GapAggregationEvent,
): Record<string, unknown> {
  const prevAsked = gap.times_asked || 0;
  const timesAsked = prevAsked + 1;

  const hmacs = gap.reporter_hmacs || [];
  const isNewReporter = !hmacs.includes(event.reporterHmac);
  const reporterHmacs = isNewReporter && hmacs.length < REPORTER_HMACS_CAP
    ? [...hmacs, event.reporterHmac]
    : hmacs;
  const prevDistinct = gap.distinct_reporters || hmacs.length || 1;
  const distinctReporters = Math.min(
    REPORTER_HMACS_CAP,
    prevDistinct + (isNewReporter ? 1 : 0),
  );

  const patch: Record<string, unknown> = {
    times_asked: timesAsked,
    last_seen_at: event.now,
    distinct_reporters: distinctReporters,
    reporter_hmacs: reporterHmacs,
    related_source_ids: unionCap(gap.related_source_ids || [], event.sourceIds || [], RELATED_SOURCES_CAP),
    missing_facets: unionCap(gap.missing_facets || [], event.missingFacets || [], 40),
    origins: unionCap(gap.origins || [], [event.origin], GAP_ORIGINS.length),
  };

  if (event.exampleQuestion) {
    const examples = gap.example_questions || [];
    if (!examples.includes(event.exampleQuestion) && examples.length < EXAMPLE_QUESTIONS_CAP) {
      patch.example_questions = [...examples, event.exampleQuestion];
    }
  }

  // Only ever promote candidate -> open. Never touch open/under_review/resolved/not_applicable.
  if ((gap.status || "candidate") === "candidate") {
    const next = promotionState(timesAsked, distinctReporters);
    if (next === "open") patch.status = "open";
  }

  return patch;
}

/** Fields for a brand-new candidate gap. */
export function newGapFields(
  event: GapAggregationEvent & {
    title: string;
    normalizedTopic: string;
    keywords: string[];
    signature: string;
    clientScope: string;
    clientId: string | null;
    processId: string | null;
  },
): Record<string, unknown> {
  return {
    title: event.title || event.normalizedTopic || "Untitled gap",
    normalized_topic: event.normalizedTopic,
    topic_keywords: event.keywords,
    topic_signature: event.signature,
    client_scope: event.clientScope,
    client_id: event.clientId ?? undefined,
    operational_process_id: event.processId ?? undefined,
    related_source_ids: (event.sourceIds || []).slice(0, RELATED_SOURCES_CAP),
    missing_facets: (event.missingFacets || []).slice(0, 40),
    origins: [event.origin],
    times_asked: 1,
    distinct_reporters: 1,
    reporter_hmacs: [event.reporterHmac],
    example_questions: event.exampleQuestion ? [event.exampleQuestion] : [],
    first_seen_at: event.now,
    last_seen_at: event.now,
    status: "candidate",
    priority: "low",
  };
}

/** source_updated / new_source_added must name an already-governed Training. */
export function resolutionRequiresSource(resolutionType: string): boolean {
  return resolutionType === "source_updated" || resolutionType === "new_source_added";
}

export interface GovernedSourceLike {
  verification_status?: string;
  is_active_version?: boolean;
  is_archived?: boolean;
  knowledge_scope?: string;
  client_id?: string | null;
}

/**
 * Phase 5 resolve GUARD (not a workflow): a gap may only be marked resolved via
 * source_updated / new_source_added when every referenced Training ALREADY
 * satisfies verified + active + not-archived + exact client-scope match. Phase 5
 * never marks a source verified; Phase 6 owns the governed review/version flow.
 */
export function sourceSatisfiesResolution(
  source: GovernedSourceLike,
  gapClientScope: string,
): { ok: boolean; reason?: string } {
  if (source.verification_status !== "verified") return { ok: false, reason: "not_verified" };
  if (source.is_active_version === false) return { ok: false, reason: "superseded" };
  if (source.is_archived === true) return { ok: false, reason: "archived" };

  const { clientId: gapClientId } = parseClientScope(gapClientScope);
  if (gapClientId) {
    if (source.knowledge_scope !== "client-specific" || (source.client_id || null) !== gapClientId) {
      return { ok: false, reason: "scope_mismatch" };
    }
  } else {
    // general gap must be resolved with general knowledge, never a client source
    if (source.knowledge_scope !== "general") return { ok: false, reason: "scope_mismatch" };
  }
  return { ok: true };
}
