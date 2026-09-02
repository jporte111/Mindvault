// Pure-module tests for the RAG scope gate + ranking. NO Base44, NO network.
// Run with:  node --test scripts/rag-eval/retrieval.test.mjs
// (Node >= 22.18 strips the TypeScript types from the imported .ts file.)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertInScope,
  parseCitations,
  pickConfidence,
  planRetrieval,
  rankChunks,
  THRESHOLDS,
} from '../../base44/shared/retrieval.ts';

// --- Deterministic fixture pool. Vectors are hand-set so cosine order is
// predictable; direction, not magnitude, is what matters. ---
const chunk = (o) => ({
  chunk_index: 0,
  chunk_type: 'decision_rule',
  content: o.content || 'x',
  title: o.title || o.id,
  content_hash: o.id,
  ...o,
});

const POOL = [
  chunk({ id: 'G1', training_id: 't-recon', knowledge_scope: 'general',
    chunk_type: 'sop_step', content: 'Steps to reconcile a bank statement each month.',
    embedding: [0.98, 0.10, 0, 0] }),
  chunk({ id: 'G2', training_id: 't-payroll', knowledge_scope: 'general',
    chunk_type: 'summary', content: 'Overview of the payroll run process.',
    embedding: [0, 0, 1, 0] }),
  chunk({ id: 'A1', training_id: 't-acme', knowledge_scope: 'client-specific', client_id: 'clientA',
    content: 'Acme closes its books on the 5th of the month.',
    embedding: [0.10, 0.98, 0, 0] }),
  chunk({ id: 'B1', training_id: 't-beta', knowledge_scope: 'client-specific', client_id: 'clientB',
    content: 'Beta closes its books on the 12th of the month.',
    embedding: [0.10, 0.98, 0, 0] }),
  chunk({ id: 'U1', training_id: 't-unclass', knowledge_scope: 'unclassified',
    content: 'Unclassified draft note that must never be retrieved.',
    embedding: [0.98, 0.10, 0, 0] }),
];

const Q_RECON = [[1, 0, 0, 0]];
const Q_CLOSE = [[0, 1, 0, 0]];
const Q_OFFTOPIC = [[0, 0, 0, 1]];

