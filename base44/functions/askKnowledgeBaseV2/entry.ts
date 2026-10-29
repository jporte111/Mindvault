import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { resolveTenantContext, TenantAuthError } from '../../shared/tenant.ts';
import { embed, isEmbeddingsConfigured } from '../../shared/embeddings.ts';
import { redact } from '../../shared/redact.ts';
import {
  hasMinimumEvidence,
  type Intent,
  parseCitations,
  pickConfidence,
  planRetrieval,
  rankChunks,
  rewriteDriftSignal,
} from '../../shared/retrieval.ts';
import {
  buildFacetInventory,
  classifySectionAuthority,
  deriveAnswerStatus,
  flattenToMarkdown,
  isOperationalIntent,
  OPERATIONAL_SECTION_KEYS,
  SECTION_TITLES,
  shouldKeepContradictionNote,
  stalenessFlags,
  validateRequestedFacets,
  validateSections,
} from '../../shared/operationalAnswer.ts';
import { normalizeTopic } from '../../shared/knowledgeGap.ts';
import { reporterHmac } from '../../shared/reporterId.ts';
import { aggregateGap } from '../../shared/gapAggregation.ts';

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
    requested_facets: [] as string[],
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
- detected_client_mention: the name of a specific client/company the user names in the latest message, or null. This is only a hint; it must not be treated as authoritative.
- requested_facets: array of any of ["steps","prerequisites","approvals","exceptions","prohibited_actions","verification_checkpoints","escalation","watch_outs","systems","expected_result"] that the user is EXPLICITLY asking about (e.g. "who approves this" -> ["approvals"]; "what are the steps and what can go wrong" -> ["steps","watch_outs"]). Empty array if the question is general or asks for none of these specifically.`,
      response_json_schema: {
        type: 'object',
        properties: {
          standalone_query: { type: 'string' },
          search_queries: { type: 'array', items: { type: 'string' } },
          intent: { type: 'string' },
          detected_client_mention: { type: ['string', 'null'] },
          requested_facets: { type: 'array', items: { type: 'string' } },
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
      // The LLM's facet DETECTION is non-deterministic; validateRequestedFacets
      // (enum-checked, tested) is the contract everything downstream relies on.
      requested_facets: validateRequestedFacets(data?.requested_facets),
    };
  } catch (_) {
    return fallback;
  }
}

// --- Operational answer generation (Phase 4) ------------------------------
// Runs INSTEAD OF the prose generation call when operational_answer_mode is on
// and the intent is operational. The LLM proposes a structured answer; the pure
// operationalAnswer.ts helpers decide citations, status, and authority. Throws
// on any failure so the caller can fall back to the prose path.
async function generateOperationalAnswer(base44: any, opts: {
  ranked: any[];
  standaloneQuery: string;
  requestedFacets: string[];
  baseBand: 'low' | 'medium' | 'high';
  clientName: string | null;
  scopeNotice: string | null;
  historyText: string;
}): Promise<{
  operational_answer: any;
  operational_status: 'HIGH' | 'PARTIAL' | 'INSUFFICIENT';
  answerMarkdown: string;
  citedTrainingIds: string[];
  missingFacets: string[];
  hadContradiction: boolean;
}> {
  const { ranked, standaloneQuery, requestedFacets, baseBand, clientName, scopeNotice, historyText } = opts;
  const rc = ranked.length;

  const sourceBlocks = ranked.map((r, i) => {
    const c = r.chunk;
    return `[S${i + 1}] "${c.title || 'Untitled'}" | ${c.chunk_type || 'note'}${
      c.knowledge_scope === 'client-specific' ? ` | client: ${clientName || c.client_id}` : ' | general'
    }\n${c.content}`;
  });
  const inventory = buildFacetInventory(ranked);

  const res = await base44.asServiceRole.integrations.Core.InvokeLLM({
    model: 'claude_sonnet_4_6',
    prompt: `You are MindVault's internal operations assistant. Produce a STRUCTURED operational answer using ONLY the numbered sources below. Ground every statement in a source and cite it inline as [S1], [S2], etc. Use no outside knowledge.

