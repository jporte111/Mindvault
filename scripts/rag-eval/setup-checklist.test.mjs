// Onboarding-1 — pure tests for src/lib/setupChecklist.js.
// All 10 areas, every applicable state, and the exact semantic constraints from
// the correction. Deterministic; no score / percentage / weighted field.
//   node --test scripts/rag-eval/setup-checklist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveChecklistItems, completeCount, CHECKLIST_ITEM_IDS, CHECKLIST_STATES,
} from '../../src/lib/setupChecklist.js';

const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// fixtures --------------------------------------------------------------
// Every source / process fixture is firm-wide ('general') by default; the
// scope-isolation tests below opt into 'client-specific' / 'unclassified'.
const src = (o = {}) => ({ id: o.id || 's1', status: 'ready', knowledge_scope: 'general', verification_status: 'verified', ...o });
const proc = (o = {}) => ({ id: o.id || 'p1', status: 'active', knowledge_scope: 'general', criticality: 'high', process_owner: 'u1', subject_matter_expert: 'u2', review_interval_days: 90, ...o });
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

// ====================================================================
// SCOPE CONSISTENCY — the checklist is firm-wide / general setup only.
// Client-specific records never move a configured-count; unclassified
// knowledge is preserved ONLY for item 1. computeKnowledgeHealth is called
// once, for scope 'general', and never per client.
// ====================================================================

test('scope: a general process DOES affect the checklist (processes_created / criticality / owners)', () => {
  const items = byId(deriveChecklistItems(healthOn({
    processes: [proc({ id: 'g1', criticality: null, process_owner: null })],
  })));
  assert.equal(items.processes_created.state, 'Complete');       // it exists
  assert.equal(items.criticality_assigned.state, 'In progress'); // it lacks criticality
  assert.equal(items.owners_assigned.state, 'In progress');      // it lacks an owner (non-critical)
});

test('scope: a client-specific process does NOT affect the firm-wide process count', () => {
  const onlyClient = byId(deriveChecklistItems(healthOn({
    processes: [proc({ id: 'c1', knowledge_scope: 'client-specific', client_id: 'clientA' })],
  })));
  // no GENERAL processes -> every process item reads as if none exist
  assert.equal(onlyClient.processes_created.state, 'Not started');
  assert.equal(onlyClient.criticality_assigned.state, 'Not started');
  assert.equal(onlyClient.owners_assigned.state, 'Not started');

  // adding the client process to a firm-wide baseline changes nothing
  const base = deriveChecklistItems(healthOn({ processes: [proc({ id: 'g1' })] }));
  const withClient = deriveChecklistItems(healthOn({
    processes: [proc({ id: 'g1' }), proc({ id: 'c1', knowledge_scope: 'client-specific', client_id: 'clientA' })],
  }));
  assert.deepEqual(withClient, base);
});

test('scope: a client-A process missing an owner/SME does NOT change firm-wide items 4 & 5', () => {
  const items = byId(deriveChecklistItems(healthOn({
    processes: [
      proc({ id: 'g1' }), // fully configured general process
      proc({ id: 'cA', knowledge_scope: 'client-specific', client_id: 'clientA', criticality: 'mission_critical', process_owner: null, subject_matter_expert: null }),
    ],
  })));
  // the client-A gap must NOT bleed into the firm-wide owners/SMEs items
  assert.equal(items.owners_assigned.state, 'Complete');
  assert.equal(items.smes_assigned.state, 'Complete');
});

test('scope: client-A knowledge does NOT affect general cadence / linkage / verification counts', () => {
  const ctx = healthOn({
    sources: [
      src({ id: 'g1', operational_process_id: 'gp', source_review_interval_days: 90, verification_status: 'verified' }),
      // client-A source: no cadence, unlinked, unverified — all "bad", must be ignored
      src({ id: 'cA', knowledge_scope: 'client-specific', client_id: 'clientA', operational_process_id: null, source_review_interval_days: undefined, verification_status: 'unverified' }),
    ],
    processes: [proc({ id: 'gp', review_interval_days: 90 })],
  });
  const items = byId(deriveChecklistItems(ctx));
  assert.equal(items.review_cadence.state, 'Complete');       // only the general source counts
  assert.equal(items.knowledge_linked.state, 'Complete');     // only the general source counts
  assert.equal(items.knowledge_verification.state, 'Complete'); // only the general source counts

  // and the client source really is being dropped, not just outweighed
  const generalOnly = deriveChecklistItems(healthOn({
    sources: [src({ id: 'g1', operational_process_id: 'gp', source_review_interval_days: 90, verification_status: 'verified' })],
    processes: [proc({ id: 'gp', review_interval_days: 90 })],
  }));
  assert.deepEqual(deriveChecklistItems(ctx), generalOnly);
});

