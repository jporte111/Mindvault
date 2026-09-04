// Phase 9 P9-3 — the computeKnowledgeHealth function boundary selects the latest
// two PERSISTED fingerprint-bearing snapshots for the exact client_scope and runs
// persisted-vs-persisted change detection. It never builds a live current
// fingerprint. Exact scope isolation. The Phase 7 engine stays clean.
//   node --test scripts/rag-eval/p9-3-boundary.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FINGERPRINT_VERSION, LONG_UNRESOLVED_PERIODS,
  isFingerprintBearing, computeContinuityChange, computeGapChange,
} from '../../base44/shared/health/continuityChange.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const entrySrc = readFileSync(new URL('../../base44/functions/computeKnowledgeHealth/entry.ts', HERE), 'utf8');
const entryNoC = stripComments(entrySrc);
const engineNoC = stripComments(readFileSync(new URL('../../base44/shared/mindvaultHealth.ts', HERE), 'utf8'));

// ==================================================================
// Boundary source-level guarantees
// ==================================================================

test('boundary: change detection is inside the P9-1 flag gate (knowledge_health_snapshots_enabled)', () => {
  const gate = entryNoC.indexOf("knowledge_health_snapshots_enabled !== true");
  const change = entryNoC.indexOf('computeContinuityChange(');
  assert.ok(gate > -1 && gate < change, 'change block must be after the flag gate');
});

test('boundary: selects fingerprint-bearing rows from the exact-scope fetch; latest + immediately prior only', () => {
  assert.ok(/KnowledgeHealthSnapshot\s*\.filter\(\{ client_scope \}, '-period_key', 24\)/.test(entryNoC),
    'exact client_scope fetch, newest-first');
  assert.ok(/\.filter\(isFingerprintBearing\)/.test(entryNoC), 'filters to fingerprint-bearing rows');
  assert.ok(/const latestFp = fpRows\[0\]/.test(entryNoC));
  assert.ok(/const priorFp = fpRows\[1\]/.test(entryNoC));
  assert.ok(/computeContinuityChange\(latestFp, priorFp\)/.test(entryNoC));
  assert.ok(/computeGapChange\(latestFp, priorFp, fpRows\.slice\(0, LONG_UNRESOLVED_PERIODS \+ 2\)\)/.test(entryNoC));
});

test('boundary: change is returned alongside trend; live health is unchanged', () => {
  assert.ok(/return Response\.json\(\{ \.\.\.enriched, trend, change \}\)/.test(entryNoC));
  // the flag-off path still returns the enriched payload with NO trend and NO change
  assert.ok(/knowledge_health_snapshots_enabled !== true\)\s*\{\s*return Response\.json\(enriched\);/.test(entryNoC));
  assert.equal(/computeKnowledgeHealth\(base44,[^)]*\)[\s\S]*fingerprintsFromHealthPayload/.test(entryNoC), false,
    'the boundary must not build a live current fingerprint');
});

test('engine (mindvaultHealth.ts) never references fingerprints / change / the P9 flag', () => {
  assert.equal(/fingerprint|continuityChange|computeContinuityChange|computeGapChange|KnowledgeHealthSnapshot|knowledge_health_snapshots_enabled/.test(engineNoC), false);
});

// ==================================================================
// Persisted-vs-persisted selection semantics (functional)
// ==================================================================

const fp = (period_key, expTokens, gapTuples, over = {}) => ({
  period_key, fingerprint_version: FINGERPRINT_VERSION,
  exposure_fingerprint: JSON.stringify([...expTokens].sort()),
  exposure_truncated: false,
  gap_fingerprint: JSON.stringify([...gapTuples].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  gap_truncated: false, ...over,
});

// replicate the boundary's selection over a '-period_key' newest-first array
function selectFp(rows) {
  const fpRows = rows.filter(isFingerprintBearing);
  return { latestFp: fpRows[0] || null, priorFp: fpRows[1] || null, run: fpRows.slice(0, LONG_UNRESOLVED_PERIODS + 2) };
}

test('pre-P9-3 rows (no fingerprint_version) are skipped as non-fingerprint-bearing history', () => {
  const rows = [
    { period_key: '2026-10' },                        // pre-P9-3, no fingerprints
    { period_key: '2026-09' },                        // pre-P9-3
    fp('2026-08', ['a~at_risk~h'], []),
    fp('2026-07', ['a~at_risk~h', 'b~at_risk~h'], []),
  ];
  const { latestFp, priorFp } = selectFp(rows);
  assert.equal(latestFp.period_key, '2026-08');
  assert.equal(priorFp.period_key, '2026-07');
  const r = computeContinuityChange(latestFp, priorFp);
  assert.equal(r.comparable, true);
  assert.deepEqual(r.categories.atRisk.resolved.ids, ['b']); // b in 07, gone in 08
});

test('only one fingerprint-bearing period -> comparable:false, no inference from live absence', () => {
  const rows = [fp('2026-10', ['x~at_risk~h'], [['g1', 9, 'o', 1, 'h']]), { period_key: '2026-09' }];
  const { latestFp, priorFp } = selectFp(rows);
  assert.equal(priorFp, null);
  const c = computeContinuityChange(latestFp, priorFp);
  const g = computeGapChange(latestFp, priorFp, [latestFp]);
  assert.equal(c.comparable, false);
  assert.equal(c.reason, 'insufficient_history');
  assert.equal(g.comparable, false);
  assert.equal(c.categories.atRisk.new.count, null); // not "1" — no inference from the live payload
});

test('newer INCOMPATIBLE fingerprint_version -> comparable:false; NOT silently skipped for an older pair', () => {
  const rows = [
    fp('2026-10', ['p1~at_risk~h', 'p2~at_risk~h'], [], { fingerprint_version: FINGERPRINT_VERSION + 1 }),
    fp('2026-09', ['p1~at_risk~h'], []),
    fp('2026-08', [], []),
  ];
  const { latestFp, priorFp } = selectFp(rows);
  assert.equal(latestFp.period_key, '2026-10');   // the newer incompatible row is still `latest`
  assert.equal(priorFp.period_key, '2026-09');
  const r = computeContinuityChange(latestFp, priorFp);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'version_changed');
  assert.equal(r.previous_period_key, '2026-09'); // actual prior reported
  // the 08<->09 pair is NOT compared as though current
  assert.equal(r.latest_period_key, '2026-10');
});

// ==================================================================
// Exact client_scope isolation
// ==================================================================

test('isolation: client A change output never contains a client B id; general data may legitimately appear in client A', () => {
  // Each scope's fingerprint rows only ever hold ids that scope's payload had.
  const aRows = [
    // client:A and general ids both newly at-risk this period (both were absent last period)
    fp('2026-10', ['procA1~at_risk~h', 'procGen1~at_risk~m'], [['gA1', 5, 'o', 0, 'h']]),
    fp('2026-09', [], [['gA1', 1, 'o', 0, 'h']]),
  ];
  const aSel = selectFp(aRows);
  const aChange = computeContinuityChange(aSel.latestFp, aSel.priorFp);
  const aGap = computeGapChange(aSel.latestFp, aSel.priorFp, aSel.run);
  const blob = JSON.stringify({ aChange, aGap });
  assert.equal(/procB1|gB1/.test(blob), false, 'no client B identifiers in client A output');
  assert.deepEqual(aChange.categories.atRisk.new.ids.sort(), ['procA1', 'procGen1']);
  assert.ok(/procGen1/.test(blob), 'a general id legitimately visible to client A is fine (permitted, not a leak)');
});
