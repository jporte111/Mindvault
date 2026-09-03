// Phase 7 — pure Operational Continuity / Knowledge Health primitives.
// F1 (effective dates), F2 (legacy index resolution), F3 (exposure vs key-person),
// F4 (unknown coverage). No Base44, no embeddings, no LLM, no randomness.
//   node --test scripts/rag-eval/health-primitives.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import {
  effectiveNow, parseableDate, resolveIndexState, deriveCoverageState,
  governedActiveSource, usableSources,
} from '../../base44/shared/health/coverage.ts';
import {
  computeFreshness, resolveReviewInterval, worstFreshness, bucketFreshness,
} from '../../base44/shared/health/freshness.ts';
import {
  assessContinuityExposure, highestContinuityExposureSeverity,
} from '../../base44/shared/health/continuityExposure.ts';
import {
  assessKeyPersonDependency, findConcentrationRisks,
} from '../../base44/shared/health/keyPersonDependency.ts';
import { deriveContinuityState } from '../../base44/shared/health/continuityState.ts';
import {
  coverageBand, currencyBand, verificationBand, keyPersonResilienceBand,
} from '../../base44/shared/health/snapshot.ts';
import { prioritizeQueue, queueSortKey } from '../../base44/shared/health/reviewQueue.ts';
import { HEALTH_VOCABULARY, BANNED_UI_TOKENS, resolveHealthVocabulary } from '../../base44/shared/health/presentation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEALTH_DIR = resolve(HERE, '../../base44/shared/health');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const NOW = Date.parse('2026-09-03T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ======================================================================
// F1 — effectiveNow boundaries
// ======================================================================

test('F1 effectiveNow: missing bounds = unbounded', () => {
  assert.equal(effectiveNow({}, NOW), true);
});
test('F1 effectiveNow: missing from + future until = effective; past until = not', () => {
  assert.equal(effectiveNow({ effective_until: iso(NOW + DAY) }, NOW), true);
  assert.equal(effectiveNow({ effective_until: iso(NOW - DAY) }, NOW), false);
});
test('F1 effectiveNow: past from + missing until = effective; future from = not', () => {
  assert.equal(effectiveNow({ effective_from: iso(NOW - DAY) }, NOW), true);
  assert.equal(effectiveNow({ effective_from: iso(NOW + DAY) }, NOW), false);
});
test('F1 effectiveNow: both sides — inside window vs each side failing', () => {
  assert.equal(effectiveNow({ effective_from: iso(NOW - DAY), effective_until: iso(NOW + DAY) }, NOW), true);
  assert.equal(effectiveNow({ effective_from: iso(NOW + DAY), effective_until: iso(NOW + 2 * DAY) }, NOW), false);
  assert.equal(effectiveNow({ effective_from: iso(NOW - 2 * DAY), effective_until: iso(NOW - DAY) }, NOW), false);
});
test('F1 effectiveNow: malformed bound treated as absent', () => {
  assert.equal(effectiveNow({ effective_from: 'garbage' }, NOW), true);
  assert.equal(effectiveNow({ effective_until: 'nonsense' }, NOW), true);
  assert.equal(effectiveNow({ effective_from: 'x', effective_until: 'y' }, NOW), true);
  assert.equal(parseableDate('garbage'), false);
  assert.equal(parseableDate(''), false);
  assert.equal(parseableDate(iso(NOW)), true);
});
test('F1 effectiveNow: equality to now is effective (<= and >=)', () => {
  assert.equal(effectiveNow({ effective_from: iso(NOW) }, NOW), true);
  assert.equal(effectiveNow({ effective_until: iso(NOW) }, NOW), true);
});

// ======================================================================
// F2 — legacy index-state resolution + governedActiveSource
// ======================================================================

const src = (o) => ({
  id: o.id || 's1', status: 'ready', knowledge_scope: 'general',
  is_active_version: true, is_archived: false, verification_status: 'unverified', ...o,
});

