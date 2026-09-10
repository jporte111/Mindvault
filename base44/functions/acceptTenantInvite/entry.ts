import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { activateInvitedMembership } from '../../shared/invite.ts';

// AUTHENTICATED. Called by the accept page immediately after the invitee has
// signed in (Google / Microsoft / email+password). It consumes the invitation
// and activates the authoritative TenantMembership.
//
//   - tenant + role are taken ONLY from the stored Invitation row
//   - activation requires the authenticated Base44 email to match the invite
//   - single-use: a consumed invite is inert; a replay by the SAME user is an
//     idempotent success; by a different user it is 409
//   - the response never echoes the tenant id — the membership is already
//     active server-side; the client just redirects home

const REASON_MESSAGE: Record<string, string> = {
  unauthorized: 'Sign in to accept this invitation.',
  not_found: 'This invitation link is not valid.',
  revoked: 'This invitation has been revoked. Ask your admin to send a new one.',
  already_accepted: 'This invitation has already been used.',
  expired: 'This invitation has expired. Ask your admin to send a new one.',
  email_mismatch:
    'This invitation was sent to a different email address. Sign in with that address to accept it.',
  tenant_inactive: 'That workspace is not active. Contact your admin.',
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user || !user.id) {
      return Response.json({ error: REASON_MESSAGE.unauthorized, reason: 'unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token || '').trim();
    if (!token) {
      return Response.json({ error: REASON_MESSAGE.not_found, reason: 'not_found' }, { status: 400 });
    }

    const result = await activateInvitedMembership(base44, token, { id: user.id, email: user.email });
    if (!result.ok) {
      return Response.json(
        { error: REASON_MESSAGE[result.reason || ''] || 'Could not accept this invitation', reason: result.reason },
        { status: result.status },
      );
    }

    return Response.json({ accepted: true, idempotent: !!result.idempotent, role: result.app_role });
  } catch (_error) {
    return Response.json({ error: 'Could not accept this invitation', reason: 'error' }, { status: 500 });
  }
}
