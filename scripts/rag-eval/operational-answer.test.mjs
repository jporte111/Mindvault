// Phase 4 — pure tests for base44/shared/operationalAnswer.ts: the assembly +
// validation layer for Operational Guidance answer mode. NO Base44, NO network.
//   node --test scripts/rag-eval/operational-answer.test.mjs
//
// The answer LLM only PROPOSES structure; every decision asserted here is made
// in code. Fixtures are run with AND without chunk `embedding` fields to prove
// nothing branches on semantic vs lexical mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATIONAL_SECTION_KEYS,
  INSUFFICIENT_MESSAGE,
  isOperationalIntent,
  validateRequestedFacets,
  buildFacetInventory,
  validateSections,
  classifySectionAuthority,
  shouldKeepContradictionNote,
  deriveAnswerStatus,
  stalenessFlags,
  flattenToMarkdown,
} from '../../base44/shared/operationalAnswer.ts';
import { parseCitations } from '../../base44/shared/retrieval.ts';

// ranked-chunk fixture; `withEmbedding` toggles a semantic-looking vector on.
const rc = (o, withEmbedding = false) => ({
  chunk: {
    id: o.id,
    training_id: o.training_id || o.id,
    title: o.title || o.id,
    chunk_type: o.chunk_type,
    source_authority: o.source_authority,
    process_freshness_status: o.process_freshness_status,
    verification_status: o.verification_status,
    ...(withEmbedding ? { embedding: [0.1, 0.9, 0, 0] } : {}),
  },
});

// ======================================================================
// isOperationalIntent
// ======================================================================

test('isOperationalIntent: procedure/decision_rule/troubleshooting -> true; others -> false', () => {
  for (const i of ['procedure', 'decision_rule', 'troubleshooting']) assert.equal(isOperationalIntent(i), true);
  for (const i of ['definition', 'overview', 'other', '', null, undefined]) assert.equal(isOperationalIntent(i), false);
});

// ======================================================================
// validateRequestedFacets — enum validation IS unit-tested; LLM detection isn't
// ======================================================================

test('validateRequestedFacets: keeps known keys, drops unknown, dedupes, non-array -> []', () => {
  assert.deepEqual(
    validateRequestedFacets(['approvals', 'steps', 'approvals', 'nonsense', 42, null]),
    ['approvals', 'steps'],
  );
  assert.deepEqual(validateRequestedFacets('approvals'), []);
  assert.deepEqual(validateRequestedFacets(undefined), []);
  assert.deepEqual(validateRequestedFacets([]), []);
});

// ======================================================================
// buildFacetInventory — diagnostics/prompt only
// ======================================================================

test('buildFacetInventory: maps chunk_types to sections, ordered, deduped', () => {
  const ranked = [
    rc({ id: 'a', chunk_type: 'sop_step' }),
    rc({ id: 'b', chunk_type: 'approval' }),
    rc({ id: 'c', chunk_type: 'decision_rule' }), // also -> steps
    rc({ id: 'd', chunk_type: 'summary' }), // -> nothing
  ];
  assert.deepEqual(buildFacetInventory(ranked), ['steps', 'approvals']);
  assert.deepEqual(buildFacetInventory([]), []);
});

// ======================================================================
// validateSections — drop uncited items / empty sections / unknown keys
// ======================================================================

test('validateSections: drops items with no citation, removes emptied sections', () => {
  const { sections, directAnswerValid } = validateSections({
    directAnswer: { text: 'Do X then Y [S1]', citations: [0] },
    sections: [
      { key: 'steps', items: [
        { text: 'grounded [S1]', citations: [0] },
        { text: 'ungrounded, no marker', citations: [] },
      ] },
      { key: 'approvals', items: [{ text: 'uncited [S9]', citations: [] }] }, // -> emptied -> removed
      { key: 'not_a_real_key', items: [{ text: 'x [S1]', citations: [0] }] }, // -> unknown key -> removed
    ],
  });
  assert.equal(directAnswerValid, true);
  assert.deepEqual(sections.map((s) => s.key), ['steps']);
  assert.equal(sections[0].items.length, 1);
});

