// Phase 9 P9-3 — pure tests for base44/shared/health/continuityChange.ts.
// Deterministic fingerprint projection + persisted-period vs persisted-period
// change detection + gap intelligence. No Base44 / Deno / LLM / embeddings /
// randomness. No names / titles / questions / topics / keywords / facets /
// reporter or employee data anywhere.
//   node --test scripts/rag-eval/continuity-change.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FINGERPRINT_VERSION, MAX_EXPOSURE_TOKENS, MAX_GAP_FINGERPRINTS, FREQ_RISE_MIN, LONG_UNRESOLVED_PERIODS,
  critChar, shiftMonthKey, monthStartMs,
  exposureFingerprintFromPayload, gapFingerprintFromPayload, fingerprintsFromHealthPayload,
  parseExposureFingerprint, parseGapFingerprint, isFingerprintBearing,
  computeContinuityChange, computeGapChange,
} from '../../base44/shared/health/continuityChange.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// --- payload fixture (only the fields the projection reads) ---
const prow = (o = {}) => ({
  id: 'p1', criticality: 'high',
  owner: { id: 'u1', name: 'Alice' }, sme: { id: 'u2', name: 'Dana' }, backup: null,
  continuityState: 'ready', keyPersonLevel: 'none', freshness: 'current', coverageState: 'documented_verified',
  ...o,
});
const gpayload = (rows, gaps = []) => ({ processRows: rows, gaps });

// ==================================================================
// small month helpers
// ==================================================================

test('critChar maps the enum; shiftMonthKey / monthStartMs are deterministic', () => {
  assert.deepEqual(['mission_critical', 'high', 'medium', 'low', null].map(critChar), ['m', 'h', 'd', 'l', 'x']);
  assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
  assert.equal(shiftMonthKey('2026-10', -1), '2026-09');
  assert.equal(shiftMonthKey('2026-12', 1), '2027-01');
  assert.equal(monthStartMs('2026-09'), Date.UTC(2026, 8, 1));
  assert.ok(Number.isNaN(monthStartMs('bad')));
});

// ==================================================================
// exposure fingerprint — allowed kinds only, sorted/deduped, capped
// ==================================================================

test('exposure kinds: at_risk / key_person(high|critical) / overdue_review', () => {
  const rows = [
    prow({ id: 'a', continuityState: 'at_risk' }),
    prow({ id: 'b', keyPersonLevel: 'high' }),
    prow({ id: 'c', keyPersonLevel: 'critical' }),
    prow({ id: 'd', keyPersonLevel: 'elevated' }),   // NOT high/critical -> no key_person
    prow({ id: 'e', freshness: 'overdue' }),
  ];
  const { tokens } = exposureFingerprintFromPayload(gpayload(rows));
  assert.ok(tokens.includes('a~at_risk~h'));
  assert.ok(tokens.includes('b~key_person~h'));
  assert.ok(tokens.includes('c~key_person~h'));
  assert.equal(tokens.some((t) => t.startsWith('d~key_person')), false, 'elevated does not manufacture key_person');
  assert.ok(tokens.includes('e~overdue_review~h'));
});

test('critical_doc_gap ONLY: (high|mission_critical) AND coverageState === "not_documented"', () => {
  const rows = [
    prow({ id: 'nd_high', criticality: 'high', coverageState: 'not_documented' }),      // yes
    prow({ id: 'nd_mc', criticality: 'mission_critical', coverageState: 'not_documented' }), // yes
    prow({ id: 'na_high', criticality: 'high', coverageState: 'needs_attention' }),      // NO — not a doc gap
    prow({ id: 'nd_med', criticality: 'medium', coverageState: 'not_documented' }),      // NO — not critical
  ];
  const { tokens } = exposureFingerprintFromPayload(gpayload(rows));
  assert.ok(tokens.includes('nd_high~critical_doc_gap~h'));
  assert.ok(tokens.includes('nd_mc~critical_doc_gap~m'));
  assert.equal(tokens.some((t) => t.includes('~critical_doc_gap~') && t.startsWith('na_high')), false,
    'needs_attention must NOT emit critical_doc_gap');
  assert.equal(tokens.some((t) => t.includes('~critical_doc_gap~') && t.startsWith('nd_med')), false);
});

