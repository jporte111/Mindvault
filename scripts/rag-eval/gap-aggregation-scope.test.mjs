// Phase 5 hardening — write-side related-source scope invariant in
// base44/shared/gapAggregation.ts (aggregateGap). A KnowledgeGap must never
// store a related_source_id that is outside its client_scope, and must not
// inherit an operational_process_id from an out-of-scope source. Existing
// dedupe / aggregation semantics are unchanged.
//   node --test scripts/rag-eval/gap-aggregation-scope.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateGap } from '../../base44/shared/gapAggregation.ts';

// ------------------------------------------------------------------
// in-memory Base44 stub (reads via .filter/.get, writes via .create/.update)
// ------------------------------------------------------------------
function stub({ trainings = [], gaps = [] } = {}) {
  const store = { Training: [...trainings], KnowledgeGap: [...gaps], AuditEvent: [] };
  const calls = { trainingFilter: 0, trainingGet: 0, gapCreate: 0, gapUpdate: 0 };
  let seq = 0;
  const matches = (row, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    if (v && typeof v === 'object' && '$gte' in v) return String(row[k]) >= v.$gte;
    return row[k] === v;
  });
  const coll = (name) => ({
    async filter(q, _sort, limit) {
      if (name === 'Training') calls.trainingFilter++;
      let rows = store[name].filter((r) => matches(r, q || {}));
      if (typeof limit === 'number') rows = rows.slice(0, limit);
      return rows.map((r) => ({ ...r }));
    },
    async get(id) {
      if (name === 'Training') calls.trainingGet++;
      const r = store[name].find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    async create(fields) {
      if (name === 'KnowledgeGap') calls.gapCreate++;
      const row = { id: `${name.toLowerCase()}_${++seq}`, ...fields };
      store[name].push(row);
      return { ...row };
    },
    async update(id, patch) {
      if (name === 'KnowledgeGap') calls.gapUpdate++;
      const row = store[name].find((x) => x.id === id);
      Object.assign(row, patch);
      return { ...row };
    },
  });
  return {
    asServiceRole: { entities: { Training: coll('Training'), KnowledgeGap: coll('KnowledgeGap'), AuditEvent: coll('AuditEvent') } },
    __store: store,
    __calls: calls,
  };
}

const T = (o) => ({ id: o.id, title: o.id, knowledge_scope: 'general', ...o });
const ev = (o = {}) => ({
  question: 'who approves emergency vendor payments',
  clientScope: 'general',
  origin: 'explicit_feedback',
  reporterHmac: 'hmac-1',
  relatedSourceIds: [],
  ...o,
});
const lastGap = (b) => b.__store.KnowledgeGap[b.__store.KnowledgeGap.length - 1];

// ==================================================================
// storage: only scope-compatible related_source_ids are persisted
// ==================================================================

test('general gap + general source -> retained', async () => {
  const b = stub({ trainings: [T({ id: 's_gen' })] });
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s_gen'] }));
  assert.deepEqual(lastGap(b).related_source_ids, ['s_gen']);
});

test('general gap + client source -> dropped', async () => {
  const b = stub({ trainings: [T({ id: 's_cliA', knowledge_scope: 'client-specific', client_id: 'A' })] });
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s_cliA'] }));
  assert.deepEqual(lastGap(b).related_source_ids, []);
});

