// Admin Help Assistant V1 — dedicated test suite.
//
// V1's chosen architecture is fully client-side and deterministic: no
// backend function, no LLM, no network call, no embeddings. The corpus
// (src/lib/adminHelp/corpus.js) and the retrieval/answer logic
// (retrieval.js / answer.js) are pure and directly `node --test`-able; UI
// behavior that only exists at runtime is verified by structural
// (source-scan) assertions on AdminHelpAssistant.jsx, the same approach
// used for GuidedTour.jsx and the prior Walkthrough.jsx, since this repo has
// no React test renderer.
//   node --test scripts/rag-eval/admin-help.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CONCEPT_HELP } from '../../src/lib/conceptHelp.js';
import { SUPPORTED_UPLOAD_HINT } from '../../src/lib/knowledgeSource.js';
import { ADMIN_HELP_TOPICS, ADMIN_HELP_TOPIC_IDS } from '../../src/lib/adminHelp/corpus.js';
import { tokenize, scoreTopic, retrieveTopics } from '../../src/lib/adminHelp/retrieval.js';
import {
  answerAdminHelpQuestion, NAV_ROUTE_ALLOWLIST, INSUFFICIENT_HELP_MESSAGE,
} from '../../src/lib/adminHelp/answer.js';
import { getStarterPrompts, GENERIC_STARTER_PROMPTS } from '../../src/lib/adminHelp/routePrompts.js';
import { topicsForRoute, isPageRelativeIntent, routeBias } from '../../src/lib/adminHelp/routeContext.js';
import { answerSupportQuestion, SUPPORT_SOURCE } from '../../src/lib/adminHelp/support.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const exists = (p) => existsSync(new URL(`../../${p}`, import.meta.url));
const stripComments = (s) => s.replace(/\/\/.*$/gm, '');

const BANNED_JARGON = /\b(embeddings?|vector(s| retrieval)?|\bRAG\b|schema|\bchunk(s|ed)?\b|payload|fingerprints?|retrieval|re-?index(ing|ed)?|lifecycle engine)\b/i;

// ====================================================================
// 1. Access
// ====================================================================

test('AdminHelpAssistant is admin-only (platform admins and Client Admins)', () => {
  const s = read('src/components/onboarding/AdminHelpAssistant.jsx');
  assert.match(s, /useIsAdmin\(\)/);
  assert.match(s, /if \(!isAdmin && !isClientAdmin\) return null;/);
});

test('V1 architecture is deliberately client-side: no backend function was created', () => {
  assert.equal(exists('base44/functions/adminHelpAssistant'), false,
    'V1 chose the simpler client-side design — no base44/functions/adminHelpAssistant');
});

test('no writes anywhere in the admin-help modules — no entity create/update/delete calls', () => {
  for (const f of [
    'src/lib/adminHelp/corpus.js',
    'src/lib/adminHelp/retrieval.js',
    'src/lib/adminHelp/answer.js',
    'src/lib/adminHelp/support.js',
    'src/lib/adminHelp/routePrompts.js',
    'src/lib/adminHelp/routeContext.js',
    'src/components/onboarding/AdminHelpAssistant.jsx',
  ]) {
    const s = stripComments(read(f));
    assert.equal(/base44\.(entities|functions|asServiceRole)/.test(s), false, `${f} must perform no Base44 reads or writes`);
    assert.equal(/\.create\(|\.update\(|\.delete\(/.test(s), false, `${f} must perform no entity mutations`);
  }
});

// ====================================================================
// 2. Corpus
// ====================================================================

const REQUIRED_TOPIC_IDS = [
  'product_overview', 'getting_started', 'company_details', 'knowledge_library',
  'adding_knowledge', 'knowledge_scope', 'ai_assistant', 'operational_processes',
  'owner', 'sme', 'backup_sme', 'criticality', 'review_cadence', 'verification',
  'lifecycle', 'setup_checklist', 'operational_continuity', 'coverage', 'currency',
  'key_person_dependency', 'knowledge_gaps', 'snapshots', 'trends',
  'what_changed', 'notifications', 'permissions', 'team_management',
  'question_history', 'mindvault_help', 'common_troubleshooting', 'guided_tour',
];

test('every required help topic exists exactly once', () => {
  assert.deepEqual([...ADMIN_HELP_TOPIC_IDS].sort(), [...REQUIRED_TOPIC_IDS].sort());
  assert.equal(new Set(ADMIN_HELP_TOPIC_IDS).size, ADMIN_HELP_TOPIC_IDS.length, 'duplicate topic id');
});

test('every topic has real content, not a one-sentence glossary entry', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    assert.ok(t.title?.length > 0, `${t.id} missing title`);
    assert.ok(t.summary?.length > 10, `${t.id} summary too short`);
    assert.ok(t.whatItIs?.length > 10, `${t.id} whatItIs too short`);
    assert.ok(t.whyItMatters?.length > 10, `${t.id} whyItMatters too short`);
    assert.ok(t.howToUse?.length > 10, `${t.id} howToUse too short`);
    assert.ok(t.whereToFind?.length > 0, `${t.id} whereToFind missing`);
    assert.ok(Array.isArray(t.related), `${t.id} related must be an array`);
  }
});

test('no visible "Training(s)" terminology anywhere in the corpus', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    const blob = [t.title, t.summary, t.whatItIs, t.whyItMatters, t.howToUse, t.whereToFind, t.caveats].join(' ');
    assert.equal(/\btraining(s)?\b/i.test(blob), false, `${t.id}: "${blob}"`);
  }
});

