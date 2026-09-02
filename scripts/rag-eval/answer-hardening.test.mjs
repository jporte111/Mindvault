// Phase 4.1 — lexical-evidence hardening. Proves the corrected contract:
//   - atomic per-row lexical evidence tuple { lex, lexHits, lexQueryTermCount }
//   - HIGH requires ONE row to clear all three lexical bars (no cross-row max)
//   - short / generic queries cannot reach HIGH from fractional overlap
//   - conservative per-row weak-evidence pre-generation gate
//   - rewrite-drift caps confidence, never hard-fails
//   - medium operational band caps at PARTIAL
// NO Base44, NO network, NO embeddings.
//   node --test scripts/rag-eval/answer-hardening.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS,
  hasMinimumEvidence,
  lexicalScore,
  lexicalScoreDetailed,
  pickConfidence,
  rankChunks,
  rewriteDriftSignal,
} from '../../base44/shared/retrieval.ts';
import { deriveAnswerStatus } from '../../base44/shared/operationalAnswer.ts';

const L = THRESHOLDS.lexical;
// a lexical-evidence row (semantic fields zeroed)
const row = (lex, lexHits, lexQueryTermCount) => ({ chunk: {}, score: lex, sem: 0, lex, lexHits, lexQueryTermCount });
const LEX = { semanticActive: false };

// ======================================================================
// lexicalScoreDetailed <-> lexicalScore, and the row invariant
// ======================================================================

test('lexicalScoreDetailed returns a coherent { lex, hits } pair; lexicalScore is the wrapper', () => {
  const chunk = { content: 'reconcile the bank statement monthly', keywords: ['reconcile', 'bank', 'statement'] };
  const qt = ['reconcile', 'bank', 'ledger', 'monthly']; // 4 terms; matches reconcile,bank,monthly = 3
  const d = lexicalScoreDetailed(qt, chunk);
  assert.equal(d.hits, 3);
  assert.equal(d.lex, 3 / 4);
  assert.equal(lexicalScore(qt, chunk), d.lex);
  // empty query
  assert.deepEqual(lexicalScoreDetailed([], chunk), { lex: 0, hits: 0 });
});

test('rankChunks stamps the atomic tuple; lexHits === round(lex * lexQueryTermCount) for every row', () => {
  const chunks = [
    { training_id: 't1', knowledge_scope: 'general', content: 'reconcile the bank statement each month', keywords: ['reconcile', 'bank', 'statement', 'month'], content_hash: 'h1' },
    { training_id: 't2', knowledge_scope: 'general', content: 'payroll is approved by the controller', keywords: ['payroll', 'approve', 'controller'], content_hash: 'h2' },
  ];
  const { ranked } = rankChunks({ chunks, queryVectors: [], standaloneQuery: 'reconcile bank statement ledger', clientId: null });
  assert.ok(ranked.length >= 1);
  for (const r of ranked) {
    assert.equal(typeof r.lexHits, 'number');
    assert.equal(r.lexQueryTermCount, 4, 'denominator = tokenize(standaloneQuery).length');
    assert.equal(r.lexQuery, 'standalone');
    assert.equal(r.lexHits, Math.round(r.lex * r.lexQueryTermCount), 'row invariant');
  }
});

// ======================================================================
// blocker 1 — no cross-row maxima; HIGH needs ONE coherent row
// ======================================================================

test('blocker 1: high lex / 1 hit  +  low lex / 2 hits  does NOT become HIGH', () => {
  assert.equal(pickConfidence([row(0.80, 1, 5), row(0.20, 2, 5)], LEX), 'medium');
});

test('blocker 1: HIGH requires one candidate to satisfy BOTH lexical thresholds', () => {
  // one row clears lex>=0.45 AND lexHits>=2 AND lexQueryTermCount>=3
  assert.equal(pickConfidence([row(0.60, 3, 4)], LEX), 'high');
  // identical numbers split across two rows -> not HIGH
  assert.equal(pickConfidence([row(0.60, 1, 4), row(0.20, 3, 4)], LEX), 'medium');
});

test('blocker 1: hasMinimumEvidence is per-row (never combines maxima from different rows)', () => {
  // row A clears the lex floor on its own -> gate passes
  assert.equal(hasMinimumEvidence([row(0.90, 1, 1), row(0.05, 3, 1)], LEX), true);
  // no row clears EITHER floor -> gate rejects
  assert.equal(hasMinimumEvidence([row(0.20, 1, 4), row(0.10, 1, 4)], LEX), false);
  // a row clears via hits alone
  assert.equal(hasMinimumEvidence([row(0.10, 2, 20)], LEX), true);
});

// ======================================================================
// blocker 2 — single query basis carried on the row
// ======================================================================

test('blocker 2: a candidate scored against a SHORT query carries that query denominator/hits consistently', () => {
  // lex 0.50, 1 hit, denominator 2  -> fails highMinMatchedTerms and highMinQueryTerms
  assert.equal(pickConfidence([row(0.50, 1, 2)], LEX), 'medium');
});

test('blocker 2: generated search-query shortening cannot turn weak standalone evidence into HIGH', () => {
  // weak standalone evidence: 6-term query, 1 term matched -> row (0.167, 1, 6)
  const band = pickConfidence([row(1 / 6, 1, 6)], LEX);
  assert.notEqual(band, 'high', 'weak standalone evidence must never be HIGH');
  assert.equal(band, 'medium', 'lex 0.167 >= 0.15 (not LOW) but far below HIGH bars');
});

