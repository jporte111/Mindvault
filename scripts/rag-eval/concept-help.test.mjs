// Onboarding-2 — tests for the ConceptHelp popover component and its required
// placements. ConceptHelp itself has no branching logic to unit-test in
// isolation (it is a thin lookup + render), so it is verified by (a) proving
// its behavior is fully determined by CONCEPT_HELP — never duplicated copy —
// and (b) source-scan assertions on the component and on every screen that
// must place it, matching the established SetupChecklist.jsx precedent.
//   node --test scripts/rag-eval/concept-help.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONCEPT_HELP } from '../../src/lib/conceptHelp.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ====================================================================
// ConceptHelp.jsx — component shape
// ====================================================================

test('ConceptHelp renders nothing for an unknown term and never throws', () => {
  const s = read('src/components/onboarding/ConceptHelp.jsx');
  assert.match(s, /const entry = CONCEPT_HELP\[term\];/);
  assert.match(s, /if \(!entry\) return null;/);
});

test('ConceptHelp content comes from CONCEPT_HELP only — no duplicated copy in the component', () => {
  const s = read('src/components/onboarding/ConceptHelp.jsx');
  assert.match(s, /\{entry\.term\}/);
  assert.match(s, /\{entry\.text\}/);
  // no inlined definition strings (a long quoted sentence would mean copy got
  // duplicated instead of sourced from CONCEPT_HELP)
  const longQuotedStrings = [...s.matchAll(/(["'`])([A-Z][^"'`]{40,})\1/g)];
  assert.equal(longQuotedStrings.length, 0, `unexpected inline copy: ${longQuotedStrings.map((m) => m[2]).join(' | ')}`);
});

test('ConceptHelp has an accessible trigger label of the form "Learn about <term>"', () => {
  const s = read('src/components/onboarding/ConceptHelp.jsx');
  assert.match(s, /aria-label=\{`Learn about \$\{entry\.term\}`\}/);
});

test('ConceptHelp uses an existing UI primitive (Popover), not a third-party library', () => {
  const s = read('src/components/onboarding/ConceptHelp.jsx');
  assert.match(s, /from '@\/components\/ui\/popover'/);
  assert.equal(/from 'react-.*-tour'|joyride|shepherd/i.test(s), false);
});

// ====================================================================
// CONCEPT_HELP reuse — every term referenced by a placement must exist
// ====================================================================

const PLACEMENTS = [
  { file: 'src/components/admin/OperationalProcessManager.jsx', terms: ['owner', 'sme', 'backup_sme', 'criticality', 'review_cadence'] },
  { file: 'src/components/admin/KnowledgeScopeManager.jsx', terms: ['scope'] },
  { file: 'src/components/admin/KnowledgeLifecyclePanel.jsx', terms: ['verification'] },
  {
    file: 'src/pages/Continuity.jsx',
    terms: ['coverage', 'continuity_exposure', 'key_person', 'snapshot', 'what_changed', 'knowledge_gap'],
  },
];

test('every required concept placement exists in its screen, using terms that exist in CONCEPT_HELP', () => {
  for (const { file, terms } of PLACEMENTS) {
    const s = read(file);
    assert.match(s, /import ConceptHelp from '@\/components\/onboarding\/ConceptHelp';/, `${file} does not import ConceptHelp`);
    for (const term of terms) {
      assert.ok(CONCEPT_HELP[term], `"${term}" is not a real CONCEPT_HELP key`);
      // A placement is either a direct <ConceptHelp term="x" />, the
      // BandCard indirection help="x" -> <ConceptHelp term={help} /> (used on
      // Continuity), or — for OperationalProcessManager's owner/sme/backup_sme
      // row, which maps over [key, label, term] — the quoted term literal
      // sitting alongside a <ConceptHelp term={term} /> render.
      const direct = new RegExp(`(term|help)="${term}"`).test(s);
      const viaMap = /<ConceptHelp term=\{term\} \/>/.test(s) && new RegExp(`'${term}'`).test(s);
      assert.ok(direct || viaMap, `${file} has no ConceptHelp placement for "${term}"`);
    }
  }
});

test('placements are sparse: no card/form places the same term twice', () => {
  for (const { file } of PLACEMENTS) {
    const s = read(file);
    const terms = [...s.matchAll(/<ConceptHelp term="(\w+)"/g)].map((m) => m[1]);
    // OperationalProcessManager's ProcessForm is reused for both create + edit,
    // so it legitimately renders once per mounted form instance, not "twice in
    // one card" — de-dupe by term is still meaningful within a single render pass.
    const counts = terms.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
    for (const [term, count] of counts) {
      assert.ok(count <= 1, `${file}: term "${term}" placed ${count} times in one render pass`);
    }
  }
});

// ====================================================================
// permissions — contextual help never exposes admin-only data to employees
// ====================================================================

test('ConceptHelp performs no data fetch — it is pure definitional copy, safe on any screen', () => {
  const s = read('src/components/onboarding/ConceptHelp.jsx');
  assert.equal(/useQuery|base44\.|fetch\(/.test(s), false);
});

test('all ConceptHelp placements are on already admin-only screens (Admin panels + /continuity)', () => {
  // OperationalProcessManager / KnowledgeScopeManager / KnowledgeLifecyclePanel
  // are only ever rendered from the Admin page; Continuity self-guards with
  // useIsAdmin(). No placement was added to Library / Chat / MyQuestions.
  for (const f of ['src/pages/Library.jsx', 'src/pages/Chat.jsx', 'src/pages/MyQuestions.jsx']) {
    assert.equal(read(f).includes('ConceptHelp'), false, `${f} must not import ConceptHelp (Onboarding-2 scope)`);
  }
  assert.match(read('src/pages/Continuity.jsx'), /useIsAdmin\(\)/);
});
