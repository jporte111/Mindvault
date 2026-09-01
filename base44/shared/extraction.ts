// Shared structured-extraction schema + prompt builders for analyzeTraining.
//
// Base44 bundles base44/shared/ into every function, imported as
// "../../shared/extraction.ts". No Base44 calls. The only network use is
// resolveSourceText's optional fetch, which is injectable so tests stay offline.
//
// Generalizes extraction to non-transcript source types (SOPs, policies,
// checklists, process docs, pasted text) without changing the fields the
// Product Strategy Engine and the existing Knowledge Source UI consume.
// Every legacy key is preserved; new operational keys are additive and
// optional. Both passes are source-type aware. The Strategy Engine and its
// expected output schema are not modified.

// --- Legacy contract (frozen — asserted by scripts/rag-eval/extraction.test.mjs) ---

export const LEGACY_PASS1_KEYS = Object.freeze([
  "summary",
  "key_takeaways",
  "sop_steps",
  "decision_rules",
  "common_mistakes",
  "required_inputs",
  "final_output",
  "client_segment",
  "topic_category",
  "software_systems",
  "presenter",
  "duration_minutes",
]);

export const LEGACY_PASS2_KEYS = Object.freeze([
  "ai_knowledge_entry",
  "app_feature_opportunities",
]);

// Keys the Product Strategy Engine / Roadmap reads off Training.
// analyzeTraining must never stop producing these.
export const STRATEGY_ENGINE_KEYS = Object.freeze([
  "summary",
  "key_takeaways",
  "sop_steps",
  "decision_rules",
  "client_segment",
  "topic_category",
  "app_feature_opportunities",
]);

// Exact nested shape of each app_feature_opportunities item (Strategy Engine contract).
export const FEATURE_OPPORTUNITY_KEYS = Object.freeze([
  "feature_name",
  "problem_solved",
  "user_type",
  "required_inputs",
  "output",
  "facing",
  "internal_need_score",
  "market_demand_score",
  "business_value_score",
  "implementation_complexity_score",
  "priority",
  "priority_reason",
]);

// --- New operational keys (additive, all optional, omitted when unsupported) ---

export const NEW_PASS1_KEYS = Object.freeze([
  "exceptions",
  "roles_involved",
  "approvers",
  "escalation_paths",
  "prerequisites",
  "deadlines",
  "verification_checkpoints",
  "prohibited_actions",
  "process_name",
  "department",
]);

// --- Source-type wording ---
//
//   sourceType undefined/null   -> legacy production data; keep the original
//                                  "training transcript" wording exactly
//   'recording' | 'transcript'  -> transcript wording
//   'legacy_unspecified'        -> type genuinely unknown; generic wording,
//                                  never assume recording/transcript
//   anything else               -> generic "operational knowledge source"

function isTranscriptLike(sourceType?: string | null): boolean {
  return sourceType === undefined || sourceType === null ||
    sourceType === "recording" || sourceType === "transcript";
}

function sourceNoun(sourceType?: string | null): string {
  return isTranscriptLike(sourceType) ? "training transcript" : "operational knowledge source";
}

// --- JSON schemas passed to InvokeLLM ---
//
// presenter / duration_minutes / process_name / department stay plain
// string/number (unchanged from the legacy schema). The prompts instruct the
// model to OMIT these fields when not applicable rather than emit null;
// analyzeTraining then normalizes (writes only a non-empty string / finite
// positive number). No null is instructed because the schema does not permit it.

