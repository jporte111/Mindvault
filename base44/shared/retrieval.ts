// Pure retrieval + ranking for MindVault RAG. NO Base44 client calls, NO
// network, NO Deno-only APIs, NO cross-module imports — so the eval harness
// can exercise it directly under Node against in-memory fixtures.
//
// The scope gate here is the security boundary. It is intentionally strict:
//   - "unclassified" chunks are never retrievable, in any context.
//   - "client-specific" chunks are retrievable only on an exact client_id match.
//   - "general" chunks are retrievable in every context, but only because a
//     human deliberately marked them general.
// Nothing about the user's question text can widen this — scope comes solely
// from the clientId argument.

export interface Chunk {
  id?: string;
  training_id: string;
  chunk_index?: number;
  chunk_type?: string;
  content: string;
  title?: string;
  topic_category?: string;
  client_segment?: string;
  knowledge_scope?: string;
  client_id?: string | null;
  embedding?: number[];
  keywords?: string[];
  content_hash?: string;
  created_date?: string;
  // --- Governance metadata, denormalized from the source Training (and its
  // linked OperationalProcess) at index time by embedKnowledge. Retrieval reads
  // ONLY these last-indexed copies — never a live join. Every field is optional;
  // a chunk with all of them missing is treated as fully retrievable and
  // neutrally ranked (legacy chunks keep answering unchanged).
  source_authority?: string;
  verification_status?: string; // "unverified" | "verified" | "rejected"
  ingestion_quality?: string; // "ok" | "needs_review"
  is_active_version?: boolean;
  effective_from?: string; // ISO date-time
  effective_until?: string; // ISO date-time
  source_is_archived?: boolean;
  version_number?: number;
  operational_process_id?: string;
  department?: string;
  // "unreviewed" | "current" | "due_soon" | "stale" | "review_requested"
  process_freshness_status?: string;
}

export type Intent =
  | "procedure"
  | "decision_rule"
  | "troubleshooting"
  | "definition"
  | "overview"
  | "other";

// --- Tunable knobs. Thresholds MUST be re-tuned per embedding provider during
// verification step 4 (they depend on the model's absolute cosine scale). ---
export const WEIGHTS = { sem: 0.72, lex: 0.28, clientBoost: 0.04 };
export const THRESHOLDS = {
  lowIfFinalBelow: 0.35,
  highIfFinalAbove: 0.55,
  lowIfSemBelow: 0.28,
  // Lexical (no-embeddings) mode: confidence is gated on query-term coverage
  // (top.lex, a 0..1 fraction of query terms present), not on cosine. These are
  // deliberately centralized here so they can be tuned without touching logic.
  lexical: {
    insufficientIfLexBelow: 0.15,
    corroborationLexAtLeast: 0.20,
    highIfLexAtLeast: 0.40,
    highMinChunks: 2,
  },
};
export const CANDIDATE_POOL = 40;
export const TOP_K = 10;
export const MAX_PER_TRAINING = 3;

// Governance rerank signals (Phase 3). Small ADDITIVE nudges on the same scale
// as BASE_TYPE_BOOST / clientBoost / recencyBoost — deliberately too small to
// override a real semantic or lexical relevance gap. A missing value maps to 0
// (neutral), so legacy chunks with no governance metadata are unaffected.
// Centralized here for tuning; applied only when the caller passes
// governance.rankingEnabled !== false (the `governance_ranking_enabled` flag).
// Authority is a rerank signal ONLY — it never filters and never hides a
// contradiction.
export const GOVERNANCE_WEIGHTS = {
  authority: {
    policy: 0.05,
    approved_sop: 0.04,
    approved_procedure: 0.03,
    training: 0.01,
    reference: 0,
    notes: -0.02,
  } as Record<string, number>,
  freshness: {
    current: 0,
    unreviewed: 0,
    due_soon: -0.02,
    review_requested: -0.02,
    stale: -0.05,
  } as Record<string, number>,
};

const BASE_TYPE_BOOST: Record<string, number> = {
  ai_knowledge_entry: 0.05,
  summary: 0.03,
  decision_rule: 0.03,
  sop_step: 0.03,
  key_takeaway: 0.02,
  common_mistake: 0.02,
  transcript: 0.0,
};

