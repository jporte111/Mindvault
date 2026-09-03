// Phase 6 — activation-operation RECONCILIATION is stage-aware, deterministic,
// and NEVER regenerates content once the cutover has begun. Specifically:
//   * cutover_cleanup recovery cleans op.priorActiveVersionId, NEVER the target
//   * no activation-recovery path calls worker.build()
//   * cutover_stale_clear recovery re-establishes full stale first, then clears
//   * half-applied cutover_flip / cutover_stalemark deterministically roll back
//   node --test scripts/rag-eval/reconcile-activation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeHarness, staleFlag } from './_lifecycle_fakes.mjs';

const admin = { id: 'admin', role: 'admin' };
const ENGINE_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../base44/shared/lifecycle/engine.ts'),
  'utf8',
);

// ---------------------------------------------------------------------------
// static guards (would fail against the old generic-resume code)
// ---------------------------------------------------------------------------

test('the activation-recovery helpers contain NO worker.build() call', () => {
  const start = ENGINE_SRC.indexOf('activation-operation recovery (NEVER generates)');
  const end = ENGINE_SRC.indexOf('// --- public API');
  assert.ok(start > -1 && end > start);
  const region = ENGINE_SRC.slice(start, end);
  assert.ok(/function recoverActivation/.test(region));
  assert.ok(/function completeActivationForward/.test(region));
  assert.ok(/function rollbackActivation/.test(region));
  assert.equal(/worker\.build\s*\(/.test(region), false,
    'no activation-recovery helper may regenerate content');
});

test('reconcile routes activate/supersede through recoverActivation BEFORE the generic (build-capable) branch', () => {
  const rc = ENGINE_SRC.slice(ENGINE_SRC.indexOf('async reconcile('));
  const routeIdx = rc.search(/op\.action === "activate" \|\| op\.action === "supersede"/);
  const genericBuildIdx = rc.indexOf('await worker.build(target)');
  assert.ok(routeIdx > -1, 'activation route present');
  assert.ok(genericBuildIdx > routeIdx, 'the only reconcile worker.build is AFTER the activation route');
  // and the activation route continues out of the loop
  const routeBlock = rc.slice(routeIdx, routeIdx + 300);
  assert.ok(/recoverActivation\(op\)/.test(routeBlock) && /continue;/.test(routeBlock));
});

test("completeActivationForward cleans op.priorActiveVersionId, never op.targetVersionId", () => {
  const fn = ENGINE_SRC.slice(
    ENGINE_SRC.indexOf('async function completeActivationForward'),
    ENGINE_SRC.indexOf('async function rollbackActivation'),
  );
  assert.ok(/if \(prior\) await worker\.cleanup\(prior\)/.test(fn), 'cleans the prior-active version');
  assert.equal(/worker\.cleanup\(target\)/.test(fn), false, 'must NEVER clean the target/new version');
});

// Build a two-version lineage: v_1 (prior active, has units) + a verified,
// pre-indexed draft. Returns { h, draftId } with the draft NOT yet activated.
async function verifiedDraft(content = 'body-v2') {
  const h = makeHarness();
  const cv = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  h.versions.get(cv.draftId).__content = content;
  await h.engine.buildDraftIndex(admin, cv.draftId);
  await h.engine.verify(admin, cv.draftId);
  return { h, draftId: cv.draftId };
}

// Snapshot the fake's call counters, run reconcile, return the deltas.
async function reconcileAndMeasure(h) {
  const buildBefore = h.flags.buildCount || 0;
  const cleanupBefore = (h.flags.cleanupTargets || []).length;
  const restampBefore = (h.flags.restampTargets || []).length;
  const rec = await h.engine.reconcile(admin);
  return {
    rec,
    buildDelta: (h.flags.buildCount || 0) - buildBefore,
    cleanupDuringReconcile: (h.flags.cleanupTargets || []).slice(cleanupBefore),
    restampDuringReconcile: (h.flags.restampTargets || []).slice(restampBefore),
  };
}

function activationOp(h) {
  return [...h.operations.values()].find((o) => o.action === 'activate');
}

// ---------------------------------------------------------------------------
// Problem 1 — cutover_cleanup must clean the PRIOR-ACTIVE version, not target
// ---------------------------------------------------------------------------

test('activation fails at cutover_cleanup -> reconcile deletes ONLY prior-active units; new-active units survive & are retrievable', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.failCleanup = true;
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);

  const op = activationOp(h);
  // explicit old/new identity
  assert.equal(op.targetVersionId, draftId, 'targetVersionId = NEW version');
  assert.equal(op.priorActiveVersionId, 'v_1', 'priorActiveVersionId = OLD version');
  assert.equal(op.failureStage, 'cutover_cleanup');

  h.flags.failCleanup = false;
  const m = await reconcileAndMeasure(h);

  // cleanup during reconcile touched ONLY the prior-active version
  assert.ok(m.cleanupDuringReconcile.length >= 1, 'reconcile ran cleanup');
  assert.ok(m.cleanupDuringReconcile.every((id) => id === 'v_1'),
    `cleanup during reconcile hit ${JSON.stringify(m.cleanupDuringReconcile)} — must be only v_1`);
  assert.equal(m.cleanupDuringReconcile.includes(draftId), false, 'reconcile must NEVER clean the target/new version');

  // zero generation
  assert.equal(m.buildDelta, 0, 'reconcile of an activation must not call worker.build()');

  // new-active units intact and retrievable
  assert.ok(h.idx.get(draftId).units.length > 0, 'new-active units still exist');
  assert.equal(staleFlag(h, draftId), false, 'new-active units un-staled -> retrievable');
  assert.equal(h.idx.get('v_1').units.length, 0, 'prior-active units removed');
  assert.equal(activationOp(h).status, 'completed');
});

