// Phase 9 P9-2 correction — src/lib/sparkline.js: a missing month must be
// VISUALLY discontinuous, not only absent from the data. No interpolation, no
// zero-fill, no synthesized point.
//   node --test scripts/rag-eval/sparkline.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSparklinePath, monthOrdinal } from '../../src/lib/sparkline.js';

const HERE = new URL('.', import.meta.url);
const P = (period_key, value) => ({ period_key, value });

test('monthOrdinal parses YYYY-MM; null on junk', () => {
  assert.equal(monthOrdinal('2026-08'), 2026 * 12 + 8);
  assert.equal(monthOrdinal('2026-10') - monthOrdinal('2026-08'), 2); // Sep in between
  assert.equal(monthOrdinal('2026-01') - monthOrdinal('2025-12'), 1); // year wrap
  assert.equal(monthOrdinal('nope'), null);
  assert.equal(monthOrdinal(undefined), null);
});

test('contiguous months -> ONE continuous path segment (single M, then Ls)', () => {
  const { d, segments, dots } = buildSparklinePath([P('2026-07', 4), P('2026-08', 6), P('2026-09', 3)]);
  assert.equal(segments, 1, 'one M command');
  assert.equal((d.match(/M/g) || []).length, 1);
  assert.equal((d.match(/L/g) || []).length, 2);
  assert.equal(dots.length, 3);
});

test('Aug -> Oct with Sep MISSING -> the path BREAKS (two subpaths, no bridging L)', () => {
  const { d, segments, dots } = buildSparklinePath([P('2026-08', 6), P('2026-10', 2)]);
  assert.equal(segments, 2, 'a new M starts after the gap — no connecting segment across September');
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((d.match(/L/g) || []).length, 0, 'no L command bridges the missing month');
  assert.equal(dots.length, 2, 'exactly the two real points — no synthesized September dot');
  // x of the Oct point is placed by real month offset (2/2 of the span), not index (1/1)
  assert.ok(dots[1].x > dots[0].x);
});

test('multi-gap series: only adjacent months are connected', () => {
  // Jan, Feb (adjacent), then May (gap), then Jun (adjacent)
  const { d, segments } = buildSparklinePath([P('2026-01', 1), P('2026-02', 2), P('2026-05', 9), P('2026-06', 4)]);
  assert.equal(segments, 2); // {Jan-Feb} and {May-Jun}
  const cmds = d.match(/[ML]/g);
  assert.deepEqual(cmds, ['M', 'L', 'M', 'L']);
});

test('x positions reflect actual elapsed months, not array index', () => {
  const contiguous = buildSparklinePath([P('2026-01', 1), P('2026-02', 1), P('2026-03', 1)]);
  const gapped = buildSparklinePath([P('2026-01', 1), P('2026-02', 1), P('2026-12', 1)]);
  // last point: contiguous span = 2 months -> right edge; gapped span = 11 months,
  // the 2nd point (Feb) sits at 1/11 of the width, far left of the 1/2 an index model would give.
  assert.ok(gapped.dots[1].x < contiguous.dots[1].x, 'Feb is pushed left when the series spans to December');
});

test('no interpolation / zero-fill: a gap never adds a point or a value', () => {
  const { dots } = buildSparklinePath([P('2026-03', 5), P('2026-09', 1)]); // 4 months missing
  assert.equal(dots.length, 2);
  assert.deepEqual(dots.map((p) => p.period_key), ['2026-03', '2026-09']);
});

test('fewer than 2 real points -> empty geometry (caller renders the dash)', () => {
  assert.deepEqual(buildSparklinePath([]), { d: '', dots: [], segments: 0, points: 0 });
  const one = buildSparklinePath([P('2026-09', 3)]);
  assert.equal(one.points, 1);
  assert.equal(one.segments, 1);
});

test('deterministic: identical points -> identical geometry', () => {
  const pts = [P('2026-06', 2), P('2026-08', 5)];
  assert.deepEqual(buildSparklinePath(pts), buildSparklinePath(pts));
});

test('sparkline.js is pure — no imports, no React, no randomness', () => {
  const src = readFileSync(new URL('../../src/lib/sparkline.js', HERE), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false, 'must not import anything');
  assert.equal(/from ['"]react|Math\.random|InvokeLLM/.test(src), false);
});
