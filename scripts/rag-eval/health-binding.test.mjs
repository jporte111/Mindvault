// Phase 7 — MindVault health binding + computeKnowledgeHealth.
// Scope isolation, GAS, the bounded legacy chunk lookup (F2/F2a), M1 unknown
// denominator, the 25% completeness guard, gap aggregation, authority invariance,
// no-LLM/no-embeddings, banned-token payload scan.
//   node --test scripts/rag-eval/health-binding.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import {
  computeKnowledgeHealth, legacyChunkExistence,
  MAX_LEGACY_LOOKUP, BATCH, PAGE_LIMIT, MAX_PAGES_PER_BATCH,
} from '../../base44/shared/mindvaultHealth.ts';
import { BANNED_UI_TOKENS } from '../../base44/shared/health/presentation.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-09-03T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------
// in-memory Base44 stub
// ------------------------------------------------------------------
function stub({ processes = [], trainings = [], chunks = [], gaps = [], clarifs = [], ops = [], users = [], chunkPageBehavior } = {}) {
  const store = {
    OperationalProcess: processes, Training: trainings, KnowledgeChunk: chunks,
    KnowledgeGap: gaps, ClarificationRequest: clarifs, KnowledgeLifecycleOperation: ops, User: users,
  };
  const calls = { KnowledgeChunk: 0, chunkQueries: [] };
  const matches = (row, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    return row[k] === v;
  });
  const coll = (name) => ({
    async filter(q, _sort, limit, skip) {
      if (name === 'KnowledgeChunk') {
        calls.KnowledgeChunk++;
        calls.chunkQueries.push({ q, limit, skip });
        if (chunkPageBehavior) return chunkPageBehavior({ q, limit, skip: skip || 0, calls: calls.KnowledgeChunk });
      }
      let rows = store[name].filter((r) => matches(r, q || {}));
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof limit === 'number') rows = rows.slice(0, limit);
      return rows;
    },
  });
  return {
    asServiceRole: { entities: {
      OperationalProcess: coll('OperationalProcess'),
      Training: coll('Training'),
      KnowledgeChunk: coll('KnowledgeChunk'),
      KnowledgeGap: coll('KnowledgeGap'),
      ClarificationRequest: coll('ClarificationRequest'),
      KnowledgeLifecycleOperation: coll('KnowledgeLifecycleOperation'),
      User: coll('User'),
    } },
    __calls: calls,
  };
}

const T = (o) => ({
  id: o.id, title: o.id, status: 'ready', knowledge_scope: 'general',
  is_active_version: true, is_archived: false, verification_status: 'unverified',
  index_status: 'indexed', operational_process_id: null, ...o,
});
const P = (o) => ({
  id: o.id, name: o.id, status: 'active', knowledge_scope: 'general',
  criticality: 'high', process_owner: 'u1', subject_matter_expert: 'u2', backup_sme: 'u3',
  review_interval_days: 90, ...o,
});
const C = (o) => ({ id: o.id, training_id: o.training_id, created_date: iso(NOW - DAY) });

// ==================================================================
// scope isolation
// ==================================================================

test('firm-wide view NEVER sums client-specific sources/processes/gaps', async () => {
  const b = stub({
    processes: [P({ id: 'pg' }), P({ id: 'pc', knowledge_scope: 'client-specific', client_id: 'A' })],
    trainings: [
      T({ id: 'tg', operational_process_id: 'pg', verification_status: 'verified' }),
      T({ id: 'tc', knowledge_scope: 'client-specific', client_id: 'A', operational_process_id: 'pc', verification_status: 'verified' }),
    ],
    gaps: [
      { id: 'gg', title: 'g', status: 'open', client_scope: 'general', times_asked: 1, distinct_reporters: 1 },
      { id: 'gc', title: 'g', status: 'open', client_scope: 'client:A', times_asked: 1, distinct_reporters: 1 },
    ],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW, scope: { kind: 'general' } });
  assert.equal(r.processRows.length, 1);
  assert.equal(r.processRows[0].id, 'pg');
  assert.equal(r.metrics.openGaps.open, 1); // only the general gap
  assert.deepEqual(r.clientProcessCounts, { A: 1 }); // count only, no names/content
  assert.equal(JSON.stringify(r).includes('"pc"'), false, 'client process id must not appear anywhere');
  assert.equal(JSON.stringify(r).includes('"tc"'), false);
});