// ---------------------------------------------------------------------------
// Problem 2 — no activation recovery path regenerates content
// ---------------------------------------------------------------------------

test('activation fails at cutover_restamp -> reconcile uses restamp on the NEW version, zero build calls', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.failRestamp = true;
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  const op = activationOp(h);
  assert.equal(op.failureStage, 'cutover_restamp');
  assert.equal(op.targetVersionId, draftId);
  assert.equal(op.priorActiveVersionId, 'v_1');

  h.flags.failRestamp = false;
  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0);
  assert.ok(m.restampDuringReconcile.includes(draftId), 'restamp targeted the NEW version');
  assert.equal(m.restampDuringReconcile.includes('v_1'), false, 'restamp did not touch the prior version');
  assert.equal(activationOp(h).status, 'completed');
  assert.equal(staleFlag(h, draftId), false);
});

test('activation fails at verify -> reconcile uses only restamp/cleanup/verify/stale-clear, zero build calls', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.forceMismatch = true; // cutover verify sees a mismatch
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  const op = activationOp(h);
  assert.equal(op.failureStage, 'verify');

  h.flags.forceMismatch = false;
  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0, 'verify-failure recovery must not regenerate');
  assert.ok(m.restampDuringReconcile.includes(draftId), 'restamp of the new version');
  assert.ok(m.cleanupDuringReconcile.every((id) => id === 'v_1'), 'cleanup only of the prior version');
  assert.equal(activationOp(h).status, 'completed');
});

test('activation fails at cutover_stale_clear -> reconcile re-establishes FULL stale before retrying the clear; zero build calls', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.failStaleClear = true;
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  const op = activationOp(h);
  assert.equal(op.failureStage, 'cutover_stale_clear');
  // new units are stale (clear failed) — fail-closed
  assert.equal(staleFlag(h, draftId), true);

  h.flags.failStaleClear = false;
  const markBefore = (h.flags.markStaleTargets || []).length;
  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0);
  // recovery re-marked the NEW version stale (fully fail-closed) BEFORE clearing
  const markDuring = (h.flags.markStaleTargets || []).slice(markBefore);
  assert.ok(markDuring.includes(draftId), 'recovery re-established full stale on the new version first');
  assert.equal(staleFlag(h, draftId), false, 'units cleared only after a clean verify');
  assert.equal(activationOp(h).status, 'completed');
  assert.ok(h.idx.get(draftId).units.length > 0);
});

// ---------------------------------------------------------------------------
// half-applied flip / stalemark -> deterministic rollback (no build)
// ---------------------------------------------------------------------------

