import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { embed, isEmbeddingsConfigured } from '../../shared/embeddings.ts';
import { redact } from '../../shared/redact.ts';
import { type Intent, parseCitations, pickConfidence, planRetrieval, rankChunks } from '../../shared/retrieval.ts';

// RAG chatbot backend. Runs strictly in parallel to askKnowledgeBase (which is
// untouched and remains the production default). Selected per request by the
// Chat page based on the AppConfig `chat_engine` flag / rollout percentage.
//
// Hard rules enforced here:
//  - scope comes ONLY from the clientId argument, never from question text
//  - unclassified knowledge is never retrieved
//  - client-specific knowledge needs an exact client_id match
//  - weak results -> confidence gate, never a fallback that widens scope

const INTENTS: Intent[] = [
  'procedure',
  'decision_rule',
  'troubleshooting',
  'definition',
  'overview',
  'other',
];

interface Turn {
  role: string;
  content: string;
}

function sanitizeConversation(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content).slice(0, 4000),
    }))
    .slice(-6);
}

async function understandQuery(base44: any, question: string, conversation: Turn[]) {
  const fallback = {
    standalone_query: question,
    search_queries: [question],
    intent: 'other' as Intent,
    detected_client_mention: null as string | null,
  };
  try {
    const historyText = conversation.length
      ? conversation.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n')
      : '(no prior turns)';
    const res = await base44.asServiceRole.integrations.Core.InvokeLLM({
      model: 'gemini_3_flash',
      prompt: `You rewrite a user's latest message into standalone search queries for an internal knowledge base.

Conversation so far:
${historyText}

Latest user message: ${question}

Return JSON:
- standalone_query: the latest message rewritten to stand alone (resolve "it"/"that"/"the step" using the conversation; keep the user's meaning; do not answer it).
- search_queries: 1-3 short search strings covering the information need (expansions or sub-questions). The first should be the standalone query.
- intent: one of ["procedure","decision_rule","troubleshooting","definition","overview","other"].
- detected_client_mention: the name of a specific client/company the user names in the latest message, or null. This is only a hint; it must not be treated as authoritative.`,
      response_json_schema: {
        type: 'object',
        properties: {
          standalone_query: { type: 'string' },
          search_queries: { type: 'array', items: { type: 'string' } },
          intent: { type: 'string' },
          detected_client_mention: { type: ['string', 'null'] },
        },
      },
    });
    const data = res?.response || res;
    const intent: Intent = INTENTS.includes(data?.intent) ? data.intent : 'other';
    const queries: string[] = Array.isArray(data?.search_queries)
      ? data.search_queries.filter((q: unknown) => typeof q === 'string' && q.trim()).slice(0, 3)
      : [];
    return {
      standalone_query: (data?.standalone_query || question).toString(),
      search_queries: queries.length ? queries : [data?.standalone_query || question],
      intent,
      detected_client_mention: data?.detected_client_mention || null,
    };
  } catch (_) {
    return fallback;
  }
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const question = (body?.question || '').toString().trim();
    if (!question) return Response.json({ error: 'Question is required' }, { status: 400 });

    // Scope is set ONLY by this argument. Never inferred from the question.
    const clientId: string | null = body?.clientId ? String(body.clientId) : null;
    const conversation = sanitizeConversation(body?.conversation);

    let clientName: string | null = null;
    if (clientId) {
      const client = await base44.asServiceRole.entities.Client.get(clientId).catch(() => null);
      if (!client) {
        return Response.json({ error: 'Unknown client context' }, { status: 400 });
      }
      clientName = client.name || null;
    }

    const understanding = await understandQuery(base44, question, conversation);

    // Soft warning only — mentioning another client never changes scope.
    let scopeNotice: string | null = null;
    const mention = (understanding.detected_client_mention || '').trim();
    if (mention) {
      if (!clientId) {
        scopeNotice = `You mentioned "${mention}", but no client is selected, so this answer only uses firm-wide general knowledge.`;
      } else if (clientName && mention.toLowerCase() !== clientName.toLowerCase()) {
        scopeNotice = `You mentioned "${mention}", but the active client context is "${clientName}". This answer only uses "${clientName}" and general knowledge.`;
      }
    }

    // --- Config: chat-engine row + Phase 3 system/governance row. Both reads
    // tolerate a missing row; every flag falls back to its safe default. ---
    const [cfgRow, sysRow] = await Promise.all([
      base44.asServiceRole.entities.AppConfig.filter({ key: 'chat' }).catch(() => []).then((r: any[]) => r?.[0]),
      base44.asServiceRole.entities.AppConfig.filter({ key: 'system' }).catch(() => []).then((r: any[]) => r?.[0]),
    ]);
    const flags = {
      requireVerified: sysRow?.require_verification_for_retrieval === true, // default off
      requireIngestionOk: sysRow?.require_ingestion_review === true, // default off
      rankingEnabled: sysRow?.governance_ranking_enabled !== false, // default ON
      loggingEnabled: sysRow?.answer_logging_enabled === true, // default OFF (explicit opt-in)
    };

    // Best-effort AnswerLog write. Knowledge-quality analytics only: NO asking
    // user id is stored, and a failure here never affects the answer. Uses
    // Base44's built-in created_date for ordering. No-op unless the flag is on.
    const logAnswer = async (data: Record<string, unknown>): Promise<string | null> => {
      if (!flags.loggingEnabled) return null;
      try {
        const row = await base44.asServiceRole.entities.AnswerLog.create({
          engine: 'v2',
          question,
          standalone_query: understanding.standalone_query,
          client_scope: clientId ? `client:${clientId}` : 'general',
          latency_ms: Date.now() - startedAt,
          ...data,
        });
        return row?.id ?? null;
      } catch (logErr) {
        console.error(JSON.stringify({
          fn: 'askKnowledgeBaseV2',
          stage: 'answer_log',
          error: redact((logErr as Error)?.message ?? String(logErr)).slice(0, 200),
        }));
        return null;
      }
    };

    // --- Retrieve candidates. DB query is scoped by knowledge_scope / client_id
    // ONLY. Lifecycle + governance filtering runs in code, after assertInScope,
    // on each chunk's denormalized last-indexed metadata (rankChunks ->
    // applyGovernanceFilters) — no `$and` nesting, no live joins, identical in
    // semantic and lexical mode. ---
    const scopeOr: Record<string, unknown>[] = [{ knowledge_scope: 'general' }];
    if (clientId) scopeOr.push({ knowledge_scope: 'client-specific', client_id: clientId });

    const candidates: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
      { $or: scopeOr },
      null,
      5000,
    );

    if (candidates.length === 0) {
      const answer_log_id = await logAnswer({
        answer_status: 'no_candidates',
        confidence: 'low',
        retrieval_mode: 'lexical',
        retrieved_chunk_ids: [],
        reranked_chunk_ids: [],
        final_source_ids: [],
      });
      return Response.json({
        answer:
          "The knowledge base doesn't have any indexed training content for this context yet. An admin needs to classify and index trainings first.",
        sources: [],
        confidence: 'low',
        used_chunk_ids: [],
        client_context: clientId ? { id: clientId, name: clientName } : null,
        scope_notice: scopeNotice,
        retrieval_mode: 'lexical',
        answer_log_id,
      });
    }

    // --- Retrieval mode. Embeddings are OPTIONAL. ---
    // 'lexical'  : never call the provider.
    // 'semantic' : require it (error loudly if unavailable).
    // 'auto'     : call embed() ONLY if a key is configured; on any runtime
    //              failure (bad key, quota, outage) fall back to lexical.
    const retrievalModeCfg: string = cfgRow?.retrieval_mode || 'auto';
    const plan = planRetrieval(retrievalModeCfg, isEmbeddingsConfigured());

    let queryVectors: number[][] = [];
    if (plan.requireEmbed && !plan.attemptEmbed) {
      return Response.json(
        { error: "Semantic retrieval is required (retrieval_mode='semantic') but no EMBEDDINGS_API_KEY is configured.", retrieval_mode: 'semantic' },
        { status: 502 },
      );
    }
    if (plan.attemptEmbed) {
      try {
        queryVectors = await embed(understanding.search_queries, 'query');
      } catch (embedErr) {
        const msg = redact((embedErr as Error)?.message ?? String(embedErr));
        if (plan.requireEmbed) {
          return Response.json(
            { error: `Semantic retrieval is required (retrieval_mode='semantic') but embeddings failed: ${msg}`, retrieval_mode: 'semantic' },
            { status: 502 },
          );
        }
        console.error(JSON.stringify({
          fn: 'askKnowledgeBaseV2', stage: 'embed_query', mode: 'lexical-fallback',
          name: (embedErr as Error)?.name ?? 'Error', error: msg.slice(0, 300),
        }));
        queryVectors = [];
      }
    }
    // else: retrieval_mode='lexical', OR 'auto' with no key -> skip embed(),
    //       go straight to lexical (no wasted provider round-trip).

    const { ranked, dropped, filteredOut, semanticActive } = rankChunks({
      chunks: candidates,
      queryVectors,
      standaloneQuery: understanding.standalone_query,
      intent: understanding.intent,
      clientId,
      governance: {
        requireVerified: flags.requireVerified,
        requireIngestionOk: flags.requireIngestionOk,
        rankingEnabled: flags.rankingEnabled,
      },
    });
    const retrievalMode: 'semantic' | 'lexical' = semanticActive ? 'semantic' : 'lexical';

    if (dropped.length) {
      // Should be impossible given the scoped query — log loudly if it happens.
      console.error(
        `askKnowledgeBaseV2: assertInScope dropped ${dropped.length} out-of-scope chunk(s) for clientId=${clientId}`,
        dropped.slice(0, 5).map((d) => ({ id: d.id, scope: d.knowledge_scope, client_id: d.client_id })),
      );
    }

    // Governance/lifecycle exclusions are EXPECTED — one info line, not an error.
    const filteredCounts: Record<string, number> = {};
    for (const f of filteredOut) filteredCounts[f.reason] = (filteredCounts[f.reason] || 0) + 1;
    if (filteredOut.length) {
      console.log(JSON.stringify({
        fn: 'askKnowledgeBaseV2', stage: 'governance_filter',
        clientId, counts: filteredCounts,
      }));
    }

    const confidence = pickConfidence(ranked, { semanticActive });
    const scoresJson = JSON.stringify(
      ranked.map((r) => ({
        id: r.chunk.id,
        sem: Number(r.sem.toFixed(4)),
        lex: Number(r.lex.toFixed(4)),
        score: Number(r.score.toFixed(4)),
      })),
    );
    const topProcessId = ranked[0]?.chunk.operational_process_id || undefined;

    if (confidence === 'low' || ranked.length === 0) {
      const maybe = ranked.slice(0, 3).map((r) => r.chunk.title).filter(Boolean);
      const relatedLine = maybe.length
        ? `\n\nLoosely related trainings: ${[...new Set(maybe)].join(', ')}.`
        : '';
      const answer_log_id = await logAnswer({
        answer_status: 'low_confidence',
        confidence: 'low',
        retrieval_mode: retrievalMode,
        operational_process_id: topProcessId,
        retrieved_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
        reranked_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
        final_source_ids: [],
        retrieval_scores: scoresJson,
        filtered_out_counts: JSON.stringify(filteredCounts),
      });
      return Response.json({
        answer:
          `I couldn't find training content that clearly answers this${
            clientName ? ` for ${clientName}` : ''
          }. It may not be covered yet, or the question may need rephrasing with more specific terms (a software name, a workflow step, a document type).${relatedLine}` +
          (scopeNotice ? `\n\n_${scopeNotice}_` : ''),
        sources: [],
        confidence: 'low',
        used_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
        client_context: clientId ? { id: clientId, name: clientName } : null,
        scope_notice: scopeNotice,
        retrieval_mode: retrievalMode,
        answer_log_id,
      });
    }

    // --- Answer generation. Only the retrieved chunks are provided. ---
    const sourceBlocks = ranked.map((r, i) => {
      const c = r.chunk;
      return `[S${i + 1}] Training: "${c.title || 'Untitled'}" | ${c.chunk_type || 'note'}${
        c.knowledge_scope === 'client-specific' ? ` | client: ${clientName || c.client_id}` : ' | general'
      }\n${c.content}`;
    });

    const historyText = conversation.length
      ? conversation.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n')
      : '(no prior turns)';

    const answerRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
      model: 'claude_sonnet_4_6',
      prompt: `You are MindVault's assistant for an internal financial-operations knowledge base.

Answer the user's question using ONLY the numbered sources below. Ground every claim in a source and cite it inline as [S1], [S2], etc. If the sources do not cover part of the question, say so plainly rather than guessing. Do not use outside knowledge.

${clientName ? `Active client context: ${clientName}. ` : 'No specific client context — general/firm-wide knowledge only. '}${scopeNotice ? `Note: ${scopeNotice} ` : ''}

Conversation so far (for context and tone only — still answer only from the sources):
${historyText}

Question: ${understanding.standalone_query}

Sources:
${sourceBlocks.join('\n\n---\n\n')}

Respond in markdown with:
1. A direct answer, with [S#] citations.
2. Relevant steps or decision rules, if any are in the sources.
3. Watchouts / common mistakes, if any are in the sources.
Keep it concise. If the sources are thin, say what's missing.`,
    });

    const answerText = typeof answerRes === 'string'
      ? answerRes
      : (answerRes?.response || answerRes?.output || '').toString();

    // Map [S#] citations actually used back to source trainings.
    const citedIdx = parseCitations(answerText, ranked.length);
    const chosen = citedIdx.length ? citedIdx.map((i) => ranked[i]) : ranked.slice(0, 3);

    const sources: any[] = [];
    const seenTraining = new Set<string>();
    for (const r of chosen) {
      if (seenTraining.has(r.chunk.training_id)) continue;
      seenTraining.add(r.chunk.training_id);
      sources.push({
        id: r.chunk.training_id,
        title: r.chunk.title || 'Untitled training',
        category: r.chunk.topic_category || '',
      });
    }

    const answer_log_id = await logAnswer({
      answer_status: 'answered',
      confidence,
      retrieval_mode: retrievalMode,
      operational_process_id: topProcessId,
      retrieved_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
      reranked_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
      final_source_ids: sources.map((s) => s.id),
      retrieval_scores: scoresJson,
      filtered_out_counts: JSON.stringify(filteredCounts),
    });

    return Response.json({
      answer: answerText + (scopeNotice ? `\n\n_${scopeNotice}_` : ''),
      sources,
      confidence,
      used_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
      client_context: clientId ? { id: clientId, name: clientName } : null,
      scope_notice: scopeNotice,
      retrieval_mode: retrievalMode,
      answer_log_id,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
