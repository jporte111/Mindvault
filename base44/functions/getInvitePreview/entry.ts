import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { previewInvitation } from '../../shared/invite.ts';

// PUBLIC / anonymous. Renders the accept page before the invitee has a
// session. Uses asServiceRole for the lookup (the Invitation entity is
// admin-only RLS). Returns ONLY display strings — never a tenant id, an
// invitation id, the raw email, or the token. A missing token and a genuinely
// absent invitation return the SAME shape, so there is no guessing oracle.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const token = String(body?.token || '').trim();
    if (!token) {
      return Response.json({ valid: false, reason: 'not_found' }, { status: 200 });
    }

    const preview = await previewInvitation(base44, token);
    if (!preview.found || preview.status !== 'pending') {
      return Response.json(
        { valid: false, reason: preview.found ? preview.status : 'not_found' },
        { status: 200 },
      );
    }

    return Response.json({
      valid: true,
      tenantName: preview.tenantName,
      tenantLogoUrl: preview.tenantLogoUrl,
      brandColor: preview.brandColor,
      roleLabel: preview.roleLabel,
      emailMasked: preview.emailMasked,
    });
  } catch (_error) {
    return Response.json({ valid: false, reason: 'error' }, { status: 200 });
  }
}
