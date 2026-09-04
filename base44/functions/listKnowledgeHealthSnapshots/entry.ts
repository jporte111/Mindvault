import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import {
  buildTrendSeries,
  TREND_SERIES_DIMENSIONS,
  TREND_SERIES_GOVERNANCE_DIMENSIONS,
  TREND_SERIES_MAX_PERIODS,
} from '../../shared/health/trendSeries.ts';

// Phase 9 P9-2 — read-only, bounded, admin-only history read for the multi-
// period trend visual on /continuity. It reads KnowledgeHealthSnapshot rows for
// ONE exact client_scope, newest-first, capped at TREND_SERIES_MAX_PERIODS (12),
// and returns both the raw rows (aggregate-only — no person data) and the
// per-dimension chronological series shaped by the pure buildTrendSeries helper.
// No interpolation: a month with no snapshot is simply absent.
//
// Gated on knowledge_health_enabled (same as the dashboard). Writes nothing.
// No LLM, no embeddings, no retrieval.
//
// Body: { scope?: 'general' | { clientId: string }, limit?: number }

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
    const client_scope = body?.scope && typeof body.scope === 'object' && body.scope.clientId
      ? `client:${String(body.scope.clientId)}`
      : 'general';

    const rawLimit = Number(body?.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(TREND_SERIES_MAX_PERIODS, Math.floor(rawLimit)))
      : TREND_SERIES_MAX_PERIODS;

    // Exact-string scope match is the isolation boundary — a client:A caller can
    // only ever read client:A rows. Newest-first, bounded.
    const rows = await base44.asServiceRole.entities.KnowledgeHealthSnapshot
      .filter({ client_scope }, '-period_key', limit)
      .catch(() => []);

    const dims = [...TREND_SERIES_DIMENSIONS, ...TREND_SERIES_GOVERNANCE_DIMENSIONS];
    const series = buildTrendSeries(rows as any[], dims as any);

    const periods = (rows as any[])
      .map((r) => r?.period_key)
      .filter((k) => typeof k === 'string')
      .sort();

    return Response.json({
      client_scope,
      limit,
      count: periods.length,
      period_range: periods.length ? { first: periods[0], last: periods[periods.length - 1] } : null,
      snapshots: rows, // aggregate rows only — admin-only, no person data
      series,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
