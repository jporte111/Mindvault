// Phase 5 — pure tests for base44/shared/knowledgeGap.ts: deterministic lexical
// gap de-duplication, promotion gating, aggregation merges, and the resolve
// guard. NO Base44, NO network, NO embeddings — gap dedupe must work with zero
// embeddings credits, identically in semantic and lexical retrieval modes.
//   node --test scripts/rag-eval/knowledge-gap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  GAP_DEDUP_JACCARD,
  GAP_ORIGINS,
  REPORTER_HMACS_CAP,
  EXAMPLE_QUESTIONS_CAP,
  feedbackAccruesGap,
  topicKeywords,
  normalizeTopic,
  topicSignature,
  jaccard,
  parseClientScope,
  shouldDedupe,
  promotionState,
  mergeGapUpdate,
  newGapFields,
  resolutionRequiresSource,
  sourceSatisfiesResolution,
  relatedSourceInGapScope,
} from '../../base44/shared/knowledgeGap.ts';

// ======================================================================
// no-embeddings contract
// ======================================================================

test('knowledgeGap.ts has NO imports and no embeddings call (pure, node-loadable)', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../base44/shared/knowledgeGap.ts'),
    'utf8',
  );
  assert.equal(src.match(/^\s*import\s/m), null, 'knowledgeGap.ts must not import anything');
  assert.equal(/\bembed\s*\(/.test(src), false, 'no embed() call');
  assert.equal(/from\s+['"][^'"]*embeddings/.test(src), false, 'does not pull in the embeddings module');
});

// ======================================================================
// topic normalization
// ======================================================================

test('normalizeTopic: deterministic, stopword + short-word stripped, stemmed, sorted', () => {
  const a = normalizeTopic('How do I reconcile the monthly bank statements?');
  assert.equal(a, normalizeTopic('How do I reconcile the monthly bank statements?'));
  assert.deepEqual(a.split(' ').sort(), a.split(' ')); // already sorted
  assert.ok(!a.includes('how') && !a.includes('the'), 'stopwords removed');
  assert.ok(a.includes('reconcil'), `stemmed 'reconcile'/'statements' -> got "${a}"`);
});

test('normalizeTopic: paraphrases land within the Jaccard threshold', () => {
  const a = topicKeywords('who approves emergency vendor payments');
  const b = topicKeywords('who signs off on urgent vendor payment approval');
  // shared roots after stemming: approv, vendor, payment
  const j = jaccard(a, b);
  assert.ok(j >= GAP_DEDUP_JACCARD, `expected paraphrase overlap >= ${GAP_DEDUP_JACCARD}, got ${j} for ${JSON.stringify([a, b])}`);
  assert.equal(shouldDedupe({ clientScope: 'general', normalizedTopic: a.join(' '), signature: 'x', keywords: a, processId: null }, { client_scope: 'general', normalized_topic: b.join(' '), topic_keywords: b, operational_process_id: null }), true);
});

test('normalizeTopic: unrelated questions do NOT collide', () => {
  const a = topicKeywords('how do I run payroll for a new hire');
  const b = topicKeywords('what is the client onboarding checklist for tax prep');
  assert.ok(jaccard(a, b) < GAP_DEDUP_JACCARD, `unrelated questions should not dedupe (jaccard=${jaccard(a, b)})`);
});

test('topicSignature: stable; same normalized topic -> same signature', () => {
  const n = normalizeTopic('who approves wire transfers over ten thousand dollars');
  assert.equal(topicSignature(n), topicSignature(n));
  assert.notEqual(topicSignature(n), topicSignature(normalizeTopic('how to close the books monthly')));
});

test('jaccard: empty / identical / disjoint', () => {
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b']), 2 / 3);
});

test('parseClientScope', () => {
  assert.deepEqual(parseClientScope('general'), { clientId: null });
  assert.deepEqual(parseClientScope('client:acme'), { clientId: 'acme' });
  assert.deepEqual(parseClientScope(undefined), { clientId: null });
});

// ======================================================================
// shouldDedupe — partitioned by client_scope, process-compatible
// ======================================================================

const norm = normalizeTopic('who approves emergency vendor payments');
const kw = topicKeywords('who approves emergency vendor payments');
const sig = topicSignature(norm);
const incoming = (over = {}) => ({ clientScope: 'general', normalizedTopic: norm, signature: sig, keywords: kw, processId: null, ...over });
const gapRow = (over = {}) => ({
  client_scope: 'general',
  normalized_topic: norm,
  topic_signature: sig,
  topic_keywords: kw,
  operational_process_id: null,
  status: 'candidate',
  ...over,
});

test('shouldDedupe: exact normalized-topic match in the same scope', () => {
  assert.equal(shouldDedupe(incoming(), gapRow()), true);
});

test('shouldDedupe: a topic_signature COLLISION alone never dedupes', () => {
  // Same (forced) signature, DIFFERENT normalized topics, and disjoint keywords
  // (Jaccard 0) -> must NOT dedupe. The signature is only a stored index hint.
  const collided = {
    clientScope: 'general',
    normalizedTopic: 'annual leave carryover policy',
    signature: sig, // forced identical
    keywords: topicKeywords('annual leave carryover policy for part time staff'),
    processId: null,
  };
  assert.equal(shouldDedupe(collided, gapRow()), false, 'hash collision must not merge unrelated topics');
  // and the real exact-match path still works when the strings actually match
  assert.equal(shouldDedupe({ ...collided, normalizedTopic: norm, keywords: kw }, gapRow()), true);
});

test('shouldDedupe: NEVER merges across client_scope', () => {
  assert.equal(shouldDedupe(incoming({ clientScope: 'client:A' }), gapRow({ client_scope: 'general' })), false);
  assert.equal(shouldDedupe(incoming({ clientScope: 'general' }), gapRow({ client_scope: 'client:A' })), false);
  assert.equal(shouldDedupe(incoming({ clientScope: 'client:A' }), gapRow({ client_scope: 'client:B' })), false);
});

test('shouldDedupe: fuzzy Jaccard match when the normalized topics differ', () => {
  const other = 'who signs off urgent vendor payment approval';
  const inc = incoming({
    normalizedTopic: normalizeTopic(other), // NOT equal to the gap's normalized_topic
    signature: 'deadbeef',
    keywords: topicKeywords(other),
  });
  // exact path is off (different strings); dedupe must come via keyword Jaccard
  assert.notEqual(inc.normalizedTopic, gapRow().normalized_topic);
  assert.equal(shouldDedupe(inc, gapRow(), 0.35), true);
});

test('shouldDedupe: process mismatch (both set) blocks dedupe; either unset allows', () => {
  assert.equal(shouldDedupe(incoming({ processId: 'p1' }), gapRow({ operational_process_id: 'p2' })), false);
  assert.equal(shouldDedupe(incoming({ processId: 'p1' }), gapRow({ operational_process_id: null })), true);
  assert.equal(shouldDedupe(incoming({ processId: null }), gapRow({ operational_process_id: 'p2' })), true);
  assert.equal(shouldDedupe(incoming({ processId: 'p1' }), gapRow({ operational_process_id: 'p1' })), true);
});

// ======================================================================
// promotion gating — one actor can't manufacture an "open" gap
// ======================================================================

test('promotionState: candidate until >=3 asked AND >=2 distinct reporters', () => {
  assert.equal(promotionState(2, 2), 'candidate');
  assert.equal(promotionState(3, 1), 'candidate', 'single reporter never promotes');
  assert.equal(promotionState(10, 1), 'candidate', 'one actor asking 10x stays candidate');
  assert.equal(promotionState(3, 2), 'open');
});

// ======================================================================
// mergeGapUpdate — unions, caps, origins[], never downgrades status
// ======================================================================

const ev = (over = {}) => ({
  origin: 'explicit_feedback',
  sourceIds: ['t1'],
  missingFacets: ['approvals'],
  reporterHmac: 'hmacA',
  exampleQuestion: null,
  now: '2026-09-02T00:00:00Z',
  ...over,
});

test('mergeGapUpdate: same reporter bumps times_asked but NOT distinct_reporters', () => {
  const gap = { times_asked: 5, distinct_reporters: 1, reporter_hmacs: ['hmacA'], status: 'candidate', origins: ['explicit_feedback'] };
  const p = mergeGapUpdate(gap, ev({ reporterHmac: 'hmacA' }));
  assert.equal(p.times_asked, 6);
  assert.equal(p.distinct_reporters, 1);
  assert.equal(p.status, undefined, 'still candidate — single reporter');
});

test('mergeGapUpdate: a NEW reporter increments distinct_reporters and can promote', () => {
  const gap = { times_asked: 2, distinct_reporters: 1, reporter_hmacs: ['hmacA'], status: 'candidate', origins: ['manual'] };
  const p = mergeGapUpdate(gap, ev({ reporterHmac: 'hmacB' }));
  assert.equal(p.times_asked, 3);
  assert.equal(p.distinct_reporters, 2);
  assert.equal(p.status, 'open');
});

test('mergeGapUpdate: origins are UNIONED, not replaced', () => {
  const gap = { times_asked: 1, distinct_reporters: 1, reporter_hmacs: ['x'], origins: ['explicit_feedback'], status: 'open' };
  const p = mergeGapUpdate(gap, ev({ origin: 'answer_status_partial', reporterHmac: 'y' }));
  assert.deepEqual([...p.origins].sort(), ['answer_status_partial', 'explicit_feedback']);
});

test('mergeGapUpdate: never downgrades a non-candidate status', () => {
  for (const status of ['open', 'under_review', 'resolved', 'not_applicable']) {
    const p = mergeGapUpdate({ times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], status, origins: [] }, ev());
    assert.equal(p.status, undefined, `${status} must not be rewritten by aggregation`);
  }
});

