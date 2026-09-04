// Onboarding-1 — pure tests for src/lib/setupChecklist.js.
// All 10 areas, every applicable state, and the exact semantic constraints from
// the correction. Deterministic; no score / percentage / weighted field.
//   node --test scripts/rag-eval/setup-checklist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveChecklistItems, completeCount, CHECKLIST_ITEM_IDS, CHECKLIST_STATES,
} from '../../src/lib/setupChecklist.js';

const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

// fixtures --------------------------------------------------------------
const src = (o = {}) => ({ id: o.id || 's1', status: 'ready', knowledge_scope: 'general', verification_status: 'verified', ...o });
const proc = (o = {}) => ({ id: o.id || 'p1', status: 'active', criticality: 'high', process_owner: 'u1', subject_matter_expert: 'u2', review_interval_days: 90, ...o });
const healthOn = (over = {}) => ({
  healthFlagOn: true,
  health: { processRows: [], setup: { legacyNeedingReindex: 0 }, ...over.health },
  sources: over.sources ?? [],
  processes: over.processes ?? [],
  continuityVisited: over.continuityVisited ?? false,
});

// ====================================================================
// shape / no score
// ====================================================================

test('returns exactly the 10 known items, in order; header is a Complete COUNT — no score field', () => {
  const items = deriveChecklistItems(healthOn());
  assert.deepEqual(items.map((i) => i.id), CHECKLIST_ITEM_IDS);
  assert.equal(items.length, 10);
  for (const it of items) {
    assert.ok(CHECKLIST_STATES.includes(it.state), `bad state ${it.state}`);
    assert.equal(typeof it.label, 'string');
    assert.equal(typeof it.detail, 'string');
    assert.ok(it.detail.length > 0);
  }
  const blob = JSON.stringify(items);
  assert.equal(/"score"|percent|weight|grade|overall/i.test(blob), false);
  assert.equal(typeof completeCount(items), 'number');
});

test('deterministic: identical ctx -> deep-equal output', () => {
  const ctx = healthOn({ sources: [src(), src({ id: 's2', knowledge_scope: 'unclassified' })], processes: [proc()] });
  assert.deepEqual(deriveChecklistItems(ctx), deriveChecklistItems(ctx));
});

// ====================================================================
// 1 — Knowledge classified
// ====================================================================

test('1 knowledge_classified: none / unclassified / clean / legacy elevation', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [] }))).knowledge_classified.state, 'Not started');
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [src(), src({ id: 's2', knowledge_scope: 'unclassified' })] }))).knowledge_classified.state, 'In progress');
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [src(), src({ id: 's2' })] }))).knowledge_classified.state, 'Complete');
  // legacy elevates Complete -> Needs attention ONLY via the established field
  const legacy = byId(deriveChecklistItems(healthOn({ sources: [src()], health: { processRows: [], setup: { legacyNeedingReindex: 2 } } }))).knowledge_classified;
  assert.equal(legacy.state, 'Needs attention');
  // and never from Not started
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [], health: { processRows: [], setup: { legacyNeedingReindex: 5 } } }))).knowledge_classified.state, 'Not started');
});

// ====================================================================
// 2 & 3 — processes-created is existence-only; criticality is separate
// ====================================================================

test('2 processes_created depends ONLY on existence, never on criticality', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [] }))).processes_created.state, 'Not started');
  // all missing criticality -> processes_created is still Complete
  const c = byId(deriveChecklistItems(healthOn({ processes: [proc({ criticality: null }), proc({ id: 'p2', criticality: null })] })));
  assert.equal(c.processes_created.state, 'Complete');
  assert.equal(c.criticality_assigned.state, 'In progress'); // the separate item catches it
});

test('3 criticality_assigned: not started / in progress / complete — no minimum high/mc count', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [] }))).criticality_assigned.state, 'Not started');
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc(), proc({ id: 'p2', criticality: null })] }))).criticality_assigned.state, 'In progress');
  // all 'low' criticality still counts as Complete (no requirement for high/mc)
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc({ criticality: 'low' }), proc({ id: 'p2', criticality: 'low' })] }))).criticality_assigned.state, 'Complete');
});

// ====================================================================
// 4 & 5 — owners / SMEs (critical distinction from raw fields)
// ====================================================================

test('4 owners_assigned: none / in progress / needs attention on critical / complete', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [] }))).owners_assigned.state, 'Not started');
  // a non-critical process missing an owner -> In progress
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc(), proc({ id: 'p2', criticality: 'low', process_owner: null })] }))).owners_assigned.state, 'In progress');
  // a CRITICAL process missing an owner -> Needs attention
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc({ criticality: 'mission_critical', process_owner: null })] }))).owners_assigned.state, 'Needs attention');
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc(), proc({ id: 'p2' })] }))).owners_assigned.state, 'Complete');
});

test('5 smes_assigned mirrors owners on the SME field', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc({ criticality: 'high', subject_matter_expert: null })] }))).smes_assigned.state, 'Needs attention');
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc(), proc({ id: 'p2', criticality: 'low', subject_matter_expert: null })] }))).smes_assigned.state, 'In progress');
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [proc()] }))).smes_assigned.state, 'Complete');
});

// ====================================================================
// 6 — Backup coverage: established key-person signal ONLY
// ====================================================================

