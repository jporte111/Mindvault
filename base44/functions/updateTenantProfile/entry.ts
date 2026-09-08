import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireTenantAdminScope, TenantAuthError } from '../../shared/tenant.ts';

// Guarded company-details editing for the multi-tenant model.
//
// Client Admins update their OWN workspace's presentation details only —
// company name, logo, and brand color. The tenant is resolved from the
// AUTHORITATIVE membership server-side; a tenant_id in the payload is only
// ever honored for a platform Super Admin targeting a specific tenant.
// No security-relevant or internal field (status, plan, config, notes) is
// writable through this function.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').trim();
    if (action !== 'update') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

    const scope = await requireTenantAdminScope(base44, body?.tenant_id);
    const tenant = await base44.asServiceRole.entities.Tenant.get(scope.tenantId);
    if (!tenant) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }
    if (tenant.status && tenant.status !== 'active') {
      return Response.json(
        { error: 'This workspace is suspended — its details cannot be changed' },
        { status: 403 },
      );
    }

    const input = body?.fields || {};
    const fields: Record<string, any> = {};

    if (input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!name || name.length > 120) {
        return Response.json({ error: 'Enter a company name (up to 120 characters)' }, { status: 400 });
      }
      fields.name = name;
    }
    if (input.logo_url !== undefined) {
      const logo = String(input.logo_url || '').trim();
      if (logo.length > 500) {
        return Response.json({ error: 'Logo link is too long' }, { status: 400 });
      }
      fields.logo_url = logo;
    }
    if (input.brand_color !== undefined) {
      const color = String(input.brand_color || '').trim();
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return Response.json({ error: 'Brand color must be a hex color like #4F46E5' }, { status: 400 });
      }
      fields.brand_color = color;
    }

    if (Object.keys(fields).length === 0) {
      return Response.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const updated = await base44.asServiceRole.entities.Tenant.update(scope.tenantId, fields);
    return Response.json({ tenant: updated });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}