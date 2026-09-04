// Phase 8 P8-1 — notification trigger + binding tests. Runs the MindVault
// binding (computeNotificationFindings) against an in-memory fake Base44
// client and the pure reconciliation engine: the six kinds against REAL Phase
// 6/7 semantics, no-overlap, client isolation, recipient chains, dry-run
// purity. Nothing here touches Base44.
//   node --test scripts/rag-eval/notification-triggers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNotificationFindings } from '../../base44/shared/notification/mindvaultNotifications.ts';
import { planReconciliation, rowFromDraft } from '../../base44/shared/notification/engine.ts';

const NOW = Date.parse('2026-09-03T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// --- fake client -----------------------------------------------------------
// The binding filters in code; the fake just serves arrays. The Notification
// entity throws on any write attempt — the binding must never write.

const makeClient = (d) => {
  const calls = { notification: [] };
  const client = {
    __calls: calls,
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
          filter: async () => { calls.notification.push('read'); return d.notifications || []; },
          bulkCreate: async () => { calls.notification.push('create'); throw new Error('binding must not write'); },
          bulkUpdate: async () => { calls.notification.push('update'); throw new Error('binding must not write'); },
        },
      },
    },
  };
  return client;
};

// --- fixture ---------------------------------------------------------------

const RAW_QUESTION = 'How do I handle the raw payroll cutoff question that must never appear?';

const users = [
  { id: 'admin1', role: 'admin' },
  { id: 'admin2', role: 'admin' },
  { id: 'owner1', role: 'user' },
  { id: 'sme1', role: 'user' },
  { id: 'backup1', role: 'user' },
  { id: 'sme2', role: 'user' },
  { id: 'sme3', role: 'user' },
];

const proc = (o) => ({
  status: 'active', knowledge_scope: 'general', process_owner: null,
  subject_matter_expert: null, backup_sme: null, criticality: null, review_interval_days: null, ...o,
});
const src = (o) => ({
  title: 'Untitled', status: 'ready', knowledge_scope: 'general', is_active_version: true,
  is_archived: false, verification_status: 'unverified', index_status: 'indexed',
  operational_process_id: null, source_review_interval_days: null, ...o,
});

const processes = [
  proc({ id: 'p1', name: 'Payroll Process', process_owner: 'owner1', subject_matter_expert: 'sme1', backup_sme: 'backup1', criticality: 'high', review_interval_days: 30 }),
  proc({ id: 'p2', name: 'Ownerless Process' }), // all four governance findings
  proc({ id: 'p3', name: 'Client A Process', knowledge_scope: 'client-specific', client_id: 'cA', process_owner: 'owner1', subject_matter_expert: 'sme2', criticality: 'mission_critical', review_interval_days: 90 }),
  proc({ id: 'p4', name: 'Owned No-SME', process_owner: 'owner1', criticality: 'medium', review_interval_days: 30 }),
  proc({ id: 'p5', name: 'Dead Owner', process_owner: 'gone-user', criticality: 'medium', review_interval_days: 30 }),
  proc({ id: 'p6', name: 'Owner Is SME', process_owner: 'sme3', subject_matter_expert: 'sme3', criticality: 'mission_critical', review_interval_days: 30 }),
  proc({ id: 'p7', name: 'Concentration Second', subject_matter_expert: 'sme2', criticality: 'high' }),
  proc({ id: 'p8', name: 'Failing Process', process_owner: 'owner1', subject_matter_expert: 'sme1', criticality: 'high', review_interval_days: 30 }),
];

