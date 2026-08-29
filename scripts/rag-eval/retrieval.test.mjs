// Pure-module tests for the RAG scope gate + ranking. NO Base44, NO network.
// Run with:  node --test scripts/rag-eval/retrieval.test.mjs
// (Node >= 22.18 strips the TypeScript types from the imported .ts file.)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertInScope,
  parseCitations,
  pickConfidence,
  rankChunks,
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
