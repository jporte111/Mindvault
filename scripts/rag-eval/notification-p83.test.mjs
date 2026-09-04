// Phase 8 P8-3 tests — the draft_stuck finding (ONE shared Phase 7 predicate,
// never a second definition), its binding trigger correctness, engine wiring,
// and UI safety. Nothing here touches Base44.
//   node --test scripts/rag-eval/notification-p83.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DRAFT_STUCK_DAYS, assessStuckDraft } from '../../base44/shared/health/draftStuck.ts';
import { computeNotificationFindings } from '../../base44/shared/notification/mindvaultNotifications.ts';
import {
  actionFor,
  buildMessage,
  buildTitle,
  makeDedupeKey,
  planReconciliation,
  REMINDER_COOLDOWN_DAYS,
  rowFromDraft,
} from '../../base44/shared/notification/engine.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NOW = Date.parse('2026-09-04T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const draftRow = (o = {}) => ({
  title: 'Draft revision', status: 'ready', knowledge_scope: 'general',
  is_active_version: false, is_archived: false, verification_status: 'unverified',
  index_status: 'indexed', operational_process_id: null, review_outcome: null,
  review_requested_at: null, ...o,
});

// ======================================================================
// ONE shared predicate — reuse, not duplication (source-level)
// ======================================================================

const walkSrc = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkSrc(join(dir, e.name)) : [join(dir, e.name)],
  );

