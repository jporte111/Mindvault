// Phase 9 P9-2 — pure tests for base44/shared/health/trendSeries.ts.
// Chronological ordering, NO interpolation, missing periods stay missing, bounded
// by the caller, deterministic, no score.
//   node --test scripts/rag-eval/trend-series.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTrendSeries,
  TREND_SERIES_DIMENSIONS,
  TREND_SERIES_GOVERNANCE_DIMENSIONS,
  TREND_SERIES_MAX_PERIODS,
} from '../../base44/shared/health/trendSeries.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const snap = (period_key, over = {}) => ({
  period_key, client_scope: 'general', schema_version: 1,
  processes_at_risk: 0, reviews_overdue: 0, active_not_verified: 0, gaps_open: 0,
  key_person_high_or_critical: 0, sources_needing_attention: 0,
  processes_without_owner_or_sme: 0, sources_needing_cadence: 0,
  ...over,
});

test('the leadership dimension set is exactly the P9-2 spec, plus two optional governance dims', () => {
  assert.deepEqual([...TREND_SERIES_DIMENSIONS], [
    'processes_at_risk', 'reviews_overdue', 'active_not_verified', 'gaps_open',
    'key_person_high_or_critical', 'sources_needing_attention',
  ]);
  assert.deepEqual([...TREND_SERIES_GOVERNANCE_DIMENSIONS], ['processes_without_owner_or_sme', 'sources_needing_cadence']);
  assert.equal(TREND_SERIES_MAX_PERIODS, 12);
});

test('points are chronological regardless of input order', () => {
  const rows = [snap('2026-09', { reviews_overdue: 3 }), snap('2026-07', { reviews_overdue: 9 }), snap('2026-08', { reviews_overdue: 6 })];
  const [s] = buildTrendSeries(rows, ['reviews_overdue']);
  assert.deepEqual(s.points.map((p) => p.period_key), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(s.points.map((p) => p.value), [9, 6, 3]);
  assert.equal(s.first, 9);
  assert.equal(s.last, 3);
  assert.equal(s.min, 3);
  assert.equal(s.max, 9);
});

test('NO interpolation — a missing month is simply absent, not synthesized', () => {
  const rows = [snap('2026-06', { gaps_open: 4 }), snap('2026-09', { gaps_open: 1 })]; // 07 + 08 missing
  const [s] = buildTrendSeries(rows, ['gaps_open']);
  assert.deepEqual(s.points.map((p) => p.period_key), ['2026-06', '2026-09']);
  assert.equal(s.points.length, 2, 'exactly the two real rows; no filler points for 07/08');
});

test('a row missing the dimension field contributes no point (never treated as 0)', () => {
  const r2 = snap('2026-08'); delete r2.active_not_verified;
  const rows = [snap('2026-07', { active_not_verified: 5 }), r2, snap('2026-09', { active_not_verified: 2 })];
  const [s] = buildTrendSeries(rows, ['active_not_verified']);
  assert.deepEqual(s.points.map((p) => p.period_key), ['2026-07', '2026-09']);
});

test('one period -> a single point (caller shows the empty state, helper does not invent a line)', () => {
  const [s] = buildTrendSeries([snap('2026-09', { processes_at_risk: 3 })], ['processes_at_risk']);
  assert.equal(s.points.length, 1);
  assert.equal(s.first, 3);
  assert.equal(s.last, 3);
});

test('empty history -> empty points, zeroed bounds, null first/last', () => {
  const [s] = buildTrendSeries([], ['gaps_open']);
  assert.deepEqual(s, { key: 'gaps_open', points: [], min: 0, max: 0, first: null, last: null });
});

test('deterministic: identical rows -> identical series', () => {
  const rows = [snap('2026-07', { gaps_open: 2 }), snap('2026-08', { gaps_open: 4 })];
  assert.deepEqual(buildTrendSeries(rows, [...TREND_SERIES_DIMENSIONS]), buildTrendSeries(rows, [...TREND_SERIES_DIMENSIONS]));
});

test('no composite / weighted / percentage score in the output shape', () => {
  const out = buildTrendSeries([snap('2026-08'), snap('2026-09')], [...TREND_SERIES_DIMENSIONS]);
  const s = JSON.stringify(out);
  assert.equal(/"score"|overall|health_score|percent/i.test(s), false);
});

test('trendSeries.ts is pure — only a type import; no LLM / embeddings / randomness / Base44', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/trendSeries.ts', HERE), 'utf8'));
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|@base44\/sdk|asServiceRole|entities\.|Deno\./.test(src), false);
});
