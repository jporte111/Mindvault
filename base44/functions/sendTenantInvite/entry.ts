import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  requireExplicitTenantAdminScope,
  resolveTenantContext,
  TenantAuthError,
  APP_ROLE_CLIENT_ADMIN,
  APP_ROLE_CLIENT_USER,
} from '../../shared/tenant.ts';
import { createAndSendInvitation } from '../../shared/invite.ts';

// Re-issue a MindVault-branded invitation for an email that already has a
// PENDING membership in the caller's tenant (the "Resend invite" action). The
// first invite is created by manageTenantMembers 'invite'; this reuses that
// pending row, mints a fresh single-use token, and supersedes the old one.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set([APP_ROLE_CLIENT_ADMIN, APP_ROLE_CLIENT_USER]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Authoritative authorization — Client Admin scoped to own tenant; a
    // Super Admin must target a tenant explicitly.
    const scope = await requireExplicitTenantAdminScope(base44, body?.tenant_id);
    const ctx = await resolveTenantContext(base44);

    const email = String(body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return Response.json({ error: 'Enter a valid email address' }, { status: 400 });
    }

    // A platform-admin account can never be a tenant member.
    try {
      const existing = await base44.asServiceRole.entities.User.filter({ email });
      if (existing?.some?.((u: any) => u?.role === 'admin')) {
        return Response.json(
          { error: 'That email belongs to a platform admin and cannot be a team member' },
          { status: 400 },
        );
      }
    } catch (_) {
      // Best-effort — activation remains authoritative at accept time.
    }

    const members = await base44.asServiceRole.entities.TenantMembership.filter({
      tenant_id: scope.tenantId,
      email,
    });
    const pending = (members || []).find((m: any) => m.status === 'pending');
    if (!pending) {
      return Response.json(
        { error: 'No pending invitation for that email — invite them from the Team page first' },
        { status: 404 },
      );
    }
    if (!VALID_ROLES.has(pending.app_role)) {
      return Response.json({ error: 'That membership has an invalid role' }, { status: 400 });
    }

    const result = await createAndSendInvitation(base44, {
      tenantId: scope.tenantId,
      email,
      appRole: pending.app_role,
      invitedByUserId: ctx.userId,
      membershipId: pending.id,
    });

    return Response.json({ sent: true, mocked: result.mocked });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}
