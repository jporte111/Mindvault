// Phase 3 — pure tests for the pre-generation governance filter and the
// authority/freshness rerank signals in base44/shared/retrieval.ts.
// NO Base44, NO network, NO embeddings key.
//   node --test scripts/rag-eval/governance-filters.test.mjs
//
// Every behavior here is asserted in BOTH modes:
//   - semantic     : queryVectors present, chunks carry an `embedding`
//   - lexical-only  : queryVectors [], chunks have no `embedding` at all
// The governance filter and nudges read denormalized chunk metadata only, so
// the two modes must produce identical kept/dropped sets and consistent order.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGovernanceFilters,
  isEffective,
  pickConfidence,
  rankChunks,
} from '../../base44/shared/retrieval.ts';
import { buildGovFields, lifecycleSkipReason } from '../../base44/shared/governance.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// --- fixture helper: a fully in-scope `general` chunk with tunable governance.
// Default content embeds the id so passages are prefix-distinct (the ranker
// dedupes on a content prefix); every default still contains all four query
// terms so lexical relevance stays equal across fixtures.
const gc = (o) => ({
  training_id: o.training_id || o.id,
  chunk_index: 0,
  chunk_type: o.chunk_type || 'sop_step',
  content: o.content || `reconcile the bank statement against the ledger — passage ${o.id}`,
  title: o.title || o.id,
  content_hash: o.id,
  knowledge_scope: 'general',
  keywords: o.keywords || ['reconcile', 'bank', 'statement', 'ledger'],
  ...o,
});

// ======================================================================
// governance.ts — index-time helpers used by embedKnowledge
// ======================================================================

test('lifecycleSkipReason: indexable source -> null', () => {
  assert.equal(lifecycleSkipReason({}), null);
  assert.equal(lifecycleSkipReason({ is_active_version: true, verification_status: 'verified' }), null);
});

test('lifecycleSkipReason: superseded > rejected > archived (first match)', () => {
  assert.equal(lifecycleSkipReason({ is_active_version: false }), 'superseded');
  assert.equal(lifecycleSkipReason({ verification_status: 'rejected' }), 'rejected');
  assert.equal(lifecycleSkipReason({ is_archived: true }), 'archived');
  assert.equal(
    lifecycleSkipReason({ is_active_version: false, verification_status: 'rejected', is_archived: true }),
    'superseded',
  );
});

test('lifecycleSkipReason: needs_review is NOT an index-time skip', () => {
  assert.equal(lifecycleSkipReason({ ingestion_quality: 'needs_review' }), null);
});

test('buildGovFields: legacy source -> every field undefined', () => {
  const g = buildGovFields({}, '');
  assert.deepEqual(Object.values(g).filter((v) => v !== undefined), []);
});

test('buildGovFields: populated source is denormalized; process freshness comes from the arg', () => {
  const g = buildGovFields({
    source_authority: 'policy',
    verification_status: 'verified',
    ingestion_quality: 'ok',
    effective_from: '2026-01-01T00:00:00Z',
    version_number: 3,
    operational_process_id: 'proc_1',
    department: 'Finance',
  }, 'stale');
  assert.equal(g.source_authority, 'policy');
  assert.equal(g.verification_status, 'verified');
  assert.equal(g.version_number, 3);
  assert.equal(g.operational_process_id, 'proc_1');
  assert.equal(g.process_freshness_status, 'stale');
  // only stamp is_active_version / source_is_archived for the excluding values
  assert.equal(g.is_active_version, undefined);
  assert.equal(g.source_is_archived, undefined);
});

test('buildGovFields: version_number must be a number, not a stringy value', () => {
  assert.equal(buildGovFields({ version_number: 0 }).version_number, 0);
  assert.equal(buildGovFields({ version_number: undefined }).version_number, undefined);
  assert.equal(buildGovFields({ version_number: 'x' }).version_number, undefined);
});

// ======================================================================
// isEffective
// ======================================================================

test('isEffective: missing bounds -> always effective', () => {
  assert.equal(isEffective(gc({ id: 'x' }), NOW), true);
});

test('isEffective: future effective_from -> not effective', () => {
  assert.equal(isEffective(gc({ id: 'x', effective_from: iso(NOW + 10 * DAY) }), NOW), false);
});

test('isEffective: past effective_until -> not effective', () => {
  assert.equal(isEffective(gc({ id: 'x', effective_until: iso(NOW - 10 * DAY) }), NOW), false);
});

test('isEffective: now inside the window -> effective', () => {
  const c = gc({ id: 'x', effective_from: iso(NOW - DAY), effective_until: iso(NOW + DAY) });
  assert.equal(isEffective(c, NOW), true);
});

