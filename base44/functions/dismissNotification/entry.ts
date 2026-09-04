import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { canDismiss } from '../../shared/notification/engine.ts';

// Phase 8 P8-1. Guarded recipient action: dismiss ONE notification.
//
// Authorization is enforced HERE (recipient-or-admin), because Notification
// entity RLS is deliberately admin-only for update. Writes ONLY
// status = 'dismissed' — NEVER resolved_at (that is set solely by
// reconciliation when the underlying condition clears). Only still-open
// episodes may be dismissed; an already-dismissed one is a successful no-op
// (idempotent); a resolved episode can no longer be dismissed.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = String(body?.id || '');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const notification = await base44.asServiceRole.entities.Notification.get(id).catch(() => null);
    if (!notification) return Response.json({ error: 'Notification not found' }, { status: 404 });

    const guard = canDismiss(user, notification);
    if (!guard.ok) {
      if (guard.reason === 'already_resolved') {
        return Response.json(
          { error: 'This notification is already resolved — the condition has cleared.' },
          { status: 409 },
        );
      }
      return Response.json({ error: 'Forbidden — not the recipient' }, { status: 403 });
    }
    if (guard.noop) {
      return Response.json({ ok: true, status: 'dismissed', unchanged: true });
    }

    await base44.asServiceRole.entities.Notification.update(id, { status: 'dismissed' });
    return Response.json({ ok: true, status: 'dismissed' });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});