${clientName ? `Active client context: ${clientName}. ` : 'No specific client context — general/firm-wide knowledge only. '}${scopeNotice ? `Note: ${scopeNotice} ` : ''}

Conversation so far (context/tone only — still answer only from the sources):
${historyText}

Question: ${standaloneQuery}

The retrieved sources appear to contain material for these facets: ${inventory.length ? inventory.join(', ') : '(none obvious)'}. Extract ONLY what the sources actually state.

NEVER invent an approver, a role, a job title, a dollar or percentage threshold, a deadline or date, a system/tool name, a form or document name, an account, or an escalation target. If the sources do not state something, leave that section out entirely.

If two sources give CONFLICTING values for the same fact (e.g. different approver, different threshold, different step order), do not pick one — set contradiction_note to a sentence that states both and cites each ([S1] says X; [S3] says Y).

Sources:
${sourceBlocks.join('\n\n---\n\n')}

Return JSON:
- direct_answer: { text } — 1-3 sentences answering the question, each claim cited [S#]. Omit only if the sources cannot answer it at all.
- sections: array of { key, items: [{ text }] } where key is one of ${OPERATIONAL_SECTION_KEYS.join(', ')}. Include a section ONLY if the sources support at least one cited item for it. Order items logically. Each item text must carry at least one [S#].
- contradiction_note: string or null.`,
    response_json_schema: {
      type: 'object',
      properties: {
        direct_answer: { type: ['object', 'null'], properties: { text: { type: 'string' } } },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } },
            },
          },
        },
        contradiction_note: { type: ['string', 'null'] },
      },
    },
  });

  const data = res?.response || res;

  const directRaw = data?.direct_answer;
  const directText = directRaw && typeof directRaw.text === 'string' ? directRaw.text : '';
  const directAnswer = directText.trim()
    ? { text: directText, citations: parseCitations(directText, rc) }
    : null;

  const rawSections = Array.isArray(data?.sections) ? data.sections : [];
  const enrichedSections = rawSections
    .filter((s: any) => s && typeof s.key === 'string')
    .map((s: any) => ({
      key: s.key,
      items: (Array.isArray(s.items) ? s.items : [])
        .filter((it: any) => it && typeof it.text === 'string' && it.text.trim())
        .map((it: any) => ({ text: String(it.text), citations: parseCitations(String(it.text), rc) })),
    }));

  const { sections: validSections, directAnswerValid } = validateSections({
    directAnswer,
    sections: enrichedSections,
  });

  const noteRaw = typeof data?.contradiction_note === 'string' && data.contradiction_note.trim()
    ? data.contradiction_note.trim()
    : null;
  const noteCitations = noteRaw ? parseCitations(noteRaw, rc) : [];
  const contradictionNoteKept = noteRaw != null && shouldKeepContradictionNote(noteCitations);
  const contradictionNote = contradictionNoteKept ? noteRaw : null;

  const survivingKeys = validSections.map((s) => s.key);
  const { status, missingFacets } = deriveAnswerStatus({
    baseBand,
    directAnswerValid,
    requestedFacets,
    survivingSectionKeys: survivingKeys,
    contradictionNoteKept,
  });

  const sectionsWithAuthority = validSections.map((s) => ({
    key: s.key,
    title: SECTION_TITLES[s.key] || s.key,
    authority: classifySectionAuthority(s.items.flatMap((i) => i.citations), ranked),
    items: s.items,
  }));

  const citedIdx = new Set<number>([
    ...(directAnswer?.citations || []),
    ...sectionsWithAuthority.flatMap((s) => s.items.flatMap((i) => i.citations)),
  ]);
  const citedChunks = [...citedIdx].map((i) => ranked[i]?.chunk).filter(Boolean);
  const { stale_sources, unverified_used } = stalenessFlags(citedChunks);

  const isInsufficient = status === 'INSUFFICIENT';
  const operational_answer = {
    direct_answer: !isInsufficient && directAnswer
      ? { text: directAnswer.text, citations: directAnswer.citations, authority: classifySectionAuthority(directAnswer.citations, ranked) }
      : null,
    sections: isInsufficient ? [] : sectionsWithAuthority,
    missing_facets: missingFacets,
    contradiction_note: isInsufficient ? null : contradictionNote,
    stale_sources,
    unverified_used: isInsufficient ? false : unverified_used,
  };

  const answerMarkdown = flattenToMarkdown(operational_answer, status);

  const citedTrainingIds: string[] = [];
  const seen = new Set<string>();
  for (const i of citedIdx) {
    const tid = ranked[i]?.chunk?.training_id;
    if (tid && !seen.has(tid)) {
      seen.add(tid);
      citedTrainingIds.push(tid);
    }
  }

  return {
    operational_answer,
    operational_status: status,
    answerMarkdown,
    citedTrainingIds,
    missingFacets,
    hadContradiction: contradictionNoteKept,
  };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    // EMERGENCY GATE (production hotfix). Chat reads and generates as the
    // service role, so refuse anonymous callers and anyone without an ACTIVE
    // membership in an ACTIVE tenant before any data is touched. Platform
    // admins keep access. Retrieval scope is unchanged (single organization
    // today); tenant-isolated retrieval ships separately.
    let ctx;
    try {
      ctx = await resolveTenantContext(base44);
    } catch (e) {
      const status = e instanceof TenantAuthError ? e.status : 401;
      return Response.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status });
    }
    if (!ctx.hasTenantAccess) {
      return Response.json({ error: 'Forbidden — no active workspace membership' }, { status: 403 });
    }
    if (!ctx.isSuperAdmin) {
      const tenant = ctx.tenantId ? await base44.asServiceRole.entities.Tenant.get(ctx.tenantId).catch(() => null) : null;
      if (!tenant || (tenant.status && tenant.status !== 'active')) {
        return Response.json({ error: 'Forbidden — workspace is not active' }, { status: 403 });
      }
    }
    const user = await base44.auth.me().catch(() => null);

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
      operationalMode: sysRow?.operational_answer_mode === true, // Phase 4, default OFF
      // Phase 5: best-effort gap evidence from operational PARTIAL/INSUFFICIENT.
      // No-op unless BOTH flags are on. Never affects the answer or its latency.
      autoGap: sysRow?.knowledge_gaps_enabled === true && sysRow?.auto_gap_from_answer_status === true,
    };
    const wantOperational = flags.operationalMode && isOperationalIntent(understanding.intent);

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

    // When operational mode is engaged but we can't ground an answer, the
    // response still carries the operational shape so the UI shows the
    // INSUFFICIENT status consistently. No operational LLM call is made here.
    const emptyOperationalAnswer = {
      direct_answer: null,
      sections: [],
      missing_facets: [] as string[],
      contradiction_note: null,
      stale_sources: [] as Array<{ id: string; title: string }>,
      unverified_used: false,
    };
    const operationalInsufficientFields = wantOperational
      ? { answer_mode: 'operational', answer_status: 'INSUFFICIENT', operational_answer: emptyOperationalAnswer }
      : {};

    if (candidates.length === 0) {
      const answer_log_id = await logAnswer({
        answer_status: 'no_candidates',
        confidence: 'low',
        retrieval_mode: 'lexical',
        retrieved_chunk_ids: [],
        reranked_chunk_ids: [],
        final_source_ids: [],
        ...(wantOperational ? { answer_mode: 'operational', operational_status: 'INSUFFICIENT' } : {}),
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
        ...operationalInsufficientFields,
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

    let confidence = pickConfidence(ranked, { semanticActive });
    // Phase 4.1: if understandQuery's rewrite (not the user's raw question)
    // supplied the operational vocabulary retrieval matched, cap — never fail —
    // confidence at 'medium'.
    if (confidence === 'high' && rewriteDriftSignal(question, understanding.standalone_query)) {
      confidence = 'medium';
    }
    // Phase 4.1: conservative per-row weak-evidence gate. Rejects (-> the
    // INSUFFICIENT / "couldn't find" early return, no generation call) only when
    // NO candidate row clears a modest lexical or matched-term floor on its own
    // coherent evidence tuple. No chunk-count / distinct-training requirement.
    const weakEvidence = !hasMinimumEvidence(ranked, { semanticActive });
    const scoresJson = JSON.stringify(
      ranked.map((r) => ({
        id: r.chunk.id,
        sem: Number(r.sem.toFixed(4)),
        lex: Number(r.lex.toFixed(4)),
        lexHits: r.lexHits,
        lexQTC: r.lexQueryTermCount,
        score: Number(r.score.toFixed(4)),
      })),
    );
    const topProcessId = ranked[0]?.chunk.operational_process_id || undefined;

    if (confidence === 'low' || ranked.length === 0 || weakEvidence) {
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
        ...(wantOperational ? { answer_mode: 'operational', operational_status: 'INSUFFICIENT' } : {}),
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
        ...operationalInsufficientFields,
      });
    }

    const historyText = conversation.length
      ? conversation.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n')
      : '(no prior turns)';

    // --- Phase 4: operational answer mode. When engaged, this runs INSTEAD OF
    // the prose generation below — one answer-generation call on the normal
    // path. On ANY failure it logs and falls through to the prose path, so an
    // employee never sees an error because operational mode broke. ---
    if (wantOperational) {
      try {
        const op = await generateOperationalAnswer(base44, {
          ranked,
          standaloneQuery: understanding.standalone_query,
          requestedFacets: understanding.requested_facets,
          baseBand: confidence,
          clientName,
          scopeNotice,
          historyText,
        });

        const opSources: any[] = [];
        const opSeen = new Set<string>();
        for (const tid of op.citedTrainingIds) {
          if (opSeen.has(tid)) continue;
          const r = ranked.find((x) => x.chunk.training_id === tid);
          if (!r) continue;
          opSeen.add(tid);
          opSources.push({ id: tid, title: r.chunk.title || 'Untitled training', category: r.chunk.topic_category || '' });
        }

        const answer_log_id = await logAnswer({
          answer_status: 'answered',
          confidence,
          retrieval_mode: retrievalMode,
          operational_process_id: topProcessId,
          retrieved_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
          reranked_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
          final_source_ids: opSources.map((s) => s.id),
          retrieval_scores: scoresJson,
          filtered_out_counts: JSON.stringify(filteredCounts),
          answer_mode: 'operational',
          operational_status: op.operational_status,
          operational_sections: JSON.stringify(
            op.operational_answer.sections.map((s: any) => ({ key: s.key, item_count: s.items.length, authority: s.authority })),
          ),
          missing_facets: JSON.stringify(op.missingFacets),
          had_contradiction: op.hadContradiction,
        });

        // Phase 5: accrue gap evidence from a documented deficiency. Best-effort,
        // fully swallowed — the answer above is already committed. PARTIAL needs
        // a specific missing facet; INSUFFICIENT needs to have retrieved
        // something (zero-candidate INSUFFICIENT is genuinely out of scope).
        const gapSecret = Deno.env.get('GAP_HMAC_SECRET');
        if (
          flags.autoGap &&
          !!user?.id &&
          gapSecret && gapSecret.trim() &&
          ((op.operational_status === 'PARTIAL' && op.missingFacets.length > 0) ||
            (op.operational_status === 'INSUFFICIENT' && ranked.length > 0))
        ) {
          try {
            const rhmac = await reporterHmac(user.id, gapSecret);
            await aggregateGap(base44, {
              normalizedTopic: normalizeTopic(understanding.standalone_query),
              clientScope: clientId ? `client:${clientId}` : 'general',
              operationalProcessId: topProcessId,
              relatedSourceIds: opSources.map((s) => s.id),
              missingFacets: op.missingFacets,
              origin: op.operational_status === 'PARTIAL' ? 'answer_status_partial' : 'answer_status_insufficient',
              reporterHmac: rhmac,
              exampleQuestion: flags.loggingEnabled ? understanding.standalone_query : null,
            });
          } catch (gapErr) {
            console.error(JSON.stringify({
              fn: 'askKnowledgeBaseV2', stage: 'auto_gap',
              error: redact((gapErr as Error)?.message ?? String(gapErr)).slice(0, 200),
            }));
          }
        }

        return Response.json({
          answer: op.answerMarkdown + (scopeNotice ? `\n\n_${scopeNotice}_` : ''),
          sources: opSources,
          confidence,
          answer_mode: 'operational',
          answer_status: op.operational_status,
          operational_answer: op.operational_answer,
          used_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
          client_context: clientId ? { id: clientId, name: clientName } : null,
          scope_notice: scopeNotice,
          retrieval_mode: retrievalMode,
          answer_log_id,
        });
      } catch (opErr) {
        console.error(JSON.stringify({
          fn: 'askKnowledgeBaseV2', stage: 'operational_generation',
          name: (opErr as Error)?.name ?? 'Error',
          error: redact((opErr as Error)?.message ?? String(opErr)).slice(0, 300),
        }));
        // fall through to the prose path below
      }
    }

    // --- Answer generation (prose). Only the retrieved chunks are provided. ---
    const sourceBlocks = ranked.map((r, i) => {
      const c = r.chunk;
      return `[S${i + 1}] Training: "${c.title || 'Untitled'}" | ${c.chunk_type || 'note'}${
        c.knowledge_scope === 'client-specific' ? ` | client: ${clientName || c.client_id}` : ' | general'
      }\n${c.content}`;
    });

    const proseRequest = {
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
    };

    // --- Fix 1: narrow reliability wrapper around prose generation. On failure,
    // retry EXACTLY ONCE with the identical proseRequest (same prompt, model, and
    // ranked context). Retrieval and understandQuery are never rerun. If the
    // retry also fails, return a safe 200 fallback instead of a hard 500 — the
    // employee never sees provider error text. Failure logging only; this stage
    // never writes an AnswerLog row. ---
    let answerRes: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        answerRes = await base44.asServiceRole.integrations.Core.InvokeLLM(proseRequest);
        break;
      } catch (genErr) {
        console.error(JSON.stringify({
          fn: 'askKnowledgeBaseV2',
          stage: 'prose_generation',
          attempt,
          error: redact((genErr as Error)?.message ?? String(genErr)).slice(0, 300),
        }));
        if (attempt === 2) {
          return Response.json({
            answer:
              "I found relevant knowledge for this, but couldn't complete the answer just now. Please try asking again in a moment.",
            sources: [],
            confidence: 'low',
            used_chunk_ids: ranked.map((r) => r.chunk.id).filter(Boolean),
            client_context: clientId ? { id: clientId, name: clientName } : null,
            scope_notice: scopeNotice,
            retrieval_mode: retrievalMode,
            answer_log_id: null,
          });
        }
      }
    }

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
      // Reaching the prose path with wantOperational === true means operational
      // generation was attempted and fell back — tag it so that shows in the
      // log. A non-operational question (even with the flag on) is NOT tagged:
      // answer_mode / answer_status appear only when wantOperational.
      ...(wantOperational ? { answer_mode: 'prose' } : {}),
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
      ...(wantOperational ? { answer_mode: 'prose' } : {}),
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});