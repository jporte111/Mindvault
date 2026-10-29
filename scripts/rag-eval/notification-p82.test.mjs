// Phase 8 P8-2 tests — master feature flag, write gate, scheduled workflow,
// idempotency of repeated scheduled runs, and absence of UI/email paths.
//   node --test scripts/rag-eval/notification-p82.test.mjs
//
// Purity: everything here reads committed source files and exercises the pure
// engine gate / reconciliation plan. No Base44 SDK, no network, no writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  planReconciliation,
  resolveWriteGate,
  rowFromDraft,
} from '../../base44/shared/notification/engine.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const appConfig = JSON.parse(
  stripComments(readFileSync(join(ROOT, 'base44/entities/AppConfig.jsonc'), 'utf8')),
);
const entrySrc = readFileSync(join(ROOT, 'base44/functions/computeNotifications/entry.ts'), 'utf8');
const workflow = JSON.parse(
  stripComments(readFileSync(join(ROOT, 'base44/workflows/Daily Notifications Reconcile.jsonc'), 'utf8')),
);
const workflowTask = workflow.definition.do[0][Object.keys(workflow.definition.do[0])[0]];

const NOW = Date.parse('2026-09-04T00:00:00Z');
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

// In-memory store simulating write-mode execution of plans (same shape the
// P8-1 engine tests use).
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
// Master feature flag — default false, additive only
// ======================================================================

test('flag: notifications_enabled exists, is boolean, defaults false', () => {
  const f = appConfig.properties.notifications_enabled;
  assert.ok(f, 'notifications_enabled field must exist');
  assert.equal(f.type, 'boolean');
  assert.equal(f.default, false);
});

test('flag: additive only — no existing flag semantics, required, or RLS changed', () => {
  assert.deepEqual(appConfig.required, ['key']);
  assert.equal(appConfig.properties.require_verification_for_retrieval.default, false);
  assert.equal(appConfig.properties.require_ingestion_review.default, false);
  assert.equal(appConfig.properties.governance_ranking_enabled.default, true);
  assert.equal(appConfig.properties.answer_logging_enabled.default, false);
  assert.equal(appConfig.properties.operational_answer_mode.default, false);
  assert.equal(appConfig.properties.knowledge_gaps_enabled.default, false);
  assert.equal(appConfig.properties.source_lifecycle_enabled.default, false);
  assert.equal(appConfig.properties.knowledge_health_enabled.default, false);
  assert.deepEqual(appConfig.rls, {
    create: { user_condition: { role: 'admin' } },
    read: { user_condition: { role: 'admin' } },
    update: { user_condition: { role: 'admin' } },
    delete: { user_condition: { role: 'admin' } },
  });
});

// ======================================================================
// Write gate — dry-run always allowed; write mode gated by the flag
// ======================================================================

test('gate: dry-run is allowed while the flag is disabled', () => {
  const g = resolveWriteGate({ notificationsEnabled: false, dryRun: true });
  assert.equal(g.allowed, true);
  assert.equal(g.dryRun, true);
});

test('gate: write mode is refused with a clear reason while disabled', () => {
  const g = resolveWriteGate({ notificationsEnabled: false, dryRun: false });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'notifications_disabled');
  assert.equal(g.dryRun, false);
});

test('gate: write mode is allowed when the flag is enabled', () => {
  const g = resolveWriteGate({ notificationsEnabled: true, dryRun: false });
  assert.equal(g.allowed, true);
  assert.equal(g.dryRun, false);
});

test('entry: dry-run still defaults to true; refusal happens before any write', () => {
  assert.ok(entrySrc.includes('body?.dryRun !== false'), 'dryRun must default to true');
  const refuseIdx = entrySrc.indexOf('reason: gate.reason');
  assert.ok(refuseIdx > -1, 'entry must return the gate refusal reason');
  const writeIdx = entrySrc.indexOf('bulkCreate');
  assert.ok(writeIdx > -1, 'entry must have a write path');
  assert.ok(refuseIdx < writeIdx, 'the flag refusal must precede the write path');
});

// ======================================================================
// Scheduled workflow — reconciliation-led, points only at computeNotifications
// ======================================================================

test('workflow: scheduled once daily, recurring, never ends', () => {
  assert.equal(workflow.trigger.config.trigger_type, 'scheduled');
  assert.equal(workflow.trigger.config.schedule_mode, 'recurring');
  assert.equal(workflow.trigger.config.cron_expression, '0 7 * * *');
  assert.equal(workflow.trigger.config.ends_type, 'never');
});

