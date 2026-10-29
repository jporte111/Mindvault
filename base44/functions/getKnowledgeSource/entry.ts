import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireReadAccess, TenantAuthError } from '../../shared/tenant.ts';
import { inReadScope, readScopeFor } from '../../shared/recordScope.ts';

// Read-only: one knowledge source (Training row) by id, if the caller may
// see it (same scope as listKnowledgeSources). A row of another tenant gets
// the same 404 as a missing one, so ids of other tenants can't be probed.
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const access = await requireReadAccess(base44, body?.workspaceId ?? null);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const row = await base44.asServiceRole.entities.Training.get(id).catch(() => null);
    if (!row || !inReadScope(row, readScopeFor(access))) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ source: row });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