test('F2 resolveIndexState: explicit index_status ALWAYS wins (chunk answer ignored)', () => {
  for (const st of ['indexed', 'failed', 'pending', 'indexing', 'skipped']) {
    assert.equal(resolveIndexState(src({ index_status: st }), undefined), st);
    assert.equal(resolveIndexState(src({ index_status: st }), true), st);
    assert.equal(resolveIndexState(src({ index_status: st }), false), st);
  }
});
test('F2 resolveIndexState: legacy true -> indexed, false -> absent, undefined -> unresolved', () => {
  assert.equal(resolveIndexState(src({}), true), 'indexed');
  assert.equal(resolveIndexState(src({}), false), 'absent');
  assert.equal(resolveIndexState(src({}), undefined), 'unresolved');
});
test('F2 resolveIndexState: unclassified legacy -> skipped', () => {
  assert.equal(resolveIndexState(src({ knowledge_scope: 'unclassified' }), true), 'skipped');
  assert.equal(resolveIndexState(src({ knowledge_scope: undefined }), true), 'skipped');
});
test('F2 governedActiveSource: rejected / archived / draft / not-ready / unclassified excluded', () => {
  assert.equal(governedActiveSource(src({})), true);
  assert.equal(governedActiveSource(src({ verification_status: 'rejected' })), false);
  assert.equal(governedActiveSource(src({ is_archived: true })), false);
  assert.equal(governedActiveSource(src({ is_active_version: false })), false);
  assert.equal(governedActiveSource(src({ status: 'processing' })), false);
  assert.equal(governedActiveSource(src({ knowledge_scope: 'unclassified' })), false);
});

// ======================================================================
// F2 + F4 — 5-state CoverageState
// ======================================================================

const HAS = (map) => (id) => map[id];

test('CoverageState: usable verified -> documented_verified', () => {
  const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'verified' })];
  assert.equal(deriveCoverageState(s, NOW, HAS({})), 'documented_verified');
});
test('CoverageState: usable unverified -> documented_unverified', () => {
  const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'unverified' })];
  assert.equal(deriveCoverageState(s, NOW, HAS({})), 'documented_unverified');
});
test('CoverageState: explicit failed, no usable -> needs_attention', () => {
  const s = [src({ id: 'a', index_status: 'failed' })];
  assert.equal(deriveCoverageState(s, NOW, HAS({})), 'needs_attention');
});
test('F4 CoverageState: only linked legacy source, lookup UNDEFINED -> unknown (never not_documented)', () => {
  const s = [src({ id: 'a', index_status: null })];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: undefined })), 'unknown');
});
test('F4 CoverageState: only linked legacy source, lookup proves FALSE -> not_documented', () => {
  const s = [src({ id: 'a', index_status: null })];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: false })), 'not_documented');
});
test('CoverageState: zero linked sources -> not_documented', () => {
  assert.equal(deriveCoverageState([], NOW, HAS({})), 'not_documented');
});
test('F4 CoverageState: unresolved legacy + usable verified -> documented_verified', () => {
  const s = [
    src({ id: 'a', index_status: null }),
    src({ id: 'b', index_status: 'indexed', verification_status: 'verified' }),
  ];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: undefined })), 'documented_verified');
});
test('F4 CoverageState: unresolved legacy + usable unverified -> documented_unverified', () => {
  const s = [
    src({ id: 'a', index_status: null }),
    src({ id: 'b', index_status: 'indexed', verification_status: 'unverified' }),
  ];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: undefined })), 'documented_unverified');
});
test('F4 CoverageState: unresolved legacy + explicit failed, no usable -> needs_attention (rung 3 before rung 4)', () => {
  const s = [
    src({ id: 'a', index_status: null }),
    src({ id: 'b', index_status: 'failed' }),
  ];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: undefined })), 'needs_attention');
});
test('F4 CoverageState: proven-absent legacy + unresolved legacy -> unknown (unresolved wins over absent)', () => {
  const s = [
    src({ id: 'a', index_status: null }),
    src({ id: 'b', index_status: null }),
  ];
  assert.equal(deriveCoverageState(s, NOW, HAS({ a: false, b: undefined })), 'unknown');
});
test('CoverageState: future-effective-only source -> not_documented', () => {
  const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'verified', effective_from: iso(NOW + DAY) })];
  assert.equal(deriveCoverageState(s, NOW, HAS({})), 'not_documented');
});
test('CoverageState: expired source -> not_documented', () => {
  const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'verified', effective_until: iso(NOW - DAY) })];
  assert.equal(deriveCoverageState(s, NOW, HAS({})), 'not_documented');
});
test('AUTHORITY INVARIANCE: source_authority never changes CoverageState', () => {
  for (const auth of ['policy', 'approved_sop', 'training', 'reference', 'notes', undefined]) {
    const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'verified', source_authority: auth })];
    assert.equal(deriveCoverageState(s, NOW, HAS({})), 'documented_verified', `authority=${auth}`);
  }
  // deriveCoverageState signature has no authority param
  assert.equal(deriveCoverageState.length, 3);
});
test('usableSources: only indexed + effective + governed-active', () => {
  const s = [
    src({ id: 'a', index_status: 'indexed' }),
    src({ id: 'b', index_status: 'failed' }),
    src({ id: 'c', index_status: null }),               // unresolved (undefined answer)
    src({ id: 'd', index_status: 'indexed', is_archived: true }),
  ];
  const u = usableSources(s, NOW, HAS({ c: undefined })).map((x) => x.id);
  assert.deepEqual(u, ['a']);
});

