import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { buildMindvaultLifecycle } from '../../shared/mindvaultLifecycle.ts';

// Phase 6. Retryable, outcome-verified reindex of ONE knowledge source version,
// via the lifecycle engine's [F2] plan (no-op only when fingerprint + unit set
// + denormalized projection are all clean; otherwise repair + verify). Used by
// the admin lifecycle panel's "Re-index" / "Needs attention" retry.
//
// Stays available even when source_lifecycle_enabled is off — it is a repair
// tool, and a stale/failed index must be fixable regardless.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const versionId = String(body?.versionId || body?.trainingId || '');
    if (!versionId) return Response.json({ error: 'versionId is required' }, { status: 400 });

    const diag = new URL(req.url).searchParams.get('diag') === '1';
    const { engine } = buildMindvaultLifecycle(base44, { redact });
    const res = await engine.reindex({ id: user.id, role: user.role }, versionId);

    if (!res.ok) {
      return Response.json(
        { ok: false, error: res.error, ...(diag ? { operationId: res.operationId } : {}) },
        { status: res.error === 'stale_state' ? 409 : 422 },
      );
    }
    return Response.json({
      ok: true,
      displayState: res.displayState,
      noOp: res.noOp === true,
      ...(diag ? { operationId: res.operationId } : {}),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