test('validateSections: direct answer with no citation -> directAnswerValid false', () => {
  const { directAnswerValid } = validateSections({
    directAnswer: { text: 'a confident but ungrounded claim', citations: [] },
    sections: [],
  });
  assert.equal(directAnswerValid, false);
});

// ======================================================================
// classifySectionAuthority — missing authority is `unknown`, never `advisory`
// ======================================================================

const AUTH_POOL = [
  rc({ id: '0', source_authority: 'policy' }),
  rc({ id: '1', source_authority: 'approved_sop' }),
  rc({ id: '2', source_authority: 'training' }),
  rc({ id: '3', source_authority: 'notes' }),
  rc({ id: '4' }), // no source_authority
  rc({ id: '5', source_authority: 'weird_value' }),
];

test('classifySectionAuthority: all authoritative -> authoritative', () => {
  assert.equal(classifySectionAuthority([0, 1], AUTH_POOL), 'authoritative');
});

test('classifySectionAuthority: all explicit training/reference/notes -> advisory', () => {
  assert.equal(classifySectionAuthority([2, 3], AUTH_POOL), 'advisory');
});

test('classifySectionAuthority: all missing source_authority -> unknown (NOT advisory)', () => {
  assert.equal(classifySectionAuthority([4], AUTH_POOL), 'unknown');
  assert.equal(classifySectionAuthority([4, 5], AUTH_POOL), 'unknown'); // unrecognized value == unknown
  assert.equal(classifySectionAuthority([], AUTH_POOL), 'unknown');
});

test('classifySectionAuthority: any category mix -> mixed', () => {
  assert.equal(classifySectionAuthority([0, 2], AUTH_POOL), 'mixed'); // auth + advisory
  assert.equal(classifySectionAuthority([0, 4], AUTH_POOL), 'mixed'); // auth + unknown
  assert.equal(classifySectionAuthority([2, 4], AUTH_POOL), 'mixed'); // advisory + unknown
});

// ======================================================================
// shouldKeepContradictionNote
// ======================================================================

test('shouldKeepContradictionNote: >=2 distinct citations -> true; fewer -> false', () => {
  assert.equal(shouldKeepContradictionNote([0, 2]), true);
  assert.equal(shouldKeepContradictionNote([1]), false);
  assert.equal(shouldKeepContradictionNote([3, 3]), false); // duplicates don't count
  assert.equal(shouldKeepContradictionNote([]), false);
});

// ======================================================================
// deriveAnswerStatus — coverage proven by SURVIVING SECTIONS, not raw inventory
// ======================================================================

const baseInput = {
  baseBand: 'high',
  directAnswerValid: true,
  requestedFacets: [],
  survivingSectionKeys: [],
  contradictionNoteKept: false,
};

test('deriveAnswerStatus: base band low -> INSUFFICIENT even with valid sections', () => {
  const r = deriveAnswerStatus({ ...baseInput, baseBand: 'low', survivingSectionKeys: ['steps', 'approvals'] });
  assert.equal(r.status, 'INSUFFICIENT');
  assert.deepEqual(r.missingFacets, []);
});

test('deriveAnswerStatus: no citation-valid direct answer -> INSUFFICIENT', () => {
  assert.equal(deriveAnswerStatus({ ...baseInput, directAnswerValid: false }).status, 'INSUFFICIENT');
});

test('deriveAnswerStatus: every requested facet has a surviving section -> HIGH', () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ['steps', 'approvals'],
    survivingSectionKeys: ['steps', 'approvals', 'watch_outs'],
  });
  assert.equal(r.status, 'HIGH');
  assert.deepEqual(r.missingFacets, []);
});