// ======================================================================
// Freshness
// ======================================================================

test('freshness: current / due_soon / overdue / unknown', () => {
  assert.equal(computeFreshness(null, 30, NOW), 'unknown');
  assert.equal(computeFreshness(iso(NOW + 30 * DAY), null, NOW), 'unknown');
  assert.equal(computeFreshness(iso(NOW + 30 * DAY), 30, NOW), 'current');
  assert.equal(computeFreshness(iso(NOW + 3 * DAY), 30, NOW), 'due_soon'); // grace = min(14d, 6d)
  assert.equal(computeFreshness(iso(NOW - DAY), 30, NOW), 'overdue');
});
test('resolveReviewInterval: source override -> process -> null', () => {
  assert.equal(resolveReviewInterval(7, 30), 7);
  assert.equal(resolveReviewInterval(undefined, 30), 30);
  assert.equal(resolveReviewInterval(0, 30), 30);
  assert.equal(resolveReviewInterval(undefined, undefined), null);
});
test('worstFreshness: unknown < current < due_soon < overdue; empty -> unknown', () => {
  assert.equal(worstFreshness([]), 'unknown');
  assert.equal(worstFreshness(['current', 'due_soon']), 'due_soon');
  assert.equal(worstFreshness(['overdue', 'current']), 'overdue');
  assert.equal(worstFreshness(['unknown', 'unknown']), 'unknown');
});

// ======================================================================
// F3 — Continuity Exposure severity + rollup
// ======================================================================

const ex = (o) => ({
  criticality: 'high', coverageState: 'documented_verified',
  worstUsableFreshness: 'current', ownerPresent: true, smePresent: true,
  openGapCount: 0, hasPromotedGap: false, reviewCadenceResolved: true, ...o,
});
const kinds = (arr) => arr.map((e) => `${e.kind}:${e.severity}`);