const trainings = [
  src({ id: 's1', title: 'Payroll SOP', operational_process_id: 'p1', next_review_due_at: iso(NOW - 10 * DAY) }),
  src({ id: 's2', title: 'Onboarding Checklist', operational_process_id: 'p1', next_review_due_at: iso(NOW + 3 * DAY) }),
  src({ id: 's3', title: 'Broken Sync Doc', index_status: 'failed', operational_process_id: 'p1' }),
  src({ id: 's4', title: 'Unclassified Doc', knowledge_scope: 'unclassified', next_review_due_at: iso(NOW - DAY), source_review_interval_days: 7 }),
  src({ id: 's5', title: 'Client A Ledger Guide', knowledge_scope: 'client-specific', client_id: 'cA', operational_process_id: 'p3', next_review_due_at: iso(NOW + 80 * DAY) }),
  src({ id: 's6', title: 'Standalone Policy', operational_process_id: null, next_review_due_at: iso(NOW - 2 * DAY), source_review_interval_days: 7 }),
  src({ id: 's7', title: 'Op-Failed Doc', operational_process_id: 'p1', root_source_id: 'root7' }),
  src({ id: 's8', title: 'Op-Recovered Doc', operational_process_id: 'p1', root_source_id: 'root8' }),
  src({ id: 's9', title: 'Only Failed Doc', index_status: 'failed', operational_process_id: 'p8' }),
  src({ id: 's10', title: 'Low Crit Failed', index_status: 'failed', operational_process_id: 'p4' }),
  src({ id: 's11', title: 'Pending Index Doc', index_status: 'pending', operational_process_id: 'p1', next_review_due_at: iso(NOW - 5 * DAY) }),
];

const ops = [
  { operation_id: 'op1', root_source_id: 'root7', status: 'completed', started_at: iso(NOW - 5 * DAY) },
  { operation_id: 'op2', root_source_id: 'root7', status: 'failed', started_at: iso(NOW - 1 * DAY) },
  { operation_id: 'op3', root_source_id: 'root8', status: 'failed', started_at: iso(NOW - 5 * DAY) },
  { operation_id: 'op4', root_source_id: 'root8', status: 'completed', started_at: iso(NOW - 1 * DAY) },
];

const gaps = [
  { id: 'g1', title: 'Payroll cutoff handling', status: 'open', client_scope: 'general', operational_process_id: 'p1', assigned_sme: 'sme1', times_asked: 4, distinct_reporters: 3, example_questions: [RAW_QUESTION] },
  { id: 'g3', title: 'Under review no assignee', status: 'under_review', client_scope: 'general', operational_process_id: 'p1', assigned_sme: null, times_asked: 1, distinct_reporters: 1 },
  { id: 'g4', title: 'Client A reconciliation question', status: 'under_review', client_scope: 'client:cA', operational_process_id: 'p3', assigned_sme: 'sme2', times_asked: 1, distinct_reporters: 1 },
];

const fixture = {
  users, processes, trainings, ops, gaps,
  clients: [
    { id: 'cA', name: 'Client Alpha' },
    { id: 'cB', name: 'Client Beta' },
  ],
  chunks: [],
};

const run = async (data = fixture) => {
  const client = makeClient(data);
  const res = await computeNotificationFindings(client, { now: NOW });
  return { ...res, client };
};

const find = (findings, pred) => findings.filter(pred);

// ======================================================================
// review_due_soon / review_overdue
// ======================================================================

test('review: overdue usable source -> review_overdue with Phase 7 severity (high -> needs_attention), owner recipient', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'review_overdue:s1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'needs_attention'); // p1 criticality high -> moderate exposure
  assert.equal(f[0].recipientUserId, 'owner1'); // chain: owner first
  assert.equal(f[0].clientScope, 'general');
  assert.ok(f[0].actionHref === '/training/s1');
});

test('review: due_soon -> info; SME chain falls through when owner invalid; due date in message', async () => {
  const data = JSON.parse(JSON.stringify(fixture));
  data.processes.find((p) => p.id === 'p1').process_owner = 'gone-user';
  const { findings } = await run(data);
  const ds = find(findings, (x) => x.dedupeKey === 'review_due_soon:s2');
  assert.equal(ds.length, 1);
  assert.equal(ds[0].severity, 'info');
  assert.equal(ds[0].recipientUserId, 'sme1'); // owner dead -> SME next
  assert.ok(ds[0].message.includes(iso(NOW + 3 * DAY).slice(0, 10)));
});

