import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { canMarkRead } from '../../shared/notification/engine.ts';

// Phase 8 P8-1. Guarded recipient action: mark ONE notification as read.
//
// Authorization is enforced HERE (recipient-or-admin), because Notification
// entity RLS is deliberately admin-only for update — recipients must not be
// able to mutate any other field of a notification through the entity SDK.
// Writes ONLY read_at. Idempotent: marking an already-read notification is a
// successful no-op.

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

    const guard = canMarkRead(user, notification);
    if (!guard.ok) return Response.json({ error: 'Forbidden — not the recipient' }, { status: 403 });

    if (notification.read_at) {
      return Response.json({ ok: true, read_at: notification.read_at, unchanged: true });
    }

    const read_at = new Date().toISOString();
    await base44.asServiceRole.entities.Notification.update(id, { read_at });
    return Response.json({ ok: true, read_at });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});