// Phase 6 — MindVault BINDING: the content/metadata field classification, the
// Training <-> ResourceVersion mapping, and a full governed cycle driven
// through buildMindvaultLifecycle against an in-memory Base44 stub. Plus the
// new-entity schema contracts (append-only, no answer-like fields).
//   node --test scripts/rag-eval/source-lifecycle.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  classifyEdit,
  scopeKeyOf,
  trainingToVersion,
  versionPatchToTraining,
  MINDVAULT_CONTENT_FIELDS,
  MINDVAULT_INPLACE_METADATA_FIELDS,
  MINDVAULT_SUPERFICIAL_FIELDS,
  buildMindvaultLifecycle,
} from '../../base44/shared/mindvaultLifecycle.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readEntity = (n) => JSON.parse(readFileSync(resolve(repo, `base44/entities/${n}.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

// ======================================================================
// content vs metadata classification
// ======================================================================

test('classifyEdit: content fields fork; metadata fields restamp; mixed is refused', () => {
  assert.equal(classifyEdit({ summary: 'x' }), 'content');
  assert.equal(classifyEdit({ sop_steps: [] }), 'content');
  assert.equal(classifyEdit({ title: 'x' }), 'metadata'); // display-only rename -> in place
  assert.equal(classifyEdit({ title: 'x', summary: 'y' }), 'content'); // rename rides along on the draft
  assert.equal(classifyEdit({ title: 'x', department: 'd' }), 'metadata');
  assert.equal(classifyEdit({ effective_from: 'x' }), 'metadata');
  assert.equal(classifyEdit({ source_authority: 'policy' }), 'metadata');
  assert.equal(classifyEdit({ operational_process_id: 'p1' }), 'metadata');
  assert.equal(classifyEdit({ summary: 'x', effective_from: 'y' }), 'mixed');
  assert.equal(classifyEdit({ presenter: 'x' }), 'none'); // not governed
});

test('content and metadata field lists do not overlap; superficial fields are display-only', () => {
  const c = new Set(MINDVAULT_CONTENT_FIELDS);
  for (const m of MINDVAULT_INPLACE_METADATA_FIELDS) assert.equal(c.has(m), false, `${m} is in both lists`);
  // superficial fields stay on the content carry-list (drafts must copy them)
  for (const s of MINDVAULT_SUPERFICIAL_FIELDS) assert.equal(c.has(s), true, `${s} left the content carry-list`);
});

// ======================================================================
// Training <-> ResourceVersion mapping
// ======================================================================

test('trainingToVersion: missing values map to safe defaults (v1, active, unverified)', () => {
  const v = trainingToVersion({ id: 't1', title: 'x' });
  assert.equal(v.lineageId, 't1'); // missing root_source_id -> self
  assert.equal(v.versionNumber, 1);
  assert.equal(v.isActiveVersion, true); // missing is_active_version -> active
  assert.equal(v.verificationStatus, 'unverified');
  assert.equal(v.isArchived, false);
  assert.equal(v.lifecycleSeq, 0);
  assert.equal(v.scopeKey, 'unclassified:');
});

test('scopeKeyOf composes knowledge_scope + client_id', () => {
  assert.equal(scopeKeyOf({ knowledge_scope: 'general' }), 'general:');
  assert.equal(scopeKeyOf({ knowledge_scope: 'client-specific', client_id: 'C1' }), 'client-specific:C1');
});

test('versionPatchToTraining maps engine field names + splits scopeKey', () => {
  const t = versionPatchToTraining({
    isActiveVersion: true, verificationStatus: 'verified', reviewOutcome: null,
    verifiedBy: 'u1', changesRequestedNote: null, indexState: 'indexed',
    scopeKey: 'client-specific:C9',
    denorm: { source_authority: 'approved_sop' },
  });
  assert.equal(t.is_active_version, true);
  assert.equal(t.verification_status, 'verified');
  assert.equal(t.verified_by, 'u1');
  assert.equal(t.changes_requested_note, null);
  assert.equal(t.index_status, 'indexed');
  assert.equal(t.knowledge_scope, 'client-specific');
  assert.equal(t.client_id, 'C9');
  assert.equal(t.source_authority, 'approved_sop');
});

// ======================================================================
// full governed cycle through the binding + an in-memory Base44 stub
// ======================================================================