test('client:A view = general + client A; client B data NEVER appears', async () => {
  const b = stub({
    processes: [P({ id: 'pg' }), P({ id: 'pa', knowledge_scope: 'client-specific', client_id: 'A' }), P({ id: 'pb', knowledge_scope: 'client-specific', client_id: 'B' })],
    trainings: [
      T({ id: 'tg', operational_process_id: 'pg', verification_status: 'verified' }),
      T({ id: 'ta', knowledge_scope: 'client-specific', client_id: 'A', operational_process_id: 'pa', verification_status: 'verified' }),
      T({ id: 'tb', knowledge_scope: 'client-specific', client_id: 'B', operational_process_id: 'pb', verification_status: 'verified' }),
    ],
    gaps: [
      { id: 'ga', title: 'topicA', status: 'open', client_scope: 'client:A', times_asked: 1, distinct_reporters: 1 },
      { id: 'gb', title: 'topicB', status: 'open', client_scope: 'client:B', times_asked: 1, distinct_reporters: 1 },
    ],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW, scope: { kind: 'client', clientId: 'A' } });
  const ids = r.processRows.map((x) => x.id).sort();
  assert.deepEqual(ids, ['pa', 'pg']);
  const s = JSON.stringify(r);
  assert.equal(s.includes('"pb"'), false);
  assert.equal(s.includes('"tb"'), false);
  assert.equal(s.includes('topicB'), false);
  assert.equal(s.includes('"gb"'), false);
  assert.equal(r.metrics.openGaps.open, 1);
  assert.equal(r.clientProcessCounts, undefined); // no cross-client roll-up in a client view
});

test('unclassified sources/processes are excluded from every number; surfaced only as a setup count', async () => {
  const b = stub({
    processes: [P({ id: 'pg' }), P({ id: 'pu', knowledge_scope: 'unclassified' })],
    trainings: [
      T({ id: 'tg', operational_process_id: 'pg', verification_status: 'verified' }),
      T({ id: 'tu', knowledge_scope: 'unclassified' }),
      T({ id: 'tu2', knowledge_scope: undefined }),
    ],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.processRows.length, 1);
  assert.equal(r.metrics.activeNotVerified.total, 0); // tg is verified; tu/tu2 excluded
  assert.equal(r.setup.unclassifiedItems, 2);
});

// ==================================================================
// GAS definition
// ==================================================================

test('GAS excludes rejected / archived / superseded / not-ready sources', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: [
      T({ id: 'ok', operational_process_id: 'p', verification_status: 'verified' }),
      T({ id: 'rej', operational_process_id: 'p', verification_status: 'rejected' }),
      T({ id: 'arch', operational_process_id: 'p', is_archived: true, verification_status: 'verified' }),
      T({ id: 'old', operational_process_id: 'p', is_active_version: false, verification_status: 'verified' }),
      T({ id: 'proc', operational_process_id: 'p', status: 'processing' }),
    ],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.processRows[0].linkedSourceCount, 1); // only 'ok'
  assert.equal(r.processRows[0].coverageState, 'documented_verified');
});

// ==================================================================
// F2/F2a — bounded legacy KnowledgeChunk existence lookup
// ==================================================================

test('legacyChunkExistence: crowding — source A (many chunks) + B (one chunk), single drained page -> both true', async () => {
  const rowsForBatch = [
    ...Array.from({ length: 200 }, (_, i) => ({ training_id: 'A', id: `A${i}` })),
    { training_id: 'B', id: 'B0' },
  ];
  const b = stub({ chunkPageBehavior: ({ skip }) => (skip === 0 ? rowsForBatch : []) });
  const { answer, stats } = await legacyChunkExistence(b, ['A', 'B']);
  assert.equal(answer('A'), true);
  assert.equal(answer('B'), true);
  assert.equal(stats.proven_present, 2);
  assert.equal(stats.calls, 1); // drained on page 1 (rows.length 201 < PAGE_LIMIT)
});

test('legacyChunkExistence: matching rows span multiple pages -> id found on page 2 is TRUE, not false', async () => {
  const b = stub({
    chunkPageBehavior: ({ skip }) => {
      if (skip === 0) return Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'A', id: `A${i}` }));
      if (skip === PAGE_LIMIT) return [{ training_id: 'B', id: 'B0' }]; // short page -> drained
      return [];
    },
  });
  const { answer } = await legacyChunkExistence(b, ['A', 'B']);
  assert.equal(answer('A'), true);
  assert.equal(answer('B'), true); // discovered on page 2, never concluded absent
});

