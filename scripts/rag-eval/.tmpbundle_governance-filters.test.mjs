// scripts/rag-eval/governance-filters.test.mjs
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
function isEffective(chunk, now = Date.now()) {
  const from = chunk.effective_from ? Date.parse(chunk.effective_from) : NaN;
  if (!Number.isNaN(from) && now < from) return false;
  const until = chunk.effective_until ? Date.parse(chunk.effective_until) : NaN;
  if (!Number.isNaN(until) && now > until) return false;
  return true;
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

// base44/shared/governance.ts
function lifecycleSkipReason(src) {
  if (src.is_active_version === false) return "superseded";
  if (src.verification_status === "rejected") return "rejected";
  if (src.is_archived === true) return "archived";
  return null;
}
function buildGovFields(src, processFreshnessStatus) {
  return {
    source_authority: src.source_authority || void 0,
    verification_status: src.verification_status || void 0,
    ingestion_quality: src.ingestion_quality || void 0,
    is_active_version: src.is_active_version === false ? false : void 0,
    effective_from: src.effective_from || void 0,
    effective_until: src.effective_until || void 0,
    source_is_archived: src.is_archived === true ? true : void 0,
    version_number: typeof src.version_number === "number" ? src.version_number : void 0,
    operational_process_id: src.operational_process_id || void 0,
    department: src.department || void 0,
    process_freshness_status: processFreshnessStatus || void 0,
    // Phase 6: lineage grouping only. NOT index_stale — that flag is managed
    // explicitly by embedKnowledge's mark_stale / clear_stale / build_staged
    // sub-commands so a legacy full reindex never leaves chunks dark.
    root_source_id: src.root_source_id || src.id || void 0
  };
}

// scripts/rag-eval/governance-filters.test.mjs
var DAY = 864e5;
var NOW = Date.parse("2026-06-15T00:00:00Z");
var iso = (ms) => new Date(ms).toISOString();
var gc = (o) => ({
  training_id: o.training_id || o.id,
  chunk_index: 0,
  chunk_type: o.chunk_type || "sop_step",
  content: o.content || `reconcile the bank statement against the ledger \u2014 passage ${o.id}`,
  title: o.title || o.id,
  content_hash: o.id,
  knowledge_scope: "general",
  keywords: o.keywords || ["reconcile", "bank", "statement", "ledger"],
  ...o
});
test("lifecycleSkipReason: indexable source -> null", () => {
  assert.equal(lifecycleSkipReason({}), null);
  assert.equal(lifecycleSkipReason({ is_active_version: true, verification_status: "verified" }), null);
});
test("lifecycleSkipReason: superseded > rejected > archived (first match)", () => {
  assert.equal(lifecycleSkipReason({ is_active_version: false }), "superseded");
  assert.equal(lifecycleSkipReason({ verification_status: "rejected" }), "rejected");
  assert.equal(lifecycleSkipReason({ is_archived: true }), "archived");
  assert.equal(
    lifecycleSkipReason({ is_active_version: false, verification_status: "rejected", is_archived: true }),
    "superseded"
  );
});
test("lifecycleSkipReason: needs_review is NOT an index-time skip", () => {
  assert.equal(lifecycleSkipReason({ ingestion_quality: "needs_review" }), null);
});
test("buildGovFields: legacy source -> every field undefined", () => {
  const g = buildGovFields({}, "");
  assert.deepEqual(Object.values(g).filter((v) => v !== void 0), []);
});
test("buildGovFields: populated source is denormalized; process freshness comes from the arg", () => {
  const g = buildGovFields({
    source_authority: "policy",
    verification_status: "verified",
    ingestion_quality: "ok",
    effective_from: "2026-01-01T00:00:00Z",
    version_number: 3,
    operational_process_id: "proc_1",
    department: "Finance"
  }, "stale");
  assert.equal(g.source_authority, "policy");
  assert.equal(g.verification_status, "verified");
  assert.equal(g.version_number, 3);
  assert.equal(g.operational_process_id, "proc_1");
  assert.equal(g.process_freshness_status, "stale");
  assert.equal(g.is_active_version, void 0);
  assert.equal(g.source_is_archived, void 0);
});
test("buildGovFields: version_number must be a number, not a stringy value", () => {
  assert.equal(buildGovFields({ version_number: 0 }).version_number, 0);
  assert.equal(buildGovFields({ version_number: void 0 }).version_number, void 0);
  assert.equal(buildGovFields({ version_number: "x" }).version_number, void 0);
});
test("isEffective: missing bounds -> always effective", () => {
  assert.equal(isEffective(gc({ id: "x" }), NOW), true);
});
test("isEffective: future effective_from -> not effective", () => {
  assert.equal(isEffective(gc({ id: "x", effective_from: iso(NOW + 10 * DAY) }), NOW), false);
});
test("isEffective: past effective_until -> not effective", () => {
  assert.equal(isEffective(gc({ id: "x", effective_until: iso(NOW - 10 * DAY) }), NOW), false);
});
test("isEffective: now inside the window -> effective", () => {
  const c = gc({ id: "x", effective_from: iso(NOW - DAY), effective_until: iso(NOW + DAY) });
  assert.equal(isEffective(c, NOW), true);
});
test("isEffective: unparseable dates are not a constraint", () => {
  assert.equal(isEffective(gc({ id: "x", effective_from: "garbage", effective_until: "nonsense" }), NOW), true);
});
test("legacy chunk with no governance metadata is always kept", () => {
  const { kept, filteredOut } = applyGovernanceFilters([gc({ id: "legacy" })], { now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(filteredOut.length, 0);
});
test("is_active_version === false -> dropped (superseded), missing/true kept", () => {
  const pool = [
    gc({ id: "old", is_active_version: false }),
    gc({ id: "cur", is_active_version: true }),
    gc({ id: "unset" })
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ["cur", "unset"]);
  assert.deepEqual(filteredOut, [{ id: "old", training_id: "old", reason: "superseded" }]);
});
test("source_is_archived === true -> dropped (archived), missing/false kept", () => {
  const pool = [gc({ id: "arch", source_is_archived: true }), gc({ id: "live", source_is_archived: false }), gc({ id: "unset" })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ["live", "unset"]);
  assert.equal(filteredOut[0].reason, "archived");
});
test("verification_status === 'rejected' -> dropped REGARDLESS of require_verification flag", () => {
  const pool = [gc({ id: "rej", verification_status: "rejected" })];
  for (const requireVerified of [false, true, void 0]) {
    const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireVerified });
    assert.equal(kept.length, 0, `rejected leaked with requireVerified=${requireVerified}`);
    assert.equal(filteredOut[0].reason, "rejected");
  }
});
test("Phase 6: index_stale === true -> always dropped (reason index_stale), checked first", () => {
  const pool = [
    gc({ id: "live" }),
    gc({ id: "stale", index_stale: true }),
    gc({ id: "staleAndSuperseded", index_stale: true, is_active_version: false }),
    gc({ id: "missing" })
    // no index_stale field -> retrievable
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ["live", "missing"]);
  const byId = Object.fromEntries(filteredOut.map((f) => [f.id, f.reason]));
  assert.equal(byId.stale, "index_stale");
  assert.equal(byId.staleAndSuperseded, "index_stale");
});
test("Phase 6: retrieval never depends on any Training.index_status-like field on the chunk", () => {
  const { kept } = applyGovernanceFilters([gc({ id: "x", index_status: "failed" })], { now: NOW });
  assert.equal(kept.length, 1);
});
for (const mode of ["semantic", "lexical"]) {
  const mk = mode === "semantic" ? (o) => gc({ ...o, embedding: [1, 0, 0, 0] }) : gc;
  const qv = mode === "semantic" ? [[1, 0, 0, 0]] : [];
  test(`[${mode}] rankChunks drops index_stale chunks in both modes (parity)`, () => {
    const pool = [
      mk({ id: "ok", training_id: "t1" }),
      mk({ id: "stale", training_id: "t2", index_stale: true })
    ];
    const { ranked, filteredOut } = rankChunks({ chunks: pool, queryVectors: qv, standaloneQuery: "reconcile bank statement ledger", clientId: null });
    assert.deepEqual(ranked.map((r) => r.chunk.id), ["ok"]);
    assert.equal(filteredOut.find((f) => f.id === "stale")?.reason, "index_stale");
  });
}
test("effective window: future-dated -> not_yet_effective, expired -> expired", () => {
  const pool = [
    gc({ id: "future", effective_from: iso(NOW + 5 * DAY) }),
    gc({ id: "expired", effective_until: iso(NOW - 5 * DAY) }),
    gc({ id: "inwindow", effective_from: iso(NOW - DAY), effective_until: iso(NOW + DAY) })
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id), ["inwindow"]);
  assert.deepEqual(
    filteredOut.map((f) => [f.id, f.reason]).sort(),
    [["expired", "expired"], ["future", "not_yet_effective"]]
  );
});
test("require_verification_for_retrieval OFF (default): unverified + missing are kept", () => {
  const pool = [gc({ id: "v", verification_status: "verified" }), gc({ id: "u", verification_status: "unverified" }), gc({ id: "m" })];
  const { kept } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ["m", "u", "v"]);
});
test("require_verification_for_retrieval ON: only verified survives; missing/unverified -> unverified reason", () => {
  const pool = [gc({ id: "v", verification_status: "verified" }), gc({ id: "u", verification_status: "unverified" }), gc({ id: "m" })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireVerified: true });
  assert.deepEqual(kept.map((c) => c.id), ["v"]);
  assert.deepEqual(filteredOut.map((f) => f.reason).sort(), ["unverified", "unverified"]);
});
test("require_ingestion_review OFF (default): needs_review is kept", () => {
  const { kept } = applyGovernanceFilters([gc({ id: "nr", ingestion_quality: "needs_review" })], { now: NOW });
  assert.equal(kept.length, 1);
});
test("require_ingestion_review ON: needs_review -> dropped; ok/missing kept", () => {
  const pool = [gc({ id: "nr", ingestion_quality: "needs_review" }), gc({ id: "ok", ingestion_quality: "ok" }), gc({ id: "m" })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireIngestionOk: true });
  assert.deepEqual(kept.map((c) => c.id).sort(), ["m", "ok"]);
  assert.equal(filteredOut[0].reason, "needs_review");
});
test('first-match ordering: superseded + archived + rejected chunk reports "superseded"', () => {
  const c = gc({ id: "triple", is_active_version: false, source_is_archived: true, verification_status: "rejected" });
  const { filteredOut } = applyGovernanceFilters([c], { now: NOW });
  assert.equal(filteredOut[0].reason, "superseded");
});
var VEC = [1, 0, 0, 0];
var withVec = (o) => gc({ ...o, embedding: VEC });
var Q = "reconcile bank statement ledger";
for (const mode of ["semantic", "lexical"]) {
  const mk = mode === "semantic" ? withVec : gc;
  const queryVectors = mode === "semantic" ? [VEC] : [];
  test(`[${mode}] governance filter runs with NO governance option (superseded/archived/rejected still dropped)`, () => {
    const pool = [
      mk({ id: "ok1", training_id: "t1" }),
      mk({ id: "sup", training_id: "t2", is_active_version: false }),
      mk({ id: "arc", training_id: "t3", source_is_archived: true }),
      mk({ id: "rej", training_id: "t4", verification_status: "rejected" })
    ];
    const { ranked, filteredOut } = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    const ids = ranked.map((r) => r.chunk.id);
    assert.deepEqual(ids, ["ok1"]);
    assert.deepEqual(filteredOut.map((f) => f.reason).sort(), ["archived", "rejected", "superseded"]);
  });
  test(`[${mode}] filteredOut carries { id, training_id, reason }`, () => {
    const pool = [mk({ id: "a", training_id: "tA" }), mk({ id: "b", training_id: "tB", is_active_version: false })];
    const { filteredOut } = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(filteredOut, [{ id: "b", training_id: "tB", reason: "superseded" }]);
  });
  test(`[${mode}] scope is enforced BEFORE governance \u2014 other-client chunk is a scope drop, not a governance drop`, () => {
    const pool = [
      mk({ id: "gen", training_id: "t-gen" }),
      mk({
        id: "other",
        training_id: "t-other",
        knowledge_scope: "client-specific",
        client_id: "clientB",
        is_active_version: true,
        verification_status: "verified",
        source_authority: "policy"
      })
    ];
    const { ranked, dropped, filteredOut } = rankChunks({
      chunks: pool,
      queryVectors,
      standaloneQuery: Q,
      clientId: "clientA"
    });
    assert.deepEqual(ranked.map((r) => r.chunk.id), ["gen"]);
    assert.deepEqual(dropped.map((d) => d.id), ["other"]);
    assert.equal(filteredOut.length, 0);
  });
  test(`[${mode}] require_verification gate applied through rankChunks`, () => {
    const pool = [
      mk({ id: "v", training_id: "t1", verification_status: "verified" }),
      mk({ id: "u", training_id: "t2", verification_status: "unverified" })
    ];
    const off = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(off.ranked.map((r) => r.chunk.id).sort(), ["u", "v"]);
    const on = rankChunks({
      chunks: pool,
      queryVectors,
      standaloneQuery: Q,
      clientId: null,
      governance: { requireVerified: true }
    });
    assert.deepEqual(on.ranked.map((r) => r.chunk.id), ["v"]);
    assert.equal(on.filteredOut[0].reason, "unverified");
  });
  test(`[${mode}] authority nudge reorders a tie; reverts when rankingEnabled=false`, () => {
    const pool = [
      mk({ id: "N", training_id: "tN", source_authority: "notes" }),
      mk({ id: "P", training_id: "tP", source_authority: "policy" })
    ];
    const nudged = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(nudged.ranked.map((r) => r.chunk.id), ["P", "N"], "policy authority should win the tie");
    const flat = rankChunks({
      chunks: pool,
      queryVectors,
      standaloneQuery: Q,
      clientId: null,
      governance: { rankingEnabled: false }
    });
    assert.deepEqual(flat.ranked.map((r) => r.chunk.id), ["N", "P"], "with nudges off, input order stands");
  });
  test(`[${mode}] freshness penalty ranks a stale-process chunk below an equal current one`, () => {
    const pool = [
      mk({ id: "STALE", training_id: "tS", process_freshness_status: "stale" }),
      mk({ id: "CUR", training_id: "tC", process_freshness_status: "current" })
    ];
    const nudged = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(nudged.ranked.map((r) => r.chunk.id), ["CUR", "STALE"]);
    const flat = rankChunks({
      chunks: pool,
      queryVectors,
      standaloneQuery: Q,
      clientId: null,
      governance: { rankingEnabled: false }
    });
    assert.deepEqual(flat.ranked.map((r) => r.chunk.id), ["STALE", "CUR"]);
  });
  test(`[${mode}] nudges never overtake a real relevance gap`, () => {
    const hi = mk({
      id: "HI",
      training_id: "tHI",
      source_authority: "notes",
      content: "reconcile bank statement ledger discrepancy monthly close",
      keywords: ["reconcile", "bank", "statement", "ledger"]
    });
    const lo = mode === "semantic" ? gc({
      id: "LO",
      training_id: "tLO",
      source_authority: "policy",
      embedding: [0, 0, 0, 1],
      content: "office holiday schedule and parking",
      keywords: ["holiday", "parking"]
    }) : gc({
      id: "LO",
      training_id: "tLO",
      source_authority: "policy",
      content: "office holiday schedule and parking",
      keywords: ["holiday", "parking"]
    });
    const { ranked } = rankChunks({ chunks: [lo, hi], queryVectors, standaloneQuery: Q, clientId: null });
    assert.equal(ranked[0].chunk.id, "HI", "a high-authority but irrelevant chunk must not outrank the relevant one");
  });
  test(`[${mode}] pickConfidence is unaffected by governance filtering`, () => {
    const pool = [
      mk({ id: "a", training_id: "t1" }),
      mk({ id: "b", training_id: "t2" }),
      mk({ id: "sup", training_id: "t3", is_active_version: false })
    ];
    const semantic = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    const conf = pickConfidence(semantic.ranked, { semanticActive: semantic.semanticActive });
    assert.ok(["low", "medium", "high"].includes(conf));
  });
}
test("semantic and lexical modes produce the SAME governance kept/dropped sets", () => {
  const base = [
    { id: "keep", training_id: "t1", verification_status: "verified" },
    { id: "sup", training_id: "t2", is_active_version: false },
    { id: "arc", training_id: "t3", source_is_archived: true },
    { id: "rej", training_id: "t4", verification_status: "rejected" },
    { id: "future", training_id: "t5", effective_from: iso(NOW + 5 * DAY) },
    { id: "unver", training_id: "t6", verification_status: "unverified" }
  ];
  const sem = rankChunks({
    chunks: base.map((o) => gc({ ...o, embedding: VEC })),
    queryVectors: [VEC],
    standaloneQuery: Q,
    clientId: null,
    governance: { requireVerified: true, now: NOW }
  });
  const lex = rankChunks({
    chunks: base.map((o) => gc(o)),
    queryVectors: [],
    standaloneQuery: Q,
    clientId: null,
    governance: { requireVerified: true, now: NOW }
  });
  assert.deepEqual(
    sem.ranked.map((r) => r.chunk.id).sort(),
    lex.ranked.map((r) => r.chunk.id).sort()
  );
  assert.deepEqual(
    sem.filteredOut.map((f) => [f.id, f.reason]).sort(),
    lex.filteredOut.map((f) => [f.id, f.reason]).sort()
  );
  assert.deepEqual(lex.ranked.map((r) => r.chunk.id), ["keep"]);
});
