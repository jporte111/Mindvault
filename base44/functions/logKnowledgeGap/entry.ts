import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { reporterHmac } from '../../shared/reporterId.ts';
import { GAP_ORIGINS } from '../../shared/knowledgeGap.ts';
import { aggregateGap } from '../../shared/gapAggregation.ts';

// Phase 5. Thin wrapper over the shared gap-aggregation helper. Auth me() only.
// Gated on knowledge_gaps_enabled. Deterministic lexical dedupe, no embeddings.
// Writes ONLY KnowledgeGap + AuditEvent. Never touches Training / KnowledgeChunk
// / OperationalProcess.

function normScope(v: unknown): string {
  const s = typeof v === 'string' ? v : 'general';
  return s === 'general' || s.startsWith('client:') ? s : 'general';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    const sysRow = (await base44.asServiceRole.entities.AppConfig
      .filter({ key: 'system' }).catch(() => []))?.[0];
    if (sysRow?.knowledge_gaps_enabled !== true) {
      return Response.json({ recorded: false, reason: 'disabled' });
    }
    const loggingEnabled = sysRow?.answer_logging_enabled === true;

    // No fallback secret: fail safely if misconfigured.
    const gapSecret = Deno.env.get('GAP_HMAC_SECRET');
    if (!gapSecret || !gapSecret.trim()) {
      console.error(JSON.stringify({ fn: 'logKnowledgeGap', stage: 'config', error: 'GAP_HMAC_SECRET is not set' }));
      return Response.json(
        { error: 'gaps_not_configured', detail: 'This deployment is missing GAP_HMAC_SECRET.' },
        { status: 503 },
      );
    }
    const rhmac = await reporterHmac(user.id, gapSecret);
    const question = typeof body?.question === 'string' ? body.question.slice(0, 1000) : '';
    const origin = (GAP_ORIGINS as readonly string[]).includes(body?.origin) ? body.origin : 'manual';

    const res = await aggregateGap(base44, {
      question: question || undefined,
      normalizedTopic: typeof body?.normalizedTopic === 'string' ? body.normalizedTopic : undefined,
      clientScope: normScope(body?.clientScope),
      operationalProcessId: typeof body?.operationalProcessId === 'string' ? body.operationalProcessId : undefined,
      relatedSourceIds: Array.isArray(body?.relatedSourceIds)
        ? body.relatedSourceIds.filter((x: unknown) => typeof x === 'string').slice(0, 40) : [],
      missingFacets: Array.isArray(body?.missingFacets)
        ? body.missingFacets.filter((x: unknown) => typeof x === 'string').slice(0, 20) : [],
      origin: origin as any,
      reporterHmac: rhmac,
      exampleQuestion: loggingEnabled && question ? question : null,
    });

    return Response.json({ recorded: true, ...res });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