test('workflow: its single task invokes only computeNotifications, in write mode', () => {
  assert.equal(workflow.definition.do.length, 1);
  assert.equal(workflowTask.call, 'invoke_backend_function');
  assert.equal(workflowTask.with.function_name, 'computeNotifications');
  assert.deepEqual(workflowTask.with.args, { dryRun: false });
  assert.equal(workflowTask.then, 'end');
  const names = [...JSON.stringify(workflow).matchAll(/"function_name":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['computeNotifications']);
});

test('workflow: cannot create notifications while the flag is false', () => {
  // The workflow calls computeNotifications with { dryRun: false }. At the
  // flag's default false the deterministic gate refuses the run, so the plan
  // never reaches storage — zero Notification writes from scheduled runs.
  const enabledDefault = appConfig.properties.notifications_enabled.default;
  const gate = resolveWriteGate({
    notificationsEnabled: enabledDefault,
    dryRun: workflowTask.with.args.dryRun === false ? false : true,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'notifications_disabled');
});

test('workflow: no write-event hooks — no entity or connector trigger, no email', () => {
  assert.equal(workflow.trigger.config.trigger_type, 'scheduled');
  const src = JSON.stringify(workflow);
  assert.ok(!/entity_name|connector|integration_type/.test(src), 'reconciliation must stay scheduled, not event-hooked');
  assert.ok(!/SendEmail|sendEmail|send_email/i.test(src), 'no email delivery');
});

// ======================================================================
// Idempotency — repeated scheduled runs with unchanged state
// ======================================================================

test('scheduled runs: repeated runs with unchanged state are idempotent', () => {
  const findings = [
    draft(),
    draft({ kind: 'source_failure', dedupeKey: 'source_failure:s2', sourceId: 's2', title: 'X', message: 'Y' }),
  ];

  // Run 1: everything is new.
  let store = applyPlan([], planReconciliation(findings, [], NOW), NOW);
  assert.equal(store.length, 2);

  // Run 2 (next day, unchanged state): no creates, no resolves, no retargets,
  // and no reminders (review_overdue cooldown is 7 days; source_failure is
  // entry-only). Still exactly one row per episode.
  const plan2 = planReconciliation(findings, store, NOW + DAY);
  assert.deepEqual(plan2.counts, { would_create: 0, would_remind: 0, would_resolve: 0, would_retarget: 0 });
  store = applyPlan(store, plan2, NOW + DAY);
  assert.equal(store.length, 2);

  // Run 3 (day after): still a full no-op.
  const plan3 = planReconciliation(findings, store, NOW + 2 * DAY);
  assert.deepEqual(plan3.counts, { would_create: 0, would_remind: 0, would_resolve: 0, would_retarget: 0 });
  assert.equal(store.filter((r) => r.dedupe_key === 'review_overdue:s1').length, 1);
  assert.equal(store.filter((r) => r.dedupe_key === 'source_failure:s2').length, 1);
});

// ======================================================================
// No UI or email paths anywhere in P8-2
// ======================================================================

test('no email: notification backend files contain no email delivery', () => {
  const dirs = [
    'base44/shared/notification',
    'base44/functions/computeNotifications',
    'base44/functions/markNotificationRead',
    'base44/functions/dismissNotification',
  ];
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d))) {
      const src = readFileSync(join(ROOT, d, f), 'utf8');
      assert.ok(!/SendEmail|sendEmail|send_email/i.test(src), `${d}/${f} must not send email`);
    }
  }
});

test('UI (P8-3): reads are recipient-scoped; mutations ONLY via guarded functions; flag not read', () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  const files = walk(join(ROOT, 'src')).filter((p) => /\.(js|jsx|ts|tsx)$/.test(p));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // The only permitted direct SDK use is a READ — never a direct write:
    // recipients act only through markNotificationRead / dismissNotification.
    assert.ok(
      !/entities\.Notification\s*\.\s*(create|bulkCreate|update|updateMany|bulkUpdate|delete|deleteMany)\s*\(/.test(src),
      `${f} must not write notifications directly`,
    );
    assert.ok(!src.includes('notifications_enabled'), `${f} must not read the flag`);
  }
  const lib = readFileSync(join(ROOT, 'src/lib/notifications.js'), 'utf8');
  assert.ok(lib.includes("invoke('markNotificationRead'"), 'mark read must go through the guarded function');
  assert.ok(lib.includes("invoke('dismissNotification'"), 'dismiss must go through the guarded function');
  assert.ok(lib.includes('recipient_user_id'), 'reads must be scoped to the current user');
});