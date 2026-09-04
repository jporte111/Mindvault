import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { computeKnowledgeHealth } from '../../shared/mindvaultHealth.ts';
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotFromHealthPayload,
} from '../../shared/health/snapshotProjection.ts';
import { computeTrend } from '../../shared/health/trend.ts';
import { priorityRationale } from '../../shared/health/priorityRationale.ts';
import { governanceCompletenessRow } from '../../shared/health/governanceCompleteness.ts';
import {
  computeContinuityChange,
  computeGapChange,
  isFingerprintBearing,
  LONG_UNRESOLVED_PERIODS,
} from '../../shared/health/continuityChange.ts';

// Phase 7 — admin-only read for the Operational Continuity dashboard. Pure
// deterministic aggregation over governed entities: NO embeddings, NO LLM, NO
// retrieval changes, NO KnowledgeChunk content / index_stale. Gated on
// AppConfig key:'system' knowledge_health_enabled (default false) so the whole
// feature stays dark until it is deliberately switched on.
//
// Phase 9 P9-1: this function boundary — NOT the Phase 7 engine — optionally
// enriches the response with a deterministic `trend` block. The engine
// (base44/shared/mindvaultHealth.ts computeKnowledgeHealth) stays the source of
// CURRENT health only: it never reads the P9 flag, never queries
// KnowledgeHealthSnapshot, never computes a trend. When
// knowledge_health_snapshots_enabled is false the payload is returned
// byte-for-byte unchanged apart from the P9-2 presentation fields below.
//
// Phase 9 P9-2 (also at this boundary, always on with the dashboard, no extra
// flag, purely additive): a deterministic `rationale` string on every
// addressFirst / reviewQueue item (built only from its kind + criticality) and
// a `governance` completeness sub-object on every processRow (a plain-language
// restatement of fields already in the payload — no new health rule).
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

    // Phase 9 P9-2 presentation enrichment — pure, deterministic, additive.
    const withRationale = (it: any) => ({
      ...it,
      rationale: priorityRationale({ kind: it?.kind, criticality: it?.criticality }),
    });
    const enriched = {
      ...payload,
      addressFirst: (payload.addressFirst || []).map(withRationale),
      reviewQueue: (payload.reviewQueue || []).map(withRationale),
      processRows: (payload.processRows || []).map((r: any) => ({
        ...r,
        governance: governanceCompletenessRow(r),
      })),
    };

    // Phase 9 P9-1 trend enrichment — flag-gated, additive, backward compatible.
    if (sysRows?.[0]?.knowledge_health_snapshots_enabled !== true) {
      return Response.json(enriched); // no `trend` key
    }

    const period_key = new Date().toISOString().slice(0, 7); // 'YYYY-MM', current period
    const client_scope = scope.kind === 'client' ? `client:${scope.clientId}` : 'general';

    // Latest prior snapshot for THIS EXACT client_scope. Exact-string scope match
    // is the isolation boundary: a client:A request can only ever read client:A
    // rows. '-period_key' sorts YYYY-MM newest-first; take the newest strictly
    // before the current period. (No $lt operator is used anywhere in this repo,
    // so the "< current period" filter is applied in memory.)
    const priorRows = await base44.asServiceRole.entities.KnowledgeHealthSnapshot
      .filter({ client_scope }, '-period_key', 24)
      .catch(() => []);
    const prior = (priorRows as any[]).find((r) => String(r?.period_key) < period_key) || null;

    const current = snapshotFromHealthPayload(payload, {
      period_key,
      schema_version: SNAPSHOT_SCHEMA_VERSION,
    });
    const trend = computeTrend(current, prior);

    // Phase 9 P9-3 — persisted-vs-persisted change detection. It compares the
    // latest fingerprint-bearing monthly snapshot for THIS exact client_scope
    // against its immediately prior fingerprint-bearing snapshot. It never
    // builds or compares a live current fingerprint (the live payload has no
    // resolved gaps). Pre-P9-3 rows carry no fingerprint_version and are
    // skipped as non-fingerprint-bearing history; a newer incompatible
    // fingerprint_version yields comparable:false — the newer period is never
    // silently skipped for an older pair.
    const fpRows = (priorRows as any[]).filter(isFingerprintBearing); // already '-period_key' newest-first
    const latestFp = fpRows[0] || null;
    const priorFp = fpRows[1] || null;
    const change = {
      continuity: computeContinuityChange(latestFp, priorFp),
      gaps: computeGapChange(latestFp, priorFp, fpRows.slice(0, LONG_UNRESOLVED_PERIODS + 2)),
    };

    return Response.json({ ...enriched, trend, change });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