export const pass1JsonSchema = {
  type: "object",
  properties: {
    // legacy
    summary: { type: "string" },
    key_takeaways: { type: "array", items: { type: "string" } },
    sop_steps: { type: "array", items: { type: "string" } },
    decision_rules: { type: "array", items: { type: "string" } },
    common_mistakes: { type: "array", items: { type: "string" } },
    required_inputs: { type: "array", items: { type: "string" } },
    final_output: { type: "string" },
    client_segment: { type: "string" },
    topic_category: { type: "string" },
    software_systems: { type: "array", items: { type: "string" } },
    presenter: { type: "string" },
    duration_minutes: { type: "number" },
    // new operational (optional)
    exceptions: { type: "array", items: { type: "string" } },
    roles_involved: { type: "array", items: { type: "string" } },
    approvers: { type: "array", items: { type: "string" } },
    escalation_paths: { type: "array", items: { type: "string" } },
    prerequisites: { type: "array", items: { type: "string" } },
    deadlines: { type: "array", items: { type: "string" } },
    verification_checkpoints: { type: "array", items: { type: "string" } },
    prohibited_actions: { type: "array", items: { type: "string" } },
    process_name: { type: "string" },
    department: { type: "string" },
  },
};

export const pass2JsonSchema = {
  type: "object",
  properties: {
    ai_knowledge_entry: { type: "string" },
    app_feature_opportunities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature_name: { type: "string" },
          problem_solved: { type: "string" },
          user_type: { type: "string" },
          required_inputs: { type: "string" },
          output: { type: "string" },
          facing: { type: "string" },
          internal_need_score: { type: "number" },
          market_demand_score: { type: "number" },
          business_value_score: { type: "number" },
          implementation_complexity_score: { type: "number" },
          priority: { type: "string" },
          priority_reason: { type: "string" },
        },
      },
    },
  },
};

// --- Prompt builders ---

const SOURCE_TYPE_GUIDANCE: Record<string, string> = {
  sop: "This source is a standard operating procedure document. It should already contain explicit, ordered steps — preserve their order and wording closely rather than paraphrasing.",
  process_doc: "This source is a process document. Reconstruct the end-to-end process, its inputs, and its outputs.",
  policy: "This source is a policy. Focus on the rules it establishes, the thresholds and conditions, who it applies to, and its exceptions. Do not invent thresholds, roles, or dollar values that are not stated.",
  checklist: "This source is a checklist. Each item is typically a required action or a validation — capture them as sop_steps and verification_checkpoints. Do not invent items.",
  reference: "This source is reference material. Summarize what it documents; only extract steps and rules that are explicitly stated.",
};

const OPERATIONAL_FIELDS_BLOCK = `
Also extract the following operational fields when the source supports them. Leave an array empty when the source does not clearly document it, and omit an optional string field entirely when it is not stated. Never guess names, roles, titles, thresholds, deadlines, or dollar values:
- exceptions: Array of situations where the normal procedure changes (strings).
- roles_involved: Array of job roles or titles that participate (strings).
- approvers: Array of roles or titles who must approve or sign off, and what they approve (strings).
- escalation_paths: Array of "if X then escalate to Y" statements (strings).
- prerequisites: Array of things that must be true or done before starting (strings).
- deadlines: Array of timing constraints or due dates mentioned (strings).
- verification_checkpoints: Array of checks or validations performed during or after the work (strings).
- prohibited_actions: Array of explicit "do not" statements or known bad practices (strings).
- process_name: The name of the operational process this source describes, only if explicitly stated. Omit this field otherwise.
- department: The owning department, only if explicitly stated. Omit this field otherwise.`;

/**
 * Pass 1 prompt. sourceType undefined/null (legacy production data) and
 * recording/transcript produce the original wording plus the additive
 * operational block. Document types get a leading type-specific guidance
 * sentence and generic "operational knowledge source" wording.
 * legacy_unspecified gets the generic wording with no type-specific guidance.
 */
