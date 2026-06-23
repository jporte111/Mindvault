import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { trainingId } = await req.json();
    console.log('analyzeTraining received trainingId:', trainingId);
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    // 1. Fetch the training record
    const training = await base44.entities.Training.get(trainingId);
    console.log('Fetched training record — title:', training?.title, '| id:', training?.id);
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

    // PASS 1 — core structured fields
    let pass1;
    try {
      pass1 = await base44.asServiceRole.integrations.Core.InvokeLLM({
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

      console.log('Pass 1 raw LLM response:', JSON.stringify(pass1));

      // InvokeLLM wraps the JSON response in a `response` property — unwrap it
      const pass1Data = pass1.response || pass1;

      // Save Pass 1 results immediately
      await base44.asServiceRole.entities.Training.update(trainingId, {
        summary: pass1Data.summary,
        key_takeaways: pass1Data.key_takeaways,
        sop_steps: pass1Data.sop_steps,
        decision_rules: pass1Data.decision_rules,
        common_mistakes: pass1Data.common_mistakes,
        required_inputs: pass1Data.required_inputs,
        final_output: pass1Data.final_output,
        client_segment: pass1Data.client_segment,
        topic_category: pass1Data.topic_category,
        category: pass1Data.topic_category,
        software_systems: pass1Data.software_systems,
        presenter: pass1Data.presenter || undefined,
        duration_minutes: pass1Data.duration_minutes,
      });
      console.log('Pass 1 saved successfully');

      // Re-fetch to confirm the write actually persisted
      const afterPass1 = await base44.asServiceRole.entities.Training.get(trainingId);
      console.log('After Pass 1 — saved summary:', JSON.stringify(afterPass1?.summary));
      console.log('After Pass 1 — saved key_takeaways:', JSON.stringify(afterPass1?.key_takeaways));
    } catch (pass1Error) {
      console.log('Pass 1 error:', pass1Error.message);
      console.log('Pass 1 raw response:', pass1);
      await base44.asServiceRole.entities.Training.update(trainingId, { status: 'error' });
      return Response.json({ error: 'Pass 1 failed: ' + pass1Error.message }, { status: 500 });
    }

    // PASS 2 — knowledge entry + feature opportunities
    let pass2;
    try {
      pass2 = await base44.asServiceRole.integrations.Core.InvokeLLM({
        model: 'claude_sonnet_4_6',
        prompt: `You are a financial operations analyst processing a training transcript for a financial concierge firm (Hormozi).

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
    - internal_need_score: Integer 1-5 based on how clearly the transcript shows this feature would solve a real workflow problem (5 = clearly solves a painful, recurring problem; 1 = vague or minor need).
    - market_demand_score: Integer 1-5 based on whether this feature aligns with current financial services, wealth management, accounting, bookkeeping, fintech, AI automation, or client experience trends (5 = strongly aligned with multiple trends; 1 = little/no market relevance).
    - business_value_score: Integer 1-5 based on how useful this feature would be for Hormozi's internal team, clients, or both (5 = high value for both; 1 = limited value).
    - implementation_complexity_score: Integer 1-5 where 1 is easy to build and 5 is complex (requires integrations, heavy logic, or significant data infrastructure).
    - priority: One of "High", "Medium", "Low" — assigned using the rules below.
    - priority_reason: A plain-English explanation of WHY the feature was marked High, Medium, or Low, referencing the scores.

PRIORITY ASSIGNMENT RULES (do not assign a priority without a matching reason):
- High priority: Strong internal need (internal_need_score 4-5), strong market demand (market_demand_score 4-5), clear business value (business_value_score 4-5), and reasonable complexity OR very high upside that justifies the effort.
- Medium priority: Useful feature with moderate internal need or market demand, good business value but not urgent, may be more niche or department-specific.
- Low priority: Nice-to-have feature, weak market demand, limited business value, or high complexity compared to expected impact.

Never assign High, Medium, or Low without also providing a clear priority_reason that explains the decision based on the scores.`,
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
                  internal_need_score: { type: 'number' },
                  market_demand_score: { type: 'number' },
                  business_value_score: { type: 'number' },
                  implementation_complexity_score: { type: 'number' },
                  priority: { type: 'string' },
                  priority_reason: { type: 'string' },
                },
              },
            },
          },
        },
      });

      console.log('Pass 2 raw LLM response:', JSON.stringify(pass2));

      // InvokeLLM wraps the JSON response in a `response` property — unwrap it
      const pass2Data = pass2.response || pass2;

      // Save Pass 2 results and mark ready
      await base44.asServiceRole.entities.Training.update(trainingId, {
        ai_knowledge_entry: pass2Data.ai_knowledge_entry,
        app_feature_opportunities: pass2Data.app_feature_opportunities,
        status: 'ready',
      });
      console.log('Pass 2 saved successfully');

      // Re-fetch to confirm the write actually persisted
      const afterPass2 = await base44.asServiceRole.entities.Training.get(trainingId);
      console.log('After Pass 2 — saved ai_knowledge_entry:', JSON.stringify(afterPass2?.ai_knowledge_entry));
      console.log('After Pass 2 — saved status:', afterPass2?.status);
    } catch (pass2Error) {
      console.log('Pass 2 error:', pass2Error.message);
      console.log('Pass 2 raw response:', pass2);
      await base44.asServiceRole.entities.Training.update(trainingId, { status: 'error' });
      return Response.json({ error: 'Pass 2 failed: ' + pass2Error.message }, { status: 500 });
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});