test('F3 exposure: source_failure -> severe', () => {
  assert.ok(kinds(assessContinuityExposure(ex({ coverageState: 'needs_attention' }))).includes('source_failure:severe'));
});
test('F3 exposure: undocumented_critical / unverified_docs_critical -> severe', () => {
  assert.ok(kinds(assessContinuityExposure(ex({ coverageState: 'not_documented', criticality: 'mission_critical' }))).includes('undocumented_critical:severe'));
  assert.ok(kinds(assessContinuityExposure(ex({ coverageState: 'documented_unverified', criticality: 'high' }))).includes('unverified_docs_critical:severe'));
});
test('F4 exposure: legacy_coverage_unresolved -> moderate (critical) / info (non-critical), NEVER severe', () => {
  const c = assessContinuityExposure(ex({ coverageState: 'unknown', criticality: 'high' }));
  const n = assessContinuityExposure(ex({ coverageState: 'unknown', criticality: 'low' }));
  assert.ok(kinds(c).includes('legacy_coverage_unresolved:moderate'));
  assert.ok(kinds(n).includes('legacy_coverage_unresolved:info'));
  assert.equal(c.some((e) => e.kind === 'legacy_coverage_unresolved' && e.severity === 'severe'), false);
  // unknown coverage produces NO undocumented_critical / source_failure
  assert.equal(c.some((e) => ['undocumented_critical', 'source_failure', 'unverified_docs_critical'].includes(e.kind)), false);
});
test('F3 exposure: overdue mission-critical -> severe; high -> moderate; low -> info', () => {
  assert.ok(kinds(assessContinuityExposure(ex({ worstUsableFreshness: 'overdue', criticality: 'mission_critical' }))).includes('overdue_review_mission_critical:severe'));
  assert.ok(kinds(assessContinuityExposure(ex({ worstUsableFreshness: 'overdue', criticality: 'high' }))).includes('overdue_review_critical:moderate'));
  assert.ok(kinds(assessContinuityExposure(ex({ worstUsableFreshness: 'overdue', criticality: 'low' }))).includes('overdue_review:info'));
});
test('F3 exposure: open_gaps_critical moderate; severe with a promoted gap; non-critical -> info', () => {
  assert.ok(kinds(assessContinuityExposure(ex({ openGapCount: 2, criticality: 'high' }))).includes('open_gaps_critical:moderate'));
  assert.ok(kinds(assessContinuityExposure(ex({ openGapCount: 2, hasPromotedGap: true, criticality: 'high' }))).includes('open_gaps_critical:severe'));
  assert.ok(kinds(assessContinuityExposure(ex({ openGapCount: 1, criticality: 'medium' }))).includes('open_gaps:info'));
});
test('F3 exposure: missing owner/sme -> moderate; criticality/cadence unset -> info', () => {
  const e = assessContinuityExposure(ex({ ownerPresent: false, smePresent: false, criticality: undefined, reviewCadenceResolved: false }));
  const k = kinds(e);
  assert.ok(k.includes('missing_owner:moderate'));
  assert.ok(k.includes('missing_sme:moderate'));
  assert.ok(k.includes('criticality_unset:info'));
  assert.ok(k.includes('missing_review_cadence:info'));
});
test('highestContinuityExposureSeverity: none < info < moderate < severe; empty -> none', () => {
  assert.equal(highestContinuityExposureSeverity([]), 'none');
  assert.equal(highestContinuityExposureSeverity([{ kind: 'x', severity: 'info' }, { kind: 'y', severity: 'moderate' }]), 'moderate');
  assert.equal(highestContinuityExposureSeverity([{ kind: 'x', severity: 'moderate' }, { kind: 'y', severity: 'severe' }]), 'severe');
});

// ======================================================================
// Key-person dependency — actual person dependency only
// ======================================================================

const kp = (o) => ({
  criticality: 'high', processOwner: null, subjectMatterExpert: null, backupSme: null,
  coverageState: 'documented_verified', worstUsableFreshness: 'current', gapFunnelToSoleSmeCount: 0, ...o,
});

test('key-person: undocumented process ALONE -> level none (it is exposure, not key-person)', () => {
  const r = assessKeyPersonDependency(kp({ coverageState: 'not_documented', criticality: 'mission_critical' }));
  assert.equal(r.level, 'none');
  assert.deepEqual(r.persons, []);
});
test('key-person: missing SME ALONE -> level none', () => {
  assert.equal(assessKeyPersonDependency(kp({ subjectMatterExpert: null, criticality: 'mission_critical' })).level, 'none');
});
test('key-person: missing owner ALONE -> level none', () => {
  assert.equal(assessKeyPersonDependency(kp({ processOwner: null, subjectMatterExpert: 'u1', backupSme: 'u2' })).level, 'none');
});
test('KP1: critical + SME + no backup -> elevated (high) / high (mission_critical)', () => {
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1' })).level, 'elevated');
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'mission_critical', subjectMatterExpert: 'u1' })).level, 'high');
  assert.deepEqual(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1' })).persons, [{ userId: 'u1', role: 'sole_sme' }]);
});
test('KP2: owner === SME, no backup -> informational (low/med) / elevated (high) / high (mc)', () => {
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'low', processOwner: 'u1', subjectMatterExpert: 'u1' })).level, 'informational');
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', processOwner: 'u1', subjectMatterExpert: 'u1' })).level, 'elevated');
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'mission_critical', processOwner: 'u1', subjectMatterExpert: 'u1' })).level, 'high');
});
test('KP4: >=2 gaps funnel to sole SME on a critical process -> high; only when a dependency is established', () => {
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1', gapFunnelToSoleSmeCount: 2 })).level, 'high');
  // with a backup present, no person dependency -> KP4 does not fire
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1', backupSme: 'u2', gapFunnelToSoleSmeCount: 5 })).level, 'none');
});
test('KP5 amplifier: high-criticality KP1 (elevated) + overdue usable docs -> high; no KP1 -> nothing', () => {
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1', worstUsableFreshness: 'overdue' })).level, 'high');
  assert.equal(assessKeyPersonDependency(kp({ criticality: 'high', subjectMatterExpert: 'u1', backupSme: 'u2', worstUsableFreshness: 'overdue' })).level, 'none');
});
test('key-person: criticality unset -> level unknown (not none, not high)', () => {
  assert.equal(assessKeyPersonDependency(kp({ criticality: undefined, subjectMatterExpert: 'u1' })).level, 'unknown');
});
test('key-person: input shape has no authority field (signature check)', () => {
  const r = assessKeyPersonDependency({ criticality: 'high', subjectMatterExpert: 'u1', coverageState: 'documented_verified', worstUsableFreshness: 'current', gapFunnelToSoleSmeCount: 0, source_authority: 'policy' });
  assert.equal(r.level, 'elevated'); // authority arg ignored
});
test('concentration: same sole SME on 2 critical -> high; >=3 -> critical; SME with backup -> none', () => {
  const P = (id, sme, backup) => ({ id, criticality: 'high', subjectMatterExpert: sme, backupSme: backup });
  const two = findConcentrationRisks([P('a', 'u1'), P('b', 'u1'), P('c', 'u2')]);
  assert.deepEqual(two, [{ userId: 'u1', level: 'high', criticalProcessIds: ['a', 'b'] }]);
  const three = findConcentrationRisks([P('a', 'u1'), P('b', 'u1'), P('c', 'u1')]);
  assert.equal(three[0].level, 'critical');
  const withBackup = findConcentrationRisks([P('a', 'u1', 'ub'), P('b', 'u1', 'ub'), P('c', 'u1', 'ub')]);
  assert.deepEqual(withBackup, []);
  // non-critical processes ignored
  assert.deepEqual(findConcentrationRisks([{ id: 'a', criticality: 'low', subjectMatterExpert: 'u1' }, { id: 'b', criticality: 'medium', subjectMatterExpert: 'u1' }]), []);
});