test('mergeGapUpdate: example_questions only appended when provided, capped', () => {
  const many = Array.from({ length: EXAMPLE_QUESTIONS_CAP }, (_, i) => `q${i}`);
  const p = mergeGapUpdate({ example_questions: many, times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: 'overflow' }));
  assert.equal(p.example_questions, undefined, 'cap reached -> not appended');
  const p2 = mergeGapUpdate({ example_questions: ['a'], times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: 'b' }));
  assert.deepEqual(p2.example_questions, ['a', 'b']);
  const p3 = mergeGapUpdate({ example_questions: [], times_asked: 1, distinct_reporters: 1, reporter_hmacs: [], origins: [] }, ev({ exampleQuestion: null }));
  assert.equal(p3.example_questions, undefined, 'null example (logging off) never stored');
});

test('mergeGapUpdate: reporter_hmacs capped; distinct_reporters clamped at cap', () => {
  const full = Array.from({ length: REPORTER_HMACS_CAP }, (_, i) => `h${i}`);
  const p = mergeGapUpdate({ reporter_hmacs: full, distinct_reporters: REPORTER_HMACS_CAP, times_asked: 50, status: 'open', origins: [] }, ev({ reporterHmac: 'hNEW' }));
  assert.equal(p.reporter_hmacs.length, REPORTER_HMACS_CAP);
  assert.equal(p.distinct_reporters, REPORTER_HMACS_CAP);
});