test('reuse: DRAFT_STUCK_DAYS is defined exactly ONCE across base44/shared (the shared helper)', () => {
  const defs = [];
  for (const f of walkSrc(join(ROOT, 'base44/shared')).filter((p) => p.endsWith('.ts'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const _ of src.matchAll(/DRAFT_STUCK_DAYS\s*=/g)) defs.push(f);
  }
  assert.deepEqual(defs.map((f) => f.split('/').pop()), ['draftStuck.ts']);
});

test('reuse: Phase 7 health AND the Phase 8 binding both call assessStuckDraft — no inline copies', () => {
  const health = readFileSync(join(ROOT, 'base44/shared/mindvaultHealth.ts'), 'utf8');
  const binding = readFileSync(join(ROOT, 'base44/shared/notification/mindvaultNotifications.ts'), 'utf8');
  assert.ok(health.includes('assessStuckDraft('), 'mindvaultHealth must use the shared predicate');
  assert.ok(binding.includes('assessStuckDraft('), 'the notification binding must use the shared predicate');
  // no inline re-implementation left behind in either consumer
  assert.equal(stripComments(health).includes('isOpenDraftCandidate('), false);
  assert.equal(stripComments(binding).includes('isOpenDraftCandidate('), false);
});

// ======================================================================
// The shared predicate itself (Phase 7 semantics, unchanged)
// ======================================================================

test('predicate: open draft past DRAFT_STUCK_DAYS -> draft_stuck; fresh -> actionable but not stuck', () => {
  const old = draftRow({ id: 'd1', created_date: iso(NOW - (DRAFT_STUCK_DAYS + 1) * DAY) });
  assert.equal(assessStuckDraft(old, [old], NOW).kind, 'draft_stuck');
  const fresh = draftRow({ id: 'd2', created_date: iso(NOW - 1 * DAY) });
  const a = assessStuckDraft(fresh, [fresh], NOW);
  assert.equal(a.kind, null);
  assert.equal(a.actionable, true);
});

test('predicate: in_review past the threshold -> draft_stuck; changes_requested -> its own kind, never draft_stuck', () => {
  const inReview = draftRow({ id: 'd3', review_requested_at: iso(NOW - (DRAFT_STUCK_DAYS + 5) * DAY), created_date: iso(NOW - (DRAFT_STUCK_DAYS + 6) * DAY) });
  assert.equal(assessStuckDraft(inReview, [inReview], NOW).kind, 'draft_stuck');
  const cr = draftRow({ id: 'd4', review_outcome: 'changes_requested', created_date: iso(NOW - 1 * DAY) });
  assert.equal(assessStuckDraft(cr, [cr], NOW).kind, 'changes_requested');
  assert.notEqual(assessStuckDraft(cr, [cr], NOW).kind, 'draft_stuck');
});

test('predicate: superseded history / archived / rejected / completed review / active rows are NEVER stuck', () => {
  const superseded = draftRow({ id: 'd5', root_source_id: 'L', version_number: 1, created_date: iso(NOW - 400 * DAY) });
  const newerActive = { id: 'a5', root_source_id: 'L', version_number: 2, is_active_version: true, created_date: iso(NOW - 1 * DAY) };
  assert.equal(assessStuckDraft(superseded, [superseded, newerActive], NOW).actionable, false);
  for (const row of [
    draftRow({ id: 'd6', is_archived: true, created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'd7', verification_status: 'rejected', created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'd8', review_outcome: 'confirmed_current', created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'd9', is_active_version: true, created_date: iso(NOW - 400 * DAY) }),
  ]) {
    assert.equal(assessStuckDraft(row, [row], NOW).actionable, false, `${row.id} must not be stuck`);
    assert.equal(assessStuckDraft(row, [row], NOW).kind, null);
  }
});

// ======================================================================
// Binding — draft_stuck findings against a fake client
// ======================================================================

const makeClient = (d) => ({
  asServiceRole: {
    entities: {
      OperationalProcess: { filter: async () => d.processes || [] },
      Training: { filter: async () => d.trainings || [] },
      KnowledgeGap: { filter: async () => d.gaps || [] },
      KnowledgeLifecycleOperation: { filter: async () => d.ops || [] },
      User: { filter: async () => d.users || [] },
      Client: { filter: async () => d.clients || [] },
      KnowledgeChunk: { filter: async () => d.chunks || [] },
      Notification: {
        filter: async () => d.notifications || [],
        bulkCreate: async () => { throw new Error('binding must not write'); },
        bulkUpdate: async () => { throw new Error('binding must not write'); },
      },
    },
  },
});

const users = [
  { id: 'admin1', role: 'admin' },
  { id: 'admin2', role: 'admin' },
  { id: 'owner1', role: 'user' },
  { id: 'sme1', role: 'user' },
];

const proc = (o) => ({
  status: 'active', knowledge_scope: 'general', process_owner: null,
  subject_matter_expert: null, backup_sme: null, criticality: null,
  review_interval_days: null, name: 'Process', ...o,
});

const baseFixture = (trainings, processes = []) => ({
  users,
  processes,
  trainings,
  gaps: [],
  ops: [],
  clients: [{ id: 'cA', name: 'Client Alpha' }],
  chunks: [],
  notifications: [],
});

const run = async (d) => computeNotificationFindings(makeClient(d), { now: NOW });

test('binding: stuck draft with no process -> admins, dedupe key, deep link to the Admin lifecycle workflow', async () => {
  const trainings = [draftRow({ id: 'd1', title: 'Ledger Update Draft', created_date: iso(NOW - 30 * DAY) })];
  const { findings } = await run(baseFixture(trainings));
  const f = findings.filter((x) => x.kind === 'draft_stuck');
  assert.equal(f.length, 2); // one per admin
  assert.deepEqual(f.map((x) => x.recipientUserId).sort(), ['admin1', 'admin2']);
  assert.ok(f.every((x) => x.dedupeKey === makeDedupeKey('draft_stuck', null, 'd1')));
  assert.ok(f.every((x) => x.severity === 'needs_attention'));
  assert.ok(f.every((x) => x.actionHref === '/admin'), 'must deep link to the Admin lifecycle panel');
  assert.ok(f.every((x) => x.actionLabel === 'Review the draft'));
  assert.ok(f.every((x) => x.clientScope === 'general'));
  assert.ok(f.every((x) => x.sourceId === 'd1'));
});

test('binding: stuck draft on a governed process -> process owner recipient, process context in the message', async () => {
  const trainings = [draftRow({ id: 'd2', title: 'Payroll Draft', operational_process_id: 'px', created_date: iso(NOW - 20 * DAY) })];
  const processes = [proc({
    id: 'px', name: 'Payroll Process', process_owner: 'owner1',
    subject_matter_expert: 'sme1', backup_sme: null, criticality: 'low', review_interval_days: 30,
  })];
  const { findings } = await run(baseFixture(trainings, processes));
  const f = findings.filter((x) => x.kind === 'draft_stuck');
  assert.equal(f.length, 1);
  assert.equal(f[0].recipientUserId, 'owner1');
  assert.equal(f[0].operationalProcessId, 'px');
  assert.ok(f[0].message.includes('Payroll Process'));
  assert.ok(f[0].message.includes(iso(NOW - 20 * DAY).slice(0, 10)), 'message names the date the draft has been open since');
  assert.ok(/incorrect|wrong|broken|stale/i.test(f[0].message) === false);
});

test('binding: client-scoped stuck draft -> client:<id> scope, message names ONLY that client', async () => {
  const trainings = [draftRow({
    id: 'd3', title: 'Client A Draft', knowledge_scope: 'client-specific',
    client_id: 'cA', created_date: iso(NOW - 20 * DAY),
  })];
  const { findings } = await run(baseFixture(trainings));
  const f = findings.filter((x) => x.kind === 'draft_stuck');
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.clientScope === 'client:cA'));
  assert.ok(f.every((x) => x.message.includes('Client Alpha')));
});

