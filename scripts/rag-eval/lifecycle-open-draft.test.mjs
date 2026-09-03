// Phase 6 hotfix — regression tests for open-draft detection.
//
// BUG: createVersion detected an open draft with merely
//   !isActiveVersion && !isArchived && verificationStatus !== "rejected".
// After publishing v2, the demoted v1 stays inactive + non-archived +
// non-rejected forever, so it was falsely treated as the lineage's open
// draft — blocking every later edit (no v3 could ever be created).
//
// FIX: stateMachine.isOpenDraftCandidate — workflow state (draft /
// in_review / changes_requested / verified-pending) PLUS the lineage fact
// that no active version in the lineage is newer. Superseded history never
// blocks the next draft.
//   node --test scripts/rag-eval/lifecycle-open-draft.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './_lifecycle_fakes.mjs';
import {
  deriveLifecycleState,
  isOpenDraftCandidate,
} from '../../base44/shared/lifecycle/stateMachine.ts';

const admin = { id: 'admin', role: 'admin' };
const lineageOf = (h) => [...h.versions.values()].filter((v) => v.lineageId === 'lin_1');

// The full publish pipeline a draft must pass: pre-index -> verify -> activate.
async function publish(h, draftId) {
  assert.ok((await h.engine.buildDraftIndex(admin, draftId)).ok, 'pre-index failed');
  assert.ok((await h.engine.verify(admin, draftId)).ok, 'verify failed');
  assert.ok((await h.engine.activate(admin, draftId, { effectiveFromNow: false })).ok, 'activate failed');
}

test('v1 active -> create v2 draft -> verify -> activate v2 -> create v3 draft succeeds', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.ok(cv2.ok, JSON.stringify(cv2));
  await publish(h, cv2.draftId);
  assert.equal(h.versions.get(cv2.draftId).isActiveVersion, true, 'v2 is active');
  assert.equal(h.versions.get('v_1').isActiveVersion, false, 'v1 demoted');

  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.ok(cv3.ok, JSON.stringify(cv3));
  assert.equal(h.versions.get(cv3.draftId).versionNumber, 3, 'forked draft is v3');
  assert.equal(h.versions.get(cv3.draftId).isActiveVersion, false);
});

test('v1 after supersession does not match open-draft detection (workflow-looking fields, historical row)', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId);

  const v1 = h.versions.get('v_1');
  const lineage = lineageOf(h);
  // The trap: v1's own fields still look like an editable workflow version…
  assert.equal(v1.isActiveVersion, false);
  assert.equal(v1.isArchived, false);
  assert.equal(v1.verificationStatus, 'verified');
  assert.equal(deriveLifecycleState(v1), 'verified');
  // …but it is superseded history and must NOT be detected as an open draft.
  assert.equal(isOpenDraftCandidate(v1, lineage), false);
  // Same for an unverified predecessor (derives 'draft' row-locally).
  const v1unverified = { ...v1, verificationStatus: 'unverified', reviewRequestedAt: null };
  assert.equal(deriveLifecycleState(v1unverified), 'draft');
  assert.equal(isOpenDraftCandidate(v1unverified, lineage), false);
});

test('a real inactive v3 draft blocks creating v4', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId);
  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.ok(cv3.ok, JSON.stringify(cv3));

  const again = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.equal(again.ok, false);
  assert.equal(again.error, 'open_draft_exists');
  assert.equal(again.draftId, cv3.draftId, 'points at the real open draft');
});

test('a v3 draft in in_review blocks creating v4', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId);
  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.ok((await h.engine.submit(admin, cv3.draftId)).ok, 'submit failed');

  const again = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.equal(again.ok, false);
  assert.equal(again.error, 'open_draft_exists');
  assert.equal(again.draftId, cv3.draftId);
});

test('a v3 draft in changes_requested blocks creating v4', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId);
  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.ok((await h.engine.submit(admin, cv3.draftId)).ok, 'submit failed');
  assert.ok((await h.engine.requestChanges(admin, cv3.draftId, 'tighten this')).ok, 'request_changes failed');

  const again = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.equal(again.ok, false);
  assert.equal(again.error, 'open_draft_exists');
  assert.equal(again.draftId, cv3.draftId);
});

test('a verified-but-not-yet-activated v3 blocks creating v4', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId);
  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.ok((await h.engine.buildDraftIndex(admin, cv3.draftId)).ok, 'pre-index failed');
  assert.ok((await h.engine.verify(admin, cv3.draftId)).ok, 'verify failed');
  assert.equal(h.versions.get(cv3.draftId).isActiveVersion, false, 'still inactive');

  const again = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  assert.equal(again.ok, false);
  assert.equal(again.error, 'open_draft_exists');
  assert.equal(again.draftId, cv3.draftId);
});

test('archived or rejected inactive versions do not block a new draft', async () => {
  const h = makeHarness();
  const d2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.ok(d2.ok);
  assert.ok((await h.engine.reject(admin, d2.draftId, 'wrong content')).ok, 'reject failed');
  assert.equal(isOpenDraftCandidate(h.versions.get(d2.draftId), lineageOf(h)), false);

  const d3 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.ok(d3.ok, 'rejected draft must not block a new draft');
  assert.ok((await h.engine.archive(admin, d3.draftId)).ok, 'archive failed');
  assert.equal(isOpenDraftCandidate(h.versions.get(d3.draftId), lineageOf(h)), false);

  const d4 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  assert.ok(d4.ok, 'archived draft must not block a new draft');
  // v_1 is still the active version, so each fork is a fresh v2-numbered draft.
  assert.equal(h.versions.get(d4.draftId).versionNumber, 2);
  assert.notEqual(d4.draftId, d3.draftId);
});

test('lineage with historical v1/v2 and current active v3 can still fork v4', async () => {
  const h = makeHarness();
  const cv2 = await h.engine.createVersion(admin, 'v_1', (d) => ({ ...d }));
  await publish(h, cv2.draftId); // v2 active, v1 superseded
  const cv3 = await h.engine.createVersion(admin, cv2.draftId, (d) => ({ ...d }));
  await publish(h, cv3.draftId); // v3 active, v2 superseded
  assert.equal(h.versions.get('v_1').isActiveVersion, false);
  assert.equal(h.versions.get(cv2.draftId).isActiveVersion, false);
  assert.equal(h.versions.get(cv3.draftId).isActiveVersion, true);

  const cv4 = await h.engine.createVersion(admin, cv3.draftId, (d) => ({ ...d }));
  assert.ok(cv4.ok, JSON.stringify(cv4));
  assert.equal(h.versions.get(cv4.draftId).versionNumber, 4);

  const lineage = lineageOf(h);
  assert.equal(isOpenDraftCandidate(h.versions.get('v_1'), lineage), false, 'v1 is history');
  assert.equal(isOpenDraftCandidate(h.versions.get(cv2.draftId), lineage), false, 'v2 is history');
  assert.equal(isOpenDraftCandidate(h.versions.get(cv4.draftId), lineage), true, 'v4 is the open draft');
});