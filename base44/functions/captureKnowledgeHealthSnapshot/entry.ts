import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import {
  planKnowledgeHealthSnapshots,
  upsertSnapshotRows,
} from '../../shared/health/snapshotCapture.ts';

// Phase 9 P9-1. Deterministic periodic capture. Thin Deno shell over the shared
// binding (base44/shared/health/snapshotCapture.ts): auth + the dryRun / flag
// write gate + HTTP Response. The binding runs the EXISTING Phase 7 current-
// health computation per scope (general + each active client), projects each
// payload to a KnowledgeHealthSnapshot aggregate row, and upserts exactly one
// row per (period_key, client_scope).
//
// dryRun DEFAULTS TO TRUE (safe): returns the planned rows, writes nothing.
// Write mode ({ dryRun: false }) additionally requires
// knowledge_health_snapshots_enabled === true and is refused — never silently
// executed — with a clear reason otherwise.
//
// Writes ONLY KnowledgeHealthSnapshot. Never Training, KnowledgeChunk,
// OperationalProcess, KnowledgeGap, Notification, or any other business entity.
// No LLM, no embeddings, no retrieval, no answer generation. Admin-only.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false; // default SAFE: dry-run
    const now = body?.now && !Number.isNaN(Date.parse(body.now)) ? Date.parse(body.now) : Date.now();

    const sysRow = await base44.asServiceRole.entities.AppConfig.filter({ key: 'system' })
      .catch(() => [])
      .then((r: any[]) => r?.[0]);
    const snapshotsEnabled = sysRow?.knowledge_health_snapshots_enabled === true;

    // Deterministic write gate: dry-run is always allowed (flag-independent
    // diagnostics); write mode is refused while the flag is false — the
    // refusal happens BEFORE any snapshot is planned or written.
    if (!dryRun && !snapshotsEnabled) {
      return Response.json({
        ok: false,
        dryRun: false,
        reason: 'snapshots_disabled',
        knowledge_health_snapshots_enabled: false,
        message:
          'Knowledge health snapshot writes are disabled (knowledge_health_snapshots_enabled is false). Dry-run remains available for diagnostics: call with { "dryRun": true }.',
      }, { status: 403 });
    }

    const plan = await planKnowledgeHealthSnapshots(base44, { now });

    if (dryRun) {
      return Response.json({
        ok: true,
        dryRun: true,
        period_key: plan.period_key,
        generated_at: plan.generated_at,
        planned_count: plan.rows.length,
        planned: plan.rows,
      });
    }

    const results = await upsertSnapshotRows(base44, plan.rows);
    return Response.json({
      ok: true,
      dryRun: false,
      period_key: plan.period_key,
      generated_at: plan.generated_at,
      written: results.length,
      results,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
