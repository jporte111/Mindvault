// scripts/rag-eval/retrieval.test.mjs
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
function planRetrieval(retrievalModeCfg, embeddingsConfigured) {
  if (retrievalModeCfg === "lexical") return { attemptEmbed: false, requireEmbed: false };
  if (retrievalModeCfg === "semantic") {
    return { attemptEmbed: embeddingsConfigured, requireEmbed: true };
  }
  return { attemptEmbed: embeddingsConfigured, requireEmbed: false };
}
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
function lexicalScoreDetailed(queryTerms, chunk2) {
  if (!queryTerms.length) return { lex: 0, hits: 0 };
  const hay = /* @__PURE__ */ new Set([
    ...tokenize(chunk2.content),
    ...(chunk2.keywords || []).map((k) => k.toLowerCase())
  ]);
  let hits = 0;
  for (const t of queryTerms) if (hay.has(t)) hits++;
  return { lex: hits / queryTerms.length, hits };
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
  const scored = kept.map((chunk2) => {
    let sem = 0;
    for (const qv of queryVectors) {
      const s = cosineSim(qv, chunk2.embedding);
      if (s > sem) sem = s;
    }
    const { lex: lex2, hits: lexHits } = lexicalScoreDetailed(queryTerms, chunk2);
    const typeBoost = (BASE_TYPE_BOOST[chunk2.chunk_type || ""] || 0) + (intentBonus[chunk2.chunk_type || ""] || 0);
    const clientBoost = chunk2.client_id && chunk2.client_id === clientId ? weights.clientBoost : 0;
    const governanceAdj = rankingEnabled ? (GOVERNANCE_WEIGHTS.authority[chunk2.source_authority || ""] ?? 0) + (GOVERNANCE_WEIGHTS.freshness[chunk2.process_freshness_status || ""] ?? 0) : 0;
    const score = weights.sem * sem + weights.lex * lex2 + typeBoost + clientBoost + governanceAdj + recencyBoost(chunk2.created_date, now);
    return {
      chunk: chunk2,
      score,
      sem,
      lex: lex2,
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
    const L = thresholds.lexical;
    const anyMinimal = ranked.some(
      (r) => r.lex >= L.insufficientIfLexBelow && (r.lexHits ?? 0) >= L.minMatchedTermsToAnswer
    );
    if (!anyMinimal) return "low";
    const highRow = ranked.some(
      (r) => r.lex >= L.highIfLexAtLeast && (r.lexHits ?? 0) >= L.highMinMatchedTerms && (r.lexQueryTermCount ?? 0) >= L.highMinQueryTerms
    );
    return highRow ? "high" : "medium";
  }
  const top = ranked[0];
  if (top.sem < thresholds.lowIfSemBelow) return "low";
  if (top.score < thresholds.lowIfFinalBelow) return "low";
  if (top.score >= thresholds.highIfFinalAbove) return "high";
  return "medium";
}
function parseCitations(answerText, rankedCount) {
  const seen = /* @__PURE__ */ new Set();
  for (const m of (answerText || "").matchAll(/\[S(\d+)\]/g)) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < rankedCount) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

// scripts/rag-eval/retrieval.test.mjs
var chunk = (o) => ({
  chunk_index: 0,
  chunk_type: "decision_rule",
  content: o.content || "x",
  title: o.title || o.id,
  content_hash: o.id,
  ...o
});
var POOL = [
  chunk({
    id: "G1",
    training_id: "t-recon",
    knowledge_scope: "general",
    chunk_type: "sop_step",
    content: "Steps to reconcile a bank statement each month.",
    embedding: [0.98, 0.1, 0, 0]
  }),
  chunk({
    id: "G2",
    training_id: "t-payroll",
    knowledge_scope: "general",
    chunk_type: "summary",
    content: "Overview of the payroll run process.",
    embedding: [0, 0, 1, 0]
  }),
  chunk({
    id: "A1",
    training_id: "t-acme",
    knowledge_scope: "client-specific",
    client_id: "clientA",
    content: "Acme closes its books on the 5th of the month.",
    embedding: [0.1, 0.98, 0, 0]
  }),
  chunk({
    id: "B1",
    training_id: "t-beta",
    knowledge_scope: "client-specific",
    client_id: "clientB",
    content: "Beta closes its books on the 12th of the month.",
    embedding: [0.1, 0.98, 0, 0]
  }),
  chunk({
    id: "U1",
    training_id: "t-unclass",
    knowledge_scope: "unclassified",
    content: "Unclassified draft note that must never be retrieved.",
    embedding: [0.98, 0.1, 0, 0]
  })
];
var Q_RECON = [[1, 0, 0, 0]];
var Q_CLOSE = [[0, 1, 0, 0]];
var Q_OFFTOPIC = [[0, 0, 0, 1]];
test("general context: only general chunks, never client or unclassified", () => {
  const { ranked, dropped } = rankChunks({
    chunks: POOL,
    queryVectors: Q_RECON,
    standaloneQuery: "reconcile bank statement",
    clientId: null
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes("G1"));
  for (const bad of ["A1", "B1", "U1"]) assert.ok(!ids.includes(bad), `${bad} leaked into general context`);
  const droppedIds = dropped.map((d) => d.id).sort();
  assert.deepEqual(droppedIds, ["A1", "B1", "U1"]);
});
test("client A context: A chunks + general, never B or unclassified", () => {
  const { ranked, dropped } = rankChunks({
    chunks: POOL,
    queryVectors: Q_CLOSE,
    standaloneQuery: "when does the client close books",
    clientId: "clientA"
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes("A1"), "A1 should be retrievable in client A context");
  assert.ok(!ids.includes("B1"), "B1 (other client) leaked");
  assert.ok(!ids.includes("U1"), "U1 (unclassified) leaked");
  assert.ok(dropped.map((d) => d.id).includes("B1"));
});
test("a client name in the query never widens scope", () => {
  const { ranked } = rankChunks({
    chunks: POOL,
    queryVectors: Q_CLOSE,
    standaloneQuery: "what is Beta's book close date for the Beta account",
    clientId: "clientA"
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes("B1"), 'mentioning "Beta" pulled in client B data');
});
test("assertInScope unit: mixed pool in -> only allowed out", () => {
  const { kept, dropped } = assertInScope(POOL, "clientA");
  assert.deepEqual(kept.map((c) => c.id).sort(), ["A1", "G1", "G2"]);
  assert.deepEqual(dropped.map((c) => c.id).sort(), ["B1", "U1"]);
});
test("weak / off-topic results -> low confidence", () => {
  const { ranked } = rankChunks({
    chunks: POOL,
    queryVectors: Q_OFFTOPIC,
    standaloneQuery: "company holiday policy",
    clientId: null
  });
  assert.equal(pickConfidence(ranked), "low");
});
test("dedupe + per-training cap", () => {
  const dupes = Array.from({ length: 6 }, (_, i) => chunk({
    id: `D${i}`,
    training_id: "t-dup",
    knowledge_scope: "general",
    content: `Reconcile the bank statement carefully \u2014 variant ${i}`,
    content_hash: `D${i}`,
    embedding: [0.9, 0.2, 0, 0]
  }));
  dupes[5].content_hash = "D0";
  const { ranked } = rankChunks({
    chunks: dupes,
    queryVectors: Q_RECON,
    standaloneQuery: "reconcile bank statement",
    clientId: null
  });
  assert.ok(ranked.length <= 3, `per-training cap not applied (${ranked.length})`);
  const hashes = ranked.map((r) => r.chunk.content_hash);
  assert.equal(new Set(hashes).size, hashes.length, "exact-duplicate hash survived");
});
test("parseCitations extracts used, in-range markers only", () => {
  assert.deepEqual(parseCitations("see [S1] and [S3], ignore [S9]", 4), [0, 2]);
  assert.deepEqual(parseCitations("no citations here", 4), []);
});
test("semanticActive is true only when vectors exist AND match something", () => {
  const withVec = rankChunks({
    chunks: POOL,
    queryVectors: Q_RECON,
    standaloneQuery: "reconcile bank statement",
    clientId: null
  });
  assert.equal(withVec.semanticActive, true);
});
var lex = (o) => ({
  chunk_index: 0,
  chunk_type: "decision_rule",
  title: o.id,
  content_hash: o.id,
  ...o
});
var LEX_POOL = [
  lex({
    id: "L1",
    training_id: "t-recon",
    knowledge_scope: "general",
    content: "To reconcile a bank statement, match every transaction to the ledger and note discrepancies.",
    keywords: ["reconcile", "bank", "statement", "ledger"]
  }),
  lex({
    id: "L2",
    training_id: "t-recon2",
    knowledge_scope: "general",
    content: "Bank reconciliation runs monthly once the statement arrives.",
    keywords: ["bank", "reconciliation", "monthly", "statement"]
  }),
  lex({
    id: "L3",
    training_id: "t-payroll",
    knowledge_scope: "general",
    content: "Payroll runs are approved by the controller before submission.",
    keywords: ["payroll", "approve", "controller"]
  }),
  lex({
    id: "LA",
    training_id: "t-acme",
    knowledge_scope: "client-specific",
    client_id: "clientA",
    content: "Acme reconcile bank statement on the fifth business day.",
    keywords: ["acme", "reconcile", "bank", "statement"]
  }),
  lex({
    id: "LB",
    training_id: "t-beta",
    knowledge_scope: "client-specific",
    client_id: "clientB",
    content: "Beta reconcile bank statement on the twelfth business day.",
    keywords: ["beta", "reconcile", "bank", "statement"]
  }),
  lex({
    id: "LU",
    training_id: "t-unclass",
    knowledge_scope: "unclassified",
    content: "Draft reconcile bank statement note, not yet classified.",
    keywords: ["reconcile", "bank", "statement"]
  })
];
test("lexical mode: no queryVectors -> semanticActive false, ranked by term overlap", () => {
  const { ranked, semanticActive } = rankChunks({
    chunks: LEX_POOL,
    queryVectors: [],
    standaloneQuery: "reconcile bank statement ledger",
    clientId: null
  });
  assert.equal(semanticActive, false);
  const ids = ranked.map((r) => r.chunk.id);
  assert.equal(ids[0], "L1", "best term overlap should rank first");
  assert.ok(ids.indexOf("L1") < ids.indexOf("L3"), "off-topic chunk should rank below on-topic");
});
test("lexical mode: scope isolation is identical (client A context)", () => {
  const { ranked, dropped } = rankChunks({
    chunks: LEX_POOL,
    queryVectors: [],
    standaloneQuery: "reconcile bank statement",
    clientId: "clientA"
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes("LA"));
  assert.ok(!ids.includes("LB"), "other client leaked in lexical mode");
  assert.ok(!ids.includes("LU"), "unclassified leaked in lexical mode");
  const droppedIds = dropped.map((d) => d.id).sort();
  assert.deepEqual(droppedIds, ["LB", "LU"]);
});
test("lexical mode: a client name in the query never widens scope", () => {
  const { ranked } = rankChunks({
    chunks: LEX_POOL,
    queryVectors: [],
    standaloneQuery: "what is Beta reconcile bank statement day for Beta",
    clientId: "clientA"
  });
  assert.ok(!ranked.map((r) => r.chunk.id).includes("LB"));
});
test("lexical mode: vectors present but no chunk has an embedding -> semanticActive false", () => {
  const { semanticActive } = rankChunks({
    chunks: LEX_POOL,
    queryVectors: [[1, 0, 0, 0]],
    standaloneQuery: "reconcile bank",
    clientId: null
  });
  assert.equal(semanticActive, false);
});
test("lexical mode: chunks without an embedding field do not crash ranking", () => {
  assert.doesNotThrow(() => rankChunks({
    chunks: LEX_POOL,
    queryVectors: [],
    standaloneQuery: "bank",
    clientId: null
  }));
});
test("THRESHOLDS.lexical is centralized and complete (Phase 4.1 term-based keys)", () => {
  const L = THRESHOLDS.lexical;
  for (const k of [
    "insufficientIfLexBelow",
    "minMatchedTermsToAnswer",
    "highIfLexAtLeast",
    "highMinMatchedTerms",
    "highMinQueryTerms",
    "gateMinBestLex",
    "gateMinBestHits"
  ]) {
    assert.equal(typeof L[k], "number", `missing THRESHOLDS.lexical.${k}`);
  }
  assert.equal(typeof THRESHOLDS.rewriteDrift.rawMaxContentTerms, "number");
  assert.equal(typeof THRESHOLDS.rewriteDrift.minNewRewriteTerms, "number");
  assert.equal(L.corroborationLexAtLeast, void 0);
  assert.equal(L.highMinChunks, void 0);
});
var row = (lex2, lexHits, lexQueryTermCount) => ({ lex: lex2, lexHits, lexQueryTermCount });
test("pickConfidence lexical: LOW needs no row with minimal coherent overlap", () => {
  const opt = { semanticActive: false };
  assert.equal(pickConfidence([], opt), "low");
  assert.equal(pickConfidence([row(0.1, 1, 5)], opt), "low", "lex below insufficient floor");
  assert.equal(pickConfidence([row(0, 0, 5)], opt), "low", "no matched terms");
  assert.equal(pickConfidence([row(0.3, 2, 5)], opt), "medium", "clears LOW, not HIGH");
});
test("pickConfidence lexical: HIGH needs ONE row to clear all three bars", () => {
  const opt = { semanticActive: false };
  assert.equal(pickConfidence([row(0.6, 3, 4)], opt), "high");
  assert.equal(
    pickConfidence([row(0.6, 1, 4), row(0.2, 3, 4)], opt),
    "medium",
    "high lex on one row + high hits on another must NOT combine to HIGH"
  );
  assert.equal(pickConfidence([row(0.8, 1, 5), row(0.2, 2, 5)], opt), "medium");
});
test("pickConfidence lexical: short/generic queries cannot reach HIGH from fractional overlap", () => {
  const opt = { semanticActive: false };
  assert.equal(pickConfidence([row(1, 1, 1)], opt), "medium", "1-word -> never HIGH");
  assert.equal(pickConfidence([row(1, 2, 2)], opt), "medium", "qTC 2 < 3 -> never HIGH");
  assert.equal(pickConfidence([row(0.67, 2, 3)], opt), "high", "3 terms, 2 matched, lex>=0.45 -> HIGH (coherent)");
});
test("pickConfidence lexical: per-row denominator is that row's own", () => {
  const opt = { semanticActive: false };
  assert.equal(pickConfidence([row(0.5, 1, 2)], opt), "medium");
  assert.equal(pickConfidence([row(1, 1, 1)], opt), "medium");
});
test("pickConfidence default (no opts) keeps the original semantic behavior", () => {
  const { ranked } = rankChunks({
    chunks: POOL,
    queryVectors: Q_OFFTOPIC,
    standaloneQuery: "company holiday policy",
    clientId: null
  });
  assert.equal(pickConfidence(ranked), "low");
});
test("planRetrieval: lexical mode never calls the provider", () => {
  assert.deepEqual(planRetrieval("lexical", true), { attemptEmbed: false, requireEmbed: false });
  assert.deepEqual(planRetrieval("lexical", false), { attemptEmbed: false, requireEmbed: false });
});
test("planRetrieval: auto with NO key skips embed() entirely -> lexical", () => {
  assert.deepEqual(planRetrieval("auto", false), { attemptEmbed: false, requireEmbed: false });
});
test("planRetrieval: auto WITH key attempts embed(), still soft-fails", () => {
  assert.deepEqual(planRetrieval("auto", true), { attemptEmbed: true, requireEmbed: false });
});
test("planRetrieval: semantic hard-requires embeddings", () => {
  assert.deepEqual(planRetrieval("semantic", false), { attemptEmbed: false, requireEmbed: true });
  assert.deepEqual(planRetrieval("semantic", true), { attemptEmbed: true, requireEmbed: true });
});
test("planRetrieval: unknown / missing mode behaves as auto", () => {
  assert.deepEqual(planRetrieval("garbage", true), { attemptEmbed: true, requireEmbed: false });
  assert.deepEqual(planRetrieval(void 0, false), { attemptEmbed: false, requireEmbed: false });
  assert.deepEqual(planRetrieval(null, true), { attemptEmbed: true, requireEmbed: false });
});
test("rankChunks still returns dropped as scope-violations-only, plus a filteredOut array", () => {
  const { dropped, filteredOut } = rankChunks({
    chunks: POOL,
    queryVectors: Q_RECON,
    standaloneQuery: "reconcile bank statement",
    clientId: null
  });
  assert.deepEqual(dropped.map((d) => d.id).sort(), ["A1", "B1", "U1"]);
  assert.ok(Array.isArray(filteredOut));
  assert.equal(filteredOut.length, 0);
});
test("rankChunks with no governance option still drops a superseded chunk into filteredOut", () => {
  const pool = [
    ...POOL,
    chunk({
      id: "OLD",
      training_id: "t-recon",
      knowledge_scope: "general",
      chunk_type: "sop_step",
      content: "Superseded reconciliation steps from an old version.",
      is_active_version: false,
      embedding: [0.98, 0.1, 0, 0]
    })
  ];
  const { ranked, filteredOut } = rankChunks({
    chunks: pool,
    queryVectors: Q_RECON,
    standaloneQuery: "reconcile bank statement",
    clientId: null
  });
  assert.ok(!ranked.map((r) => r.chunk.id).includes("OLD"));
  assert.deepEqual(filteredOut, [{ id: "OLD", training_id: "t-recon", reason: "superseded" }]);
});