export function buildPass1Prompt(
  { sourceText, sourceType }: { sourceText: string; sourceType?: string | null },
): string {
  const noun = sourceNoun(sourceType);
  const guidance = (sourceType && SOURCE_TYPE_GUIDANCE[sourceType])
    ? SOURCE_TYPE_GUIDANCE[sourceType] + "\n\n"
    : "";
  const metadataRule = isTranscriptLike(sourceType)
    ? ""
    : "\nThis source is a document, not a recorded session: do not invent a presenter or a duration — omit presenter and duration_minutes entirely.";

  return `You are a financial operations analyst processing a ${noun} for a financial concierge firm. Extract structured business logic from the ${noun} below.

${guidance}Source:
${sourceText}

Return a JSON object with ALL of the following fields:
- summary: A concise 2-3 sentence summary of what this covers.
- key_takeaways: Array of 4-7 most important lessons (strings).
- sop_steps: Array of numbered step-by-step operating procedure steps (strings, e.g. "1. Log into QuickBooks and navigate to...").
- decision_rules: Array of if/then rules extracted from the source (strings, e.g. "If a client has multiple entities, then...").
- common_mistakes: Array of errors, risks, misclassifications, or watchouts to avoid (strings).
- required_inputs: Array of documents, data, software access, or client info needed to complete this workflow (strings).
- final_output: A string describing what this workflow produces (e.g. "Reconciled bank statement, journal entries, and monthly close report").
- client_segment: One of: "Small Business", "High-Net-Worth Household", "Both", "Internal Only".
- topic_category: One of: "Bookkeeping", "Payroll", "Tax Prep", "Reconciliation", "Reporting", "Cash Flow", "Entity Management", "Client Communication", "Operations", "Compliance", "Troubleshooting", "Other".
- software_systems: Array of software tools, portals, or systems mentioned (strings, e.g. "QuickBooks Online", "Excel", "ADP").
- presenter: The presenter's name if clearly identifiable. Omit this field if it is not clearly identifiable — do not guess.
- duration_minutes: Estimated duration in minutes as a number, only for a recorded session. Omit this field otherwise.${metadataRule}
${OPERATIONAL_FIELDS_BLOCK}`;
}

/**
 * Pass 2 prompt. Source-type aware wording; the OUTPUT CONTRACT is unchanged —
 * ai_knowledge_entry plus app_feature_opportunities with exactly the fields the
 * Product Strategy Engine consumes.
 */
export function buildPass2Prompt(
  { sourceText, sourceType }: { sourceText: string; sourceType?: string | null },
): string {
  const noun = sourceNoun(sourceType);
  const featureCaveat = isTranscriptLike(sourceType)
    ? ""
    : " If this source is an operational document rather than a training session and surfaces no genuine product or feature ideas, return an empty app_feature_opportunities array rather than inventing entries.";

  return `You are a financial operations analyst processing a ${noun} for a financial concierge firm.

Source:
${sourceText}

Return a JSON object with the following fields:
- ai_knowledge_entry: A clean, well-written knowledge base entry (2-4 paragraphs) that an AI assistant can use to answer questions about this topic accurately.
- app_feature_opportunities: Array of objects, each with:
    - feature_name: Short name for the feature
    - problem_solved: What problem this feature solves
    - user_type: Who uses it (e.g. "Bookkeeper", "Small Business Owner", "HNW Client", "CFO", "Internal Employee")
    - required_inputs: What data the feature needs
    - output: What the feature produces
    - facing: One of "Internal", "Client-Facing", "Both"
    - internal_need_score: Integer 1-5 based on how clearly the source shows this feature would solve a real workflow problem (5 = clearly solves a painful, recurring problem; 1 = vague or minor need).
    - market_demand_score: Integer 1-5 based on whether this feature aligns with current financial services, wealth management, accounting, bookkeeping, fintech, AI automation, or client experience trends (5 = strongly aligned with multiple trends; 1 = little/no market relevance).
    - business_value_score: Integer 1-5 based on how useful this feature would be for the firm's internal team, clients, or both (5 = high value for both; 1 = limited value).
    - implementation_complexity_score: Integer 1-5 where 1 is easy to build and 5 is complex (requires integrations, heavy logic, or significant data infrastructure).
    - priority: One of "High", "Medium", "Low" — assigned using the rules below.
    - priority_reason: A plain-English explanation of WHY the feature was marked High, Medium, or Low, referencing the scores.

PRIORITY ASSIGNMENT RULES (do not assign a priority without a matching reason):
- High priority: Strong internal need (internal_need_score 4-5), strong market demand (market_demand_score 4-5), clear business value (business_value_score 4-5), and reasonable complexity OR very high upside that justifies the effort.
- Medium priority: Useful feature with moderate internal need or market demand, good business value but not urgent, may be more niche or department-specific.
- Low priority: Nice-to-have feature, weak market demand, limited business value, or high complexity compared to expected impact.

Never assign High, Medium, or Low without also providing a clear priority_reason that explains the decision based on the scores.${featureCaveat}`;
}

