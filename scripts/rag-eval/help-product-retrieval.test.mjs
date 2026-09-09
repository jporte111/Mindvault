// MindVault Help — product-knowledge retrieval & actionable navigation.
//
// Covers the reported failure ("how can i update the company information when
// i need to?") and the spec's question set with wording variations, plus the
// "answer, then take me there" navigation contract: real routes only, exact
// section deep links, and no Client-Admin-only action offered to a Client
// User.
//   node --test scripts/rag-eval/help-product-retrieval.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_HELP_TOPICS } from '../../src/lib/adminHelp/corpus.js';
import { retrieveTopics } from '../../src/lib/adminHelp/retrieval.js';
import { answerAdminHelpQuestion, NAV_ROUTE_ALLOWLIST } from '../../src/lib/adminHelp/answer.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const ADMIN_CTX = { route: '/admin', setup: { role: 'client_admin', loading: false } };
const USER_CTX = { route: '/', setup: { role: 'client_user', loading: false } };

const KNOWN_ANCHORS = new Set(['company-details', 'manage-knowledge']);

function topId(q, ctx) {
  return retrieveTopics(ADMIN_HELP_TOPICS, q, { limit: 3, minScore: 1, route: ctx?.route })[0]?.id;
}
function navRoutes(r) {
  return (r.navigation || []).map((n) => n.route);
}

// ====================================================================
// 1. The reported failure + Company details, every natural phrasing
// ====================================================================

const COMPANY_PHRASINGS = [
  'how can i update the company information when i need to?', // verbatim report
  'How do I change my company information?',
  'Where do I edit my business name?',
  'How do I update my logo?',
  'Can I change the brand color later?',
  'Where are company settings?',
  'update our company name',
  'change company branding',
];

for (const q of COMPANY_PHRASINGS) {
  test(`company details phrasing is answered with the section deep link: "${q}"`, () => {
    // Pure semantic retrieval must rank the Company details topic first...
    assert.equal(topId(q), 'company_details', `retrieval top match for "${q}"`);
    // ...and end to end (a "where is" phrasing may be fielded by the support
    // layer's location answer instead — either way the answer is about
    // company identity and links straight to the card).
    const r = answerAdminHelpQuestion(q, ADMIN_CTX);
    assert.match(r.answer, /company name|logo|brand colou?r|Company details/i);
    assert.ok(
      navRoutes(r).includes('/setup#company-details'),
      `"${q}" should offer an Open Company Details action, got ${JSON.stringify(navRoutes(r))}`,
    );
  });
}

test('the verbatim reported sentence no longer returns the no-documentation message', () => {
  const r = answerAdminHelpQuestion('how can i update the company information when i need to?', ADMIN_CTX);
  assert.doesNotMatch(r.answer, /don.t have documentation|don.t have enough/i);
  assert.doesNotMatch(r.answer, /Operational Processes, Verification/);
});

// ====================================================================
// 2. Spec question set (#9) with wording variations
// ====================================================================

const SPEC_CASES = [
  { topic: 'company_details', qs: ['Where do I change my logo?', 'update company logo', 'swap out our logo image'] },
  { topic: 'company_details', qs: ['Can I change the company name later?', 'rename the company', 'edit the organization name'] },
  { topic: 'company_details', qs: ['Where do I change the brand color?', 'update our brand colour', 'pick a different accent color'] },
  { topic: 'team_management', qs: ['How do I invite someone?', 'invite a colleague to the team', 'add a new team member', 'send an invitation to a coworker'] },
  { topic: 'team_management', qs: ['how do I revoke a teammate access', 'deactivate a member', 'take away someone’s access', 'reactivate a member'] },
  { topic: 'team_management', qs: ['change a teammate to admin', 'change someone’s role'] },
  { topic: 'permissions', qs: ["What's the difference between Client Admin and Client User?", 'client admin vs client user', 'what can a client user do'] },
  { topic: 'adding_knowledge', qs: ['How do I upload an SOP?', 'add a policy document', 'import our employee handbook', 'how do I add knowledge'] },
  { topic: 'operational_processes', qs: ['How do I edit a process?', 'create a process', 'archive a process', 'add an operational process'] },
  { topic: 'question_history', qs: ['Where can I see my previous AI questions?', 'is there a chat history', 'can I read past conversations with the assistant'] },
  { topic: 'setup_checklist', qs: ['review setup progress', "what's on my setup checklist", 'how far through onboarding am I', 'show my onboarding progress'] },
];

