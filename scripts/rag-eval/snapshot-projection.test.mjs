// Phase 9 P9-1 — pure tests for base44/shared/health/snapshotProjection.ts.
// The projection ONLY reads fields the Phase 7 computeKnowledgeHealth payload
// already computed; it never re-derives a health semantic, reads an entity,
// calls an LLM/embeddings, or emits person/content data.
//   node --test scripts/rag-eval/snapshot-projection.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  snapshotFromHealthPayload,
  clientScopeOf,
  SNAPSHOT_SCHEMA_VERSION,
} from '../../base44/shared/health/snapshotProjection.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// A representative Phase 7 payload (only the fields the projection reads).
const payload = (over = {}) => ({
  scope: { kind: 'general' },
  snapshot: {
    coverage: { band: 'Partial', label: 'Partial' },
    currency: { band: 'Slipping', label: 'Slipping' },
    verification: { band: 'Review backlog', label: 'Review backlog', caveat: 'x' },
    keyPersonResilience: { band: 'Watch', label: 'Watch' },
  },
  metrics: {
    criticalCoverage: { covered: 8, evaluable: 12, unknown: 3 },
    knowledgeNeedingReview: { overdue: 5, due_soon: 2 },
    activeNotVerified: { total: 9, criticalLinked: 4 },
    openGaps: { open: 3, watching: 6 },
    processesWithoutOwnerOrSme: 7,
    keyPersonDependencyRisk: { processes: 2, concentrationPeople: 1 },
    sourcesNeedingAttention: 4,
    effectiveDateExposure: { expiredActive: 1 },
  },
  setup: {
    processesNeedingOwner: 3, processesNeedingSme: 4, processesNeedingCriticality: 2,
    sourcesNeedingCadence: 6, unlinkedSources: 5, unclassifiedItems: 8, legacyNeedingReindex: 10,
  },
  processRows: [
    { id: 'p1', name: 'Alice-owned close', owner: { id: 'u1', name: 'Alice' }, continuityState: 'at_risk' },
    { id: 'p2', name: 'Bob process', continuityState: 'ready' },
    { id: 'p3', name: 'x', continuityState: 'at_risk' },
    { id: 'p4', name: 'y', continuityState: 'needs_setup' },
  ],
  keyPersonExposure: [{ userId: 'u9', name: 'Carla', processes: [{ id: 'p1', name: 'Alice-owned close' }] }],
  reviewQueue: [{ id: 'q1', title: 'A published source failed', label: 'x' }],
  gaps: [{ id: 'g1', title: 'draw handl jlm process request' }],
  ...over,
});

test('maps every band and metric to the documented field', () => {
  const r = snapshotFromHealthPayload(payload(), { period_key: '2026-09' });
  assert.equal(r.period_key, '2026-09');
  assert.equal(r.client_scope, 'general');
  assert.equal(r.schema_version, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(r.coverage_band, 'Partial');
  assert.equal(r.currency_band, 'Slipping');
  assert.equal(r.verification_band, 'Review backlog');
  assert.equal(r.key_person_resilience_band, 'Watch');
  assert.equal(r.critical_covered, 8);
  assert.equal(r.critical_evaluable, 12);
  assert.equal(r.critical_unknown, 3);
  assert.equal(r.reviews_overdue, 5);
  assert.equal(r.reviews_due_soon, 2);
  assert.equal(r.active_not_verified, 9);
  assert.equal(r.active_not_verified_critical, 4);
  assert.equal(r.gaps_open, 3);
  assert.equal(r.gaps_watching, 6);
  assert.equal(r.processes_total, 4);
  assert.equal(r.processes_at_risk, 2); // p1 + p3
  assert.equal(r.key_person_high_or_critical, 2);
  assert.equal(r.concentration_people, 1);
  assert.equal(r.sources_needing_attention, 4);
  assert.equal(r.expired_active, 1);
  assert.equal(r.processes_without_owner_or_sme, 7);
  assert.equal(r.processes_needing_owner, 3);
  assert.equal(r.processes_needing_sme, 4);
  assert.equal(r.processes_needing_criticality, 2);
  assert.equal(r.sources_needing_cadence, 6);
  assert.equal(r.unlinked_sources, 5);
  assert.equal(r.unclassified_items, 8);
  assert.equal(r.legacy_needing_reindex, 10);
});

test('client_scope is derived from the payload scope, never a caller value', () => {
  assert.equal(clientScopeOf({ scope: { kind: 'general' } }), 'general');
  assert.equal(clientScopeOf({ scope: { kind: 'client', clientId: 'A' } }), 'client:A');
  assert.equal(clientScopeOf({}), 'general');
  const r = snapshotFromHealthPayload(payload({ scope: { kind: 'client', clientId: 'JLM' } }), { period_key: '2026-09' });
  assert.equal(r.client_scope, 'client:JLM');
});

test('projection is deterministic — identical payload -> deep-equal row', () => {
  const a = snapshotFromHealthPayload(payload(), { period_key: '2026-09' });
  const b = snapshotFromHealthPayload(payload(), { period_key: '2026-09' });
  assert.deepEqual(a, b);
});

test('projection output carries NO person / content data', () => {
  const r = snapshotFromHealthPayload(payload(), { period_key: '2026-09' });
  const keys = Object.keys(r);
  for (const k of ['client_id', 'name', 'title', 'owner', 'sme', 'user_id', 'reporter_hmac',
    'question', 'example_questions', 'standalone_query', 'processRows', 'keyPersonExposure', 'gaps', 'reviewQueue']) {
    assert.equal(keys.includes(k), false, `projection must not carry "${k}"`);
  }
  // every value is a number or a short band string — nothing that could be a name/title/question
  for (const [k, v] of Object.entries(r)) {
    if (k === 'period_key' || k === 'client_scope') continue;
    if (typeof v === 'number') continue;
    assert.ok(['Strong', 'Partial', 'Weak', 'Unknown', 'Current', 'Slipping', 'Overdue',
      'Confirmed', 'Mostly confirmed', 'Review backlog', 'Resilient', 'Watch', 'Exposed'].includes(v),
      `field ${k} is a non-band string: ${v}`);
  }
  const s = JSON.stringify(r);
  assert.equal(/Alice|Bob|Carla|draw handl|jlm/i.test(s), false, 'no name/title/question text leaked');
});

test('missing / partial payload sections default to 0 / Unknown — never throw', () => {
  const r = snapshotFromHealthPayload({ scope: { kind: 'general' } }, { period_key: '2026-09' });
  assert.equal(r.coverage_band, 'Unknown');
  assert.equal(r.critical_covered, 0);
  assert.equal(r.processes_total, 0);
  assert.equal(r.processes_at_risk, 0);
});

test('snapshotProjection.ts is pure — no Base44 SDK / entity / LLM / embeddings / randomness', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/snapshotProjection.ts', HERE), 'utf8'));
  assert.equal(/@base44\/sdk|createClientFromRequest|asServiceRole|entities\.|InvokeLLM|\.embed\s*\(|Math\.random|Deno\./.test(src), false);
});
