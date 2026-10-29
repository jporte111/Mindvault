import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireReadAccess, TenantAuthError } from '../../shared/tenant.ts';
import { fetchInScope, readScopeFor, sortRows } from '../../shared/recordScope.ts';

// Read-only: the knowledge sources (Training rows) the caller may see.
// Training direct reads are admin-only, so every member-facing page lists
// sources here. Platform admins see every row; members see only their
// verified membership tenant's rows (plus legacy untagged rows while
// LEGACY_UNTAGGED_VISIBLE, see shared/recordScope.ts). Never another
// tenant's rows, whatever the body says.
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const access = await requireReadAccess(base44, body?.workspaceId ?? null);
    const scope = readScopeFor(access);

    const query: Record<string, unknown> = {};
    if (typeof body?.status === 'string' && body.status) query.status = body.status;
    const { rows, truncated } = await fetchInScope(base44.asServiceRole.entities.Training, scope, query);
    if (truncated) console.warn('listKnowledgeSources: result reached the read limit; rows may be missing');
    const sources = sortRows(rows, body?.sort ?? '-created_date');
    return Response.json({ sources, truncated });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