test('no banned implementation jargon in admin help copy', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    const blob = [t.title, t.summary, t.whatItIs, t.whyItMatters, t.howToUse, t.whereToFind, t.caveats].join(' ');
    assert.equal(BANNED_JARGON.test(blob), false, `${t.id}: "${blob}"`);
  }
});

test('no unsupported PDF ingestion claim — the corpus states PDF is NOT a supported format, matching knowledgeSource.js', () => {
  const adding = ADMIN_HELP_TOPICS.find((t) => t.id === 'adding_knowledge');
  assert.match(adding.caveats, /PDF is not currently a supported upload format/i);
  assert.equal(/PDF is (supported|accepted|allowed)/i.test(adding.caveats), false);
  assert.ok(adding.caveats.includes(SUPPORTED_UPLOAD_HINT), 'must reuse the real supported-format hint, not a hand-written list');
});

test('key-person dependency is never described as inferred from Criticality alone', () => {
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'key_person_dependency');
  assert.match(t.caveats, /never inferred from Criticality alone/i);
  const backup = ADMIN_HELP_TOPICS.find((x) => x.id === 'backup_sme');
  assert.match(backup.caveats, /never.*from Criticality alone|not automatically flagged/i);
});

test('Operational Continuity is described with four independent bands, never a composite score', () => {
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'operational_continuity');
  assert.match(t.caveats, /four independent signals/i);
  assert.match(t.caveats, /no single combined score/i);
  const blob = [t.summary, t.whatItIs, t.whyItMatters, t.howToUse, t.caveats].join(' ');
  assert.equal(/\boverall score\b|\bhealth grade\b|\b0-?100\b/i.test(blob), false);
});

test('unverified knowledge is never described as automatically wrong', () => {
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'verification');
  assert.match(t.caveats, /not the same as wrong/i);
  // an outright claim ("unverified is wrong"), not the negation we expect
  assert.equal(/unverified (is|means|equals) (wrong|incorrect|invalid)\b/i.test(t.caveats), false);
});

test('firm-wide / client-specific scope isolation is described as real isolation', () => {
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'knowledge_scope');
  assert.match(t.summary, /never crosses over|only ever used/i);
});

test('definitions reused from CONCEPT_HELP are byte-identical, never a drifted second definition', () => {
  const pairs = [
    ['owner', 'owner'], ['sme', 'sme'], ['backup_sme', 'backup_sme'],
    ['criticality', 'criticality'], ['review_cadence', 'review_cadence'],
    ['verification', 'verification'], ['coverage', 'coverage'], ['currency', 'currency'],
    ['knowledge_scope', 'scope'], ['key_person_dependency', 'key_person'],
    ['knowledge_gaps', 'knowledge_gap'], ['snapshots', 'snapshot'],
    ['what_changed', 'what_changed'],
  ];
  for (const [corpusId, conceptKey] of pairs) {
    const t = ADMIN_HELP_TOPICS.find((x) => x.id === corpusId);
    assert.ok(t, `${corpusId} missing from corpus`);
    assert.equal(t.summary, CONCEPT_HELP[conceptKey].text, `${corpusId} summary drifted from CONCEPT_HELP.${conceptKey}`);
  }
});

test('corpus.js is otherwise pure — only reuses conceptHelp.js and knowledgeSource.js, no Base44/React/LLM', () => {
  const s = stripComments(read('src/lib/adminHelp/corpus.js'));
  const imports = [...s.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  for (const imp of imports) {
    assert.ok(imp === '../conceptHelp.js' || imp === '../knowledgeSource.js', `unexpected import "${imp}" in corpus.js`);
  }
  assert.equal(/base44|InvokeLLM|localStorage|React/.test(s), false);
});

// ====================================================================
// 3. Retrieval
// ====================================================================

test('an Owner question retrieves Owner (and Operational Process context)', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What is the difference between an Owner and an SME?', { limit: 3 });
  const ids = matched.map((t) => t.id);
  assert.equal(ids[0], 'owner');
  assert.ok(ids.includes('sme'));
});

test('an Operational Process question retrieves operational_processes first', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What is an Operational Process?', { limit: 3 });
  assert.equal(matched[0].id, 'operational_processes');
});

test('an SME question retrieves sme', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What does SME mean?', { limit: 3 });
  assert.equal(matched[0].id, 'sme');
});

test('a review cadence question retrieves review_cadence', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What does Review Cadence do?', { limit: 3 });
  assert.equal(matched[0].id, 'review_cadence');
});

test('a scope question retrieves the firm-wide/client-specific help topic', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'How do I make knowledge client-specific?', { limit: 3 });
  assert.equal(matched[0].id, 'knowledge_scope');
});