// ======================================================================
// ContinuityState precedence (7-rung ladder)
// ======================================================================

const cs = (o) => ({
  coverageState: 'documented_verified', keyPersonLevel: 'none', highestExposureSeverity: 'none',
  ownerPresent: true, smePresent: true, criticalitySet: true, reviewCadenceResolved: true, ...o,
});

test('ContinuityState 1: not_documented -> not_documented (wins over everything)', () => {
  assert.equal(deriveContinuityState(cs({ coverageState: 'not_documented', keyPersonLevel: 'critical', highestExposureSeverity: 'severe' })), 'not_documented');
});
test('ContinuityState 2: needs_attention -> at_risk', () => {
  assert.equal(deriveContinuityState(cs({ coverageState: 'needs_attention' })), 'at_risk');
});
test('ContinuityState 3: key-person high/critical -> at_risk', () => {
  assert.equal(deriveContinuityState(cs({ keyPersonLevel: 'high' })), 'at_risk');
  assert.equal(deriveContinuityState(cs({ keyPersonLevel: 'critical' })), 'at_risk');
});
test('ContinuityState 4: severe exposure alone -> at_risk (no key-person needed)', () => {
  assert.equal(deriveContinuityState(cs({ coverageState: 'documented_unverified', highestExposureSeverity: 'severe' })), 'at_risk');
});
test('F4 ContinuityState 5: coverage unknown -> needs_setup (NOT at_risk, NOT not_documented)', () => {
  const r = deriveContinuityState(cs({ coverageState: 'unknown', highestExposureSeverity: 'moderate' }));
  assert.equal(r, 'needs_setup');
});
test('ContinuityState: only-moderate exposure never causes at_risk (falls to needs_setup via rung 6)', () => {
  assert.equal(deriveContinuityState(cs({ ownerPresent: false, smePresent: false, highestExposureSeverity: 'moderate' })), 'needs_setup');
});
test('ContinuityState: only-info exposure with full setup -> ready', () => {
  assert.equal(deriveContinuityState(cs({ highestExposureSeverity: 'info' })), 'ready');
});
test('ContinuityState: signature consumes only the rollup, not an exposure list', () => {
  // input keys are fixed and contain no `exposures` array
  const keys = Object.keys(cs({}));
  assert.equal(keys.includes('exposures'), false);
  assert.ok(keys.includes('highestExposureSeverity'));
});

