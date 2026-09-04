// Onboarding-1 — concept-help copy, checklist copy, empty-state copy, and the
// user-facing terminology cleanup. No implementation jargon in anything a
// customer reads; legacy nouns ("Training(s)", "All Trainings") gone from
// user-visible strings while internal identifiers stay unchanged.
//   node --test scripts/rag-eval/onboarding-copy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONCEPT_HELP, CONCEPT_HELP_KEYS } from '../../src/lib/conceptHelp.js';
import { deriveChecklistItems } from '../../src/lib/setupChecklist.js';

const HERE = new URL('.', import.meta.url);
const read = (p) => readFileSync(new URL(`../../${p}`, HERE), 'utf8');

// Words that are implementation details, never admin-facing product concepts.
const BANNED_JARGON = /\b(embeddings?|vector(s| retrieval)?|\bRAG\b|schema|fingerprints?|lifecycle engine|re-?index(ing|ed)?|\bchunk(s|ed)?\b|payload)\b/i;

// ====================================================================
// concept-help copy
// ====================================================================

test('CONCEPT_HELP covers the 13 required concepts, each with a term + plain text', () => {
  const required = ['scope', 'owner', 'sme', 'backup_sme', 'criticality', 'review_cadence',
    'verification', 'coverage', 'continuity_exposure', 'key_person', 'knowledge_gap', 'snapshot', 'what_changed'];
  assert.deepEqual([...CONCEPT_HELP_KEYS].sort(), [...required].sort());
  for (const k of required) {
    assert.equal(typeof CONCEPT_HELP[k].term, 'string');
    assert.ok(CONCEPT_HELP[k].term.length > 0);
    assert.ok(CONCEPT_HELP[k].text.length > 20, `${k} text too short`);
  }
});

test('CONCEPT_HELP contains NO implementation jargon', () => {
  for (const [k, v] of Object.entries(CONCEPT_HELP)) {
    assert.equal(BANNED_JARGON.test(v.term), false, `${k}.term: "${v.term}"`);
    assert.equal(BANNED_JARGON.test(v.text), false, `${k}.text: "${v.text}"`);
  }
});

// ====================================================================
// checklist copy
// ====================================================================

test('checklist labels + detail strings contain no implementation jargon (across every state)', () => {
  const src = (o = {}) => ({ id: o.id || 's', status: 'ready', knowledge_scope: 'general', verification_status: 'verified', ...o });
  const proc = (o = {}) => ({ id: o.id || 'p', status: 'active', knowledge_scope: 'general', criticality: 'high', process_owner: 'u', subject_matter_expert: 'u2', review_interval_days: 90, ...o });
  const ctxs = [
    { healthFlagOn: false, health: null, sources: null, processes: null, continuityVisited: false },
    { healthFlagOn: true, health: { processRows: [], setup: { legacyNeedingReindex: 3 } }, sources: [src()], processes: [], continuityVisited: false },
    { healthFlagOn: true, health: { processRows: [{ id: 'p', governance: { backupKeyPerson: { status: 'needs_attention' } } }], setup: { legacyNeedingReindex: 0 } },
      sources: [src({ verification_status: 'unverified', operational_process_id: 'p' })], processes: [proc({ id: 'p', criticality: 'mission_critical', backup_sme: null })], continuityVisited: true },
  ];
  for (const ctx of ctxs) {
    for (const it of deriveChecklistItems(ctx)) {
      assert.equal(BANNED_JARGON.test(it.label), false, `label "${it.label}"`);
      assert.equal(BANNED_JARGON.test(it.detail), false, `detail "${it.detail}"`);
      assert.equal(BANNED_JARGON.test(it.actionLabel), false, `actionLabel "${it.actionLabel}"`);
      assert.equal(/\btraining(s)?\b/i.test(it.label + it.detail + it.actionLabel), false, 'no "training" noun');
    }
  }
});

// ====================================================================
// empty-state + component copy — no jargon, employee actions safe
// ====================================================================

test('EmptyState is a shared component; onboarding + changed pages carry no jargon in visible copy', () => {
  const files = [
    'src/components/common/EmptyState.jsx',
    'src/components/onboarding/SetupChecklist.jsx',
    'src/components/onboarding/Walkthrough.jsx',
    'src/components/onboarding/ConceptHelp.jsx',
    'src/lib/walkthroughSteps.js',
    'src/pages/Library.jsx',
    'src/pages/Chat.jsx',
    'src/pages/MyQuestions.jsx',
    'src/pages/Continuity.jsx',
    'src/pages/Admin.jsx',
  ];
  // crude visible-string scan: quoted strings that look like sentences
  const sentence = /(["'`])([A-Z][^"'`]{15,})\1/g;
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(sentence)) {
      const text = m[2];
      assert.equal(BANNED_JARGON.test(text), false, `${f}: "${text}"`);
    }
  }
});

