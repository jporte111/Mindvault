// Phase 8 P8-1 — pure notification-engine tests: identity, episode model,
// cooldowns, severity mapping, recipient resolution, guarded read/dismiss
// decisions, entity RLS shape, purity, determinism.
//   node --test scripts/rag-eval/notification-engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  makeDedupeKey,
  pairKey,
  REMINDER_COOLDOWN_DAYS,
  reminderEligible,
  severityFromExposureSeverity,
  overdueSeverityForCriticality,
  pickFirstPresent,
  canMarkRead,
  canDismiss,
  planReconciliation,
  latestByPair,
  rowFromDraft,
  buildTitle,
  buildMessage,
  actionFor,
  P8_1_KINDS,
} from '../../base44/shared/notification/engine.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_FILE = resolve(HERE, '../../base44/shared/notification/engine.ts');
const ENTITY_FILE = join(HERE, '../../base44/entities/Notification.jsonc');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NOW = Date.parse('2026-09-03T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const draft = (o = {}) => ({
  kind: 'review_overdue',
  finding: null,
  severity: 'needs_attention',
  dedupeKey: 'review_overdue:s1',
  recipientUserId: 'u1',
  clientScope: 'general',
  title: 'Review overdue: Payroll SOP',
  message: 'A review of "Payroll SOP" is due.',
  actionLabel: 'Open the source',
  actionHref: '/training/s1',
  operationalProcessId: null,
  sourceId: 's1',
  knowledgeGapId: null,
  ...o,
});

// In-memory store that simulates write-mode execution of a plan.
let seq = 0;
const applyPlan = (rows, plan, now = NOW) => {
  const store = rows.map((r) => ({ ...r }));
  for (const c of plan.creates) {
    store.push({ id: `n${++seq}`, ...rowFromDraft(c.draft, now), created_date: iso(now) });
  }
  for (const r of plan.reminders) {
    const row = store.find((x) => x.id === r.id);
    if (row) { row.last_sent_at = r.last_sent_at; row.next_eligible_at = r.next_eligible_at; }
  }
  for (const r of plan.resolves) {
    const row = store.find((x) => x.id === r.id);
    if (row) { row.resolved_at = r.resolved_at; if (r.status) row.status = r.status; }
  }
  return store;
};

// ======================================================================
// Identity
// ======================================================================

test('identity: governance keys carry the finding subtype; other kinds are kind:ref', () => {
  assert.equal(makeDedupeKey('process_governance', 'missing_owner', 'p1'), 'process_governance:missing_owner:p1');
  assert.equal(makeDedupeKey('process_governance', 'missing_sme', 'p1'), 'process_governance:missing_sme:p1');
  assert.equal(makeDedupeKey('review_overdue', null, 's1'), 'review_overdue:s1');
  assert.equal(makeDedupeKey('key_person', null, 'p1'), 'key_person:p1');
  assert.notEqual(makeDedupeKey('review_due_soon', null, 's1'), makeDedupeKey('review_overdue', null, 's1'));
  assert.equal(pairKey('k:ref', 'u1'), 'k:ref::u1');
});

test('identity: episode identity is (dedupe_key, recipient) — same key, two recipients are two episodes', () => {
  const latest = latestByPair([
    { id: 'a', dedupe_key: 'k:ref', recipient_user_id: 'u1', status: 'open' },
    { id: 'b', dedupe_key: 'k:ref', recipient_user_id: 'u2', status: 'open' },
  ]);
  assert.equal(latest.size, 2);
});

// ======================================================================
// Episodes — create / suppress / dismiss / clear / re-entry / churn
// ======================================================================

test('episode: first detection -> create (first_detection)', () => {
  const plan = planReconciliation([draft()], [], NOW);
  assert.equal(plan.counts.would_create, 1);
  assert.equal(plan.creates[0].reason, 'first_detection');
  assert.deepEqual(plan.counts, { would_create: 1, would_remind: 0, would_resolve: 0, would_retarget: 0 });
});

