// Phase 9 P9-2 — the read-only history endpoint (listKnowledgeHealthSnapshots)
// and the computeKnowledgeHealth FUNCTION BOUNDARY presentation enrichment
// (rationale + governance). The Phase 7 engine and the P9-1 trend/snapshot
// semantics are unchanged.
//   node --test scripts/rag-eval/p9-2-enrichment.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTrendSeries, TREND_SERIES_DIMENSIONS, TREND_SERIES_MAX_PERIODS } from '../../base44/shared/health/trendSeries.ts';
import { priorityRationale } from '../../base44/shared/health/priorityRationale.ts';
import { governanceCompletenessRow } from '../../base44/shared/health/governanceCompleteness.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const listSrc = readFileSync(new URL('../../base44/functions/listKnowledgeHealthSnapshots/entry.ts', HERE), 'utf8');
const listNoC = stripComments(listSrc);
const healthEntrySrc = readFileSync(new URL('../../base44/functions/computeKnowledgeHealth/entry.ts', HERE), 'utf8');
const healthEntryNoC = stripComments(healthEntrySrc);
const engineNoC = stripComments(readFileSync(new URL('../../base44/shared/mindvaultHealth.ts', HERE), 'utf8'));

// ==================================================================
// listKnowledgeHealthSnapshots — read-only, bounded, admin-only, exact scope
// ==================================================================

test('list endpoint: admin gate + knowledge_health_enabled gate, both before the read', () => {
  assert.ok(/user\.role !== 'admin'/.test(listNoC));
  const flagIdx = listNoC.indexOf("knowledge_health_enabled !== true");
  const readIdx = listNoC.indexOf('KnowledgeHealthSnapshot');
  assert.ok(flagIdx > -1 && flagIdx < readIdx, 'the health-flag gate must precede the snapshot read');
});

