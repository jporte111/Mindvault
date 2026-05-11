import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { folderId } = body;

    const { accessToken } = await base44.asServiceRole.connectors.getConnection('googledrive');
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // List files in the specified folder (or root if none)
    let filesUrl = `https://www.googleapis.com/drive/v3/files?fields=files(id,name,mimeType,webViewLink,createdTime)&q=`;
    
    if (folderId) {
      filesUrl += encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    } else {
      filesUrl += encodeURIComponent(`mimeType='text/plain' and name contains 'transcript' and trashed=false`);
    }

    const filesRes = await fetch(filesUrl, { headers: authHeader });
    if (!filesRes.ok) {
      const err = await filesRes.text();
      return Response.json({ error: 'Failed to list Drive files', details: err }, { status: 500 });
    }

    const { files } = await filesRes.json();

    // Get existing trainings to avoid duplicates
    const existingTrainings = await base44.asServiceRole.entities.Training.list();
    const existingDriveIds = new Set(existingTrainings.map(t => t.drive_file_id).filter(Boolean));

    const newFiles = (files || []).filter(f => !existingDriveIds.has(f.id));
    const results = [];

    for (const file of newFiles) {
      // Download file content
      const contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: authHeader }
      );

      if (!contentRes.ok) continue;

      const transcript = await contentRes.text();
      const title = file.name.replace(/\.(txt|vtt|srt|docx?)$/i, '').replace(/transcript/i, '').trim() || file.name;

      // Create the training record first as "processing"
      const training = await base44.asServiceRole.entities.Training.create({
        title,
        transcript,
        drive_file_id: file.id,
        status: 'processing',
        video_url: file.webViewLink || ''
      });

      results.push({ id: training.id, title, status: 'created' });

      // Generate AI summary and key takeaways
      try {
        const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: `You are an expert at summarizing business training sessions. 
          
Analyze this training transcript and provide:
1. A concise, professional summary (2-3 paragraphs)
2. 5-8 key takeaways as bullet points
3. Suggest a category for this training (e.g., "Sales", "Operations", "Product", "HR", "Leadership", "Customer Service", "Technical", "Onboarding")
4. Identify the presenter name if mentioned in the transcript

Transcript:
${transcript.substring(0, 8000)}

Return JSON with: summary (string), key_takeaways (array of strings), category (string), presenter (string)`,
          response_json_schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              key_takeaways: { type: 'array', items: { type: 'string' } },
              category: { type: 'string' },
              presenter: { type: 'string' }
            }
          }
        });

        await base44.asServiceRole.entities.Training.update(training.id, {
          summary: aiResult.summary || '',
          key_takeaways: aiResult.key_takeaways || [],
          category: aiResult.category || 'General',
          presenter: aiResult.presenter || '',
          status: 'ready'
        });

        results[results.length - 1].status = 'processed';
      } catch (aiErr) {
        await base44.asServiceRole.entities.Training.update(training.id, { status: 'ready' });
      }
    }

    return Response.json({
      synced: results.length,
      skipped: (files || []).length - newFiles.length,
      results
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});