import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { visibleProcesses } from '../../shared/processAccess.ts';

// Scoped read helper for OperationalProcess.
//
// The entity's RLS is admin-only for every operation, so non-admins cannot read
// it directly. This function returns the subset a caller is allowed to see:
//   admin           -> all processes
//   any other user  -> organization-wide ('general') processes only
// It never exposes 'client-specific' or 'unclassified' processes to non-admins,
// because the user model has no user<->client authorization data.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const all = await base44.asServiceRole.entities.OperationalProcess.list('name', 1000);
    return Response.json({ processes: visibleProcesses(user, all) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
