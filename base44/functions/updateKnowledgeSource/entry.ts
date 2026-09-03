import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import {
  buildMindvaultLifecycle,
  classifyEdit,
  MINDVAULT_CONTENT_FIELDS,
  MINDVAULT_INPLACE_METADATA_FIELDS,
} from '../../shared/mindvaultLifecycle.ts';

// Phase 6. The ONLY content-editing entry point for a governed knowledge source.
// It is NOT an in-place editor:
//   * editing an ACTIVE version's content -> forks an unverified draft N+1 and
//     pre-indexes it; the active version is untouched until someone Publishes.
//   * editing an already-inactive DRAFT -> updates that draft in place (it is
//     not served) and re-pre-indexes it.
//   * a metadata-only patch -> in-place governed restamp on the active version
//     (no new version, verification unchanged).
//   * a mixed content+metadata patch is refused.

async function lifecycleEnabled(base44: any): Promise<boolean> {
  const rows = await base44.asServiceRole.entities.AppConfig.filter({ key: 'system' }).catch(() => []);
  return rows?.[0]?.source_lifecycle_enabled === true;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    if (!(await lifecycleEnabled(base44))) {
      return Response.json(
        { error: 'lifecycle_disabled', message: 'Source Lifecycle is turned off. Enable it in Admin → System to edit governed knowledge.' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const trainingId = String(body?.trainingId || '');
    const rawPatch = (body?.patch && typeof body.patch === 'object') ? body.patch as Record<string, unknown> : {};
    const changeReason = typeof body?.changeReason === 'string' ? body.changeReason.slice(0, 2000) : undefined;
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    const kind = classifyEdit(rawPatch);
    if (kind === 'none') return Response.json({ error: 'patch has no editable fields' }, { status: 400 });
    if (kind === 'mixed') {
      return Response.json(
        { error: 'mixed_patch', message: 'Split this into a content edit and a separate metadata change.' },
        { status: 400 },
      );
    }

    const diag = new URL(req.url).searchParams.get('diag') === '1';
    const { engine } = buildMindvaultLifecycle(base44, { redact });
    const actor = { id: user.id, role: user.role };
    const T = base44.asServiceRole.entities.Training;

    const training = await T.get(trainingId).catch(() => null);
    if (!training) return Response.json({ error: 'Training not found' }, { status: 404 });

    // ---- metadata-only: in-place governed restamp on the active version -----
    if (kind === 'metadata') {
      const meta: Record<string, unknown> = {};
      for (const k of MINDVAULT_INPLACE_METADATA_FIELDS) {
        if (k in rawPatch) meta[k] = (rawPatch as Record<string, unknown>)[k];
      }
      const mp: any = { denorm: {} };
      if ('effective_from' in meta) mp.effectiveFrom = meta.effective_from ?? null;
      if ('effective_until' in meta) mp.effectiveUntil = meta.effective_until ?? null;
      if ('knowledge_scope' in meta || 'client_id' in meta) {
        mp.scopeKey = `${meta.knowledge_scope ?? training.knowledge_scope ?? 'unclassified'}:${meta.client_id ?? training.client_id ?? ''}`;
      }
      for (const k of ['source_authority', 'operational_process_id', 'department', 'source_review_interval_days', 'client_name']) {
        if (k in meta) mp.denorm[k] = meta[k];
      }
      const res = await engine.setMetadata(actor, trainingId, mp);
      return res.ok
        ? Response.json({ ok: true, mode: 'metadata', displayState: res.displayState, ...(diag ? { operationId: res.operationId } : {}) })
        : Response.json({ ok: false, error: res.error, reason: res.reason }, { status: res.error === 'stale_state' ? 409 : res.error === 'invalid_effective_window' ? 400 : 422 });
    }

    // ---- content edit -----------------------------------------------------
    const contentPatch: Record<string, unknown> = {};
    for (const k of MINDVAULT_CONTENT_FIELDS) {
      if (k in rawPatch) contentPatch[k] = (rawPatch as Record<string, unknown>)[k];
    }

    if (training.is_active_version === false && training.is_archived !== true && training.verification_status !== 'rejected') {
      // an inactive draft — safe to edit in place, then re-pre-index
      await T.update(trainingId, { ...contentPatch, verification_status: 'unverified', index_status: 'pending' });
      const bi = await engine.buildDraftIndex(actor, trainingId, 'admin_edit');
      return bi.ok
        ? Response.json({ ok: true, mode: 'draft_updated', draftId: trainingId, displayState: bi.displayState })
        : Response.json({ ok: false, error: bi.error, mode: 'draft_updated', draftId: trainingId }, { status: 422 });
    }

    // an active version — fork an unverified draft N+1, then pre-index it
    const cv = await engine.createVersion(
      actor,
      trainingId,
      (draft) => ({ ...draft, ...contentPatch }),
      'admin_edit',
    );
    if (!cv.ok) {
      const status = cv.error === 'open_draft_exists' ? 409 : cv.error === 'forbidden' ? 403 : 422;
      return Response.json({ ok: false, error: cv.error, existingDraftId: cv.draftId }, { status });
    }
    const bi = await engine.buildDraftIndex(actor, cv.draftId!, 'admin_edit');
    return Response.json({
      ok: true,
      mode: 'draft_forked',
      draftId: cv.draftId,
      preIndexed: bi.ok,
      displayState: bi.ok ? bi.displayState : cv.displayState,
      ...(bi.ok ? {} : { preIndexError: bi.error }),
      ...(changeReason ? { changeReason } : {}),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