for (const { topic, qs } of SPEC_CASES) {
  for (const q of qs) {
    test(`"${q}" retrieves ${topic} and the answer uses current terminology`, () => {
      // Pure semantic retrieval ranks the intended topic first.
      assert.equal(topId(q), topic, `retrieval top match for "${q}"`);
      // End to end it produces a real answer (from the corpus topic, or the
      // support layer's location answer for a "where is" phrasing) — never
      // the no-documentation message, never retired vocabulary.
      const r = answerAdminHelpQuestion(q, ADMIN_CTX);
      assert.doesNotMatch(r.answer, /don.t have documentation on that yet/i, `"${q}" fell through to the last resort`);
      assert.doesNotMatch(r.answer, /\bTraining Library\b|\bSubmit Recording\b|\bthe Library\b|\bTrainings?\b/);
    });
  }
}

// ====================================================================
// 3. Actionable navigation (#13): real routes, exact section deep links
// ====================================================================

const NAV_CASES = [
  { q: 'update company details', route: '/setup#company-details' },
  { q: 'How do I invite a teammate?', route: '/team' },
  { q: 'how do I add knowledge', route: '/manage#manage-knowledge' },
  { q: 'how do I edit a process', route: '/processes' },
  { q: 'review setup progress', route: '/setup' },
];

for (const { q, route } of NAV_CASES) {
  test(`navigation for "${q}" resolves to ${route}`, () => {
    const r = answerAdminHelpQuestion(q, ADMIN_CTX);
    assert.ok(navRoutes(r).includes(route), `expected ${route}, got ${JSON.stringify(navRoutes(r))}`);
  });
}

test('view previous AI questions never navigates to /my-questions (it is not chat history)', () => {
  for (const q of ['Where can I see my previous AI questions?', 'chat history', 'past conversations']) {
    const r = answerAdminHelpQuestion(q, ADMIN_CTX);
    assert.ok(!navRoutes(r).some((rt) => rt.startsWith('/my-questions')),
      `"${q}" offered a /my-questions link`);
    assert.match(r.answer, /does not keep|no .* history|not saved/i);
    assert.match(r.answer, /reload/i);
  }
});

test('every navigation action Help can emit points at a real, allowlisted route with a known anchor', () => {
  const seen = [];
  for (const t of ADMIN_HELP_TOPICS) {
    for (const q of [...(t.keywords || []), ...(t.phrases || [])]) {
      const r = answerAdminHelpQuestion(q, ADMIN_CTX);
      for (const n of r.navigation || []) seen.push(n.route);
    }
  }
  assert.ok(seen.length > 0, 'expected some navigation to be produced');
  for (const route of seen) {
    const [path, anchor] = route.split('#');
    assert.ok(NAV_ROUTE_ALLOWLIST.includes(path), `route ${route} is not on the allowlist`);
    if (anchor) assert.ok(KNOWN_ANCHORS.has(anchor), `route ${route} uses an unknown section anchor`);
  }
});

test('the section anchors Help links to actually exist in the current pages', () => {
  assert.match(read('src/pages/GettingStarted.jsx'), /id="company-details"/);
  assert.match(read('src/pages/Manage.jsx'), /id="manage-knowledge"/);
});

// ====================================================================
// 4. Role safety — a Client User is never handed a Client-Admin-only action
// ====================================================================

const ADMIN_ONLY = ['/setup', '/manage', '/processes', '/team', '/continuity', '/admin'];

for (const { q } of NAV_CASES) {
  test(`Client User context strips admin-only navigation for "${q}"`, () => {
    const r = answerAdminHelpQuestion(q, USER_CTX);
    for (const route of navRoutes(r)) {
      assert.ok(!ADMIN_ONLY.includes(route.split('#')[0]),
        `a client_user was offered ${route} for "${q}"`);
    }
  });
}

test('a Client User still gets the same explanatory answer text, just without the admin action', () => {
  const asAdmin = answerAdminHelpQuestion('how do I invite a teammate', ADMIN_CTX);
  const asUser = answerAdminHelpQuestion('how do I invite a teammate', USER_CTX);
  assert.equal(asUser.sources[0]?.id, asAdmin.sources[0]?.id, 'same topic retrieved');
  assert.equal(asUser.answer, asAdmin.answer, 'answer text is unchanged by role');
  assert.deepEqual(asUser.navigation, [], 'no admin-only action for the client_user');
});

// ====================================================================
// 5. Fallback discipline — no generic topic dump
// ====================================================================

test('a page-relative question with no corpus match answers from the route, not a topic list', () => {
  const r = answerAdminHelpQuestion('what does this page do?', { route: '/admin', setup: { role: 'client_admin' } });
  assert.doesNotMatch(r.answer, /Operational Processes, Verification, or Operational Continuity/);
  assert.ok(r.sources.length > 0, 'named the route topic as the source');
});

test('true gibberish still gets the honest last-resort message', () => {
  const r = answerAdminHelpQuestion('zzxq wobble frotz', { route: '/admin' });
  assert.match(r.answer, /don.t have documentation on that yet/i);
  assert.deepEqual(r.navigation, []);
});