test('activation fails at cutover_flip -> reconcile ROLLS BACK to the recorded prior-active, no build, prior units retrievable', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.staleWriteOnce = true; // the flip write sees a moved seq
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  const op = activationOp(h);
  assert.equal(op.failureStage, 'cutover_flip');
  assert.equal(op.targetVersionId, draftId);
  assert.equal(op.priorActiveVersionId, 'v_1');

  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0, 'rollback must not regenerate');
  assert.equal(m.cleanupDuringReconcile.length, 0, 'rollback does not cleanup (old units still needed)');
  // prior active restored & retrievable; new version parked inactive+pending
  assert.equal(h.versions.get('v_1').isActiveVersion, true, 'prior-active restored');
  assert.equal(h.versions.get(draftId).isActiveVersion, false, 'failed new version demoted');
  assert.equal(h.versions.get(draftId).indexState, 'pending');
  assert.ok(h.idx.get('v_1').units.length > 0, 'prior units still present');
  assert.equal(staleFlag(h, 'v_1'), false, 'prior units un-staled -> retrievable again');
  assert.equal(activationOp(h).status, 'completed');
});

test('activation fails at cutover_stalemark -> reconcile rolls back deterministically, no build', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.failStaleMark = true;
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  const op = activationOp(h);
  assert.equal(op.failureStage, 'cutover_stalemark');
  assert.equal(op.targetVersionId, draftId);
  assert.equal(op.priorActiveVersionId, 'v_1');

  h.flags.failStaleMark = false;
  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0);
  assert.equal(h.versions.get('v_1').isActiveVersion, true);
  assert.ok(h.idx.get('v_1').units.length > 0);
  assert.equal(staleFlag(h, 'v_1'), false);
  assert.equal(activationOp(h).status, 'completed');
});

// ---------------------------------------------------------------------------
// parametrized: ZERO build calls for EVERY post-cutover failure stage
// ---------------------------------------------------------------------------

const STAGE_INJECTORS = {
  cutover_stalemark: (h) => { h.flags.failStaleMark = true; },
  cutover_flip: (h) => { h.flags.staleWriteOnce = true; },
  cutover_restamp: (h) => { h.flags.failRestamp = true; },
  cutover_cleanup: (h) => { h.flags.failCleanup = true; },
  verify: (h) => { h.flags.forceMismatch = true; },
  cutover_stale_clear: (h) => { h.flags.failStaleClear = true; },
};
const CLEAR_INJECTORS = {
  cutover_stalemark: (h) => { h.flags.failStaleMark = false; },
  cutover_flip: (h) => { h.flags.staleWriteOnce = false; },
  cutover_restamp: (h) => { h.flags.failRestamp = false; },
  cutover_cleanup: (h) => { h.flags.failCleanup = false; },
  verify: (h) => { h.flags.forceMismatch = false; },
  cutover_stale_clear: (h) => { h.flags.failStaleClear = false; },
};

for (const stage of Object.keys(STAGE_INJECTORS)) {
  test(`reconcile of an activation that failed at ${stage}: total worker.build() calls = 0, identity asserted`, async () => {
    const { h, draftId } = await verifiedDraft();
    STAGE_INJECTORS[stage](h);
    const act = await h.engine.activate(admin, draftId);
    assert.equal(act.ok, false, `activate should fail at ${stage}`);
    const op = activationOp(h);
    assert.equal(op.failureStage, stage, `op.failureStage`);
    // explicit old/new identity in every fixture
    assert.equal(op.targetVersionId, draftId, 'target = NEW version');
    assert.equal(op.priorActiveVersionId, 'v_1', 'prior = OLD version');

    CLEAR_INJECTORS[stage](h);
    const m = await reconcileAndMeasure(h);
    assert.equal(m.buildDelta, 0, `reconcile of ${stage} must not call worker.build()`);
    // cleanup, if any, only ever the prior-active version
    assert.ok(m.cleanupDuringReconcile.every((id) => id === 'v_1'),
      `${stage}: cleanup during reconcile = ${JSON.stringify(m.cleanupDuringReconcile)}`);
    assert.equal(m.cleanupDuringReconcile.includes(draftId), false, `${stage}: never clean the target`);
  });
}