test('deriveAnswerStatus: requested facet with NO surviving section -> PARTIAL + missingFacets', () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ['steps', 'approvals'],
    survivingSectionKeys: ['steps'],
  });
  assert.equal(r.status, 'PARTIAL');
  assert.deepEqual(r.missingFacets, ['approvals']);
});

test('deriveAnswerStatus: coverage comes from surviving sections, NOT buildFacetInventory', () => {
  // The retrieval pool DOES contain an `approval` chunk...
  const ranked = [rc({ id: 'a', chunk_type: 'sop_step' }), rc({ id: 'b', chunk_type: 'approval' })];
  assert.ok(buildFacetInventory(ranked).includes('approvals'), 'inventory has approvals');
  // ...but the LLM's approvals section was dropped by validateSections (uncited).
  const { sections } = validateSections({
    directAnswer: { text: 'answer [S1]', citations: [0] },
    sections: [
      { key: 'steps', items: [{ text: 'step [S1]', citations: [0] }] },
      { key: 'approvals', items: [{ text: 'guess about approver', citations: [] }] },
    ],
  });
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ['approvals'],
    survivingSectionKeys: sections.map((s) => s.key),
  });
  assert.equal(r.status, 'PARTIAL', 'inventory must not mask an unanswered facet');
  assert.deepEqual(r.missingFacets, ['approvals']);
});

test('deriveAnswerStatus: kept contradiction note caps status at PARTIAL even with full coverage', () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ['approvals'],
    survivingSectionKeys: ['approvals'],
    contradictionNoteKept: true,
  });
  assert.equal(r.status, 'PARTIAL');
});

test('deriveAnswerStatus: no requested facets + valid direct answer -> HIGH', () => {
  assert.equal(deriveAnswerStatus(baseInput).status, 'HIGH');
});

// ======================================================================
// stalenessFlags — cited subset only, denormalized metadata
// ======================================================================

test('stalenessFlags: stale chunk listed (deduped by training_id); unverified flips the bool', () => {
  const cited = [
    { training_id: 't1', title: 'Recon SOP', process_freshness_status: 'stale', verification_status: 'verified' },
    { training_id: 't1', title: 'Recon SOP', process_freshness_status: 'stale', verification_status: 'verified' },
    { training_id: 't2', title: 'Payroll', process_freshness_status: 'current', verification_status: 'unverified' },
  ];
  const r = stalenessFlags(cited);
  assert.deepEqual(r.stale_sources, [{ id: 't1', title: 'Recon SOP' }]);
  assert.equal(r.unverified_used, true);
});

test('stalenessFlags: all verified + current -> nothing flagged', () => {
  const r = stalenessFlags([{ training_id: 't1', title: 'X', process_freshness_status: 'current', verification_status: 'verified' }]);
  assert.deepEqual(r.stale_sources, []);
  assert.equal(r.unverified_used, false);
});

test('stalenessFlags: missing verification_status counts as unverified', () => {
  assert.equal(stalenessFlags([{ training_id: 't1', title: 'X' }]).unverified_used, true);
});

// ======================================================================
// flattenToMarkdown — deterministic, preserves [S#]
// ======================================================================

const sampleAnswer = {
  direct_answer: { text: 'Post the invoice against the draw schedule [S1].', citations: [0], authority: 'authoritative' },
  sections: [
    { key: 'steps', title: 'Steps', authority: 'authoritative', items: [
      { text: 'Pull the draw request [S1].', citations: [0] },
      { text: 'Attach the wire confirmation [S2].', citations: [1] },
    ] },
    { key: 'approvals', title: 'Approvals', authority: 'advisory', items: [
      { text: 'The controller signs off [S2].', citations: [1] },
    ] },
  ],
  missing_facets: ['exceptions'],
  contradiction_note: null,
  stale_sources: [],
  unverified_used: false,
};