test('review: backup SME chain position; no linked process -> admins; no process criticality -> info severity', async () => {
  const { findings } = await run();
  // s6: standalone policy, own 7d cadence, overdue, no process
  const s6 = find(findings, (x) => x.dedupeKey === 'review_overdue:s6');
  assert.equal(s6.length, 2); // one per admin
  assert.deepEqual(s6.map((x) => x.recipientUserId).sort(), ['admin1', 'admin2']);
  assert.ok(s6.every((x) => x.severity === 'info'));
});

test('review: chain reaches backup SME only when owner and SME are both invalid', async () => {
  const data = JSON.parse(JSON.stringify(fixture));
  const p1 = data.processes.find((p) => p.id === 'p1');
  p1.process_owner = 'gone-owner';
  p1.subject_matter_expert = 'gone-sme';
  const { findings } = await run(data);
  const f = find(findings, (x) => x.dedupeKey === 'review_overdue:s1');
  assert.equal(f.length, 1);
  assert.equal(f[0].recipientUserId, 'backup1');
});

test('review: non-usable sources never produce review findings (failed / pending / unclassified)', async () => {
  const { findings } = await run();
  for (const id of ['s3', 's11']) {
    assert.equal(find(findings, (x) => x.sourceId === id && x.kind.startsWith('review')).length, 0, `${id} is not usable`);
  }
  assert.equal(find(findings, (x) => x.sourceId === 's4').length, 0, 'unclassified excluded entirely');
});

test('review: overdue suppresses due_soon for the same source (old due_soon episode resolves)', async () => {
  // s2 flips from due_soon to overdue
  const data = JSON.parse(JSON.stringify(fixture));
  data.trainings.find((t) => t.id === 's2').next_review_due_at = iso(NOW - 1 * DAY);
  const { findings } = await run(data);
  assert.equal(find(findings, (x) => x.dedupeKey === 'review_due_soon:s2').length, 0);
  assert.equal(find(findings, (x) => x.dedupeKey === 'review_overdue:s2').length, 1);

  // and a pre-existing open due_soon episode is closed by reconciliation
  const existing = [{ id: 'e1', dedupe_key: 'review_due_soon:s2', recipient_user_id: 'owner1', status: 'open', triggered_at: iso(NOW - 20 * DAY) }];
  const plan = planReconciliation(findings, existing, NOW);
  assert.equal(plan.counts.would_resolve, 1);
  assert.equal(plan.resolves[0].id, 'e1');
});

// ======================================================================
// source_failure
// ======================================================================

test('source_failure: explicit index_status failed -> finding; critical process -> urgent with admin copy', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'source_failure:s3');
  assert.equal(f.length, 3); // owner1 + admin1 + admin2 (p1 is high-criticality)
  assert.ok(f.every((x) => x.severity === 'urgent'));
  assert.ok(f.some((x) => x.recipientUserId === 'owner1'));
  assert.ok(f.some((x) => x.recipientUserId === 'admin2'));
});

test('source_failure: latest failed lifecycle operation -> finding; recovered lineage -> none', async () => {
  const { findings } = await run();
  assert.equal(find(findings, (x) => x.dedupeKey === 'source_failure:s7').length, 3); // root7 latest op failed
  assert.equal(find(findings, (x) => x.dedupeKey === 'source_failure:s8').length, 0); // root8 latest op completed
});

test('source_failure: non-critical process -> needs_attention, chain only, no admin copy', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'source_failure:s10');
  assert.equal(f.length, 1); // p4 is medium — owner only, no admins
  assert.equal(f[0].severity, 'needs_attention');
  assert.equal(f[0].recipientUserId, 'owner1');
});

