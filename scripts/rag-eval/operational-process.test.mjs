// Structure + helper tests for the OperationalProcess entity and its UI lib.
// No Base44, no network.
//   node --test scripts/rag-eval/operational-process.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CLIENT_PREFIX,
  SCOPE_GENERAL,
  SCOPE_UNCLASSIFIED,
  PROCESS_CRITICALITY_OPTIONS,
  PROCESS_FRESHNESS_VALUES,
  isProcessScopeCompatible,
  processFreshness,
  processScopeValue,
  resolveProcessScopeFields,
} from '../../src/lib/operationalProcess.js';
import { visibleProcesses } from '../../base44/shared/processAccess.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const jsonc = readFileSync(resolve(repo, 'base44/entities/OperationalProcess.jsonc'), 'utf8');
const schema = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ''));
const props = schema.properties;

// --- Entity schema ---

test('OperationalProcess entity parses and has the expected shape', () => {
  assert.equal(schema.name, 'OperationalProcess');
  assert.deepEqual(schema.required, ['name']);
  assert.equal(props.name.minLength, 1);
  assert.equal(props.review_interval_days.minimum, 1);
});

test('knowledge_scope defaults to unclassified, never general', () => {
  assert.equal(props.knowledge_scope.default, 'unclassified');
  assert.deepEqual(props.knowledge_scope.enum, ['unclassified', 'general', 'client-specific']);
});

test('freshness_status is unreviewed-first and has no archived value', () => {
  assert.deepEqual(props.freshness_status.enum, ['unreviewed', 'current', 'due_soon', 'stale', 'review_requested']);
  assert.ok(!props.freshness_status.enum.includes('archived'));
});

test('archival lives only on the status field', () => {
  assert.deepEqual(props.status.enum, ['active', 'archived']);
  assert.equal(props.status.default, 'active');
});

test('criticality enum matches the four documented levels', () => {
  assert.deepEqual(props.criticality.enum, ['low', 'medium', 'high', 'mission_critical']);
});

test('entity RLS restricts EVERY operation (incl. read) to admins', () => {
  assert.ok(schema.rls, 'no rls block on OperationalProcess');
  for (const op of ['create', 'read', 'update', 'delete']) {
    assert.deepEqual(schema.rls[op], { user_condition: { role: 'admin' } }, `${op} not admin-gated`);
  }
});

// --- Lib parity with the entity ---

test('PROCESS_FRESHNESS_VALUES matches the entity enum exactly', () => {
  assert.deepEqual([...PROCESS_FRESHNESS_VALUES], [...props.freshness_status.enum]);
});

test('PROCESS_CRITICALITY_OPTIONS values match the entity enum', () => {
  assert.deepEqual(PROCESS_CRITICALITY_OPTIONS.map((o) => o.value), props.criticality.enum);
  for (const o of PROCESS_CRITICALITY_OPTIONS) assert.ok(o.label && o.label.trim());
});

test('inlined scope constants mirror src/lib/knowledgeScope.js', () => {
  const ks = readFileSync(resolve(repo, 'src/lib/knowledgeScope.js'), 'utf8');
  const grab = (name) => ks.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1];
  assert.equal(SCOPE_UNCLASSIFIED, grab('SCOPE_UNCLASSIFIED'));
  assert.equal(SCOPE_GENERAL, grab('SCOPE_GENERAL'));
  assert.equal(CLIENT_PREFIX, grab('CLIENT_PREFIX'));
});

// --- Helpers ---

test('processFreshness treats missing as unreviewed', () => {
  assert.equal(processFreshness(null), 'unreviewed');
  assert.equal(processFreshness({}), 'unreviewed');
  assert.equal(processFreshness({ freshness_status: 'stale' }), 'stale');
});