test('binding: NOT stuck — fresh draft, superseded history, archived, rejected, completed review, changes_requested', async () => {
  const trainings = [
    draftRow({ id: 'fresh', created_date: iso(NOW - 2 * DAY) }),
    draftRow({ id: 'super', root_source_id: 'L', version_number: 1, created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'arch', is_archived: true, created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'rej', verification_status: 'rejected', created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'done', review_outcome: 'confirmed_current', created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'cr', review_outcome: 'changes_requested', created_date: iso(NOW - 400 * DAY) }),
    draftRow({ id: 'active', is_active_version: true, created_date: iso(NOW - 400 * DAY) }),
    { id: 'newer', root_source_id: 'L', version_number: 2, is_active_version: true, status: 'ready', knowledge_scope: 'general', created_date: iso(NOW - 1 * DAY) },
  ];
  const { findings } = await run(baseFixture(trainings));
  assert.equal(findings.filter((x) => x.kind === 'draft_stuck').length, 0,
    'none of these may notify — and Phase 7 changes_requested stays dashboard work');
});

test('binding: draft_stuck clears like any other condition — reconciliation resolves the episode when the draft is published', async () => {
  const trainings = [draftRow({ id: 'd1', created_date: iso(NOW - 30 * DAY) })];
  const r = await run(baseFixture(trainings));
  const plan = planReconciliation(r.findings, [], NOW);
  assert.equal(plan.counts.would_create, 2);
  // next run: the draft was activated — no finding, episodes resolve
  trainings[0].is_active_version = true;
  const r2 = await run(baseFixture(trainings));
  const store = plan.creates.map((c, i) => ({ id: `n${i}`, ...rowFromDraft(c.draft, NOW) }));
  const plan2 = planReconciliation(r2.findings, store, NOW);
  assert.equal(plan2.counts.would_resolve, 2);
  assert.equal(plan2.counts.would_create, 0);
});

// ======================================================================
// Engine wiring — copy, action, weekly reminder
// ======================================================================

test('engine: draft_stuck title/message/action are plain-language, with client/process context', () => {
  const ctx = { subjectTitle: 'Ledger Guide', processName: 'Reconciliation', clientName: 'Client Alpha', sinceDate: iso(NOW - 20 * DAY) };
  assert.equal(buildTitle('draft_stuck', null, ctx), 'Draft waiting on review: Ledger Guide');
  const m = buildMessage('draft_stuck', null, ctx);
  assert.ok(m.includes('Ledger Guide') && m.includes('Reconciliation') && m.includes('Client Alpha'));
  assert.ok(m.includes(iso(NOW - 20 * DAY).slice(0, 10)));
  assert.deepEqual(actionFor('draft_stuck', { sourceId: 'x' }), { label: 'Review the draft', href: '/admin' });
});

test('engine: draft_stuck reminds weekly (cooldown 7) — not entry-only, not immediate', () => {
  assert.equal(REMINDER_COOLDOWN_DAYS.draft_stuck, 7);
  const d = {
    kind: 'draft_stuck', finding: null, severity: 'needs_attention',
    dedupeKey: 'draft_stuck:d1', recipientUserId: 'admin1', clientScope: 'general',
    title: 't', message: 'm', actionLabel: 'a', actionHref: '/admin',
    operationalProcessId: null, sourceId: 'd1', knowledgeGapId: null,
  };
  const row = rowFromDraft(d, NOW);
  assert.equal(row.next_eligible_at, iso(NOW + 7 * DAY));
  const plan6 = planReconciliation([d], [{ ...row, id: 'n1', status: 'open' }], NOW + 6 * DAY);
  assert.equal(plan6.counts.would_remind, 0);
  const plan7 = planReconciliation([d], [{ ...row, id: 'n1', status: 'open' }], NOW + 7 * DAY);
  assert.equal(plan7.counts.would_remind, 1);
});

// ======================================================================
// Safety — RLS untouched, no email, flag untouched
// ======================================================================

test('safety: Notification RLS unchanged — recipient-or-admin read, admin-only writes', () => {
  const entity = JSON.parse(stripComments(readFileSync(join(ROOT, 'base44/entities/Notification.jsonc'), 'utf8')));
  assert.ok(entity.rls.read.$or.some((x) => x['data.recipient_user_id'] === '{{user.id}}'));
  assert.ok(entity.rls.read.$or.some((x) => x.user_condition?.role === 'admin'));
  for (const op of ['create', 'update', 'delete']) {
    assert.deepEqual(entity.rls[op], { user_condition: { role: 'admin' } });
  }
  assert.ok(entity.properties.kind.enum.includes('draft_stuck'));
});

test('safety: no email delivery anywhere in the notification path', () => {
  const dirs = [
    'base44/shared/notification',
    'base44/shared/health',
    'base44/functions/computeNotifications',
    'base44/functions/markNotificationRead',
    'base44/functions/dismissNotification',
  ];
  const files = dirs.flatMap((d) => walkSrc(join(ROOT, d))).filter((p) => p.endsWith('.ts'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/SendEmail|sendEmail|send_email/i.test(src), `${f} must not send email`);
  }
});

test('safety: notifications_enabled stays default false in the AppConfig schema', () => {
  const cfg = JSON.parse(stripComments(readFileSync(join(ROOT, 'base44/entities/AppConfig.jsonc'), 'utf8')));
  assert.equal(cfg.properties.notifications_enabled.default, false);
});