test('source_failure: recovery resolves the episode; re-failure opens a NEW episode', async () => {
  const existing = [
    { id: 'e1', dedupe_key: 'source_failure:s3', recipient_user_id: 'owner1', status: 'open', triggered_at: iso(NOW - 30 * DAY) },
    { id: 'e2', dedupe_key: 'source_failure:s9', recipient_user_id: 'owner1', status: 'open', triggered_at: iso(NOW - 30 * DAY) },
  ];
  // recover s9 (index repaired), keep s3 failed
  const data = JSON.parse(JSON.stringify(fixture));
  data.trainings.find((t) => t.id === 's9').index_status = 'indexed';
  const { findings } = await run(data);
  const plan = planReconciliation(findings, existing, NOW);
  assert.ok(plan.resolves.some((r) => r.id === 'e2'));       // recovered -> closed
  assert.equal(plan.resolves.filter((r) => r.id === 'e1').length, 0); // still failing -> untouched
  assert.equal(plan.counts.would_retarget, 0);
});

// ======================================================================
// no-overlap: source failure vs process coverage rollups
// ======================================================================

test('NO-OVERLAP: a failed source that also degrades process coverage yields exactly ONE source_failure — no coverage notification kind exists', async () => {
  const { findings } = await run();
  // p8's only source s9 failed -> p8 coverage is needs_attention in Phase 7.
  const p8findings = find(findings, (x) => x.operationalProcessId === 'p8');
  assert.equal(p8findings.length, 3); // source_failure:s9 to owner1 + 2 admins — nothing else
  assert.ok(p8findings.every((x) => x.kind === 'source_failure' && x.sourceId === 's9'));
  assert.equal(find(findings, (x) => x.sourceId === 's9').length, 3);
  // no notification kind is derived from coverage/not_documented/unknown/
  // legacy/active_not_verified/expired states
  const kinds = new Set(findings.map((x) => x.kind));
  for (const banned of ['coverage', 'not_documented', 'legacy_coverage_unresolved', 'active_not_verified', 'expired_active']) {
    assert.equal(kinds.has(banned), false);
  }
});

// ======================================================================
// gap_actionable
// ======================================================================

test('gap_actionable: promoted open gap on a critical process -> urgent, assigned SME recipient', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'gap_actionable:g1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'urgent'); // promoted (>=3 asked, >=2 reporters) + p1 critical
  assert.equal(f[0].recipientUserId, 'sme1');
  assert.equal(f[0].knowledgeGapId, 'g1');
});

test('gap_actionable: under_review WITHOUT assigned SME -> no notification; WITH assignment -> needs_attention', async () => {
  const { findings } = await run();
  assert.equal(find(findings, (x) => x.dedupeKey === 'gap_actionable:g3').length, 0);
  const g4 = find(findings, (x) => x.dedupeKey === 'gap_actionable:g4');
  assert.equal(g4.length, 1);
  assert.equal(g4[0].severity, 'needs_attention'); // assigned but not promoted
  assert.equal(g4[0].recipientUserId, 'sme2');
});

test('gap_actionable: falls back owner -> admin when the assigned SME id is dead', async () => {
  const data = JSON.parse(JSON.stringify(fixture));
  data.gaps.find((g) => g.id === 'g1').assigned_sme = 'gone-sme';
  const { findings } = await run(data);
  const f = find(findings, (x) => x.dedupeKey === 'gap_actionable:g1');
  assert.equal(f.length, 1);
  assert.equal(f[0].recipientUserId, 'owner1'); // process owner next in chain
});

test('gap_actionable: message uses the gap title only — never raw question text or reporter identity', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'gap_actionable:g1');
  assert.ok(f[0].message.includes('Payroll cutoff handling'));
  assert.equal(f[0].message.includes(RAW_QUESTION), false);
  assert.equal(JSON.stringify(f).includes(RAW_QUESTION), false);
});

// ======================================================================
// process_governance
// ======================================================================

