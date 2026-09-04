// Phase 9 P9-1 — pure tests for base44/shared/health/trend.ts. Deterministic,
// no composite / weighted / percentage score. Directions, Unknown semantics,
// coverage-denominator guard, schema-version mismatch, missing prior/field,
// symmetry, and the "label by actual prior period; never interpolate" rule.
//   node --test scripts/rag-eval/trend.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeTrend, monthsBetween } from '../../base44/shared/health/trend.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// A full projection row with sane defaults; override per test.
const row = (over = {}) => ({
  period_key: '2026-09', client_scope: 'general', schema_version: 1,
  coverage_band: 'Partial', currency_band: 'Slipping', verification_band: 'Mostly confirmed',
  key_person_resilience_band: 'Watch',
  critical_covered: 8, critical_evaluable: 12, critical_unknown: 3,
  reviews_overdue: 5, reviews_due_soon: 2,
  active_not_verified: 9, active_not_verified_critical: 4,
  gaps_open: 3, gaps_watching: 6,
  processes_total: 20, processes_at_risk: 4,
  key_person_high_or_critical: 2, concentration_people: 1,
  sources_needing_attention: 4, expired_active: 1,
  processes_without_owner_or_sme: 7,
  processes_needing_owner: 3, processes_needing_sme: 4, processes_needing_criticality: 2,
  sources_needing_cadence: 6, unlinked_sources: 5, unclassified_items: 8, legacy_needing_reindex: 10,
  ...over,
});

test('missing prior -> comparable:false, previous_period_key null, every dimension unknown', () => {
  const t = computeTrend(row(), null);
  assert.equal(t.comparable, false);
  assert.equal(t.previous_period_key, null);
  assert.equal(t.periods_elapsed, null);
  for (const d of Object.values(t.dimensions)) assert.equal(d.direction, 'unknown');
});

test('lower-is-better counts: down improving, up deteriorating, equal stable', () => {
  const prior = row({ period_key: '2026-08', reviews_overdue: 6, gaps_open: 3, processes_at_risk: 4 });
  const cur = row({ reviews_overdue: 2, gaps_open: 5, processes_at_risk: 4 });
  const t = computeTrend(cur, prior);
  assert.equal(t.comparable, true);
  assert.equal(t.dimensions.reviews_overdue.direction, 'improving');
  assert.deepEqual([t.dimensions.reviews_overdue.previous, t.dimensions.reviews_overdue.current], [6, 2]);
  assert.equal(t.dimensions.gaps_open.direction, 'deteriorating');
  assert.equal(t.dimensions.processes_at_risk.direction, 'stable');
});

test('higher-is-better critical_covered: up improving, down deteriorating', () => {
  assert.equal(computeTrend(row({ critical_covered: 10 }), row({ period_key: '2026-08', critical_covered: 6 })).dimensions.critical_covered.direction, 'improving');
  assert.equal(computeTrend(row({ critical_covered: 4 }), row({ period_key: '2026-08', critical_covered: 9 })).dimensions.critical_covered.direction, 'deteriorating');
});

test('ordinal band comparisons: Weak->Partial improving, Confirmed->Review backlog deteriorating, equal stable', () => {
  const up = computeTrend(row({ coverage_band: 'Partial' }), row({ period_key: '2026-08', coverage_band: 'Weak' }));
  assert.equal(up.dimensions.coverage_band.direction, 'improving');
  const down = computeTrend(row({ verification_band: 'Review backlog' }), row({ period_key: '2026-08', verification_band: 'Confirmed' }));
  assert.equal(down.dimensions.verification_band.direction, 'deteriorating');
  const same = computeTrend(row({ currency_band: 'Slipping' }), row({ period_key: '2026-08', currency_band: 'Slipping' }));
  assert.equal(same.dimensions.currency_band.direction, 'stable');
});

test('Unknown band on EITHER side -> unknown (never "improving" when data drops below the threshold)', () => {
  const drop = computeTrend(row({ coverage_band: 'Unknown' }), row({ period_key: '2026-08', coverage_band: 'Weak' }));
  assert.equal(drop.dimensions.coverage_band.direction, 'unknown');
  const rise = computeTrend(row({ coverage_band: 'Strong' }), row({ period_key: '2026-08', coverage_band: 'Unknown' }));
  assert.equal(rise.dimensions.coverage_band.direction, 'unknown');
});

