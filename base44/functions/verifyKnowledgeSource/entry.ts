import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { buildMindvaultLifecycle } from '../../shared/mindvaultLifecycle.ts';

// One-click verification of a published knowledge source. Composes the SAME
// governed engine primitives a human would run by hand in the Knowledge
// Lifecycle panel, in order: fork an identical draft of the active version,
// pre-index it, verify it, publish it. Content is never edited — the draft is
// a clone of exactly what the admin saw on screen, so "verified" means a human
// confirmed that content. Every step is audited by the lifecycle engine.

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
        { error: 'lifecycle_disabled', message: 'Source Lifecycle is turned off. Enable it in Admin → System to verify sources.' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const trainingId = String(body?.trainingId || '');
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    const T = base44.asServiceRole.entities.Training;
    const training = await T.get(trainingId).catch(() => null);
    if (!training) return Response.json({ error: 'Training not found' }, { status: 404 });

    if (training.is_archived === true) {
      return Response.json({ error: 'source_archived', message: 'This source is archived and cannot be verified.' }, { status: 409 });
    }
    if (training.verification_status === 'rejected') {
      return Response.json({ error: 'source_rejected', message: 'This source was rejected. Restore it from the Knowledge page first.' }, { status: 409 });
    }
    if (training.is_active_version === false) {
      return Response.json({ error: 'not_an_active_version', message: 'Open the published version to verify it.' }, { status: 409 });
    }
    if (training.verification_status === 'verified') {
      return Response.json({ ok: true, noOp: true, displayState: 'published' });
    }

    const { engine } = buildMindvaultLifecycle(base44, { redact });
    const actor = { id: user.id, role: user.role };

    // 1. Fork a byte-identical draft (the engine refuses if an open draft exists).
    const cv = await engine.createVersion(actor, trainingId, (draft) => draft, 'other');
    if (!cv.ok) {
      const status = cv.error === 'open_draft_exists' ? 409 : cv.error === 'forbidden' ? 403 : 422;
      const message = cv.error === 'open_draft_exists'
        ? 'This source has an unpublished draft with different content. Review and publish that draft from the Knowledge page first.'
        : cv.reason || cv.error;
      return Response.json({ ok: false, error: cv.error, draftId: cv.draftId, message }, { status });
    }

    // 2. Pre-index the draft (heavy generation; the served version is untouched).
    const bi = await engine.buildDraftIndex(actor, cv.draftId!, 'other');
    if (!bi.ok) {
      return Response.json(
        {
          ok: false,
          error: bi.error || 'pre_index_failed',
          draftId: cv.draftId,
          message: 'Preparing the source for verification failed — it will show as "Needs attention" on the Knowledge page, where you can retry.',
        },
        { status: 422 },
      );
    }

    // 3. Verify + publish the draft.
    const v = await engine.verify(actor, cv.draftId!);
    if (!v.ok) {
      return Response.json({ ok: false, error: v.error, draftId: cv.draftId, message: v.reason || 'Verification failed.' }, { status: 422 });
    }

    const a = await engine.activate(actor, cv.draftId!, {});
    if (!a.ok) {
      return Response.json(
        {
          ok: false,
          error: a.error,
          draftId: cv.draftId,
          message: 'Verified, but publishing failed — finish it from the Knowledge page (Publish on the draft).',
        },
        { status: 422 },
      );
    }

    return Response.json({
      ok: true,
      displayState: a.displayState,
      draftId: cv.draftId,
      ...(a.verifiedSourceIds ? { verifiedSourceIds: a.verifiedSourceIds } : {}),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});