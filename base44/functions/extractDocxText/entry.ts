import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import mammoth from 'npm:mammoth@1.8.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { file_url } = await req.json();
    if (!file_url) return Response.json({ error: 'file_url is required' }, { status: 400 });

    // Download the file
    const fileRes = await fetch(file_url);
    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // Extract text using mammoth
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value;

    return Response.json({ text });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});