test('newGapFields: starts as a candidate with origins:[origin], counts at 1', () => {
  const g = newGapFields({
    origin: 'answer_status_insufficient', title: 'vendor payment approval', normalizedTopic: 'approv payment vendor',
    keywords: ['approv', 'payment', 'vendor'], signature: 'abc123', clientScope: 'client:A', clientId: 'A',
    processId: null, sourceIds: ['t1', 't2'], missingFacets: ['approvals'], reporterHmac: 'h1',
    exampleQuestion: null, now: '2026-09-02T00:00:00Z',
  });
  assert.equal(g.status, 'candidate');
  assert.deepEqual(g.origins, ['answer_status_insufficient']);
  assert.equal(g.times_asked, 1);
  assert.equal(g.distinct_reporters, 1);
  assert.equal(g.client_scope, 'client:A');
  assert.equal(g.priority, 'low');
  assert.deepEqual(g.example_questions, []);
});

// ======================================================================
// resolve guard — Phase 5 refuses, it does not verify
// ======================================================================

test('resolutionRequiresSource', () => {
  assert.equal(resolutionRequiresSource('source_updated'), true);
  assert.equal(resolutionRequiresSource('new_source_added'), true);
  for (const t of ['clarified_no_change', 'duplicate', 'not_applicable', 'deferred']) {
    assert.equal(resolutionRequiresSource(t), false);
  }
});

test('sourceSatisfiesResolution: refuses unverified / superseded / archived', () => {
  const base = { verification_status: 'verified', is_active_version: true, is_archived: false, knowledge_scope: 'general' };
  assert.deepEqual(sourceSatisfiesResolution(base, 'general'), { ok: true });
  assert.equal(sourceSatisfiesResolution({ ...base, verification_status: 'unverified' }, 'general').ok, false);
  assert.equal(sourceSatisfiesResolution({ ...base, is_active_version: false }, 'general').ok, false);
  assert.equal(sourceSatisfiesResolution({ ...base, is_archived: true }, 'general').ok, false);
});