test('governance_setup ONLY: missing owner OR SME OR criticality — never from freshness "unknown"', () => {
  const rows = [
    prow({ id: 'no_owner', owner: null }),                                   // yes
    prow({ id: 'no_sme', sme: null }),                                       // yes
    prow({ id: 'no_crit', criticality: null }),                             // yes
    prow({ id: 'fresh_unknown', freshness: 'unknown' }),                     // NO — cadence is not inferred here
  ];
  const { tokens } = exposureFingerprintFromPayload(gpayload(rows));
  assert.ok(tokens.includes('no_owner~governance_setup~h'));
  assert.ok(tokens.includes('no_sme~governance_setup~h'));
  assert.ok(tokens.some((t) => t.startsWith('no_crit~governance_setup~')));
  assert.equal(tokens.some((t) => t.startsWith('fresh_unknown~governance_setup')), false,
    'freshness "unknown" must NOT emit governance_setup');
});

test('exposure tokens are sorted, deduped, deterministic', () => {
  const rows = [prow({ id: 'z', continuityState: 'at_risk' }), prow({ id: 'a', continuityState: 'at_risk' }), prow({ id: 'a', continuityState: 'at_risk' })];
  const a = exposureFingerprintFromPayload(gpayload(rows));
  const b = exposureFingerprintFromPayload(gpayload(rows));
  assert.deepEqual(a, b);
  assert.deepEqual(a.tokens, [...a.tokens].sort());
  assert.equal(new Set(a.tokens).size, a.tokens.length);
});

test('exposure cap sets exposure_truncated', () => {
  const rows = Array.from({ length: MAX_EXPOSURE_TOKENS + 50 }, (_, i) => prow({ id: `p${i}`, continuityState: 'at_risk' }));
  const { tokens, truncated } = exposureFingerprintFromPayload(gpayload(rows));
  assert.equal(truncated, true);
  assert.equal(tokens.length, MAX_EXPOSURE_TOKENS);
});

// ==================================================================
// gap fingerprint — compact tuples, no text, resolved rows -> 'r'
// ==================================================================

test('gap tuples: [id, times_asked, statusChar, promoted, critChar]; sorted by id; resolved rows -> r', () => {
  const rows = [prow({ id: 'proc1', criticality: 'mission_critical' })];
  const gaps = [
    { id: 'g2', state: 'open', promoted: true, timesAsked: 8, processId: 'proc1' },
    { id: 'g1', state: 'candidate', promoted: false, timesAsked: 2, processId: null },
  ];
  const resolved = [{ id: 'g0', times_asked: 5, operational_process_id: 'proc1' }];
  const { tuples } = gapFingerprintFromPayload(gpayload(rows, gaps), resolved);
  assert.deepEqual(tuples, [
    ['g0', 5, 'r', 0, 'm'],
    ['g1', 2, 'c', 0, 'n'],
    ['g2', 8, 'o', 1, 'm'],
  ]);
});

test('gap cap sets gap_truncated', () => {
  const gaps = Array.from({ length: MAX_GAP_FINGERPRINTS + 20 }, (_, i) => ({ id: `g${String(i).padStart(4, '0')}`, state: 'open', timesAsked: 1 }));
  const { tuples, truncated } = gapFingerprintFromPayload(gpayload([], gaps), []);
  assert.equal(truncated, true);
  assert.equal(tuples.length, MAX_GAP_FINGERPRINTS);
});