test('a continuity question retrieves operational_continuity', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What is Operational Continuity?', { limit: 3 });
  assert.equal(matched[0].id, 'operational_continuity');
});

test('every spec example question retrieves a non-empty, relevant top match', () => {
  const cases = [
    ['How do I add knowledge?', 'adding_knowledge'],
    ['What is an Operational Process?', 'operational_processes'],
    ['When should I assign a Backup SME?', 'backup_sme'],
    ['What does Criticality mean?', 'criticality'],
    ['Why is knowledge unverified?', 'verification'],
    ['What does the Setup Checklist mean?', 'setup_checklist'],
    ["Why isn't a source showing up in AI answers?", 'common_troubleshooting'],
    ['What does Coverage mean?', 'coverage'],
    ['What is a key-person dependency?', 'key_person_dependency'],
    ['What are Knowledge Gaps?', 'knowledge_gaps'],
    ['How do I restart the product tour?', 'guided_tour'],
    ['What should I configure first?', 'getting_started'],
  ];
  for (const [q, expectedId] of cases) {
    const matched = retrieveTopics(ADMIN_HELP_TOPICS, q, { limit: 3 });
    assert.equal(matched[0]?.id, expectedId, `"${q}" -> expected ${expectedId}, got ${matched[0]?.id}`);
  }
});

test('a Snapshots / Trends question retrieves the closely-related snapshots+trends pair (either may rank first — they are two facets of one concept)', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What are Snapshots / Trends?', { limit: 3 });
  const ids = matched.map((t) => t.id);
  assert.ok(['snapshots', 'trends'].includes(ids[0]), `expected snapshots or trends first, got ${ids[0]}`);
  assert.ok(ids.includes('snapshots') && ids.includes('trends'), `expected both topics present, got ${ids.join(',')}`);
});

test('gibberish returns no matches, and answerAdminHelpQuestion falls back to the insufficient-help message', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'asdkjfh qwoeiruty zzz gibberish', { limit: 3 });
  assert.deepEqual(matched, []);
  const r = answerAdminHelpQuestion('asdkjfh qwoeiruty zzz gibberish');
  assert.equal(r.answer, INSUFFICIENT_HELP_MESSAGE);
  assert.deepEqual(r.sources, []);
  assert.deepEqual(r.navigation, []);
});

test('an empty question never crashes and never fabricates an answer', () => {
  assert.deepEqual(answerAdminHelpQuestion(''), { answer: '', sources: [], navigation: [] });
  assert.deepEqual(answerAdminHelpQuestion('   '), { answer: '', sources: [], navigation: [] });
  assert.deepEqual(answerAdminHelpQuestion(undefined), { answer: '', sources: [], navigation: [] });
});

test('tokenize and scoreTopic are deterministic and pure', () => {
  assert.deepEqual(tokenize('What is a Key-Person dependency?'), ['key', 'person', 'dependency']);
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'owner');
  const words = tokenize('owner');
  assert.equal(scoreTopic(t, words), scoreTopic(t, words));
});

// ====================================================================
// Correction — route as a lightweight relevance SIGNAL for vague,
// page-relative questions. Never permission to fabricate an answer, and
// never satisfied by a bare cue word alone: route bias may only apply when
// the topic already has real lexical relevance (re-rank) OR the question
// matches a small, explicit, recognized page-relative intent pattern.
// Invariant: unknown words + a page cue ≠ a documented question.
// ====================================================================

test('/continuity + "What should I look at here?" retrieves Operational Continuity help', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What should I look at here?', { route: '/continuity' });
  assert.equal(matched[0]?.id, 'operational_continuity');
});

test('/admin + "What should I do first on this page?" retrieves Setup Checklist or Getting Started help', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What should I do first on this page?', { route: '/admin' });
  assert.ok(['setup_checklist', 'getting_started'].includes(matched[0]?.id), `got ${matched[0]?.id}`);
});

test('/admin + "What should I do first here?" (the original phrasing) still retrieves Setup Checklist or Getting Started', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What should I do first here?', { route: '/admin' });
  assert.ok(['setup_checklist', 'getting_started'].includes(matched[0]?.id), `got ${matched[0]?.id}`);
});

test('/library + "What is this page?" retrieves Knowledge Library', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What is this page?', { route: '/library' });
  assert.equal(matched[0]?.id, 'knowledge_library');
});

test('/chat + "How does this work?" retrieves AI Assistant', () => {
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'How does this work?', { route: '/chat' });
  assert.equal(matched[0]?.id, 'ai_assistant');
});

test('explicit "What is an SME?" on /continuity still retrieves SME — explicit terms outrank route context', () => {
  const onContinuity = retrieveTopics(ADMIN_HELP_TOPICS, 'What is an SME?', { route: '/continuity' });
  const noRoute = retrieveTopics(ADMIN_HELP_TOPICS, 'What is an SME?');
  assert.equal(onContinuity[0]?.id, 'sme');
  assert.equal(noRoute[0]?.id, 'sme');
  assert.notEqual(onContinuity[0]?.id, 'operational_continuity');
});

