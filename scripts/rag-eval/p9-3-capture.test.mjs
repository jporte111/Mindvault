// Phase 9 P9-3 — monthly capture now also projects the fingerprint fields onto
// each KnowledgeHealthSnapshot row. Capture still: one row per
// (period_key, client_scope), idempotent, exact-scope resolved-gap lookup,
// writes ONLY KnowledgeHealthSnapshot.
//   node --test scripts/rag-eval/p9-3-capture.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planKnowledgeHealthSnapshots, upsertSnapshotRows } from '../../base44/shared/health/snapshotCapture.ts';
import { FINGERPRINT_VERSION } from '../../base44/shared/health/continuityChange.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const NOW = Date.parse('2026-10-01T06:00:00Z'); // period_key 2026-10

function stub({ clients = [], gaps = [], snapshots = [] } = {}) {
  const store = {
    OperationalProcess: [], Training: [], KnowledgeChunk: [], KnowledgeGap: [...gaps],
    ClarificationRequest: [], KnowledgeLifecycleOperation: [], User: [],
    Client: [...clients], KnowledgeHealthSnapshot: [...snapshots], AppConfig: [],
  };
  const writes = {};
  const reads = { KnowledgeGap: [] };
  let seq = 0;
  const match = (r, q) => Object.entries(q || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(r[k]);
    if (v && typeof v === 'object' && '$gte' in v) return String(r[k]) >= v.$gte;
    return r[k] === v;
  });
  const coll = (name) => ({
    async filter(q, sort, limit) {
      if (name === 'KnowledgeGap') reads.KnowledgeGap.push({ q, sort, limit });
      let rows = (store[name] || []).filter((r) => match(r, q));
      if (typeof limit === 'number') rows = rows.slice(0, limit);
      return rows.map((r) => ({ ...r }));
    },
    async get(id) { const r = (store[name] || []).find((x) => x.id === id); return r ? { ...r } : null; },
    async create(fields) { writes[name] = (writes[name] || 0) + 1; const row = { id: `${name}_${++seq}`, ...fields }; store[name].push(row); return { ...row }; },
    async update(id, patch) { writes[name] = (writes[name] || 0) + 1; Object.assign(store[name].find((x) => x.id === id), patch); return {}; },
  });
  const entities = {};
  for (const n of Object.keys(store)) entities[n] = coll(n);
  return { asServiceRole: { entities }, __store: store, __writes: writes, __reads: reads };
}

test('plan: every row carries fingerprint_version + the four fingerprint fields', async () => {
  const b = stub({ clients: [{ id: 'A', name: 'A', status: 'active' }] });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  assert.equal(plan.period_key, '2026-10');
  for (const row of plan.rows) {
    assert.equal(row.fingerprint_version, FINGERPRINT_VERSION);
    assert.equal(typeof row.exposure_fingerprint, 'string');
    assert.equal(typeof row.gap_fingerprint, 'string');
    assert.equal(typeof row.exposure_truncated, 'boolean');
    assert.equal(typeof row.gap_truncated, 'boolean');
    // still an aggregate row — the P9-1 scalars are present
    assert.equal(typeof row.processes_at_risk, 'number');
  }
});