test('fingerprintsFromHealthPayload: version + JSON strings + no person/text data', () => {
  const rows = [prow({ id: 'p1', continuityState: 'at_risk', owner: null }), prow({ id: 'p2', keyPersonLevel: 'high' })];
  const gaps = [{ id: 'g1', state: 'open', promoted: true, timesAsked: 9, processId: 'p2' }];
  const fp = fingerprintsFromHealthPayload(gpayload(rows, gaps), []);
  assert.equal(fp.fingerprint_version, FINGERPRINT_VERSION);
  assert.equal(typeof fp.exposure_fingerprint, 'string');
  assert.equal(typeof fp.gap_fingerprint, 'string');
  const blob = JSON.stringify(fp);
  assert.equal(/Alice|Dana|title|normalized_topic|keyword|missing_facet|question|reporter|distinct_reporters|example/i.test(blob), false);
  // only ids, small ints, and single-letter codes
  for (const tok of JSON.parse(fp.exposure_fingerprint)) assert.match(tok, /^[\w-]+~[a-z_]+~[mhdlx]$/);
  for (const t of JSON.parse(fp.gap_fingerprint)) {
    assert.equal(t.length, 5);
    assert.match(String(t[2]), /^[oucrn]$/);
    assert.match(String(t[4]), /^[mhdlxn]$/);
  }
});

// ==================================================================
// computeContinuityChange — new / resolved / persisting / unknown
// ==================================================================

const fpRow = (period_key, tokens, over = {}) => ({
  period_key, fingerprint_version: FINGERPRINT_VERSION,
  exposure_fingerprint: JSON.stringify([...tokens].sort()),
  exposure_truncated: false,
  gap_fingerprint: '[]', gap_truncated: false,
  ...over,
});

test('missing prior -> comparable:false, insufficient_history, all categories unknown (never zero)', () => {
  const r = computeContinuityChange(fpRow('2026-10', ['p1~at_risk~h']), null);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'insufficient_history');
  assert.equal(r.previous_period_key, null);
  assert.equal(r.categories.atRisk.new.count, null);
  assert.deepEqual(r.categories.atRisk.new.ids, []);
});

test('new / resolved / persisting for at_risk, with the newCritical sub-count', () => {
  const prior = fpRow('2026-09', ['keep~at_risk~h', 'gone~at_risk~m']);
  const latest = fpRow('2026-10', ['keep~at_risk~h', 'fresh~at_risk~m', 'fresh2~at_risk~d']);
  const r = computeContinuityChange(latest, prior);
  assert.equal(r.comparable, true);
  assert.equal(r.previous_period_key, '2026-09');
  assert.equal(r.periods_elapsed, 1);
  assert.deepEqual(r.categories.atRisk.new.ids, ['fresh', 'fresh2']);
  assert.deepEqual(r.categories.atRisk.resolved.ids, ['gone']);
  assert.deepEqual(r.categories.atRisk.newCritical.ids, ['fresh']); // 'm' counts; 'd' does not
});

test('key_person / overdue_review / governance_setup new & resolved', () => {
  const prior = fpRow('2026-09', ['a~key_person~h', 'b~overdue_review~h', 'c~governance_setup~x']);
  const latest = fpRow('2026-10', ['a~key_person~h', 'd~overdue_review~h', 'e~governance_setup~x']);
  const r = computeContinuityChange(latest, prior);
  assert.deepEqual(r.categories.keyPerson.new.ids, []);
  assert.deepEqual(r.categories.keyPerson.resolved.ids, []);       // 'a' persists
  assert.deepEqual(r.categories.overdueReview.new.ids, ['d']);
  assert.deepEqual(r.categories.overdueReview.resolved.ids, ['b']);
  assert.deepEqual(r.categories.governanceSetup.regressed.ids, ['e']);
  assert.deepEqual(r.categories.governanceSetup.improved.ids, ['c']);
});

