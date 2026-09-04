import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { computeNotificationFindings } from '../../shared/notification/mindvaultNotifications.ts';
import {
  planReconciliation,
  resolveWriteGate,
  rowFromDraft,
  type FindingDraft,
  type ReconcilePlan,
} from '../../shared/notification/engine.ts';

// Phase 8 P8-1. Deterministic notification reconciliation: computes the six
// P8-1 findings as a projection of governed state and diffs them against
// existing Notification episodes (create / remind / resolve / retarget).
//
// P8-2 adds the notifications_enabled master flag (AppConfig row key 'system',
// default false) and the scheduled 'Daily Notifications Reconcile' workflow.
// dryRun DEFAULTS TO TRUE (safe) and stays available for admin diagnostics
// even while the flag is off; write mode additionally requires
// notifications_enabled === true and is refused with a clear reason otherwise.
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

function createsBySeverity(plan: ReconcilePlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of plan.creates) {
    out[c.draft.severity] = (out[c.draft.severity] || 0) + 1;
  }
  return out;
}

function createsByScope(plan: ReconcilePlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of plan.creates) {
    out[c.draft.clientScope] = (out[c.draft.clientScope] || 0) + 1;
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

    // P8-2 feature flag (AppConfig row key 'system'). Missing row/field => false.
    const sysRow = await base44.asServiceRole.entities.AppConfig.filter({ key: 'system' })
      .catch(() => [])
      .then((r: any[]) => r?.[0]);
    const notificationsEnabled = sysRow?.notifications_enabled === true;

    // Deterministic write gate: dry-run is ALWAYS allowed (flag-independent
    // admin diagnostics); write mode is refused — never silently executed —
    // while notifications_enabled is false.
    const gate = resolveWriteGate({ notificationsEnabled, dryRun });
    if (!gate.allowed) {
      return Response.json({
        ok: false,
        dryRun: false,
        reason: gate.reason,
        notifications_enabled: false,
        message:
          'Notification writes are disabled (notifications_enabled is false). Dry-run remains available for diagnostics: call with { "dryRun": true }.',
      }, { status: 403 });
    }

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
        creates_by_severity: createsBySeverity(plan),
        creates_by_scope: createsByScope(plan),
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
      creates_by_severity: createsBySeverity(plan),
      creates_by_scope: createsByScope(plan),
      stats,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});