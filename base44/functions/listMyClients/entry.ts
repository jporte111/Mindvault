import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireReadAccess, TenantAuthError } from '../../shared/tenant.ts';
import { fetchInScope, readScopeFor, sortRows } from '../../shared/recordScope.ts';

// Read-only: the Client rows the caller may see (client pickers, client
// management). Same scope as listKnowledgeSources: platform admins see
// every row, members only their membership tenant's clients (plus legacy
// untagged rows while LEGACY_UNTAGGED_VISIBLE).
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const access = await requireReadAccess(base44, body?.workspaceId ?? null);
    const { rows, truncated } = await fetchInScope(base44.asServiceRole.entities.Client, readScopeFor(access));
    if (truncated) console.warn('listMyClients: result reached the read limit; rows may be missing');
    return Response.json({ clients: sortRows(rows, 'name'), truncated });
  } catch (error) {
    if (error instanceof TenantAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
