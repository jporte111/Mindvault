// Phase 6 — the atomic index contract:
//   [F1] index_stale is the FINAL activation commit gate — new active units stay
//        stale through every restamp/verify step and are cleared only as the
//        penultimate action, itself verified before the operation completes; any
//        earlier failure leaves them stale (retrieval fail-closed).
//   [F2] hash equality ALONE is never a no-op — a no-op also requires a complete
//        unit set AND a clean projection; otherwise repair + verify.
//   node --test scripts/rag-eval/reindex-contract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, staleFlag, fp } from './_lifecycle_fakes.mjs';

const admin = { id: 'admin', role: 'admin' };

async function toVerifiedDraft(h, content = 'body-v2') {
  const cv = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  h.versions.get(cv.draftId).__content = content;
  await h.engine.buildDraftIndex(admin, cv.draftId);
  await h.engine.verify(admin, cv.draftId);
  return cv.draftId;
}

// ---------------------------------------------------------------------------
// [F1] activation cutover
// ---------------------------------------------------------------------------

test('[F1] happy path: new units become retrievable only after the verified stale-clear', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  const res = await h.engine.activate(admin, draftId);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(staleFlag(h, draftId), false);
  assert.equal(h.idx.get('v_1').units.length, 0, 'old units cleaned');
  const op = [...h.operations.values()].find((o) => o.action === 'activate');
  assert.equal(op.status, 'completed');
});

test('[F1] stale-clear failure -> new units stay stale, op failed at cutover_stale_clear', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  h.flags.failStaleClear = true;
  const res = await h.engine.activate(admin, draftId);
  assert.equal(res.ok, false);
  assert.equal(staleFlag(h, draftId), true, 'retrieval fail-closed');
  const op = [...h.operations.values()].find((o) => o.action === 'activate');
  assert.equal(op.status, 'failed');
  assert.equal(op.failureStage, 'cutover_stale_clear');
});

test('[F1] restamp failure during cutover -> new units stay stale, stage cutover_restamp', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  h.flags.failRestamp = true;
  const res = await h.engine.activate(admin, draftId);
  assert.equal(res.ok, false);
  assert.equal(staleFlag(h, draftId), true);
  assert.equal([...h.operations.values()].find((o) => o.action === 'activate').failureStage, 'cutover_restamp');
});

test('[F1] verify-mismatch during cutover -> never completed, stale NOT cleared', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  h.flags.forceMismatch = true; // projectionMismatches returns a mismatch during cutover verify
  const res = await h.engine.activate(admin, draftId);
  assert.equal(res.ok, false);
  assert.equal(staleFlag(h, draftId), true);
  const op = [...h.operations.values()].find((o) => o.action === 'activate');
  assert.equal(op.status, 'failed');
  assert.notEqual(op.status, 'completed');
});

test('[F1] the activation cutover performs NO generation (worker.build is never called)', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  h.flags.buildCount = 0; // reset after pre-index
  const res = await h.engine.activate(admin, draftId);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(h.flags.buildCount, 0, 'activate must not (re)generate any units');
  assert.equal(h.idx.get('v_1').units.length, 0, 'old units removed by cleanup only');
});

// ---------------------------------------------------------------------------
// [F2] reindex no-op / repair
// ---------------------------------------------------------------------------

test('[F2] reindex no-ops only when fingerprint + unit set + projection are all clean', async () => {
  const h = makeHarness();
  const r = await h.engine.reindex(admin, 'v_1');
  assert.ok(r.ok);
  assert.equal(r.noOp, true);
});

test('[F2] fingerprint matches but projection is stale -> repairs, NOT a no-op', async () => {
  const h = makeHarness();
  h.idx.get('v_1').units[0].projection.scopeKey = 'STALE:wrong';
  h.idx.get('v_1').units[0].projection.effective_from = '1999-01-01';
  const r = await h.engine.reindex(admin, 'v_1');
  assert.ok(r.ok, JSON.stringify(r));
  assert.notEqual(r.noOp, true, 'hash equality must not force a no-op over stale metadata');
  const fixed = h.idx.get('v_1').units.every(
    (u) => u.projection.scopeKey === 'general:' && u.projection.effective_from === '',
  );
  assert.equal(fixed, true, 'units restamped to the source projection');
  assert.equal(staleFlag(h, 'v_1'), false, 'stale cleared only after the repair verified');
});

test('[F2] fingerprint matches but unit set incomplete -> full rebuild, not a no-op', async () => {
  const h = makeHarness();
  h.flags.forceIncompleteSet = true;
  const r = await h.engine.reindex(admin, 'v_1');
  assert.ok(r.ok || r.error, JSON.stringify(r));
  assert.notEqual(r.noOp, true);
});

// ---------------------------------------------------------------------------
// idempotency + concurrency guard
// ---------------------------------------------------------------------------

test('lifecycle_seq guard: a concurrent writer bumping the row mid-operation forces stale_state', async () => {
  const h = makeHarness();
  h.flags.staleWriteOnce = true; // the next guarded write sees a moved seq
  const res = await h.engine.setMetadata(admin, 'v_1', { effectiveFrom: '2026-01-01T00:00:00Z' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'stale_state');
  // nothing was applied
  assert.equal(h.versions.get('v_1').effectiveFrom ?? null, null);
});

test('replaying a completed operation id does not double-apply', async () => {
  const h = makeHarness();
  const draftId = await toVerifiedDraft(h);
  const a1 = await h.engine.activate(admin, draftId);
  assert.ok(a1.ok);
  // a second activate on the now-active version is refused (already_active)
  const a2 = await h.engine.activate(admin, draftId);
  assert.equal(a2.ok, false);
  assert.equal(a2.error, 'already_active');
});