test('isEffective: unparseable dates are not a constraint', () => {
  assert.equal(isEffective(gc({ id: 'x', effective_from: 'garbage', effective_until: 'nonsense' }), NOW), true);
});

// ======================================================================
// applyGovernanceFilters — the pre-generation filter
// ======================================================================

test('legacy chunk with no governance metadata is always kept', () => {
  const { kept, filteredOut } = applyGovernanceFilters([gc({ id: 'legacy' })], { now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(filteredOut.length, 0);
});

test('is_active_version === false -> dropped (superseded), missing/true kept', () => {
  const pool = [
    gc({ id: 'old', is_active_version: false }),
    gc({ id: 'cur', is_active_version: true }),
    gc({ id: 'unset' }),
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ['cur', 'unset']);
  assert.deepEqual(filteredOut, [{ id: 'old', training_id: 'old', reason: 'superseded' }]);
});

test('source_is_archived === true -> dropped (archived), missing/false kept', () => {
  const pool = [gc({ id: 'arch', source_is_archived: true }), gc({ id: 'live', source_is_archived: false }), gc({ id: 'unset' })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ['live', 'unset']);
  assert.equal(filteredOut[0].reason, 'archived');
});

test("verification_status === 'rejected' -> dropped REGARDLESS of require_verification flag", () => {
  const pool = [gc({ id: 'rej', verification_status: 'rejected' })];
  for (const requireVerified of [false, true, undefined]) {
    const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireVerified });
    assert.equal(kept.length, 0, `rejected leaked with requireVerified=${requireVerified}`);
    assert.equal(filteredOut[0].reason, 'rejected');
  }
});

// --- Phase 6: index_stale is the SOLE new always-on retrieval gate ----------

test('Phase 6: index_stale === true -> always dropped (reason index_stale), checked first', () => {
  const pool = [
    gc({ id: 'live' }),
    gc({ id: 'stale', index_stale: true }),
    gc({ id: 'staleAndSuperseded', index_stale: true, is_active_version: false }),
    gc({ id: 'missing' }), // no index_stale field -> retrievable
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ['live', 'missing']);
  const byId = Object.fromEntries(filteredOut.map((f) => [f.id, f.reason]));
  assert.equal(byId.stale, 'index_stale');
  // a chunk that is both stale AND superseded reports the actionable reason
  assert.equal(byId.staleAndSuperseded, 'index_stale');
});

test('Phase 6: retrieval never depends on any Training.index_status-like field on the chunk', () => {
  // a chunk carrying only a (hypothetical) index_status but not index_stale
  // stays retrievable — the gate is index_stale alone, join-free.
  const { kept } = applyGovernanceFilters([gc({ id: 'x', index_status: 'failed' })], { now: NOW });
  assert.equal(kept.length, 1);
});

for (const mode of ['semantic', 'lexical']) {
  const mk = mode === 'semantic' ? (o) => gc({ ...o, embedding: [1, 0, 0, 0] }) : gc;
  const qv = mode === 'semantic' ? [[1, 0, 0, 0]] : [];
  test(`[${mode}] rankChunks drops index_stale chunks in both modes (parity)`, () => {
    const pool = [
      mk({ id: 'ok', training_id: 't1' }),
      mk({ id: 'stale', training_id: 't2', index_stale: true }),
    ];
    const { ranked, filteredOut } = rankChunks({ chunks: pool, queryVectors: qv, standaloneQuery: 'reconcile bank statement ledger', clientId: null });
    assert.deepEqual(ranked.map((r) => r.chunk.id), ['ok']);
    assert.equal(filteredOut.find((f) => f.id === 'stale')?.reason, 'index_stale');
  });
}

test('effective window: future-dated -> not_yet_effective, expired -> expired', () => {
  const pool = [
    gc({ id: 'future', effective_from: iso(NOW + 5 * DAY) }),
    gc({ id: 'expired', effective_until: iso(NOW - 5 * DAY) }),
    gc({ id: 'inwindow', effective_from: iso(NOW - DAY), effective_until: iso(NOW + DAY) }),
  ];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id), ['inwindow']);
  assert.deepEqual(
    filteredOut.map((f) => [f.id, f.reason]).sort(),
    [['expired', 'expired'], ['future', 'not_yet_effective']],
  );
});

test('require_verification_for_retrieval OFF (default): unverified + missing are kept', () => {
  const pool = [gc({ id: 'v', verification_status: 'verified' }), gc({ id: 'u', verification_status: 'unverified' }), gc({ id: 'm' })];
  const { kept } = applyGovernanceFilters(pool, { now: NOW });
  assert.deepEqual(kept.map((c) => c.id).sort(), ['m', 'u', 'v']);
});

