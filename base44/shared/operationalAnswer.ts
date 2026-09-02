// Pure assembly + validation for MindVault's Operational Guidance answer mode
// (Phase 4). NO Base44 client, NO network, NO Deno APIs, NO cross-module
// imports — the eval harness loads this directly under Node against fixtures.
//
// The answer LLM PROPOSES a structured answer; this module DECIDES:
//   - which section items are citation-valid (kept) vs uncited (dropped)
//   - the grounding/coverage status HIGH | PARTIAL | INSUFFICIENT
//   - each section's source-authority label (a SEPARATE signal from status)
//   - stale / unverified flags over the CITED chunks only
//
// Status is a grounding/coverage measure, never an authority measure. Coverage
// of a requested facet is proven ONLY by a citation-validated surviving
// section — never by the raw retrieved-chunk inventory.

export type AnswerStatus = "HIGH" | "PARTIAL" | "INSUFFICIENT";
export type SectionAuthority = "authoritative" | "advisory" | "unknown" | "mixed";

// Ordered. Also the exact vocabulary for understandQuery's `requested_facets`.
export const OPERATIONAL_SECTION_KEYS = [
  "steps",
  "prerequisites",
  "approvals",
  "exceptions",
  "prohibited_actions",
  "verification_checkpoints",
  "escalation",
  "watch_outs",
  "systems",
  "expected_result",
] as const;

export type SectionKey = (typeof OPERATIONAL_SECTION_KEYS)[number];

export const SECTION_TITLES: Record<string, string> = {
  steps: "Steps",
  prerequisites: "Prerequisites",
  approvals: "Approvals",
  exceptions: "Exceptions",
  prohibited_actions: "Do not",
  verification_checkpoints: "Verification checkpoints",
  escalation: "Escalation",
  watch_outs: "Watch out for",
  systems: "Systems",
  expected_result: "Expected result",
};

// chunk_type -> section. Used ONLY for buildFacetInventory (prompt hint +
// AnswerLog diagnostics). NEVER consulted to decide whether a facet was
// actually answered.
const SECTION_FOR_CHUNK_TYPE: Record<string, SectionKey> = {
  sop_step: "steps",
  decision_rule: "steps",
  required_input: "prerequisites",
  approval: "approvals",
  exception: "exceptions",
  prohibited_action: "prohibited_actions",
  verification: "verification_checkpoints",
  escalation: "escalation",
  common_mistake: "watch_outs",
};

const AUTHORITATIVE = new Set(["policy", "approved_sop", "approved_procedure"]);
const ADVISORY = new Set(["training", "reference", "notes"]);

// Intents from understandQuery that warrant operational answer mode.
const PROCESS_INTENTS = new Set(["procedure", "decision_rule", "troubleshooting"]);

export function isOperationalIntent(intent: string | null | undefined): boolean {
  return !!intent && PROCESS_INTENTS.has(intent);
}

/**
 * Filter an LLM-proposed requested-facets list down to the known vocabulary.
 * The LLM's DETECTION of facets is non-deterministic (covered by ragEval, not
 * unit tests); this validation and everything downstream of it ARE unit-tested.
 */
export function validateRequestedFacets(raw: unknown): SectionKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SectionKey[] = [];
  for (const v of raw) {
    if (
      typeof v === "string" &&
      (OPERATIONAL_SECTION_KEYS as readonly string[]).includes(v) &&
      !seen.has(v)
    ) {
      seen.add(v);
      out.push(v as SectionKey);
    }
  }
  return out;
}

interface ChunkLike {
  id?: string;
  training_id?: string;
  title?: string;
  chunk_type?: string;
  source_authority?: string;
  process_freshness_status?: string;
  verification_status?: string;
}
interface RankedLike {
  chunk: ChunkLike;
}

/**
 * Which operational sections the retrieved chunks COULD support. Feeds the
 * generation prompt and AnswerLog diagnostics only. This never proves a facet
 * was answered — deriveAnswerStatus uses the citation-validated sections.
 */