test('client A gap + general source -> retained', async () => {
  const b = stub({ trainings: [T({ id: 's_gen' })] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_gen'] }));
  assert.deepEqual(lastGap(b).related_source_ids, ['s_gen']);
});

test('client A gap + client A source -> retained', async () => {
  const b = stub({ trainings: [T({ id: 's_A', knowledge_scope: 'client-specific', client_id: 'A' })] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_A'] }));
  assert.deepEqual(lastGap(b).related_source_ids, ['s_A']);
});

test('client A gap + client B source -> dropped', async () => {
  const b = stub({ trainings: [T({ id: 's_B', knowledge_scope: 'client-specific', client_id: 'B' })] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_B'] }));
  assert.deepEqual(lastGap(b).related_source_ids, []);
});

test('client A gap + mixed general / A / B sources -> only general + A retained, order preserved', async () => {
  const b = stub({ trainings: [
    T({ id: 's_B', knowledge_scope: 'client-specific', client_id: 'B' }),
    T({ id: 's_gen' }),
    T({ id: 's_A', knowledge_scope: 'client-specific', client_id: 'A' }),
  ] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_B', 's_gen', 's_A'] }));
  assert.deepEqual(lastGap(b).related_source_ids, ['s_gen', 's_A']);
});

test('malformed / unknown / unclassified source -> dropped', async () => {
  const b = stub({ trainings: [
    T({ id: 's_unclass', knowledge_scope: 'unclassified' }),
    T({ id: 's_noscope', knowledge_scope: undefined }),
  ] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_unclass', 's_noscope', 's_missing_from_db'] }));
  assert.deepEqual(lastGap(b).related_source_ids, []);
});

// ==================================================================
// process inference: only from an in-scope related source
// ==================================================================

test('out-of-scope FIRST related source cannot provide operational_process_id', async () => {
  const b = stub({ trainings: [
    T({ id: 's_B', knowledge_scope: 'client-specific', client_id: 'B', operational_process_id: 'proc_B' }),
  ] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_B'] }));
  assert.equal(lastGap(b).operational_process_id ?? null, null);
  assert.deepEqual(lastGap(b).related_source_ids, []);
});

test('a later IN-SCOPE related source may provide operational_process_id', async () => {
  const b = stub({ trainings: [
    T({ id: 's_B', knowledge_scope: 'client-specific', client_id: 'B', operational_process_id: 'proc_B' }),
    T({ id: 's_gen_noproc' }), // in scope, but no process id
    T({ id: 's_A', knowledge_scope: 'client-specific', client_id: 'A', operational_process_id: 'proc_A' }),
  ] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_B', 's_gen_noproc', 's_A'] }));
  assert.equal(lastGap(b).operational_process_id, 'proc_A');
  assert.deepEqual(lastGap(b).related_source_ids, ['s_gen_noproc', 's_A']);
});

test('an explicit operationalProcessId is still honored and is not overridden by inference', async () => {
  const b = stub({ trainings: [T({ id: 's_gen', operational_process_id: 'proc_from_source' })] });
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s_gen'], operationalProcessId: 'proc_explicit' }));
  assert.equal(lastGap(b).operational_process_id, 'proc_explicit');
});

// ==================================================================
// existing dedupe / aggregation semantics unchanged
// ==================================================================

test('dedupe unchanged: same topic + same scope -> UPDATE (deduped), scoped ids unioned', async () => {
  const b = stub({ trainings: [T({ id: 's1' }), T({ id: 's2' })] });
  const r1 = await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s1'], reporterHmac: 'hA' }));
  assert.equal(r1.deduped, false);
  const r2 = await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s2'], reporterHmac: 'hB' }));
  assert.equal(r2.deduped, true);
  assert.equal(r2.knowledge_gap_id, r1.knowledge_gap_id);
  assert.equal(b.__store.KnowledgeGap.length, 1);
  assert.deepEqual(b.__store.KnowledgeGap[0].related_source_ids, ['s1', 's2']);
  assert.equal(b.__store.KnowledgeGap[0].times_asked, 2);
  assert.equal(b.__store.KnowledgeGap[0].distinct_reporters, 2);
});

test('dedupe unchanged: same topic, DIFFERENT scope -> new record, never merged', async () => {
  const b = stub({ trainings: [T({ id: 's_gen' }), T({ id: 's_A', knowledge_scope: 'client-specific', client_id: 'A' })] });
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s_gen'], reporterHmac: 'hA' }));
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_A'], reporterHmac: 'hA' }));
  assert.equal(b.__store.KnowledgeGap.length, 2);
  const byScope = Object.fromEntries(b.__store.KnowledgeGap.map((g) => [g.client_scope, g.related_source_ids]));
  assert.deepEqual(byScope['general'], ['s_gen']);
  assert.deepEqual(byScope['client:A'], ['s_A']);
});

test('dedupe unchanged: a client:B source offered to a client:A dedupe update is still dropped', async () => {
  const b = stub({ trainings: [T({ id: 's_A', knowledge_scope: 'client-specific', client_id: 'A' }), T({ id: 's_B', knowledge_scope: 'client-specific', client_id: 'B' })] });
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_A'], reporterHmac: 'hA' }));
  await aggregateGap(b, ev({ clientScope: 'client:A', relatedSourceIds: ['s_B'], reporterHmac: 'hB' }));
  assert.equal(b.__store.KnowledgeGap.length, 1);
  assert.deepEqual(b.__store.KnowledgeGap[0].related_source_ids, ['s_A']); // s_B never stored
  assert.equal(b.__store.KnowledgeGap[0].times_asked, 2); // aggregation still happened
});

test('no related sources at all -> no Training reads, gap still created', async () => {
  const b = stub();
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: [] }));
  assert.equal(b.__calls.trainingFilter, 0);
  assert.equal(b.__store.KnowledgeGap.length, 1);
  assert.deepEqual(lastGap(b).related_source_ids, []);
});

test('scope resolution uses ONE bounded $in read, never N+1 per-id gets', async () => {
  const b = stub({ trainings: [T({ id: 's1' }), T({ id: 's2' }), T({ id: 's3' })] });
  await aggregateGap(b, ev({ clientScope: 'general', relatedSourceIds: ['s1', 's2', 's3'] }));
  assert.equal(b.__calls.trainingFilter, 1);
  assert.equal(b.__calls.trainingGet, 0);
});

test('gapAggregation.ts still performs no write to Training / KnowledgeChunk / OperationalProcess', () => {
  const src = readFileSync(new URL('../../base44/shared/gapAggregation.ts', import.meta.url), 'utf8');
  assert.equal(/entities\.(Training|KnowledgeChunk|OperationalProcess)\.(create|update|delete)/.test(src), false);
});
