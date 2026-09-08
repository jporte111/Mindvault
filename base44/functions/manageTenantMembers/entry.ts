import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  requireExplicitTenantAdminScope,
  resolveTenantContext,
  TenantAuthError,
  APP_ROLE_CLIENT_ADMIN,
  APP_ROLE_CLIENT_USER,
} from '../../shared/tenant.ts';

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
    return { ...m, display_name };
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

      // Send the email invitation (best-effort — activation is by email match
      // at first sign-in regardless of whether the email send succeeds).
      try {
        await base44.users.inviteUser(email, 'user');
      } catch (_) {
        // Already-invited or send-unavailable: the pending row still works.
      }

      return Response.json({ member });
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
      return Response.json({ member: updated });
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