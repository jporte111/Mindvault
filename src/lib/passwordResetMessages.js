// Pure copy + state mapping for the MindVault-branded password-reset screens.
// No React, no network. Unit-tested in scripts/rag-eval/password-reset.test.mjs.
//
// Design rules baked in here:
//   - never claim "email sent" unless the request actually RESOLVED
//   - the request result is account-enumeration-neutral: a known and an
//     unknown email produce the SAME success copy
//   - a rejected request produces an honest error, not a success
//   - token failures fail safe ("request a new link"), never leak the token

// The neutral success message — used whenever resetPasswordRequest resolves,
// regardless of whether the address is registered.
export const RESET_REQUEST_NEUTRAL =
  'If an account with that email exists and uses a password, we’ve sent a link to reset it. Check your inbox — and your spam folder.';

/**
 * @param {{ resolved: boolean, status?: number, error?: string }} outcome
 *   `resolved: true`  -> the SDK promise fulfilled (Base44 accepted the request)
 *   `resolved: false` -> it rejected; `status` is the HTTP status if known
 * @returns {{ tone: 'neutral'|'error', message: string, retryable: boolean }}
 */
export function resetRequestResult(outcome) {
  if (outcome && outcome.resolved) {
    return { tone: 'neutral', message: RESET_REQUEST_NEUTRAL, retryable: false };
  }
  const status = outcome && Number(outcome.status);
  if (status === 429) {
    return {
      tone: 'error',
      message: 'Too many attempts. Please wait a few minutes and try again.',
      retryable: true,
    };
  }
  if (status === 400 || status === 422) {
    return {
      tone: 'error',
      message: 'That doesn’t look like a valid email address.',
      retryable: true,
    };
  }
  // network error / 5xx / unknown — do NOT imply the email was sent
  return {
    tone: 'error',
    message: 'We couldn’t send the reset email just now. Please try again in a moment.',
    retryable: true,
  };
}

/**
 * @param {{ resolved: boolean, status?: number }} outcome  from auth.resetPassword
 * @returns {{ ok: boolean, message: string }}
 */
export function resetSubmitResult(outcome) {
  if (outcome && outcome.resolved) {
    return { ok: true, message: 'Your password has been updated. You can sign in now.' };
  }
  const status = outcome && Number(outcome.status);
  if (status === 400 || status === 401 || status === 404 || status === 410 || status === 422) {
    return {
      ok: false,
      message:
        'This reset link is invalid or has expired. Request a new one from the “Forgot password” screen.',
    };
  }
  return {
    ok: false,
    message: 'We couldn’t update your password just now. Please try again in a moment.',
  };
}

/** Client-side password rule shared by both screens. */
export function validateNewPassword(pw, confirm) {
  const p = String(pw || '');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (confirm != null && p !== String(confirm)) return 'The two passwords don’t match.';
  return null;
}

/** Base44's reset email link may carry the code as `token` or `reset_token`. */
export function readResetToken(search) {
  const q = new URLSearchParams(String(search || ''));
  return (q.get('reset_token') || q.get('token') || '').trim();
}