test('require_verification_for_retrieval ON: only verified survives; missing/unverified -> unverified reason', () => {
  const pool = [gc({ id: 'v', verification_status: 'verified' }), gc({ id: 'u', verification_status: 'unverified' }), gc({ id: 'm' })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireVerified: true });
  assert.deepEqual(kept.map((c) => c.id), ['v']);
  assert.deepEqual(filteredOut.map((f) => f.reason).sort(), ['unverified', 'unverified']);
});

test('require_ingestion_review OFF (default): needs_review is kept', () => {
  const { kept } = applyGovernanceFilters([gc({ id: 'nr', ingestion_quality: 'needs_review' })], { now: NOW });
  assert.equal(kept.length, 1);
});

test('require_ingestion_review ON: needs_review -> dropped; ok/missing kept', () => {
  const pool = [gc({ id: 'nr', ingestion_quality: 'needs_review' }), gc({ id: 'ok', ingestion_quality: 'ok' }), gc({ id: 'm' })];
  const { kept, filteredOut } = applyGovernanceFilters(pool, { now: NOW, requireIngestionOk: true });
  assert.deepEqual(kept.map((c) => c.id).sort(), ['m', 'ok']);
  assert.equal(filteredOut[0].reason, 'needs_review');
});

test('first-match ordering: superseded + archived + rejected chunk reports "superseded"', () => {
  const c = gc({ id: 'triple', is_active_version: false, source_is_archived: true, verification_status: 'rejected' });
  const { filteredOut } = applyGovernanceFilters([c], { now: NOW });
  assert.equal(filteredOut[0].reason, 'superseded');
});

// ======================================================================
// rankChunks integration — governance filter + rerank nudges, BOTH modes
// ======================================================================

// A chunk with a hand-set vector aligned to Q, for semantic runs.
const VEC = [1, 0, 0, 0];
const withVec = (o) => gc({ ...o, embedding: VEC });
const Q = 'reconcile bank statement ledger';

