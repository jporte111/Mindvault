import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { accessToken } = await base44.asServiceRole.connectors.getConnection('googledrive');
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id,name)&orderBy=name`,
      { headers: authHeader }
    );

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: 'Failed to list folders', details: err }, { status: 500 });
    }

    const { files } = await res.json();
    return Response.json({ folders: files || [] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});