test('nonsense + a bare page cue word must still be insufficient — route context cannot create relevance from zero', () => {
  const cases = [
    ['/continuity', 'flibbertigibbet here'],
    ['/admin', 'xyzzy this page'],
    ['/library', 'banana section'],
  ];
  for (const [route, q] of cases) {
    const matched = retrieveTopics(ADMIN_HELP_TOPICS, q, { route });
    assert.deepEqual(matched, [], `"${q}" on ${route} incorrectly produced a result`);
    const r = answerAdminHelpQuestion(q, { route });
    assert.equal(r.answer, INSUFFICIENT_HELP_MESSAGE, `"${q}" on ${route} did not fall back to insufficient help`);
  }
});

test('gibberish does not become a confident answer merely because a route exists', () => {
  const gibberish = 'asdkjfh qwoeiruty zzz gibberish';
  for (const route of ['/library', '/chat', '/admin', '/continuity', '/training/abc123']) {
    const matched = retrieveTopics(ADMIN_HELP_TOPICS, gibberish, { route });
    assert.deepEqual(matched, [], `route ${route} let gibberish through`);
  }
  const r = answerAdminHelpQuestion(gibberish, { route: '/continuity' });
  assert.equal(r.answer, INSUFFICIENT_HELP_MESSAGE);
});

test('unknown routes add no relevance — a page-relative question on an unmapped route (or no route) resolves to no match', () => {
  const q = 'What should I look at here?';
  assert.deepEqual(retrieveTopics(ADMIN_HELP_TOPICS, q, { route: '/some/unmapped/route' }), []);
  assert.deepEqual(retrieveTopics(ADMIN_HELP_TOPICS, q), []);
  assert.deepEqual(topicsForRoute('/some/unmapped/route'), []);
  assert.deepEqual(topicsForRoute(undefined), []);
});

test('isPageRelativeIntent recognizes the small explicit intent set, and nothing else — the bare presence of "here"/"page"/"section" is not enough', () => {
  const recognized = [
    'What should I look at here?',
    'What should I do first on this page?',
    'What should I do first here?',
    'What is this page?',
    'What is this?',
    'How does this work?',
    'What do I do on this page?',
  ];
  for (const q of recognized) {
    assert.equal(isPageRelativeIntent(q), true, `expected "${q}" to be recognized`);
  }
  const unrecognized = [
    'flibbertigibbet here',
    'xyzzy this page',
    'banana section',
    'What does Review Cadence do?', // a real, explicit, non-vague question
    'here',
    'this page',
    'section',
  ];
  for (const q of unrecognized) {
    assert.equal(isPageRelativeIntent(q), false, `expected "${q}" to NOT be recognized as page-relative intent`);
  }
});

test('route bias never applies on its own without either real lexical relevance or a recognized page-relative intent', () => {
  // "What does Review Cadence do?" is explicit and not vague — no bias needed,
  // and it must not be granted purely because /continuity is a mapped route.
  assert.equal(isPageRelativeIntent('What does Review Cadence do?'), false);
  const matched = retrieveTopics(ADMIN_HELP_TOPICS, 'What does Review Cadence do?', { route: '/continuity' });
  assert.equal(matched[0]?.id, 'review_cadence'); // real lexical match wins, not a continuity topic
});

test('route bias is strictly weaker than an explicit keyword or exact-id match', () => {
  const bias = routeBias('/continuity', 'operational_continuity');
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === 'sme');
  const explicitScore = scoreTopic(t, tokenize('What is an SME?'));
  assert.ok(bias < explicitScore, `route bias (${bias}) must be weaker than an explicit id match (${explicitScore})`);
});

test('routeBias no longer takes or depends on the question text — gating on intent is retrieveTopics\' job', () => {
  const s = stripComments(read('src/lib/adminHelp/routeContext.js'));
  assert.match(s, /export function routeBias\(route, topicId\)/);
});

test('topicsForRoute matches the suggested route -> topic bias, including the /training/:id prefix', () => {
  assert.deepEqual(topicsForRoute('/library'), ['knowledge_library', 'adding_knowledge', 'knowledge_scope']);
  assert.deepEqual(topicsForRoute('/chat'), ['ai_assistant', 'knowledge_scope', 'knowledge_gaps']);
  assert.deepEqual(topicsForRoute('/admin'), ['setup_checklist', 'operational_processes', 'owner', 'sme', 'review_cadence', 'verification']);
  assert.deepEqual(topicsForRoute('/continuity'), [
    'operational_continuity', 'coverage', 'currency', 'key_person_dependency',
    'knowledge_gaps', 'snapshots', 'trends', 'what_changed',
  ]);
  assert.deepEqual(topicsForRoute('/training/xyz'), ['knowledge_library', 'verification', 'lifecycle', 'knowledge_scope']);
  // every biased topic id must be a real corpus topic
  for (const route of ['/library', '/chat', '/admin', '/continuity', '/training/xyz']) {
    for (const id of topicsForRoute(route)) {
      assert.ok(ADMIN_HELP_TOPICS.some((t) => t.id === id), `${route} biases toward unknown topic "${id}"`);
    }
  }
});