test('6 backup_coverage: high/mission-critical + no backup ALONE does NOT create a requirement', () => {
  // health payload present, but NO row has an established key-person needs_attention
  const noSignal = healthOn({
    processes: [proc({ criticality: 'mission_critical', backup_sme: null })],
    health: { processRows: [{ id: 'p1', governance: { backupKeyPerson: { status: 'missing' } } }], setup: { legacyNeedingReindex: 0 } },
  });
  assert.equal(byId(deriveChecklistItems(noSignal)).backup_coverage.state, 'Complete');
});

test('6 backup_coverage: an ESTABLISHED key-person dependency with a missing backup DOES', () => {
  const signal = healthOn({
    processes: [proc({ backup_sme: null })],
    health: { processRows: [{ id: 'p1', governance: { backupKeyPerson: { status: 'needs_attention' } } }], setup: { legacyNeedingReindex: 0 } },
  });
  assert.equal(byId(deriveChecklistItems(signal)).backup_coverage.state, 'Needs attention');
});

test('6 backup_coverage: Unknown when the health signal is unavailable; Not started when no processes', () => {
  assert.equal(byId(deriveChecklistItems({ healthFlagOn: false, health: null, sources: [], processes: [proc()] })).backup_coverage.state, 'Unknown');
  assert.equal(byId(deriveChecklistItems(healthOn({ processes: [] }))).backup_coverage.state, 'Not started');
});

// ====================================================================
// 7 — Review cadence (source override OR inherited from the linked process)
// ====================================================================

test('7 review_cadence: none / in progress / complete; inherited cadence counts', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [], processes: [] }))).review_cadence.state, 'Not started');
  // source has no own cadence but its linked process does -> counts as covered
  const inherited = healthOn({
    sources: [src({ operational_process_id: 'p1', source_review_interval_days: undefined })],
    processes: [proc({ id: 'p1', review_interval_days: 30 })],
  });
  assert.equal(byId(deriveChecklistItems(inherited)).review_cadence.state, 'Complete');
  // no own, no inherited -> In progress
  const missing = healthOn({ sources: [src({ operational_process_id: 'p1', source_review_interval_days: undefined })], processes: [proc({ id: 'p1', review_interval_days: undefined })] });
  assert.equal(byId(deriveChecklistItems(missing)).review_cadence.state, 'In progress');
});

// ====================================================================
// 8 — Knowledge linked to processes
// ====================================================================

test('8 knowledge_linked: none / in progress / complete', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [], processes: [] }))).knowledge_linked.state, 'Not started');
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [src({ operational_process_id: null })], processes: [proc()] }))).knowledge_linked.state, 'In progress');
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [src({ operational_process_id: 'p1' })], processes: [proc({ id: 'p1' })] }))).knowledge_linked.state, 'Complete');
});

// ====================================================================
// 9 — Knowledge verification: the actual verification STATE, not a "review"
// ====================================================================

test('9 knowledge_verification describes verification state (label + copy), not whether a human reviewed a backlog', () => {
  const items = deriveChecklistItems(healthOn({ sources: [src({ verification_status: 'unverified' })], processes: [] }));
  const v = byId(items).knowledge_verification;
  assert.equal(v.label, 'Knowledge verification');
  assert.equal(/review(ed)? a backlog|someone reviewed/i.test(v.detail), false);
  assert.equal(v.state, 'In progress'); // active unverified, none critical-linked
});

test('9 knowledge_verification: none / complete / needs-attention when critical-linked', () => {
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [] }))).knowledge_verification.state, 'Not started');
  assert.equal(byId(deriveChecklistItems(healthOn({ sources: [src({ verification_status: 'verified' })] }))).knowledge_verification.state, 'Complete');
  const crit = healthOn({
    sources: [src({ verification_status: 'unverified', operational_process_id: 'p1' })],
    processes: [proc({ id: 'p1', criticality: 'mission_critical' })],
  });
  assert.equal(byId(deriveChecklistItems(crit)).knowledge_verification.state, 'Needs attention');
});

// ====================================================================
// 10 — Continuity dashboard reviewed: NEVER completed by a snapshot existing
// ====================================================================

test('10 continuity_reviewed: disabled -> Not started; enabled+unvisited -> In progress; visited -> Complete', () => {
  assert.equal(byId(deriveChecklistItems({ healthFlagOn: false, health: null, sources: [], processes: [] })).continuity_reviewed.state, 'Not started');
  assert.equal(byId(deriveChecklistItems(healthOn({ continuityVisited: false }))).continuity_reviewed.state, 'In progress');
  assert.equal(byId(deriveChecklistItems(healthOn({ continuityVisited: true }))).continuity_reviewed.state, 'Complete');
});

test('10 continuity_reviewed: a KnowledgeHealthSnapshot existing does NOT complete it', () => {
  // deriveChecklistItems has no snapshot input at all; feed a health payload
  // that (hypothetically) carried snapshot info and confirm it is ignored.
  const withSnapshotNoise = healthOn({ continuityVisited: false, health: { processRows: [], setup: { legacyNeedingReindex: 0 }, snapshotCount: 12, snapshots: [{}] } });
  assert.equal(byId(deriveChecklistItems(withSnapshotNoise)).continuity_reviewed.state, 'In progress');
});

// ====================================================================
// degradation: nothing loaded -> Unknown / Not started, never a crash
// ====================================================================

test('null sources/processes -> Unknown where data is required; never throws', () => {
  const items = deriveChecklistItems({ healthFlagOn: false, health: null, sources: null, processes: null, continuityVisited: false });
  assert.equal(items.length, 10);
  assert.equal(byId(items).knowledge_classified.state, 'Unknown');
  assert.equal(byId(items).processes_created.state, 'Unknown');
});