test('sourceSatisfiesResolution: exact client-scope match required', () => {
  const clientSrc = { verification_status: 'verified', is_active_version: true, is_archived: false, knowledge_scope: 'client-specific', client_id: 'A' };
  assert.equal(sourceSatisfiesResolution(clientSrc, 'client:A').ok, true);
  assert.equal(sourceSatisfiesResolution(clientSrc, 'client:B').ok, false, 'client:B gap cannot be resolved with a client:A source');
  assert.equal(sourceSatisfiesResolution(clientSrc, 'general').ok, false, 'general gap cannot be resolved with a client source');
  const generalSrc = { verification_status: 'verified', is_active_version: true, is_archived: false, knowledge_scope: 'general' };
  assert.equal(sourceSatisfiesResolution(generalSrc, 'client:A').ok, false, 'client:A gap cannot be resolved with a general source');
});

// ======================================================================
// relatedSourceInGapScope — write-side scope invariant (Phase 5 hardening)
// ======================================================================

const GEN = { knowledge_scope: 'general' };
const CLI = (id) => ({ knowledge_scope: 'client-specific', client_id: id });

test('relatedSourceInGapScope: general gap accepts only general sources', () => {
  assert.equal(relatedSourceInGapScope(GEN, 'general'), true);
  assert.equal(relatedSourceInGapScope(CLI('A'), 'general'), false);
});

test('relatedSourceInGapScope: client gap accepts general + same-client, rejects other-client', () => {
  assert.equal(relatedSourceInGapScope(GEN, 'client:A'), true);
  assert.equal(relatedSourceInGapScope(CLI('A'), 'client:A'), true);
  assert.equal(relatedSourceInGapScope(CLI('B'), 'client:A'), false);
});

test('relatedSourceInGapScope: unclassified / missing / malformed source scope is always rejected', () => {
  assert.equal(relatedSourceInGapScope({ knowledge_scope: 'unclassified' }, 'client:A'), false);
  assert.equal(relatedSourceInGapScope({ knowledge_scope: 'unclassified' }, 'general'), false);
  assert.equal(relatedSourceInGapScope({}, 'client:A'), false);
  assert.equal(relatedSourceInGapScope(null, 'client:A'), false);
  assert.equal(relatedSourceInGapScope(undefined, 'general'), false);
  assert.equal(relatedSourceInGapScope({ knowledge_scope: 'client-specific' /* no client_id */ }, 'client:A'), false);
  assert.equal(relatedSourceInGapScope({ knowledge_scope: 'nonsense' }, 'client:A'), false);
});

test('relatedSourceInGapScope: uses the SAME model as retrieval assertInScope (no second scope model)', () => {
  const src = readFileSync(new URL('../../base44/shared/retrieval.ts', import.meta.url), 'utf8');
  // assertInScope: scope === "general" || (scope === "client-specific" && !!clientId && c.client_id === clientId)
  assert.ok(/scope === "general"[\s\S]{0,120}client-specific[\s\S]{0,80}client_id === clientId/.test(src));
});

// ======================================================================
// feedback -> gap routing
// ======================================================================

test('feedbackAccruesGap: only the deficiency types', () => {
  assert.equal(feedbackAccruesGap('didnt_answer'), true);
  assert.equal(feedbackAccruesGap('missing_detail'), true);
  assert.equal(feedbackAccruesGap('incorrect_or_outdated'), true);
  assert.equal(feedbackAccruesGap('helpful'), false);
  assert.equal(feedbackAccruesGap('still_need_help'), false);
});

test('GAP_ORIGINS is the complete, deduped origin vocabulary', () => {
  assert.equal(new Set(GAP_ORIGINS).size, GAP_ORIGINS.length);
});

// ======================================================================
// abuse / poisoning contract — Phase 5 functions never mutate knowledge
// ======================================================================

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readFn = (p) => readFileSync(resolve(repoRoot, p), 'utf8');