test('Chat empty state: the admin-only action is gated behind isAdmin', () => {
  const s = read('src/pages/Chat.jsx');
  // the "add and classify" instruction only appears in the isAdmin branch
  assert.ok(/isAdmin\s*\?\s*['"]Add and classify knowledge sources/.test(s.replace(/\s+/g, ' ')));
  assert.ok(/:\s*['"]Ask an admin to add and classify/.test(s.replace(/\s+/g, ' ')));
});

// ====================================================================
// terminology cleanup — legacy nouns gone from user-visible strings,
// internal identifiers untouched
// ====================================================================

test('legacy user-facing nouns removed from the changed files', () => {
  const admin = read('src/pages/Admin.jsx');
  assert.equal(admin.includes('All Trainings'), false);
  assert.equal(admin.includes('Total Trainings'), false);
  assert.equal(admin.includes('No trainings yet'), false);
  assert.equal(admin.includes('No new trainings found'), false);
  assert.equal(admin.includes('new training(s)!'), false);
  assert.equal(read('src/components/knowledge/TrainingCard.jsx').includes("'Training deleted'"), false);
  assert.equal(read('src/components/knowledge/SubmitRecordingModal.jsx').includes('"All Trainings"'), false);
  // Chat placeholder / empty state no longer say "trainings"
  const chat = read('src/pages/Chat.jsx');
  assert.equal(/No analyzed trainings yet/.test(chat), false);
  assert.equal(/sync trainings first/.test(chat), false);
});

test('internal identifiers are unchanged (Training entity, query keys, /training/:id, prop names)', () => {
  const admin = read('src/pages/Admin.jsx');
  assert.ok(admin.includes("base44.entities.Training.list"));           // entity name kept
  assert.ok(admin.includes("queryKey: ['all-trainings']"));             // query key kept
  assert.ok(read('src/App.jsx').includes('/training/:id'));             // route kept
  assert.ok(read('src/components/knowledge/TrainingCard.jsx').includes('training.id')); // prop names kept
});

test('preferred terminology present where expected', () => {
  assert.ok(read('src/pages/Admin.jsx').includes('All knowledge sources'));
  assert.ok(read('src/pages/Admin.jsx').includes('Total knowledge sources'));
  assert.ok(read('src/components/knowledge/TrainingCard.jsx').includes("'Knowledge source removed'"));
});

// ====================================================================
// admin-only: SetupChecklist self-guards; not mounted on employee pages
// ====================================================================

test('SetupChecklist is admin-guarded and only mounted on the Admin page', () => {
  const comp = read('src/components/onboarding/SetupChecklist.jsx');
  assert.ok(/useIsAdmin\(\)/.test(comp));
  assert.ok(/if \(!isAdmin\) return null/.test(comp));
  assert.ok(read('src/pages/Admin.jsx').includes('<SetupChecklist />'));
  for (const p of ['src/pages/Library.jsx', 'src/pages/Chat.jsx', 'src/pages/MyQuestions.jsx']) {
    assert.equal(read(p).includes('SetupChecklist'), false, `${p} must not mount the setup checklist`);
  }
});

test('Onboarding-2 walkthrough / concept-help copy reintroduces no legacy "Training(s)" noun', () => {
  for (const f of ['src/lib/walkthroughSteps.js', 'src/components/onboarding/Walkthrough.jsx', 'src/components/onboarding/ConceptHelp.jsx']) {
    const s = read(f);
    assert.equal(/\btraining(s)?\b/i.test(s.replace(/training\.id|Training\.(list|get|create|update)|\/training\//g, '')), false, `${f} reintroduces "training(s)" in visible copy`);
  }
});

test('Onboarding-2 walkthrough step copy also bans "retrieval" and standalone "index" (spec-specific additions)', () => {
  const s = read('src/lib/walkthroughSteps.js');
  const copy = [...s.matchAll(/(title|copy|secondary|actionLabel):\s*'([^']*)'/g)].map((m) => m[2]).join(' ');
  assert.equal(/\bretrieval\b/i.test(copy), false);
  assert.equal(/\bindex(ing|ed)?\b/i.test(copy), false);
});

test('setupChecklist.js is pure — no imports, no Base44 / network / storage', () => {
  const s = read('src/lib/setupChecklist.js');
  assert.equal(/^\s*import\s/m.test(s), false);
  assert.equal(/base44|localStorage|fetch\(|InvokeLLM|Math\.random/.test(s), false);
});
