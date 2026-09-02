// Regression: client-specific scoping end-to-end — index-time scope stamping
// (embedKnowledge) plus lexical retrieval isolation (askKnowledgeBaseV2).
// NO Base44, NO network, NO embeddings key — pure fixtures.
//   node --test scripts/rag-eval/client-scoping.test.mjs
//
// Covers the JLM invoice-workflow incident:
//   1. a client-specific Training source (client_id=JLM) stamps scope/client_id
//      onto every chunk embedKnowledge builds from it
//   2. drift re-stamping restores a lost/blank client_id; an idempotent re-index
//      of correctly-stamped chunks writes NOTHING (never blanks client_id)
//   3. lexical retrieval (queryVectors: []) with clientId=JLM retrieves those
//      chunks; general knowledge is still retrievable alongside
//   4. lexical retrieval with ANOTHER client's context does not retrieve them
//      (no cross-client leakage); unclassified chunks are never retrieved

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScopeFields,
  scopeFieldsDrift,
} from '../../base44/shared/governance.ts';
import { rankChunks } from '../../base44/shared/retrieval.ts';

const JLM = 'client-jlm';
const GBP = 'client-gbp';
const INVOICE_SRC_ID = 'training-invoice-workflow';

// The source of truth: the Training record after correct classification.
const invoiceSource = {
  id: INVOICE_SRC_ID,
  title: 'Invoice Workflow',
  knowledge_scope: 'client-specific',
  client_id: JLM,
  topic_category: 'Bookkeeping',
  client_segment: 'Small Business',
};

// ======================================================================
// 1. Index-time stamping — what embedKnowledge puts on every chunk
// ======================================================================

test('buildScopeFields: client-specific source stamps scope + exact client_id', () => {
  const f = buildScopeFields(invoiceSource);
  assert.equal(f.knowledge_scope, 'client-specific');
  assert.equal(f.client_id, JLM);
  assert.equal(f.title, 'Invoice Workflow');
  assert.equal(f.topic_category, 'Bookkeeping');
});

test('buildScopeFields: general source leaves client_id unset; missing scope -> unclassified', () => {
  assert.equal(buildScopeFields({ title: 'X', knowledge_scope: 'general' }).client_id, undefined);
  assert.equal(buildScopeFields({ title: 'X' }).knowledge_scope, 'unclassified');
});

// Simulate embedKnowledge building chunks from the source: every chunk
// inherits training_id + the stamped scope fields.
const draftContents = [
  'JLM invoice draw dashboard: pull the draw request from the JLM portal before posting the invoice',
  'Post the JLM invoice against the draw schedule and attach the wire confirmation',
];
const indexedChunks = draftContents.map((content, i) => ({
  id: `chunk-${i}`,
  training_id: INVOICE_SRC_ID,
  chunk_index: i,
  chunk_type: 'sop_step',
  content,
  content_hash: `hash-${i}`,
  keywords: ['jlm', 'invoice', 'draw'],
  created_date: '2026-09-01T00:00:00Z',
  ...buildScopeFields(invoiceSource),
}));

test('indexed chunks: every chunk inherits client scope, exact client_id, and source id/title', () => {
  for (const c of indexedChunks) {
    assert.equal(c.knowledge_scope, 'client-specific');
    assert.equal(c.client_id, JLM);
    assert.equal(c.training_id, INVOICE_SRC_ID);
    assert.equal(c.title, 'Invoice Workflow');
    assert.ok(c.content.length > 0);
  }
});

// ======================================================================
// 2. Drift re-stamping — idempotent, never blanks client_id
// ======================================================================

test('scopeFieldsDrift: chunk with blanked client_id is re-stamped with the source client_id', () => {
  const drifted = { ...indexedChunks[0], client_id: undefined, knowledge_scope: 'general' };
  const drift = scopeFieldsDrift(drifted, buildScopeFields(invoiceSource), 0);
  assert.equal(drift.client_id, JLM);
  assert.equal(drift.knowledge_scope, 'client-specific');
});