test('exposure_truncated on EITHER side -> comparable:false (reason truncated), categories unknown', () => {
  const prior = fpRow('2026-09', ['p1~at_risk~h']);
  const latest = fpRow('2026-10', ['p1~at_risk~h', 'p2~at_risk~h'], { exposure_truncated: true });
  const r = computeContinuityChange(latest, prior);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'truncated');
  assert.equal(r.previous_period_key, '2026-09');
  assert.equal(r.categories.atRisk.new.count, null);
});

test('newer INCOMPATIBLE fingerprint_version -> comparable:false, version_changed, prior reported, NOT silently skipped', () => {
  const prior = fpRow('2026-09', ['p1~at_risk~h']);
  const latest = fpRow('2026-10', ['p1~at_risk~h', 'p2~at_risk~h'], { fingerprint_version: FINGERPRINT_VERSION + 1 });
  const r = computeContinuityChange(latest, prior);
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'version_changed');
  assert.equal(r.previous_period_key, '2026-09');
  assert.equal(r.latest_period_key, '2026-10');
  assert.equal(r.categories.atRisk.new.count, null);
});

test('skipped month labels the ACTUAL prior period, never "last month"; nothing interpolated', () => {
  const r = computeContinuityChange(
    fpRow('2026-10', ['x~at_risk~h']),
    fpRow('2026-08', []),
  );
  assert.equal(r.previous_period_key, '2026-08');
  assert.equal(r.periods_elapsed, 2);
  assert.deepEqual(r.categories.atRisk.new.ids, ['x']); // only current vs the single prior row
});

test('deterministic: identical rows -> identical change output', () => {
  const p = fpRow('2026-09', ['a~at_risk~h']);
  const l = fpRow('2026-10', ['a~at_risk~h', 'b~key_person~m']);
  assert.deepEqual(computeContinuityChange(l, p), computeContinuityChange(l, p));
});

// ==================================================================
// computeGapChange — frequency, promotion, resolved, recurring, long-unresolved
// ==================================================================

