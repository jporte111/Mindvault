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

// period_key '2026-10' -> completed window [2026-09-01T00:00:00Z, 2026-10-01T00:00:00Z)
const W_START = Date.parse('2026-09-01T00:00:00Z');
const W_END = Date.parse('2026-10-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const rgap = (id, resolved_at, client_scope = 'general') => ({ id, client_scope, status: 'resolved', resolved_at, times_asked: 1 });

test('resolved-gap window: BOTH bounds — [prevMonthStart, thisMonthStart); anchored to period_key, not run date', async () => {
  const b = stub({
    gaps: [
      rgap('before_start', iso(W_START - 1)),           // one ms before windowStart -> EXCLUDED
      rgap('at_start', iso(W_START)),                     // exactly windowStart -> INCLUDED
      rgap('before_end', iso(W_END - 1)),                 // one ms before windowEnd -> INCLUDED
      rgap('at_end', iso(W_END)),                         // exactly windowEnd -> EXCLUDED
      rgap('current_month', '2026-10-14T00:00:00Z'),      // later in the current month -> EXCLUDED
      rgap('way_old', '2026-05-01T00:00:00Z'),            // long before -> EXCLUDED
    ],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW }); // NOW = 2026-10-01T06:00:00Z
  const fp = JSON.parse(plan.rows.find((r) => r.client_scope === 'general').gap_fingerprint);
  const ids = fp.filter((t) => t[2] === 'r').map((t) => t[0]).sort();
  assert.deepEqual(ids, ['at_start', 'before_end']);

  // a LATER rerun in the same month must not widen the set
  const later = await planKnowledgeHealthSnapshots(b, { now: Date.parse('2026-10-27T23:59:00Z') });
  const idsLater = JSON.parse(later.rows.find((r) => r.client_scope === 'general').gap_fingerprint)
    .filter((t) => t[2] === 'r').map((t) => t[0]).sort();
  assert.deepEqual(idsLater, ids, 'rerunning the same period later does not change which resolution dates qualify');
});

test('resolved-gap scope: GENERAL snapshot includes only general resolved gaps', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'A', status: 'active' }, { id: 'B', name: 'B', status: 'active' }],
    gaps: [
      rgap('gGen', '2026-09-10T00:00:00Z', 'general'),
      rgap('gA', '2026-09-11T00:00:00Z', 'client:A'),
      rgap('gB', '2026-09-12T00:00:00Z', 'client:B'),
    ],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const gen = plan.rows.find((r) => r.client_scope === 'general').gap_fingerprint;
  assert.ok(JSON.parse(gen).some((t) => t[0] === 'gGen' && t[2] === 'r'));
  assert.equal(/gA|gB/.test(gen), false, 'general excludes every client resolved gap');
});

test('resolved-gap scope: CLIENT A snapshot includes general + client:A, never client:B', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'A', status: 'active' }, { id: 'B', name: 'B', status: 'active' }],
    gaps: [
      rgap('gGen', '2026-09-10T00:00:00Z', 'general'),
      rgap('gA', '2026-09-11T00:00:00Z', 'client:A'),
      rgap('gB', '2026-09-12T00:00:00Z', 'client:B'),
    ],
  });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const a = plan.rows.find((r) => r.client_scope === 'client:A').gap_fingerprint;
  const aIds = JSON.parse(a).filter((t) => t[2] === 'r').map((t) => t[0]).sort();
  assert.deepEqual(aIds, ['gA', 'gGen'], 'client A gets general + its own resolved gaps');
  assert.equal(a.includes('gB'), false, 'client B resolved gap never appears in client A');
  // client B's own row is fine — the plan naturally builds it, but it never leaks into A
  const bRow = plan.rows.find((r) => r.client_scope === 'client:B').gap_fingerprint;
  assert.equal(bRow.includes('gA'), false, 'client A resolved gap never appears in client B');

  // every resolved-gap read is scoped to exactly 'general' or one 'client:<id>' and bounded
  const resolvedReads = b.__reads.KnowledgeGap.filter((rd) => rd.q.status === 'resolved');
  for (const rd of resolvedReads) {
    assert.ok(rd.q.client_scope === 'general' || /^client:[A-Za-z0-9]+$/.test(rd.q.client_scope));
    assert.ok(typeof rd.limit === 'number' && rd.limit <= 2000);
  }
  // 1 (general row) + 2 (client:A: general+A) + 2 (client:B: general+B)
  assert.equal(resolvedReads.length, 5);
});

test('resolved-gap dedupe: a duplicate id across the general + client reads dedupes deterministically', async () => {
  const b = stub({
    clients: [{ id: 'A', name: 'A', status: 'active' }],
    gaps: [
      // same id present in both scope reads (fixture-contrived); general read is first -> wins
      { id: 'dup', client_scope: 'general', status: 'resolved', resolved_at: '2026-09-05T00:00:00Z', times_asked: 3, operational_process_id: null },
      { id: 'dup', client_scope: 'client:A', status: 'resolved', resolved_at: '2026-09-20T00:00:00Z', times_asked: 9, operational_process_id: null },
    ],
  });
  const p1 = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const p2 = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const fp1 = JSON.parse(p1.rows.find((r) => r.client_scope === 'client:A').gap_fingerprint).filter((t) => t[0] === 'dup');
  const fp2 = JSON.parse(p2.rows.find((r) => r.client_scope === 'client:A').gap_fingerprint).filter((t) => t[0] === 'dup');
  assert.equal(fp1.length, 1, 'exactly one tuple for the duplicated id');
  assert.deepEqual(fp1, fp2, 'deterministic across runs');
  assert.equal(fp1[0][1], 3, 'the general read (first) wins the dedupe');
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
