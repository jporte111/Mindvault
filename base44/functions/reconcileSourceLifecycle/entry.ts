import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { buildMindvaultLifecycle } from '../../shared/mindvaultLifecycle.ts';

// Phase 6. Operation-record-driven recovery. Scans stuck / failed
// KnowledgeLifecycleOperation rows and, for each, resumes an idempotent stage
// forward, rolls back a half-applied activation from the recorded prior-active,
// or — when there is no deterministic recovery — stale-marks the whole lineage
// and flags it for manual reconciliation. It NEVER picks a version by number.
//
// Available regardless of source_lifecycle_enabled (recovery must always work).
// Cron-eligible; also an admin button.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const { engine } = buildMindvaultLifecycle(base44, { redact });
    const report = await engine.reconcile({ id: user.id, role: user.role });
    return Response.json({ ok: report.ok, handled: report.handled, manual: report.manual });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
