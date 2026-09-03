// Phase 6 — proof the lifecycle engine is genuinely reusable:
//   * driven end-to-end by in-memory FAKE adapters (no Base44, no MindVault),
//   * with a non-MindVault policy,
//   * and the engine source tree imports nothing from Base44 / MindVault.
//   node --test scripts/rag-eval/lifecycle-engine-reuse.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { makeHarness, staleFlag } from './_lifecycle_fakes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(HERE, '../../base44/shared/lifecycle');
const admin = { id: 'admin', role: 'admin' };

// ======================================================================
// coupling guard — the engine tree must be import-clean
// ======================================================================

test('lifecycle engine source imports nothing from Base44 SDK or MindVault modules', () => {
  const files = readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 7, 'expected the full engine module set');
  const BANNED = [
    '@base44/sdk', 'createClientFromRequest', 'Deno.',
    'shared/retrieval', 'shared/governance', 'shared/embeddings', 'shared/knowledgeGap',
    'shared/operationalAnswer', 'shared/extraction', 'shared/gapAggregation', 'shared/text',
    'shared/chunkLifecycle', 'shared/mindvaultLifecycle',
    'Training', 'KnowledgeChunk', 'OperationalProcess', 'askKnowledgeBase',
  ];
  for (const f of files) {
    const src = readFileSync(join(ENGINE_DIR, f), 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
    for (const line of importLines) {
      for (const b of BANNED) {
        assert.equal(line.includes(b), false, `${f}: import line couples to "${b}":\n  ${line.trim()}`);
      }
    }
    assert.equal(/\bDeno\.\w/.test(src), false, `${f} uses a Deno API`);
    assert.equal(/@base44\/sdk/.test(src), false, `${f} references the Base44 SDK`);
  }
});

// ======================================================================
// full lifecycle with fake adapters
// ======================================================================

test('end-to-end: edit -> pre-index -> approve -> publish, driven entirely by fakes', async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, 'v_1', (draft) => ({ ...draft }));
  assert.ok(cv.ok, JSON.stringify(cv));
  const draftId = cv.draftId;
  h.versions.get(draftId).__content = 'body-v2';

  const bi = await h.engine.buildDraftIndex(admin, draftId);
  assert.ok(bi.ok, JSON.stringify(bi));
  assert.equal(h.versions.get(draftId).indexState, 'indexed');
  assert.equal(h.versions.get(draftId).isActiveVersion, false, 'draft stays inactive after pre-index');
  assert.equal(staleFlag(h, draftId), false, 'draft units cleared after a clean pre-index');

  const vr = await h.engine.verify(admin, draftId);
  assert.ok(vr.ok);
  assert.equal(vr.displayState, 'verified');

  const act = await h.engine.activate(admin, draftId, { effectiveFromNow: false });
  assert.ok(act.ok, JSON.stringify(act));
  assert.equal(h.versions.get(draftId).isActiveVersion, true);
  assert.equal(h.versions.get('v_1').isActiveVersion, false, 'old version demoted');
  assert.equal(h.idx.get('v_1').units.length, 0, 'old units cleaned');
  assert.equal(staleFlag(h, draftId), false, 'new active units un-staled only at the end');
  assert.ok(h.audits.some((a) => a.code === 'VERSION_ACTIVATED'));
  assert.ok(h.audits.some((a) => a.code === 'VERSION_SUPERSEDED'));
  assert.ok(h.revisions.some((r) => r.operationId === act.operationId));
});

// ======================================================================
// SAFETY invariants
// ======================================================================

test('createVersion never mutates the active version and forks an unverified draft', async () => {
  const h = makeHarness();
  const before = JSON.stringify(h.versions.get('v_1'));
  const cv = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.ok(cv.ok);
  assert.equal(JSON.stringify(h.versions.get('v_1')), before, 'active v1 unchanged');
  assert.equal(h.versions.get(cv.draftId).verificationStatus, 'unverified');
  assert.equal(h.versions.get(cv.draftId).isActiveVersion, false);
});

test('a second open draft in the same lineage is refused', async () => {
  const h = makeHarness();
  assert.ok((await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }))).ok);
  const b = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.equal(b.ok, false);
  assert.equal(b.error, 'open_draft_exists');
});

test('non-admin actor is refused every write', async () => {
  const h = makeHarness();
  const emp = { id: 'e', role: 'user' };
  assert.equal((await h.engine.createVersion(emp, 'v_1', (d) => d)).ok, false);
  assert.equal((await h.engine.verify(emp, 'v_1')).ok, false);
  assert.equal((await h.engine.activate(emp, 'v_1')).ok, false);
});

test('activate refused for an unverified draft (human verification required before publish)', async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await h.engine.buildDraftIndex(admin, cv.draftId);
  const res = await h.engine.activate(admin, cv.draftId);
  assert.equal(res.ok, false);
  assert.equal(h.versions.get(cv.draftId).isActiveVersion, false);
  assert.equal(h.versions.get('v_1').isActiveVersion, true);
});

test('activate refused when the draft is not pre-indexed (successful pre-index is a precondition)', async () => {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await h.engine.verify(admin, cv.draftId);
  const res = await h.engine.activate(admin, cv.draftId);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'pre_index_required');
});
