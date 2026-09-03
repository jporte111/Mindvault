import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { buildMindvaultLifecycle } from '../../shared/mindvaultLifecycle.ts';

// Phase 6. The single authoritative path for lifecycle-critical mutations of a
// knowledge source version. A thin HTTP shell over the reusable lifecycle
// engine (base44/shared/lifecycle) wired by the MindVault binding.
//
// Actions (on an EXISTING version id):
//   submit | request_changes | verify | reject | un_reject | confirm_current
//   set_effective_dates | set_authority | relink_process | reclassify_scope
//   activate | archive | restore
//
// Content edits DO NOT come here — they go through updateKnowledgeSource, which
// forks an unverified draft. This function never edits active content in place.
//
// Normal responses carry a plain-language displayState. Implementation detail
// (operation ids, lifecycle_seq, index_stale, stages) is only echoed when the
// caller passes ?diag=1.

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
        { error: 'lifecycle_disabled', message: 'Source Lifecycle is turned off. Enable it in Admin → System to make governed changes.' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const versionId = String(body?.versionId || body?.trainingId || '');
    const action = String(body?.action || '');
    if (!versionId) return Response.json({ error: 'versionId is required' }, { status: 400 });
    if (!action) return Response.json({ error: 'action is required' }, { status: 400 });

    const diag = new URL(req.url).searchParams.get('diag') === '1';
    const { engine } = buildMindvaultLifecycle(base44, { redact });
    const actor = { id: user.id, role: user.role };

    let result: any;
    switch (action) {
      case 'submit':
        result = await engine.submit(actor, versionId); break;
      case 'request_changes':
        result = await engine.requestChanges(actor, versionId, String(body?.note || '')); break;
      case 'verify':
        result = await engine.verify(actor, versionId); break;
      case 'reject':
        result = await engine.reject(actor, versionId, String(body?.note || '')); break;
      case 'un_reject':
        result = await engine.unReject(actor, versionId); break;
      case 'confirm_current':
        result = await engine.confirmCurrent(actor, versionId); break;
      case 'set_effective_dates':
        result = await engine.setMetadata(actor, versionId, {
          effectiveFrom: body?.effectiveFrom ?? null,
          effectiveUntil: body?.effectiveUntil ?? null,
        });
        break;
      case 'set_authority':
        result = await engine.setMetadata(actor, versionId, {
          denorm: { source_authority: body?.sourceAuthority ?? null },
        });
        break;
      case 'relink_process':
        result = await engine.setMetadata(actor, versionId, {
          denorm: { operational_process_id: body?.operationalProcessId ?? null },
        });
        break;
      case 'reclassify_scope':
        result = await engine.setMetadata(actor, versionId, {
          scopeKey: `${body?.knowledgeScope || 'unclassified'}:${body?.clientId || ''}`,
          denorm: { client_name: body?.clientName ?? null },
        });
        break;
      case 'activate':
        result = await engine.activate(actor, versionId, {
          force: body?.force === true,
          effectiveFromNow: body?.effectiveFromNow === true,
          linkedGapId: body?.linkedGapId ? String(body.linkedGapId) : undefined,
        });
        break;
      case 'archive':
        result = await engine.archive(actor, versionId); break;
      case 'restore':
        result = await engine.restore(actor, versionId); break;
      default:
        return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    }

    if (!result.ok) {
      const status = result.error === 'stale_state' ? 409
        : result.error === 'forbidden' ? 403
        : ['not_verified', 'pre_index_required', 'open_draft_exists', 'operation_in_flight', 'already_active'].includes(result.error) ? 409
        : result.error === 'invalid_effective_window' ? 400
        : 422;
      return Response.json(
        { ok: false, error: result.error, reason: result.reason, ...(diag ? { operationId: result.operationId } : {}) },
        { status },
      );
    }

    return Response.json({
      ok: true,
      displayState: result.displayState,
      ...(result.verifiedSourceIds ? { verifiedSourceIds: result.verifiedSourceIds } : {}),
      ...(diag ? { operationId: result.operationId, noOp: result.noOp } : {}),
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
