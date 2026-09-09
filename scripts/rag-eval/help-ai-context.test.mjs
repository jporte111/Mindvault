// MindVault Help — the response planner (message-evidence extraction), the
// structured runtime support context, and the end-to-end troubleshooting
// behaviour they enable. Everything here is pure / in-memory: no live data,
// no network, no Base44.
//   node --test scripts/rag-eval/help-ai-context.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractEvidence, extractQuotedError, classifyError } from '../../src/lib/adminHelp/messageEvidence.js';
import { answerSupportQuestion } from '../../src/lib/adminHelp/support.js';
import { answerAdminHelpQuestion } from '../../src/lib/adminHelp/answer.js';
import {
  recordAppError,
  recordAppAction,
  clearRecentAppError,
  getRecentAppError,
  buildSupportContext,
  __resetSupportContextForTests,
} from '../../src/lib/supportContext.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ====================================================================
// 1. Message evidence — the user's current message is primary evidence
// ====================================================================

test('a quoted error is extracted even when a button name is quoted first in the same message', () => {
  const msg = 'everytime i click "save company details" the message "a tenant must be specified" shows up.';
  const e = extractEvidence(msg);
  assert.equal(e.quotedError, 'a tenant must be specified');
  assert.equal(e.errorKey, 'error_tenant_scope');
  assert.equal(e.pageOrFeature?.id, 'company_details');
  assert.ok(e.actionAttempted && /company details/i.test(e.actionAttempted));
  assert.equal(e.isErrorReport, true);
});

test('an unquoted "it says X" error is extracted', () => {
  const e = extractEvidence('It says a tenant must be specified');
  assert.equal(e.errorKey, 'error_tenant_scope');
  assert.equal(e.isErrorReport, true);
});

test('classifyError recognizes the standard MindVault messages and their paraphrases', () => {
  assert.equal(classifyError('A tenant must be specified'), 'error_tenant_scope');
  assert.equal(classifyError('you must select a tenant first'), 'error_tenant_scope');
  assert.equal(classifyError('403 unauthorized'), 'error_unauthorized');
  assert.equal(classifyError('cross-tenant access is not allowed'), 'error_cross_tenant');
  assert.equal(classifyError('active tenant admins only'), 'error_admin_only');
  assert.equal(classifyError('the coffee machine is broken'), null);
});

test('a plain question is NOT an error report and NOT a quoted error', () => {
  const e = extractEvidence('What is a tenant?');
  assert.equal(e.isErrorReport, false);
  assert.equal(e.quotedError, null);
  assert.equal(e.errorKey, null);
  assert.equal(e.isQuestion, true);
});

test('a quoted, unrecognized error is still captured as a quote (so the assistant never re-asks for the wording)', () => {
  assert.equal(extractQuotedError('I got an error saying "the flux capacitor overloaded"'), 'the flux capacitor overloaded');
});

// ====================================================================
// 2. Structured runtime support context
// ====================================================================

test('buildSupportContext exposes the situational fields the assistant reasons over', () => {
  __resetSupportContextForTests();
  const sc = buildSupportContext({
    route: '/setup#company-details',
    userRole: 'client_admin',
    tenantName: 'Acme Books',
    setup: { progressPct: 40, setupComplete: false, nextItem: { label: 'Invite your team' }, counts: { knowledge: 0 } },
  });
  assert.equal(sc.currentRoute, '/setup#company-details');
  assert.equal(sc.currentPage, 'Getting Started');
  assert.equal(sc.currentSection, 'Company details');
  assert.equal(sc.currentUserRole, 'client_admin');
  assert.equal(sc.tenantName, 'Acme Books');
  assert.equal(sc.onboardingProgress, 40);
  assert.equal(sc.currentSetupStep?.label, 'Invite your team');
  assert.deepEqual(sc.counts, { knowledge: 0 });
});

test('the support context carries NO security-sensitive data — no tenant_id, tokens, stack traces, membership rows', () => {
  __resetSupportContextForTests();
  recordAppError({
    action: 'update company details',
    page: 'Getting Started',
    section: 'Company details',
    error: 'Authorization: Bearer abc.def.ghi failed at SQL line 42\n  at handler (/x/y.ts:10)',
    code: 500,
  });
  const sc = buildSupportContext({ route: '/setup', userRole: 'client_admin' });
  const blob = JSON.stringify(sc);
  assert.equal(/tenant_id|Bearer|Authorization|SQL|\.ts:\d|at handler/i.test(blob), false, blob);
  // the redactor collapses a message that looks like it contains a secret
  assert.match(sc.recentError.message, /A system error occurred\./);
  assert.equal(sc.recentErrorCode, '500');
});

