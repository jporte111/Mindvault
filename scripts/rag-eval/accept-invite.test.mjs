// MindVault-branded accept-invite screen — pure copy/state mapping + a
// structural scan of the page (this repo has no React renderer, so runtime
// behaviour is asserted the same way GuidedTour / AdminHelpAssistant are).
//   node --test scripts/rag-eval/accept-invite.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewState, acceptErrorMessage, roleDescription } from '../../src/lib/inviteMessages.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// --- previewState -------------------------------------------------------

test('a valid preview is "ready"; every invalid reason maps to a titled, actionable message', () => {
  assert.deepEqual(previewState({ valid: true }), { kind: 'ready' });
  for (const reason of ['not_found', 'expired', 'revoked', 'accepted', 'error']) {
    const s = previewState({ valid: false, reason });
    assert.equal(s.kind, 'invalid', reason);
    assert.ok(s.title && s.title.length > 4, `${reason} needs a title`);
    assert.ok(
      s.body && /admin|sign in|try again|invited|send a new|fresh invitation/i.test(s.body),
      `${reason} body should tell the user what to do`,
    );
  }
});

test('an unknown / missing reason falls back to the generic not-found message (no crash)', () => {
  assert.equal(previewState({ valid: false }).kind, 'invalid');
  assert.equal(previewState(null).kind, 'invalid');
  assert.equal(previewState({ valid: false, reason: 'weird' }).title, previewState({ valid: false, reason: 'not_found' }).title);
});

// --- acceptErrorMessage ----------------------------------------------

test('accept failures each get an honest, non-success message; email_mismatch tells the user to switch address', () => {
  for (const reason of ['unauthorized', 'not_found', 'revoked', 'already_accepted', 'expired', 'tenant_inactive', 'error']) {
    const m = acceptErrorMessage(reason);
    assert.ok(m && m.length > 8, reason);
    assert.doesNotMatch(m, /you.?re in|success|welcome/i, `${reason} must not read as success`);
  }
  assert.match(acceptErrorMessage('email_mismatch'), /different email|invited address/i);
  assert.equal(acceptErrorMessage('nonsense'), acceptErrorMessage('error'));
});

test('roleDescription is plain English and role-appropriate', () => {
  assert.match(roleDescription('Client Admin'), /manage/i);
  assert.match(roleDescription('Client User'), /ask questions|browse/i);
  assert.match(roleDescription(''), /access/i);
});

// --- structural scan of AcceptInvite.jsx -----------------------------

const page = read('src/pages/AcceptInvite.jsx');

test('the page reads only the opaque token from the URL — never a tenant id or role', () => {
  assert.match(page, /URLSearchParams\(window\.location\.search\)\.get\('token'\)/);
  assert.doesNotMatch(page, /\.get\('tenant_id'\)|\.get\('role'\)|\.get\('app_role'\)/);
});

test('tenant + role come from getInvitePreview, and acceptance from acceptTenantInvite', () => {
  assert.match(page, /invoke\('getInvitePreview'/);
  assert.match(page, /invoke\('acceptTenantInvite'/);
});

test('Google and Microsoft are the primary options; email/password is the fallback underneath', () => {
  assert.match(page, /Continue with Google/);
  assert.match(page, /Continue with Microsoft/);
  assert.match(page, /loginWithProvider\(provider/);
  assert.match(page, /oauth\('google'\)/);
  assert.match(page, /oauth\('microsoft'\)/);
  // the email/password form is inside a <details> disclosure (secondary)
  const gIdx = page.indexOf('Continue with Google');
  const dIdx = page.indexOf('<details');
  assert.ok(gIdx > 0 && dIdx > gIdx, 'the password form must come after the OAuth buttons');
  assert.match(page, /loginViaEmailPassword\(/);
  assert.match(page, /auth\.register\(/);
  assert.match(page, /verifyOtp\(/);
});

test('the page is MindVault-branded and states the inviting company + assigned role', () => {
  assert.match(page, /MindVault/);
  assert.match(page, /You’ve been invited to join/);
  assert.match(page, /tenantName/);
  assert.match(page, /roleLabel/);
});

test('success only redirects after the server confirms acceptance, and does a full reload', () => {
  assert.match(page, /data\?\.accepted/);
  assert.match(page, /window\.location\.href = '\/'/);
  // no optimistic "accepted" state before the invoke resolves
  assert.doesNotMatch(page, /setPhase\('accepted'\)[\s\S]{0,40}invoke\('acceptTenantInvite'/);
});

test('AcceptInvite performs no entity writes and never uses asServiceRole', () => {
  assert.doesNotMatch(page, /asServiceRole|\.entities\.[A-Za-z]+\.(create|update|delete)\(/);
});

// --- App.jsx public route wiring -----------------------------------

const app = read('src/App.jsx');

test('/invite/accept, /forgot-password, /reset-password render BEFORE the auth gate', () => {
  assert.match(app, /PUBLIC_PATHS\s*=\s*\[[^\]]*'\/invite\/accept'[^\]]*'\/forgot-password'[^\]]*'\/reset-password'/s);
  // the public branch returns before the loading spinner / authError handling
  const pubIdx = app.indexOf('isPublicPath(pathname)');
  const gateIdx = app.indexOf('isLoadingPublicSettings || isLoadingAuth');
  assert.ok(pubIdx > 0 && pubIdx < gateIdx, 'public routes must be checked before the auth gate');
});
