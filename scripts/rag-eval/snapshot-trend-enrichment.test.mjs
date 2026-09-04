// Phase 9 P9-1 — trend enrichment at the computeKnowledgeHealth FUNCTION
// BOUNDARY, and the invariant that the Phase 7 current-health engine
// (base44/shared/mindvaultHealth.ts) stays free of all historical concerns.
//   node --test scripts/rag-eval/snapshot-trend-enrichment.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotFromHealthPayload, SNAPSHOT_SCHEMA_VERSION } from '../../base44/shared/health/snapshotProjection.ts';
import { computeTrend } from '../../base44/shared/health/trend.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const engineSrc = readFileSync(new URL('../../base44/shared/mindvaultHealth.ts', HERE), 'utf8');
const engineNoComments = stripComments(engineSrc);
const entrySrc = readFileSync(new URL('../../base44/functions/computeKnowledgeHealth/entry.ts', HERE), 'utf8');
const entryNoComments = stripComments(entrySrc);

// ==================================================================
// INVARIANT: the Phase 7 engine never touches historical concerns
// ==================================================================

test('mindvaultHealth.ts (Phase 7 engine) does NOT import or query KnowledgeHealthSnapshot', () => {
  assert.equal(/KnowledgeHealthSnapshot/.test(engineNoComments), false,
    'the current-health engine must not reference the snapshot entity');
});

test('mindvaultHealth.ts does NOT read the P9 flag or compute a trend', () => {
  assert.equal(/knowledge_health_snapshots_enabled/.test(engineNoComments), false);
  assert.equal(/computeTrend|snapshotFromHealthPayload|snapshotProjection|health\/trend/.test(engineNoComments), false);
  // it returns no `trend` key
  assert.equal(/\btrend\s*:/.test(engineNoComments), false);
});

// ==================================================================
// The FUNCTION BOUNDARY does the enrichment — source-level guarantees
// ==================================================================

test('entry: when the snapshots flag is not true, NO trend key is added (P9-2 presentation fields aside)', () => {
  // the early return must be the flag guard, before any trend code
  const guardIdx = entryNoComments.indexOf("knowledge_health_snapshots_enabled !== true");
  assert.ok(guardIdx > -1, 'entry must guard on the P9-1 flag');
  // flag-off path returns WITHOUT a trend key. (P9-2 added rationale/governance
  // to the returned object — `enriched` — but never a `trend`.)
  assert.ok(/knowledge_health_snapshots_enabled !== true\)\s*\{\s*return Response\.json\(enriched\);/.test(entryNoComments),
    'flag-off path must return the payload with no trend key');
  assert.equal(/return Response\.json\(enriched\);[\s\S]*trend/.test(
    entryNoComments.slice(guardIdx, entryNoComments.indexOf('computeTrend'))), false,
    'no trend before the flag branch resolves');
  const trendIdx = entryNoComments.indexOf('computeTrend(current');
  assert.ok(guardIdx < trendIdx, 'the flag guard must precede the trend computation');
});

