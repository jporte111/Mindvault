import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireReadAccess, TenantAuthError } from '../../shared/tenant.ts';

// Read-only: the caller's OWN workspace profile (name and branding), resolved
// from their verified ACTIVE membership. Tenant direct reads are admin-only;
// before this, members read it through an RLS rule keyed on the user-writable
// profile stamp, which a member could point at another tenant.
// Only display fields are returned — never config, plan, SSO, Drive folders
// or notes. A platform admin without a membership gets { workspace: null }.
const PUBLIC_FIELDS = ['id', 'name', 'slug', 'status', 'logo_url', 'brand_color'] as const;

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const access = await requireReadAccess(base44, body?.workspaceId ?? null);
    if (!access.tenantId) return Response.json({ workspace: null });
    const t = await base44.asServiceRole.entities.Tenant.get(access.tenantId).catch(() => null);
    if (!t) return Response.json({ workspace: null });
    const workspace: Record<string, unknown> = {};
    for (const k of PUBLIC_FIELDS) workspace[k] = t[k] ?? null;
    return Response.json({ workspace });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