for (const mode of ['semantic', 'lexical']) {
  const mk = mode === 'semantic' ? withVec : gc;
  const queryVectors = mode === 'semantic' ? [VEC] : [];

  test(`[${mode}] governance filter runs with NO governance option (superseded/archived/rejected still dropped)`, () => {
    const pool = [
      mk({ id: 'ok1', training_id: 't1' }),
      mk({ id: 'sup', training_id: 't2', is_active_version: false }),
      mk({ id: 'arc', training_id: 't3', source_is_archived: true }),
      mk({ id: 'rej', training_id: 't4', verification_status: 'rejected' }),
    ];
    const { ranked, filteredOut } = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    const ids = ranked.map((r) => r.chunk.id);
    assert.deepEqual(ids, ['ok1']);
    assert.deepEqual(filteredOut.map((f) => f.reason).sort(), ['archived', 'rejected', 'superseded']);
  });

  test(`[${mode}] filteredOut carries { id, training_id, reason }`, () => {
    const pool = [mk({ id: 'a', training_id: 'tA' }), mk({ id: 'b', training_id: 'tB', is_active_version: false })];
    const { filteredOut } = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(filteredOut, [{ id: 'b', training_id: 'tB', reason: 'superseded' }]);
  });

  test(`[${mode}] scope is enforced BEFORE governance — other-client chunk is a scope drop, not a governance drop`, () => {
    const pool = [
      mk({ id: 'gen', training_id: 't-gen' }),
      mk({
        id: 'other', training_id: 't-other', knowledge_scope: 'client-specific', client_id: 'clientB',
        is_active_version: true, verification_status: 'verified', source_authority: 'policy',
      }),
    ];
    const { ranked, dropped, filteredOut } = rankChunks({
      chunks: pool, queryVectors, standaloneQuery: Q, clientId: 'clientA',
    });
    assert.deepEqual(ranked.map((r) => r.chunk.id), ['gen']);
    assert.deepEqual(dropped.map((d) => d.id), ['other']); // scope channel
    assert.equal(filteredOut.length, 0); // NOT re-admitted, NOT double-counted
  });

  test(`[${mode}] require_verification gate applied through rankChunks`, () => {
    const pool = [
      mk({ id: 'v', training_id: 't1', verification_status: 'verified' }),
      mk({ id: 'u', training_id: 't2', verification_status: 'unverified' }),
    ];
    const off = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(off.ranked.map((r) => r.chunk.id).sort(), ['u', 'v']);
    const on = rankChunks({
      chunks: pool, queryVectors, standaloneQuery: Q, clientId: null,
      governance: { requireVerified: true },
    });
    assert.deepEqual(on.ranked.map((r) => r.chunk.id), ['v']);
    assert.equal(on.filteredOut[0].reason, 'unverified');
  });

  test(`[${mode}] authority nudge reorders a tie; reverts when rankingEnabled=false`, () => {
    // identical relevance + hash-distinct; N is first in input order.
    const pool = [
      mk({ id: 'N', training_id: 'tN', source_authority: 'notes' }),
      mk({ id: 'P', training_id: 'tP', source_authority: 'policy' }),
    ];
    const nudged = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(nudged.ranked.map((r) => r.chunk.id), ['P', 'N'], 'policy authority should win the tie');
    const flat = rankChunks({
      chunks: pool, queryVectors, standaloneQuery: Q, clientId: null,
      governance: { rankingEnabled: false },
    });
    assert.deepEqual(flat.ranked.map((r) => r.chunk.id), ['N', 'P'], 'with nudges off, input order stands');
  });

  test(`[${mode}] freshness penalty ranks a stale-process chunk below an equal current one`, () => {
    const pool = [
      mk({ id: 'STALE', training_id: 'tS', process_freshness_status: 'stale' }),
      mk({ id: 'CUR', training_id: 'tC', process_freshness_status: 'current' }),
    ];
    const nudged = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    assert.deepEqual(nudged.ranked.map((r) => r.chunk.id), ['CUR', 'STALE']);
    const flat = rankChunks({
      chunks: pool, queryVectors, standaloneQuery: Q, clientId: null,
      governance: { rankingEnabled: false },
    });
    assert.deepEqual(flat.ranked.map((r) => r.chunk.id), ['STALE', 'CUR']);
  });

  test(`[${mode}] nudges never overtake a real relevance gap`, () => {
    const hi = mk({
      id: 'HI', training_id: 'tHI', source_authority: 'notes',
      content: 'reconcile bank statement ledger discrepancy monthly close',
      keywords: ['reconcile', 'bank', 'statement', 'ledger'],
    });
    const lo = mode === 'semantic'
      ? gc({ id: 'LO', training_id: 'tLO', source_authority: 'policy', embedding: [0, 0, 0, 1],
          content: 'office holiday schedule and parking', keywords: ['holiday', 'parking'] })
      : gc({ id: 'LO', training_id: 'tLO', source_authority: 'policy',
          content: 'office holiday schedule and parking', keywords: ['holiday', 'parking'] });
    const { ranked } = rankChunks({ chunks: [lo, hi], queryVectors, standaloneQuery: Q, clientId: null });
    assert.equal(ranked[0].chunk.id, 'HI', 'a high-authority but irrelevant chunk must not outrank the relevant one');
  });

  test(`[${mode}] pickConfidence is unaffected by governance filtering`, () => {
    const pool = [
      mk({ id: 'a', training_id: 't1' }),
      mk({ id: 'b', training_id: 't2' }),
      mk({ id: 'sup', training_id: 't3', is_active_version: false }),
    ];
    const semantic = rankChunks({ chunks: pool, queryVectors, standaloneQuery: Q, clientId: null });
    const conf = pickConfidence(semantic.ranked, { semanticActive: semantic.semanticActive });
    assert.ok(['low', 'medium', 'high'].includes(conf));
  });
}

// ======================================================================
// cross-mode parity: identical kept/dropped sets
// ======================================================================

test('semantic and lexical modes produce the SAME governance kept/dropped sets', () => {
  const base = [
    { id: 'keep', training_id: 't1', verification_status: 'verified' },
    { id: 'sup', training_id: 't2', is_active_version: false },
    { id: 'arc', training_id: 't3', source_is_archived: true },
    { id: 'rej', training_id: 't4', verification_status: 'rejected' },
    { id: 'future', training_id: 't5', effective_from: iso(NOW + 5 * DAY) },
    { id: 'unver', training_id: 't6', verification_status: 'unverified' },
  ];
  const sem = rankChunks({
    chunks: base.map((o) => gc({ ...o, embedding: VEC })),
    queryVectors: [VEC], standaloneQuery: Q, clientId: null,
    governance: { requireVerified: true, now: NOW },
  });
  const lex = rankChunks({
    chunks: base.map((o) => gc(o)),
    queryVectors: [], standaloneQuery: Q, clientId: null,
    governance: { requireVerified: true, now: NOW },
  });
  assert.deepEqual(
    sem.ranked.map((r) => r.chunk.id).sort(),
    lex.ranked.map((r) => r.chunk.id).sort(),
  );
  assert.deepEqual(
    sem.filteredOut.map((f) => [f.id, f.reason]).sort(),
    lex.filteredOut.map((f) => [f.id, f.reason]).sort(),
  );
  // only the legitimately-clean chunk survives
  assert.deepEqual(lex.ranked.map((r) => r.chunk.id), ['keep']);
});
