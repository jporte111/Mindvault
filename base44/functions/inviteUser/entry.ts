import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json();
    const email = (body?.email || '').trim().toLowerCase();
    const role = body?.role === 'admin' ? 'admin' : 'user';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: 'A valid email is required' }, { status: 400 });
    }

    await base44.auth.inviteUser(email, role);
    return Response.json({ success: true, email, role });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});