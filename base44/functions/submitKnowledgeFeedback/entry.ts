import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { redact } from '../../shared/redact.ts';
import { reporterHmac } from '../../shared/reporterId.ts';
import {
  FEEDBACK_RATE_PER_HOUR,
  FEEDBACK_TYPES,
  FREE_TEXT_MAX,
  CLARIFICATION_MESSAGE_MAX,
  feedbackAccruesGap,
  normalizeTopic,
} from '../../shared/knowledgeGap.ts';
import { aggregateGap } from '../../shared/gapAggregation.ts';

// Phase 5. One employee's reaction to one answer. Auth me() only. Rate-limited.
// Writes ONLY KnowledgeFeedback / KnowledgeGap / ClarificationRequest /
// ClarificationMessage / AuditEvent (+ one AnswerLog.feedback_id back-link).
// NEVER touches Training / KnowledgeChunk / OperationalProcess.

function normScope(v: unknown): string {
  const s = typeof v === 'string' ? v : 'general';
  return s === 'general' || s.startsWith('client:') ? s : 'general';
}
function strArr(v: unknown, cap: number): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, cap) : [];
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const feedbackType = String(body?.feedbackType || '');
    if (!(FEEDBACK_TYPES as readonly string[]).includes(feedbackType)) {
      return Response.json({ error: 'invalid feedbackType' }, { status: 400 });
    }

    const sysRow = (await base44.asServiceRole.entities.AppConfig
      .filter({ key: 'system' }).catch(() => []))?.[0];
    const gapsEnabled = sysRow?.knowledge_gaps_enabled === true;
    const clarificationsEnabled = sysRow?.clarifications_enabled === true;
    const loggingEnabled = sysRow?.answer_logging_enabled === true;
    if (!gapsEnabled) return Response.json({ recorded: false, reason: 'disabled' });

    // No fallback secret: fail the write safely if the deployment is misconfigured.
    const gapSecret = Deno.env.get('GAP_HMAC_SECRET');
    if (!gapSecret || !gapSecret.trim()) {
      console.error(JSON.stringify({ fn: 'submitKnowledgeFeedback', stage: 'config', error: 'GAP_HMAC_SECRET is not set' }));
      return Response.json(
        { error: 'feedback_not_configured', detail: 'This deployment is missing GAP_HMAC_SECRET. An admin must set it before feedback can be recorded.' },
        { status: 503 },
      );
    }
    const rhmac = await reporterHmac(user.id, gapSecret);

    // Rate limit per stable reporter hmac.
    const sinceIso = new Date(Date.now() - 3_600_000).toISOString();
    const recent = await base44.asServiceRole.entities.KnowledgeFeedback
      .filter({ reporter_hmac: rhmac, created_date: { $gte: sinceIso } }, '-created_date', FEEDBACK_RATE_PER_HOUR + 1)
      .catch(() => []);
    if (recent.length >= FEEDBACK_RATE_PER_HOUR) {
      return Response.json({ error: 'rate_limited', retry_after_seconds: 3600 }, { status: 429 });
    }

    const clientScope = normScope(body?.clientScope);
    const standaloneQuery = typeof body?.standaloneQuery === 'string' ? body.standaloneQuery.slice(0, 1000) : '';
    const rawQuestion = typeof body?.question === 'string' ? body.question.slice(0, 1000) : '';
    const normalizedTopic = normalizeTopic(standaloneQuery || rawQuestion);
    // DELIBERATELY submitted -> stored regardless of loggingEnabled, capped.
    const freeText = typeof body?.freeText === 'string' ? body.freeText.trim().slice(0, FREE_TEXT_MAX) : '';
    const relatedSourceIds = strArr(body?.relatedSourceIds, 40);
    const reportedMissingFacets = strArr(body?.reportedMissingFacets, 20);
    const operationalProcessId = typeof body?.operationalProcessId === 'string' ? body.operationalProcessId : undefined;
    const answerLogId = typeof body?.answerLogId === 'string' ? body.answerLogId : undefined;
    // PASSIVELY captured -> only stored when answer_logging_enabled.
    const passiveQuery = loggingEnabled && standaloneQuery ? standaloneQuery : undefined;

    const feedback = await base44.asServiceRole.entities.KnowledgeFeedback.create({
      feedback_type: feedbackType,
      answer_log_id: answerLogId,
      normalized_topic: normalizedTopic,
      standalone_query: passiveQuery,
      client_scope: clientScope,
      operational_process_id: operationalProcessId,
      related_source_ids: relatedSourceIds,
      answer_mode: typeof body?.answerMode === 'string' ? body.answerMode : undefined,
      confidence_level: typeof body?.confidenceLevel === 'string' ? body.confidenceLevel : undefined,
      reported_missing_facets: reportedMissingFacets,
      free_text: freeText || undefined,
      reporter_hmac: rhmac,
      status: 'new',
    });

    if (answerLogId) {
      await base44.asServiceRole.entities.AnswerLog.update(answerLogId, { feedback_id: feedback.id }).catch(() => {});
    }

    let knowledgeGapId: string | null = null;
    let clarificationRequestId: string | null = null;

    if (feedbackType === 'still_need_help' && clarificationsEnabled) {
      const cr = await base44.asServiceRole.entities.ClarificationRequest.create({
        feedback_id: feedback.id,
        answer_log_id: answerLogId,
        normalized_topic: normalizedTopic,
        standalone_query: passiveQuery,
        client_scope: clientScope,
        operational_process_id: operationalProcessId,
        retrieved_source_ids: relatedSourceIds,
        confidence_level: typeof body?.confidenceLevel === 'string' ? body.confidenceLevel : undefined,
        requester_user_id: user.id,
        status: 'open',
        message_count: 0,
      });
      clarificationRequestId = cr.id;
      if (freeText) {
        await base44.asServiceRole.entities.ClarificationMessage.create({
          clarification_request_id: cr.id,
          requester_user_id: user.id,
          sender_type: 'employee',
          sender_user_id: user.id,
          message: freeText.slice(0, CLARIFICATION_MESSAGE_MAX),
        });
        await base44.asServiceRole.entities.ClarificationRequest.update(cr.id, {
          message_count: 1,
          last_message_at: new Date().toISOString(),
        }).catch(() => {});
      }
      await base44.asServiceRole.entities.KnowledgeFeedback.update(feedback.id, {
        clarification_request_id: cr.id,
        status: 'linked',
      }).catch(() => {});
    }

    if (feedbackAccruesGap(feedbackType)) {
      try {
        const res = await aggregateGap(base44, {
          normalizedTopic,
          question: rawQuestion || undefined,
          clientScope,
          operationalProcessId,
          relatedSourceIds,
          missingFacets: reportedMissingFacets,
          origin: 'explicit_feedback',
          reporterHmac: rhmac,
          exampleQuestion: passiveQuery ?? null,
        });
        knowledgeGapId = res.knowledge_gap_id;
        await base44.asServiceRole.entities.KnowledgeFeedback.update(feedback.id, {
          knowledge_gap_id: knowledgeGapId,
          status: 'linked',
        }).catch(() => {});
      } catch (gapErr) {
        console.error(JSON.stringify({
          fn: 'submitKnowledgeFeedback', stage: 'aggregate_gap',
          error: redact((gapErr as Error)?.message ?? String(gapErr)).slice(0, 200),
        }));
      }
    }

    return Response.json({
      recorded: true,
      feedback_id: feedback.id,
      knowledge_gap_id: knowledgeGapId,
      clarification_request_id: clarificationRequestId,
    });
  } catch (error) {
    return Response.json({ error: redact((error as Error).message) }, { status: 500 });
  }
});
