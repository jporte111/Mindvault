// Phase 9 P9-2 — pure tests for base44/shared/health/governanceCompleteness.ts.
// Every cell is a plain-language restatement of a field the Phase 7
// computeKnowledgeHealth payload already computed. NO new health rule. Missing
// data -> missing / unknown / needs_attention per existing semantics.
//   node --test scripts/rag-eval/governance-completeness.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  governanceCompletenessRow,
  governanceCompleteness,
} from '../../base44/shared/health/governanceCompleteness.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// A Phase 7 processRow shape (only fields the helper reads).
const row = (over = {}) => ({
  id: 'p1', name: 'Monthly close', criticality: 'high',
  owner: { id: 'u1', name: 'Alice' },
  sme: { id: 'u2', name: 'Dana' },
  backup: null,
  coverageState: 'documented_verified', coverageLabel: 'Documented & verified',
  continuityState: 'ready', continuityLabel: 'Ready',
  keyPersonLevel: 'none', keyPersonLabel: 'No single-person dependency',
  freshness: 'current',
  detail: { linkedSources: [{ id: 's1', verification: 'Verified' }] },
  ...over,
});

test('owner / SME reflect the process fields; present when assigned, missing when null', () => {
  const g = governanceCompletenessRow(row());
  assert.deepEqual(g.owner, { status: 'present', label: 'Alice' });
  assert.deepEqual(g.sme, { status: 'present', label: 'Dana' });
  const g2 = governanceCompletenessRow(row({ owner: null, sme: null }));
  assert.equal(g2.owner.status, 'missing');
  assert.equal(g2.sme.status, 'missing');
});

test('review cadence uses the existing freshness semantics (unknown = no schedule)', () => {
  assert.deepEqual(governanceCompletenessRow(row({ freshness: 'current' })).reviewCadence, { status: 'present', label: 'Up to date' });
  assert.equal(governanceCompletenessRow(row({ freshness: 'due_soon' })).reviewCadence.status, 'needs_attention');
  assert.equal(governanceCompletenessRow(row({ freshness: 'overdue' })).reviewCadence.status, 'needs_attention');
  assert.deepEqual(governanceCompletenessRow(row({ freshness: 'unknown' })).reviewCadence, { status: 'missing', label: 'No review schedule' });
});

test('coverage cell uses the existing coverageState ladder — unknown stays unknown, not "bad"', () => {
  assert.equal(governanceCompletenessRow(row({ coverageState: 'documented_verified' })).coverage.status, 'present');
  assert.equal(governanceCompletenessRow(row({ coverageState: 'documented_unverified' })).coverage.status, 'needs_attention');
  assert.equal(governanceCompletenessRow(row({ coverageState: 'needs_attention' })).coverage.status, 'needs_attention');
  assert.equal(governanceCompletenessRow(row({ coverageState: 'unknown' })).coverage.status, 'unknown');
  assert.equal(governanceCompletenessRow(row({ coverageState: 'not_documented' })).coverage.status, 'missing');
  // label is the existing vocab string, unchanged
  assert.equal(governanceCompletenessRow(row({ coverageState: 'unknown', coverageLabel: 'Documentation status needs confirmation' })).coverage.label,
    'Documentation status needs confirmation');
});

test('verification reads detail.linkedSources[].verification; falls back to coverage when detail absent', () => {
  assert.equal(governanceCompletenessRow(row({ detail: { linkedSources: [{ verification: 'Verified' }] } })).verification.status, 'present');
  assert.equal(governanceCompletenessRow(row({ detail: { linkedSources: [{ verification: 'Not yet verified' }] } })).verification.status, 'needs_attention');
  assert.equal(governanceCompletenessRow(row({ detail: { linkedSources: [{ verification: 'Rejected' }] } })).verification.status, 'needs_attention');
  assert.equal(governanceCompletenessRow(row({ detail: { linkedSources: [] } })).verification.status, 'missing');
  // no detail at all -> derive from coverageState
  assert.equal(governanceCompletenessRow(row({ detail: undefined, coverageState: 'documented_verified' })).verification.status, 'present');
  assert.equal(governanceCompletenessRow(row({ detail: undefined, coverageState: 'not_documented' })).verification.status, 'missing');
});

