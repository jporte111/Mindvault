import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  assessIngestionQuality,
  buildPass1Prompt,
  buildPass2Prompt,
  NEW_PASS1_KEYS,
  pass1JsonSchema,
  pass2JsonSchema,
  resolveSourceText,
} from '../../shared/extraction.ts';
import { classifyReanalysisTarget } from '../../shared/reanalysisGuard.ts';
import { buildMindvaultLifecycle } from '../../shared/mindvaultLifecycle.ts';
import { redact } from '../../shared/redact.ts';

// Normalize an optional string field: keep only a non-empty trimmed string.
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Normalize an optional array-of-strings field.
function optArr(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? (v as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
}

// Normalize an optional positive-number field.
function optPosNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { trainingId } = await req.json();
    console.log('analyzeTraining received trainingId:', trainingId);
    if (!trainingId) return Response.json({ error: 'trainingId is required' }, { status: 400 });

    // 1. Fetch the knowledge source record
    const training = await base44.entities.Training.get(trainingId);
    console.log('Fetched record — title:', training?.title, '| id:', training?.id, '| source_type:', training?.source_type);
    if (!training) return Response.json({ error: 'Training not found' }, { status: 404 });

    // ---- Phase 6 PERMANENT SAFETY INVARIANT ---------------------------------
    // AI extraction must NEVER overwrite a SERVED governed source in place —
    // regardless of source_lifecycle_enabled. The decision is made from the
    // source's lifecycle / served STATE (classifyReanalysisTarget, which never
    // reads the flag). The flag is consulted ONLY to phrase the refusal.
    let hasServedChunks = false;
    try {
      const c = await base44.asServiceRole.entities.KnowledgeChunk.filter(
        { training_id: trainingId }, null, 1,
      );
      hasServedChunks = Array.isArray(c) && c.length > 0;
    } catch (_) {
      hasServedChunks = true; // unknown -> fail safe: treat as served
    }
    const decision = classifyReanalysisTarget(training, hasServedChunks);

    if (decision.kind === 'served') {
      let lifecycleOn = false;
      try {
        const sysRows = await base44.asServiceRole.entities.AppConfig.filter({ key: 'system' });
        lifecycleOn = sysRows?.[0]?.source_lifecycle_enabled === true;
      } catch (_) {
        lifecycleOn = false;
      }
      return Response.json({
        error: lifecycleOn ? 'governed_source' : 'lifecycle_disabled',
        message: lifecycleOn
          ? 'This is a published knowledge source. Create a draft revision ("Edit" in Admin → Knowledge Lifecycle), then re-analyze the draft.'
          : 'Re-analyzing a published knowledge source would overwrite content employees rely on. Turn on Source Lifecycle (Admin → System) to create and analyze a draft revision instead.',
      }, { status: 409 });
    }
    // decision.kind is 'draft' (inactive draft — in place is safe, re-pre-indexed
    // after Pass 2) or 'legacy' (never-served onboarding — unchanged path).
    const isInactiveDraft = decision.kind === 'draft';

    // 2. Resolve source text. transcript is EITHER a supported http(s) URL to a
    //    text file OR the raw source text itself (pasted text, legacy records).
    //    Both paths are preserved. The invalid-content guard is applied after
    //    resolution, matching the original behavior.
    const resolution = await resolveSourceText(training.transcript);
    if (!resolution.ok) {
      // Only unusable *content* marks the record errored (as the original guard
      // did). A missing field or a fetch failure returns without a status write,
      // also matching the original.
      if (resolution.reason === 'invalid_content') {
        await base44.asServiceRole.entities.Training.update(trainingId, { status: 'error' });
      }
      return Response.json({ error: resolution.error }, { status: resolution.status });
    }
    console.log('Source text first 200 chars:', resolution.text.slice(0, 200));

    const sourceText = resolution.text.slice(0, 25000);
    const sourceType = training.source_type ?? null;

    // PASS 1 — core structured fields (+ additive operational fields)
    let pass1;
    try {
      pass1 = await base44.asServiceRole.integrations.Core.InvokeLLM({
        model: 'claude_sonnet_4_6',
        prompt: buildPass1Prompt({ sourceText, sourceType }),
        response_json_schema: pass1JsonSchema,
      });

      console.log('Pass 1 raw LLM response:', JSON.stringify(pass1));

      // InvokeLLM wraps the JSON response in a `response` property — unwrap it
      const pass1Data = pass1.response || pass1;

      // Thin-but-valid extraction -> flag for review; does NOT block ingestion.
      const ingestion_quality = assessIngestionQuality(pass1Data);
      console.log('Ingestion quality:', ingestion_quality);

      // Additive operational fields — written only when present.
      const operational: Record<string, unknown> = {};
      for (const k of NEW_PASS1_KEYS) {
        const v = (k === 'process_name' || k === 'department')
          ? optStr(pass1Data[k])
          : optArr(pass1Data[k]);
        if (v !== undefined) operational[k] = v;
      }

      // Legacy fields written exactly as before; presenter/duration_minutes
      // normalized once each; ingestion_quality + operational fields additive.
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
        presenter: optStr(pass1Data.presenter),
        duration_minutes: optPosNum(pass1Data.duration_minutes),
        ingestion_quality,
        ...operational,
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

    // PASS 2 — knowledge entry + feature opportunities (Strategy Engine contract unchanged)
    let pass2;
    try {
      pass2 = await base44.asServiceRole.integrations.Core.InvokeLLM({
        model: 'claude_sonnet_4_6',
        prompt: buildPass2Prompt({ sourceText, sourceType }),
        response_json_schema: pass2JsonSchema,
      });

      console.log('Pass 2 raw LLM response:', JSON.stringify(pass2));

      // InvokeLLM wraps the JSON response in a `response` property — unwrap it
      const pass2Data = pass2.response || pass2;

      // Save Pass 2 results and mark ready (unchanged behavior).
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

    // Phase 6: a re-analyzed INACTIVE DRAFT must be re-pre-indexed (verified) so
    // its staged chunks reflect the new extraction. The engine's pre-index is
    // unconditional — it does not read source_lifecycle_enabled.
    if (isInactiveDraft) {
      try {
        const { engine } = buildMindvaultLifecycle(base44, { redact });
        const pre = await engine.buildDraftIndex(
          { id: user.id, role: user.role },
          trainingId,
          'reanalysis',
        );
        console.log('draft re-pre-index:', JSON.stringify(pre));
      } catch (reErr) {
        console.log('draft re-pre-index (best-effort) failed:', (reErr as Error)?.message);
      }
    }

    return Response.json({ success: true, reanalysis_target: decision.kind });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
