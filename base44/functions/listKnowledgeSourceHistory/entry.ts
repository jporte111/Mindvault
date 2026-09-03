import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import {
  buildMindvaultLifecycle,
  displayFor,
} from '../../shared/mindvaultLifecycle.ts';
import { computeFreshness, DEFAULT_POLICY } from '../../shared/lifecycle/index.ts';
import { loadChunks } from '../../shared/chunkLifecycle.ts';

// Phase 6. Read-only lineage view for the admin lifecycle panel / version
// viewer: every version in a lineage with its plain-language displayState, the
// KnowledgeRevision ledger, the AuditEvent stream, and any open/failed
// operations. Lineage view labels (previous_version, has_open_draft) are
// computed HERE, never stored on a row. Admin only.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const url = new URL(req.url);
    const trainingId = url.searchParams.get('trainingId') || '';
    const body = await req.json().catch(() => ({}));
    const id = trainingId || String(body?.trainingId || '');
    if (!id) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    const T = base44.asServiceRole.entities.Training;
    const anchor = await T.get(id).catch(() => null);
    if (!anchor) return Response.json({ error: 'Training not found' }, { status: 404 });
    const lineageId = anchor.root_source_id || anchor.id;

    const [byRoot, self] = await Promise.all([
      T.filter({ root_source_id: lineageId }, 'version_number', 200).catch(() => []),
      T.get(lineageId).catch(() => null),
    ]);
    const map = new Map<string, any>();
    for (const t of byRoot) map.set(t.id, t);
    if (self && !map.has(self.id)) map.set(self.id, self);
    const lineage = [...map.values()].sort((a, b) => (a.version_number || 1) - (b.version_number || 1));

    const revisions = await base44.asServiceRole.entities.KnowledgeRevision.filter(
      { root_source_id: lineageId }, '-created_date', 200,
    ).catch(() => []);
    const operations = await base44.asServiceRole.entities.KnowledgeLifecycleOperation.filter(
      { root_source_id: lineageId }, '-started_at', 200,
    ).catch(() => []);
    const openOps = operations.filter((o: any) => !['completed', 'failed'].includes(o.status));
    const failedOps = operations.filter((o: any) => o.status === 'failed');

    const versionIds = new Set(lineage.map((t) => t.id));
    const audits = (await base44.asServiceRole.entities.AuditEvent.filter(
      { entity: 'Training' }, '-created_date', 500,
    ).catch(() => [])).filter((a: any) => versionIds.has(a.entity_id));

    const nowMs = Date.now();
    const versions = [];
    for (const t of lineage) {
      const chunks = await loadChunks(base44, t.id);
      const indexStaleOnActive = t.is_active_version !== false && chunks.some((c: any) => c.index_stale === true);
      const anyOpenOperation = openOps.some((o: any) => o.target_training_id === t.id);
      const needsManual = String(t.index_error || '').startsWith('manual reconciliation required');
      const freshness = computeFreshness(
        t.next_review_due_at,
        typeof t.source_review_interval_days === 'number' ? t.source_review_interval_days : null,
        nowMs,
        DEFAULT_POLICY,
      );
      const { displayState } = displayFor(t, lineage, {
        anyOpenOperation, indexStaleOnActive, needsManualReconciliation: needsManual, freshness,
      });
      versions.push({
        id: t.id,
        version_number: t.version_number || 1,
        is_active_version: t.is_active_version !== false,
        verification_status: t.verification_status || 'unverified',
        verified_by: t.verified_by || null,
        verified_at: t.verified_at || null,
        effective_from: t.effective_from || null,
        effective_until: t.effective_until || null,
        source_authority: t.source_authority || null,
        operational_process_id: t.operational_process_id || null,
        index_status: t.index_status || null,
        indexed_version_number: t.indexed_version_number ?? null,
        last_reviewed_at: t.last_reviewed_at || null,
        next_review_due_at: t.next_review_due_at || null,
        chunk_count: chunks.length,
        index_stale_units: chunks.filter((c: any) => c.index_stale === true).length,
        freshness,
        displayState,
      });
    }

    const activeVersion = lineage.find((t) => t.is_active_version !== false);
    return Response.json({
      lineage_id: lineageId,
      title: anchor.title || '',
      active_version_number: activeVersion?.version_number || null,
      has_open_draft: lineage.some(
        (t) => t.is_active_version === false && t.is_archived !== true && t.verification_status !== 'rejected',
      ),
      latest_version_number: lineage[lineage.length - 1]?.version_number || 1,
      needs_manual_reconciliation: versions.some((v) => v.displayState === 'needs_attention'),
      versions,
      revisions,
      open_operations: openOps.map(scrubOp),
      failed_operations: failedOps.map(scrubOp),
      audit: audits.map((a: any) => ({
        action: a.action, actor_type: a.actor_type, summary: a.summary, at: a.created_date,
      })),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});

// Diagnostics-shaped, but this endpoint is admin-only and used by the advanced
// panel; still keep it tidy.
function scrubOp(o: any) {
  return {
    operation_id: o.operation_id,
    action: o.action,
    status: o.status,
    failure_stage: o.failure_stage || null,
    failure_reason: o.failure_reason || null,
    target_training_id: o.target_training_id,
    started_at: o.started_at,
    resume_count: o.resume_count || 0,
  };
}
