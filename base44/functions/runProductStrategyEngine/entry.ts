import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ---- Helpers ----

function clampScore(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function extractJson(text) {
  if (!text) return null;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function buildDigest(training, index) {
  const parts = [`--- Training ${index + 1}: ${training.title} (ID: ${training.id}) ---`];
  parts.push(`Segment: ${training.client_segment || 'Unknown'} | Topic: ${training.topic_category || 'Unknown'}`);
  if (training.summary) parts.push(`Summary: ${truncate(training.summary, 300)}`);
  if (training.key_takeaways?.length) parts.push(`Key Takeaways: ${truncate(training.key_takeaways.join('; '), 300)}`);
  if (training.common_mistakes?.length) parts.push(`Pain Points: ${truncate(training.common_mistakes.join('; '), 300)}`);
  if (training.decision_rules?.length) parts.push(`Decision Rules: ${truncate(training.decision_rules.join('; '), 300)}`);
  if (training.sop_steps?.length) parts.push(`SOP Steps: ${truncate(training.sop_steps.join('; '), 200)}`);
  if (training.app_feature_opportunities?.length) {
    const feats = training.app_feature_opportunities
      .map(f => f.feature_name)
      .join('; ');
    parts.push(`Feature Ideas: ${truncate(feats, 200)}`);
  }
  return parts.join('\n');
}

const BUSINESS_CONTEXT = `You are a product strategy analyst for a boutique finance and financial concierge firm. We provide highly tailored finance support for small businesses and some high-net-worth individual clients. We handle both backend finance work (bookkeeping, categorization, reconciliation, reporting, monthly close support) and strategic finance work (CFO services, budgeting, forecasting, financial decision support, client communication, and advisory).

We are NOT trying to copy broad platforms like Ramp. Ramp focuses heavily on spend management, corporate cards, expenses, bill pay, procurement, and accounting automation. Our advantage is that we deeply understand client-specific financial workflows, messy edge cases, recurring judgment calls, and boutique advisory needs.`;

async function getReadyTrainings(base44) {
  const trainings = await base44.asServiceRole.entities.Training.list('-created_date', 200);
  // Only the CURRENT version of each distinct source. Retired historical
  // versions (is_active_version === false) and archived sources are excluded
  // so pattern frequency and confidence reflect the true source count.
  const live = trainings.filter(t =>
    (t.status === 'ready' || t.summary) &&
    t.is_active_version !== false &&
    !t.is_archived
  );
  // Safety net: keep only one record per logical source (list is newest-first),
  // so a data anomaly can never analyze the same SOP twice.
  const byRoot = new Map();
  for (const t of live) {
    const key = t.root_source_id || t.id;
    if (!byRoot.has(key)) byRoot.set(key, t);
  }
  return [...byRoot.values()];
}

async function callLLM(base44, prompt) {
  const res = await base44.asServiceRole.integrations.Core.InvokeLLM({
    model: 'gemini_3_flash',
    prompt,
  });
  const raw = typeof res === 'string' ? res : (res?.response || res?.output || JSON.stringify(res));
  return extractJson(raw);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const phase = body.phase || 'patterns';
    const now = new Date().toISOString();

    const ready = await getReadyTrainings(base44);
    if (ready.length === 0) {
      return Response.json({ error: 'No analyzed trainings found. Upload and analyze trainings first.' }, { status: 400 });
    }

    const analyzedCount = ready.length;
    const maxTrainings = body.max_trainings ? Math.min(50, Number(body.max_trainings)) : 50;
    const trainingsToAnalyze = ready.slice(0, maxTrainings);
    const trainingIds = trainingsToAnalyze.map(t => t.id);
    const mapIndicesToIds = (indices) =>
      (Array.isArray(indices) ? indices.map(i => trainingIds[i - 1]).filter(Boolean) : []);

    // ===================== PHASE 1: PATTERNS =====================
    if (phase === 'patterns') {
      const digests = trainingsToAnalyze.map((t, i) => buildDigest(t, i));
      const digestText = digests.join('\n\n');

      const data = await callLLM(base44, `${BUSINESS_CONTEXT}

Analyze ALL the training digests below and identify patterns that appear across MULTIPLE trainings. Only include items that appear in 2 or more trainings. Limit to the 5 most important items per category.

Return a JSON object (no markdown, no code fences) with three arrays:

1. "recurring_pain_points": Problems, frustrations, errors, or difficulties that appear repeatedly. Each entry: { name, description, client_segment (Small Business, High-Net-Worth Household, Both, or Internal Only), related_training_indices (1-based indices from the list below), frequency_count, severity_score (1-5), supporting_evidence_summary }.

2. "workflow_patterns": Repeated manual workflows that could be automated or systematized. Each entry: { name, description, workflow_type (e.g. Bookkeeping, Reconciliation, Reporting, Client Communication, CFO Advisory), client_segment, related_training_indices, frequency_count, automation_potential_score (1-5), complexity_score (1-5), supporting_evidence_summary }.

3. "decision_rule_patterns": Judgment-based rules — categorization rules, client-specific treatment, financial strategy decisions, exception handling, reporting interpretation. Each entry: { rule_name, rule_description, example_if_then_rule, client_segment, related_training_indices, frequency_count, judgment_dependency_score (1-5), supporting_evidence_summary }.

Training digests:
${digestText}`);

      const painPointRecords = (data?.recurring_pain_points || []).map(p => ({
        name: p.name,
        description: p.description,
        client_segment: p.client_segment,
        related_training_ids: mapIndicesToIds(p.related_training_indices),
        frequency_count: p.frequency_count || 2,
        severity_score: clampScore(p.severity_score, 3),
        first_seen_date: now,
        last_seen_date: now,
        supporting_evidence_summary: p.supporting_evidence_summary,
      }));
      const workflowRecords = (data?.workflow_patterns || []).map(w => ({
        name: w.name,
        description: w.description,
        workflow_type: w.workflow_type,
        client_segment: w.client_segment,
        related_training_ids: mapIndicesToIds(w.related_training_indices),
        frequency_count: w.frequency_count || 2,
        automation_potential_score: clampScore(w.automation_potential_score, 3),
        complexity_score: clampScore(w.complexity_score, 3),
        supporting_evidence_summary: w.supporting_evidence_summary,
      }));
      const decisionRuleRecords = (data?.decision_rule_patterns || []).map(d => ({
        rule_name: d.rule_name,
        rule_description: d.rule_description,
        example_if_then_rule: d.example_if_then_rule,
        client_segment: d.client_segment,
        related_training_ids: mapIndicesToIds(d.related_training_indices),
        frequency_count: d.frequency_count || 2,
        judgment_dependency_score: clampScore(d.judgment_dependency_score, 3),
        supporting_evidence_summary: d.supporting_evidence_summary,
      }));

      await base44.asServiceRole.entities.RecurringPainPoint.deleteMany({});
      await base44.asServiceRole.entities.WorkflowPattern.deleteMany({});
      await base44.asServiceRole.entities.DecisionRulePattern.deleteMany({});
      if (painPointRecords.length) await base44.asServiceRole.entities.RecurringPainPoint.bulkCreate(painPointRecords);
      if (workflowRecords.length) await base44.asServiceRole.entities.WorkflowPattern.bulkCreate(workflowRecords);
      if (decisionRuleRecords.length) await base44.asServiceRole.entities.DecisionRulePattern.bulkCreate(decisionRuleRecords);

      return Response.json({
        success: true,
        phase: 'patterns',
        transcripts_analyzed: analyzedCount,
        pain_points_found: painPointRecords.length,
        workflow_patterns_found: workflowRecords.length,
        decision_rules_found: decisionRuleRecords.length,
      });
    }

    // ===================== PHASE 2: CLUSTERS =====================
    if (phase === 'clusters') {
      const allFeatures = trainingsToAnalyze.flatMap((t, ti) =>
        (t.app_feature_opportunities || []).map(f => ({
          training_index: ti + 1,
          training_title: t.title,
          feature_name: f.feature_name,
          problem_solved: f.problem_solved,
          facing: f.facing,
          user_type: f.user_type,
        }))
      );
      const featureText = allFeatures.map((f, i) =>
        `${i + 1}. [Training ${f.training_index}: ${f.training_title}] ${f.feature_name} — ${f.problem_solved} (Facing: ${f.facing || 'N/A'}, Users: ${f.user_type || 'N/A'})`
      ).join('\n');

      const painPoints = await base44.asServiceRole.entities.RecurringPainPoint.list('-frequency_count', 50);
      const workflows = await base44.asServiceRole.entities.WorkflowPattern.list('-frequency_count', 50);
      const decisionRules = await base44.asServiceRole.entities.DecisionRulePattern.list('-frequency_count', 50);
      const painPointNames = painPoints.map(p => p.name);
      const workflowNames = workflows.map(w => `${w.name} (${w.workflow_type || 'N/A'})`);
      const decisionRuleNames = decisionRules.map(d => d.rule_name);

      const data = await callLLM(base44, `${BUSINESS_CONTEXT}

Group ALL the feature ideas below into larger PRODUCT OPPORTUNITY CLUSTERS. Do not treat every feature separately — group related features into themes. Aim for 5-12 clusters.

Example clusters: Client financial command center, AI bookkeeping quality control, Monthly close and reporting automation, CFO insight and recommendation engine, HNW household finance dashboard, Client-specific categorization and decision-rule memory, Boutique finance workflow automation, Risk and anomaly detection, Client-ready financial storytelling.

Return a JSON object (no markdown, no code fences) with a "product_opportunity_clusters" array. Each entry:
{ cluster_name, description, related_feature_ideas (array of feature names), related_pain_points (array of pain point names from below), related_workflow_patterns (array of workflow names from below), related_decision_rules (array of decision rule names from below), client_segment (Small Business, High-Net-Worth Household, Both, or Internal Only), facing ("Internal", "Client-Facing", or "Both"), internal_need_score (1-5), AI_estimated_market_demand_score (1-5), business_fit_score (1-5), defensibility_score (1-5), implementation_complexity_score (1-5), overall_opportunity_score (1-5), priority ("High", "Medium", or "Low"), priority_reason, related_training_indices (1-based), frequency_count, supporting_evidence_summary }

Defensibility factors: internal process knowledge, client-specific patterns, judgment involved, number of supporting trainings, whether it gets more valuable with more trainings, proprietary workflow/data advantage.

Feature ideas from all trainings:
${featureText || 'No feature ideas found yet.'}

Recurring pain points identified:
${painPointNames.length ? painPointNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'None identified yet'}

Workflow patterns identified:
${workflowNames.length ? workflowNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'None identified yet'}

Decision rule patterns identified:
${decisionRuleNames.length ? decisionRuleNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'None identified yet'}`);

      const clusterRecords = (data?.product_opportunity_clusters || []).map(c => ({
        cluster_name: c.cluster_name,
        description: c.description,
        related_feature_ideas: c.related_feature_ideas || [],
        related_pain_points: c.related_pain_points || [],
        related_workflow_patterns: c.related_workflow_patterns || [],
        related_decision_rules: c.related_decision_rules || [],
        client_segment: c.client_segment,
        facing: c.facing,
        internal_need_score: clampScore(c.internal_need_score, 3),
        AI_estimated_market_demand_score: clampScore(c.AI_estimated_market_demand_score, 3),
        business_fit_score: clampScore(c.business_fit_score, 3),
        defensibility_score: clampScore(c.defensibility_score, 3),
        implementation_complexity_score: clampScore(c.implementation_complexity_score, 3),
        overall_opportunity_score: clampScore(c.overall_opportunity_score, 3),
        priority: c.priority || 'Medium',
        priority_reason: c.priority_reason,
        related_training_ids: mapIndicesToIds(c.related_training_indices),
        frequency_count: c.frequency_count || 1,
        supporting_evidence_summary: c.supporting_evidence_summary,
        last_updated_date: now,
      }));

      await base44.asServiceRole.entities.ProductOpportunityCluster.deleteMany({});
      if (clusterRecords.length) await base44.asServiceRole.entities.ProductOpportunityCluster.bulkCreate(clusterRecords);

      return Response.json({
        success: true,
        phase: 'clusters',
        clusters_found: clusterRecords.length,
      });
    }

    // ===================== PHASE 3: RECOMMENDATION =====================
    if (phase === 'recommendation') {
      const clusters = await base44.asServiceRole.entities.ProductOpportunityCluster.list('-overall_opportunity_score', 50);
      const painPoints = await base44.asServiceRole.entities.RecurringPainPoint.list('-frequency_count', 50);
      const workflows = await base44.asServiceRole.entities.WorkflowPattern.list('-frequency_count', 50);
      const decisionRules = await base44.asServiceRole.entities.DecisionRulePattern.list('-frequency_count', 50);

      const confidenceLevel = analyzedCount < 15 ? 'Low' : analyzedCount < 30 ? 'Medium' : 'High';
      const confidenceReason = analyzedCount < 15
        ? `Low confidence: only ${analyzedCount} relevant transcripts analyzed. The system is still learning — these are early hypotheses only.`
        : analyzedCount < 30
        ? `Medium confidence: ${analyzedCount} relevant transcripts analyzed. Patterns are emerging but more data is needed for high confidence.`
        : `High confidence: ${analyzedCount} transcripts analyzed with repeated patterns identified.`;

      const clusterSummary = clusters.map((c, i) =>
        `${i + 1}. ${c.cluster_name} (Priority: ${c.priority}, Overall: ${c.overall_opportunity_score}/5, Defensibility: ${c.defensibility_score}/5, Business Fit: ${c.business_fit_score}/5) — ${c.description}`
      ).join('\n');
      const painPointNames = painPoints.map(p => p.name);
      const workflowNames = workflows.map(w => w.name);
      const decisionRuleNames = decisionRules.map(d => d.rule_name);

      const data = await callLLM(base44, `${BUSINESS_CONTEXT}

Based on the product opportunity clusters and patterns below, recommend a SINGLE app, website, or SaaS product concept that could be built specifically around our boutique finance service model.

Current data: ${analyzedCount} transcripts analyzed. Confidence level: ${confidenceLevel}.

${analyzedCount < 30 ? 'IMPORTANT: The system is still learning. With fewer than 30 transcripts, produce EARLY HYPOTHESES ONLY. Do not overstate confidence. Frame the recommendation as a preliminary direction that will improve as more trainings are uploaded.' : ''}

Return a JSON object (no markdown, no code fences) with a "product_recommendation" field containing:
{ product_name_idea, positioning_statement (one sentence), target_users, main_problem_solved, core_modules (array of module names), unique_business_advantage, why_hard_to_copy, competitive_positioning (how it competes against broad platforms like Ramp without copying them), first_version_mvp, future_version_roadmap, risks_or_weaknesses, data_needed_to_improve_confidence, additional_training_topics_needed (what training topics to upload), related_product_clusters (array of cluster names), related_training_indices (1-based indices of key trainings) }

Product opportunity clusters:
${clusterSummary || 'No clusters identified yet.'}

Recurring pain points:
${painPointNames.length ? painPointNames.join('\n') : 'None identified yet'}

Workflow patterns:
${workflowNames.length ? workflowNames.join('\n') : 'None identified yet'}

Decision rule patterns:
${decisionRuleNames.length ? decisionRuleNames.join('\n') : 'None identified yet'}`);

      const recData = data?.product_recommendation;
      let recommendationRecord = null;
      let additionalTopicsNeeded = '';
      if (recData) {
        recommendationRecord = {
          product_name_idea: recData.product_name_idea,
          positioning_statement: recData.positioning_statement,
          target_users: recData.target_users,
          main_problem_solved: recData.main_problem_solved,
          core_modules: recData.core_modules || [],
          unique_business_advantage: recData.unique_business_advantage,
          why_hard_to_copy: recData.why_hard_to_copy,
          competitive_positioning: recData.competitive_positioning,
          first_version_mvp: recData.first_version_mvp,
          future_version_roadmap: recData.future_version_roadmap,
          risks_or_weaknesses: recData.risks_or_weaknesses,
          data_needed_to_improve_confidence: recData.data_needed_to_improve_confidence,
          additional_training_topics_needed: recData.additional_training_topics_needed,
          confidence_level: confidenceLevel,
          confidence_reason: confidenceReason,
          related_product_clusters: recData.related_product_clusters || [],
          related_training_ids: mapIndicesToIds(recData.related_training_indices),
          last_updated_date: now,
        };
        additionalTopicsNeeded = recData.additional_training_topics_needed || '';
      }

      await base44.asServiceRole.entities.ProductRecommendation.deleteMany({});
      if (recommendationRecord) await base44.asServiceRole.entities.ProductRecommendation.create(recommendationRecord);

      return Response.json({
        success: true,
        phase: 'recommendation',
        recommendation_generated: !!recommendationRecord,
        confidence_level: confidenceLevel,
        additional_training_topics_needed: additionalTopicsNeeded,
      });
    }

    // ===================== TEST PHASE =====================
    if (phase === 'test') {
      const data = await callLLM(base44, 'List 3 fruits. Return a JSON object: {"fruits": ["apple", "banana", "cherry"]}');
      return Response.json({ success: true, phase: 'test', data });
    }
    if (phase === 'test2') {
      const data = await callLLM(base44, 'Analyze these 2 training summaries and identify 2 recurring pain points. Return JSON: {"recurring_pain_points": [{"name": "x", "description": "y"}]}\n\nTraining 1: Bookkeeping for small business, common mistakes include miscategorization and missing receipts.\nTraining 2: Payroll processing, common mistakes include wrong tax rates and missing employee classifications.');
      return Response.json({ success: true, phase: 'test2', data });
    }

    return Response.json({ error: 'Unknown phase: ' + phase }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});