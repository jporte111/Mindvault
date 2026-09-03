import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { computeKnowledgeHealth } from '../../shared/mindvaultHealth.ts';

// Phase 7 — admin-only read for the Operational Continuity dashboard. Pure
// deterministic aggregation over governed entities: NO embeddings, NO LLM, NO
// retrieval changes, NO KnowledgeChunk content / index_stale. Gated on
// AppConfig key:'system' knowledge_health_enabled (default false) so the whole
// feature stays dark until it is deliberately switched on.
//
// Body: { scope?: 'general' | { clientId: string }, vocabularyOverride? }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const sysRows = await base44.asServiceRole.entities.AppConfig.filter({ key: 'system' }).catch(() => []);
    if (sysRows?.[0]?.knowledge_health_enabled !== true) {
      return Response.json(
        { error: 'health_disabled', message: 'The Operational Continuity dashboard is turned off. Enable it in Admin → System.' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    let scope: any = { kind: 'general' };
    if (body?.scope && typeof body.scope === 'object' && body.scope.clientId) {
      scope = { kind: 'client', clientId: String(body.scope.clientId) };
    } else if (body?.scope === 'general' || body?.scope?.kind === 'general') {
      scope = { kind: 'general' };
    }

    let vocabularyOverride: unknown = undefined;
    try {
      const raw = sysRows?.[0]?.lifecycle_vocabulary; // optional shared override row
      if (raw && typeof raw === 'string') vocabularyOverride = JSON.parse(raw)?.health;
    } catch (_) { /* optional */ }

    const payload = await computeKnowledgeHealth(base44, { scope, vocabularyOverride });
    return Response.json(payload);
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