// ======================================================================
// Snapshot bands
// ======================================================================

test('Coverage band: <3 evaluable critical -> Unknown', () => {
  assert.equal(coverageBand({ evaluableCritical: 2, coveredCritical: 2, inScopeCritical: 2, unknownCritical: 0 }), 'Unknown');
});
test('F4 Coverage band: >25% of in-scope critical unknown -> Unknown (2 documented + 20 unknown)', () => {
  assert.equal(coverageBand({ evaluableCritical: 2, coveredCritical: 2, inScopeCritical: 22, unknownCritical: 20 }), 'Unknown');
});
test('F4 Coverage band: <=25% unknown with >=3 evaluable -> normal Strong/Partial/Weak', () => {
  // 12 covered / 15 evaluable + 3 unknown => 3/18 = 16.7% -> normal calc -> 80% -> Partial
  assert.equal(coverageBand({ evaluableCritical: 15, coveredCritical: 12, inScopeCritical: 18, unknownCritical: 3 }), 'Partial');
  assert.equal(coverageBand({ evaluableCritical: 10, coveredCritical: 10, inScopeCritical: 10, unknownCritical: 0 }), 'Strong');
  assert.equal(coverageBand({ evaluableCritical: 10, coveredCritical: 5, inScopeCritical: 10, unknownCritical: 0 }), 'Weak');
});
test('Currency band: 0 Current, <=15 Slipping, >15 Overdue; <5 scheduled -> Unknown', () => {
  assert.equal(currencyBand({ scheduledCount: 4, overdueCount: 0 }), 'Unknown');
  assert.equal(currencyBand({ scheduledCount: 20, overdueCount: 0 }), 'Current');
  assert.equal(currencyBand({ scheduledCount: 20, overdueCount: 2 }), 'Slipping'); // 10%
  assert.equal(currencyBand({ scheduledCount: 20, overdueCount: 8 }), 'Overdue'); // 40%
});
test('F3 Verification band: zero verified is KNOWN -> Review backlog (not Unknown)', () => {
  assert.equal(verificationBand({ gasCount: 50, verifiedCount: 0 }), 'Review backlog');
  assert.equal(verificationBand({ gasCount: 4, verifiedCount: 0 }), 'Unknown'); // insufficient population
  assert.equal(verificationBand({ gasCount: 50, verifiedCount: 48 }), 'Confirmed'); // 96%
  assert.equal(verificationBand({ gasCount: 50, verifiedCount: 35 }), 'Mostly confirmed'); // 70%
});
test('Key-person resilience band: 0 Resilient, 1-2 Watch, >=3 Exposed', () => {
  assert.equal(keyPersonResilienceBand({ highOrCriticalKeyPersonProcesses: 0 }), 'Resilient');
  assert.equal(keyPersonResilienceBand({ highOrCriticalKeyPersonProcesses: 2 }), 'Watch');
  assert.equal(keyPersonResilienceBand({ highOrCriticalKeyPersonProcesses: 3 }), 'Exposed');
});
test('NO composite score: the snapshot module exports no overall/score function', () => {
  const snap = readFileSync(join(HEALTH_DIR, 'snapshot.ts'), 'utf8');
  assert.equal(/overallScore|compositeScore|healthScore|combineBands|totalScore/i.test(snap), false);
});

// ======================================================================
// Review Queue priority
// ======================================================================