test('coverage ratio uses critical_covered / critical_evaluable; either evaluable < 3 -> unknown', () => {
  // both >= 3, ratio improves 6/12 -> 10/12
  const ok = computeTrend(row({ critical_covered: 10, critical_evaluable: 12 }),
    row({ period_key: '2026-08', critical_covered: 6, critical_evaluable: 12 }));
  assert.equal(ok.dimensions.critical_coverage_ratio.direction, 'improving');
  assert.deepEqual(ok.dimensions.critical_coverage_ratio.previous, { covered: 6, evaluable: 12 });
  assert.deepEqual(ok.dimensions.critical_coverage_ratio.current, { covered: 10, evaluable: 12 });
  // current evaluable < 3
  const cLow = computeTrend(row({ critical_covered: 2, critical_evaluable: 2 }),
    row({ period_key: '2026-08', critical_covered: 6, critical_evaluable: 12 }));
  assert.equal(cLow.dimensions.critical_coverage_ratio.direction, 'unknown');
  // prior evaluable < 3
  const pLow = computeTrend(row({ critical_covered: 6, critical_evaluable: 12 }),
    row({ period_key: '2026-08', critical_covered: 1, critical_evaluable: 2 }));
  assert.equal(pLow.dimensions.critical_coverage_ratio.direction, 'unknown');
});

test('schema-version mismatch -> comparable:false, all dimensions unknown, prior period still reported', () => {
  const t = computeTrend(row({ schema_version: 2 }), row({ period_key: '2026-08', schema_version: 1 }));
  assert.equal(t.comparable, false);
  assert.equal(t.previous_period_key, '2026-08');
  for (const d of Object.values(t.dimensions)) assert.equal(d.direction, 'unknown');
});

test('missing field on the prior row -> that dimension unknown, others still compared', () => {
  const prior = row({ period_key: '2026-08' });
  delete prior.reviews_overdue;
  const t = computeTrend(row({ reviews_overdue: 2, gaps_open: 1 }), prior);
  assert.equal(t.dimensions.reviews_overdue.direction, 'unknown');
  assert.equal(t.dimensions.gaps_open.direction, 'improving');
});

test('missed monthly periods: periods_elapsed reflects the ACTUAL prior period; nothing interpolated', () => {
  const t = computeTrend(row({ period_key: '2026-09' }), row({ period_key: '2026-06' }));
  assert.equal(t.previous_period_key, '2026-06');
  assert.equal(t.periods_elapsed, 3);
  assert.equal(monthsBetween('2025-11', '2026-02'), 3);
  assert.equal(monthsBetween('bad', '2026-02'), null);
});

test('symmetry: swapping current/prior flips every comparable non-unknown direction', () => {
  const a = row({ period_key: '2026-09', reviews_overdue: 2, critical_covered: 10, coverage_band: 'Strong',
    critical_covered_dummy: 0, critical_evaluable: 12 });
  const b = row({ period_key: '2026-08', reviews_overdue: 6, critical_covered: 5, coverage_band: 'Weak', critical_evaluable: 12 });
  const ab = computeTrend(a, b).dimensions;
  const ba = computeTrend({ ...b, period_key: '2026-09' }, { ...a, period_key: '2026-08' }).dimensions;
  const flip = { improving: 'deteriorating', deteriorating: 'improving', stable: 'stable', unknown: 'unknown' };
  for (const k of Object.keys(ab)) {
    if (ab[k].direction === 'unknown') continue;
    assert.equal(ba[k].direction, flip[ab[k].direction], `dimension ${k} not symmetric`);
  }
});

test('no composite / weighted / percentage score anywhere in the result', () => {
  const t = computeTrend(row(), row({ period_key: '2026-08' }));
  assert.equal('score' in t, false);
  assert.equal('overall' in t, false);
  assert.equal('health_score' in t, false);
  const s = JSON.stringify(t);
  assert.equal(/"score"|overallScore|health_score|"percent"/.test(s), false);
});

test('trend.ts is pure — no Base44 SDK / entity / LLM / embeddings / randomness', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/trend.ts', HERE), 'utf8'));
  assert.equal(/@base44\/sdk|createClientFromRequest|asServiceRole|entities\.|InvokeLLM|\.embed\s*\(|Math\.random|Deno\./.test(src), false);
});
