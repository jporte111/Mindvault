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

    console.log('Transcript first 200 chars:', transcript?.slice(0, 200));

    if (!transcript || transcript.trim().length < 20 || transcript.trim().startsWith('<')) {
      await base44.asServiceRole.entities.Training.update(trainingId, { status: 'error' });
      return Response.json({ error: 'Transcript fetch returned empty or invalid content' }, { status: 400 });
    }

    const transcriptText = transcript.slice(0, 25000);

    try {
      // PASS 1 — core structured fields
      const pass1 = await base44.asServiceRole.integrations.Core.InvokeLLM({
        model: 'claude_sonnet_4_6',
        prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm. Extract structured business logic from the transcript below.

Transcript:
${transcriptText}

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
            presenter: { type: 'string' },
            duration_minutes: { type: 'number' },
          },
        },
      });

      // Save Pass 1 results immediately
      await base44.asServiceRole.entities.Training.update(trainingId, {
        summary: pass1.summary,
        key_takeaways: pass1.key_takeaways,
        sop_steps: pass1.sop_steps,
        decision_rules: pass1.decision_rules,
        common_mistakes: pass1.common_mistakes,
        required_inputs: pass1.required_inputs,
        final_output: pass1.final_output,
        client_segment: pass1.client_segment,
        topic_category: pass1.topic_category,
        category: pass1.topic_category,
        software_systems: pass1.software_systems,
        presenter: pass1.presenter || undefined,
        duration_minutes: pass1.duration_minutes,
      });

      // PASS 2 — knowledge entry + feature opportunities
      const pass2 = await base44.asServiceRole.integrations.Core.InvokeLLM({
        model: 'claude_sonnet_4_6',
        prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm.

Transcript:
${transcriptText}

Return a JSON object with the following fields:
- ai_knowledge_entry: A clean, well-written knowledge base entry (2-4 paragraphs) that an AI assistant can use to answer questions about this topic accurately.
- app_feature_opportunities: Array of objects, each with:
    - feature_name: Short name for the feature
    - problem_solved: What problem this feature solves
    - user_type: Who uses it (e.g. "Bookkeeper", "Small Business Owner", "HNW Client", "CFO", "Internal Employee")
    - required_inputs: What data the feature needs
    - output: What the feature produces
    - facing: One of "Internal", "Client-Facing", "Both"
    - priority: One of "High", "Medium", "Low"`,
        response_json_schema: {
          type: 'object',
          properties: {
            ai_knowledge_entry: { type: 'string' },
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
          },
        },
      });

      // Save Pass 2 results and mark ready
      await base44.asServiceRole.entities.Training.update(trainingId, {
        ai_knowledge_entry: pass2.ai_knowledge_entry,
        app_feature_opportunities: pass2.app_feature_opportunities,
        status: 'ready',
      });

      return Response.json({ success: true });
    } catch (analysisError) {
      // Mark as error so the record does not get stuck at "processing"
      await base44.asServiceRole.entities.Training.update(trainingId, { status: 'error' });
      return Response.json({ error: analysisError.message }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});