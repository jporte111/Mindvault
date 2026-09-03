// scripts/rag-eval/knowledge-gap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// base44/shared/knowledgeGap.ts
var GAP_DEDUP_JACCARD = 0.5;
var GAP_OPEN_MIN_ASKED = 3;
var GAP_OPEN_MIN_REPORTERS = 2;
var EXAMPLE_QUESTIONS_CAP = 5;
var REPORTER_HMACS_CAP = 20;
var RELATED_SOURCES_CAP = 40;
var GAP_ORIGINS = [
  "explicit_feedback",
  "answer_status_partial",
  "answer_status_insufficient",
  "clarification",
  "manual"
];
var GAP_ACCRUING_FEEDBACK = /* @__PURE__ */ new Set([
  "didnt_answer",
  "missing_detail",
  "incorrect_or_outdated"
]);
function feedbackAccruesGap(t) {
  return GAP_ACCRUING_FEEDBACK.has(t);
}
var STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or off that the their them then there these they this to was were what when where which who via per will with you your our we do does did done not can cannot could should would may might must about so no yes than too very just also more most such only own same each any all some other new get got getting need needs needed want wants please thanks thank tell show give me my mine our ours us here now still again already ever whether question answer info information detail details".split(" ")
);
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.endsWith("edly")) w = w.slice(0, -4);
  else if (w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("es")) w = w.slice(0, -2);
  else if (w.endsWith("tion")) w = w.slice(0, -3);
  else if (w.endsWith("sion")) w = w.slice(0, -4) + "s";
  else if (w.endsWith("ency")) w = w.slice(0, -4) + "ent";
  else if (w.endsWith("ancy")) w = w.slice(0, -4) + "ant";
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5) {
    if (w.endsWith("al")) w = w.slice(0, -2);
    else if (w.endsWith("ly")) w = w.slice(0, -2);
    else if (w.endsWith("ity")) w = w.slice(0, -3);
    else if (w.endsWith("ance") || w.endsWith("ence")) w = w.slice(0, -4);
  }
  return w;
}
function topicKeywords(text) {
  const set = /* @__PURE__ */ new Set();
  for (const raw of (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) || []) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length >= 3 && !STOPWORDS.has(s)) set.add(s);
  }
  return [...set].sort();
}
function normalizeTopic(text) {
  return topicKeywords(text).join(" ");
}
function topicSignature(normalizedTopic) {
  let h = 2166136261;
  const s = normalizedTopic || "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function jaccard(a, b) {
  if (!a?.length && !b?.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
function parseClientScope(scope) {
  if (typeof scope === "string" && scope.startsWith("client:")) {
    return { clientId: scope.slice("client:".length) || null };
  }
  return { clientId: null };
}
function shouldDedupe(incoming2, gap, jaccardThreshold = GAP_DEDUP_JACCARD) {
  if (incoming2.clientScope !== (gap.client_scope || "")) return false;
  const exactMatch = !!incoming2.normalizedTopic && incoming2.normalizedTopic === (gap.normalized_topic || "");
  const fuzzyMatch = jaccard(incoming2.keywords, gap.topic_keywords || []) >= jaccardThreshold;
  if (!exactMatch && !fuzzyMatch) return false;
  const gp = gap.operational_process_id || null;
  const processCompatible = !incoming2.processId || !gp || incoming2.processId === gp;
  return processCompatible;
}
function promotionState(timesAsked, distinctReporters, minAsked = GAP_OPEN_MIN_ASKED, minReporters = GAP_OPEN_MIN_REPORTERS) {
  return timesAsked >= minAsked && distinctReporters >= minReporters ? "open" : "candidate";
}
function unionCap(existing, incoming2, cap) {
  const out = [...existing || []];
  const seen = new Set(out);
  for (const v of incoming2 || []) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
      if (out.length >= cap) break;
    }
  }
  return out;
}
function mergeGapUpdate(gap, event) {
  const prevAsked = gap.times_asked || 0;
  const timesAsked = prevAsked + 1;
  const hmacs = gap.reporter_hmacs || [];
  const isNewReporter = !hmacs.includes(event.reporterHmac);
  const reporterHmacs = isNewReporter && hmacs.length < REPORTER_HMACS_CAP ? [...hmacs, event.reporterHmac] : hmacs;
  const prevDistinct = gap.distinct_reporters || hmacs.length || 1;
  const distinctReporters = Math.min(
    REPORTER_HMACS_CAP,
    prevDistinct + (isNewReporter ? 1 : 0)
  );
  const patch = {
    times_asked: timesAsked,
    last_seen_at: event.now,
    distinct_reporters: distinctReporters,
    reporter_hmacs: reporterHmacs,
    related_source_ids: unionCap(gap.related_source_ids || [], event.sourceIds || [], RELATED_SOURCES_CAP),
    missing_facets: unionCap(gap.missing_facets || [], event.missingFacets || [], 40),
    origins: unionCap(gap.origins || [], [event.origin], GAP_ORIGINS.length)
  };
  if (event.exampleQuestion) {
    const examples = gap.example_questions || [];
    if (!examples.includes(event.exampleQuestion) && examples.length < EXAMPLE_QUESTIONS_CAP) {
      patch.example_questions = [...examples, event.exampleQuestion];
    }
  }
  if ((gap.status || "candidate") === "candidate") {
    const next = promotionState(timesAsked, distinctReporters);
    if (next === "open") patch.status = "open";
  }
  return patch;
}
function newGapFields(event) {
  return {
    title: event.title || event.normalizedTopic || "Untitled gap",
    normalized_topic: event.normalizedTopic,
    topic_keywords: event.keywords,
    topic_signature: event.signature,
    client_scope: event.clientScope,
    client_id: event.clientId ?? void 0,
    operational_process_id: event.processId ?? void 0,
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
    priority: "low"
  };
}
function resolutionRequiresSource(resolutionType) {
  return resolutionType === "source_updated" || resolutionType === "new_source_added";
}
function sourceSatisfiesResolution(source, gapClientScope) {
  if (source.verification_status !== "verified") return { ok: false, reason: "not_verified" };
  if (source.is_active_version === false) return { ok: false, reason: "superseded" };
  if (source.is_archived === true) return { ok: false, reason: "archived" };
  const { clientId: gapClientId } = parseClientScope(gapClientScope);
  if (gapClientId) {
    if (source.knowledge_scope !== "client-specific" || (source.client_id || null) !== gapClientId) {
      return { ok: false, reason: "scope_mismatch" };
    }
  } else {
    if (source.knowledge_scope !== "general") return { ok: false, reason: "scope_mismatch" };
  }
  return { ok: true };
}