test('recentError has a bounded recency and can be cleared once resolved', () => {
  __resetSupportContextForTests();
  recordAppError({ action: 'save company details', page: 'Getting Started', section: 'Company details', error: 'A tenant must be specified', code: 400 });
  assert.ok(getRecentAppError());
  clearRecentAppError();
  assert.equal(getRecentAppError(), null);
});

// ====================================================================
// 3. End-to-end — the reported failure and the spec's other cases
// ====================================================================

const CLIENT_ADMIN_CTX = {
  route: '/setup#company-details',
  setup: { role: 'client_admin', loading: false, progressPct: 40, setupComplete: false, nextItem: null, items: [], counts: {} },
  supportContext: buildSupportContext({ route: '/setup#company-details', userRole: 'client_admin', tenantName: 'Acme' }),
};

test('the exact reported prompt: recognizes the error already supplied, does NOT re-ask for its wording, understands the Company details context, troubleshoots', () => {
  __resetSupportContextForTests();
  const r = answerAdminHelpQuestion(
    'everytime i click "save company details" the message "a tenant must be specified" shows up.',
    CLIENT_ADMIN_CTX,
  );
  // does NOT ask "what did the message say?"
  assert.doesNotMatch(r.answer, /what did the message say|what does the message say/i);
  // uses the Company details context the user gave
  assert.match(r.answer, /company.details/i);
  // troubleshoots: what it means, whose fault, what to do
  assert.match(r.answer, /doesn.t mean you need to pick anything/i);
  assert.match(r.answer, /application issue|nothing you typed caused it/i);
  assert.match(r.answer, /Reload the page|sign out and back in/i);
  // NOT a generic onboarding wall
  assert.doesNotMatch(r.answer, /Setup Checklist|Invite your team|Upload your first/i);
});

test('after the underlying bug is fixed the answer states it has been corrected and gives a retry path', () => {
  const r = answerAdminHelpQuestion('It says "a tenant must be specified" when I save company details', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /already been corrected|has been fixed|corrected on MindVault/i);
});

