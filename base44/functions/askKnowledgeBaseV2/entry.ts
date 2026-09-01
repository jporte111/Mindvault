import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { embed } from '../../shared/embeddings.ts';
import { type Intent, parseCitations, pickConfidence, rankChunks } from '../../shared/retrieval.ts';

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

    // --- Retrieve candidates. DB query is scoped; assertInScope is the backstop. ---
    // FUTURE GATE (Phase 3): additional pre-generation filters land here —
    // is_active_version, effective-date window, archived exclusion, and (behind
    // a `require_verification_for_retrieval` / `require_ingestion_review` flag)
    // verification_status and ingestion_quality. All default-off or
    // default-pass so existing production knowledge keeps answering. No such
    // filter in Phase 1; the scope gate below is unchanged.
    const scopeOr: Record<string, unknown>[] = [{ knowledge_scope: 'general' }];
    if (clientId) scopeOr.push({ knowledge_scope: 'client-specific', client_id: clientId });

    const candidates: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
      { $or: scopeOr },
      null,
      5000,
    );

    if (candidates.length === 0) {
      return Response.json({
        answer:
          "The knowledge base doesn't have any indexed training content for this context yet. An admin needs to classify and index trainings first.",
        sources: [],
        confidence: 'low',
        used_chunk_ids: [],
        client_context: clientId ? { id: clientId, name: clientName } : null,
        scope_notice: scopeNotice,
      });
    }

    const queryVectors = await embed(understanding.search_queries, 'query');

    const { ranked, dropped } = rankChunks({
      chunks: candidates,
      queryVectors,
      standaloneQuery: understanding.standalone_query,
      intent: understanding.intent,
      clientId,
    });

    if (dropped.length) {
      // Should be impossible given the scoped query — log loudly if it happens.
      console.error(
        `askKnowledgeBaseV2: assertInScope dropped ${dropped.length} out-of-scope chunk(s) for clientId=${clientId}`,
        dropped.slice(0, 5).map((d) => ({ id: d.id, scope: d.knowledge_scope, client_id: d.client_id })),
      );
    }

    const confidence = pickConfidence(ranked);

    if (confidence === 'low' || ranked.length === 0) {
      const maybe = ranked.slice(0, 3).map((r) => r.chunk.title).filter(Boolean);
      const relatedLine = maybe.length
        ? `\n\nLoosely related trainings: ${[...new Set(maybe)].join(', ')}.`
        : '';
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

    return Response.json({
      answer: answerText + (scopeNotice ? `\n\n_${scopeNotice}_` : ''),
      sources,
      confidence,
      used_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
      client_context: clientId ? { id: clientId, name: clientName } : null,
      scope_notice: scopeNotice,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