export function buildFacetInventory(ranked: RankedLike[]): SectionKey[] {
  const present = new Set<SectionKey>();
  for (const r of ranked || []) {
    const s = SECTION_FOR_CHUNK_TYPE[r?.chunk?.chunk_type || ""];
    if (s) present.add(s);
  }
  return OPERATIONAL_SECTION_KEYS.filter((k) => present.has(k));
}

export interface EnrichedItem {
  text: string;
  citations: number[]; // 0-based indices into `ranked`, already in-range
}
export interface EnrichedSection {
  key: string;
  items: EnrichedItem[];
}

/**
 * Drop items with no valid citation; drop sections left empty or carrying an
 * unknown key. Returns the surviving sections plus whether the direct answer is
 * itself citation-valid.
 */
export function validateSections(input: {
  directAnswer: EnrichedItem | null;
  sections: EnrichedSection[];
}): { sections: EnrichedSection[]; directAnswerValid: boolean } {
  const keep: EnrichedSection[] = [];
  for (const s of input.sections || []) {
    if (!s || !(OPERATIONAL_SECTION_KEYS as readonly string[]).includes(s.key)) continue;
    const items = (s.items || []).filter(
      (it) => it && typeof it.text === "string" && it.text.trim() && it.citations.length > 0,
    );
    if (items.length) keep.push({ key: s.key, items });
  }
  const directAnswerValid = !!input.directAnswer &&
    typeof input.directAnswer.text === "string" &&
    input.directAnswer.text.trim().length > 0 &&
    input.directAnswer.citations.length > 0;
  return { sections: keep, directAnswerValid };
}

/**
 * Source-authority label for a set of cited chunks (by 0-based ranked index).
 * A SEPARATE signal from answer status — it never changes status, retrieval, or
 * ranking. Missing `source_authority` is `unknown`, NEVER `advisory`: advisory
 * requires an explicit training/reference/notes value.
 */
export function classifySectionAuthority(
  citations: number[],
  ranked: RankedLike[],
): SectionAuthority {
  let hasAuth = false;
  let hasAdv = false;
  let hasUnknown = false;
  for (const i of citations || []) {
    const a = ranked[i]?.chunk?.source_authority;
    if (a && AUTHORITATIVE.has(a)) hasAuth = true;
    else if (a && ADVISORY.has(a)) hasAdv = true;
    else hasUnknown = true; // missing or unrecognized -> unknown, not advisory
  }
  const kinds = (hasAuth ? 1 : 0) + (hasAdv ? 1 : 0) + (hasUnknown ? 1 : 0);
  if (kinds === 0) return "unknown";
  if (kinds > 1) return "mixed";
  if (hasAuth) return "authoritative";
  if (hasAdv) return "advisory";
  return "unknown";
}

/**
 * A contradiction note is kept only if it references >= 2 DISTINCT in-range
 * citations. Phase 4 has no deterministic contradiction detection — the LLM
 * flags an apparent conflict, and this is the only check we apply (plus the
 * status cap). We do NOT verify the claimed values actually differ.
 */
export function shouldKeepContradictionNote(noteCitations: number[]): boolean {
  return new Set(noteCitations || []).size >= 2;
}

/**
 * Grounding/coverage status. Decided here, in code — not by the answer LLM.
 *   baseBand 'low'                         -> INSUFFICIENT
 *   no citation-valid direct answer        -> INSUFFICIENT
 *   baseBand 'medium'                      -> PARTIAL   (Phase 4.1 — HIGH needs 'high')
 *   a kept contradiction note              -> PARTIAL
 *   a requested facet with no surviving
 *     citation-validated section           -> PARTIAL (facet listed in missing)
 *   otherwise (baseBand 'high')            -> HIGH
 *
 * `survivingSectionKeys` MUST come from validateSections(), never from
 * buildFacetInventory(ranked).
 */