test('routeContext.js is pure — no React, no Base44, no network, no LLM', () => {
  const s = stripComments(read('src/lib/adminHelp/routeContext.js'));
  assert.equal(/^\s*import\s/m.test(s), false);
  assert.equal(/base44|InvokeLLM|fetch\(|localStorage/.test(s), false);
});

// ====================================================================
// 4. Scope isolation — never touches customer retrieval / answer generation
// ====================================================================

const FORBIDDEN_PATTERNS = [
  /askKnowledgeBaseV2/,
  /KnowledgeChunk/,
  /base44\/shared\/retrieval/,
  /base44\/shared\/embeddings/,
  /rankChunks|pickConfidence|applyGovernanceFilters/,
  /operationalAnswer/,
];

test('the Admin Help Assistant never imports or invokes the customer retrieval / answer-generation pipeline', () => {
  for (const f of [
    'src/lib/adminHelp/corpus.js',
    'src/lib/adminHelp/retrieval.js',
    'src/lib/adminHelp/answer.js',
    'src/lib/adminHelp/support.js',
    'src/lib/adminHelp/routePrompts.js',
    'src/lib/adminHelp/routeContext.js',
    'src/lib/adminHelp/index.js',
    'src/components/onboarding/AdminHelpAssistant.jsx',
  ]) {
    const s = stripComments(read(f));
    for (const re of FORBIDDEN_PATTERNS) {
      assert.equal(re.test(s), false, `${f} matched forbidden pattern ${re}`);
    }
  }
});

test('AdminHelpAssistant.jsx imports only from src/lib/adminHelp — never the employee chat/knowledge modules', () => {
  const s = stripComments(read('src/components/onboarding/AdminHelpAssistant.jsx'));
  const imports = [...s.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  const forbidden = imports.filter((i) => /knowledgeHealth|knowledgeScope|ChatMessage|askKnowledgeBase/.test(i));
  assert.deepEqual(forbidden, []);
  assert.ok(imports.some((i) => i === '@/lib/adminHelp'));
});

// ====================================================================
// 5. Navigation
// ====================================================================

test('NAV_ROUTE_ALLOWLIST is exactly the current safe app routes', () => {
  assert.deepEqual([...NAV_ROUTE_ALLOWLIST].sort(), [
    '/', '/admin', '/chat', '/continuity', '/library', '/manage', '/processes', '/setup', '/team',
  ]);
});

test('every navigation entry in the corpus targets an allowlisted route (ignoring any #section anchor)', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    for (const n of t.navigation) {
      const path = n.route.split('#')[0];
      assert.ok(NAV_ROUTE_ALLOWLIST.includes(path), `${t.id} navigation route "${n.route}" is not allowlisted`);
    }
  }
});

test('answerAdminHelpQuestion strips a non-allowlisted route even if a topic tried to supply one (defense in depth)', () => {
  const rogueTopics = [
    {
      id: 'rogue', title: 'Rogue', keywords: ['rogue topic zzz'], summary: 'rogue',
      whatItIs: 'rogue', whyItMatters: 'rogue', howToUse: 'rogue', whereToFind: 'rogue',
      caveats: '', related: [],
      navigation: [
        { label: 'Go to admin', route: '/admin' },
        { label: 'Delete everything', route: '/__delete_everything__' },
      ],
    },
  ];
  const r = answerAdminHelpQuestion('rogue topic zzz', { topics: rogueTopics });
  assert.deepEqual(r.navigation, [{ label: 'Go to admin', route: '/admin', topic: 'rogue' }]);
});

test('navigation actions carry only label/route/topic — no action, no id, nothing that could trigger a mutation', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    for (const n of t.navigation) {
      assert.deepEqual(Object.keys(n).sort(), ['label', 'route', 'topic'].sort());
      assert.equal(typeof n.label, 'string');
      assert.equal(typeof n.route, 'string');
    }
  }
  const s = read('src/components/onboarding/AdminHelpAssistant.jsx');
  // the UI's only handler for a navigation item is React Router's navigate()
  assert.match(s, /onClick=\{\(\) => navigate\(n\.route\)\}/);
});

// ====================================================================
// 6. UI
// ====================================================================

test('starter prompts: 4-6 generic prompts, and every mapped route has 3 deterministic prompts', () => {
  assert.ok(GENERIC_STARTER_PROMPTS.length >= 4 && GENERIC_STARTER_PROMPTS.length <= 6);
  for (const route of ['/admin', '/continuity', '/library', '/chat']) {
    const prompts = getStarterPrompts(route);
    assert.ok(prompts.length > 0, `${route} has no starter prompts`);
    assert.deepEqual(prompts, getStarterPrompts(route), 'must be deterministic');
  }
});

test('an unmapped route (e.g. /training/:id) falls back to the generic starter set, never empty', () => {
  assert.deepEqual(getStarterPrompts('/training/abc123'), GENERIC_STARTER_PROMPTS);
  assert.deepEqual(getStarterPrompts('/unknown-route'), GENERIC_STARTER_PROMPTS);
});