const PHASE5_FUNCTIONS = [
  'base44/functions/submitKnowledgeFeedback/entry.ts',
  'base44/functions/logKnowledgeGap/entry.ts',
  'base44/functions/reviewKnowledgeGap/entry.ts',
  'base44/functions/respondToClarification/entry.ts',
  'base44/functions/replyToClarification/entry.ts',
  'base44/functions/getMyClarifications/entry.ts',
  'base44/functions/listKnowledgeGaps/entry.ts',
];
const KNOWLEDGE_WRITE = /entities\.(Training|KnowledgeChunk|OperationalProcess)\.(create|update|delete|bulkCreate|deleteMany|updateMany)\s*\(/;

test('poisoning guard: NO Phase 5 function writes to Training / KnowledgeChunk / OperationalProcess', () => {
  for (const f of [...PHASE5_FUNCTIONS, 'base44/shared/gapAggregation.ts']) {
    const src = readFn(f);
    assert.equal(KNOWLEDGE_WRITE.test(src), false, `${f} must not write to a knowledge entity`);
  }
});

test('gapAggregation only reads Training (scope check + process inheritance), never writes it', () => {
  const src = readFn('base44/shared/gapAggregation.ts');
  // Phase 5 hardening replaced the per-id Training.get with ONE bounded $in read
  // that resolves related sources for the scope check and process inheritance.
  assert.ok(/entities\.Training\.filter\(\s*\{\s*id:\s*\{\s*\$in/.test(src), 'expected a bounded Training.filter($in) read');
  assert.equal(/entities\.Training\.(create|update|delete)/.test(src), false);
});

test('resolve guard is enforced in reviewKnowledgeGap (sourceSatisfiesResolution + not verified path)', () => {
  const src = readFn('base44/functions/reviewKnowledgeGap/entry.ts');
  assert.ok(src.includes('sourceSatisfiesResolution'), 'reviewKnowledgeGap must call the guard');
  assert.ok(/does not verify sources/.test(src), 'the guard message must state Phase 5 does not verify sources');
});

test('deliberately-typed content (free_text / message) is length-capped in the functions', () => {
  assert.ok(readFn('base44/functions/submitKnowledgeFeedback/entry.ts').includes('FREE_TEXT_MAX'));
  assert.ok(readFn('base44/functions/replyToClarification/entry.ts').includes('CLARIFICATION_MESSAGE_MAX'));
});

test('passive capture (standalone_query / example_questions) is gated by answer_logging_enabled', () => {
  const src = readFn('base44/functions/submitKnowledgeFeedback/entry.ts');
  assert.ok(/loggingEnabled\s*&&\s*standaloneQuery/.test(src), 'standalone_query must be gated by loggingEnabled');
});

test('no Phase 5 entity carries an answer-like field', () => {
  for (const e of ['KnowledgeFeedback', 'KnowledgeGap', 'ClarificationRequest', 'ClarificationMessage']) {
    const src = readFn(`base44/entities/${e}.jsonc`);
    assert.equal(/"(proposed_answer|correct_text|corrected_answer|answer_text)"\s*:/.test(src), false, `${e} must not have an answer-like field`);
  }
});

test('reporterId.ts has NO fallback/default secret and throws when it is missing', () => {
  const src = readFn('base44/shared/reporterId.ts');
  assert.equal(/FALLBACK_SECRET|"mindvault-gap-reporter/.test(src), false, 'no hard-coded default secret');
  assert.ok(/MissingGapSecretError|throw/.test(src), 'must throw when the secret is missing');
  assert.ok(src.includes('if (!s) throw'), 'empty secret must be rejected');
});

test('feedback / gap functions fail safely (503) when GAP_HMAC_SECRET is missing', () => {
  for (const f of ['submitKnowledgeFeedback', 'logKnowledgeGap']) {
    const src = readFn(`base44/functions/${f}/entry.ts`);
    assert.ok(/GAP_HMAC_SECRET/.test(src));
    assert.ok(/status:\s*503/.test(src), `${f} must return a 503 config error when the secret is absent`);
  }
});

test('AuditEvent is append-only: no Phase 5 code updates or deletes it', () => {
  const files = [...PHASE5_FUNCTIONS, 'base44/shared/gapAggregation.ts', 'base44/functions/askKnowledgeBaseV2/entry.ts'];
  for (const f of files) {
    const src = readFn(f);
    assert.equal(/entities\.AuditEvent\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete AuditEvent`);
  }
});

test('AuditEvent RLS uses only proven admin-only conditions (no invented role values)', () => {
  const src = readFn('base44/entities/AuditEvent.jsonc');
  assert.equal(/"role"\s*:\s*"(?!admin")[a-z_]+"/.test(src), false, 'only "role": "admin" is allowed in RLS conditions');
});
