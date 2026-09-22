import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { buildMindvaultLifecycle, MINDVAULT_CONTENT_FIELDS } from '../../shared/mindvaultLifecycle.ts';
import { waitUntil } from 'base44:runtime';
import { exportSourceToDropbox } from '../../shared/dropboxExport.ts';

// One-click verification of a published knowledge source. Runs the SAME
// governed engine steps a human would run in the Knowledge Lifecycle panel:
// fork an identical draft, pre-index it, verify it, publish it. Content is
// never edited — "verified" always means a human confirmed what is on screen.
//
// RESUMABLE: index preparation can take a minute, and a request cut off
// mid-run leaves an identical draft behind. A later click picks up where the
// interrupted attempt stopped instead of failing with a conflict — but only
// ever adopts a draft whose content is IDENTICAL to the published version.

const OPEN_DRAFT_STATES = ['draft', 'in_review', 'changes_requested', 'verified'];

const RETRY_HINTS: Record<string, string> = {
  operation_in_flight:
    'A previous attempt on this source is still wrapping up. Wait a couple of minutes and click "Verify this source" again.',
  stale_state: 'The source was updated while verifying. Click "Verify this source" again.',
  pre_index_required: 'The source is still being prepared. Click "Verify this source" again to finish.',
  open_draft_exists:
    'This source has an unpublished draft with different content. Review it on the Knowledge page first.',
};

function stepFail(step: string, r: any): Response {
  const error = r?.error || 'failed';
  return Response.json(
    {
      ok: false,
      step,
      error,
      draftId: r?.draftId ?? null,
      message: RETRY_HINTS[error] || r?.reason || error,
    },
    { status: 422 },
  );
}

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

    // Pick up an identical draft left by an interrupted attempt, or fork one.
    const lineageId = training.root_source_id || training.id;
    const siblings = await T.filter({ root_source_id: lineageId }).catch(() => []);
    const activeVersionNumber = typeof training.version_number === 'number' ? training.version_number : 1;
    const draft = (siblings || [])
      .filter(
        (s: any) =>
          s.is_active_version === false &&
          (typeof s.version_number === 'number' ? s.version_number : 1) > activeVersionNumber &&
          OPEN_DRAFT_STATES.includes(s.lifecycle_state),
      )
      .sort((a: any, b: any) => (b.version_number ?? 0) - (a.version_number ?? 0))[0] || null;

    let draftId: string;
    if (draft) {
      // Forks normalize empty lists to [] where the original had none — treat
      // those as identical. Anything else differing means a human edited the
      // draft, and we must not verify content that differs from the screen.
      const norm = (v: unknown) =>
        Array.isArray(v) ? (v.length ? JSON.stringify(v) : 'null') : JSON.stringify(v ?? null);
      const contentDiffers = (MINDVAULT_CONTENT_FIELDS as readonly string[]).some(
        (f) => norm(draft[f]) !== norm(training[f]),
      );
      if (contentDiffers) {
        return Response.json(
          { ok: false, error: 'draft_has_changes', message: RETRY_HINTS.open_draft_exists },
          { status: 409 },
        );
      }
      draftId = draft.id;
    } else {
      const cv = await engine.createVersion(actor, trainingId, (d) => d, 'other');
      if (!cv.ok) return stepFail('create_version', cv);
      draftId = cv.draftId!;
    }

    // Prepare the draft's index — skipped when an earlier attempt finished it.
    let draftRow = draft || (await T.get(draftId).catch(() => null));
    if (!draftRow) {
      return Response.json({ ok: false, error: 'draft_not_found' }, { status: 422 });
    }
    const needsBuild =
      draftRow.index_status !== 'indexed' ||
      (draftRow.indexed_version_number ?? null) !== (draftRow.version_number ?? null);
    if (needsBuild) {
      const bi = await engine.buildDraftIndex(actor, draftId, 'other');
      if (!bi.ok) return stepFail('prepare', bi);
    }

    // Verify + publish.
    if ((draftRow.verification_status || 'unverified') !== 'verified') {
      const v = await engine.verify(actor, draftId);
      if (!v.ok) return stepFail('verify', v);
    }

    const a = await engine.activate(actor, draftId, {});
    if (!a.ok) return stepFail('publish', a);

    // Save the published PDF to the company Dropbox. Best-effort and
    // post-response: a Dropbox failure never fails the publication.
    waitUntil(
      exportSourceToDropbox(base44, draftId).catch((e: unknown) =>
        console.error('verifyKnowledgeSource: dropbox export failed:', redact(String(e))),
      ),
    );

    return Response.json({
      ok: true,
      displayState: a.displayState,
      ...(a.verifiedSourceIds ? { verifiedSourceIds: a.verifiedSourceIds } : {}),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});