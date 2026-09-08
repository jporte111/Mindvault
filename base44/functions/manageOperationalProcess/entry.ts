import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  requireTenantAdminScope,
  TenantAuthError,
  withTenant,
} from '../../shared/tenant.ts';

// Guarded OperationalProcess writes for the multi-tenant model.
//
// The entity's RLS allows member READS within their own tenant and reserves
// direct writes for the Base44 admin (Super Admin). Client Admins (Base44 role
// 'user' + TenantMembership.app_role 'client_admin') perform all writes here,
// where authorization comes from the AUTHORITATIVE TenantMembership record —
// never from user profile stamps or request payloads.
//
//   Client Admin  -> own tenant only (cross-tenant id -> 403)
//   Client User   -> 403 (no administrative access)
//   Super Admin   -> any tenant (cross-tenant as intended); defaults to own membership

const ALLOWED_FIELDS = [
  'name',
  'description',
  'department',
  'criticality',
  'review_interval_days',
  'process_owner',
  'subject_matter_expert',
  'backup_sme',
  'knowledge_scope',
  'client_id',
  'status',
  'tags',
];

function sanitizeFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const key of ALLOWED_FIELDS) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').trim();

    // Authoritative authorization: resolves the caller's membership server-side.
    // A tenant id from the payload only widens scope for a Super Admin; for
    // everyone else a mismatched value is a hard 403.
    const scope = await requireTenantAdminScope(base44, body?.tenant_id);

    if (action === 'create') {
      const payload = sanitizeFields(body?.fields);
      if (!payload.name || !String(payload.name).trim()) {
        return Response.json({ error: 'Name is required' }, { status: 400 });
      }
      // Tenant always stamped from the verified scope — never from the payload.
      const created = await base44.asServiceRole.entities.OperationalProcess.create(
        withTenant(scope.tenantId, payload),
      );
      return Response.json({ process: created });
    }

    if (action === 'update') {
      const id = String(body?.id || '').trim();
      if (!id) return Response.json({ error: 'Process id is required' }, { status: 400 });

      const existing = await base44.asServiceRole.entities.OperationalProcess.get(id);
      if (!existing) return Response.json({ error: 'Process not found' }, { status: 404 });

      // Cross-tenant guard: the record's own tenant must equal the caller's
      // verified scope. A forged tenant id in the payload cannot reach here.
      if (existing.tenant_id !== scope.tenantId) {
        return Response.json(
          { error: 'Forbidden — cross-tenant access is not allowed' },
          { status: 403 },
        );
      }

      const updates = sanitizeFields(body?.fields);
      // tenant_id can never be moved by an update payload.
      delete updates.tenant_id;
      const updated = await base44.asServiceRole.entities.OperationalProcess.update(id, updates);
      return Response.json({ process: updated });
    }

    if (action === 'delete') {
      const id = String(body?.id || '').trim();
      if (!id) return Response.json({ error: 'Process id is required' }, { status: 400 });

      const existing = await base44.asServiceRole.entities.OperationalProcess.get(id);
      if (!existing) return Response.json({ error: 'Process not found' }, { status: 404 });

      // Same cross-tenant guard as update: the record's own tenant must equal
      // the caller's VERIFIED scope. A Client Admin can only ever delete within
      // their own tenant; a Super Admin must target the record's tenant explicitly.
      if (existing.tenant_id !== scope.tenantId) {
        return Response.json(
          { error: 'Forbidden — cross-tenant access is not allowed' },
          { status: 403 },
        );
      }

      await base44.asServiceRole.entities.OperationalProcess.delete(id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}