function stubBase44() {
  const store = { Training: new Map(), KnowledgeChunk: new Map(), KnowledgeLifecycleOperation: new Map(), KnowledgeRevision: [], AuditEvent: [], OperationalProcess: new Map(), AppConfig: new Map() };
  let n = 0;
  const coll = (name) => ({
    async get(id) { return store[name].get(id) ? { ...store[name].get(id) } : null; },
    async create(data) { const id = data.id || `${name}_${++n}`; const row = { ...data, id, created_date: new Date().toISOString() }; store[name].set ? store[name].set(id, row) : store[name].push(row); return { ...row }; },
    async update(id, patch) { const row = store[name].get(id); Object.assign(row, patch); return { ...row }; },
    async delete(id) { store[name].delete(id); },
    async filter(q) {
      const rows = store[name].set ? [...store[name].values()] : store[name];
      return rows.filter((r) => Object.entries(q).every(([k, val]) => {
        if (val && typeof val === 'object' && '$in' in val) return val.$in.includes(r[k]);
        return r[k] === val;
      }));
    },
  });
  const arrColl = (name) => ({
    async create(data) { const id = `${name}_${++n}`; const row = { ...data, id, created_date: new Date().toISOString() }; store[name].push(row); return { ...row }; },
    async filter(q) { return store[name].filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)); },
  });
  const entities = {
    Training: coll('Training'),
    KnowledgeChunk: coll('KnowledgeChunk'),
    KnowledgeLifecycleOperation: coll('KnowledgeLifecycleOperation'),
    KnowledgeRevision: arrColl('KnowledgeRevision'),
    AuditEvent: arrColl('AuditEvent'),
    OperationalProcess: coll('OperationalProcess'),
    AppConfig: coll('AppConfig'),
  };
  return { asServiceRole: { entities }, __store: store };
}

test('full governed cycle: fork draft -> pre-index -> verify -> activate; active v1 untouched until publish', async () => {
  const base44 = stubBase44();
  // seed an active, verified, indexed v1 with one chunk
  await base44.asServiceRole.entities.Training.create({
    id: 'T1', title: 'Bank rec SOP', summary: 'reconcile the bank statement monthly',
    knowledge_scope: 'general', status: 'ready', version_number: 1,
    is_active_version: true, verification_status: 'verified', index_status: 'indexed',
    indexed_version_number: 1, lifecycle_seq: 0,
  });
  await base44.asServiceRole.entities.KnowledgeChunk.create({
    id: 'T1c0', training_id: 'T1', content: 'reconcile the bank statement monthly', content_hash: 'h0',
    knowledge_scope: 'general', index_stale: null,
  });

  const { engine } = buildMindvaultLifecycle(base44);
  const admin = { id: 'admin', role: 'admin' };

  // edit content -> fork an unverified draft; v1 must be byte-unchanged
  const v1Before = JSON.stringify(base44.__store.Training.get('T1'));
  const cv = await engine.createVersion(admin, 'T1', (d) => ({ ...d, summary: 'reconcile the bank statement AND the sub-ledger monthly' }));
  assert.ok(cv.ok, JSON.stringify(cv));
  assert.equal(JSON.stringify(base44.__store.Training.get('T1')), v1Before, 'active v1 unchanged by createVersion');
  const draft = base44.__store.Training.get(cv.draftId);
  assert.equal(draft.is_active_version, false);
  assert.equal(draft.verification_status, 'unverified');
  assert.equal(draft.version_number, 2);
  assert.equal(draft.root_source_id, 'T1');

  const bi = await engine.buildDraftIndex(admin, cv.draftId);
  assert.ok(bi.ok, JSON.stringify(bi));
  assert.equal(base44.__store.Training.get(cv.draftId).index_status, 'indexed');
  // draft chunks exist but are inactive-version + not the active one
  const draftChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === cv.draftId);
  assert.ok(draftChunks.length >= 1);
  assert.equal(base44.__store.Training.get('T1').is_active_version, true, 'v1 still active during pre-index');

  const vr = await engine.verify(admin, cv.draftId);
  assert.ok(vr.ok);

  const act = await engine.activate(admin, cv.draftId);
  assert.ok(act.ok, JSON.stringify(act));
  assert.equal(base44.__store.Training.get(cv.draftId).is_active_version, true);
  assert.equal(base44.__store.Training.get('T1').is_active_version, false, 'v1 demoted');
  // old chunks cleaned; new chunks not stale
  const oldChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === 'T1');
  assert.equal(oldChunks.length, 0);
  const newChunks = [...base44.__store.KnowledgeChunk.values()].filter((c) => c.training_id === cv.draftId);
  assert.ok(newChunks.every((c) => c.index_stale !== true), 'new active chunks not stale after commit');
  // a completed revision + audit trail exist
  assert.ok(base44.__store.KnowledgeRevision.some((r) => r.operation_id === act.operationId));
  assert.ok(base44.__store.AuditEvent.some((a) => a.action === 'version_activated'));
});

test('metadata-only edit restamps the active version in place, verification unchanged', async () => {
  const base44 = stubBase44();
  await base44.asServiceRole.entities.Training.create({
    id: 'T2', title: 'x', summary: 'a body here', knowledge_scope: 'general', status: 'ready',
    is_active_version: true, verification_status: 'verified', version_number: 1, lifecycle_seq: 0,
    index_status: 'indexed',
  });
  await base44.asServiceRole.entities.KnowledgeChunk.create({
    id: 'T2c0', training_id: 'T2', content: 'a body here', content_hash: 'h', knowledge_scope: 'general',
  });
  const { engine } = buildMindvaultLifecycle(base44);
  const r = await engine.setMetadata({ id: 'admin', role: 'admin' }, 'T2', { effectiveFrom: '2026-01-01T00:00:00Z' });
  assert.ok(r.ok, JSON.stringify(r));
  const t = base44.__store.Training.get('T2');
  assert.equal(t.effective_from, '2026-01-01T00:00:00Z');
  assert.equal(t.verification_status, 'verified', 'metadata change does not reset verification');
  assert.equal(t.version_number, 1, 'no new version for a metadata change');
});