// ---------------------------------------------------------------------------
// no deterministic recovery -> fail closed
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// terminal governance history — recovery must match a normal activation
// ---------------------------------------------------------------------------

const auditsOf = (h, code) => h.audits.filter((a) => a.code === code);
// terminal publication records are scoped to the activation OPERATION — earlier
// lifecycle steps (createVersion / buildDraftIndex / verify) also write their
// own revisions for the same version, which is expected and unrelated.
const opAuditsOf = (h, opId, code) => h.audits.filter((a) => a.code === code && a.operationId === opId);
const opRevs = (h, opId) => h.revisions.filter((r) => r.operationId === opId);

async function recoverFrom(stage, inject, clear) {
  const { h, draftId } = await verifiedDraft();
  inject(h);
  const act = await h.engine.activate(admin, draftId);
  assert.equal(act.ok, false);
  assert.equal(activationOp(h).failureStage, stage);
  clear(h);
  const rec = await h.engine.reconcile(admin);
  return { h, draftId, rec };
}

test('recovered cutover_restamp activation produces EXACTLY ONE VERSION_ACTIVATED audit', async () => {
  const { h, draftId } = await recoverFrom('cutover_restamp',
    (x) => { x.flags.failRestamp = true; }, (x) => { x.flags.failRestamp = false; });
  const opId = activationOp(h).operationId;
  const va = opAuditsOf(h, opId, 'VERSION_ACTIVATED');
  assert.equal(va.length, 1, `expected 1 VERSION_ACTIVATED for this activation, got ${va.length}`);
  assert.equal(va[0].versionId, draftId);
  assert.equal(activationOp(h).status, 'completed');
});

test('recovered activation produces EXACTLY ONE VERSION_SUPERSEDED audit when a prior active exists', async () => {
  const { h } = await recoverFrom('cutover_restamp',
    (x) => { x.flags.failRestamp = true; }, (x) => { x.flags.failRestamp = false; });
  const opId = activationOp(h).operationId;
  const vs = opAuditsOf(h, opId, 'VERSION_SUPERSEDED');
  assert.equal(vs.length, 1);
  assert.equal(vs[0].versionId, 'v_1', 'superseded event is on the PRIOR-active version');
});

test('recovered activation produces EXACTLY ONE completed KnowledgeRevision for the activation operation', async () => {
  const { h } = await recoverFrom('verify',
    (x) => { x.flags.forceMismatch = true; }, (x) => { x.flags.forceMismatch = false; });
  const op = activationOp(h);
  const revs = opRevs(h, op.operationId);
  assert.equal(revs.length, 1, `expected 1 revision for op ${op.operationId}, got ${revs.length}`);
  assert.equal(revs[0].versionId, op.targetVersionId);
  assert.equal(revs[0].previousVersionId, 'v_1');
  assert.equal(revs[0].versionNumber, 2);
});

test('retrying reconcile does NOT duplicate VERSION_ACTIVATED / VERSION_SUPERSEDED / the revision', async () => {
  const { h } = await recoverFrom('cutover_cleanup',
    (x) => { x.flags.failCleanup = true; }, (x) => { x.flags.failCleanup = false; });
  const opId = activationOp(h).operationId;
  assert.equal(activationOp(h).status, 'completed');

  // force the SAME completed activation operation back through reconcile twice
  for (let i = 0; i < 2; i++) {
    const op = activationOp(h);
    op.status = 'failed';
    op.resumeCount = 0;
    await h.engine.reconcile(admin);
  }

  assert.equal(opAuditsOf(h, opId, 'VERSION_ACTIVATED').length, 1, 'no duplicate VERSION_ACTIVATED');
  assert.equal(opAuditsOf(h, opId, 'VERSION_SUPERSEDED').length, 1, 'no duplicate VERSION_SUPERSEDED');
  assert.equal(opRevs(h, opId).length, 1, 'no duplicate revision');
  assert.equal(opAuditsOf(h, opId, 'LIFECYCLE_RECONCILED').length, 1, 'LIFECYCLE_RECONCILED not duplicated either');
});