test('episode: unchanged second run -> no duplicates (within cooldown)', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  const plan2 = planReconciliation([draft()], store, NOW);
  assert.equal(plan2.counts.would_create, 0);
  assert.equal(plan2.counts.would_remind, 0);
  assert.equal(plan2.counts.would_resolve, 0);
  store = applyPlan(store, plan2, NOW);
  assert.equal(store.filter((r) => r.dedupe_key === 'review_overdue:s1').length, 1);
});

test('episode: cooldown elapsed -> weekly reminder for review_overdue', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  // 6 days: not yet eligible
  assert.equal(planReconciliation([draft()], store, NOW + 6 * DAY).counts.would_remind, 0);
  // 7 days: eligible
  const plan = planReconciliation([draft()], store, NOW + 7 * DAY);
  assert.equal(plan.counts.would_remind, 1);
  assert.equal(plan.counts.would_create, 0);
  assert.equal(plan.reminders[0].last_sent_at, iso(NOW + 7 * DAY));
});

test('episode: entry-only kinds never remind (review_due_soon / source_failure / gap_actionable / key_person)', () => {
  for (const kind of ['review_due_soon', 'source_failure', 'gap_actionable', 'key_person']) {
    const f = draft({ kind, dedupeKey: `${kind}:x1` });
    let store = applyPlan([], planReconciliation([f], [], NOW), NOW);
    const later = planReconciliation([f], store, NOW + 365 * DAY);
    assert.equal(later.counts.would_remind, 0, `${kind} must not remind`);
    assert.equal(later.counts.would_create, 0, `${kind} must not create a second episode`);
  }
  assert.equal(REMINDER_COOLDOWN_DAYS.review_due_soon, undefined);
  assert.equal(REMINDER_COOLDOWN_DAYS.review_overdue, 7);
  assert.equal(REMINDER_COOLDOWN_DAYS.process_governance, 7);
});

test('episode: dismissed while condition remains true -> suppressed, stays suppressed', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  store[0].status = 'dismissed'; // recipient dismisses via the guarded function
  for (const dt of [0, 30, 400]) {
    const plan = planReconciliation([draft()], store, NOW + dt * DAY);
    assert.equal(plan.counts.would_create, 0, `dismissed must stay suppressed at +${dt}d`);
    assert.equal(plan.counts.would_resolve, 0, `condition still holds — no resolve`);
    assert.equal(plan.counts.would_remind, 0);
  }
});

test('episode: condition clears -> open row resolved; dismissed row closed with resolved_at but status kept', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  const openRow = { ...store[0] };
  store[0].status = 'dismissed';
  const dismissedRow = { ...store[0] };

  const p1 = planReconciliation([], [openRow], NOW + DAY);
  assert.equal(p1.counts.would_resolve, 1);
  assert.equal(p1.resolves[0].status, 'resolved');
  assert.ok(p1.resolves[0].resolved_at);

  const p2 = planReconciliation([], [dismissedRow], NOW + DAY);
  assert.equal(p2.counts.would_resolve, 1);
  assert.equal(p2.resolves[0].status, undefined, 'dismissed close keeps status, sets resolved_at');
  assert.ok(p2.resolves[0].resolved_at);
});

test('episode: re-entry after clear -> NEW episode with fresh triggered_at; old episode never reopened', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  store = applyPlan(store, planReconciliation([], store, NOW + DAY), NOW + DAY); // condition cleared
  const cleared = store.find((r) => r.dedupe_key === 'review_overdue:s1');
  assert.ok(cleared.resolved_at);

  const plan = planReconciliation([draft()], store, NOW + 10 * DAY);
  assert.equal(plan.counts.would_create, 1);
  assert.equal(plan.creates[0].reason, 'new_episode');
  // the resolved row is untouched — no reopen, no delete
  assert.equal(plan.resolves.filter((r) => r.id === cleared.id).length, 0);
});