test('scopeFieldsDrift: idempotent re-index of correctly stamped chunk writes nothing', () => {
  const drift = scopeFieldsDrift(indexedChunks[0], buildScopeFields(invoiceSource), 0);
  assert.equal(Object.keys(drift).length, 0, `expected no drift, got ${JSON.stringify(drift)}`);
});

test('scopeFieldsDrift: reclassify to general clears the stale client_id', () => {
  const generalFields = buildScopeFields({ ...invoiceSource, knowledge_scope: 'general', client_id: null });
  const drift = scopeFieldsDrift(indexedChunks[0], generalFields, 0);
  assert.equal(drift.client_id, null);
  assert.equal(drift.knowledge_scope, 'general');
});

// ======================================================================
// 3 & 4. Lexical retrieval — scope gate, isolation, general co-retrieval
// ======================================================================

const generalChunk = {
  id: 'chunk-general',
  training_id: 'training-general',
  chunk_index: 0,
  chunk_type: 'sop_step',
  content: 'Standard invoice workflow: match the invoice to the purchase order before posting it',
  content_hash: 'hash-general',
  keywords: ['invoice', 'workflow', 'posting'],
  knowledge_scope: 'general',
  ...buildScopeFields({ title: 'General invoicing basics', knowledge_scope: 'general' }),
};
const unclassifiedChunk = {
  id: 'chunk-unclassified',
  training_id: 'training-unclassified',
  chunk_index: 0,
  chunk_type: 'sop_step',
  content: 'JLM invoice draw dashboard shortcut never indexed on purpose',
  content_hash: 'hash-unclassified',
  keywords: ['jlm', 'invoice', 'draw'],
};
const gbpChunk = {
  id: 'chunk-gbp',
  training_id: 'training-gbp',
  chunk_index: 0,
  chunk_type: 'sop_step',
  content: 'GBP invoice draw dashboard posting rules for the GBP portal',
  content_hash: 'hash-gbp',
  keywords: ['gbp', 'invoice', 'draw'],
  ...buildScopeFields({ title: 'GBP invoicing', knowledge_scope: 'client-specific', client_id: GBP }),
};

const QUERY = 'JLM invoice draw dashboard posting';
const lexRank = (clientId) => rankChunks({
  chunks: [...indexedChunks, generalChunk, unclassifiedChunk, gbpChunk],
  queryVectors: [], // lexical-only mode: no embeddings key
  standaloneQuery: QUERY,
  clientId,
});

test('lexical retrieval with JLM context retrieves the client-specific chunks', () => {
  const { ranked } = lexRank(JLM);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes('chunk-0') || ids.includes('chunk-1'), `JLM chunks not retrieved: ${ids}`);
});

test('lexical retrieval with JLM context: general still usable, unclassified excluded, no GBP leakage', () => {
  const { ranked } = lexRank(JLM);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(ids.includes('chunk-general'), 'general knowledge must remain retrievable');
  assert.ok(!ids.includes('chunk-unclassified'), 'unclassified chunk must never be retrieved');
  assert.ok(!ids.includes('chunk-gbp'), 'cross-client leakage');
});

test('lexical retrieval with another client context does NOT retrieve the JLM chunks', () => {
  const { ranked } = lexRank(GBP);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes('chunk-0') && !ids.includes('chunk-1'), `JLM chunks leaked to GBP context: ${ids}`);
  // GBP's own chunk is legitimately retrievable in its own context.
  assert.ok(ids.includes('chunk-gbp'));
});

test('lexical retrieval with NO client context excludes all client-specific chunks', () => {
  const { ranked } = lexRank(null);
  const ids = ranked.map((r) => r.chunk.id);
  assert.ok(!ids.includes('chunk-0') && !ids.includes('chunk-1') && !ids.includes('chunk-gbp'));
  assert.ok(ids.includes('chunk-general'));
});