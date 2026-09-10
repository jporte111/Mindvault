// Pure copy + state mapping for the MindVault invite-accept page. No React,
// no network — unit-tested in scripts/rag-eval/accept-invite.test.mjs.

/**
 * A getInvitePreview response ({ valid, reason }) → what the branded page
 * should show. `reason` mirrors the Invitation status for an invalid link.
 */
export function previewState(res) {
  if (res && res.valid === true) {
    return { kind: 'ready' };
  }
  const reason = res && res.reason ? String(res.reason) : 'not_found';
  const map = {
    not_found: {
      kind: 'invalid',
      title: 'This invitation link isn’t valid',
      body: 'The link may be incomplete or mistyped. Ask whoever invited you to send a new one.',
    },
    expired: {
      kind: 'invalid',
      title: 'This invitation has expired',
      body: 'Invitations are valid for a limited time. Ask your admin to send a fresh invitation.',
    },
    revoked: {
      kind: 'invalid',
      title: 'This invitation was cancelled',
      body: 'Your admin cancelled this invitation. Ask them to send a new one if you still need access.',
    },
    accepted: {
      kind: 'invalid',
      title: 'This invitation has already been used',
      body: 'If this was you, just sign in to MindVault. Otherwise ask your admin for a new invitation.',
    },
    error: {
      kind: 'invalid',
      title: 'We couldn’t load this invitation',
      body: 'Please try again in a moment. If it keeps happening, ask your admin to resend the invitation.',
    },
  };
  return map[reason] || map.not_found;
}

/**
 * An acceptTenantInvite failure ({ reason }) → a short, honest message. Never
 * claims success. `email_mismatch` tells the user which address to use
 * without revealing the full invited address.
 */
export function acceptErrorMessage(reason) {
  const map = {
    unauthorized: 'Please sign in first, then accept the invitation.',
    not_found: 'This invitation link isn’t valid anymore. Ask your admin to resend it.',
    revoked: 'This invitation was cancelled. Ask your admin to send a new one.',
    already_accepted: 'This invitation has already been used. Try signing in to MindVault.',
    expired: 'This invitation has expired. Ask your admin to send a new one.',
    email_mismatch:
      'You’re signed in with a different email than the one this invitation was sent to. Sign out and use the invited address.',
    tenant_inactive: 'That workspace isn’t active right now. Contact your admin.',
    error: 'Something went wrong accepting the invitation. Please try again.',
  };
  return map[reason] || map.error;
}

/** "Client Admin" / "Client User" → a one-line plain-English description. */
export function roleDescription(roleLabel) {
  const l = String(roleLabel || '').toLowerCase();
  if (l.includes('admin')) {
    return 'You’ll be able to manage this workspace — its knowledge, processes, and team.';
  }
  if (l.includes('user')) {
    return 'You’ll be able to ask questions and browse your team’s knowledge.';
  }
  return 'You’ll get access to your team’s MindVault workspace.';
}