test('episode: recipient churn -> old episode closed as retarget, new recipient episode created', () => {
  const f1 = draft({ recipientUserId: 'u1' });
  let store = applyPlan([], planReconciliation([f1], [], NOW), NOW);
  const f2 = draft({ recipientUserId: 'u2' });

  const plan = planReconciliation([f2], store, NOW + DAY);
  assert.equal(plan.counts.would_retarget, 1);
  assert.equal(plan.counts.would_resolve, 0, 'retarget is counted separately from condition clears');
  assert.equal(plan.counts.would_create, 1);
  assert.ok(plan.retargetedRowIds.includes(store[0].id));
  assert.equal(plan.creates[0].draft.recipientUserId, 'u2');
  // subject identity unchanged — same dedupe key
  assert.equal(plan.creates[0].draft.dedupeKey, f1.dedupeKey);
});

test('episode: condition clear (not churn) is counted as would_resolve, never as retarget', () => {
  let store = applyPlan([], planReconciliation([draft()], [], NOW), NOW);
  const plan = planReconciliation([], store, NOW + DAY); // nothing active at all
  assert.equal(plan.counts.would_resolve, 1);
  assert.equal(plan.counts.would_retarget, 0);
});

test('episode: historical episodes are never touched (only the latest pair row is acted on)', () => {
  const old = {
    id: 'old', dedupe_key: 'review_overdue:s1', recipient_user_id: 'u1', status: 'resolved',
    resolved_at: iso(NOW - 30 * DAY), triggered_at: iso(NOW - 40 * DAY),
  };
  const cur = {
    id: 'cur', dedupe_key: 'review_overdue:s1', recipient_user_id: 'u1', status: 'open',
    triggered_at: iso(NOW - 5 * DAY), last_sent_at: iso(NOW - 5 * DAY),
  };
  const plan = planReconciliation([], [old, cur], NOW);
  assert.equal(plan.resolves.filter((r) => r.id === 'old').length, 0);
  assert.ok(plan.resolves.some((r) => r.id === 'cur'));
  // latestByPair picks the newer row
  assert.equal(latestByPair([old, cur]).get('review_overdue:s1::u1').id, 'cur');
});

test('episode: duplicate (key, recipient) findings in one run produce exactly one create', () => {
  const plan = planReconciliation([draft(), draft()], [], NOW);
  assert.equal(plan.counts.would_create, 1);
});

test('episode: plan is pure — inputs are not mutated', () => {
  const f = draft();
  const rows = [{ id: 'a', dedupe_key: 'review_overdue:s1', recipient_user_id: 'u1', status: 'open' }];
  const fCopy = JSON.parse(JSON.stringify(f));
  const rowsCopy = JSON.parse(JSON.stringify(rows));
  planReconciliation([f], rows, NOW);
  assert.deepEqual(f, fCopy);
  assert.deepEqual(rows, rowsCopy);
});

// ======================================================================
// Cooldowns
// ======================================================================

test('cooldown: reminderEligible boundaries', () => {
  const sent = iso(NOW);
  assert.equal(reminderEligible(null, 7, NOW), true);
  assert.equal(reminderEligible(sent, 7, NOW + 7 * DAY - 1), false);
  assert.equal(reminderEligible(sent, 7, NOW + 7 * DAY), true);
  assert.equal(reminderEligible(sent, undefined, NOW + 365 * DAY), false, 'no cooldown -> never');
  assert.equal(reminderEligible('garbage', 7, NOW), true, 'unparseable -> eligible');
});

// ======================================================================
// Severity mapping — reused Phase 7 exposure, never a second table
// ======================================================================

test('severity: exposure severity mapping severe->urgent, moderate->needs_attention, info->info', () => {
  assert.equal(severityFromExposureSeverity('severe'), 'urgent');
  assert.equal(severityFromExposureSeverity('moderate'), 'needs_attention');
  assert.equal(severityFromExposureSeverity('info'), 'info');
  assert.equal(severityFromExposureSeverity('none'), 'info');
});