test('legacyChunkExistence: page cap hit without a short page -> undetermined ids are UNDEFINED, never false', async () => {
  const b = stub({
    chunkPageBehavior: () => Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'A', id: `x${i}` })), // never short
  });
  const { answer, stats } = await legacyChunkExistence(b, ['A', 'B', 'C']);
  assert.equal(answer('A'), true);
  assert.equal(answer('B'), undefined);
  assert.equal(answer('C'), undefined);
  assert.equal(stats.calls, MAX_PAGES_PER_BATCH); // capped
  assert.equal(stats.undetermined, 2);
});

test('legacyChunkExistence: query error -> every id in that batch is UNDEFINED, never false', async () => {
  const b = stub({ chunkPageBehavior: () => { throw new Error('boom'); } });
  const { answer, stats } = await legacyChunkExistence(b, ['A', 'B']);
  assert.equal(answer('A'), undefined);
  assert.equal(answer('B'), undefined);
  assert.equal(stats.proven_absent, 0);
});

test('legacyChunkExistence: proven absence — drained short page, id absent -> FALSE', async () => {
  const b = stub({ chunkPageBehavior: ({ skip }) => (skip === 0 ? [{ training_id: 'A', id: 'A0' }] : []) });
  const { answer, stats } = await legacyChunkExistence(b, ['A', 'B']);
  assert.equal(answer('A'), true);
  assert.equal(answer('B'), false);
  assert.equal(stats.proven_absent, 1);
});

test('legacyChunkExistence: MAX cap — 1500 ids, only 500 evaluated, 1000 truncated, calls from min(L,500)', async () => {
  const ids = Array.from({ length: 1500 }, (_, i) => `t${i}`);
  const b = stub({ chunkPageBehavior: ({ skip }) => (skip === 0 ? [] : []) }); // every batch drains empty on page 1
  const { answer, stats } = await legacyChunkExistence(b, ids);
  assert.equal(stats.evaluated, 500);
  assert.equal(stats.truncated, true);
  assert.equal(stats.truncated_count, 1000);
  assert.equal(answer('t0'), false); // evaluated + drained
  assert.equal(answer('t600'), undefined); // truncated -> undefined
  const batches = Math.ceil(500 / BATCH);
  assert.ok(stats.calls >= batches && stats.calls <= batches * MAX_PAGES_PER_BATCH,
    `calls ${stats.calls} not in [${batches}, ${batches * MAX_PAGES_PER_BATCH}]`);
});

test('computeKnowledgeHealth: sources with explicit index_status trigger ZERO chunk queries; no N+1', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: Array.from({ length: 40 }, (_, i) => T({ id: `t${i}`, operational_process_id: 'p', index_status: 'indexed' })),
  });
  await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(b.__calls.KnowledgeChunk, 0);
  // no single-id chunk query anywhere in the binding source
  const src = readFileSync(resolve(REPO, 'base44/shared/mindvaultHealth.ts'), 'utf8');
  assert.equal(/KnowledgeChunk\.filter\(\s*\{\s*training_id:\s*[a-zA-Z_]/.test(src.replace(/training_id:\s*\{\s*\$in/g, '')), false,
    'no single-id KnowledgeChunk.filter — only { training_id: { $in: batch } }');
});

test('F2: no chunk query requests content/embedding fields; index_stale never read for health', async () => {
  const src = readFileSync(resolve(REPO, 'base44/shared/mindvaultHealth.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/\.content\b|\.embedding\b|index_stale/.test(src), false);
});

// ==================================================================
// F4 — unknown coverage never becomes not_documented in the payload
// ==================================================================

test('F4: process whose only linked legacy source is UNRESOLVED -> CoverageState unknown, ContinuityState needs_setup', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: [T({ id: 'legacy', operational_process_id: 'p', index_status: null })],
    chunkPageBehavior: () => Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'z', id: `z${i}` })), // never short -> undetermined
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.processRows[0].coverageState, 'unknown');
  assert.equal(r.processRows[0].continuityState, 'needs_setup');
  assert.notEqual(r.processRows[0].coverageState, 'not_documented');
});

test('F4: process whose only linked legacy source is PROVEN ABSENT -> not_documented', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: [T({ id: 'legacy', operational_process_id: 'p', index_status: null })],
    chunkPageBehavior: () => [], // drained empty -> proven absent
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.processRows[0].coverageState, 'not_documented');
});