// scripts/rag-eval/knowledge-gap.test.mjs
test("knowledgeGap.ts has NO imports and no embeddings call (pure, node-loadable)", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../base44/shared/knowledgeGap.ts"),
    "utf8"
  );
  assert.equal(src.match(/^\s*import\s/m), null, "knowledgeGap.ts must not import anything");
  assert.equal(/\bembed\s*\(/.test(src), false, "no embed() call");
  assert.equal(/from\s+['"][^'"]*embeddings/.test(src), false, "does not pull in the embeddings module");
});
test("normalizeTopic: deterministic, stopword + short-word stripped, stemmed, sorted", () => {
  const a = normalizeTopic("How do I reconcile the monthly bank statements?");
  assert.equal(a, normalizeTopic("How do I reconcile the monthly bank statements?"));
  assert.deepEqual(a.split(" ").sort(), a.split(" "));
  assert.ok(!a.includes("how") && !a.includes("the"), "stopwords removed");
  assert.ok(a.includes("reconcil"), `stemmed 'reconcile'/'statements' -> got "${a}"`);
});
test("normalizeTopic: paraphrases land within the Jaccard threshold", () => {
  const a = topicKeywords("who approves emergency vendor payments");
  const b = topicKeywords("who signs off on urgent vendor payment approval");
  const j = jaccard(a, b);
  assert.ok(j >= GAP_DEDUP_JACCARD, `expected paraphrase overlap >= ${GAP_DEDUP_JACCARD}, got ${j} for ${JSON.stringify([a, b])}`);
  assert.equal(shouldDedupe({ clientScope: "general", normalizedTopic: a.join(" "), signature: "x", keywords: a, processId: null }, { client_scope: "general", normalized_topic: b.join(" "), topic_keywords: b, operational_process_id: null }), true);
});
test("normalizeTopic: unrelated questions do NOT collide", () => {
  const a = topicKeywords("how do I run payroll for a new hire");
  const b = topicKeywords("what is the client onboarding checklist for tax prep");
  assert.ok(jaccard(a, b) < GAP_DEDUP_JACCARD, `unrelated questions should not dedupe (jaccard=${jaccard(a, b)})`);
});
test("topicSignature: stable; same normalized topic -> same signature", () => {
  const n = normalizeTopic("who approves wire transfers over ten thousand dollars");
  assert.equal(topicSignature(n), topicSignature(n));
  assert.notEqual(topicSignature(n), topicSignature(normalizeTopic("how to close the books monthly")));
});
test("jaccard: empty / identical / disjoint", () => {
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
  assert.equal(jaccard(["a", "b", "c"], ["a", "b"]), 2 / 3);
});
test("parseClientScope", () => {
  assert.deepEqual(parseClientScope("general"), { clientId: null });
  assert.deepEqual(parseClientScope("client:acme"), { clientId: "acme" });
  assert.deepEqual(parseClientScope(void 0), { clientId: null });
});
var norm = normalizeTopic("who approves emergency vendor payments");
var kw = topicKeywords("who approves emergency vendor payments");
var sig = topicSignature(norm);
var incoming = (over = {}) => ({ clientScope: "general", normalizedTopic: norm, signature: sig, keywords: kw, processId: null, ...over });
var gapRow = (over = {}) => ({
  client_scope: "general",
  normalized_topic: norm,
  topic_signature: sig,
  topic_keywords: kw,
  operational_process_id: null,
  status: "candidate",
  ...over
});
test("shouldDedupe: exact normalized-topic match in the same scope", () => {
  assert.equal(shouldDedupe(incoming(), gapRow()), true);
});
test("shouldDedupe: a topic_signature COLLISION alone never dedupes", () => {
  const collided = {
    clientScope: "general",
    normalizedTopic: "annual leave carryover policy",
    signature: sig,
    // forced identical
    keywords: topicKeywords("annual leave carryover policy for part time staff"),
    processId: null
  };
  assert.equal(shouldDedupe(collided, gapRow()), false, "hash collision must not merge unrelated topics");
  assert.equal(shouldDedupe({ ...collided, normalizedTopic: norm, keywords: kw }, gapRow()), true);
});
test("shouldDedupe: NEVER merges across client_scope", () => {
  assert.equal(shouldDedupe(incoming({ clientScope: "client:A" }), gapRow({ client_scope: "general" })), false);
  assert.equal(shouldDedupe(incoming({ clientScope: "general" }), gapRow({ client_scope: "client:A" })), false);
  assert.equal(shouldDedupe(incoming({ clientScope: "client:A" }), gapRow({ client_scope: "client:B" })), false);
});
test("shouldDedupe: fuzzy Jaccard match when the normalized topics differ", () => {
  const other = "who signs off urgent vendor payment approval";
  const inc = incoming({
    normalizedTopic: normalizeTopic(other),
    // NOT equal to the gap's normalized_topic
    signature: "deadbeef",
    keywords: topicKeywords(other)
  });
  assert.notEqual(inc.normalizedTopic, gapRow().normalized_topic);
  assert.equal(shouldDedupe(inc, gapRow(), 0.35), true);
});
test("shouldDedupe: process mismatch (both set) blocks dedupe; either unset allows", () => {
  assert.equal(shouldDedupe(incoming({ processId: "p1" }), gapRow({ operational_process_id: "p2" })), false);
  assert.equal(shouldDedupe(incoming({ processId: "p1" }), gapRow({ operational_process_id: null })), true);
  assert.equal(shouldDedupe(incoming({ processId: null }), gapRow({ operational_process_id: "p2" })), true);
  assert.equal(shouldDedupe(incoming({ processId: "p1" }), gapRow({ operational_process_id: "p1" })), true);
});
test("promotionState: candidate until >=3 asked AND >=2 distinct reporters", () => {
  assert.equal(promotionState(2, 2), "candidate");
  assert.equal(promotionState(3, 1), "candidate", "single reporter never promotes");
  assert.equal(promotionState(10, 1), "candidate", "one actor asking 10x stays candidate");
  assert.equal(promotionState(3, 2), "open");
});
var ev = (over = {}) => ({
  origin: "explicit_feedback",
  sourceIds: ["t1"],
  missingFacets: ["approvals"],
  reporterHmac: "hmacA",
  exampleQuestion: null,
  now: "2026-09-02T00:00:00Z",
  ...over
});
test("mergeGapUpdate: same reporter bumps times_asked but NOT distinct_reporters", () => {
  const gap = { times_asked: 5, distinct_reporters: 1, reporter_hmacs: ["hmacA"], status: "candidate", origins: ["explicit_feedback"] };
  const p = mergeGapUpdate(gap, ev({ reporterHmac: "hmacA" }));
  assert.equal(p.times_asked, 6);
  assert.equal(p.distinct_reporters, 1);
  assert.equal(p.status, void 0, "still candidate \u2014 single reporter");
});
test("mergeGapUpdate: a NEW reporter increments distinct_reporters and can promote", () => {
  const gap = { times_asked: 2, distinct_reporters: 1, reporter_hmacs: ["hmacA"], status: "candidate", origins: ["manual"] };
  const p = mergeGapUpdate(gap, ev({ reporterHmac: "hmacB" }));
  assert.equal(p.times_asked, 3);
  assert.equal(p.distinct_reporters, 2);
  assert.equal(p.status, "open");
});
test("mergeGapUpdate: origins are UNIONED, not replaced", () => {
  const gap = { times_asked: 1, distinct_reporters: 1, reporter_hmacs: ["x"], origins: ["explicit_feedback"], status: "open" };
  const p = mergeGapUpdate(gap, ev({ origin: "answer_status_partial", reporterHmac: "y" }));
  assert.deepEqual([...p.origins].sort(), ["answer_status_partial", "explicit_feedback"]);
});
test("mergeGapUpdate: never downgrades a non-candidate status", () => {
  for (const status of ["open", "under_review", "resolved", "not_applicable"]) {
    const p = mergeGapUpdate({ times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], status, origins: [] }, ev());
    assert.equal(p.status, void 0, `${status} must not be rewritten by aggregation`);
  }
});
test("mergeGapUpdate: example_questions only appended when provided, capped", () => {
  const many = Array.from({ length: EXAMPLE_QUESTIONS_CAP }, (_, i) => `q${i}`);
  const p = mergeGapUpdate({ example_questions: many, times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: "overflow" }));
  assert.equal(p.example_questions, void 0, "cap reached -> not appended");
  const p2 = mergeGapUpdate({ example_questions: ["a"], times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: "b" }));
  assert.deepEqual(p2.example_questions, ["a", "b"]);
  const p3 = mergeGapUpdate({ example_questions: [], times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: null }));
  assert.equal(p3.example_questions, void 0, "null example (logging off) never stored");
});
test("mergeGapUpdate: reporter_hmacs capped; distinct_reporters clamped at cap", () => {
  const full = Array.from({ length: REPORTER_HMACS_CAP }, (_, i) => `h${i}`);
  const p = mergeGapUpdate({ reporter_hmacs: full, distinct_reporters: REPORTER_HMACS_CAP, times_asked: 50, status: "open", origins: [] }, ev({ reporterHmac: "hNEW" }));
  assert.equal(p.reporter_hmacs.length, REPORTER_HMACS_CAP);
  assert.equal(p.distinct_reporters, REPORTER_HMACS_CAP);
});
test("newGapFields: starts as a candidate with origins:[origin], counts at 1", () => {
  const g = newGapFields({
    origin: "answer_status_insufficient",
    title: "vendor payment approval",
    normalizedTopic: "approv payment vendor",
    keywords: ["approv", "payment", "vendor"],
    signature: "abc123",
    clientScope: "client:A",
    clientId: "A",
    processId: null,
    sourceIds: ["t1", "t2"],
    missingFacets: ["approvals"],
    reporterHmac: "h1",
    exampleQuestion: null,
    now: "2026-09-02T00:00:00Z"
  });
  assert.equal(g.status, "candidate");
  assert.deepEqual(g.origins, ["answer_status_insufficient"]);
  assert.equal(g.times_asked, 1);
  assert.equal(g.distinct_reporters, 1);
  assert.equal(g.client_scope, "client:A");
  assert.equal(g.priority, "low");
  assert.deepEqual(g.example_questions, []);
});
test("resolutionRequiresSource", () => {
  assert.equal(resolutionRequiresSource("source_updated"), true);
  assert.equal(resolutionRequiresSource("new_source_added"), true);
  for (const t of ["clarified_no_change", "duplicate", "not_applicable", "deferred"]) {
    assert.equal(resolutionRequiresSource(t), false);
  }
});
test("sourceSatisfiesResolution: refuses unverified / superseded / archived", () => {
  const base = { verification_status: "verified", is_active_version: true, is_archived: false, knowledge_scope: "general" };
  assert.deepEqual(sourceSatisfiesResolution(base, "general"), { ok: true });
  assert.equal(sourceSatisfiesResolution({ ...base, verification_status: "unverified" }, "general").ok, false);
  assert.equal(sourceSatisfiesResolution({ ...base, is_active_version: false }, "general").ok, false);
  assert.equal(sourceSatisfiesResolution({ ...base, is_archived: true }, "general").ok, false);
});
test("sourceSatisfiesResolution: exact client-scope match required", () => {
  const clientSrc = { verification_status: "verified", is_active_version: true, is_archived: false, knowledge_scope: "client-specific", client_id: "A" };
  assert.equal(sourceSatisfiesResolution(clientSrc, "client:A").ok, true);
  assert.equal(sourceSatisfiesResolution(clientSrc, "client:B").ok, false, "client:B gap cannot be resolved with a client:A source");
  assert.equal(sourceSatisfiesResolution(clientSrc, "general").ok, false, "general gap cannot be resolved with a client source");
  const generalSrc = { verification_status: "verified", is_active_version: true, is_archived: false, knowledge_scope: "general" };
  assert.equal(sourceSatisfiesResolution(generalSrc, "client:A").ok, false, "client:A gap cannot be resolved with a general source");
});
test("feedbackAccruesGap: only the deficiency types", () => {
  assert.equal(feedbackAccruesGap("didnt_answer"), true);
  assert.equal(feedbackAccruesGap("missing_detail"), true);
  assert.equal(feedbackAccruesGap("incorrect_or_outdated"), true);
  assert.equal(feedbackAccruesGap("helpful"), false);
  assert.equal(feedbackAccruesGap("still_need_help"), false);
});
test("GAP_ORIGINS is the complete, deduped origin vocabulary", () => {
  assert.equal(new Set(GAP_ORIGINS).size, GAP_ORIGINS.length);
});
var repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var readFn = (p) => readFileSync(resolve(repoRoot, p), "utf8");
var PHASE5_FUNCTIONS = [
  "base44/functions/submitKnowledgeFeedback/entry.ts",
  "base44/functions/logKnowledgeGap/entry.ts",
  "base44/functions/reviewKnowledgeGap/entry.ts",
  "base44/functions/respondToClarification/entry.ts",
  "base44/functions/replyToClarification/entry.ts",
  "base44/functions/getMyClarifications/entry.ts",
  "base44/functions/listKnowledgeGaps/entry.ts"
];
var KNOWLEDGE_WRITE = /entities\.(Training|KnowledgeChunk|OperationalProcess)\.(create|update|delete|bulkCreate|deleteMany|updateMany)\s*\(/;
test("poisoning guard: NO Phase 5 function writes to Training / KnowledgeChunk / OperationalProcess", () => {
  for (const f of [...PHASE5_FUNCTIONS, "base44/shared/gapAggregation.ts"]) {
    const src = readFn(f);
    assert.equal(KNOWLEDGE_WRITE.test(src), false, `${f} must not write to a knowledge entity`);
  }
});
test("gapAggregation only reads Training (for process inheritance), never writes it", () => {
  const src = readFn("base44/shared/gapAggregation.ts");
  assert.ok(/entities\.Training\.get\(/.test(src), "expected a Training.get for process inheritance");
  assert.equal(/entities\.Training\.(create|update|delete)/.test(src), false);
});
test("resolve guard is enforced in reviewKnowledgeGap (sourceSatisfiesResolution + not verified path)", () => {
  const src = readFn("base44/functions/reviewKnowledgeGap/entry.ts");
  assert.ok(src.includes("sourceSatisfiesResolution"), "reviewKnowledgeGap must call the guard");
  assert.ok(/does not verify sources/.test(src), "the guard message must state Phase 5 does not verify sources");
});
test("deliberately-typed content (free_text / message) is length-capped in the functions", () => {
  assert.ok(readFn("base44/functions/submitKnowledgeFeedback/entry.ts").includes("FREE_TEXT_MAX"));
  assert.ok(readFn("base44/functions/replyToClarification/entry.ts").includes("CLARIFICATION_MESSAGE_MAX"));
});
test("passive capture (standalone_query / example_questions) is gated by answer_logging_enabled", () => {
  const src = readFn("base44/functions/submitKnowledgeFeedback/entry.ts");
  assert.ok(/loggingEnabled\s*&&\s*standaloneQuery/.test(src), "standalone_query must be gated by loggingEnabled");
});
test("no Phase 5 entity carries an answer-like field", () => {
  for (const e of ["KnowledgeFeedback", "KnowledgeGap", "ClarificationRequest", "ClarificationMessage"]) {
    const src = readFn(`base44/entities/${e}.jsonc`);
    assert.equal(/"(proposed_answer|correct_text|corrected_answer|answer_text)"\s*:/.test(src), false, `${e} must not have an answer-like field`);
  }
});
test("reporterId.ts has NO fallback/default secret and throws when it is missing", () => {
  const src = readFn("base44/shared/reporterId.ts");
  assert.equal(/FALLBACK_SECRET|"mindvault-gap-reporter/.test(src), false, "no hard-coded default secret");
  assert.ok(/MissingGapSecretError|throw/.test(src), "must throw when the secret is missing");
  assert.ok(src.includes("if (!s) throw"), "empty secret must be rejected");
});
test("feedback / gap functions fail safely (503) when GAP_HMAC_SECRET is missing", () => {
  for (const f of ["submitKnowledgeFeedback", "logKnowledgeGap"]) {
    const src = readFn(`base44/functions/${f}/entry.ts`);
    assert.ok(/GAP_HMAC_SECRET/.test(src));
    assert.ok(/status:\s*503/.test(src), `${f} must return a 503 config error when the secret is absent`);
  }
});
test("AuditEvent is append-only: no Phase 5 code updates or deletes it", () => {
  const files = [...PHASE5_FUNCTIONS, "base44/shared/gapAggregation.ts", "base44/functions/askKnowledgeBaseV2/entry.ts"];
  for (const f of files) {
    const src = readFn(f);
    assert.equal(/entities\.AuditEvent\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete AuditEvent`);
  }
});
test("AuditEvent RLS uses only proven admin-only conditions (no invented role values)", () => {
  const src = readFn("base44/entities/AuditEvent.jsonc");
  assert.equal(/"role"\s*:\s*"(?!admin")[a-z_]+"/.test(src), false, 'only "role": "admin" is allowed in RLS conditions');
});