test('backup / key-person only RESTATES the existing Phase 7 key-person finding', () => {
  // has a backup -> present with the name
  assert.deepEqual(governanceCompletenessRow(row({ backup: { id: 'u3', name: 'Sam' } })).backupKeyPerson,
    { status: 'present', label: 'Backup: Sam' });
  // every ESTABLISHED key-person level reflects the finding via its existing label
  for (const [level, label] of [
    ['critical', 'Critical key-person dependency'],
    ['high', 'High key-person dependency'],
    ['elevated', 'Elevated dependency'],
    ['informational', 'Minor dependency'],
  ]) {
    assert.deepEqual(
      governanceCompletenessRow(row({ backup: null, keyPersonLevel: level, keyPersonLabel: label })).backupKeyPerson,
      { status: 'needs_attention', label }, `level ${level} must restate the finding`);
  }
  // key-person unknown (criticality unset) -> unknown, not "bad"
  assert.equal(governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'unknown' })).backupKeyPerson.status, 'unknown');
  // level 'none' + no backup -> plain fact 'missing', regardless of criticality
  assert.equal(governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'none', criticality: 'low' })).backupKeyPerson.status, 'missing');
});

test('P9-2 does NOT manufacture key-person risk: mission-critical + no established dependency stays "missing"', () => {
  // Phase 7 established NO identifiable person dependency (keyPersonLevel 'none').
  // A missing backup on a mission-critical process must remain a plain fact —
  // never a new key-person risk invented by the governance view.
  const g = governanceCompletenessRow(row({
    backup: null, keyPersonLevel: 'none', keyPersonLabel: 'No single-person dependency',
    criticality: 'mission_critical',
  }));
  assert.equal(g.backupKeyPerson.status, 'missing');
  assert.notEqual(g.backupKeyPerson.status, 'needs_attention');
  assert.equal(g.backupKeyPerson.label, 'No backup expert');
  // same for 'high'
  assert.equal(governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'none', criticality: 'high' })).backupKeyPerson.status, 'missing');
});

test('the three key-person buckets stay distinct: no-dependency vs unknown vs actual dependency', () => {
  const noDep = governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'none', criticality: 'mission_critical' })).backupKeyPerson.status;
  const unknown = governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'unknown' })).backupKeyPerson.status;
  const actual = governanceCompletenessRow(row({ backup: null, keyPersonLevel: 'high' })).backupKeyPerson.status;
  assert.deepEqual([noDep, unknown, actual], ['missing', 'unknown', 'needs_attention']);
  assert.equal(new Set([noDep, unknown, actual]).size, 3);
});

test('criticality label + continuity pass-through; "Not set" when absent', () => {
  assert.equal(governanceCompletenessRow(row({ criticality: 'mission_critical' })).criticality, 'Mission-critical');
  assert.equal(governanceCompletenessRow(row({ criticality: null })).criticality, 'Not set');
  assert.equal(governanceCompletenessRow(row({ continuityLabel: 'At risk' })).continuityLabel, 'At risk');
});

test('governanceCompleteness maps a list; deterministic; tolerates junk rows', () => {
  const a = governanceCompleteness([row(), row({ id: 'p2', name: 'x' })]);
  const b = governanceCompleteness([row(), row({ id: 'p2', name: 'x' })]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.doesNotThrow(() => governanceCompleteness([{}, null, undefined]));
});

test('governanceCompleteness.ts is pure — no import, no LLM / embeddings / randomness / Base44', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/governanceCompleteness.ts', HERE), 'utf8'));
  assert.equal(/^\s*import\s+[^t]/m.test(src.replace(/import type[^\n]*\n/g, '')), false, 'only type imports allowed');
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|@base44\/sdk|asServiceRole|entities\.|Deno\./.test(src), false);
});