test('processScopeValue round-trips scope', () => {
  assert.equal(processScopeValue(null), 'unclassified');
  assert.equal(processScopeValue({ knowledge_scope: 'general' }), 'general');
  assert.equal(processScopeValue({ knowledge_scope: 'client-specific', client_id: 'c1' }), 'client:c1');
  assert.equal(processScopeValue({ knowledge_scope: 'client-specific' }), 'unclassified'); // no id -> not client
});

test('resolveProcessScopeFields maps UI value -> stored fields (no client_name)', () => {
  assert.deepEqual(resolveProcessScopeFields('general'), { knowledge_scope: 'general', client_id: null });
  assert.deepEqual(resolveProcessScopeFields('client:abc'), { knowledge_scope: 'client-specific', client_id: 'abc' });
  assert.deepEqual(resolveProcessScopeFields('unclassified'), { knowledge_scope: 'unclassified', client_id: null });
  assert.deepEqual(resolveProcessScopeFields(''), { knowledge_scope: 'unclassified', client_id: null });
});

// --- Scope compatibility for linking a source to a process ---

test('isProcessScopeCompatible: same scope required', () => {
  const u = { knowledge_scope: 'unclassified' };
  const g = { knowledge_scope: 'general' };
  assert.equal(isProcessScopeCompatible(u, { knowledge_scope: 'unclassified' }), true);
  assert.equal(isProcessScopeCompatible(u, { knowledge_scope: 'general' }), false);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: 'general' }), true);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: 'unclassified' }), false);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: 'client-specific', client_id: 'c1' }), false);
});

test('isProcessScopeCompatible: client-specific needs exact same client_id', () => {
  const src = { knowledge_scope: 'client-specific', client_id: 'c1' };
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: 'client-specific', client_id: 'c1' }), true);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: 'client-specific', client_id: 'c2' }), false);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: 'client-specific' }), false);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: 'general' }), false);
});

test('isProcessScopeCompatible: client-specific source missing its own client_id never matches', () => {
  const src = { knowledge_scope: 'client-specific' };
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: 'client-specific', client_id: 'c1' }), false);
});

test('isProcessScopeCompatible: missing knowledge_scope treated as unclassified on both sides', () => {
  assert.equal(isProcessScopeCompatible({}, {}), true);
  assert.equal(isProcessScopeCompatible({}, { knowledge_scope: 'general' }), false);
  assert.equal(isProcessScopeCompatible(undefined, { knowledge_scope: 'unclassified' }), true);
});

// --- Server-side read visibility (visibleProcesses) ---

const SAMPLE = [
  { id: 'g1', knowledge_scope: 'general' },
  { id: 'g2', knowledge_scope: 'general', status: 'archived' },
  { id: 'c1', knowledge_scope: 'client-specific', client_id: 'acme' },
  { id: 'c2', knowledge_scope: 'client-specific', client_id: 'beta' },
  { id: 'u1', knowledge_scope: 'unclassified' },
  { id: 'x1' },
];

test('visibleProcesses: no user -> nothing', () => {
  assert.deepEqual(visibleProcesses(null, SAMPLE), []);
  assert.deepEqual(visibleProcesses(undefined, SAMPLE), []);
});

test('visibleProcesses: admin -> everything', () => {
  assert.deepEqual(visibleProcesses({ role: 'admin' }, SAMPLE), SAMPLE);
});

test('visibleProcesses: non-admin -> ONLY organization-wide (general)', () => {
  const seen = visibleProcesses({ role: 'user' }, SAMPLE).map((p) => p.id);
  assert.deepEqual(seen, ['g1', 'g2']);
});

test('visibleProcesses: non-admin never sees client-specific or unclassified', () => {
  for (const role of ['user', undefined, 'viewer']) {
    const scopes = visibleProcesses({ role }, SAMPLE).map((p) => p.knowledge_scope);
    assert.ok(scopes.every((s) => s === 'general'), `role=${role} leaked ${JSON.stringify(scopes)}`);
    assert.ok(!scopes.includes('client-specific'));
    assert.ok(!scopes.includes('unclassified'));
  }
});