test('blocker 2: even a fabricated short-query row (1.0, 1, 1) cannot reach HIGH', () => {
  assert.equal(pickConfidence([row(1.0, 1, 1)], LEX), 'medium');
});

test('blocker 2: rankChunks lexical evidence always derives from the standalone query only', () => {
  // search_queries would be an embeddings-only concept; in lexical mode they do
  // not exist. Confirm the denominator is the standalone token count regardless.
  const chunks = [{ training_id: 't1', knowledge_scope: 'general', content: 'vendor invoice filing and draw request approval process', keywords: ['vendor', 'invoice', 'draw', 'approval'], content_hash: 'h1' }];
  const { ranked } = rankChunks({
    chunks, queryVectors: [],
    standaloneQuery: 'what is the emergency vendor payment approval threshold and who signs off',
    clientId: null,
  });
  const r = ranked[0];
  assert.ok(r.lexQueryTermCount >= 6, 'denominator is the long standalone query, not a short search variant');
  assert.equal(r.lexHits, Math.round(r.lex * r.lexQueryTermCount));
});

// ======================================================================
// short / generic queries
// ======================================================================

test('1-word generic query: perfect fractional overlap, 1 hit -> never HIGH', () => {
  assert.equal(pickConfidence([row(1.0, 1, 1)], LEX), 'medium');
});

test('2-word terse valid query: both terms matched -> may answer, never HIGH', () => {
  assert.equal(pickConfidence([row(1.0, 2, 2)], LEX), 'medium'); // qTC 2 < 3
  assert.equal(hasMinimumEvidence([row(1.0, 2, 2)], LEX), true); // may answer
});

test('normal supported query: >=3 terms, one row clears all bars -> HIGH', () => {
  assert.equal(pickConfidence([row(0.75, 3, 4)], LEX), 'high');
  assert.equal(pickConfidence([row(0.44, 2, 4), row(0.40, 2, 4)], LEX), 'medium', 'neither row clears lex 0.45 alone');
});

// ======================================================================
// weak-evidence pre-generation gate
// ======================================================================

test('hasMinimumEvidence: rejects only when NO row clears either modest floor', () => {
  assert.equal(hasMinimumEvidence([], LEX), false);
  assert.equal(hasMinimumEvidence([row(0.20, 1, 4)], LEX), false, 'lex<0.25 and hits<2');
  assert.equal(hasMinimumEvidence([row(0.25, 1, 4)], LEX), true, 'lex clears');
  assert.equal(hasMinimumEvidence([row(0.10, 2, 20)], LEX), true, 'hits clears');
  assert.equal(hasMinimumEvidence([row(0.90, 1, 1)], LEX), true, 'one concise authoritative source passes');
});

test('hasMinimumEvidence: always true in semantic mode (that path is gated elsewhere)', () => {
  assert.equal(hasMinimumEvidence([row(0.0, 0, 5)], { semanticActive: true }), true);
});

// ======================================================================
// rewrite-drift signal
// ======================================================================

test('rewriteDriftSignal: contentless raw, rewrite carries NONE of it + adds >=4 terms -> true', () => {
  assert.equal(
    rewriteDriftSignal('uh the thing', 'How do I run the monthly vendor payment reconciliation process'),
    true,
  );
});

test('rewriteDriftSignal: terse legitimate question is NOT flagged (a raw term is carried forward)', () => {
  assert.equal(
    rewriteDriftSignal('bank reconciliation?', 'how do I reconcile the bank statement at month end'),
    false, // "bank" is carried into the standalone -> elaboration, not substitution
  );
  assert.equal(
    rewriteDriftSignal('payroll?', 'how do I run the payroll approval and submit'),
    false, // "payroll" carried
  );
});

test('rewriteDriftSignal: raw already carries the operational content -> false', () => {
  assert.equal(
    rewriteDriftSignal('invoice when process approval reconcile', 'How do I process an invoice, get approval, and reconcile it'),
    false, // raw.length 5 > rawMaxContentTerms 2
  );
});

test('rewriteDriftSignal: normal-length raw question -> false regardless of rewrite', () => {
  assert.equal(rewriteDriftSignal('what is the approval threshold for an emergency vendor payment', 'approval threshold emergency vendor payment sign off who'), false);
});

// ======================================================================
// end-to-end status: medium band caps at PARTIAL
// ======================================================================

test('medium band + valid cited answer + full facet coverage -> PARTIAL, never HIGH', () => {
  const r = deriveAnswerStatus({
    baseBand: 'medium', directAnswerValid: true,
    requestedFacets: ['steps'], survivingSectionKeys: ['steps'], contradictionNoteKept: false,
  });
  assert.equal(r.status, 'PARTIAL');
});

test('high band + valid cited answer + full coverage -> HIGH (unchanged)', () => {
  const r = deriveAnswerStatus({
    baseBand: 'high', directAnswerValid: true,
    requestedFacets: ['steps'], survivingSectionKeys: ['steps'], contradictionNoteKept: false,
  });
  assert.equal(r.status, 'HIGH');
});
