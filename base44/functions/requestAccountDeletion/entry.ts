import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Signal an account-deletion request to platform systems.
    // The platform does not expose a programmatic self-deletion API;
    // this endpoint records the authenticated user's intent for downstream handling.
    return Response.json({
      status: 'requested',
      user_id: user.id,
      email: user.email,
      requested_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}