test('entry: prior snapshot is read for the EXACT client_scope only (isolation boundary)', () => {
  assert.ok(/client_scope = scope\.kind === 'client' \? `client:\$\{scope\.clientId\}` : 'general'/.test(entrySrc));
  assert.ok(/KnowledgeHealthSnapshot\s*\.filter\(\{\s*client_scope\s*\}/.test(entryNoComments),
    'prior lookup must filter on the exact client_scope, nothing broader');
  // it must not fetch across scopes and filter later
  assert.equal(/KnowledgeHealthSnapshot\.filter\(\{\}\)/.test(entryNoComments), false);
});

test('entry: current projection + computeTrend, then the payload is spread with trend appended', () => {
  assert.ok(/snapshotFromHealthPayload\(payload, \{/.test(entryNoComments));
  assert.ok(/computeTrend\(current, prior\)/.test(entryNoComments));
  // P9-2 renamed the spread base `payload` -> `enriched`; P9-3 appends `change`
  // alongside `trend`. The P9-1 trend computation itself is unchanged.
  assert.ok(/return Response\.json\(\{ \.\.\.enriched, trend, change \}\)/.test(entryNoComments));
});

// ==================================================================
// Functional: prior-selection + strict scope isolation (replicating the
// entry's in-memory "-period_key, find < current" selection)
// ==================================================================

const healthPayload = (scope, over = {}) => ({
  scope,
  snapshot: {
    coverage: { band: 'Partial' }, currency: { band: 'Current' },
    verification: { band: 'Mostly confirmed' }, keyPersonResilience: { band: 'Watch' },
  },
  metrics: {
    criticalCoverage: { covered: 10, evaluable: 12, unknown: 1 },
    knowledgeNeedingReview: { overdue: 2, due_soon: 1 },
    activeNotVerified: { total: 3, criticalLinked: 1 },
    openGaps: { open: 1, watching: 2 },
    processesWithoutOwnerOrSme: 1,
    keyPersonDependencyRisk: { processes: 1, concentrationPeople: 0 },
    sourcesNeedingAttention: 0, effectiveDateExposure: { expiredActive: 0 },
  },
  setup: {
    processesNeedingOwner: 0, processesNeedingSme: 0, processesNeedingCriticality: 0,
    sourcesNeedingCadence: 0, unlinkedSources: 0, unclassifiedItems: 0, legacyNeedingReindex: 0,
  },
  processRows: [{ id: 'p1', continuityState: 'ready' }],
  ...over,
});

// mimic entry.ts: filter by client_scope, sort -period_key, take newest < current
function selectPrior(allRows, client_scope, currentPeriod) {
  const scoped = allRows
    .filter((r) => r.client_scope === client_scope)
    .sort((a, b) => (a.period_key < b.period_key ? 1 : -1));
  return scoped.find((r) => r.period_key < currentPeriod) || null;
}

test('prior selection: newest snapshot strictly before the current period, same scope', () => {
  const rows = [
    { period_key: '2026-06', client_scope: 'general', schema_version: 1, ...num() },
    { period_key: '2026-08', client_scope: 'general', schema_version: 1, ...num({ reviews_overdue: 9 }) },
    { period_key: '2026-09', client_scope: 'general', schema_version: 1, ...num() }, // current period — must be ignored
  ];
  const prior = selectPrior(rows, 'general', '2026-09');
  assert.equal(prior.period_key, '2026-08');
  const current = snapshotFromHealthPayload(healthPayload({ kind: 'general' }), { period_key: '2026-09', schema_version: SNAPSHOT_SCHEMA_VERSION });
  const t = computeTrend(current, prior);
  assert.equal(t.previous_period_key, '2026-08');
  assert.equal(t.dimensions.reviews_overdue.direction, 'improving'); // 9 -> 2
});

test('STRICT isolation: a client:A request never reads client:B history', () => {
  const rows = [
    { period_key: '2026-08', client_scope: 'client:A', schema_version: 1, ...num({ reviews_overdue: 4 }) },
    { period_key: '2026-08', client_scope: 'client:B', schema_version: 1, ...num({ reviews_overdue: 99 }) },
    { period_key: '2026-08', client_scope: 'general', schema_version: 1, ...num({ reviews_overdue: 50 }) },
  ];
  const priorA = selectPrior(rows, 'client:A', '2026-09');
  assert.equal(priorA.client_scope, 'client:A');
  assert.equal(priorA.reviews_overdue, 4);
  const currentA = snapshotFromHealthPayload(healthPayload({ kind: 'client', clientId: 'A' }), { period_key: '2026-09', schema_version: SNAPSHOT_SCHEMA_VERSION });
  assert.equal(currentA.client_scope, 'client:A');
  const t = computeTrend(currentA, priorA);
  // 4 -> 2 improving; if B's 99 or general's 50 had leaked in it would read differently
  assert.equal(t.dimensions.reviews_overdue.direction, 'improving');
  assert.deepEqual([t.dimensions.reviews_overdue.previous, t.dimensions.reviews_overdue.current], [4, 2]);
});

test('no prior for this scope -> comparable:false, "starts after next snapshot" state', () => {
  const rows = [{ period_key: '2026-08', client_scope: 'client:B', schema_version: 1, ...num() }];
  const priorA = selectPrior(rows, 'client:A', '2026-09');
  assert.equal(priorA, null);
  const currentA = snapshotFromHealthPayload(healthPayload({ kind: 'client', clientId: 'A' }), { period_key: '2026-09', schema_version: SNAPSHOT_SCHEMA_VERSION });
  const t = computeTrend(currentA, priorA);
  assert.equal(t.comparable, false);
  assert.equal(t.previous_period_key, null);
});

// minimal numeric row filler for a snapshot
function num(over = {}) {
  return {
    coverage_band: 'Partial', currency_band: 'Current', verification_band: 'Mostly confirmed', key_person_resilience_band: 'Watch',
    critical_covered: 10, critical_evaluable: 12, critical_unknown: 1,
    reviews_overdue: 2, reviews_due_soon: 1, active_not_verified: 3, active_not_verified_critical: 1,
    gaps_open: 1, gaps_watching: 2, processes_total: 5, processes_at_risk: 0,
    key_person_high_or_critical: 1, concentration_people: 0, sources_needing_attention: 0, expired_active: 0,
    processes_without_owner_or_sme: 1, processes_needing_owner: 0, processes_needing_sme: 0,
    processes_needing_criticality: 0, sources_needing_cadence: 0, unlinked_sources: 0, unclassified_items: 0, legacy_needing_reindex: 0,
    ...over,
  };
}
