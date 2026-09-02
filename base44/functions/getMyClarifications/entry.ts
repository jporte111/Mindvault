import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';

// Phase 5. Returns the CALLER's own ClarificationRequest threads + their
// messages (admin -> all). This is the only path by which an employee reads a
// clarification; the entities themselves are admin-only at the RLS layer.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const isAdmin = user.role === 'admin';
    const wantAll = isAdmin && body?.all === true;

    const requests = await base44.asServiceRole.entities.ClarificationRequest
      .filter(wantAll ? {} : { requester_user_id: user.id }, '-last_message_at', wantAll ? 300 : 100)
      .catch(() => []);

    const ids = new Set(requests.map((r: any) => r.id));
    const byRequest: Record<string, any[]> = {};
    if (ids.size) {
      // Fetch this caller's messages (scoped by the denormalized requester id
      // unless admin), then bucket by request.
      const msgs = await base44.asServiceRole.entities.ClarificationMessage
        .filter(wantAll ? {} : { requester_user_id: user.id }, 'created_date', 2000)
        .catch(() => []);
      for (const m of msgs) {
        if (!ids.has(m.clarification_request_id)) continue;
        (byRequest[m.clarification_request_id] ||= []).push({
          id: m.id,
          sender_type: m.sender_type,
          message: m.message,
          created_date: m.created_date,
        });
      }
    }

    return Response.json({
      clarifications: requests.map((r: any) => ({
        id: r.id,
        status: r.status,
        normalized_topic: r.normalized_topic,
        client_scope: r.client_scope,
        created_date: r.created_date,
        last_message_at: r.last_message_at,
        message_count: r.message_count,
        messages: byRequest[r.id] || [],
      })),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
