// Phase 6 — reusable lifecycle engine: state machine, transition normalization,
// index-correctness checks, operation-machine helpers. Pure, no adapters.
//   node --test scripts/rag-eval/lifecycle-engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLifecycleState,
  legalTransitions,
  assertTransitionLegal,
  normalizeForTransition,
  newDraftFields,
  demoteFields,
  assertNoStaleState,
} from '../../base44/shared/lifecycle/stateMachine.ts';
import { DEFAULT_POLICY, computeFreshness } from '../../base44/shared/lifecycle/policy.ts';
import {
  isIndexNoOp,
  planReindex,
  assertResourceMatchesIndex,
} from '../../base44/shared/lifecycle/verification.ts';
import { compensationKind, isResumableStage } from '../../base44/shared/lifecycle/operationMachine.ts';

// ---------------------------------------------------------------------------
// deriveLifecycleState — ROW-LOCAL ONLY
// ---------------------------------------------------------------------------

test('deriveLifecycleState reads only this row\'s fields (no lineage input)', () => {
  // exhaustive over the five backing fields that matter
  const V = (o) => ({
    isArchived: false, verificationStatus: 'unverified', isActiveVersion: false,
    reviewOutcome: null, reviewRequestedAt: null, ...o,
  });
  assert.equal(deriveLifecycleState(V({})), 'draft');
  assert.equal(deriveLifecycleState(V({ reviewRequestedAt: 'x' })), 'in_review');
  assert.equal(deriveLifecycleState(V({ reviewOutcome: 'changes_requested' })), 'changes_requested');
  assert.equal(deriveLifecycleState(V({ verificationStatus: 'verified' })), 'verified');
  assert.equal(deriveLifecycleState(V({ verificationStatus: 'verified', reviewRequestedAt: 'x' })), 'verified');
  assert.equal(deriveLifecycleState(V({ isActiveVersion: true })), 'active');
  assert.equal(deriveLifecycleState(V({ isActiveVersion: true, reviewOutcome: 'changes_requested' })), 'active');
  assert.equal(deriveLifecycleState(V({ verificationStatus: 'rejected' })), 'rejected');
  assert.equal(deriveLifecycleState(V({ isArchived: true, isActiveVersion: true })), 'archived');
  // a verified inactive draft and a superseded former-active row BOTH derive 'verified'
  assert.equal(deriveLifecycleState(V({ verificationStatus: 'verified', isActiveVersion: false })), 'verified');
});

// ---------------------------------------------------------------------------
// transition graph — narrowing only
// ---------------------------------------------------------------------------

test('transition graph: legal / illegal', () => {
  assert.ok(assertTransitionLegal('draft', 'submit', DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal('in_review', 'verify', DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal('verified', 'activate', DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal('active', 'create_version', DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal('archived', 'restore', DEFAULT_POLICY).ok);
  assert.ok(assertTransitionLegal('rejected', 'un_reject', DEFAULT_POLICY).ok);
  assert.equal(assertTransitionLegal('draft', 'activate', DEFAULT_POLICY).ok, false);
  assert.equal(assertTransitionLegal('archived', 'verify', DEFAULT_POLICY).ok, false);
  assert.equal(assertTransitionLegal('active', 'activate', DEFAULT_POLICY).ok, false);
});

test('policy can NARROW the graph but not widen it', () => {
  const narrow = { ...DEFAULT_POLICY, disallowTransitions: ['restore'] };
  assert.equal(assertTransitionLegal('archived', 'restore', narrow).ok, false);
  assert.equal(legalTransitions('archived', narrow).includes('restore'), false);
  // there is no API to add a transition — the graph is a fixed table
  assert.equal(assertTransitionLegal('draft', 'activate', narrow).ok, false);
});

// ---------------------------------------------------------------------------
// [F3] transition field normalization — no stale backing field survives
// ---------------------------------------------------------------------------

// adversarial seed: every review field set to a value that could mislead
const adversarial = {
  isArchived: false, verificationStatus: 'unverified', isActiveVersion: false,
  reviewOutcome: 'changes_requested', reviewRequestedAt: '2020-01-01T00:00:00Z',
};
const apply = (v, patch) => ({ ...v, ...patch });
const ctx = { now: '2026-09-02T00:00:00Z', actorId: 'u1' };

test('submit from changes_requested -> in_review, changes_requested field cleared', () => {
  const after = apply(adversarial, normalizeForTransition('submit', ctx));
  assert.equal(deriveLifecycleState(after), 'in_review');
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState('changes_requested', after).ok);
});

test('verify from changes_requested -> verified, not stuck on changes_requested/in_review', () => {
  const after = apply(adversarial, normalizeForTransition('verify', ctx));
  assert.equal(deriveLifecycleState(after), 'verified');
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState('changes_requested', after).ok);
  assert.ok(assertNoStaleState('in_review', after).ok);
});

test('request_changes -> changes_requested', () => {
  const seed = { ...adversarial, reviewOutcome: null };
  const after = apply(seed, normalizeForTransition('request_changes', ctx));
  assert.equal(deriveLifecycleState(after), 'changes_requested');
  assert.ok(assertNoStaleState('in_review', after).ok);
});

test('un_reject establishes in_review explicitly (not stuck rejected/verified)', () => {
  const seed = { ...adversarial, verificationStatus: 'rejected' };
  const after = apply(seed, normalizeForTransition('un_reject', ctx));
  assert.equal(deriveLifecycleState(after), 'in_review');
  assert.equal(after.verificationStatus, 'unverified');
  assert.equal(after.reviewOutcome, null);
  assert.ok(assertNoStaleState('rejected', after).ok);
});

test('reject -> rejected, review fields cleared', () => {
  const after = apply(adversarial, normalizeForTransition('reject', ctx));
  assert.equal(deriveLifecycleState(after), 'rejected');
  assert.equal(after.reviewRequestedAt, null);
  assert.equal(after.reviewOutcome, null);
});

test('archive -> archived; restore -> verified when verified else draft, never changes_requested', () => {
  const arch = apply({ ...adversarial, verificationStatus: 'verified' }, normalizeForTransition('archive', ctx));
  assert.equal(deriveLifecycleState(arch), 'archived');
  const restored = apply(arch, normalizeForTransition('restore', ctx));
  assert.equal(deriveLifecycleState(restored), 'verified');
  assert.equal(restored.reviewOutcome, null);
  const restoredUnverified = apply(
    apply({ ...adversarial }, normalizeForTransition('archive', ctx)),
    normalizeForTransition('restore', ctx),
  );
  assert.equal(deriveLifecycleState(restoredUnverified), 'draft');
  assert.ok(assertNoStaleState('changes_requested', restoredUnverified).ok);
});

test('activate normalization -> active; demoteFields -> inactive', () => {
  const promoted = apply(
    { ...adversarial, verificationStatus: 'verified' },
    normalizeForTransition('activate', ctx),
  );
  assert.equal(deriveLifecycleState(promoted), 'active');
  const demoted = apply({ ...promoted }, demoteFields());
  assert.equal(demoted.isActiveVersion, false);
  assert.equal(deriveLifecycleState(demoted), 'verified'); // verification stamp retained
});

test('newDraftFields yields a clean draft regardless of the source row', () => {
  const d = { ...adversarial, verificationStatus: 'verified', isActiveVersion: true, ...newDraftFields('2026-09-02T00:00:00Z') };
  assert.equal(deriveLifecycleState(d), 'draft');
  assert.equal(d.verificationStatus, 'unverified');
  assert.equal(d.isActiveVersion, false);
  assert.equal(d.reviewOutcome, null);
  assert.equal(d.reviewRequestedAt, null);
  assert.equal(d.indexState, 'pending');
});

// ---------------------------------------------------------------------------
// [F2] index correctness — hash equality alone is never a no-op
// ---------------------------------------------------------------------------

test('isIndexNoOp requires ALL THREE: fingerprint match + complete set + clean projection', () => {
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: true, mismatches: [] }), true);
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: true, mismatches: [{ field: 'scopeKey' }] }), false);
  assert.equal(isIndexNoOp({ fingerprintMatches: true, unitSetComplete: false, mismatches: [] }), false);
  assert.equal(isIndexNoOp({ fingerprintMatches: false, unitSetComplete: true, mismatches: [] }), false);
});

