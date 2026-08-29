import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { question } = await req.json();
    if (!question) {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }

    // Fetch all ready trainings
    const trainings = await base44.asServiceRole.entities.Training.filter({ status: 'ready' });

    if (trainings.length === 0) {
      return Response.json({
        answer: "The knowledge base doesn't have any training content yet. Please ask an admin to sync training recordings from Google Drive.",
        sources: []
      });
    }

    // Build context from summaries + key takeaways
    // transcript field may now be a URL — fetch a snippet if so
    const contextParts = await Promise.all(trainings.map(async (t, i) => {
      let transcriptExcerpt = '';
      if (t.transcript) {
        if (t.transcript.startsWith('http')) {
          try {
            const res = await fetch(t.transcript);
            const text = await res.text();
            transcriptExcerpt = `Transcript excerpt: ${text.substring(0, 1500)}`;
          } catch (_) { /* skip */ }
        } else {
          transcriptExcerpt = `Transcript excerpt: ${t.transcript.substring(0, 1500)}`;
        }
      }
      const sop = (t.sop_steps || []).length ? (t.sop_steps || []).map((s, j) => `${j + 1}. ${s}`).join('\n') : 'None recorded';
      const rules = (t.decision_rules || []).length ? (t.decision_rules || []).join('\n- ') : 'None recorded';
      const mistakes = (t.common_mistakes || []).length ? (t.common_mistakes || []).join('\n- ') : 'None recorded';
      const inputs = (t.required_inputs || []).length ? (t.required_inputs || []).join('; ') : 'None recorded';
      return `[Training ${i + 1}]: ${t.title}
      Category: ${t.category || 'General'}
      Presenter: ${t.presenter || 'Unknown'}
      Summary: ${t.summary || 'No summary available'}
      Key Takeaways: ${(t.key_takeaways || []).join('; ')}
      SOP Steps:
      ${sop}
      Decision Rules:
      - ${rules}
      Common Mistakes:
      - ${mistakes}
      Required Inputs: ${inputs}
      Final Output: ${t.final_output || 'Not specified'}
      ${transcriptExcerpt}
      ---`;
    }));
    const context = contextParts.join('\n');

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `You are a knowledgeable assistant for an internal company training knowledge base. 
      
A team member has a question. Use the training content below to provide a clear, helpful, and accurate answer.
Always cite which training(s) your answer comes from using the format [Training Title].
If the answer isn't covered in the trainings, say so clearly and suggest what type of training might help.

Question: ${question}

Available Training Content:
${context}

Provide:
1. A clear, direct answer citing specific trainings
2. Any relevant details or steps
3. Which training(s) to watch for more depth`,
      model: 'claude_sonnet_4_6'
    });

    // Find which trainings are most relevant (simple keyword matching on the question)
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    const sources = trainings
      .filter(t => {
        const text = `${t.title} ${t.category} ${t.summary} ${(t.key_takeaways || []).join(' ')}`.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      })
      .slice(0, 3)
      .map(t => ({
        id: t.id,
        title: t.title,
        category: t.category,
        video_url: t.video_url,
        presenter: t.presenter
      }));

    return Response.json({ answer: result, sources });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});