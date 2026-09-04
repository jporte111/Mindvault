// Phase 9 P9-1 — capture binding (base44/shared/health/snapshotCapture.ts) and
// the thin Deno entry shell. One row per scope per month, idempotent upsert,
// dry-run writes nothing, flag-off refuses writes, scope isolation, and the
// hard guarantee that capture writes ONLY KnowledgeHealthSnapshot.
//   node --test scripts/rag-eval/snapshot-capture.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planKnowledgeHealthSnapshots,
  upsertSnapshotRows,
  snapshotPeriodKey,
} from '../../base44/shared/health/snapshotCapture.ts';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const NOW = Date.parse('2026-09-15T12:00:00Z');

// Generic in-memory Base44 stub. Every entity starts empty unless seeded; a
// write counter is kept per entity so we can assert capture only writes
// KnowledgeHealthSnapshot.
function stub({ clients = [], snapshots = [] } = {}) {
  const store = {
    OperationalProcess: [], Training: [], KnowledgeChunk: [], KnowledgeGap: [],
    ClarificationRequest: [], KnowledgeLifecycleOperation: [], User: [],
    Client: [...clients], KnowledgeHealthSnapshot: [...snapshots], AppConfig: [],
  };
  const writes = {};
  let seq = 0;
  const match = (r, q) => Object.entries(q || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(r[k]);
    if (v && typeof v === 'object' && '$gte' in v) return String(r[k]) >= v.$gte;
    return r[k] === v;
  });
  const coll = (name) => ({
    async filter(q, _sort, limit) {
      let rows = (store[name] || []).filter((r) => match(r, q));
      if (typeof limit === 'number') rows = rows.slice(0, limit);
      return rows.map((r) => ({ ...r }));
    },
    async get(id) { const r = (store[name] || []).find((x) => x.id === id); return r ? { ...r } : null; },
    async create(fields) {
      writes[name] = (writes[name] || 0) + 1;
      const row = { id: `${name}_${++seq}`, ...fields };
      store[name].push(row);
      return { ...row };
    },
    async update(id, patch) {
      writes[name] = (writes[name] || 0) + 1;
      const row = store[name].find((x) => x.id === id);
      Object.assign(row, patch);
      return { ...row };
    },
  });
  const entities = {};
  for (const n of Object.keys(store)) entities[n] = coll(n);
  return { asServiceRole: { entities }, __store: store, __writes: writes };
}

// ==================================================================
// planKnowledgeHealthSnapshots — one row per scope, correct scope strings
// ==================================================================

test('plan: general + one row per ACTIVE client; archived clients excluded', async () => {
  const b = stub({ clients: [
    { id: 'A', name: 'Client A', status: 'active' },
    { id: 'B', name: 'Client B', status: 'active' },
    { id: 'Z', name: 'Old client', status: 'archived' },
  ] });
  const plan = await planKnowledgeHealthSnapshots(b, { now: NOW });
  assert.equal(plan.period_key, '2026-09');
  const scopes = plan.rows.map((r) => r.client_scope).sort();
  assert.deepEqual(scopes, ['client:A', 'client:B', 'general']);
  for (const r of plan.rows) {
    assert.equal(r.period_key, '2026-09');
    assert.equal(r.schema_version, 1);
    // shape sanity — every metric present and numeric on an empty deployment
    assert.equal(typeof r.processes_total, 'number');
    assert.equal(typeof r.gaps_open, 'number');
  }
});

test('plan writes NOTHING', async () => {
  const b = stub({ clients: [{ id: 'A', name: 'A', status: 'active' }] });
  await planKnowledgeHealthSnapshots(b, { now: NOW });
  assert.deepEqual(b.__writes, {});
});

test('snapshotPeriodKey is deterministic UTC YYYY-MM', () => {
  assert.equal(snapshotPeriodKey(Date.parse('2026-01-01T00:00:00Z')), '2026-01');
  assert.equal(snapshotPeriodKey(Date.parse('2026-12-31T23:59:59Z')), '2026-12');
});

// ==================================================================
// upsertSnapshotRows — idempotent, one row per (period_key, client_scope)
// ==================================================================