test('governance: only the four Phase 7 exposure findings, severity mapped from that exposure', async () => {
  const { findings } = await run();
  const p2 = find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p2');
  const byFinding = new Map(p2.map((x) => [x.finding, x]));
  assert.equal(p2.length, 8); // 4 findings x 2 admins
  assert.equal(byFinding.get('missing_owner').severity, 'needs_attention');      // moderate
  assert.equal(byFinding.get('missing_sme').severity, 'needs_attention');       // moderate
  assert.equal(byFinding.get('missing_review_cadence').severity, 'info');       // info
  assert.equal(byFinding.get('criticality_unset').severity, 'info');            // info
  assert.ok(p2.every((x) => x.clientScope === 'general'));
});

test('governance: missing owner -> admins only; missing SME/cadence/criticality -> process owner first, then admin', async () => {
  const { findings } = await run();
  // p4 has an owner, no SME -> missing_sme to the owner
  const p4 = find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p4');
  assert.equal(p4.length, 1);
  assert.equal(p4[0].finding, 'missing_sme');
  assert.equal(p4[0].recipientUserId, 'owner1');
  // p5: the owner FIELD is set but points at a dead id — presence is a data
  // fact, so no missing_owner finding fires; the dead id still falls back to
  // admins for the missing_sme finding.
  const p5 = find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p5');
  assert.equal(p5.length, 2);
  assert.ok(p5.every((x) => x.recipientUserId.startsWith('admin')));
  assert.deepEqual([...new Set(p5.map((x) => x.finding))], ['missing_sme']);
});

