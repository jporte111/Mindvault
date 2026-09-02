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
}

/**
 * Full pipeline: scope gate -> hybrid score -> dedupe -> per-training cap ->
 * top K. Returns { ranked, dropped, semanticActive }.
 *
 * Lexical fallback: pass `queryVectors: []` (or vectors that match nothing) and
 * ranking is driven entirely by lexical overlap + boosts. The scope gate,
 * dedupe, per-training cap and citation flow are IDENTICAL in both modes —
 * only the candidate-pool ordering and the semantic term of `score` differ.
 */
export function rankChunks(
  opts: RankOptions,
): { ranked: RankedChunk[]; dropped: Chunk[]; semanticActive: boolean } {
  const {
    chunks,
    queryVectors,
    standaloneQuery,
    intent = "other",
    clientId = null,
    now = Date.now(),
    weights = WEIGHTS,
    topK = TOP_K,
  } = opts;

  const { kept, dropped } = assertInScope(chunks, clientId);
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
    const score =
      weights.sem * sem +
      weights.lex * lex +
      typeBoost +
      clientBoost +
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

  return { ranked, dropped, semanticActive };
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