test('resolved-gap lookup: bounded, EXACT client_scope, status=resolved, window = prior month start', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'A', status: 'active' }],
    gaps: [
      { id: 'gA_recent', client_scope: 'client:A', status: 'resolved', resolved_at: '2026-09-20T00:00:00Z', times_asked: 7 },
      { id: 'gA_old', client_scope: 'client:A', status: 'resolved', resolved_at: '2026-05-01T00:00:00Z', times_asked: 3 },
      { id: 'gB', client_scope: 'client:B', status: 'resolved', resolved_at: '2026-09-25T00:00:00Z', times_asked: 9 },
      { id: 'gGen', client_scope: 'general', status: 'resolved', resolved_at: '2026-09-10T00:00:00Z', times_asked: 4 },
    ],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const rowA = plan.rows.find((r) => r.client_scope === 'client:A');
  const rowGen = plan.rows.find((r) => r.client_scope === 'general');

  // client:A row includes only client:A's recently-resolved gap (window starts 2026-09-01)
  const fpA = JSON.parse(rowA.gap_fingerprint);
  assert.ok(fpA.some((t) => t[0] === 'gA_recent' && t[2] === 'r'));
  assert.equal(fpA.some((t) => t[0] === 'gA_old'), false, 'resolved before the window is excluded');
  assert.equal(rowA.gap_fingerprint.includes('gB'), false, 'client B gap never appears in client A');

  // general row gets only the general resolved gap
  assert.ok(JSON.parse(rowGen.gap_fingerprint).some((t) => t[0] === 'gGen'));
  assert.equal(rowGen.gap_fingerprint.includes('gA_recent'), false);

  // the P9-3 resolved-gap reads (status === 'resolved') are each scoped + bounded,
  // one per scope (general + client:A). Other KnowledgeGap reads belong to the
  // unchanged Phase 7 health engine.
  const resolvedReads = b.__reads.KnowledgeGap.filter((rd) => rd.q.status === 'resolved');
  assert.equal(resolvedReads.length, 2);
  assert.deepEqual(resolvedReads.map((rd) => rd.q.client_scope).sort(), ['client:A', 'general']);
  for (const rd of resolvedReads) assert.ok(typeof rd.limit === 'number' && rd.limit <= 2000);
});

test('capture writes ONLY KnowledgeHealthSnapshot (KnowledgeGap is read-only)', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'A', status: 'active' }],
    gaps: [{ id: 'g1', client_scope: 'general', status: 'resolved', resolved_at: '2026-09-15T00:00:00Z', times_asked: 2 }],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  await upsertSnapshotRows(b, plan.rows);
  assert.deepEqual(Object.keys(b.__writes), ['KnowledgeHealthSnapshot']);
  for (const forbidden of ['KnowledgeGap', 'Training', 'OperationalProcess', 'KnowledgeChunk', 'Notification', 'Client']) {
    assert.equal(b.__writes[forbidden] || 0, 0);
  }
});

test('idempotent: re-running the same month overwrites, one row per (period_key, client_scope)', async () => {
  const b = stub({ clients: [{ id: 'A', name: 'A', status: 'active' }] });
  await upsertSnapshotRows(b, (await planKnowledgeHealthSnapshots(b, { now: NOW })).rows);
  await upsertSnapshotRows(b, (await planKnowledgeHealthSnapshots(b, { now: NOW })).rows);
  assert.equal(b.__store.KnowledgeHealthSnapshot.length, 2); // general + client:A, no duplicates
  const scopes = b.__store.KnowledgeHealthSnapshot.map((r) => `${r.period_key}|${r.client_scope}`).sort();
  assert.deepEqual(scopes, ['2026-10|client:A', '2026-10|general']);
});

test('a written row contains no employee/reporter/question/topic/title text', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'Alice Corp', status: 'active' }],
    gaps: [{ id: 'g1', client_scope: 'client:A', status: 'resolved', resolved_at: '2026-09-15T00:00:00Z',
      times_asked: 2, title: 'vendor lien releases', normalized_topic: 'vendor lien release',
      reporter_hmacs: ['HMAC_X'], example_questions: ['how do I file a lien release'], distinct_reporters: 3 }],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const blob = JSON.stringify(plan.rows);
  assert.equal(/vendor lien|HMAC_X|how do I file|normalized_topic|distinct_reporters|example_question|Alice Corp/i.test(blob), false);
});

test('snapshotCapture.ts still writes nothing but KnowledgeHealthSnapshot (source scan)', () => {
  const src = stripComments(readFileSync(new URL('../../base44/shared/health/snapshotCapture.ts', HERE), 'utf8'));
  assert.equal(/entities\.(KnowledgeGap|Training|OperationalProcess|KnowledgeChunk|Notification)\.(create|update|delete|bulkCreate|bulkUpdate)/.test(src), false);
  assert.ok(/entities\.KnowledgeGap\s*\.filter\(/.test(src), 'resolved-gap read is a filter');
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random/.test(src), false);
});
