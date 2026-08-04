import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const name = body?.name || user.full_name || 'Unknown';
    const email = body?.email || user.email || 'Unknown';
    const message = (body?.message || '').toString().trim();
    if (!message) return Response.json({ error: 'Message is required' }, { status: 400 });

    // Route the message to the workspace admins; fall back to the submitter.
    const recipients = [];
    try {
      const users = await base44.asServiceRole.entities.User.list();
      const admins = users.filter((u) => u.role === 'admin').map((u) => u.email);
      if (admins.length > 0) recipients.push(...admins);
    } catch (listErr) {
      console.error('Admin lookup failed:', listErr);
    }
    if (recipients.length === 0) recipients.push(user.email);

    for (const to of recipients) {
      await base44.integrations.Core.SendEmail({
        to,
        subject: 'New contact form submission',
        body: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
      });
    }

    return Response.json({ status: 'sent' });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}