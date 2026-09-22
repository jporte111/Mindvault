import { createClientFromRequest } from 'npm:@base44/sdk@0.8.49';
import { redact } from '../../shared/redact.ts';
import { exportSourceToDropbox } from '../../shared/dropboxExport.ts';

// Admin function: save one knowledge source's current published version to
// the company Dropbox as a PDF. Used to retry an automatic save that failed
// (publish-time saves are best-effort) and to backfill older sources.
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const trainingId = String(body?.trainingId || '');
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    const result = await exportSourceToDropbox(base44, trainingId);
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 422 });
    return Response.json({ ok: true, dropboxPath: result.dropboxPath });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
}