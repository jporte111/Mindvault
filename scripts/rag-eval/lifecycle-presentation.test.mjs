// Phase 6 — presentation layer: plain-language DisplayState / DisplayAction only,
// no backend identifier ever leaks into a normal-user-facing value or label.
//   node --test scripts/rag-eval/lifecycle-presentation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toDisplayState,
  availableActions,
  ADVANCED_ACTIONS,
  DEFAULT_VOCABULARY,
  resolveVocabulary,
} from '../../base44/shared/lifecycle/presentation.ts';

// Tokens that must NEVER appear in a DisplayState value, a DisplayAction value,
// or any default label a normal user sees.
const BANNED = [
  'lifecycle_seq', 'lifecycleSeq',
  'index_stale', 'indexStale',
  'operation_id', 'operationId',
  'payload_hash', 'payloadHash',
  'compensat', 'reconcil',
  'lifecycle_state', 'lifecycleState',
  'index_status', 'indexState',
  'cutover', 'stale_clear', 'failure_stage', 'failureStage',
  'KnowledgeChunk', 'KnowledgeLifecycleOperation', 'Training.',
];

const bannedHit = (s) => BANNED.find((b) => String(s).toLowerCase().includes(b.toLowerCase()));

const ALL_DISPLAY_STATES = [
  'draft', 'in_review', 'changes_requested', 'verified', 'published',
  'previous_version', 'outdated', 'indexing', 'needs_attention', 'archived', 'rejected',
];

test('no DisplayState value contains a backend identifier', () => {
  for (const s of ALL_DISPLAY_STATES) {
    assert.equal(bannedHit(s), undefined, `DisplayState "${s}" leaks a backend token`);
  }
});

test('no NORMAL DisplayAction value or label leaks a backend identifier (advanced actions exempt — diagnostics-only)', () => {
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.action)) {
    if (ADVANCED_ACTIONS.includes(k)) continue; // advanced diagnostics view only
    assert.equal(bannedHit(k), undefined, `action key "${k}" leaks`);
    assert.equal(bannedHit(v), undefined, `action label "${v}" leaks`);
  }
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.state)) {
    assert.equal(bannedHit(k), undefined, `state key "${k}" leaks`);
    assert.equal(bannedHit(v), undefined, `state label "${v}" leaks`);
  }
  for (const [k, v] of Object.entries(DEFAULT_VOCABULARY.freshness)) {
    assert.equal(bannedHit(k), undefined, `freshness key "${k}" leaks`);
    assert.equal(bannedHit(v), undefined, `freshness label "${v}" leaks`);
  }
});

test('toDisplayState priority ladder: fail-safe states beat workflow states', () => {
  const base = {
    lifecycleState: 'active', isActiveVersion: true, hasNewerActiveVersion: false,
    indexState: 'indexed', anyOpenOperation: false, indexStaleOnActive: false,
    needsManualReconciliation: false, freshness: 'current',
  };
  assert.equal(toDisplayState(base), 'published');
  assert.equal(toDisplayState({ ...base, freshness: 'overdue' }), 'outdated');
  assert.equal(toDisplayState({ ...base, needsManualReconciliation: true }), 'needs_attention');
  assert.equal(toDisplayState({ ...base, indexState: 'failed' }), 'needs_attention');
  // published but chunks currently stale (failed/in-flight without an operation) => needs_attention
  assert.equal(toDisplayState({ ...base, indexStaleOnActive: true }), 'needs_attention');
  // an operation in flight => indexing (fail-closed, not published)
  assert.equal(toDisplayState({ ...base, anyOpenOperation: true }), 'indexing');
});

test('toDisplayState workflow states for inactive versions', () => {
  const draft = {
    lifecycleState: 'draft', isActiveVersion: false, hasNewerActiveVersion: false,
    indexState: 'pending', anyOpenOperation: false, indexStaleOnActive: false,
    needsManualReconciliation: false, freshness: 'unknown',
  };
  assert.equal(toDisplayState(draft), 'draft');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'in_review' }), 'in_review');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'changes_requested' }), 'changes_requested');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'verified' }), 'verified');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'verified', hasNewerActiveVersion: true }), 'previous_version');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'archived' }), 'archived');
  assert.equal(toDisplayState({ ...draft, lifecycleState: 'rejected' }), 'rejected');
});

test('availableActions: advanced actions ONLY appear when ctx.advanced', () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: true, canWrite: true, advanced: false };
  for (const s of ALL_DISPLAY_STATES) {
    const acts = availableActions(s, ctx);
    for (const adv of ADVANCED_ACTIONS) {
      assert.equal(acts.includes(adv), false, `advanced action "${adv}" leaked into normal actions for "${s}"`);
    }
  }
  const advActs = availableActions('needs_attention', { ...ctx, advanced: true });
  assert.ok(advActs.includes('view_diagnostics'));
  assert.ok(advActs.includes('force_reconcile'));
});

test('availableActions: no write actions offered when canWrite is false', () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: true, canWrite: false, advanced: false };
  for (const s of ALL_DISPLAY_STATES) {
    assert.deepEqual(availableActions(s, ctx), [], `"${s}" offered actions without write permission`);
  }
});

test('availableActions: publish only offered on verified when the draft is pre-indexed', () => {
  const ready = { hasOpenDraftInLineage: true, draftIndexReady: true, canWrite: true, advanced: false };
  const notReady = { ...ready, draftIndexReady: false };
  assert.ok(availableActions('verified', ready).includes('publish'));
  assert.equal(availableActions('verified', notReady).includes('publish'), false);
});

test('availableActions: no write actions while indexing', () => {
  const ctx = { hasOpenDraftInLineage: false, draftIndexReady: false, canWrite: true, advanced: false };
  assert.deepEqual(availableActions('indexing', ctx), []);
});

test('resolveVocabulary merges an override without losing keys or leaking tokens', () => {
  const v = resolveVocabulary({ state: { published: 'Live' } });
  assert.equal(v.state.published, 'Live');
  assert.equal(v.state.draft, 'Draft'); // untouched key preserved
  for (const label of Object.values(v.state)) assert.equal(bannedHit(label), undefined);
});
