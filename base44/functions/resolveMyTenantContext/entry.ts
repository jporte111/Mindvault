import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { TenantAuthError } from '../../shared/tenant.ts';

// Membership activation on sign-in (called best-effort from AuthContext).
//
// A pre-provisioned pending TenantMembership row (created by
// manageTenantMembers 'invite') matches on email until the invitee first
// signs in. This function is the ONE place that activation happens:
//   1. find the caller's active membership by user_id, or
//   2. activate the first pending row matching their email (in an ACTIVE
//      tenant), stamping user_id + status + activated_at.
// Then it keeps the denormalized user.data.tenant_id RLS stamp in sync with
// the authoritative membership. Idempotent — safe to call on every sign-in.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || !user.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const email = String(user.email || '').trim().toLowerCase();

    const byId = await base44.asServiceRole.entities.TenantMembership.filter({
      user_id: user.id,
    });
    let active = (byId || []).find((m: any) => m.status === 'active') || null;

    if (!active) {
      const pending = await base44.asServiceRole.entities.TenantMembership.filter({
        email,
        status: 'pending',
      });
      // Prefer an invite into an ACTIVE tenant if several exist.
      for (const row of pending || []) {
        let tenantOk = true;
        try {
          const tenant = await base44.asServiceRole.entities.Tenant.get(row.tenant_id);
          tenantOk = !tenant?.status || tenant.status === 'active';
        } catch (_) {
          tenantOk = false;
        }
        if (!tenantOk) continue;
        active = await base44.asServiceRole.entities.TenantMembership.update(row.id, {
          user_id: user.id,
          status: 'active',
          activated_at: new Date().toISOString(),
        });
        break;
      }
    }

    if (active?.tenant_id) {
      // Keep the denormalized RLS stamp in sync with the authoritative
      // membership (best-effort — never blocks sign-in).
      try {
        if (user.data?.tenant_id !== active.tenant_id) {
          await base44.auth.updateMe({ tenant_id: active.tenant_id });
        }
      } catch (_) {
        // Stamp sync is retryable on the next sign-in.
      }
      return Response.json({
        tenant_id: active.tenant_id,
        app_role: active.app_role,
        status: 'active',
      });
    }

    return Response.json({
      tenant_id: null,
      app_role: null,
      status: byId?.length ? (byId[0] as any).status : 'none',
    });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}