test('scope: active UNCLASSIFIED knowledge still makes Knowledge classified = In progress (not hidden)', () => {
  const items = byId(deriveChecklistItems(healthOn({
    sources: [
      src({ id: 'g1' }),
      src({ id: 'u1', knowledge_scope: 'unclassified' }),
      src({ id: 'u2', knowledge_scope: undefined }),
    ],
  })));
  assert.equal(items.knowledge_classified.state, 'In progress');
  assert.match(items.knowledge_classified.detail, /awaiting classification/i);
  // but unclassified knowledge does NOT count as a configured general source elsewhere
  assert.equal(items.knowledge_verification.state, 'Complete'); // only g1 (verified) is a general source
});

test('scope: a GENERAL established key-person dependency with no backup -> Needs attention', () => {
  const items = byId(deriveChecklistItems(healthOn({
    processes: [proc({ id: 'g1', backup_sme: null })],
    health: { processRows: [{ id: 'g1', governance: { backupKeyPerson: { status: 'needs_attention' } } }], setup: { legacyNeedingReindex: 0 } },
  })));
  assert.equal(items.backup_coverage.state, 'Needs attention');
});

test('scope: a client-specific established dependency is NOT silently mixed into firm-wide raw counts', () => {
  // The general health payload (scope:'general') is the ONLY key-person signal.
  // A client-specific process with a raw no-backup gap, absent from processRows,
  // must not flip backup_coverage, and must not inflate the general process items.
  const items = byId(deriveChecklistItems(healthOn({
    processes: [
      proc({ id: 'g1' }), // healthy general process, has backup by default? -> proc() has no backup_sme
      proc({ id: 'cA', knowledge_scope: 'client-specific', client_id: 'clientA', criticality: 'mission_critical', backup_sme: null }),
    ],
    health: { processRows: [{ id: 'g1', governance: { backupKeyPerson: { status: 'present' } } }], setup: { legacyNeedingReindex: 0 } },
  })));
  assert.equal(items.backup_coverage.state, 'Complete');   // general signal only, no needs_attention
  assert.equal(items.processes_created.state, 'Complete'); // g1
  assert.equal(items.criticality_assigned.state, 'Complete'); // g1 has 'high'
});

test('scope: no per-client computeKnowledgeHealth calls — health is fetched once for "general"', () => {
  const comp = read('src/components/onboarding/SetupChecklist.jsx');
  // exactly one health query, keyed to the general scope
  const healthQueryKeys = [...comp.matchAll(/queryKey:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  const healthKeys = healthQueryKeys.filter((k) => /knowledge-health/.test(k));
  assert.equal(healthKeys.length, 1, `expected 1 knowledge-health query, got ${healthKeys.length}`);
  assert.match(healthKeys[0], /'general'/);
  assert.match(comp, /fetchKnowledgeHealth\('general'\)/);
  // fetchKnowledgeHealth is called exactly once in the component, and only ever
  // with the 'general' argument (no per-client fan-out)
  const calls = [...comp.matchAll(/fetchKnowledgeHealth\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ["'general'"]);
  // and the pure module derives from a single `health` payload it is handed —
  // it never reaches for the health function itself
  const lib = read('src/lib/setupChecklist.js');
  assert.equal(/\bfetchKnowledgeHealth\s*\(/.test(lib), false);
  assert.equal(/\bcomputeKnowledgeHealth\s*\([a-zA-Z_$]/.test(lib), false); // a real call, not the "{ scope: 'general' }" doc reference
});
