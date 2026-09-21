import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  requireExplicitTenantAdminScope,
  resolveTenantContext,
  TenantAuthError,
  APP_ROLE_CLIENT_ADMIN,
  APP_ROLE_CLIENT_USER,
} from '../../shared/tenant.ts';
import { createAndSendInvitation, revokeOpenInvitations } from '../../shared/invite.ts';

// Guarded TenantMembership administration for the multi-tenant model.
//
// The entity's RLS returns only a caller's OWN rows and reserves direct
// writes for the Base44 admin. All member administration happens HERE, where
// authorization comes from the AUTHORITATIVE TenantMembership record — never
// from user profile stamps or request payloads.
//
//   Client Admin  -> own tenant only (cross-tenant id -> 403)
//   Client User   -> 403
//   Super Admin   -> any tenant, explicitly targeted via tenant_id
//
// A tenant must always keep at least one ACTIVE client_admin — the last one
// cannot be demoted or revoked.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set([APP_ROLE_CLIENT_ADMIN, APP_ROLE_CLIENT_USER]);
const STATUS_ORDER = { active: 0, pending: 1, inactive: 2 };

async function listMembers(base44: any, tenantId: string) {
  const rows = await base44.asServiceRole.entities.TenantMembership.filter({
    tenant_id: tenantId,
  });
  // Latest invitation per email, so the Team page can show whether an
  // invite was sent, delivered, expired, or failed — never silently broken.
  const latestInvite = new Map<string, any>();
  try {
    const invites = await base44.asServiceRole.entities.Invitation.filter({
      tenant_id: tenantId,
    });
    for (const inv of invites || []) {
      const key = String(inv.email || "").toLowerCase();
      const cur = latestInvite.get(key);
      if (!cur || String(inv.created_date || "") >= String(cur.created_date || "")) {
        latestInvite.set(key, inv);
      }
    }
  } catch (_) {
    // Invite enrichment is display-only — the member list still loads.
  }
  const enriched = await Promise.all((rows || []).map(async (m: any) => {
    let display_name: string | null = null;
    if (m.user_id) {
      try {
        const u = await base44.asServiceRole.entities.User.get(m.user_id);
        display_name = u?.full_name || u?.email || null;
      } catch (_) {
        // User record unreachable — the member's email still displays.
      }
    }
    const inv = latestInvite.get(String(m.email || "").toLowerCase()) || null;
    const invite = inv
      ? {
          status: inv.status,
          sent_at: inv.sent_at || null,
          expires_at: inv.expires_at || null,
          delivered: !!inv.email_message_id,
        }
      : null;
    return { ...m, display_name, invite };
  }));
  return enriched.sort(
    (a: any, b: any) =>
      (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) ||
      String(a.email).localeCompare(String(b.email)),
  );
}

async function countOtherActiveClientAdmins(base44: any, tenantId: string, excludeId: string) {
  const rows = await base44.asServiceRole.entities.TenantMembership.filter({
    tenant_id: tenantId,
  });
  return (rows || []).filter(
    (m: any) => m.id !== excludeId && m.status === 'active' && m.app_role === APP_ROLE_CLIENT_ADMIN,
  ).length;
}

