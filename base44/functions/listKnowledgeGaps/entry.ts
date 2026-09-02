import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';

// Phase 5. Admin-only read of KnowledgeGap rows (employees have no gap-list UX).
// Read-only. Supports coarse filters.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const q: Record<string, unknown> = {};
    if (typeof body?.status === 'string') q.status = body.status;
    if (typeof body?.clientScope === 'string') q.client_scope = body.clientScope;
    if (typeof body?.operationalProcessId === 'string') q.operational_process_id = body.operationalProcessId;
    if (typeof body?.assignedSme === 'string') q.assigned_sme = body.assignedSme;
    if (typeof body?.priority === 'string') q.priority = body.priority;

    const limit = Math.min(500, Number(body?.limit) || 200);
    const gaps = await base44.asServiceRole.entities.KnowledgeGap
      .filter(Object.keys(q).length ? q : {}, '-last_seen_at', limit)
      .catch(() => []);

    return Response.json({ gaps });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