test('"What is a tenant?" — a definition, not troubleshooting, not onboarding', () => {
  const r = answerAdminHelpQuestion('What is a tenant?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /private workspace/i);
  assert.doesNotMatch(r.answer, /Reload the page|Setup Checklist/i);
});

test('"Where do I select my tenant?" — told there is no selector, it is automatic', () => {
  const r = answerAdminHelpQuestion('Where do I select my tenant?', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /no tenant \(workspace\) selector|never pick it|automatically/i);
});

test('"It says a tenant must be specified" alone — troubleshooting, asks only for the page', () => {
  const r = answerAdminHelpQuestion('It says a tenant must be specified', { ...CLIENT_ADMIN_CTX, supportContext: undefined });
  assert.match(r.answer, /doesn.t mean you need to pick anything/i);
  assert.doesNotMatch(r.answer, /what did the message say|what does the message say/i);
});

test('"I got unauthorized when I clicked Save" — role check, uses the known context, no re-ask for wording', () => {
  const r = answerAdminHelpQuestion('I got unauthorized when I clicked Save', CLIENT_ADMIN_CTX);
  assert.match(r.answer, /role check/i);
  assert.match(r.answer, /coming from (the Save|Company details|the "Save")/i);
  assert.doesNotMatch(r.answer, /what did the message say|what does the message say/i);
});

test('"What do I do here?" from Home / from Team — page-relative guidance, not a generic wall', () => {
  const home = answerAdminHelpQuestion('What do I do here?', {
    ...CLIENT_ADMIN_CTX, route: '/',
    setup: { role: 'client_admin', loading: false, progressPct: 40, nextItem: { label: 'Invite your team', how: 'Add a teammate by email.' }, items: [], counts: {} },
  });
  assert.match(home.answer, /40%|Invite your team/i);
  const team = answerAdminHelpQuestion('What do I do here?', {
    ...CLIENT_ADMIN_CTX, route: '/team',
    setup: { role: 'client_admin', loading: false, progressPct: 40, nextItem: null, items: [], counts: { members: 1 } },
  });
  assert.match(team.answer, /Team page/i);
});

test('"What should I do next?" — the live setup copilot', () => {
  const r = answerAdminHelpQuestion('What should I do next?', {
    ...CLIENT_ADMIN_CTX,
    setup: {
      role: 'client_admin', loading: false, progressPct: 40, setupComplete: false,
      nextItem: { label: 'Invite your team', why: 'MindVault works best with your team.', how: 'Add a teammate by email.', doneWhen: 'One teammate invited.', actionLabel: 'Invite your team', actionHref: '/team' },
      items: [], counts: {},
    },
  });
  assert.match(r.answer, /Invite your team/i);
  assert.ok(r.navigation.some((n) => n.route === '/team'));
});

test('"Where is the Library?" / "Where is the Admin page?" — current Client Admin navigation only', () => {
  const lib = answerAdminHelpQuestion('Where is the Library?', CLIENT_ADMIN_CTX);
  assert.match(lib.answer, /Knowledge page/i);
  const admin = answerAdminHelpQuestion('Where is the Admin page?', CLIENT_ADMIN_CTX);
  assert.match(admin.answer, /no separate "Admin" page|Getting Started|Manage/i);
  assert.doesNotMatch(admin.answer, /\bAdmin →/);
});

test('an unknown error with insufficient information: one honest, targeted follow-up — no invented workflow', () => {
  __resetSupportContextForTests();
  const r = answerAdminHelpQuestion('something is broken and I keep getting an error', { ...CLIENT_ADMIN_CTX, supportContext: undefined });
  assert.match(r.answer, /can.t tell|rather not guess/i);
  assert.match(r.answer, /what were you clicking/i);
  assert.doesNotMatch(r.answer, /Setup Checklist|Invite your team/i);
});

// ====================================================================
// 4. Captured-error path — the Help panel can troubleshoot the failure
//    the user just hit, before they describe it
// ====================================================================

test('a recently-captured application error lets a bare "what do I do" become real troubleshooting', () => {
  __resetSupportContextForTests();
  recordAppError({ action: 'save company details', page: 'Getting Started', section: 'Company details', error: 'A tenant must be specified', code: 400 });
  const sc = buildSupportContext({ route: '/setup', userRole: 'client_admin', tenantName: 'Acme' });
  const r = answerAdminHelpQuestion('what do I do', { route: '/setup', supportContext: sc });
  assert.match(r.answer, /doesn.t mean you need to pick anything/i);
  assert.match(r.answer, /company.details/i);
  assert.doesNotMatch(r.answer, /what did the message say/i);
});

test('with no captured error, a bare "what do I do" on /setup falls through to the setup copilot, not a fabricated error answer', () => {
  __resetSupportContextForTests();
  const r = answerAdminHelpQuestion('what do I do', {
    route: '/setup',
    setup: { role: 'client_admin', loading: false, progressPct: 20, nextItem: { label: 'Add your company details', how: 'Set your company name and logo.' }, items: [], counts: {} },
    supportContext: buildSupportContext({ route: '/setup', userRole: 'client_admin' }),
  });
  assert.doesNotMatch(r.answer, /doesn.t mean you need to pick anything|a tenant must be specified/i);
});

// ====================================================================
// 5. Scope isolation — the Help AI never touches customer knowledge or
//    the employee answer pipeline, and carries no cross-tenant state
// ====================================================================

test('the new modules never import the customer retrieval / answer-generation pipeline', () => {
  const forbidden = [/askKnowledgeBaseV2/, /KnowledgeChunk/, /base44\/shared\/(retrieval|embeddings)/, /rankChunks|pickConfidence/];
  for (const f of ['src/lib/adminHelp/messageEvidence.js', 'src/lib/adminHelp/support.js', 'src/lib/supportContext.js']) {
    const s = read(f).replace(/\/\/.*$/gm, '');
    for (const re of forbidden) assert.equal(re.test(s), false, `${f} matched ${re}`);
  }
});

test('supportContext.js never sends anything anywhere — no fetch/base44/network', () => {
  const s = read('src/lib/supportContext.js').replace(/\/\/.*$/gm, '');
  assert.equal(/fetch\(|base44|XMLHttpRequest|WebSocket|navigator\.send/.test(s), false);
});

test('recordAppError refuses to keep a message that looks like it contains a credential', () => {
  __resetSupportContextForTests();
  recordAppError({ action: 'x', page: 'y', error: 'api_key=sk-live-1234567890 rejected' });
  assert.equal(getRecentAppError().message, 'A system error occurred.');
});
