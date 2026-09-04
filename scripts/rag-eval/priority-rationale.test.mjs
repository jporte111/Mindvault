// Phase 9 P9-2 — pure tests for base44/shared/health/priorityRationale.ts.
// Deterministic, stable for the same input, derived ONLY from kind + criticality,
// no LLM / embeddings / randomness / employee-behavior inference.
//   node --test scripts/rag-eval/priority-rationale.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priorityRationale, criticalityPhrase } from '../../base44/shared/health/priorityRationale.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('criticalityPhrase maps the enum, falls back to Unclassified', () => {
  assert.equal(criticalityPhrase('mission_critical'), 'Mission-critical');
  assert.equal(criticalityPhrase('high'), 'High-criticality');
  assert.equal(criticalityPhrase('medium'), 'Medium-criticality');
  assert.equal(criticalityPhrase('low'), 'Low-criticality');
  assert.equal(criticalityPhrase(null), 'Unclassified');
  assert.equal(criticalityPhrase(undefined), 'Unclassified');
  assert.equal(criticalityPhrase('weird'), 'Unclassified');
});

test('expected phrasing for the major queue kinds', () => {
  assert.equal(priorityRationale({ kind: 'source_failure', criticality: 'mission_critical' }),
    'Mission-critical process — a published source failed to update and needs re-indexing');
  assert.equal(priorityRationale({ kind: 'not_documented', criticality: 'high' }),
    'High-criticality process with no documented procedure');
  assert.equal(priorityRationale({ kind: 'key_person_dependency', criticality: 'high' }),
    'High-criticality process depends on one expert with no backup');
  assert.equal(priorityRationale({ kind: 'missing_owner_sme', criticality: 'high' }),
    'High-criticality process has no owner or subject-matter expert assigned');
  assert.equal(priorityRationale({ kind: 'overdue_review', criticality: 'mission_critical' }),
    'Mission-critical process is overdue for a documentation review');
  assert.equal(priorityRationale({ kind: 'active_not_verified', criticality: 'medium' }),
    'Medium-criticality process is answering from knowledge that is not yet verified');
  assert.equal(priorityRationale({ kind: 'legacy_coverage_unresolved', criticality: 'low' }),
    'Low-criticality process — legacy knowledge needs re-indexing to confirm its documentation status');
});

test('every declared queue kind has a distinct, non-empty rationale', () => {
  const kinds = ['source_failure', 'not_documented', 'key_person_dependency', 'active_not_verified',
    'promoted_gap', 'legacy_coverage_unresolved', 'overdue_review', 'missing_owner_sme',
    'no_review_cadence', 'changes_requested', 'draft_stuck', 'awaiting_employee', 'expired_active',
    'open_gap', 'other_setup'];
  const seen = new Set();
  for (const k of kinds) {
    const s = priorityRationale({ kind: k, criticality: 'high' });
    assert.ok(typeof s === 'string' && s.length > 0, `${k} produced no rationale`);
    assert.equal(seen.has(s), false, `${k} rationale collides with another kind`);
    seen.add(s);
  }
});

test('unknown kind -> safe generic rationale, still deterministic', () => {
  assert.equal(priorityRationale({ kind: 'totally_new_kind', criticality: 'low' }), 'Low-criticality process needs attention');
  assert.equal(priorityRationale({ kind: undefined, criticality: null }), 'Unclassified process needs attention');
});

test('deterministic: same input -> identical string across many calls', () => {
  const inputs = [
    { kind: 'source_failure', criticality: 'mission_critical' },
    { kind: 'open_gap', criticality: null },
    { kind: 'draft_stuck', criticality: 'medium' },
  ];
  for (const i of inputs) {
    const first = priorityRationale(i);
    for (let n = 0; n < 50; n++) assert.equal(priorityRationale(i), first);
  }
});

test('priorityRationale.ts is pure — no import, no LLM / embeddings / randomness / Base44', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/priorityRationale.ts', HERE), 'utf8'));
  assert.equal(/^\s*import\s/m.test(src), false, 'must not import anything');
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|@base44\/sdk|asServiceRole|entities\.|Deno\./.test(src), false);
});