test('F4: truncation never makes a process display not_documented solely for an unfinished lookup', async () => {
  const ids = Array.from({ length: 600 }, (_, i) => `t${i}`);
  const procs = ids.map((id) => P({ id: `p_${id}` }));
  const tr = ids.map((id, i) => T({ id, operational_process_id: `p_${id}`, index_status: null }));
  const b = stub({ processes: procs, trainings: tr, chunkPageBehavior: ({ skip }) => (skip === 0 ? [] : []) });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  // first 500 evaluated + drained empty -> proven absent -> not_documented; last 100 truncated -> unknown
  const unknownRows = r.processRows.filter((x) => x.coverageState === 'unknown');
  assert.ok(unknownRows.length >= 100, `expected >=100 unknown from truncation, got ${unknownRows.length}`);
  for (const row of unknownRows) assert.equal(row.continuityState, 'needs_setup');
  assert.equal(r.legacy_index_lookup.truncated_count, 100);
  assert.equal(r.setup.legacyNeedingReindex, r.legacy_index_lookup.undetermined + r.legacy_index_lookup.truncated_count);
});

// ==================================================================
// M1 unknown denominator + 25% completeness guard
// ==================================================================

test('M1: unknown critical process excluded from numerator AND evaluable denominator; surfaced separately', async () => {
  const b = stub({
    processes: [P({ id: 'c1' }), P({ id: 'c2' }), P({ id: 'c3' }), P({ id: 'cu' })],
    trainings: [
      T({ id: 't1', operational_process_id: 'c1', index_status: 'indexed', verification_status: 'verified' }),
      T({ id: 't2', operational_process_id: 'c2', index_status: 'indexed', verification_status: 'verified' }),
      T({ id: 't3', operational_process_id: 'c3', index_status: 'indexed', verification_status: 'verified' }),
      T({ id: 'tu', operational_process_id: 'cu', index_status: null }),
    ],
    chunkPageBehavior: () => Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'z', id: `z${i}` })), // tu -> unresolved
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.metrics.criticalCoverage.evaluable, 3);
  assert.equal(r.metrics.criticalCoverage.covered, 3);
  assert.equal(r.metrics.criticalCoverage.unknown, 1);
  assert.ok(r.metrics.criticalCoverage.unknownDisplay.includes('1 critical processes need documentation status confirmed'));
});

test('25% guard: 2 documented + 20 unknown critical -> Coverage Snapshot band Unknown', async () => {
  const procs = [];
  const tr = [];
  const chunkAbsent = ({ skip }) => (skip === 0 ? [] : []); // proven absent (drained empty)
  // 2 documented
  for (const id of ['d1', 'd2']) {
    procs.push(P({ id }));
    tr.push(T({ id: `t_${id}`, operational_process_id: id, index_status: 'indexed', verification_status: 'verified' }));
  }
  // 20 unknown (legacy, will resolve undefined via never-short pages)
  for (let i = 0; i < 20; i++) {
    procs.push(P({ id: `u${i}` }));
    tr.push(T({ id: `t_u${i}`, operational_process_id: `u${i}`, index_status: null }));
  }
  const b = stub({
    processes: procs, trainings: tr,
    chunkPageBehavior: () => Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'zz', id: `zz${i}` })),
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.metrics.criticalCoverage.unknown, 20);
  assert.equal(r.snapshot.coverage.band, 'Unknown');
});

test('25% guard: <=25% unknown with >=3 evaluable -> normal Strong/Partial/Weak', async () => {
  const procs = [];
  const tr = [];
  // 12 covered / 3 unverified / 3 unknown  => evaluable 15, covered 12 => 80% Partial; unknown 3/18 = 16.7% ok
  for (let i = 0; i < 12; i++) { procs.push(P({ id: `v${i}` })); tr.push(T({ id: `tv${i}`, operational_process_id: `v${i}`, index_status: 'indexed', verification_status: 'verified' })); }
  for (let i = 0; i < 3; i++) { procs.push(P({ id: `n${i}` })); tr.push(T({ id: `tn${i}`, operational_process_id: `n${i}`, index_status: 'indexed', verification_status: 'unverified' })); }
  for (let i = 0; i < 3; i++) { procs.push(P({ id: `k${i}` })); tr.push(T({ id: `tk${i}`, operational_process_id: `k${i}`, index_status: null })); }
  const b = stub({ processes: procs, trainings: tr, chunkPageBehavior: () => Array.from({ length: PAGE_LIMIT }, (_, i) => ({ training_id: 'q', id: `q${i}` })) });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.metrics.criticalCoverage.evaluable, 15);
  assert.equal(r.metrics.criticalCoverage.unknown, 3);
  assert.equal(r.snapshot.coverage.band, 'Partial');
});