test('route-specific prompts differ meaningfully by page', () => {
  const admin = getStarterPrompts('/admin');
  const continuity = getStarterPrompts('/continuity');
  const library = getStarterPrompts('/library');
  assert.notDeepEqual(admin, continuity);
  assert.notDeepEqual(admin, library);
  assert.notDeepEqual(continuity, library);
});

test('the drawer is visibly distinct from the employee AI Assistant', () => {
  const s = read('src/components/onboarding/AdminHelpAssistant.jsx');
  assert.match(s, /MindVault Help/);
  assert.match(s, /Ask how to set up and use MindVault/);
  assert.match(s, /does not answer questions\s+from your company knowledge/i);
  // never claims to be, or visually labels itself as, the employee assistant
  assert.equal(/>\s*AI Assistant\s*</.test(s), false);
});

test('the source indicator is labeled distinctly from employee-assistant citations ("Based on:", not "Sources")', () => {
  const s = read('src/components/onboarding/AdminHelpAssistant.jsx');
  assert.match(s, /Based on:/);
});

test('starter prompts and route-suggestion prompts are chosen with no LLM call', () => {
  const s = stripComments(read('src/lib/adminHelp/routePrompts.js'));
  assert.equal(/InvokeLLM|fetch\(|base44/.test(s), false);
});

// ====================================================================
// 7. Product support — system errors, internal terminology, page
//    locations. These run BEFORE the setup copilot and corpus retrieval,
//    so a question about an error, an internal term, or where a page lives
//    is never substituted with a generic onboarding response. Answers
//    must use the CURRENT Client Admin UI (Home, Knowledge, AI Assistant,
//    Processes, Team, Manage, Getting Started) and never deprecated
//    navigation ("Admin" page, "Library" page, the old 10-area checklist).
// ====================================================================

const CLIENT_ADMIN_SETUP = {
  role: 'client_admin',
  loading: false,
  progressPct: 40,
  setupComplete: false,
  nextItem: {
    label: 'Invite your team',
    why: 'MindVault works best with your whole team.',
    how: 'Add your first team member by email and choose their role.',
    doneWhen: 'At least one teammate has been invited.',
    actionLabel: 'Invite your team',
    actionHref: '/team',
  },
  items: [],
  counts: { knowledge: 0, members: 1, processes: 0 },
};
const CLIENT_ADMIN_CTX = { route: '/', setup: CLIENT_ADMIN_SETUP };

test('"What is a tenant?" gets a plain-English term explanation, not onboarding', () => {
  const r = answerAdminHelpQuestion('What is a tenant?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /private workspace/i);
  assert.match(r.answer, /assigned automatically when you sign in/i);
  assert.doesNotMatch(r.answer, /Setup Checklist|Operational Continuity|knowledge source/i);
  assert.deepEqual(r.sources, SUPPORT_SOURCE);
});

test('"Where do I choose my tenant?" is told there is nothing to choose — not treated as an error report', () => {
  const r = answerAdminHelpQuestion('Where do I choose my tenant?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /no tenant \(workspace\) selector|never create, choose, or configure|never pick it/i);
  assert.match(r.answer, /automatically/i);
  assert.doesNotMatch(r.answer, /page or button produced|Setup Checklist/i);
});

test('"It says a tenant must be specified" is treated as troubleshooting context', () => {
  const r = answerAdminHelpQuestion('It says a tenant must be specified', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /doesn.t mean you need to pick anything/i);
  assert.match(r.answer, /application issue|MindVault.s side/i);
  // one missing piece only — the page — never the wording the user gave
  assert.match(r.answer, /page or button produced/i);
  assert.doesNotMatch(r.answer, /what did the message say|what does the message say/i);
  assert.doesNotMatch(r.answer, /Setup Checklist|knowledge sources|Operational Processes/i);
});

test('the original failing prompt is answered as troubleshooting, not onboarding', () => {
  const r = answerAdminHelpQuestion("where is the 'tenant'? it said i need to specify a tenant first", CLIENT_ADMIN_CTX);
  assert.match(r.answer, /doesn.t mean you need to pick anything/i);
  assert.match(r.answer, /application issue|MindVault.s side/i);
  assert.doesNotMatch(r.answer, /Setup Checklist/i);
});

test('"What does tenant_id mean?" explains the internal identifier in plain English', () => {
  const r = answerAdminHelpQuestion('What does tenant_id mean?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /internal record identifier/i);
  assert.match(r.answer, /never have to find, copy, or type it/i);
});

test('"What do I do on this page?" is answered from the CURRENT page, not generic onboarding', () => {
  assert.equal(isPageRelativeIntent('What do I do on this page?'), true);
  const r = answerAdminHelpQuestion('What do I do on this page?', { ...CLIENT_ADMIN_CTX, route: '/library' });
  assert.match(r.answer, /Knowledge page/i);
});

test('"What should I do next?" still uses the live setup copilot', () => {
  const r = answerAdminHelpQuestion('What should I do next?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /Here's what's next: Invite your team/i);
  assert.ok(r.navigation.some((n) => n.route === '/team'));
});

test('"Where is the Admin page?" is answered with the current Client Admin navigation', () => {
  const r = answerAdminHelpQuestion('Where is the Admin page?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /Getting Started|Manage/i);
  assert.doesNotMatch(r.answer, /Admin →/);
  assert.ok(r.navigation.every((n) => n.route !== '/admin'),
    'client admins are never sent to the deprecated /admin page');
});

test('"Where is the Library?" gets the current name — Knowledge', () => {
  const r = answerAdminHelpQuestion('Where is the Library?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /Knowledge page/i);
  assert.ok(r.navigation.some((n) => n.route === '/library'));
});

test('other quoted system errors are treated as troubleshooting, never as setup instructions', () => {
  const cases = [
    ['I got an unauthorized error', /role check/i],
    ['It says active tenant admins only', /reserved for a Client Admin/i],
    ['It says cross-tenant access is not allowed', /different company.s workspace/i],
  ];
  for (const [q, re] of cases) {
    const r = answerAdminHelpQuestion(q, CLIENT_ADMIN_CTX);
    assert.match(r.answer, re, `"${q}" was not treated as troubleshooting`);
    assert.doesNotMatch(r.answer, /Setup Checklist/i);
  }
});

test('an unknown error with no usable detail gets an honest "I can\'t tell" plus ONE targeted follow-up — no invented workflow', () => {
  const r = answerAdminHelpQuestion('something went wrong and I got an error', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /can.t tell|rather not guess/i);
  assert.match(r.answer, /what were you clicking/i);
  assert.doesNotMatch(r.answer, /Setup Checklist|invite your team|Getting Started page/i);
});

test('an error report that DOES name the action asks only for the wording — never a blind "I can\'t tell"', () => {
  const r = answerAdminHelpQuestion('I keep getting an error message when I save company details', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /save your company details/i);
  assert.match(r.answer, /what does the message say/i);
  assert.doesNotMatch(r.answer, /can.t tell from your description/i);
});

test('internal terms are explained in plain English and never something the user is told to configure', () => {
  for (const q of [
    'What is RLS?',
    'What does scope resolution mean?',
    'What is a membership record?',
    'What is a guarded function?',
    'What is a Super Admin?',
  ]) {
    const r = answerAdminHelpQuestion(q, CLIENT_ADMIN_CTX);
    assert.match(r.answer,
      /nothing for you to configure|not something you configure|nothing for you to do|runs automatically|handled for you|maintains them for you|part of the platform|not something your company uses/i,
      `"${q}" did not reassure the user there is nothing to configure`);
    assert.doesNotMatch(r.answer, /Setup Checklist/i);
  }
});

test('support navigation never leaves the allowlist and never carries anything but label/route/topic', () => {
  const questions = [
    'Where is the Admin page?',
    'Where is the Library?',
    'Where is the Manage page?',
    'Where is the Team page?',
    'Where is my setup checklist?',
    'How do I get to the Processes page?',
    'Where do I enter my company details?',
  ];
  for (const q of questions) {
    const r = answerAdminHelpQuestion(q, CLIENT_ADMIN_CTX);
    for (const n of r.navigation) {
      assert.ok(NAV_ROUTE_ALLOWLIST.includes(n.route.split('#')[0]),
        `"${q}" produced non-allowlisted route ${n.route}`);
      assert.deepEqual(Object.keys(n).sort(), ['label', 'route', 'topic']);
    }
  }
});

test('support answers reflect the CURRENT Client Admin UI — no deprecated navigation, no old checklist', () => {
  const answers = [];
  for (const q of [
    'What is a tenant?',
    'Where do I choose my tenant?',
    'It says a tenant must be specified',
    'What does tenant_id mean?',
    'What do I do on this page?',
    'What should I do next?',
    'Where is the Admin page?',
    'Where is the Library?',
  ]) {
    const r = answerAdminHelpQuestion(q, CLIENT_ADMIN_CTX);
    answers.push(r.answer);
    assert.doesNotMatch(r.answer, /\b10 areas?\b|\bAdmin →|\bLibrary page\b|Open Admin\b/i,
      `"${q}" references deprecated navigation`);
  }
  // The old 10-area checklist is gone from the corpus too: every mention of
  // the checklist describes the current 7-step guided setup.
  const checklist = ADMIN_HELP_TOPICS.find((t) => t.id === 'setup_checklist');
  const blob = [checklist.summary, checklist.whatItIs, checklist.howToUse, checklist.whereToFind, checklist.caveats].join(' ');
  assert.match(blob, /7-step guided checklist/i);
  assert.doesNotMatch(blob, /\b10\b|ten\b/i);
});

test('the corpus no longer references deprecated page names — audit', () => {
  for (const t of ADMIN_HELP_TOPICS) {
    const blob = [t.title, t.summary, t.whatItIs, t.whyItMatters, t.howToUse, t.whereToFind, t.caveats].join(' ');
    assert.doesNotMatch(blob, /Admin →|Library page\b|\bthe Library\b|\bten (firm-wide )?(setup )?areas?\b/i,
      `${t.id} still references deprecated navigation: "${blob.match(/Admin →|Library page\b|\bthe Library\b/i)?.[0]}"`);
  }
});

test('answerSupportQuestion returns null for questions outside its scope — corpus and setup copilot still handle those', () => {
  assert.equal(answerSupportQuestion('What is an Operational Process?'), null);
  assert.equal(answerSupportQuestion('asdkjfh qwoeiruty zzz gibberish'), null);
});

test('support.js is deterministic — only reuses the sibling messageEvidence.js, no React/Base44/network/LLM', () => {
  const s = stripComments(read('src/lib/adminHelp/support.js'));
  const imports = [...s.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./messageEvidence.js']);
  assert.equal(/base44|InvokeLLM|fetch\(|localStorage/.test(s), false);
});

test('messageEvidence.js is pure — no imports, no React/Base44/network/LLM/DOM', () => {
  const s = stripComments(read('src/lib/adminHelp/messageEvidence.js'));
  assert.equal(/^\s*import\s/m.test(s), false);
  assert.equal(/base44|InvokeLLM|fetch\(|localStorage|window\.|document\./.test(s), false);
});

// ====================================================================
// 8. Conversation awareness — a troubleshooting thread spans turns. The
//    follow-up reply ("whenever I click 'save company details'...") must
//    be resolved against the thread, never re-answered as context-free.
// ====================================================================

test('the reported failure: the follow-up reply is resolved against the thread, not re-asked', () => {
  const history = [
    { role: 'user', text: 'What is a tenant? It says a tenant must be specified' },
    { role: 'assistant', text: answerAdminHelpQuestion('What is a tenant? It says a tenant must be specified', CLIENT_ADMIN_CTX).answer },
  ];
  const r = answerAdminHelpQuestion('whenever i click "save company details" that message comes up', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r.answer, /pinpoints it/i);
  assert.match(r.answer, /save your company details/i);
  assert.match(r.answer, /Getting Started/i);
  assert.match(r.answer, /Sign out and sign back in/i);
  assert.doesNotMatch(r.answer, /can.?t tell/i, 'must NOT repeat the context-free "I can\'t tell" answer');
});

test('same for a generic-error thread: the reply names the action and gets a real answer', () => {
  const history = [
    { role: 'user', text: 'I keep getting an error message when I save' },
    { role: 'assistant', text: answerAdminHelpQuestion('I keep getting an error message when I save', CLIENT_ADMIN_CTX).answer },
  ];
  const r = answerAdminHelpQuestion('whenever i click "save company details" that message comes up', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r.answer, /save your company details/i);
  assert.doesNotMatch(r.answer, /can.?t tell/i);
});

test('a still-failing reply escalates instead of looping on the same question', () => {
  const h1 = [
    { role: 'user', text: 'It says a tenant must be specified' },
    { role: 'assistant', text: answerAdminHelpQuestion('It says a tenant must be specified', CLIENT_ADMIN_CTX).answer },
  ];
  const turn2 = answerAdminHelpQuestion('whenever i click "save company details" that message comes up', { ...CLIENT_ADMIN_CTX, history: h1 }).answer;
  const r = answerAdminHelpQuestion('i tried again and it still does not work', {
    ...CLIENT_ADMIN_CTX,
    history: [...h1, { role: 'user', text: 'whenever i click "save company details" that message comes up' }, { role: 'assistant', text: turn2 }],
  });
  assert.match(r.answer, /Sign out and sign back in/i);
  assert.match(r.answer, /contact MindVault support/i);
  assert.doesNotMatch(r.answer, /what page or button|what were you clicking/i);
});

test('an unrelated new question is never hijacked by an open thread', () => {
  const history = [
    { role: 'user', text: 'It says a tenant must be specified' },
    { role: 'assistant', text: answerAdminHelpQuestion('It says a tenant must be specified', CLIENT_ADMIN_CTX).answer },
  ];
  const r = answerAdminHelpQuestion('What is an Operational Process?', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r.answer, /business workflow/i);
  const r2 = answerAdminHelpQuestion('Where is the Team page?', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r2.answer, /Team page is in the left navigation/i);
});

test('a first-turn message that names the action asks for the message text, not a blind "I can\'t tell"', () => {
  const r = answerAdminHelpQuestion('I get a message whenever I click save company details', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /save your company details/i);
  assert.match(r.answer, /what does the message say/i);
  assert.doesNotMatch(r.answer, /can.t tell from your description/i);
});

test('other actions are recognized as triggers too', () => {
  const history = [
    { role: 'user', text: 'It says a tenant must be specified' },
    { role: 'assistant', text: answerAdminHelpQuestion('It says a tenant must be specified', CLIENT_ADMIN_CTX).answer },
  ];
  const r = answerAdminHelpQuestion('when i hit invite on the team page', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r.answer, /invite a teammate/i);
  const r2 = answerAdminHelpQuestion('it happens when i upload a document', { ...CLIENT_ADMIN_CTX, history });
  assert.match(r2.answer, /add a knowledge source/i);
});