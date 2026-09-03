// scripts/rag-eval/client-scoping.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/governance.ts
function buildScopeFields(src) {
  const scope = src.knowledge_scope || "unclassified";
  return {
    knowledge_scope: scope,
    client_id: scope === "client-specific" ? src.client_id : void 0,
    title: src.title || "",
    topic_category: src.topic_category || src.category || "",
    client_segment: src.client_segment || ""
  };
}
function scopeFieldsDrift(chunk, scopeFields, chunkIndex) {
  const drift = {};
  if ((chunk.knowledge_scope || "") !== scopeFields.knowledge_scope) {
    drift.knowledge_scope = scopeFields.knowledge_scope;
  }
  if ((chunk.client_id || void 0) !== scopeFields.client_id) {
    drift.client_id = scopeFields.client_id ?? null;
  }
  if ((chunk.chunk_index ?? -1) !== chunkIndex) drift.chunk_index = chunkIndex;
  if ((chunk.title || "") !== scopeFields.title) drift.title = scopeFields.title;
  if ((chunk.topic_category || "") !== scopeFields.topic_category) {
    drift.topic_category = scopeFields.topic_category;
  }
  if ((chunk.client_segment || "") !== scopeFields.client_segment) {
    drift.client_segment = scopeFields.client_segment;
  }
  return drift;
}

// base44/shared/retrieval.ts
var WEIGHTS = { sem: 0.72, lex: 0.28, clientBoost: 0.04 };
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

// scripts/rag-eval/client-scoping.test.mjs
var JLM = "client-jlm";
var GBP = "client-gbp";
var INVOICE_SRC_ID = "training-invoice-workflow";
var invoiceSource = {
  id: INVOICE_SRC_ID,
  title: "Invoice Workflow",
  knowledge_scope: "client-specific",
  client_id: JLM,
  topic_category: "Bookkeeping",
  client_segment: "Small Business"
};
test("buildScopeFields: client-specific source stamps scope + exact client_id", () => {
  const f = buildScopeFields(invoiceSource);
  assert.equal(f.knowledge_scope, "client-specific");
  assert.equal(f.client_id, JLM);
  assert.equal(f.title, "Invoice Workflow");
  assert.equal(f.topic_category, "Bookkeeping");
});
test("buildScopeFields: general source leaves client_id unset; missing scope -> unclassified", () => {
  assert.equal(buildScopeFields({ title: "X", knowledge_scope: "general" }).client_id, void 0);
  assert.equal(buildScopeFields({ title: "X" }).knowledge_scope, "unclassified");
});
var draftContents = [
  "JLM invoice draw dashboard: pull the draw request from the JLM portal before posting the invoice",
  "Post the JLM invoice against the draw schedule and attach the wire confirmation"
];
var indexedChunks = draftContents.map((content, i) => ({
  id: `chunk-${i}`,
  training_id: INVOICE_SRC_ID,
  chunk_index: i,
  chunk_type: "sop_step",
  content,
  content_hash: `hash-${i}`,
  keywords: ["jlm", "invoice", "draw"],
  created_date: "2026-09-01T00:00:00Z",
  ...buildScopeFields(invoiceSource)
}));
test("indexed chunks: every chunk inherits client scope, exact client_id, and source id/title", () => {
  for (const c of indexedChunks) {
    assert.equal(c.knowledge_scope, "client-specific");
    assert.equal(c.client_id, JLM);
    assert.equal(c.training_id, INVOICE_SRC_ID);
    assert.equal(c.title, "Invoice Workflow");
    assert.ok(c.content.length > 0);
  }
});
test("scopeFieldsDrift: chunk with blanked client_id is re-stamped with the source client_id", () => {
  const drifted = { ...indexedChunks[0], client_id: void 0, knowledge_scope: "general" };
  const drift = scopeFieldsDrift(drifted, buildScopeFields(invoiceSource), 0);
  assert.equal(drift.client_id, JLM);
  assert.equal(drift.knowledge_scope, "client-specific");
});
test("scopeFieldsDrift: idempotent re-index of correctly stamped chunk writes nothing", () => {
  const drift = scopeFieldsDrift(indexedChunks[0], buildScopeFields(invoiceSource), 0);
  assert.equal(Object.keys(drift).length, 0, `expected no drift, got ${JSON.stringify(drift)}`);
});
test("scopeFieldsDrift: reclassify to general clears the stale client_id", () => {
  const generalFields = buildScopeFields({ ...invoiceSource, knowledge_scope: "general", client_id: null });
  const drift = scopeFieldsDrift(indexedChunks[0], generalFields, 0);
  assert.equal(drift.client_id, null);
  assert.equal(drift.knowledge_scope, "general");
});
var generalChunk = {
  id: "chunk-general",
  training_id: "training-general",
  chunk_index: 0,
  chunk_type: "sop_step",
  content: "Standard invoice workflow: match the invoice to the purchase order before posting it",
  content_hash: "hash-general",
  keywords: ["invoice", "workflow", "posting"],
  knowledge_scope: "general",
  ...buildScopeFields({ title: "General invoicing basics", knowledge_scope: "general" })
};
var unclassifiedChunk = {
  id: "chunk-unclassified",
  training_id: "training-unclassified",
  chunk_index: 0,
  chunk_type: "sop_step",
  content: "JLM invoice draw dashboard shortcut never indexed on purpose",
  content_hash: "hash-unclassified",
  keywords: ["jlm", "invoice", "draw"]
};
var gbpChunk = {
  id: "chunk-gbp",
  training_id: "training-gbp",
  chunk_index: 0,
  chunk_type: "sop_step",
  content: "GBP invoice draw dashboard posting rules for the GBP portal",
  content_hash: "hash-gbp",
  keywords: ["gbp", "invoice", "draw"],
  ...buildScopeFields({ title: "GBP invoicing", knowledge_scope: "client-specific", client_id: GBP })
};
var QUERY = "JLM invoice draw dashboard posting";
var lexRank = (clientId) => rankChunks({
  chunks: [...indexedChunks, generalChunk, unclassifiedChunk, gbpChunk],
  queryVectors: [],
  // lexical-only mode: no embeddings key
  standaloneQuery: QUERY,
  clientId
});
test("lexical retrieval with JLM context retrieves the client-specific chunks", () => {
  const { ranked } = lexRank(JLM);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes("chunk-0") || ids.includes("chunk-1"), `JLM chunks not retrieved: ${ids}`);
});
test("lexical retrieval with JLM context: general still usable, unclassified excluded, no GBP leakage", () => {
  const { ranked } = lexRank(JLM);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes("chunk-general"), "general knowledge must remain retrievable");
  assert.ok(!ids.includes("chunk-unclassified"), "unclassified chunk must never be retrieved");
  assert.ok(!ids.includes("chunk-gbp"), "cross-client leakage");
});
test("lexical retrieval with another client context does NOT retrieve the JLM chunks", () => {
  const { ranked } = lexRank(GBP);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes("chunk-0") && !ids.includes("chunk-1"), `JLM chunks leaked to GBP context: ${ids}`);
  assert.ok(ids.includes("chunk-gbp"));
});
test("lexical retrieval with NO client context excludes all client-specific chunks", () => {
  const { ranked } = lexRank(null);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes("chunk-0") && !ids.includes("chunk-1") && !ids.includes("chunk-gbp"));
  assert.ok(ids.includes("chunk-general"));
});