// ==================================================================
// verification band + gap aggregation + key-person
// ==================================================================

test('Verification band: zero verified across a large GAS population -> Review backlog + legacy caveat', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: Array.from({ length: 20 }, (_, i) => T({ id: `t${i}`, operational_process_id: 'p', verification_status: 'unverified', index_status: 'indexed' })),
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.snapshot.verification.band, 'Review backlog');
  assert.equal(r.snapshot.verification.caveat, 'Includes legacy knowledge that predates the verification workflow.');
});

test('gap aggregation: open+under_review counted; candidate = watching; merged excluded; promoted flag', async () => {
  const b = stub({
    processes: [P({ id: 'p' })],
    trainings: [T({ id: 't', operational_process_id: 'p', verification_status: 'verified' })],
    gaps: [
      { id: 'g1', title: 'x', status: 'open', client_scope: 'general', times_asked: 5, distinct_reporters: 3, operational_process_id: 'p' },
      { id: 'g2', title: 'y', status: 'under_review', client_scope: 'general', times_asked: 1, distinct_reporters: 1 },
      { id: 'g3', title: 'z', status: 'candidate', client_scope: 'general', times_asked: 1, distinct_reporters: 1 },
    ],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  assert.equal(r.metrics.openGaps.open, 2);
  assert.equal(r.metrics.openGaps.watching, 1);
  assert.equal(r.gaps.find((g) => g.id === 'g1').promoted, true);
  assert.equal(r.gaps.find((g) => g.id === 'g2').promoted, false);
  assert.ok(r.gapInvariantNote.includes('not an answer'));
});

test('key-person: undocumented critical process alone does NOT count in M6; a real sole-SME-no-backup does', async () => {
  const b = stub({
    processes: [
      P({ id: 'undoc', criticality: 'mission_critical', backup_sme: 'u3' }), // documented? no sources -> not_documented, but has backup -> no KP
      P({ id: 'sole', criticality: 'mission_critical', backup_sme: null }),
    ],
    trainings: [T({ id: 't', operational_process_id: 'sole', verification_status: 'verified' })],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  const undoc = r.processRows.find((x) => x.id === 'undoc');
  const sole = r.processRows.find((x) => x.id === 'sole');
  assert.equal(undoc.keyPersonLevel, 'none'); // exposure, not key-person
  assert.equal(undoc.continuityState, 'not_documented');
  assert.equal(sole.keyPersonLevel, 'high'); // KP1 on mission_critical
  assert.equal(r.metrics.keyPersonDependencyRisk.processes, 1);
});

// ==================================================================
// authority invariance / no LLM / no embeddings / banned tokens
// ==================================================================

test('AUTHORITY INVARIANCE: source_authority changes nothing in the payload', async () => {
  const build = (auth) => stub({
    processes: [P({ id: 'p' })],
    trainings: [T({ id: 't', operational_process_id: 'p', index_status: 'indexed', verification_status: 'verified', source_authority: auth })],
  });
  const a = await computeKnowledgeHealth(build('policy'), { now: NOW });
  const c = await computeKnowledgeHealth(build('notes'), { now: NOW });
  assert.deepEqual(a.snapshot, c.snapshot);
  assert.deepEqual(a.metrics, c.metrics);
  assert.deepEqual(a.processRows.map((x) => x.coverageState), c.processRows.map((x) => x.coverageState));
});

test('binding + primitives contain no InvokeLLM / embed / Math.random / index_stale', () => {
  const files = [
    'base44/shared/mindvaultHealth.ts',
    ...readdirSync(resolve(REPO, 'base44/shared/health')).map((f) => `base44/shared/health/${f}`),
  ];
  for (const f of files) {
    const s = readFileSync(resolve(REPO, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // `.index_stale` = a property READ; the quoted "index_stale" inside
    // presentation.ts BANNED_UI_TOKENS is the guard list, not a dependency.
    assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|[.]index_stale\b/.test(s), false, `${f} not pure`);
  }
});

test('lexical / no-embeddings parity: payload does not depend on retrieval mode or an embeddings key', async () => {
  // the binding reads Training.index_status only — no retrieval_mode, no EMBEDDINGS_API_KEY
  const src = readFileSync(resolve(REPO, 'base44/shared/mindvaultHealth.ts'), 'utf8');
  assert.equal(/retrieval_mode|EMBEDDINGS_API_KEY|planRetrieval|rankChunks/.test(src), false);
});

test('BANNED technical tokens never appear in user-facing payload strings', async () => {
  const b = stub({
    processes: [P({ id: 'p', criticality: 'mission_critical', backup_sme: null })],
    trainings: [T({ id: 't', operational_process_id: 'p', index_status: 'failed' })],
    gaps: [{ id: 'g', title: 'how to reconcile', status: 'open', client_scope: 'general', times_asked: 5, distinct_reporters: 3, operational_process_id: 'p' }],
  });
  const r = await computeKnowledgeHealth(b, { now: NOW });
  // collect every human-facing string field
  const humanKeys = new Set(['label', 'caveat', 'display', 'unknownDisplay', 'freshnessNote', 'gapInvariantNote',
    'coverageLabel', 'continuityLabel', 'keyPersonLabel', 'freshnessLabel']);
  const strings = [];
  const walk = (o, keyHint) => {
    if (typeof o === 'string') { if (humanKeys.has(keyHint)) strings.push(o); return; }
    if (Array.isArray(o)) { o.forEach((v) => walk(v, keyHint)); return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, k);
  };
  walk(r, '');
  strings.push(r.snapshot.verification.caveat || '');
  for (const s of strings) {
    const low = String(s).toLowerCase();
    for (const bad of BANNED_UI_TOKENS) assert.equal(low.includes(bad), false, `payload string "${s}" leaks "${bad}"`);
  }
});

// ==================================================================
// determinism + performance
// ==================================================================

test('determinism: identical stub -> byte-identical payload', async () => {
  const mk = () => stub({
    processes: [P({ id: 'p1' }), P({ id: 'p2', backup_sme: null })],
    trainings: [T({ id: 't1', operational_process_id: 'p1', verification_status: 'verified' })],
    gaps: [{ id: 'g', title: 't', status: 'open', client_scope: 'general', times_asked: 1, distinct_reporters: 1 }],
  });
  const a = await computeKnowledgeHealth(mk(), { now: NOW });
  const c = await computeKnowledgeHealth(mk(), { now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(c));
});

test('performance: 300 processes / 3000 sources (1500 legacy) / 5000 gaps — bounded chunk calls, single facing call', async () => {
  const procs = Array.from({ length: 300 }, (_, i) => P({ id: `p${i}`, criticality: i % 3 === 0 ? 'mission_critical' : 'medium' }));
  const tr = [];
  for (let i = 0; i < 1500; i++) tr.push(T({ id: `x${i}`, operational_process_id: `p${i % 300}`, index_status: 'indexed', verification_status: i % 2 ? 'verified' : 'unverified' }));
  for (let i = 0; i < 1500; i++) tr.push(T({ id: `l${i}`, operational_process_id: `p${i % 300}`, index_status: null }));
  const gaps = Array.from({ length: 5000 }, (_, i) => ({ id: `g${i}`, title: `q${i}`, status: 'open', client_scope: 'general', times_asked: 1, distinct_reporters: 1, operational_process_id: `p${i % 300}` }));
  const b = stub({ processes: procs, trainings: tr, gaps, chunkPageBehavior: ({ skip }) => (skip === 0 ? [{ training_id: 'nobody' }] : []) });
  const t0 = Date.now();
  const r = await computeKnowledgeHealth(b, { now: NOW });
  const dt = Date.now() - t0;
  const batches = Math.ceil(Math.min(1500, MAX_LEGACY_LOOKUP) / BATCH); // 10
  assert.ok(b.__calls.KnowledgeChunk >= batches && b.__calls.KnowledgeChunk <= batches * MAX_PAGES_PER_BATCH,
    `chunk calls ${b.__calls.KnowledgeChunk} outside [${batches}, ${batches * MAX_PAGES_PER_BATCH}]`);
  assert.equal(r.legacy_index_lookup.evaluated, 500);
  assert.equal(r.legacy_index_lookup.truncated_count, 1000);
  assert.ok(dt < 2500, `compute took ${dt}ms`);
});
