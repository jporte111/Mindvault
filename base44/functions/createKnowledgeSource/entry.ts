import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import {
  requireTenantAdminScope,
  TenantAuthError,
  withTenant,
} from '../../shared/tenant.ts';

// Guarded Training creation for the multi-tenant model.
//
// The entity's RLS reserves direct creates for the Base44 admin (Super
// Admin). Client Admins create knowledge sources HERE, where the tenant is
// stamped from the AUTHORITATIVE, server-verified scope — never from the
// request payload. tenant_id is immutable after create.
//
//   Client Admin  -> own tenant only
//   Client User   -> 403 (no administrative access)
//   Super Admin   -> any tenant, explicitly targeted

const ALLOWED_FIELDS = [
  'title',
  'transcript',
  'video_url',
  'source_type',
  'source_format',
  'source_filename',
  'source_url',
  'knowledge_scope',
  'client_id',
  'client_name',
  'department',
  'presenter',
  'tags',
];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'create').trim();
    if (action !== 'create') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

    // Authoritative authorization: resolves the caller's membership
    // server-side. A payload tenant_id only widens scope for a Super Admin.
    const scope = await requireTenantAdminScope(base44, body?.tenant_id);

    // A suspended/archived tenant cannot add knowledge.
    const tenant = await base44.asServiceRole.entities.Tenant.get(scope.tenantId);
    if (tenant && tenant.status && tenant.status !== 'active') {
      return Response.json(
        { error: `This workspace is ${tenant.status} — knowledge cannot be added` },
        { status: 403 },
      );
    }

    const input = body?.fields && typeof body.fields === 'object' ? body.fields : {};
    const fields: Record<string, any> = {};
    for (const key of ALLOWED_FIELDS) {
      if (input[key] !== undefined) fields[key] = input[key];
    }

    if (!fields.title || !String(fields.title).trim()) {
      return Response.json({ error: 'Title is required' }, { status: 400 });
    }
    if (!fields.transcript || !String(fields.transcript).trim()) {
      return Response.json({ error: 'A source text file is required' }, { status: 400 });
    }
    if (!fields.source_type || !String(fields.source_type).trim()) {
      return Response.json({ error: 'Knowledge type is required' }, { status: 400 });
    }

    // client fields are only meaningful with a client-specific scope.
    if (fields.knowledge_scope !== 'client-specific') {
      delete fields.client_id;
      delete fields.client_name;
    }
    if (fields.knowledge_scope === 'client-specific' && !fields.client_id) {
      return Response.json(
        { error: 'Choose which client this knowledge belongs to' },
        { status: 400 },
      );
    }

    // Tenant always stamped from the verified scope — never from the payload.
    const training = await base44.asServiceRole.entities.Training.create(
      withTenant(scope.tenantId, { ...fields, status: 'processing' }),
    );
    return Response.json({ training });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}