export function deriveAnswerStatus(input: {
  baseBand: "low" | "medium" | "high";
  directAnswerValid: boolean;
  requestedFacets: string[];
  survivingSectionKeys: string[];
  contradictionNoteKept: boolean;
}): { status: AnswerStatus; missingFacets: string[] } {
  if (input.baseBand === "low" || !input.directAnswerValid) {
    return { status: "INSUFFICIENT", missingFacets: [] };
  }
  const covered = new Set(input.survivingSectionKeys || []);
  const missingFacets = (input.requestedFacets || []).filter((f) => !covered.has(f));
  // Phase 4.1: a 'medium' base band may still produce an answer, but grounding
  // confidence is not high enough for HIGH — cap at PARTIAL. HIGH now strictly
  // requires baseBand === 'high'.
  if (input.baseBand === "medium") return { status: "PARTIAL", missingFacets };
  if (input.contradictionNoteKept) return { status: "PARTIAL", missingFacets };
  if (missingFacets.length) return { status: "PARTIAL", missingFacets };
  return { status: "HIGH", missingFacets: [] };
}

export interface StaleFlagResult {
  stale_sources: Array<{ id: string; title: string }>;
  unverified_used: boolean;
}

/**
 * Stale / unverified over the CITED chunks only. Reads the chunk's denormalized
 * Phase-3 metadata — no live join. `stale` = process_freshness_status 'stale';
 * `unverified_used` = any cited chunk not explicitly 'verified'.
 */
export function stalenessFlags(citedChunks: ChunkLike[]): StaleFlagResult {
  const stale = new Map<string, string>();
  let unverified = false;
  for (const c of citedChunks || []) {
    if (!c) continue;
    if (c.process_freshness_status === "stale") {
      stale.set(c.training_id || c.id || `k${stale.size}`, c.title || "Untitled");
    }
    if (c.verification_status !== "verified") unverified = true;
  }
  return {
    stale_sources: [...stale].map(([id, title]) => ({ id, title })),
    unverified_used: unverified,
  };
}

export interface OperationalAnswer {
  direct_answer: { text: string; citations: number[]; authority: SectionAuthority } | null;
  sections: Array<{ key: string; title: string; authority: SectionAuthority; items: EnrichedItem[] }>;
  missing_facets: string[];
  contradiction_note: string | null;
  stale_sources: Array<{ id: string; title: string }>;
  unverified_used: boolean;
}

export const INSUFFICIENT_MESSAGE =
  "The knowledge base doesn't clearly document this operational question yet. " +
  "It may not be covered, or the question may need more specific terms (a system, a step, a document type).";

/**
 * Deterministic markdown rendering of an operational answer. Every [S#] marker
 * carried in an item's text is preserved verbatim.
 */
export function flattenToMarkdown(answer: OperationalAnswer, status: AnswerStatus): string {
  if (status === "INSUFFICIENT" || (!answer.direct_answer && answer.sections.length === 0)) {
    return INSUFFICIENT_MESSAGE;
  }
  const parts: string[] = [];
  if (answer.direct_answer) parts.push(answer.direct_answer.text.trim());
  for (const s of answer.sections) {
    const ordered = s.key === "steps";
    const lines = s.items.map((it, i) =>
      ordered ? `${i + 1}. ${it.text.trim()}` : `- ${it.text.trim()}`,
    );
    parts.push(`**${s.title}**\n${lines.join("\n")}`);
  }
  if (answer.missing_facets.length) {
    const names = answer.missing_facets.map((f) => SECTION_TITLES[f] || f).join("; ");
    parts.push(`**Not documented:** ${names}.`);
  }
  if (answer.contradiction_note) parts.push(`_${answer.contradiction_note.trim()}_`);
  if (answer.stale_sources.length) {
    parts.push(
      `_⚠ Some sources for this answer are overdue for review: ${
        answer.stale_sources.map((s) => s.title).join(", ")
      }._`,
    );
  }
  if (answer.unverified_used) parts.push("_Based on unverified knowledge._");
  return parts.join("\n\n");
}