const INTENT_TYPE_BONUS: Record<Intent, Record<string, number>> = {
  procedure: { sop_step: 0.06, ai_knowledge_entry: 0.02 },
  decision_rule: { decision_rule: 0.07 },
  troubleshooting: { common_mistake: 0.06, decision_rule: 0.03 },
  definition: { summary: 0.04, ai_knowledge_entry: 0.04 },
  overview: { summary: 0.06, ai_knowledge_entry: 0.03 },
  other: {},
};

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i if in into is it its of on or " +
    "that the their them then there these they this to was were what when where which who " +
    "will with you your our we do does did not can could should would may might must about")
    .split(" "),
);

/**
 * Decide whether askKnowledgeBaseV2 should call the embeddings provider.
 * Pure so it can be unit-tested.
 *
 *   retrievalModeCfg   embeddingsConfigured   attemptEmbed   requireEmbed
 *   'lexical'          *                     false          false
 *   'auto'             false                 false          false   (skip -> lexical)
 *   'auto'             true                  true           false   (try -> lexical on fail)
 *   'semantic'         false                 false          true    (-> 502)
 *   'semantic'         true                  true           true    (-> 502 on fail)
 *
 * Any unrecognized retrievalModeCfg is treated as 'auto'.
 */
export function planRetrieval(
  retrievalModeCfg: string | null | undefined,
  embeddingsConfigured: boolean,
): { attemptEmbed: boolean; requireEmbed: boolean } {
  if (retrievalModeCfg === "lexical") return { attemptEmbed: false, requireEmbed: false };
  if (retrievalModeCfg === "semantic") {
    return { attemptEmbed: embeddingsConfigured, requireEmbed: true };
  }
  return { attemptEmbed: embeddingsConfigured, requireEmbed: false };
}

export function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'+.-]*/g)
    ?.map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w)) ?? [];
}