/**
 * Decide whether a successful extraction is thin enough to warrant human review
 * before the knowledge is trusted operationally. This never blocks ingestion in
 * Phase 1 — the record still becomes `ready`. A later phase adds a flag-gated
 * retrieval/indexing gate keyed off `ingestion_quality`.
 */
export function assessIngestionQuality(pass1Data: Record<string, unknown>): "ok" | "needs_review" {
  const arr = (k: string) => (Array.isArray(pass1Data?.[k]) ? (pass1Data[k] as unknown[]) : []);
  const str = (k: string) => (typeof pass1Data?.[k] === "string" ? (pass1Data[k] as string).trim() : "");

  const structuredCount =
    arr("sop_steps").length +
    arr("key_takeaways").length +
    arr("decision_rules").length +
    arr("common_mistakes").length +
    arr("required_inputs").length;
  const hasSummary = str("summary").length >= 20;

  if (!hasSummary && structuredCount === 0) return "needs_review";
  if (structuredCount <= 1 && !hasSummary) return "needs_review";
  return "ok";
}

// --- Source-text resolution ---
//
// A Training's `transcript` field is EITHER a supported http(s) URL to a text
// file OR the raw source text itself (pasted text, legacy records). This mirror
// of the existing behavior in embedKnowledge / TrainingDetail / legacy
// askKnowledgeBase must be preserved. Arbitrary text that merely contains
// URL-like characters is NOT treated as a URL.

export type SourceResolution =
  | { ok: true; text: string }
  | { ok: false; reason: "no_source" | "fetch_failed" | "invalid_content"; error: string; status: number };

/** True only for a whitespace-free string that parses as an http(s) URL. */
export function looksLikeHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t || /\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve a Training.transcript field to plain source text.
 *   - http(s) URL  -> fetch it, read response text
 *   - anything else -> treat the field itself as the raw source text
 * The invalid-content guard (empty / too short / HTML) is applied AFTER
 * resolution, matching the original analyzeTraining behavior. `fetchImpl` is
 * injectable so tests do not hit the network.
 */
export async function resolveSourceText(
  field: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResolution> {
  if (typeof field !== "string" || !field.trim()) {
    return { ok: false, reason: "no_source", error: "Knowledge source has no source text", status: 400 };
  }

  let raw: string;
  if (looksLikeHttpUrl(field)) {
    let res: Response;
    try {
      res = await fetchImpl(field.trim());
    } catch (e) {
      return {
        ok: false,
        reason: "fetch_failed",
        error: `Failed to fetch source text: ${(e as Error).message}`,
        status: 500,
      };
    }
    if (!res.ok) {
      return { ok: false, reason: "fetch_failed", error: `Failed to fetch source text: ${res.status}`, status: 500 };
    }
    raw = await res.text();
  } else {
    raw = field;
  }

  const trimmed = raw.trim();
  if (trimmed.length < 20 || trimmed.startsWith("<")) {
    return { ok: false, reason: "invalid_content", error: "Source text is empty or invalid content", status: 400 };
  }
  return { ok: true, text: raw };
}
