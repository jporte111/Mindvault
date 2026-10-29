import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { MEMBER_VISIBLE_SETTINGS, memberView } from '../../shared/appSettings.ts';

// Read-only: the AppConfig rows ('chat', 'system') the UI needs. AppConfig
// direct reads are admin-only. Signed-in callers only (anonymous -> 401).
// Platform admins get the full rows (the admin toggles update them by id);
// everyone else gets only MEMBER_VISIBLE_SETTINGS. The flags are global, so
// no membership is required — users awaiting an invitation see the shell.
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const isPlatformAdmin = user.role === 'admin';

    const settings: Record<string, unknown> = {};
    for (const key of Object.keys(MEMBER_VISIBLE_SETTINGS)) {
      const rows = (await base44.asServiceRole.entities.AppConfig.filter({ key }).catch(() => [])) || [];
      const row = rows[0] || null;
      settings[key] = isPlatformAdmin ? row : memberView(key, row);
    }
    return Response.json({ settings, full: isPlatformAdmin });
  } catch (error) {
    return Response.json({ error: (error as Error)?.message || 'Internal error' }, { status: 500 });
  }
}
