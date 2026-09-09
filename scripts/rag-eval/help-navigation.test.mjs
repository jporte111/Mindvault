// MindVault Help — navigation safety: anchored deep links, role gating, and
// the context-aware fallback that replaces the old generic topic dump.
// Uses injected topics so it is independent of live corpus content.
//   node --test scripts/rag-eval/help-navigation.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerAdminHelpQuestion, NAV_ROUTE_ALLOWLIST, INSUFFICIENT_HELP_MESSAGE,
} from '../../src/lib/adminHelp/answer.js';

const mk = (over) => ({
  keywords: [], phrases: [], caveats: '', related: [], navigation: [],
  summary: 's', whatItIs: 'w', whyItMatters: 'y', howToUse: 'h', whereToFind: 'f',
  ...over,
});

test('an anchored deep-link route passes the allowlist on its path and is returned verbatim', () => {
  const topics = [mk({
    id: 'company_details', title: 'Company details', keywords: ['zzcompanydetailskw'],
    navigation: [{ label: 'Open Company Details', route: '/setup#company-details', topic: 'company_details' }],
  })];
  const r = answerAdminHelpQuestion('zzcompanydetailskw', { topics });
  assert.deepEqual(r.navigation, [
    { label: 'Open Company Details', route: '/setup#company-details', topic: 'company_details' },
  ]);
});

test('a Client User never receives navigation to a Client-Admin-only page', () => {
  const topics = [mk({
    id: 'team', title: 'Team', keywords: ['zzteamkw'],
    navigation: [
      { label: 'Open Team', route: '/team', topic: 'team' },
      { label: 'Open Company Details', route: '/setup#company-details', topic: 'team' },
      { label: 'Open AI Assistant', route: '/chat', topic: 'team' },
    ],
  })];
  const asUser = answerAdminHelpQuestion('zzteamkw', { topics, setup: { role: 'client_user' } });
  assert.deepEqual(asUser.navigation.map((n) => n.route), ['/chat'],
    'admin-only /team and /setup#... must be withheld from a client_user');

  const asAdmin = answerAdminHelpQuestion('zzteamkw', { topics, setup: { role: 'client_admin' } });
  assert.deepEqual(asAdmin.navigation.map((n) => n.route), ['/team', '/setup#company-details', '/chat']);
});

test('role can also come from supportContext.currentUserRole', () => {
  const topics = [mk({
    id: 'proc', title: 'Processes', keywords: ['zzprockw'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'proc' }],
  })];
  const r = answerAdminHelpQuestion('zzprockw', { topics, supportContext: { currentUserRole: 'client_user' } });
  assert.deepEqual(r.navigation, []);
});

test('a non-allowlisted route is still stripped regardless of role', () => {
  const topics = [mk({
    id: 'rogue', title: 'Rogue', keywords: ['zzroguekw'],
    navigation: [
      { label: 'ok', route: '/chat', topic: 'rogue' },
      { label: 'bad', route: '/__danger__#x', topic: 'rogue' },
    ],
  })];
  const r = answerAdminHelpQuestion('zzroguekw', { topics, setup: { role: 'client_admin' } });
  assert.deepEqual(r.navigation.map((n) => n.route), ['/chat']);
});

test('context-aware fallback: a page-relative question with no corpus match answers from the route primary topic, not the generic message', () => {
  // no injected topic matches, but the route is a real mapped route
  const r = answerAdminHelpQuestion('what does this page do?', { route: '/continuity' });
  assert.notEqual(r.answer, INSUFFICIENT_HELP_MESSAGE);
  assert.equal(r.sources[0]?.id, 'operational_continuity');
});

test('gibberish on a mapped route still falls through to the honest last-resort message', () => {
  const r = answerAdminHelpQuestion('asdkjfh qwoeiruty zzz', { route: '/continuity' });
  assert.equal(r.answer, INSUFFICIENT_HELP_MESSAGE);
  assert.deepEqual(r.navigation, []);
});

test('the last-resort message names concrete tasks, never a list of unrelated concept topics', () => {
  assert.doesNotMatch(INSUFFICIENT_HELP_MESSAGE, /Operational Processes, Verification/);
  assert.match(INSUFFICIENT_HELP_MESSAGE, /company details|inviting a teammate|adding knowledge/);
});

test('NAV_ROUTE_ALLOWLIST is unchanged by this work', () => {
  assert.deepEqual([...NAV_ROUTE_ALLOWLIST].sort(), [
    '/', '/admin', '/chat', '/continuity', '/library', '/manage', '/processes', '/setup', '/team',
  ]);
});
