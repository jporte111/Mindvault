import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { computeFreshness, DEFAULT_POLICY } from '../../shared/lifecycle/index.ts';

// Phase 6. Deterministic, date-only recompute of review freshness for knowledge
// sources (and, for parity, operational processes). Writes ONLY freshness
// scheduling fields and NEVER OperationalProcess.freshness_status — Phase 6 adds
// no new answer-path or ranking effect. Consumed only by the admin lifecycle
// panel and (later) Phase 7. Idempotent + paginated; admin only; cron-eligible.

function resolveIntervalDays(training: any, proc: any): number | null {
  if (typeof training?.source_review_interval_days === 'number') return training.source_review_interval_days;
  if (typeof proc?.review_interval_days === 'number') return proc.review_interval_days;
  return null;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const skip = Number(body?.skip) || 0;
    const limit = Math.min(50, Number(body?.limit) || 25);
    const nowMs = Date.now();

    const sources: any[] = await base44.asServiceRole.entities.Training.filter(
      { status: 'ready' }, '-created_date', limit, skip,
    ).catch(() => []);

    const procCache = new Map<string, any>();
    const getProc = async (id: string) => {
      if (!id) return null;
      if (procCache.has(id)) return procCache.get(id);
      const p = await base44.asServiceRole.entities.OperationalProcess.get(id).catch(() => null);
      procCache.set(id, p);
      return p;
    };

    const buckets: Record<string, number> = { current: 0, due_soon: 0, overdue: 0, unknown: 0 };
    let updated = 0;

    for (const t of sources) {
      const proc = await getProc(t.operational_process_id || '');
      const interval = resolveIntervalDays(t, proc);
      const nextDue = t.last_reviewed_at && interval
        ? addDays(t.last_reviewed_at, interval)
        : null;
      if (nextDue && nextDue !== (t.next_review_due_at || null)) {
        await base44.asServiceRole.entities.Training.update(t.id, { next_review_due_at: nextDue }).catch(() => {});
        updated++;
      }
      const fresh = computeFreshness(nextDue || t.next_review_due_at, interval, nowMs, DEFAULT_POLICY);
      buckets[fresh] = (buckets[fresh] || 0) + 1;
    }

    return Response.json({
      ok: true,
      processed: sources.length,
      next_skip: sources.length === limit ? skip + limit : null,
      updated_due_dates: updated,
      freshness_buckets: buckets,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