test('list endpoint: reads ONE exact client_scope, newest-first, bounded to <= 12', () => {
  assert.ok(/client_scope = .*body\.scope.*clientId.*\? `client:\$\{String\(body\.scope\.clientId\)\}` : 'general'/.test(listSrc)
    || /`client:\$\{String\(body\.scope\.clientId\)\}`/.test(listSrc));
  assert.ok(/KnowledgeHealthSnapshot\s*\.filter\(\{ client_scope \}, '-period_key', limit\)/.test(listNoC),
    'must filter on the exact client_scope only');
  assert.ok(/Math\.min\(TREND_SERIES_MAX_PERIODS/.test(listNoC), 'limit must be clamped to TREND_SERIES_MAX_PERIODS');
  assert.equal(TREND_SERIES_MAX_PERIODS, 12);
});

test('list endpoint: read-only — no writes, no LLM / embeddings', () => {
  assert.equal(/\.(create|update|delete|bulkCreate|bulkUpdate)\s*\(/.test(listNoC), false);
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random/.test(listNoC), false);
});

// Functional scope isolation: replicate filter({client_scope}, '-period_key', N)
function selectScopeHistory(allRows, client_scope, limit) {
  return allRows
    .filter((r) => r.client_scope === client_scope)
    .sort((a, b) => (a.period_key < b.period_key ? 1 : -1)) // newest first, like '-period_key'
    .slice(0, Math.max(1, Math.min(TREND_SERIES_MAX_PERIODS, limit || TREND_SERIES_MAX_PERIODS)));
}
const snap = (client_scope, period_key, over = {}) => ({
  client_scope, period_key, schema_version: 1,
  processes_at_risk: 0, reviews_overdue: 0, active_not_verified: 0, gaps_open: 0,
  key_person_high_or_critical: 0, sources_needing_attention: 0,
  processes_without_owner_or_sme: 0, sources_needing_cadence: 0, ...over,
});

test('scope isolation: general history excludes client rows; client A never sees client B', () => {
  const all = [
    snap('general', '2026-08', { reviews_overdue: 1 }), snap('general', '2026-09', { reviews_overdue: 2 }),
    snap('client:A', '2026-08', { reviews_overdue: 10 }), snap('client:A', '2026-09', { reviews_overdue: 11 }),
    snap('client:B', '2026-08', { reviews_overdue: 99 }), snap('client:B', '2026-09', { reviews_overdue: 98 }),
  ];
  const gen = selectScopeHistory(all, 'general', 12);
  assert.deepEqual(gen.map((r) => r.reviews_overdue).sort(), [1, 2]);
  const a = selectScopeHistory(all, 'client:A', 12);
  assert.deepEqual(a.map((r) => r.reviews_overdue).sort(), [10, 11]);
  const [sA] = buildTrendSeries(a, ['reviews_overdue']);
  assert.deepEqual(sA.points.map((p) => p.value), [10, 11]); // chronological, only A
  assert.equal(JSON.stringify(a).includes('99'), false, 'client B value must not appear in client A history');
});

test('bounded: last-N respected; chronological ordering after slice', () => {
  const all = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((p, i) => snap('general', p, { gaps_open: i }));
  const win = selectScopeHistory(all, 'general', 3); // newest 3: 05,04,03
  const [s] = buildTrendSeries(win, ['gaps_open']);
  assert.deepEqual(s.points.map((p) => p.period_key), ['2026-03', '2026-04', '2026-05']);
  assert.equal(s.points.length, 3);
});

// ==================================================================
// computeKnowledgeHealth boundary — P9-2 presentation enrichment
// ==================================================================

test('boundary: rationale + governance enrichment happens at the FUNCTION, not the engine', () => {
  assert.ok(/priorityRationale\(\{ kind: it\?\.kind, criticality: it\?\.criticality \}\)/.test(healthEntryNoC));
  assert.ok(/governanceCompletenessRow\(r\)/.test(healthEntryNoC));
  assert.ok(/addressFirst: \(payload\.addressFirst \|\| \[\]\)\.map\(withRationale\)/.test(healthEntryNoC));
  assert.ok(/reviewQueue: \(payload\.reviewQueue \|\| \[\]\)\.map\(withRationale\)/.test(healthEntryNoC));
  // the engine stays clean
  assert.equal(/priorityRationale|governanceCompleteness|governance:|rationale:/.test(engineNoC), false,
    'mindvaultHealth.ts must not compute rationale/governance');
});

test('boundary: P9-2 fields are present with AND without the snapshots flag (no extra flag gate)', () => {
  // enriched is built before the snapshots-flag branch; both returns use it
  const enrichedIdx = healthEntryNoC.indexOf('const enriched = {');
  const flagBranchIdx = healthEntryNoC.indexOf("knowledge_health_snapshots_enabled !== true");
  assert.ok(enrichedIdx > -1 && enrichedIdx < flagBranchIdx, 'enrichment must precede the P9-1 flag branch');
  assert.ok(/return Response\.json\(enriched\);/.test(healthEntryNoC), 'flag-off path returns the enriched payload');
  assert.ok(/return Response\.json\(\{ \.\.\.enriched, trend \}\)/.test(healthEntryNoC), 'flag-on path spreads enriched + trend');
});

test('boundary: P9-1 trend semantics unchanged — still exact client_scope, in-memory < current period', () => {
  assert.ok(/KnowledgeHealthSnapshot\s*\.filter\(\{ client_scope \}, '-period_key', 24\)/.test(healthEntryNoC));
  assert.ok(/find\(\(r\) => String\(r\?\.period_key\) < period_key\)/.test(healthEntryNoC));
  assert.ok(/computeTrend\(current, prior\)/.test(healthEntryNoC));
});

test('functional: withRationale maps kind+criticality only; governance maps a processRow', () => {
  const it = { id: 'q1', kind: 'key_person_dependency', criticality: 'mission_critical', title: 'Close' };
  assert.equal(priorityRationale({ kind: it.kind, criticality: it.criticality }),
    'Mission-critical process depends on one expert with no backup');
  const g = governanceCompletenessRow({ id: 'p1', name: 'Close', criticality: 'high', owner: null, sme: { id: 'u', name: 'D' }, coverageState: 'not_documented', freshness: 'unknown' });
  assert.equal(g.owner.status, 'missing');
  assert.equal(g.sme.status, 'present');
  assert.equal(g.reviewCadence.status, 'missing');
  assert.equal(g.coverage.status, 'missing');
});

// ==================================================================
// engine invariant (re-asserted for P9-2)
// ==================================================================

test('mindvaultHealth.ts still does not import/query snapshots or read a P9 flag', () => {
  assert.equal(/KnowledgeHealthSnapshot|knowledge_health_snapshots_enabled|computeTrend|snapshotFromHealthPayload|buildTrendSeries/.test(engineNoC), false);
});
