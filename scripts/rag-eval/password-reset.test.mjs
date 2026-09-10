// MindVault-branded Forgot / Reset Password — pure state mapping + a
// structural scan of the two screens. No network, no live email.
//   node --test scripts/rag-eval/password-reset.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resetRequestResult,
  resetSubmitResult,
  validateNewPassword,
  readResetToken,
  RESET_REQUEST_NEUTRAL,
} from '../../src/lib/passwordResetMessages.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// --- request result (account-enumeration-neutral) -------------------

test('a RESOLVED request always yields the same neutral success — known and unknown emails are indistinguishable', () => {
  const a = resetRequestResult({ resolved: true });
  assert.equal(a.tone, 'neutral');
  assert.equal(a.message, RESET_REQUEST_NEUTRAL);
  // the neutral copy must not assert the account exists
  assert.match(a.message, /if an account .* exists/i);
  assert.doesNotMatch(a.message, /we sent you|your account|reset link is on its way\b/i);
});

test('a REJECTED request never reads as "sent" — it is an honest, retryable error', () => {
  for (const status of [undefined, 500, 502, 0]) {
    const r = resetRequestResult({ resolved: false, status });
    assert.equal(r.tone, 'error');
    assert.equal(r.retryable, true);
    assert.doesNotMatch(r.message, /sent|check your inbox/i, `status ${status} must not imply success`);
  }
  assert.match(resetRequestResult({ resolved: false, status: 429 }).message, /too many|wait/i);
  assert.match(resetRequestResult({ resolved: false, status: 400 }).message, /valid email/i);
});

// --- submit (set new password) -------------------------------------

test('a resolved resetPassword is a success; token-shaped failures fail safe with "request a new one"', () => {
  assert.deepEqual(resetSubmitResult({ resolved: true }).ok, true);
  for (const status of [400, 401, 404, 410, 422]) {
    const r = resetSubmitResult({ resolved: false, status });
    assert.equal(r.ok, false);
    assert.match(r.message, /invalid or has expired|request a new one/i, `status ${status}`);
  }
  // a transient failure is distinct from an expired token
  assert.match(resetSubmitResult({ resolved: false, status: 503 }).message, /try again/i);
});

// --- password rule + token parsing --------------------------------

test('validateNewPassword enforces length and confirmation', () => {
  assert.match(validateNewPassword('short'), /8 characters/);
  assert.match(validateNewPassword('longenough', 'different'), /don’t match|don't match/);
  assert.equal(validateNewPassword('longenough', 'longenough'), null);
  assert.equal(validateNewPassword('longenough'), null);
});

test('readResetToken accepts Base44’s reset_token OR a plain token param, trims, and is safe when absent', () => {
  assert.equal(readResetToken('?reset_token=abc123'), 'abc123');
  assert.equal(readResetToken('?token=xyz789'), 'xyz789');
  assert.equal(readResetToken('?reset_token=  spaced  '), 'spaced');
  assert.equal(readResetToken('?foo=bar'), '');
  assert.equal(readResetToken(''), '');
  assert.equal(readResetToken(null), '');
});

// --- structural scan --------------------------------------------------

const forgot = read('src/pages/ForgotPassword.jsx');
const reset = read('src/pages/ResetPassword.jsx');

test('ForgotPassword calls the supported Base44 API and only shows success after it resolves', () => {
  assert.match(forgot, /auth\.resetPasswordRequest\(/);
  // success state is set from resetRequestResult({ resolved: true }) INSIDE the try,
  // after the await — never before / in a catch
  assert.match(forgot, /await base44\.auth\.resetPasswordRequest[\s\S]{0,120}resetRequestResult\(\{ resolved: true \}\)/);
  assert.match(forgot, /catch[\s\S]{0,160}resetRequestResult\(\{ resolved: false/);
});

test('ForgotPassword tells OAuth users there is no password to reset', () => {
  assert.match(forgot, /Google or Microsoft/);
  assert.match(forgot, /no password to reset|sign-in screen instead/i);
});

test('ResetPassword uses auth.resetPassword, never logs the token, and fails safe without one', () => {
  assert.match(reset, /auth\.resetPassword\(\{ resetToken: token, newPassword/);
  assert.match(reset, /readResetToken\(window\.location\.search\)/);
  assert.doesNotMatch(reset, /console\.(log|info|warn|error)\([^)]*token/i, 'the reset token must never be logged');
  assert.match(reset, /if \(!token\)/, 'a missing token must render a safe state');
});

test('neither screen builds its own password crypto or bypasses Base44 as the credential authority', () => {
  for (const s of [forgot, reset]) {
    assert.doesNotMatch(s, /bcrypt|scrypt|pbkdf2|argon2|crypto\.subtle|jsonwebtoken|jwt\.sign/i);
    assert.doesNotMatch(s, /asServiceRole|\.entities\.[A-Za-z]+\.(create|update|delete)\(/);
  }
});