test('upsert: first run creates, second run updates — never a duplicate', async () => {
  const b = stub({ clients: [{ id: 'A', name: 'A', status: 'active' }] });
  const p1 = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const r1 = await upsertSnapshotRows(b, p1.rows);
  assert.deepEqual(r1.map((x) => x.action).sort(), ['created', 'created']);
  assert.equal(b.__store.KnowledgeHealthSnapshot.length, 2);

  const p2 = await planKnowledgeHealthSnapshots(b, { now: NOW });
  const r2 = await upsertSnapshotRows(b, p2.rows);
  assert.deepEqual(r2.map((x) => x.action).sort(), ['updated', 'updated']);
  assert.equal(b.__store.KnowledgeHealthSnapshot.length, 2, 'still exactly one row per scope for this month');

  // a different month adds new rows, does not touch September
  const p3 = await planKnowledgeHealthSnapshots(b, { now: Date.parse('2026-10-02T00:00:00Z') });
  await upsertSnapshotRows(b, p3.rows);
  assert.equal(b.__store.KnowledgeHealthSnapshot.length, 4);
  const sep = b.__store.KnowledgeHealthSnapshot.filter((r) => r.period_key === '2026-09');
  assert.equal(sep.length, 2);
});

test('capture writes ONLY KnowledgeHealthSnapshot — never a business entity or Notification', async () => {
  const b = stub({ clients: [{ id: 'A', name: 'A', status: 'active' }, { id: 'B', name: 'B', status: 'active' }] });
  const p = await planKnowledgeHealthSnapshots(b, { now: NOW });
  await upsertSnapshotRows(b, p.rows);
  assert.deepEqual(Object.keys(b.__writes), ['KnowledgeHealthSnapshot']);
  for (const forbidden of ['Training', 'KnowledgeChunk', 'OperationalProcess', 'KnowledgeGap', 'Notification', 'Client']) {
    assert.equal(b.__writes[forbidden] || 0, 0, `capture must not write ${forbidden}`);
  }
});

// ==================================================================
// scope isolation
// ==================================================================

test('scope isolation: each row is keyed by its own canonical client_scope; no cross-client mixing', async () => {
  const b = stub({ clients: [{ id: 'JLM', name: 'JLM', status: 'active' }, { id: 'GBP', name: 'GBP', status: 'active' }] });
  const p = await planKnowledgeHealthSnapshots(b, { now: NOW });
  await upsertSnapshotRows(b, p.rows);
  const rows = b.__store.KnowledgeHealthSnapshot;
  assert.deepEqual(rows.map((r) => r.client_scope).sort(), ['client:GBP', 'client:JLM', 'general']);
  // no row carries a client_id field or any second-scope marker
  for (const r of rows) {
    assert.equal('client_id' in r, false);
    assert.equal(Object.keys(r).filter((k) => k.startsWith('client_')).sort().join(','), 'client_scope');
  }
});

// ==================================================================
// entry shell — source-level guarantees (Deno.serve can't run under node --test)
// ==================================================================

const entrySrc = readFileSync(new URL('../../base44/functions/captureKnowledgeHealthSnapshot/entry.ts', HERE), 'utf8');
const bindingSrc = stripComments(readFileSync(new URL('../../base44/shared/health/snapshotCapture.ts', HERE), 'utf8'));

test('entry: dryRun defaults to true (safe)', () => {
  assert.ok(entrySrc.includes('body?.dryRun !== false'), 'dryRun must default to true');
});

test('entry: flag-off write refusal returns reason and PRECEDES any plan/write', () => {
  const refuseIdx = entrySrc.indexOf("reason: 'snapshots_disabled'");
  assert.ok(refuseIdx > -1, 'entry must refuse with an explicit reason');
  const planIdx = entrySrc.indexOf('planKnowledgeHealthSnapshots(base44');
  const writeIdx = entrySrc.indexOf('upsertSnapshotRows(base44');
  assert.ok(refuseIdx < planIdx && refuseIdx < writeIdx, 'refusal must come before planning or writing');
  assert.ok(entrySrc.includes('!dryRun && !snapshotsEnabled'), 'write mode requires the flag');
});

test('entry + binding: no writes to Training / KnowledgeChunk / OperationalProcess / KnowledgeGap / Notification', () => {
  for (const src of [stripComments(entrySrc), bindingSrc]) {
    assert.equal(
      /entities\.(Training|KnowledgeChunk|OperationalProcess|KnowledgeGap|Notification)\.(create|update|delete|bulkCreate|bulkUpdate)/.test(src),
      false,
    );
  }
});

test('entry + binding: no LLM / embeddings / randomness', () => {
  for (const src of [stripComments(entrySrc), bindingSrc]) {
    assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random/.test(src), false);
  }
});