test('general context: only general chunks, never client or unclassified', () => {
  const { ranked, dropped } = rankChunks({
    chunks: POOL, queryVectors: Q_RECON, standaloneQuery: 'reconcile bank statement', clientId: null,
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes('G1'));
  for (const bad of ['A1', 'B1', 'U1']) assert.ok(!ids.includes(bad), `${bad} leaked into general context`);
  const droppedIds = dropped.map((d) => d.id).sort();
  assert.deepEqual(droppedIds, ['A1', 'B1', 'U1']);
});

test('client A context: A chunks + general, never B or unclassified', () => {
  const { ranked, dropped } = rankChunks({
    chunks: POOL, queryVectors: Q_CLOSE, standaloneQuery: 'when does the client close books', clientId: 'clientA',
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes('A1'), 'A1 should be retrievable in client A context');
  assert.ok(!ids.includes('B1'), 'B1 (other client) leaked');
  assert.ok(!ids.includes('U1'), 'U1 (unclassified) leaked');
  assert.ok(dropped.map((d) => d.id).includes('B1'));
});

test('a client name in the query never widens scope', () => {
  const { ranked } = rankChunks({
    chunks: POOL, queryVectors: Q_CLOSE,
    standaloneQuery: "what is Beta's book close date for the Beta account",
    clientId: 'clientA',
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes('B1'), 'mentioning "Beta" pulled in client B data');
});

test('assertInScope unit: mixed pool in -> only allowed out', () => {
  const { kept, dropped } = assertInScope(POOL, 'clientA');
  assert.deepEqual(kept.map((c) => c.id).sort(), ['A1', 'G1', 'G2']);
  assert.deepEqual(dropped.map((c) => c.id).sort(), ['B1', 'U1']);
});

test('weak / off-topic results -> low confidence', () => {
  const { ranked } = rankChunks({
    chunks: POOL, queryVectors: Q_OFFTOPIC, standaloneQuery: 'company holiday policy', clientId: null,
  });
  assert.equal(pickConfidence(ranked), 'low');
});

test('dedupe + per-training cap', () => {
  const dupes = Array.from({ length: 6 }, (_, i) =>
    chunk({ id: `D${i}`, training_id: 't-dup', knowledge_scope: 'general',
      content: `Reconcile the bank statement carefully — variant ${i}`,
      content_hash: `D${i}`, embedding: [0.9, 0.2, 0, 0] }));
  // two exact-hash duplicates
  dupes[5].content_hash = 'D0';
  const { ranked } = rankChunks({
    chunks: dupes, queryVectors: Q_RECON, standaloneQuery: 'reconcile bank statement', clientId: null,
  });
  assert.ok(ranked.length <= 3, `per-training cap not applied (${ranked.length})`);
  const hashes = ranked.map((r) => r.chunk.content_hash);
  assert.equal(new Set(hashes).size, hashes.length, 'exact-duplicate hash survived');
});

test('parseCitations extracts used, in-range markers only', () => {
  assert.deepEqual(parseCitations('see [S1] and [S3], ignore [S9]', 4), [0, 2]);
  assert.deepEqual(parseCitations('no citations here', 4), []);
});

test('semanticActive is true only when vectors exist AND match something', () => {
  const withVec = rankChunks({
    chunks: POOL, queryVectors: Q_RECON, standaloneQuery: 'reconcile bank statement', clientId: null,
  });
  assert.equal(withVec.semanticActive, true);
});

// --- Lexical fallback (no embeddings) --------------------------------------

const lex = (o) => ({
  chunk_index: 0, chunk_type: 'decision_rule', title: o.id, content_hash: o.id, ...o,
});

const LEX_POOL = [
  lex({ id: 'L1', training_id: 't-recon', knowledge_scope: 'general',
    content: 'To reconcile a bank statement, match every transaction to the ledger and note discrepancies.',
    keywords: ['reconcile', 'bank', 'statement', 'ledger'] }),
  lex({ id: 'L2', training_id: 't-recon2', knowledge_scope: 'general',
    content: 'Bank reconciliation runs monthly once the statement arrives.',
    keywords: ['bank', 'reconciliation', 'monthly', 'statement'] }),
  lex({ id: 'L3', training_id: 't-payroll', knowledge_scope: 'general',
    content: 'Payroll runs are approved by the controller before submission.',
    keywords: ['payroll', 'approve', 'controller'] }),
  lex({ id: 'LA', training_id: 't-acme', knowledge_scope: 'client-specific', client_id: 'clientA',
    content: 'Acme reconcile bank statement on the fifth business day.',
    keywords: ['acme', 'reconcile', 'bank', 'statement'] }),
  lex({ id: 'LB', training_id: 't-beta', knowledge_scope: 'client-specific', client_id: 'clientB',
    content: 'Beta reconcile bank statement on the twelfth business day.',
    keywords: ['beta', 'reconcile', 'bank', 'statement'] }),
  lex({ id: 'LU', training_id: 't-unclass', knowledge_scope: 'unclassified',
    content: 'Draft reconcile bank statement note, not yet classified.',
    keywords: ['reconcile', 'bank', 'statement'] }),
];

test('lexical mode: no queryVectors -> semanticActive false, ranked by term overlap', () => {
  const { ranked, semanticActive } = rankChunks({
    chunks: LEX_POOL, queryVectors: [], standaloneQuery: 'reconcile bank statement ledger', clientId: null,
  });
  assert.equal(semanticActive, false);
  const ids = ranked.map((r) => r.chunk.id);
  assert.equal(ids[0], 'L1', 'best term overlap should rank first');
  assert.ok(ids.indexOf('L1') < ids.indexOf('L3'), 'off-topic chunk should rank below on-topic');
});

test('lexical mode: scope isolation is identical (client A context)', () => {
  const { ranked, dropped } = rankChunks({
    chunks: LEX_POOL, queryVectors: [], standaloneQuery: 'reconcile bank statement', clientId: 'clientA',
  });
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes('LA'));
  assert.ok(!ids.includes('LB'), 'other client leaked in lexical mode');
  assert.ok(!ids.includes('LU'), 'unclassified leaked in lexical mode');
  const droppedIds = dropped.map((d) => d.id).sort();
  assert.deepEqual(droppedIds, ['LB', 'LU']);
});

test('lexical mode: a client name in the query never widens scope', () => {
  const { ranked } = rankChunks({
    chunks: LEX_POOL, queryVectors: [],
    standaloneQuery: 'what is Beta reconcile bank statement day for Beta',
    clientId: 'clientA',
  });
  assert.ok(!ranked.map((r) => r.chunk.id).includes('LB'));
});

test('lexical mode: vectors present but no chunk has an embedding -> semanticActive false', () => {
  const { semanticActive } = rankChunks({
    chunks: LEX_POOL, queryVectors: [[1, 0, 0, 0]], standaloneQuery: 'reconcile bank', clientId: null,
  });
  assert.equal(semanticActive, false);
});

test('lexical mode: chunks without an embedding field do not crash ranking', () => {
  assert.doesNotThrow(() => rankChunks({
    chunks: LEX_POOL, queryVectors: [], standaloneQuery: 'bank', clientId: null,
  }));
});

test('THRESHOLDS.lexical is centralized and complete', () => {
  const L = THRESHOLDS.lexical;
  for (const k of ['insufficientIfLexBelow', 'corroborationLexAtLeast', 'highIfLexAtLeast', 'highMinChunks']) {
    assert.equal(typeof L[k], 'number', `missing THRESHOLDS.lexical.${k}`);
  }
});

test('pickConfidence lexical: coverage-gated bands', () => {
  const opt = { semanticActive: false };
  assert.equal(pickConfidence([], opt), 'low');
  assert.equal(pickConfidence([{ lex: 0.10 }], opt), 'low', 'below insufficient floor');
  assert.equal(pickConfidence([{ lex: 0.30 }], opt), 'medium', 'partial coverage, no corroboration');
  assert.equal(pickConfidence([{ lex: 0.80 }, { lex: 0.50 }, { lex: 0.10 }], opt), 'high', 'strong + corroborated');
  assert.equal(pickConfidence([{ lex: 0.80 }, { lex: 0.05 }], opt), 'medium', 'strong top but only 1 corroborating');
});

test('pickConfidence default (no opts) keeps the original semantic behavior', () => {
  const { ranked } = rankChunks({
    chunks: POOL, queryVectors: Q_OFFTOPIC, standaloneQuery: 'company holiday policy', clientId: null,
  });
  assert.equal(pickConfidence(ranked), 'low');
});

// --- planRetrieval: whether askKnowledgeBaseV2 should call the provider -----

test('planRetrieval: lexical mode never calls the provider', () => {
  assert.deepEqual(planRetrieval('lexical', true), { attemptEmbed: false, requireEmbed: false });
  assert.deepEqual(planRetrieval('lexical', false), { attemptEmbed: false, requireEmbed: false });
});

test('planRetrieval: auto with NO key skips embed() entirely -> lexical', () => {
  assert.deepEqual(planRetrieval('auto', false), { attemptEmbed: false, requireEmbed: false });
});

test('planRetrieval: auto WITH key attempts embed(), still soft-fails', () => {
  assert.deepEqual(planRetrieval('auto', true), { attemptEmbed: true, requireEmbed: false });
});

test('planRetrieval: semantic hard-requires embeddings', () => {
  assert.deepEqual(planRetrieval('semantic', false), { attemptEmbed: false, requireEmbed: true });
  assert.deepEqual(planRetrieval('semantic', true), { attemptEmbed: true, requireEmbed: true });
});

test('planRetrieval: unknown / missing mode behaves as auto', () => {
  assert.deepEqual(planRetrieval('garbage', true), { attemptEmbed: true, requireEmbed: false });
  assert.deepEqual(planRetrieval(undefined, false), { attemptEmbed: false, requireEmbed: false });
  assert.deepEqual(planRetrieval(null, true), { attemptEmbed: true, requireEmbed: false });
});
