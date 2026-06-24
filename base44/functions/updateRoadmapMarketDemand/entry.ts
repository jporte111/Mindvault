import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ---- Priority calculation helpers (pure, safe at module level) ----

function calcPriority(internalNeed, marketDemand, businessValue, complexity) {
  const strong = (s) => s >= 4;
  const weak = (s) => s <= 2;

  // Low: weak demand, limited business value, or too much complexity for the expected payoff
  if (weak(marketDemand) || weak(businessValue) || (complexity >= 5 && businessValue <= 3)) {
    return 'Low';
  }

  // High: strong internal need, strong market demand, strong business value, acceptable complexity
  if (strong(internalNeed) && strong(marketDemand) && strong(businessValue) && complexity <= 4) {
    return 'High';
  }

  return 'Medium';
}

function buildPriorityReason(internalNeed, marketDemand, businessValue, complexity, priority, marketSummary) {
  const parts = [];
  parts.push(`Internal need ${internalNeed}/5, market demand ${marketDemand}/5, business value ${businessValue}/5, complexity ${complexity}/5.`);
  if (marketSummary) parts.push(`Market: ${marketSummary}`);
  if (priority === 'High') {
    parts.push('Marked High: strong internal need, strong market demand, strong business value, and acceptable complexity.');
  } else if (priority === 'Medium') {
    parts.push('Marked Medium: moderate demand or moderate business value.');
  } else {
    parts.push('Marked Low: weak demand, limited business value, or complexity outweighs the expected payoff.');
  }
  return parts.join(' ');
}

function clampScore(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.round(n)));
}

// InvokeLLM with add_context_from_internet cannot use response_json_schema (Gemini Search
// tool doesn't support controlled generation), so we ask for JSON in the prompt and parse it.
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const skip = Math.max(0, Number(body.skip) || 0);
    const limit = Math.min(5, Math.max(1, Number(body.limit) || 2));

    // 1. Review all App Roadmap items — fetch trainings, keep only those with features
    const trainings = await base44.asServiceRole.entities.Training.list('-created_date', 200);
    const withFeatures = trainings.filter(
      (t) => Array.isArray(t.app_feature_opportunities) && t.app_feature_opportunities.length > 0
    );

    const batch = withFeatures.slice(skip, skip + limit);
    const hasMore = skip + limit < withFeatures.length;

    const now = new Date().toISOString();
    let featuresUpdated = 0;
    const errors = [];

    for (const training of batch) {
      const features = training.app_feature_opportunities;

      // 2. Build a single market-research prompt covering all features for this training
      //    (features from one transcript are topically related, so one web-search call is efficient)
      const featureLines = features.map((f, i) => {
        const keywords = [f.feature_name, f.problem_solved, f.user_type, f.facing]
          .filter(Boolean)
          .map((s) => String(s).replace(/\s+/g, ' ').trim())
          .join(' | ');
        return `${i + 1}. Name: ${f.feature_name || 'N/A'}\n   Problem: ${f.problem_solved || 'N/A'}\n   Users: ${f.user_type || 'N/A'}\n   Facing: ${f.facing || 'N/A'}\n   Keywords: ${keywords}`;
      }).join('\n\n');

      let analysis;
      try {
        // 3. Check external market signals via web-enabled LLM
        //    (no response_json_schema — Gemini Search tool doesn't support controlled generation)
        const llmRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
          model: 'gemini_3_flash',
          add_context_from_internet: true,
          prompt: `You are a market analyst evaluating demand for software features in the financial services, wealth management, accounting, bookkeeping, and fintech space. Use current market trends, news, and industry signals.

Evaluate the market demand for EACH of the following feature ideas. For each one, determine whether demand for that feature category is increasing, stable, or low, and assign a market_demand_score from 1 to 5 (5 = strongly increasing demand backed by multiple supporting trends; 3 = stable/moderate; 1 = weak or declining).

Features:
${featureLines}

Respond with ONLY a valid JSON object (no markdown, no code fences) with a "results" array, one entry per feature IN THE SAME ORDER as listed above. Each entry must include:
- feature_index: the 1-based index matching the list above
- market_demand_score: integer 1-5
- market_demand_summary: 1-2 sentence summary of whether demand is increasing, stable, or low, citing specific trends or signals
- market_signal_sources: array of 2-4 short strings naming the trends, news themes, or industry signals that informed the score`,
        });

        const rawText = typeof llmRes === 'string' ? llmRes : (llmRes?.response || JSON.stringify(llmRes));
        analysis = extractJson(rawText);
      } catch (err) {
        errors.push({ training: training.title, error: 'Market analysis failed: ' + err.message });
        continue;
      }

      const results = Array.isArray(analysis?.results) ? analysis.results : [];
      const resultsByIndex = {};
      for (const r of results) {
        if (r && Number.isFinite(r.feature_index)) resultsByIndex[r.feature_index] = r;
      }

      // 4 & 5. Update each roadmap item with market signals + recalculated priority
      const updatedFeatures = features.map((f, i) => {
        const r = resultsByIndex[i + 1] || results[i] || {};

        const marketDemandScore = clampScore(r.market_demand_score, 3);
        const marketDemandSummary = r.market_demand_summary || '';
        const marketSignalSources = Array.isArray(r.market_signal_sources) ? r.market_signal_sources : [];

        const internalNeed = clampScore(f.internal_need_score, 3);
        const businessValue = clampScore(f.business_value_score, 3);
        const complexity = clampScore(f.implementation_complexity_score, 3);

        // 6. Recalculate priority using all four scores
        const newPriority = calcPriority(internalNeed, marketDemandScore, businessValue, complexity);
        const newPriorityReason = buildPriorityReason(
          internalNeed, marketDemandScore, businessValue, complexity, newPriority, marketDemandSummary
        );

        return {
          ...f,
          market_demand_score: marketDemandScore,
          market_demand_summary: marketDemandSummary,
          market_signal_sources: marketSignalSources,
          last_market_check_date: now,
          priority: newPriority,
          priority_reason: newPriorityReason,
        };
      });

      try {
        await base44.asServiceRole.entities.Training.update(training.id, {
          app_feature_opportunities: updatedFeatures,
        });
        featuresUpdated += updatedFeatures.length;
      } catch (err) {
        errors.push({ training: training.title, error: 'Save failed: ' + err.message });
      }
    }

    return Response.json({
      success: true,
      batch_size: batch.length,
      features_updated: featuresUpdated,
      has_more: hasMore,
      next_skip: skip + limit,
      total_with_features: withFeatures.length,
      errors,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});