test('normal activation and recovered activation produce EQUIVALENT terminal governance history (+ recovery adds LIFECYCLE_RECONCILED)', async () => {
  // normal
  const n = await verifiedDraft();
  const nAct = await n.h.engine.activate(admin, n.draftId);
  assert.ok(nAct.ok);
  // recovered (failed at cutover_restamp, then reconciled forward)
  const r = await recoverFrom('cutover_restamp',
    (x) => { x.flags.failRestamp = true; }, (x) => { x.flags.failRestamp = false; });

  const summarize = (h) => {
    const opId = activationOp(h).operationId;
    return {
      activated: opAuditsOf(h, opId, 'VERSION_ACTIVATED').map((a) => a.versionId.replace(/^v_\d+$/, 'NEW')),
      superseded: opAuditsOf(h, opId, 'VERSION_SUPERSEDED').map((a) => a.versionId),
      revision: opRevs(h, opId).map((x) => ({
        vN: x.versionNumber, prev: x.previousVersionId, prevN: x.previousVersionNumber, src: x.changeSource,
      })),
      reconciled: opAuditsOf(h, opId, 'LIFECYCLE_RECONCILED').length,
    };
  };
  const N = summarize(n.h);
  const R = summarize(r.h);

  assert.deepEqual(N.activated, ['NEW']);
  assert.deepEqual(R.activated, ['NEW']);
  assert.deepEqual(N.superseded, ['v_1']);
  assert.deepEqual(R.superseded, ['v_1']);
  assert.deepEqual(N.revision, R.revision, 'the completed revision is equivalent');
  // the ONLY difference: recovery adds a LIFECYCLE_RECONCILED event
  assert.equal(N.reconciled, 0, 'normal path has no reconcile event');
  assert.equal(R.reconciled, 1, 'recovered path records exactly one extra event');
});

test('unexpected exception DURING activation recovery -> full lineage stale + needs_manual_reconciliation surfaced', async () => {
  const { h, draftId } = await verifiedDraft();
  h.flags.failCleanup = true;
  await h.engine.activate(admin, draftId);            // fails at cutover_cleanup
  assert.equal(activationOp(h).failureStage, 'cutover_cleanup');

  // now make the RECOVERY throw unexpectedly (restamp blows up mid-recovery)
  h.flags.failCleanup = false;
  h.flags.failRestamp = true;
  const buildBefore = h.flags.buildCount || 0;
  const rec = await h.engine.reconcile(admin);

  assert.equal((h.flags.buildCount || 0) - buildBefore, 0, 'recovery still calls no build');
  assert.ok(rec.manual >= 1, 'surfaced as manual, not silently failed');
  assert.ok(h.manualFlags.length >= 1, 'lineage flagged needs_manual_reconciliation');
  assert.ok(auditsOf(h, 'NEEDS_MANUAL_RECONCILIATION').length >= 1);
  assert.equal(staleFlag(h, 'v_1'), true, 'prior units stale');
  assert.equal(staleFlag(h, draftId), true, 'new units stale — fully fail-closed');
  assert.equal(activationOp(h).status, 'failed');
});

test('activation with no prior active (first activation of a lineage) that fails at flip -> fail closed, no build', async () => {
  const h = makeHarness();
  // make v_1 an inactive, verified, pre-indexed DRAFT that is the lineage root
  h.versions.get('v_1').isActiveVersion = false;
  h.versions.get('v_1').verificationStatus = 'verified';
  h.versions.get('v_1').indexState = 'indexed';
  h.versions.get('v_1').indexedVersionNumber = 1;
  h.idx.get('v_1').units[0].projection.is_active_version = 'false';
  h.flags.staleWriteOnce = true;
  const act = await h.engine.activate(admin, 'v_1');
  assert.equal(act.ok, false);
  const op = [...h.operations.values()].find((o) => o.action === 'activate');
  assert.equal(op.priorActiveVersionId, null, 'no prior active');

  h.flags.staleWriteOnce = false;
  const m = await reconcileAndMeasure(h);
  assert.equal(m.buildDelta, 0);
  assert.ok(m.rec.manual >= 1, 'no deterministic recovery -> manual');
  assert.ok(h.manualFlags.length >= 1, 'lineage flagged for manual reconciliation');
});