test('planReindex: hash match + metadata drift -> restamp_repair (never no_op)', () => {
  assert.equal(planReindex({ fingerprintMatches: true, unitSetComplete: true, mismatches: [] }), 'no_op');
  assert.equal(
    planReindex({ fingerprintMatches: true, unitSetComplete: true, mismatches: [{ field: 'is_active_version' }] }),
    'restamp_repair',
  );
  assert.equal(planReindex({ fingerprintMatches: true, unitSetComplete: false, mismatches: [] }), 'full_rebuild');
  assert.equal(planReindex({ fingerprintMatches: false, unitSetComplete: true, mismatches: [] }), 'full_rebuild');
});

test('assertResourceMatchesIndex flags every drifted (unit,field)', () => {
  const expected = { scopeKey: 'general:', is_active_version: 'true', effective_from: '2026-01-01' };
  const units = [
    { unitId: 'a', projection: { scopeKey: 'general:', is_active_version: 'true', effective_from: '2026-01-01' } },
    { unitId: 'b', projection: { scopeKey: 'client:X', is_active_version: 'true', effective_from: '2025-06-01' } },
  ];
  const m = assertResourceMatchesIndex(expected, units);
  assert.deepEqual(m.map((x) => [x.unitId, x.field]).sort(), [['b', 'effective_from'], ['b', 'scopeKey']]);
});

// ---------------------------------------------------------------------------
// operation-machine helpers
// ---------------------------------------------------------------------------

test('compensationKind: half-applied cutover flip -> rollback_activation; index steps -> resume', () => {
  assert.equal(compensationKind('activate', 'cutover_flip'), 'rollback_activation');
  assert.equal(compensationKind('activate', 'cutover_restamp'), 'resume');
  assert.equal(compensationKind('activate', 'cutover_cleanup'), 'resume');
  assert.equal(compensationKind('activate', 'cutover_stale_clear'), 'resume');
  assert.equal(compensationKind('verify', 'apply'), 'resume');
  assert.equal(compensationKind('activate', 'compensate'), 'manual');
  assert.equal(isResumableStage('cutover_flip'), false);
  assert.equal(isResumableStage('cutover_restamp'), true);
});

// ---------------------------------------------------------------------------
// freshness — date math only, no answer-path signal
// ---------------------------------------------------------------------------

test('computeFreshness: current / due_soon / overdue / unknown', () => {
  const now = Date.parse('2026-09-02T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 86_400_000;
  assert.equal(computeFreshness(null, 30, now), 'unknown');
  assert.equal(computeFreshness(iso(now + 30 * DAY), null, now), 'unknown');
  assert.equal(computeFreshness(iso(now + 30 * DAY), 30, now), 'current');
  assert.equal(computeFreshness(iso(now + 3 * DAY), 30, now), 'due_soon'); // grace = min(14d, 6d) = 6d
  assert.equal(computeFreshness(iso(now - DAY), 30, now), 'overdue');
});