test('governance: fully-governed process produces no governance findings', async () => {
  const { findings } = await run();
  assert.equal(find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p1').length, 0);
  assert.equal(find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p3').length, 0);
});

test('governance: keys carry the finding subtype — one deficient process yields distinct resolvable rows', async () => {
  const { findings } = await run();
  const keys = new Set(find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p2').map((x) => x.dedupeKey));
  assert.deepEqual([...keys].sort(), [
    'process_governance:criticality_unset:p2',
    'process_governance:missing_owner:p2',
    'process_governance:missing_review_cadence:p2',
    'process_governance:missing_sme:p2',
  ]);
});

// ======================================================================
// key_person
// ======================================================================

test('key_person: high/critical dependency notifies admin + owner, NEVER the flagged SME', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'key_person:p3');
  assert.equal(f.length, 3); // admin1, admin2, owner1
  assert.deepEqual(f.map((x) => x.recipientUserId).sort(), ['admin1', 'admin2', 'owner1']);
  assert.equal(f.some((x) => x.recipientUserId === 'sme2'), false, 'the dependency subject is never notified');
  assert.ok(f.every((x) => x.severity === 'urgent'));
  // message describes process risk, never the person
  assert.equal(JSON.stringify(f).includes('sme2'), false);
});

test('key_person: owner who IS the sole SME is excluded as a recipient — admins only', async () => {
  const { findings } = await run();
  const f = find(findings, (x) => x.dedupeKey === 'key_person:p6');
  assert.equal(f.length, 2); // admin1 + admin2 only — owner1? p6 owner is sme3, a subject
  assert.deepEqual(f.map((x) => x.recipientUserId).sort(), ['admin1', 'admin2']);
  assert.equal(f.some((x) => x.recipientUserId === 'sme3'), false);
});

test('key_person: concentration fold (same sole SME on 2+ critical processes) raises both to notify', async () => {
  const { findings } = await run();
  // p7 on its own: elevated; sme2 concentrates across p3+p7 -> folded to high
  const f = find(findings, (x) => x.dedupeKey === 'key_person:p7');
  assert.equal(f.length, 2); // admins only (p7 has no owner)
  assert.equal(f.some((x) => x.recipientUserId === 'sme2'), false);
});

test('key_person: below high/critical never notifies; missing-SME alone is governance, not key-person', async () => {
  const data = JSON.parse(JSON.stringify(fixture));
  data.processes = data.processes.filter((p) => ['p1', 'p2', 'p4', 'p5', 'p8'].includes(p.id));
  data.trainings = data.trainings.filter((t) => ['s1', 's2', 's3', 's9', 's10', 's11'].includes(t.id));
  const { findings } = await run(data);
  assert.equal(find(findings, (x) => x.kind === 'key_person').length, 0);
});

// ======================================================================
// client isolation
// ======================================================================

test('isolation: general findings carry client_scope general — one notification, no per-client fan-out', async () => {
  const { findings } = await run();
  const general = find(findings, (x) => x.dedupeKey === 'review_overdue:s1');
  assert.equal(general.length, 1);
  assert.equal(general[0].clientScope, 'general');
  assert.equal(findings.filter((x) => x.clientScope.startsWith('client:') && x.sourceId === 's1').length, 0);
});

test('isolation: client-scoped subjects carry client:<id> verbatim; message names that client only', async () => {
  const { findings } = await run();
  const g4 = find(findings, (x) => x.dedupeKey === 'gap_actionable:g4');
  assert.equal(g4.length, 1);
  assert.equal(g4[0].clientScope, 'client:cA');
  assert.ok(g4[0].message.includes('Client Alpha'));
  assert.equal(g4[0].message.includes('Client Beta'), false);
});

test('isolation: no message anywhere contains another client\'s name', async () => {
  const { findings } = await run();
  assert.equal(findings.some((x) => x.message.includes('Client Beta')), false);
  assert.equal(findings.some((x) => x.title.includes('Client Beta')), false);
});

test('isolation: client-scoped process findings stay client-scoped', async () => {
  const data = JSON.parse(JSON.stringify(fixture));
  // break p3's SME -> governance finding on the client-scoped process
  data.processes.find((p) => p.id === 'p3').subject_matter_expert = null;
  const { findings } = await run(data);
  const f = find(findings, (x) => x.kind === 'process_governance' && x.operationalProcessId === 'p3');
  assert.equal(f.length, 1);
  assert.equal(f[0].clientScope, 'client:cA');
  assert.ok(f[0].message.includes('Client Alpha'));
});

// ======================================================================
// dry-run behavior (binding + plan are projection-only)
// ======================================================================

test('dry-run: the binding performs ZERO notification calls — no reads, no writes', async () => {
  const { client } = await run();
  assert.deepEqual(client.__calls.notification, [], 'the binding must never touch the Notification entity');
});

test('dry-run: repeated runs project identical findings and identical plans (state unchanged)', async () => {
  const r1 = await run();
  const r2 = await run();
  assert.deepEqual(r1.findings, r2.findings);
  const existing = [{ id: 'e1', dedupe_key: 'review_overdue:s1', recipient_user_id: 'owner1', status: 'open', last_sent_at: iso(NOW - 3 * DAY) }];
  assert.deepEqual(
    planReconciliation(r1.findings, existing, NOW),
    planReconciliation(r2.findings, JSON.parse(JSON.stringify(existing)), NOW),
  );
});

test('dry-run counts: first run over empty state -> would_create equals the finding count, nothing else', async () => {
  const { findings } = await run();
  const plan = planReconciliation(findings, [], NOW);
  assert.deepEqual(plan.counts, {
    would_create: findings.length,
    would_remind: 0,
    would_resolve: 0,
    would_retarget: 0,
  });
});

test('reconciliation: second full cycle over simulated persisted state creates nothing new (per-pair episodes)', async () => {
  const { findings } = await run();
  const plan = planReconciliation(findings, [], NOW);
  let store = [];
  // apply plan (simulating write mode) — recipients keep their episodes
  store = plan.creates.reduce(
    (acc, c, i) => [...acc, { id: `n${i}`, ...rowFromDraft(c.draft, NOW), created_date: iso(NOW) }],
    [],
  );
  const plan2 = planReconciliation(findings, store, NOW);
  assert.equal(plan2.counts.would_create, 0);
  assert.equal(plan2.counts.would_resolve, 0);
  assert.equal(plan2.counts.would_retarget, 0);
  // weekly reminders (review_overdue / process_governance) would fire after 7d
  const plan3 = planReconciliation(findings, store, NOW + 7 * DAY);
  assert.equal(plan3.counts.would_remind, plan3.reminders.length);
  assert.ok(plan3.counts.would_remind > 0);
});