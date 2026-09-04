import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { computeNotificationFindings } from '../../shared/notification/mindvaultNotifications.ts';
import {
  planReconciliation,
  rowFromDraft,
  type FindingDraft,
  type ReconcilePlan,
} from '../../shared/notification/engine.ts';

// Phase 8 P8-1. Deterministic notification reconciliation: computes the six
// P8-1 findings as a projection of governed state and diffs them against
// existing Notification episodes (create / remind / resolve / retarget).
//
// P8-1 builds the function but does NOT schedule it — the scheduled workflow
// and the notifications_enabled flag belong to P8-2. dryRun DEFAULTS TO TRUE
// (safe): an explicit { "dryRun": false } is required for any write.
//
// Never deletes notifications; never invokes LLMs or embeddings; no retrieval or
// answer-generation effects. Admin-only.

function createsByKind(plan: ReconcilePlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of plan.creates) {
    out[c.draft.kind] = (out[c.draft.kind] || 0) + 1;
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false; // default SAFE: dry-run
    const now = body?.now && !Number.isNaN(Date.parse(body.now)) ? Date.parse(body.now) : Date.now();

    const { findings, stats } = await computeNotificationFindings(base44, { now });
    const existing = await base44.asServiceRole.entities.Notification.filter(
      {},
      '-created_date',
      5000,
    ).catch(() => []);

    const plan = planReconciliation(findings as FindingDraft[], existing || [], now);
    const generated_at = new Date(now).toISOString();

    if (dryRun) {
      return Response.json({
        ok: true,
        dryRun: true,
        generated_at,
        counts: { ...plan.counts, findings: findings.length },
        creates_by_kind: createsByKind(plan),
        stats,
      });
    }

    // Write mode — service-role writes (RLS create/update are admin-only, and
    // service role is the reconciliation actor). Only the plan executes; no
    // deletes, no reopens.
    const svc = base44.asServiceRole.entities.Notification;
    const created = plan.creates.length
      ? await svc.bulkCreate(plan.creates.map((c) => rowFromDraft(c.draft, now)))
      : [];
    const reminded = plan.reminders.length ? await svc.bulkUpdate(plan.reminders) : [];
    const resolved = plan.resolves.length ? await svc.bulkUpdate(plan.resolves) : [];
    const n = (x: unknown, fallback: number) => (Array.isArray(x) ? x.length : fallback);

    return Response.json({
      ok: true,
      dryRun: false,
      generated_at,
      counts: {
        created: n(created, plan.creates.length),
        reminded: n(reminded, plan.reminders.length),
        resolved: n(resolved, plan.resolves.length) - plan.retargetedRowIds.length,
        retargeted: plan.retargetedRowIds.length,
        findings: findings.length,
      },
      creates_by_kind: createsByKind(plan),
      stats,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});