test('invalid effective window is refused at write time', async () => {
  const base44 = stubBase44();
  await base44.asServiceRole.entities.Training.create({
    id: 'T3', title: 'x', knowledge_scope: 'general', status: 'ready', is_active_version: true,
    verification_status: 'verified', version_number: 1, lifecycle_seq: 0,
  });
  const { engine } = buildMindvaultLifecycle(base44);
  const r = await engine.setMetadata({ id: 'admin', role: 'admin' }, 'T3', {
    effectiveFrom: '2027-01-01T00:00:00Z', effectiveUntil: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_effective_window');
});

// ======================================================================
// new-entity schema contracts
// ======================================================================

test('KnowledgeRevision + KnowledgeLifecycleOperation: admin-only RLS, no answer-like fields', () => {
  for (const name of ['KnowledgeRevision', 'KnowledgeLifecycleOperation']) {
    const s = readEntity(name);
    for (const op of ['create', 'read', 'update', 'delete']) {
      assert.deepEqual(s.rls[op], { user_condition: { role: 'admin' } }, `${name}.rls.${op}`);
    }
    const src = JSON.stringify(s);
    assert.equal(/proposed_answer|corrected_answer|answer_text|correct_text/.test(src), false, `${name} must carry no answer-like field`);
  }
});

test('KnowledgeRevision is append-only by contract: no Phase 6 function updates/deletes it', () => {
  const fns = [
    'reviewKnowledgeSource', 'updateKnowledgeSource', 'reindexKnowledgeSource',
    'reconcileSourceLifecycle', 'computeSourceFreshness', 'listKnowledgeSourceHistory',
  ];
  for (const f of fns) {
    const src = readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), 'utf8');
    assert.equal(/KnowledgeRevision\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete KnowledgeRevision`);
    assert.equal(/AuditEvent\.(update|delete)\s*\(/.test(src), false, `${f} must not update/delete AuditEvent`);
  }
});

test('the engine never writes AuditEvent.update/delete or KnowledgeRevision.update/delete', () => {
  const eng = readFileSync(resolve(repo, 'base44/shared/lifecycle/engine.ts'), 'utf8');
  assert.equal(/appendAudit|appendRevision/.test(eng), true, 'engine appends audit/revision records');
  assert.equal(/\.(update|delete)Audit|updateRevision|deleteRevision/.test(eng), false);
});

// ======================================================================
// no employee / AI auto-promotion — verification & active flags are only
// ever written through the governed lifecycle path
// ======================================================================

const VERIF_WRITE = /verification_status\s*[:=]\s*['"](verified|rejected)['"]|is_active_version\s*[:=]\s*true/;

test('Phase 5 + analyzeTraining never set verification_status verified/rejected or is_active_version true', () => {
  const files = [
    'base44/functions/submitKnowledgeFeedback/entry.ts',
    'base44/functions/logKnowledgeGap/entry.ts',
    'base44/functions/reviewKnowledgeGap/entry.ts',
    'base44/functions/respondToClarification/entry.ts',
    'base44/functions/replyToClarification/entry.ts',
    'base44/shared/gapAggregation.ts',
  ];
  for (const f of files) {
    const src = readFileSync(resolve(repo, f), 'utf8');
    assert.equal(VERIF_WRITE.test(src), false, `${f} must not promote content (verification/active flags)`);
  }
});

test('analyzeTraining guards SERVED governed sources (state-based, both flag values) and sets no verification/active flags', () => {
  const src = readFileSync(resolve(repo, 'base44/functions/analyzeTraining/entry.ts'), 'utf8');
  assert.ok(src.includes('classifyReanalysisTarget'), 'analyzeTraining must decide from served STATE');
  assert.ok(src.includes('governed_source') && src.includes('lifecycle_disabled'), 'refuses in BOTH flag states');
  assert.equal(VERIF_WRITE.test(src), false, 'analyzeTraining must not set verification/active flags itself');
  // full state-based coverage lives in scripts/rag-eval/reanalysis-guard.test.mjs
});

test('only reviewKnowledgeSource / updateKnowledgeSource reach the lifecycle engine', () => {
  const build = 'buildMindvaultLifecycle';
  const users = [
    'reviewKnowledgeSource', 'updateKnowledgeSource', 'reindexKnowledgeSource',
    'reconcileSourceLifecycle', 'listKnowledgeSourceHistory',
  ];
  for (const f of users) {
    assert.ok(
      readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), 'utf8').includes(build),
      `${f} should construct the engine via the binding`,
    );
  }
  // employee / gap / feedback functions must NOT
  for (const f of ['submitKnowledgeFeedback', 'logKnowledgeGap', 'askKnowledgeBaseV2']) {
    assert.equal(
      readFileSync(resolve(repo, `base44/functions/${f}/entry.ts`), 'utf8').includes(build),
      false,
      `${f} must not touch the lifecycle engine`,
    );
  }
});