export function cosineSim(a?: number[], b?: number[]): number {
  if (!a || !b || !a.length || !b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * THE SCOPE GATE. Returns only chunks the active context is allowed to see.
 * Defense-in-depth: even if a caller's DB query is wrong, this drops anything
 * out of scope. `dropped` is returned so callers can log/alert.
 */
export function assertInScope(
  chunks: Chunk[],
  clientId: string | null | undefined,
): { kept: Chunk[]; dropped: Chunk[] } {
  const kept: Chunk[] = [];
  const dropped: Chunk[] = [];
  for (const c of chunks) {
    const scope = c.knowledge_scope || "unclassified";
    const ok =
      scope === "general" ||
      (scope === "client-specific" && !!clientId && c.client_id === clientId);
    (ok ? kept : dropped).push(c);
  }
  return { kept, dropped };
}

/**
 * Whether `now` falls within a chunk's effective window. Missing OR unparseable
 * bounds are NOT treated as constraints — a chunk with no dates is always
 * effective. Kept as a standalone helper for callers/tests that only need the
 * boolean; applyGovernanceFilters inlines the same checks to name the reason.
 */
export function isEffective(chunk: Chunk, now: number = Date.now()): boolean {
  const from = chunk.effective_from ? Date.parse(chunk.effective_from) : NaN;
  if (!Number.isNaN(from) && now < from) return false;
  const until = chunk.effective_until ? Date.parse(chunk.effective_until) : NaN;
  if (!Number.isNaN(until) && now > until) return false;
  return true;
}

export interface GovernanceOptions {
  // AppConfig key:'system' require_verification_for_retrieval — when true, only
  // verification_status === 'verified' chunks survive. 'rejected' is ALWAYS
  // excluded regardless of this flag; this flag governs unverified content only.
  requireVerified?: boolean;
  // AppConfig key:'system' require_ingestion_review — when true, chunks whose
  // source ingestion_quality === 'needs_review' are excluded.
  requireIngestionOk?: boolean;
  now?: number;
}

export interface GovernanceDrop {
  id?: string;
  training_id: string;
  reason:
    | "superseded"
    | "archived"
    | "rejected"
    | "not_yet_effective"
    | "expired"
    | "unverified"
    | "needs_review";
}

/**
 * THE PRE-GENERATION GOVERNANCE FILTER (Phase 3). Runs AFTER assertInScope:
 * scope is the security boundary, this is lifecycle/trust. Operates ONLY on
 * each chunk's last-indexed denormalized metadata — no live joins.
 *
 * Every rule is written so a MISSING field means "keep". A legacy chunk with
 * none of these fields set passes untouched, in both semantic and lexical mode.
 *
 *   ALWAYS ON (no flag):
 *     is_active_version === false        -> superseded
 *     source_is_archived === true        -> archived
 *     verification_status === 'rejected' -> rejected
 *     now < effective_from               -> not_yet_effective
 *     now > effective_until              -> expired
 *   FLAGGED:
 *     requireVerified && verification_status !== 'verified'  -> unverified
 *     requireIngestionOk && ingestion_quality === 'needs_review' -> needs_review
 */
export function applyGovernanceFilters(
  chunks: Chunk[],
  opts: GovernanceOptions = {},
): { kept: Chunk[]; filteredOut: GovernanceDrop[] } {
  const now = opts.now ?? Date.now();
  const kept: Chunk[] = [];
  const filteredOut: GovernanceDrop[] = [];
  const drop = (c: Chunk, reason: GovernanceDrop["reason"]) =>
    filteredOut.push({ id: c.id, training_id: c.training_id, reason });

  for (const c of chunks) {
    if (c.is_active_version === false) { drop(c, "superseded"); continue; }
    if (c.source_is_archived === true) { drop(c, "archived"); continue; }
    if (c.verification_status === "rejected") { drop(c, "rejected"); continue; }
    const from = c.effective_from ? Date.parse(c.effective_from) : NaN;
    if (!Number.isNaN(from) && now < from) { drop(c, "not_yet_effective"); continue; }
    const until = c.effective_until ? Date.parse(c.effective_until) : NaN;
    if (!Number.isNaN(until) && now > until) { drop(c, "expired"); continue; }
    if (opts.requireVerified && c.verification_status !== "verified") {
      drop(c, "unverified");
      continue;
    }
    if (opts.requireIngestionOk && c.ingestion_quality === "needs_review") {
      drop(c, "needs_review");
      continue;
    }
    kept.push(c);
  }
  return { kept, filteredOut };
}

export function lexicalScore(queryTerms: string[], chunk: Chunk): number {
  if (!queryTerms.length) return 0;
  const hay = new Set([
    ...tokenize(chunk.content),
    ...(chunk.keywords || []).map((k) => k.toLowerCase()),
  ]);
  let hits = 0;
  for (const t of queryTerms) if (hay.has(t)) hits++;
  return hits / queryTerms.length;
}

function recencyBoost(created_date?: string, now: number = Date.now()): number {
  if (!created_date) return 0;
  const t = Date.parse(created_date);
  if (Number.isNaN(t)) return 0;
  const days = (now - t) / 86_400_000;
  if (days <= 0) return 0.02;
  if (days >= 120) return 0;
  return 0.02 * (1 - days / 120);
}

export interface RankedChunk {
  chunk: Chunk;
  score: number;
  sem: number;
  lex: number;
}

export interface RankOptions {
  chunks: Chunk[];
  queryVectors: number[][];
  standaloneQuery: string;
  intent?: Intent;
  clientId?: string | null;
  now?: number;
  weights?: typeof WEIGHTS;
  topK?: number;
  // Phase 3. When present, applyGovernanceFilters runs after the scope gate and
  // (unless rankingEnabled === false) authority/freshness rerank nudges are
  // added to `score`. Omit entirely to keep pure PR #1 behavior.
  governance?: GovernanceOptions & { rankingEnabled?: boolean };
}

/**
 * Full pipeline: scope gate -> governance filter -> hybrid score -> dedupe ->
 * per-training cap -> top K. Returns { ranked, dropped, filteredOut,
 * semanticActive }. `dropped` is scope violations only (should never be
 * non-empty in production); `filteredOut` is the expected governance/lifecycle
 * exclusions with a reason each.
 *
 * Lexical fallback: pass `queryVectors: []` (or vectors that match nothing) and
 * ranking is driven entirely by lexical overlap + boosts. The scope gate,
 * governance filter, dedupe, per-training cap and citation flow are IDENTICAL
 * in both modes — only the candidate-pool ordering and the semantic term of
 * `score` differ. Governance filters and nudges read denormalized chunk
 * metadata only, so they behave the same with or without vectors.
 */
export function rankChunks(
  opts: RankOptions,
): {
  ranked: RankedChunk[];
  dropped: Chunk[];
  filteredOut: GovernanceDrop[];
  semanticActive: boolean;
} {
  const {
    chunks,
    queryVectors,
    standaloneQuery,
    intent = "other",
    clientId = null,
    now = Date.now(),
    weights = WEIGHTS,
    topK = TOP_K,
    governance,
  } = opts;

  const { kept: inScope, dropped } = assertInScope(chunks, clientId);
  // Governance / lifecycle filter — always runs; with no `governance` option it
  // still drops superseded / archived / rejected / out-of-window chunks (all
  // "missing = keep", so legacy chunks are untouched).
  const { kept, filteredOut } = applyGovernanceFilters(inScope, {
    requireVerified: governance?.requireVerified,
    requireIngestionOk: governance?.requireIngestionOk,
    now: governance?.now ?? now,
  });
  const rankingEnabled = governance?.rankingEnabled !== false;
  const queryTerms = tokenize(standaloneQuery);
  const intentBonus = INTENT_TYPE_BONUS[intent] || {};

  const scored: RankedChunk[] = kept.map((chunk) => {
    let sem = 0;
    for (const qv of queryVectors) {
      const s = cosineSim(qv, chunk.embedding);
      if (s > sem) sem = s;
    }
    const lex = lexicalScore(queryTerms, chunk);
    const typeBoost =
      (BASE_TYPE_BOOST[chunk.chunk_type || ""] || 0) +
      (intentBonus[chunk.chunk_type || ""] || 0);
    const clientBoost =
      chunk.client_id && chunk.client_id === clientId ? weights.clientBoost : 0;
    // Governance rerank nudge (Phase 3): small additive authority + freshness
    // signal. Missing metadata -> 0. Disabled when rankingEnabled === false.
    const governanceAdj = rankingEnabled
      ? (GOVERNANCE_WEIGHTS.authority[chunk.source_authority || ""] ?? 0) +
        (GOVERNANCE_WEIGHTS.freshness[chunk.process_freshness_status || ""] ?? 0)
      : 0;
    const score =
      weights.sem * sem +
      weights.lex * lex +
      typeBoost +
      clientBoost +
      governanceAdj +
      recencyBoost(chunk.created_date, now);
    return { chunk, score, sem, lex };
  });

  // Semantic is "active" only if query vectors exist AND some chunk actually
  // has a comparable vector. Otherwise the pool is picked by lexical signal.
  const semanticActive = queryVectors.length > 0 && scored.some((r) => r.sem > 1e-9);

  // Candidate pool: order by whichever signal is informative, then re-rank the
  // pool by the combined `score`.
  scored.sort((a, b) => (semanticActive ? b.sem - a.sem : b.lex - a.lex));
  const pool = scored.slice(0, CANDIDATE_POOL);
  pool.sort((a, b) => b.score - a.score);

  // Dedupe near-identical passages; cap per source training for diversity.
  const seenHash = new Set<string>();
  const seenPrefix = new Set<string>();
  const perTraining = new Map<string, number>();
  const ranked: RankedChunk[] = [];
  for (const r of pool) {
    const h = r.chunk.content_hash;
    if (h && seenHash.has(h)) continue;
    const prefix = r.chunk.content.slice(0, 120).toLowerCase().replace(/\s+/g, " ").trim();
    if (seenPrefix.has(prefix)) continue;
    const count = perTraining.get(r.chunk.training_id) || 0;
    if (count >= MAX_PER_TRAINING) continue;

    if (h) seenHash.add(h);
    seenPrefix.add(prefix);
    perTraining.set(r.chunk.training_id, count + 1);
    ranked.push(r);
    if (ranked.length >= topK) break;
  }

  return { ranked, dropped, filteredOut, semanticActive };
}

/**
 * Confidence band. In semantic mode this is the original cosine-based gate. In
 * lexical mode (`semanticActive: false`) it is gated on query-term coverage
 * using THRESHOLDS.lexical. Passing no options keeps the original behavior.
 */
export function pickConfidence(
  ranked: RankedChunk[],
  opts: { semanticActive?: boolean; thresholds?: typeof THRESHOLDS } = {},
): "low" | "medium" | "high" {
  const { semanticActive = true, thresholds = THRESHOLDS } = opts;
  if (!ranked.length) return "low";
  const top = ranked[0];

  if (!semanticActive) {
    const L = thresholds.lexical;
    if (top.lex < L.insufficientIfLexBelow) return "low";
    const corroborating = ranked.filter((r) => r.lex >= L.corroborationLexAtLeast).length;
    if (top.lex >= L.highIfLexAtLeast && corroborating >= L.highMinChunks) return "high";
    return "medium";
  }

  if (top.sem < thresholds.lowIfSemBelow) return "low";
  if (top.score < thresholds.lowIfFinalBelow) return "low";
  if (top.score >= thresholds.highIfFinalAbove) return "high";
  return "medium";
}

/**
 * Which [S#] markers an answer actually used, as 0-based indices into the
 * ranked list. Out-of-range markers are ignored.
 */
export function parseCitations(answerText: string, rankedCount: number): number[] {
  const seen = new Set<number>();
  for (const m of (answerText || "").matchAll(/\[S(\d+)\]/g)) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < rankedCount) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}
