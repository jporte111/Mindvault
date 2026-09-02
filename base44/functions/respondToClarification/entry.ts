import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { CLARIFICATION_MESSAGE_MAX } from '../../shared/knowledgeGap.ts';

// Phase 5. Admin/SME replies into a clarification thread and/or transitions its
// status. Writes ONLY ClarificationMessage + ClarificationRequest + AuditEvent.
// The SME's reply is a human message in a thread — it is NEVER knowledge and is
// NEVER retrieved. If it should become knowledge, the SME edits a source and a
// human verifies it (existing flow; Phase 6 governs it).

const STATUSES = ['open', 'awaiting_employee', 'answered', 'knowledge_updated', 'not_applicable'];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const crId = String(body?.clarificationRequestId || '');
    if (!crId) return Response.json({ error: 'clarificationRequestId is required' }, { status: 400 });

    const cr = await base44.asServiceRole.entities.ClarificationRequest.get(crId).catch(() => null);
    if (!cr) return Response.json({ error: 'not found' }, { status: 404 });

    const message = typeof body?.message === 'string' ? body.message.trim().slice(0, CLARIFICATION_MESSAGE_MAX) : '';
    const nextStatus = STATUSES.includes(body?.status) ? String(body.status) : undefined;
    const now = new Date().toISOString();

    const patch: Record<string, unknown> = {};
    if (message) {
      await base44.asServiceRole.entities.ClarificationMessage.create({
        clarification_request_id: crId,
        requester_user_id: cr.requester_user_id,
        sender_type: 'sme',
        sender_user_id: user.id,
        message,
      });
      patch.message_count = (Number(cr.message_count) || 0) + 1;
      patch.last_message_at = now;
    }
    if (nextStatus) {
      patch.status = nextStatus;
      if (['answered', 'knowledge_updated', 'not_applicable'].includes(nextStatus)) {
        patch.resolved_at = now;
        patch.resolved_by = user.id;
      }
    }
    if (typeof body?.assignedSme === 'string' && body.assignedSme) patch.assigned_sme = body.assignedSme;

    if (Object.keys(patch).length) {
      await base44.asServiceRole.entities.ClarificationRequest.update(crId, patch);
    }
    await base44.asServiceRole.entities.AuditEvent.create({
      entity: 'ClarificationRequest',
      entity_id: crId,
      action: message ? 'clarification_answered' : 'clarification_updated',
      actor_type: 'user',
      actor_user_id: user.id,
      summary: `${message ? 'SME replied. ' : ''}${nextStatus ? `status -> ${nextStatus}` : ''}`.trim(),
    }).catch(() => {});

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