test('flattenToMarkdown: INSUFFICIENT -> the standard message', () => {
  assert.equal(flattenToMarkdown(sampleAnswer, 'INSUFFICIENT'), INSUFFICIENT_MESSAGE);
  assert.equal(
    flattenToMarkdown({ ...sampleAnswer, direct_answer: null, sections: [] }, 'HIGH'),
    INSUFFICIENT_MESSAGE,
  );
});

test('flattenToMarkdown: deterministic, numbered steps, every [S#] preserved', () => {
  const md = flattenToMarkdown(sampleAnswer, 'PARTIAL');
  assert.equal(md, flattenToMarkdown(sampleAnswer, 'PARTIAL')); // deterministic
  assert.ok(md.includes('1. Pull the draw request [S1].'));
  assert.ok(md.includes('2. Attach the wire confirmation [S2].'));
  assert.ok(md.includes('**Approvals**'));
  assert.ok(md.includes('**Not documented:** Exceptions.'));
  // parseCitations over the flattened text is a subset of the section citations
  const flat = parseCitations(md, 3);
  const declared = new Set([0, 1]);
  for (const c of flat) assert.ok(declared.has(c), `flattened text cited [S${c + 1}] which no item declared`);
});

test('flattenToMarkdown: contradiction / stale / unverified footnotes render when present', () => {
  const md = flattenToMarkdown({
    ...sampleAnswer,
    contradiction_note: '[S1] says the controller approves; [S2] says the partner does.',
    stale_sources: [{ id: 't9', title: 'Old Vendor Policy' }],
    unverified_used: true,
  }, 'PARTIAL');
  assert.ok(md.includes('_[S1] says the controller approves; [S2] says the partner does._'));
  assert.ok(md.includes('overdue for review: Old Vendor Policy'));
  assert.ok(md.includes('_Based on unverified knowledge._'));
});

// ======================================================================
// semantic vs lexical parity — nothing branches on embeddings
// ======================================================================

test('parity: validateSections / classifySectionAuthority / deriveAnswerStatus ignore embeddings', () => {
  const mk = (withEmb) => [
    rc({ id: '0', source_authority: 'policy', chunk_type: 'sop_step' }, withEmb),
    rc({ id: '1', source_authority: 'notes', chunk_type: 'approval' }, withEmb),
  ];
  const sectionsInput = {
    directAnswer: { text: 'answer [S1]', citations: [0] },
    sections: [
      { key: 'steps', items: [{ text: 'step [S1]', citations: [0] }] },
      { key: 'approvals', items: [{ text: 'approver [S2]', citations: [1] }] },
    ],
  };
  const run = (withEmb) => {
    const ranked = mk(withEmb);
    const { sections, directAnswerValid } = validateSections(sectionsInput);
    return {
      keys: sections.map((s) => s.key),
      directAnswerValid,
      auth: sections.map((s) => classifySectionAuthority(s.items.flatMap((i) => i.citations), ranked)),
      status: deriveAnswerStatus({
        baseBand: 'medium',
        directAnswerValid,
        requestedFacets: ['steps', 'approvals'],
        survivingSectionKeys: sections.map((s) => s.key),
        contradictionNoteKept: false,
      }),
    };
  };
  assert.deepEqual(run(true), run(false));
  assert.deepEqual(run(false).status, { status: 'HIGH', missingFacets: [] });
  assert.deepEqual(run(false).auth, ['authoritative', 'advisory']);
});

// ======================================================================
// section-key vocabulary is stable + matches requested-facet enum
// ======================================================================

test('OPERATIONAL_SECTION_KEYS is the requested-facet vocabulary and has no dupes', () => {
  assert.equal(new Set(OPERATIONAL_SECTION_KEYS).size, OPERATIONAL_SECTION_KEYS.length);
  assert.deepEqual(validateRequestedFacets([...OPERATIONAL_SECTION_KEYS]), [...OPERATIONAL_SECTION_KEYS]);
});