test('severity: overdue severity derives from the Phase 7 exposure primitive', () => {
  assert.equal(overdueSeverityForCriticality('low'), 'info');
  assert.equal(overdueSeverityForCriticality('medium'), 'info');
  assert.equal(overdueSeverityForCriticality(undefined), 'info');
  assert.equal(overdueSeverityForCriticality('high'), 'needs_attention');
  assert.equal(overdueSeverityForCriticality('mission_critical'), 'urgent');
});

// ======================================================================
// Recipient resolution
// ======================================================================

test('recipients: pickFirstPresent skips nulls and invalid ids, returns first valid', () => {
  const valid = new Set(['owner1', 'sme1', 'backup1']);
  assert.equal(pickFirstPresent(['owner1', 'sme1', 'backup1'], valid), 'owner1');
  assert.equal(pickFirstPresent([null, 'sme1', 'backup1'], valid), 'sme1');
  assert.equal(pickFirstPresent(['dead-user', 'sme1'], valid), 'sme1', 'dead id falls through');
  assert.equal(pickFirstPresent(['dead-user', null], valid), null, 'no valid id -> null (caller falls back to admin)');
  assert.equal(pickFirstPresent([], valid), null);
});

// ======================================================================
// Guarded read / dismiss decisions
// ======================================================================

const row = (o = {}) => ({
  id: 'n1', dedupe_key: 'k:ref', status: 'open', recipient_user_id: 'u1', ...o,
});
const admin = { id: 'admin1', role: 'admin' };
const recipient = { id: 'u1', role: 'user' };
const stranger = { id: 'u2', role: 'user' };