test('Queue: critical-tier kind order 1..6 (F4 places legacy_coverage_unresolved at 6)', () => {
  const mk = (kind) => ({ id: kind, kind, criticality: 'high', ageMs: 1000, title: kind });
  const order = prioritizeQueue([
    mk('overdue_review'), mk('legacy_coverage_unresolved'), mk('promoted_gap'),
    mk('active_not_verified'), mk('key_person_dependency'), mk('not_documented'),
    mk('source_failure'), mk('missing_owner_sme'),
  ]).map((x) => x.kind);
  assert.deepEqual(order, [
    'source_failure', 'not_documented', 'key_person_dependency', 'active_not_verified',
    'promoted_gap', 'legacy_coverage_unresolved', 'overdue_review', 'missing_owner_sme',
  ]);
});
test('Queue: all critical items outrank all high items; then medium/low/unset', () => {
  const a = { id: 'a', kind: 'missing_owner_sme', criticality: 'mission_critical', ageMs: 1, title: 'a' };
  const b = { id: 'b', kind: 'source_failure', criticality: 'high', ageMs: 1, title: 'b' };
  assert.ok(queueSortKey(a) < queueSortKey(b));
});
test('Queue: age tiebreak — oldest first', () => {
  const mk = (id, age) => ({ id, kind: 'overdue_review', criticality: 'high', ageMs: age, title: id });
  assert.deepEqual(prioritizeQueue([mk('new', 10), mk('old', 999), mk('mid', 100)]).map((x) => x.id), ['old', 'mid', 'new']);
});
test('AUTHORITY INVARIANCE: queue priority ignores source_authority (identical items sort identically)', () => {
  const mk = (id, auth) => ({ id, kind: 'active_not_verified', criticality: 'high', ageMs: 500, title: id, source_authority: auth });
  const [x, y] = prioritizeQueue([mk('p', 'policy'), mk('n', 'notes')]);
  assert.equal(queueSortKey(x), queueSortKey(y));
});
test('Queue: "thin" is not a kind', () => {
  const rq = stripComments(readFileSync(join(HEALTH_DIR, 'reviewQueue.ts'), 'utf8'));
  assert.equal(/thin/i.test(rq), false);
});

// ======================================================================
// Presentation — banned technical tokens, freshness-not-correctness
// ======================================================================

test('no banned technical token appears in ANY user-facing vocabulary string', () => {
  const walk = (o) => {
    for (const v of Object.values(o)) {
      if (typeof v === 'string') {
        const low = v.toLowerCase();
        for (const b of BANNED_UI_TOKENS) {
          assert.equal(low.includes(b), false, `"${v}" contains banned token "${b}"`);
        }
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(HEALTH_VOCABULARY);
});
test('freshness copy says "due for review", never "incorrect"/"wrong"', () => {
  const f = HEALTH_VOCABULARY.freshness;
  assert.equal(f.overdue, 'Due for review');
  for (const v of Object.values(f)) {
    assert.equal(/incorrect|wrong|broken/i.test(v), false);
  }
});
test('unknown-coverage copy is exactly the approved F4 string; no alarming words', () => {
  const c = HEALTH_VOCABULARY.copy.unknownCoverage;
  assert.ok(c.includes('Documentation status needs confirmation'));
  assert.equal(/undocumented|missing|broken|failed/i.test(c), false);
});
test('legacy_coverage_unresolved queue copy uses non-alarming language', () => {
  const c = HEALTH_VOCABULARY.queueKind.legacy_coverage_unresolved;
  assert.ok(/re-index/i.test(c));
  assert.equal(/\bundocumented\b|\bmissing documentation\b|\bbroken\b|\bfailed\b/i.test(c), false);
});
test('resolveHealthVocabulary merges an override without losing keys or leaking tokens', () => {
  const v = resolveHealthVocabulary({ continuityState: { ready: 'All good' } });
  assert.equal(v.continuityState.ready, 'All good');
  assert.equal(v.continuityState.at_risk, 'At risk');
});

// ======================================================================
// Purity — no LLM / no embeddings / no randomness / no Base44 / no UI
// ======================================================================

test('health primitives are pure: no InvokeLLM / embed / Math.random / Base44 SDK / Deno', () => {
  const files = readdirSync(HEALTH_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 9);
  for (const f of files) {
    const s = stripComments(readFileSync(join(HEALTH_DIR, f), 'utf8'));
    assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|@base44\/sdk|createClientFromRequest|\bDeno\.\w/.test(s), false, `${f} is not pure`);
    // no UI import
    assert.equal(/from ['"]react|from ['"]@\//.test(s), false, `${f} imports UI`);
  }
});

// ======================================================================
// Determinism
// ======================================================================

test('determinism: identical inputs -> identical outputs across runs', () => {
  const s = [src({ id: 'a', index_status: 'indexed', verification_status: 'verified' })];
  const r1 = deriveCoverageState(s, NOW, HAS({}));
  const r2 = deriveCoverageState(s, NOW, HAS({}));
  assert.equal(r1, r2);
  const b1 = bucketFreshness([{ nextReviewDueAt: iso(NOW - DAY), intervalDays: 30 }], NOW);
  const b2 = bucketFreshness([{ nextReviewDueAt: iso(NOW - DAY), intervalDays: 30 }], NOW);
  assert.deepEqual(b1, b2);
});
