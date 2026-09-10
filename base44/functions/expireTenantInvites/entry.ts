import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { expireStaleInvitations } from '../../shared/invite.ts';

// Maintenance sweep — flips every past-due PENDING invitation to 'expired' and
// writes an audit event. Idempotent and side-effect-free beyond that (it never
// touches memberships, tenants, or non-expired rows), so it is safe to run
// unauthenticated from a Base44 workflow/cron. previewInvitation and
// acceptTenantInvite also expire lazily, so this is only a tidy-up.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const expired = await expireStaleInvitations(base44);
    return Response.json({ expired });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}
