import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import {
  RESOLUTION_TYPES,
  resolutionRequiresSource,
  sourceSatisfiesResolution,
} from '../../shared/knowledgeGap.ts';

// Phase 5. Admin-only governance of a KnowledgeGap. Writes ONLY KnowledgeGap +
// AuditEvent. It NEVER edits a source and NEVER verifies one — `resolve` with
// source_updated / new_source_added is a GUARD that refuses unless every
// referenced Training already satisfies verified + active + not-archived +
// exact client-scope. Phase 6 owns the first-class governed source-review /
// version workflow.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const gapId = String(body?.gapId || '');
    const action = String(body?.action || '');
    if (!gapId) return Response.json({ error: 'gapId is required' }, { status: 400 });

    const gap = await base44.asServiceRole.entities.KnowledgeGap.get(gapId).catch(() => null);
    if (!gap) return Response.json({ error: 'gap not found' }, { status: 404 });

    const now = new Date().toISOString();
    const gapScope = gap.client_scope || 'general';
    const audit = (a: string, summary: string, before?: unknown, after?: unknown) =>
      base44.asServiceRole.entities.AuditEvent.create({
        entity: 'KnowledgeGap',
        entity_id: gapId,
        action: a,
        actor_type: 'user',
        actor_user_id: user.id,
        summary,
        before: before ? JSON.stringify(before) : undefined,
        after: after ? JSON.stringify(after) : undefined,
      }).catch(() => {});

    let patch: Record<string, unknown> = {};

    switch (action) {
      case 'assign': {
        const sme = String(body?.assignedSme || '');
        if (!sme) return Response.json({ error: 'assignedSme required' }, { status: 400 });
        patch = { assigned_sme: sme, assigned_at: now };
        await audit('gap_assigned', `assigned_sme set`, { assigned_sme: gap.assigned_sme }, { assigned_sme: sme });
        break;
      }
      case 'start_review': {
        if (!['open', 'candidate'].includes(gap.status)) {
          return Response.json({ error: `cannot start_review from status ${gap.status}` }, { status: 409 });
        }
        patch = {
          status: 'under_review',
          ...(body?.assignedSme ? { assigned_sme: String(body.assignedSme), assigned_at: now } : {}),
        };
        await audit('gap_review_started', `${gap.status} -> under_review`);
        break;
      }
      case 'set_priority': {
        const p = String(body?.priority || '');
        if (!['low', 'medium', 'high'].includes(p)) return Response.json({ error: 'invalid priority' }, { status: 400 });
        patch = { priority: p };
        await audit('gap_priority_set', `priority ${gap.priority} -> ${p}`);
        break;
      }
      case 'reopen': {
        if (!['resolved', 'not_applicable'].includes(gap.status)) {
          return Response.json({ error: `cannot reopen from status ${gap.status}` }, { status: 409 });
        }
        patch = { status: 'open', resolution_type: null, resolved_at: null, resolved_by: null, merged_into_gap_id: null };
        await audit('gap_reopened', `${gap.status} -> open`);
        break;
      }
      case 'resolve': {
        const rt = String(body?.resolutionType || '');
        if (!(RESOLUTION_TYPES as readonly string[]).includes(rt)) {
          return Response.json({ error: 'invalid resolutionType' }, { status: 400 });
        }
        const notes = typeof body?.resolutionNotes === 'string' ? body.resolutionNotes.slice(0, 2000) : undefined;

        if (resolutionRequiresSource(rt)) {
          const ids: string[] = Array.isArray(body?.resolvedSourceIds)
            ? body.resolvedSourceIds.filter((x: unknown) => typeof x === 'string') : [];
          if (!ids.length) {
            return Response.json({ error: `resolvedSourceIds required for ${rt}` }, { status: 400 });
          }
          for (const id of ids) {
            const t = await base44.asServiceRole.entities.Training.get(id).catch(() => null);
            if (!t) return Response.json({ error: `Training ${id} not found` }, { status: 400 });
            const chk = sourceSatisfiesResolution(t, gapScope);
            if (!chk.ok) {
              return Response.json({
                error: `Training ${id} does not satisfy the resolve guard (${chk.reason}). ` +
                  `Phase 5 does not verify sources — a human must mark it verified + active + not archived + in the exact scope first.`,
              }, { status: 409 });
            }
          }
          patch = {
            status: 'resolved',
            resolution_type: rt,
            resolved_source_ids: ids,
            resolution_notes: notes,
            resolved_at: now,
            resolved_by: user.id,
          };
        } else {
          patch = {
            status: rt === 'not_applicable' ? 'not_applicable' : 'resolved',
            resolution_type: rt,
            resolution_notes: notes,
            merged_into_gap_id: rt === 'duplicate' ? String(body?.mergedIntoGapId || '') || undefined : undefined,
            resolved_at: now,
            resolved_by: user.id,
          };
        }
        await audit('gap_resolved', `resolution_type=${rt}`, { status: gap.status }, { status: patch.status, resolution_type: rt });
        break;
      }
      default:
        return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    }

    await base44.asServiceRole.entities.KnowledgeGap.update(gapId, patch);
    const updated = await base44.asServiceRole.entities.KnowledgeGap.get(gapId).catch(() => null);
    return Response.json({ ok: true, gap: updated });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