test('guards: markRead — recipient ok, admin ok, stranger rejected, anonymous rejected', () => {
  assert.deepEqual(canMarkRead(recipient, row()), { ok: true });
  assert.deepEqual(canMarkRead(admin, row()), { ok: true });
  assert.deepEqual(canMarkRead(stranger, row()), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(canMarkRead(null, row()), { ok: false, reason: 'unauthorized' });
});

test('guards: dismiss — open ok; already dismissed is an idempotent no-op; resolved rejected', () => {
  assert.deepEqual(canDismiss(recipient, row()), { ok: true, noop: false });
  assert.deepEqual(canDismiss(recipient, row({ status: 'dismissed' })), { ok: true, noop: true });
  assert.deepEqual(canDismiss(recipient, row({ status: 'resolved' })), { ok: false, reason: 'already_resolved' });
  assert.deepEqual(canDismiss(recipient, row({ status: 'open', resolved_at: iso(NOW) })), { ok: false, reason: 'already_resolved' });
  assert.deepEqual(canDismiss(stranger, row()), { ok: false, reason: 'unauthorized' });
  assert.deepEqual(canDismiss(admin, row()), { ok: true, noop: false });
});

// ======================================================================
// Message safety — no reporter/person/question context by construction
// ======================================================================

test('messages: key_person describes process risk, never a person', () => {
  const title = buildTitle('key_person', null, { subjectTitle: 'Payroll', processName: 'Payroll' });
  const message = buildMessage('key_person', null, { subjectTitle: 'Payroll', processName: 'Payroll' });
  assert.ok(title.includes('Payroll'));
  assert.ok(/single point of expertise|subject-matter expert/.test(message));
  assert.equal(/sme|person name|employee/i.test(message.replace(/subject-matter expert/g, '')), false);
});

test('messages: client name appears only when the context carries one (client-scoped findings)', () => {
  const withClient = buildMessage('review_overdue', null, { subjectTitle: 'Doc', clientName: 'Client Alpha' });
  const without = buildMessage('review_overdue', null, { subjectTitle: 'Doc' });
  assert.ok(withClient.includes('Client Alpha'));
  assert.equal(without.includes('Client Alpha'), false);
});

test('messages: engine accepts no reporter / question-text / person-name context (signature + source scan)', () => {
  const src = stripComments(readFileSync(ENGINE_FILE, 'utf8'));
  assert.equal(/reporter|question_text|rawQuestion|personName|reporter_hmac/i.test(src), false);
});

test('messages: overdue copy never says incorrect/wrong/broken (Phase 7 vocabulary rule)', () => {
  const m = buildMessage('review_overdue', null, { subjectTitle: 'Doc', daysOverdue: 5 });
  assert.equal(/incorrect|wrong|broken|stale/i.test(m), false);
  assert.ok(m.includes('due by about 5 days'));
});

// ======================================================================
// rowFromDraft
// ======================================================================

test('rowFromDraft: open episode, cooldown-backed eligibility, escalated false', () => {
  const r = rowFromDraft(draft(), NOW);
  assert.equal(r.status, 'open');
  assert.equal(r.dedupe_key, 'review_overdue:s1');
  assert.equal(r.recipient_user_id, 'u1');
  assert.equal(r.triggered_at, iso(NOW));
  assert.equal(r.last_sent_at, iso(NOW));
  assert.equal(r.next_eligible_at, iso(NOW + 7 * DAY)); // review_overdue weekly
  assert.equal(r.read_at, null);
  assert.equal(r.resolved_at, null);
  assert.equal(r.escalated, false);

  const entryOnly = rowFromDraft(draft({ kind: 'key_person', dedupeKey: 'key_person:p1' }), NOW);
  assert.equal(entryOnly.next_eligible_at, null);
});

test('actionFor: deep links into existing workflows only', () => {
  assert.deepEqual(actionFor('review_overdue', { sourceId: 's1' }), { label: 'Open the source', href: '/training/s1' });
  assert.equal(actionFor('gap_actionable', {}).href, '/admin');
  assert.equal(actionFor('key_person', {}).href, '/continuity');
  assert.equal(actionFor('process_governance', {}).href, '/continuity');
});

// ======================================================================
// Entity RLS — recipient read, admin-only writes, no recipient update path
// ======================================================================

test('RLS: read is recipient-or-admin; create/update/delete are admin-only; no recipient write path', () => {
  const entity = JSON.parse(readFileSync(ENTITY_FILE, 'utf8'));
  const rls = entity.rls;
  assert.ok(Array.isArray(rls.read.$or));
  assert.deepEqual(
    rls.read.$or.find((x) => x['data.recipient_user_id']),
    { 'data.recipient_user_id': '{{user.id}}' },
  );
  assert.ok(rls.read.$or.some((x) => x.user_condition && x.user_condition.role === 'admin'));
  for (const op of ['create', 'update', 'delete']) {
    assert.deepEqual(rls[op], { user_condition: { role: 'admin' } }, `${op} must be admin-only`);
  }
  const updateSrc = stripComments(readFileSync(ENTITY_FILE, 'utf8'));
  assert.equal(/"update"\s*:\s*\{[^}]*recipient/.test(updateSrc), false, 'recipients must not gain update rights');
});

// ======================================================================
// Purity + determinism
// ======================================================================

test('engine is pure: no LLM / embeddings / randomness / Base44 SDK / host APIs / UI', () => {
  const s = stripComments(readFileSync(ENGINE_FILE, 'utf8'));
  assert.equal(/InvokeLLM|\.embed\s*\(|Math\.random|@base44\/sdk|createClientFromRequest|\bDeno\.\w/.test(s), false);
  assert.equal(/from ['"]react|from ['"]@\//.test(s), false);
});

test('P8-1 kinds are exactly the six approved kinds', () => {
  assert.deepEqual(P8_1_KINDS, [
    'review_due_soon', 'review_overdue', 'source_failure',
    'gap_actionable', 'process_governance', 'key_person',
  ]);
});

test('determinism: identical inputs -> identical plans', () => {
  const f = [draft(), draft({ kind: 'process_governance', finding: 'missing_owner', dedupeKey: 'process_governance:missing_owner:p1', recipientUserId: 'admin1' })];
  const rows = [{ id: 'a', dedupe_key: 'review_overdue:s1', recipient_user_id: 'u1', status: 'open', last_sent_at: iso(NOW - 10 * DAY) }];
  assert.deepEqual(planReconciliation(f, rows, NOW), planReconciliation(JSON.parse(JSON.stringify(f)), JSON.parse(JSON.stringify(rows)), NOW));
});