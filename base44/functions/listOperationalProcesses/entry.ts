import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { visibleProcesses } from '../../shared/processAccess.ts';
import {
  resolveTenantContext,
  TenantAuthError,
  APP_ROLE_CLIENT_ADMIN,
} from '../../shared/tenant.ts';

// Scoped read helper for OperationalProcess (multi-tenant).
//
// Authorization comes from the AUTHORITATIVE TenantMembership record via
// resolveTenantContext — never from user profile stamps or request payloads.
//   Super Admin  -> all processes across tenants (optionally filtered by tenant_id)
//   Client Admin -> every process in their own tenant
//   Client User  -> organization-wide ('general') processes in their own tenant only
// Cross-tenant results are never returned to tenant members.

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const ctx = await resolveTenantContext(base44);
    const all = await base44.asServiceRole.entities.OperationalProcess.list('name', 1000);

    let rows = all;
    if (ctx.isSuperAdmin) {
      const target = String(body?.tenant_id || '').trim();
      if (target) rows = rows.filter((p) => p.tenant_id === target);
    } else {
      if (!ctx.hasTenantAccess || !ctx.tenantId) {
        return Response.json(
          { error: 'Forbidden — no active tenant membership' },
          { status: 403 },
        );
      }
      rows = rows.filter((p) => p.tenant_id === ctx.tenantId);
      if (ctx.appRole !== APP_ROLE_CLIENT_ADMIN) {
        rows = visibleProcesses(user, rows);
      }
    }
    return Response.json({ processes: rows });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}