const gRow = (period_key, tuples, over = {}) => ({
  period_key, fingerprint_version: FINGERPRINT_VERSION,
  exposure_fingerprint: '[]', exposure_truncated: false,
  gap_fingerprint: JSON.stringify([...tuples].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  gap_truncated: false, ...over,
});

test('frequency rise: latest.a - prior.a >= FREQ_RISE_MIN', () => {
  const prior = gRow('2026-09', [['g1', 3, 'o', 0, 'h'], ['g2', 5, 'o', 0, 'n']]);
  const latest = gRow('2026-10', [['g1', 8, 'o', 0, 'h'], ['g2', 6, 'o', 0, 'n']]);
  const r = computeGapChange(latest, prior, [latest, prior]);
  assert.equal(r.comparable, true);
  assert.deepEqual(r.frequencyRises.items, [{ id: 'g1', from: 3, to: 8 }]); // +5 >= 2; g2 +1 < 2
});

test('newly promoted (p 0/absent -> 1); resolved since prior (o|u|c -> r); recurring; critical-process', () => {
  const prior = gRow('2026-09', [['g1', 2, 'o', 0, 'm'], ['g2', 4, 'u', 0, 'n'], ['g3', 1, 'c', 0, 'h']]);
  const latest = gRow('2026-10', [['g1', 3, 'o', 1, 'm'], ['g2', 4, 'r', 0, 'n'], ['g3', 2, 'o', 0, 'h']]);
  const r = computeGapChange(latest, prior, [latest, prior]);
  assert.deepEqual(r.newlyPromoted.ids, ['g1']);
  assert.equal(r.resolvedSincePrior.count, 1);          // g2 u -> r
  assert.deepEqual(r.recurring.ids.sort(), ['g1']);     // actionable (open/promoted) in BOTH; g3 was 'candidate' in prior
  assert.deepEqual(r.criticalProcessGaps.ids.sort(), ['g1', 'g3']); // latest c in {m,h} and actionable
});

test('gap_truncated either side -> whole gap block unknown', () => {
  const r = computeGapChange(
    gRow('2026-10', [['g1', 9, 'o', 1, 'h']], { gap_truncated: true }),
    gRow('2026-09', [['g1', 2, 'o', 0, 'h']]),
    [],
  );
  assert.equal(r.comparable, false);
  assert.equal(r.reason, 'truncated');
  assert.equal(r.recurring.count, null);
  assert.equal(r.longUnresolved.state, 'unknown');
});

test('long-unresolved: 3 TRULY CONSECUTIVE calendar months, run ending at latest', () => {
  const g = (pk) => gRow(pk, [['g1', 1, 'o', 0, 'h']]);
  // consecutive Aug, Sep, Oct -> qualifies, since = 2026-08
  const ok = computeGapChange(g('2026-10'), g('2026-09'), [g('2026-10'), g('2026-09'), g('2026-08')]);
  assert.equal(ok.longUnresolved.state, 'known');
  assert.deepEqual(ok.longUnresolved.items, [{ id: 'g1', since: '2026-08' }]);
});

test('long-unresolved: 2026-10, 2026-09, 2026-07 (August missing) does NOT qualify', () => {
  const g = (pk) => gRow(pk, [['g1', 1, 'o', 0, 'h']]);
  const r = computeGapChange(g('2026-10'), g('2026-09'), [g('2026-10'), g('2026-09'), g('2026-07')]);
  assert.equal(r.longUnresolved.state, 'unknown');
  assert.equal(r.longUnresolved.reason, 'insufficient_consecutive_history');
  assert.deepEqual(r.longUnresolved.items, []);
});

test('long-unresolved: fewer than 3 fingerprint rows -> unknown', () => {
  const g = (pk) => gRow(pk, [['g1', 1, 'o', 0, 'h']]);
  const r = computeGapChange(g('2026-10'), g('2026-09'), [g('2026-10'), g('2026-09')]);
  assert.equal(r.longUnresolved.state, 'unknown');
});

test('long-unresolved: a gap NOT open in every row of the run is excluded', () => {
  const open = [['g1', 1, 'o', 0, 'h']];
  const closed = [['g1', 1, 'r', 0, 'h']];
  const r = computeGapChange(
    gRow('2026-10', open), gRow('2026-09', open),
    [gRow('2026-10', open), gRow('2026-09', open), gRow('2026-08', closed)],
  );
  assert.equal(r.longUnresolved.state, 'known');
  assert.deepEqual(r.longUnresolved.items, []); // g1 was 'r' in August
});

test('gap version mismatch / missing prior -> unknown block, prior reported', () => {
  const bad = computeGapChange(gRow('2026-10', [], { fingerprint_version: 99 }), gRow('2026-09', []), []);
  assert.equal(bad.comparable, false);
  assert.equal(bad.reason, 'version_changed');
  assert.equal(bad.previous_period_key, '2026-09');
  const none = computeGapChange(gRow('2026-10', []), null, []);
  assert.equal(none.reason, 'insufficient_history');
});

// ==================================================================
// isFingerprintBearing + purity
// ==================================================================

test('isFingerprintBearing: true only when fingerprint_version is set (pre-P9-3 rows excluded)', () => {
  assert.equal(isFingerprintBearing({ fingerprint_version: 1, exposure_fingerprint: '[]' }), true);
  assert.equal(isFingerprintBearing({ period_key: '2026-05' }), false);        // pre-P9-3
  assert.equal(isFingerprintBearing(null), false);
});

test('continuityChange.ts is pure — only a type/monthsBetween import; no SDK / Deno / LLM / embeddings / randomness', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/continuityChange.ts', HERE), 'utf8'));
  assert.equal(/@base44\/sdk|createClientFromRequest|asServiceRole|entities\.|InvokeLLM|\.embed\s*\(|Math\.random|Deno\./.test(src), false);
  assert.equal(/"score"|health_score|overallScore|percent/i.test(src), false);
  // imports only from ./trend.ts
  const imports = [...src.matchAll(/from ["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ['./trend.ts']);
});
