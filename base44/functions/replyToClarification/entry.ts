import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { CLARIFICATION_MESSAGE_MAX } from '../../shared/knowledgeGap.ts';

// Phase 5. The employee (thread owner) adds a message to their own clarification
// thread. Auth me(); requester-only (admins may also reply here). Writes ONLY
// ClarificationMessage + ClarificationRequest (status / counters). The message
// is deliberately typed content: stored regardless of the logging flag, capped,
// never retrieved, never knowledge.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const crId = String(body?.clarificationRequestId || '');
    const message = typeof body?.message === 'string' ? body.message.trim().slice(0, CLARIFICATION_MESSAGE_MAX) : '';
    if (!crId || !message) return Response.json({ error: 'clarificationRequestId and message are required' }, { status: 400 });

    const sysRow = (await base44.asServiceRole.entities.AppConfig
      .filter({ key: 'system' }).catch(() => []))?.[0];
    if (sysRow?.clarifications_enabled !== true) return Response.json({ error: 'disabled' }, { status: 409 });

    const cr = await base44.asServiceRole.entities.ClarificationRequest.get(crId).catch(() => null);
    if (!cr) return Response.json({ error: 'not found' }, { status: 404 });
    if (cr.requester_user_id !== user.id && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (['answered', 'knowledge_updated', 'not_applicable'].includes(cr.status)) {
      // still allow, but keep it open again for the SME
    }

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.ClarificationMessage.create({
      clarification_request_id: crId,
      requester_user_id: cr.requester_user_id,
      sender_type: 'employee',
      sender_user_id: user.id,
      message,
    });
    await base44.asServiceRole.entities.ClarificationRequest.update(crId, {
      status: cr.status === 'awaiting_employee' ? 'open' : cr.status,
      message_count: (Number(cr.message_count) || 0) + 1,
      last_message_at: now,
    }).catch(() => {});

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
