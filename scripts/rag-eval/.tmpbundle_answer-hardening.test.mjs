// scripts/rag-eval/answer-hardening.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/retrieval.ts
var WEIGHTS = { sem: 0.72, lex: 0.28, clientBoost: 0.04 };
var THRESHOLDS = {
  lowIfFinalBelow: 0.35,
  highIfFinalAbove: 0.55,
  lowIfSemBelow: 0.28,
  // Lexical (no-embeddings) mode: confidence is decided per-candidate against
  // ONE coherent evidence tuple (lex, lexHits, lexQueryTermCount). Never mix a
  // numerator from one query with a denominator from another; never combine
  // maxima from different rows. No chunk-count / distinct-training requirement.
  lexical: {
    insufficientIfLexBelow: 0.15,
    // no row with fractional overlap >= this -> LOW
    minMatchedTermsToAnswer: 1,
    // no row matched >= this many terms -> LOW
    highIfLexAtLeast: 0.45,
    // HIGH also needs one row's fractional overlap >= this
    highMinMatchedTerms: 2,
    // HIGH needs that same row to match >= this many terms
    highMinQueryTerms: 3,
    // HIGH needs that same row's query to carry >= this many terms
    gateMinBestLex: 0.25,
    // pre-generation gate: a row clears if lex >= this ...
    gateMinBestHits: 2
    //   ... OR lexHits >= this. Reject only if NO row clears either.
  },
  // Phase 4.1 rewrite-drift: cap (never fail) confidence when the standalone
  // rewrite injected the operational vocabulary the user's raw question lacked.
  rewriteDrift: {
    rawMaxContentTerms: 2,
    minNewRewriteTerms: 4
  }
};
var CANDIDATE_POOL = 40;
var TOP_K = 10;
var MAX_PER_TRAINING = 3;
var GOVERNANCE_WEIGHTS = {
  authority: {
    policy: 0.05,
    approved_sop: 0.04,
    approved_procedure: 0.03,
    training: 0.01,
    reference: 0,
    notes: -0.02
  },
  freshness: {
    current: 0,
    unreviewed: 0,
    due_soon: -0.02,
    review_requested: -0.02,
    stale: -0.05
  }
};
var BASE_TYPE_BOOST = {
  ai_knowledge_entry: 0.05,
  summary: 0.03,
  decision_rule: 0.03,
  sop_step: 0.03,
  key_takeaway: 0.02,
  common_mistake: 0.02,
  transcript: 0
};
var INTENT_TYPE_BONUS = {
  procedure: { sop_step: 0.06, ai_knowledge_entry: 0.02 },
  decision_rule: { decision_rule: 0.07 },
  troubleshooting: { common_mistake: 0.06, decision_rule: 0.03 },
  definition: { summary: 0.04, ai_knowledge_entry: 0.04 },
  overview: { summary: 0.06, ai_knowledge_entry: 0.03 },
  other: {}
};
var STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these they this to was were what when where which who will with you your our we do does did not can could should would may might must about".split(" ")
);
function tokenize(text) {
  return (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g)?.map((w) => w.replace(/^[.'-]+|[.'-]+$/g, "")).filter((w) => w.length >= 3 && !STOPWORDS.has(w)) ?? [];
}
function cosineSim(a, b) {
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
function assertInScope(chunks, clientId) {
  const kept = [];
  const dropped = [];
  for (const c of chunks) {
    const scope = c.knowledge_scope || "unclassified";
    const ok = scope === "general" || scope === "client-specific" && !!clientId && c.client_id === clientId;
    (ok ? kept : dropped).push(c);
  }
  return { kept, dropped };
}
function applyGovernanceFilters(chunks, opts = {}) {
  const now = opts.now ?? Date.now();
  const kept = [];
  const filteredOut = [];
  const drop = (c, reason) => filteredOut.push({ id: c.id, training_id: c.training_id, reason });
  for (const c of chunks) {
    if (c.index_stale === true) {
      drop(c, "index_stale");
      continue;
    }
    if (c.is_active_version === false) {
      drop(c, "superseded");
      continue;
    }
    if (c.source_is_archived === true) {
      drop(c, "archived");
      continue;
    }
    if (c.verification_status === "rejected") {
      drop(c, "rejected");
      continue;
    }
    const from = c.effective_from ? Date.parse(c.effective_from) : NaN;
    if (!Number.isNaN(from) && now < from) {
      drop(c, "not_yet_effective");
      continue;
    }
    const until = c.effective_until ? Date.parse(c.effective_until) : NaN;
    if (!Number.isNaN(until) && now > until) {
      drop(c, "expired");
      continue;
    }
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
function lexicalScoreDetailed(queryTerms, chunk) {
  if (!queryTerms.length) return { lex: 0, hits: 0 };
  const hay = /* @__PURE__ */ new Set([
    ...tokenize(chunk.content),
    ...(chunk.keywords || []).map((k) => k.toLowerCase())
  ]);
  let hits = 0;
  for (const t of queryTerms) if (hay.has(t)) hits++;
  return { lex: hits / queryTerms.length, hits };
}
function lexicalScore(queryTerms, chunk) {
  return lexicalScoreDetailed(queryTerms, chunk).lex;
}
function recencyBoost(created_date, now = Date.now()) {
  if (!created_date) return 0;
  const t = Date.parse(created_date);
  if (Number.isNaN(t)) return 0;
  const days = (now - t) / 864e5;
  if (days <= 0) return 0.02;
  if (days >= 120) return 0;
  return 0.02 * (1 - days / 120);
}
function rankChunks(opts) {
  const {
    chunks,
    queryVectors,
    standaloneQuery,
    intent = "other",
    clientId = null,
    now = Date.now(),
    weights = WEIGHTS,
    topK = TOP_K,
    governance
  } = opts;
  const { kept: inScope, dropped } = assertInScope(chunks, clientId);
  const { kept, filteredOut } = applyGovernanceFilters(inScope, {
    requireVerified: governance?.requireVerified,
    requireIngestionOk: governance?.requireIngestionOk,
    now: governance?.now ?? now
  });
  const rankingEnabled = governance?.rankingEnabled !== false;
  const queryTerms = tokenize(standaloneQuery);
  const intentBonus = INTENT_TYPE_BONUS[intent] || {};
  const scored = kept.map((chunk) => {
    let sem = 0;
    for (const qv of queryVectors) {
      const s = cosineSim(qv, chunk.embedding);
      if (s > sem) sem = s;
    }
    const { lex, hits: lexHits } = lexicalScoreDetailed(queryTerms, chunk);
    const typeBoost = (BASE_TYPE_BOOST[chunk.chunk_type || ""] || 0) + (intentBonus[chunk.chunk_type || ""] || 0);
    const clientBoost = chunk.client_id && chunk.client_id === clientId ? weights.clientBoost : 0;
    const governanceAdj = rankingEnabled ? (GOVERNANCE_WEIGHTS.authority[chunk.source_authority || ""] ?? 0) + (GOVERNANCE_WEIGHTS.freshness[chunk.process_freshness_status || ""] ?? 0) : 0;
    const score = weights.sem * sem + weights.lex * lex + typeBoost + clientBoost + governanceAdj + recencyBoost(chunk.created_date, now);
    return {
      chunk,
      score,
      sem,
      lex,
      lexHits,
      lexQueryTermCount: queryTerms.length,
      lexQuery: "standalone"
    };
  });
  const semanticActive = queryVectors.length > 0 && scored.some((r) => r.sem > 1e-9);
  scored.sort((a, b) => semanticActive ? b.sem - a.sem : b.lex - a.lex);
  const pool = scored.slice(0, CANDIDATE_POOL);
  pool.sort((a, b) => b.score - a.score);
  const seenHash = /* @__PURE__ */ new Set();
  const seenPrefix = /* @__PURE__ */ new Set();
  const perTraining = /* @__PURE__ */ new Map();
  const ranked = [];
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
function pickConfidence(ranked, opts = {}) {
  const { semanticActive = true, thresholds = THRESHOLDS } = opts;
  if (!ranked.length) return "low";
  if (!semanticActive) {
    const L2 = thresholds.lexical;
    const anyMinimal = ranked.some(
      (r) => r.lex >= L2.insufficientIfLexBelow && (r.lexHits ?? 0) >= L2.minMatchedTermsToAnswer
    );
    if (!anyMinimal) return "low";
    const highRow = ranked.some(
      (r) => r.lex >= L2.highIfLexAtLeast && (r.lexHits ?? 0) >= L2.highMinMatchedTerms && (r.lexQueryTermCount ?? 0) >= L2.highMinQueryTerms
    );
    return highRow ? "high" : "medium";
  }
  const top = ranked[0];
  if (top.sem < thresholds.lowIfSemBelow) return "low";
  if (top.score < thresholds.lowIfFinalBelow) return "low";
  if (top.score >= thresholds.highIfFinalAbove) return "high";
  return "medium";
}
function hasMinimumEvidence(ranked, opts = {}) {
  const { semanticActive = false, thresholds = THRESHOLDS } = opts;
  if (semanticActive) return true;
  if (!ranked.length) return false;
  const L2 = thresholds.lexical;
  return ranked.some(
    (r) => r.lex >= L2.gateMinBestLex || (r.lexHits ?? 0) >= L2.gateMinBestHits
  );
}
function rewriteDriftSignal(rawQuestion, standaloneQuery, thresholds = THRESHOLDS) {
  const D = thresholds.rewriteDrift;
  const raw = tokenize(rawQuestion);
  if (raw.length > D.rawMaxContentTerms) return false;
  const std = tokenize(standaloneQuery);
  const stdSet = new Set(std);
  if (raw.some((t) => stdSet.has(t))) return false;
  const rawSet = new Set(raw);
  const newTerms = std.filter((t) => !rawSet.has(t)).length;
  return newTerms >= D.minNewRewriteTerms;
}

// base44/shared/operationalAnswer.ts
function deriveAnswerStatus(input) {
  if (input.baseBand === "low" || !input.directAnswerValid) {
    return { status: "INSUFFICIENT", missingFacets: [] };
  }
  const covered = new Set(input.survivingSectionKeys || []);
  const missingFacets = (input.requestedFacets || []).filter((f) => !covered.has(f));
  if (input.baseBand === "medium") return { status: "PARTIAL", missingFacets };
  if (input.contradictionNoteKept) return { status: "PARTIAL", missingFacets };
  if (missingFacets.length) return { status: "PARTIAL", missingFacets };
  return { status: "HIGH", missingFacets: [] };
}

// scripts/rag-eval/answer-hardening.test.mjs
var L = THRESHOLDS.lexical;
var row = (lex, lexHits, lexQueryTermCount) => ({ chunk: {}, score: lex, sem: 0, lex, lexHits, lexQueryTermCount });
var LEX = { semanticActive: false };
test("lexicalScoreDetailed returns a coherent { lex, hits } pair; lexicalScore is the wrapper", () => {
  const chunk = { content: "reconcile the bank statement monthly", keywords: ["reconcile", "bank", "statement"] };
  const qt = ["reconcile", "bank", "ledger", "monthly"];
  const d = lexicalScoreDetailed(qt, chunk);
  assert.equal(d.hits, 3);
  assert.equal(d.lex, 3 / 4);
  assert.equal(lexicalScore(qt, chunk), d.lex);
  assert.deepEqual(lexicalScoreDetailed([], chunk), { lex: 0, hits: 0 });
});
test("rankChunks stamps the atomic tuple; lexHits === round(lex * lexQueryTermCount) for every row", () => {
  const chunks = [
    { training_id: "t1", knowledge_scope: "general", content: "reconcile the bank statement each month", keywords: ["reconcile", "bank", "statement", "month"], content_hash: "h1" },
    { training_id: "t2", knowledge_scope: "general", content: "payroll is approved by the controller", keywords: ["payroll", "approve", "controller"], content_hash: "h2" }
  ];
  const { ranked } = rankChunks({ chunks, queryVectors: [], standaloneQuery: "reconcile bank statement ledger", clientId: null });
  assert.ok(ranked.length >= 1);
  for (const r of ranked) {
    assert.equal(typeof r.lexHits, "number");
    assert.equal(r.lexQueryTermCount, 4, "denominator = tokenize(standaloneQuery).length");
    assert.equal(r.lexQuery, "standalone");
    assert.equal(r.lexHits, Math.round(r.lex * r.lexQueryTermCount), "row invariant");
  }
});
test("blocker 1: high lex / 1 hit  +  low lex / 2 hits  does NOT become HIGH", () => {
  assert.equal(pickConfidence([row(0.8, 1, 5), row(0.2, 2, 5)], LEX), "medium");
});
test("blocker 1: HIGH requires one candidate to satisfy BOTH lexical thresholds", () => {
  assert.equal(pickConfidence([row(0.6, 3, 4)], LEX), "high");
  assert.equal(pickConfidence([row(0.6, 1, 4), row(0.2, 3, 4)], LEX), "medium");
});
test("blocker 1: hasMinimumEvidence is per-row (never combines maxima from different rows)", () => {
  assert.equal(hasMinimumEvidence([row(0.9, 1, 1), row(0.05, 3, 1)], LEX), true);
  assert.equal(hasMinimumEvidence([row(0.2, 1, 4), row(0.1, 1, 4)], LEX), false);
  assert.equal(hasMinimumEvidence([row(0.1, 2, 20)], LEX), true);
});
test("blocker 2: a candidate scored against a SHORT query carries that query denominator/hits consistently", () => {
  assert.equal(pickConfidence([row(0.5, 1, 2)], LEX), "medium");
});
test("blocker 2: generated search-query shortening cannot turn weak standalone evidence into HIGH", () => {
  const band = pickConfidence([row(1 / 6, 1, 6)], LEX);
  assert.notEqual(band, "high", "weak standalone evidence must never be HIGH");
  assert.equal(band, "medium", "lex 0.167 >= 0.15 (not LOW) but far below HIGH bars");
});
test("blocker 2: even a fabricated short-query row (1.0, 1, 1) cannot reach HIGH", () => {
  assert.equal(pickConfidence([row(1, 1, 1)], LEX), "medium");
});
test("blocker 2: rankChunks lexical evidence always derives from the standalone query only", () => {
  const chunks = [{ training_id: "t1", knowledge_scope: "general", content: "vendor invoice filing and draw request approval process", keywords: ["vendor", "invoice", "draw", "approval"], content_hash: "h1" }];
  const { ranked } = rankChunks({
    chunks,
    queryVectors: [],
    standaloneQuery: "what is the emergency vendor payment approval threshold and who signs off",
    clientId: null
  });
  const r = ranked[0];
  assert.ok(r.lexQueryTermCount >= 6, "denominator is the long standalone query, not a short search variant");
  assert.equal(r.lexHits, Math.round(r.lex * r.lexQueryTermCount));
});
test("1-word generic query: perfect fractional overlap, 1 hit -> never HIGH", () => {
  assert.equal(pickConfidence([row(1, 1, 1)], LEX), "medium");
});
test("2-word terse valid query: both terms matched -> may answer, never HIGH", () => {
  assert.equal(pickConfidence([row(1, 2, 2)], LEX), "medium");
  assert.equal(hasMinimumEvidence([row(1, 2, 2)], LEX), true);
});
test("normal supported query: >=3 terms, one row clears all bars -> HIGH", () => {
  assert.equal(pickConfidence([row(0.75, 3, 4)], LEX), "high");
  assert.equal(pickConfidence([row(0.44, 2, 4), row(0.4, 2, 4)], LEX), "medium", "neither row clears lex 0.45 alone");
});
test("hasMinimumEvidence: rejects only when NO row clears either modest floor", () => {
  assert.equal(hasMinimumEvidence([], LEX), false);
  assert.equal(hasMinimumEvidence([row(0.2, 1, 4)], LEX), false, "lex<0.25 and hits<2");
  assert.equal(hasMinimumEvidence([row(0.25, 1, 4)], LEX), true, "lex clears");
  assert.equal(hasMinimumEvidence([row(0.1, 2, 20)], LEX), true, "hits clears");
  assert.equal(hasMinimumEvidence([row(0.9, 1, 1)], LEX), true, "one concise authoritative source passes");
});
test("hasMinimumEvidence: always true in semantic mode (that path is gated elsewhere)", () => {
  assert.equal(hasMinimumEvidence([row(0, 0, 5)], { semanticActive: true }), true);
});
test("rewriteDriftSignal: contentless raw, rewrite carries NONE of it + adds >=4 terms -> true", () => {
  assert.equal(
    rewriteDriftSignal("uh the thing", "How do I run the monthly vendor payment reconciliation process"),
    true
  );
});
test("rewriteDriftSignal: terse legitimate question is NOT flagged (a raw term is carried forward)", () => {
  assert.equal(
    rewriteDriftSignal("bank reconciliation?", "how do I reconcile the bank statement at month end"),
    false
    // "bank" is carried into the standalone -> elaboration, not substitution
  );
  assert.equal(
    rewriteDriftSignal("payroll?", "how do I run the payroll approval and submit"),
    false
    // "payroll" carried
  );
});
test("rewriteDriftSignal: raw already carries the operational content -> false", () => {
  assert.equal(
    rewriteDriftSignal("invoice when process approval reconcile", "How do I process an invoice, get approval, and reconcile it"),
    false
    // raw.length 5 > rawMaxContentTerms 2
  );
});
test("rewriteDriftSignal: normal-length raw question -> false regardless of rewrite", () => {
  assert.equal(rewriteDriftSignal("what is the approval threshold for an emergency vendor payment", "approval threshold emergency vendor payment sign off who"), false);
});
test("medium band + valid cited answer + full facet coverage -> PARTIAL, never HIGH", () => {
  const r = deriveAnswerStatus({
    baseBand: "medium",
    directAnswerValid: true,
    requestedFacets: ["steps"],
    survivingSectionKeys: ["steps"],
    contradictionNoteKept: false
  });
  assert.equal(r.status, "PARTIAL");
});
test("high band + valid cited answer + full coverage -> HIGH (unchanged)", () => {
  const r = deriveAnswerStatus({
    baseBand: "high",
    directAnswerValid: true,
    requestedFacets: ["steps"],
    survivingSectionKeys: ["steps"],
    contradictionNoteKept: false
  });
  assert.equal(r.status, "HIGH");
});