async function getScopedMembership(base44: any, scope: { tenantId: string }, rawId: string) {
  const id = String(rawId || '').trim();
  if (!id) return { error: Response.json({ error: 'Membership id is required' }, { status: 400 }) };
  const row = await base44.asServiceRole.entities.TenantMembership.get(id);
  if (!row) return { error: Response.json({ error: 'Member not found' }, { status: 404 }) };
  if (row.tenant_id !== scope.tenantId) {
    return {
      error: Response.json(
        { error: 'Forbidden — cross-tenant access is not allowed' },
        { status: 403 },
      ),
    };
  }
  return { row };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').trim();

    // Authoritative authorization. A Super Admin must target a tenant
    // explicitly (no silent fallback to their own membership tenant).
    const scope = await requireExplicitTenantAdminScope(base44, body?.tenant_id);
    const ctx = await resolveTenantContext(base44);

    if (action === 'list') {
      return Response.json({ members: await listMembers(base44, scope.tenantId) });
    }

    if (action === 'invite') {
      const email = String(body?.email || '').trim().toLowerCase();
      const app_role = String(body?.app_role || '').trim();
      if (!EMAIL_RE.test(email)) {
        return Response.json({ error: 'Enter a valid email address' }, { status: 400 });
      }
      if (!VALID_ROLES.has(app_role)) {
        return Response.json({ error: 'Invalid role' }, { status: 400 });
      }

      // A platform admin account can never become a tenant member.
      try {
        const existingUsers = await base44.asServiceRole.entities.User.filter({ email });
        if (existingUsers?.some?.((u: any) => u?.role === 'admin')) {
          return Response.json(
            { error: 'That email belongs to a platform admin and cannot be a team member' },
            { status: 400 },
          );
        }
      } catch (_) {
        // Best-effort guard; activation remains authoritative at sign-in.
      }

      const rows = await base44.asServiceRole.entities.TenantMembership.filter({
        tenant_id: scope.tenantId,
      });
      const dupe = (rows || []).some(
        (m: any) =>
          String(m.email).toLowerCase() === email &&
          (m.status === 'active' || m.status === 'pending'),
      );
      if (dupe) {
        return Response.json(
          { error: 'That person is already invited or on the team' },
          { status: 409 },
        );
      }

      // Pre-provisioned pending row — activated by resolveMyTenantContext at
      // the invitee's first sign-in.
      const member = await base44.asServiceRole.entities.TenantMembership.create({
        tenant_id: scope.tenantId,
        email,
        app_role,
        status: 'pending',
        invited_by: ctx.userId,
      });

      // Send the MindVault-branded invitation. The generic Base44 platform
      // invite (base44.users.inviteUser) is intentionally NOT sent. Email is
      // mocked unless the deployment is explicitly configured for live send
      // (INVITE_EMAIL_MODE=live + INVITE_ESP_API_KEY + INVITE_FROM). Activation
      // is authoritative via acceptTenantInvite (email match), with
      // resolveMyTenantContext as a fallback, so a send failure never blocks
      // the pending row.
      try {
        const sent = await createAndSendInvitation(base44, {
          tenantId: scope.tenantId,
          email,
          appRole: app_role,
          invitedByUserId: ctx.userId,
          membershipId: member.id,
        });
        return Response.json({ member, email_mocked: sent.mocked });
      } catch (err) {
        return Response.json(
          { member, email_error: err?.message || 'Invitation email could not be sent' },
          { status: 200 },
        );
      }
    }

    if (action === 'update_role') {
      const app_role = String(body?.app_role || '').trim();
      if (!VALID_ROLES.has(app_role)) {
        return Response.json({ error: 'Invalid role' }, { status: 400 });
      }
      const scoped = await getScopedMembership(base44, scope, body?.id);
      if (scoped.error) return scoped.error;
      const row = scoped.row;
      if (row.app_role === APP_ROLE_CLIENT_ADMIN && row.status === 'active' && app_role === APP_ROLE_CLIENT_USER) {
        const others = await countOtherActiveClientAdmins(base44, scope.tenantId, row.id);
        if (others === 0) {
          return Response.json(
            { error: 'A team must keep at least one active Client Admin' },
            { status: 400 },
          );
        }
      }
      const updated = await base44.asServiceRole.entities.TenantMembership.update(row.id, {
        app_role,
      });
      return Response.json({ member: updated });
    }

    if (action === 'revoke') {
      const scoped = await getScopedMembership(base44, scope, body?.id);
      if (scoped.error) return scoped.error;
      const row = scoped.row;
      if (row.status === 'active' && row.app_role === APP_ROLE_CLIENT_ADMIN) {
        const others = await countOtherActiveClientAdmins(base44, scope.tenantId, row.id);
        if (others === 0) {
          return Response.json(
            { error: 'A team must keep at least one active Client Admin' },
            { status: 400 },
          );
        }
      }
      const updated = await base44.asServiceRole.entities.TenantMembership.update(row.id, {
        status: 'inactive',
      });
      // Cancel any still-open invitation so a not-yet-accepted link cannot be
      // used after the member has been removed.
      try {
        await revokeOpenInvitations(base44, scope.tenantId, row.email, ctx.userId);
      } catch (_) {
        // Best-effort — the membership is already inactive, which is the gate.
      }
      return Response.json({ member: updated });
    }

    // Hard delete — permanently removes the membership row (and with it the
    // email) from the team. Same safeguards as revoke: the last active Client
    // Admin cannot be deleted, and an admin cannot delete their own
    // membership. Any still-open invitation link is cancelled first.
    if (action === 'delete') {
      const scoped = await getScopedMembership(base44, scope, body?.id);
      if (scoped.error) return scoped.error;
      const row = scoped.row;
      if (row.user_id && row.user_id === ctx.userId) {
        return Response.json(
          { error: "You can't delete your own membership — ask another Client Admin to remove you" },
          { status: 400 },
        );
      }
      if (row.status === 'active' && row.app_role === APP_ROLE_CLIENT_ADMIN) {
        const others = await countOtherActiveClientAdmins(base44, scope.tenantId, row.id);
        if (others === 0) {
          return Response.json(
            { error: 'A team must keep at least one active Client Admin' },
            { status: 400 },
          );
        }
      }
      try {
        await revokeOpenInvitations(base44, scope.tenantId, row.email, ctx.userId);
      } catch (_) {
        // Best-effort — the membership deletion below is the real gate.
      }
      await base44.asServiceRole.entities.TenantMembership.delete(row.id);
      return Response.json({ deleted: true, email: row.email });
    }

    if (action === 'reactivate') {
      const scoped = await getScopedMembership(base44, scope, body?.id);
      if (scoped.error) return scoped.error;
      const row = scoped.row;
      // An invited user who never signed in goes back to 'pending'; a formerly
      // active member becomes 'active' again immediately.
      const status = row.user_id ? 'active' : 'pending';
      const updated = await base44.asServiceRole.entities.TenantMembership.update(row.id, {
        status,
      });
      // A never-signed-in member returning to 'pending' needs a fresh, valid
      // invitation link (the prior one was revoked when they were removed).
      if (status === 'pending' && VALID_ROLES.has(row.app_role)) {
        try {
          const sent = await createAndSendInvitation(base44, {
            tenantId: scope.tenantId,
            email: row.email,
            appRole: row.app_role,
            invitedByUserId: ctx.userId,
            membershipId: row.id,
          });
          return Response.json({ member: updated, email_mocked: sent.mocked });
        } catch (err) {
          return Response.json(
            { member: updated, email_error: err?.message || 'Invitation email could not be sent' },
            { status: 200 },
          );
        }
      }
      return Response.json({ member: updated });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}