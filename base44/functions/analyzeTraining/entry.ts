import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { trainingId } = await req.json();
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    // 1. Fetch the training record
    const training = await base44.entities.Training.get(trainingId);
    if (!training) return Response.json({ error: 'Training not found' }, { status: 404 });
    if (!training.transcript) return Response.json({ error: 'Training has no transcript URL' }, { status: 400 });

    // 2. Fetch transcript content as plain text
    const res = await fetch(training.transcript);
    if (!res.ok) return Response.json({ error: `Failed to fetch transcript: ${res.status}` }, { status: 500 });
    const transcript = await res.text();

    if (!transcript || transcript.trim().length < 20) {
      return Response.json({ error: 'Transcript content is empty or too short' }, { status: 400 });
    }

    // 3. Invoke LLM
    const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
      model: 'claude_sonnet_4_6',
      prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm. Extract structured business logic from the transcript below to power a future AI app.

Transcript:
${transcript.slice(0, 25000)}

Return a JSON object with ALL of the following fields:
- summary: A concise 2-3 sentence summary of what this training covers.
- key_takeaways: Array of 4-7 most important lessons (strings).
- sop_steps: Array of numbered step-by-step operating procedure steps (strings, e.g. "1. Log into QuickBooks and navigate to...").
- decision_rules: Array of if/then rules extracted from the training (strings, e.g. "If a client has multiple entities, then...").
- common_mistakes: Array of errors, risks, misclassifications, or watchouts to avoid (strings).
- required_inputs: Array of documents, data, software access, or client info needed to complete this workflow (strings).
- final_output: A string describing what this workflow produces (e.g. "Reconciled bank statement, journal entries, and monthly close report").
- client_segment: One of: "Small Business", "High-Net-Worth Household", "Both", "Internal Only".
- topic_category: One of: "Bookkeeping", "Payroll", "Tax Prep", "Reconciliation", "Reporting", "Cash Flow", "Entity Management", "Client Communication", "Operations", "Compliance", "Troubleshooting", "Other".
- software_systems: Array of software tools, portals, or systems mentioned (strings, e.g. "QuickBooks Online", "Excel", "ADP").
- app_feature_opportunities: Array of objects, each with:
    - feature_name: Short name for the feature
    - problem_solved: What problem this feature solves
    - user_type: Who uses it (e.g. "Bookkeeper", "Small Business Owner", "HNW Client", "CFO", "Internal Employee")
    - required_inputs: What data the feature needs
    - output: What the feature produces
    - facing: One of "Internal", "Client-Facing", "Both"
    - priority: One of "High", "Medium", "Low"
- ai_knowledge_entry: A clean, well-written knowledge base entry (2-4 paragraphs) that an AI assistant can use to answer questions about this topic accurately.
- presenter: The presenter's name if identifiable, otherwise null.
- duration_minutes: Estimated duration in minutes as a number.`,
      response_json_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          key_takeaways: { type: 'array', items: { type: 'string' } },
          sop_steps: { type: 'array', items: { type: 'string' } },
          decision_rules: { type: 'array', items: { type: 'string' } },
          common_mistakes: { type: 'array', items: { type: 'string' } },
          required_inputs: { type: 'array', items: { type: 'string' } },
          final_output: { type: 'string' },
          client_segment: { type: 'string' },
          topic_category: { type: 'string' },
          software_systems: { type: 'array', items: { type: 'string' } },
          app_feature_opportunities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feature_name: { type: 'string' },
                problem_solved: { type: 'string' },
                user_type: { type: 'string' },
                required_inputs: { type: 'string' },
                output: { type: 'string' },
                facing: { type: 'string' },
                priority: { type: 'string' },
              },
            },
          },
          ai_knowledge_entry: { type: 'string' },
          presenter: { type: 'string' },
          duration_minutes: { type: 'number' },
        },
      },
    });

    // 4. Save results back to the Training entity
    await base44.entities.Training.update(trainingId, {
      summary: aiResult.summary,
      key_takeaways: aiResult.key_takeaways,
      sop_steps: aiResult.sop_steps,
      decision_rules: aiResult.decision_rules,
      common_mistakes: aiResult.common_mistakes,
      required_inputs: aiResult.required_inputs,
      final_output: aiResult.final_output,
      client_segment: aiResult.client_segment,
      topic_category: aiResult.topic_category,
      category: aiResult.topic_category,
      software_systems: aiResult.software_systems,
      app_feature_opportunities: aiResult.app_feature_opportunities,
      ai_knowledge_entry: aiResult.ai_knowledge_entry,
      presenter: aiResult.presenter || undefined,
      duration_minutes: aiResult.duration_minutes,
      status: 'ready',
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});