import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { embed } from '../../shared/embeddings.ts';
import { assertInScope, pickConfidence, rankChunks } from '../../shared/retrieval.ts';

// READ-ONLY evaluation of the RAG retrieval pipeline against real indexed
// KnowledgeChunks. Never creates, updates, or deletes anything. Admin only.
//
// Input: { cases: EvalCase[] }  (see scripts/rag-eval/cases.example.jsonl)
//   EvalCase = {
//     id, question, clientScope ("general" | "client:<id>"),
//     conversation?: {role,content}[],
//     expectTrainingTitleIncludes?: string[],   // recall check (case-insensitive substring)
//     expectConfidence?: "low"|"medium"|"high",
//     forbidAnswerSubstring?: string[]           // reported, not retrieval-enforced
//   }
//
// Output: per-case retrieval + pass flags, plus an aggregate. The single
// hardest requirement: total_scope_violations MUST be 0.

interface EvalCase {
  id?: string;
  question: string;
  clientScope?: string;
  conversation?: Array<{ role: string; content: string }>;
  expectTrainingTitleIncludes?: string[];
  expectConfidence?: 'low' | 'medium' | 'high';
  forbidAnswerSubstring?: string[];
}

function clientIdFromScope(scope?: string): string | null {
  if (scope && scope.startsWith('client:')) return scope.slice('client:'.length);
  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const cases: EvalCase[] = Array.isArray(body?.cases) ? body.cases : [];
    if (cases.length === 0) {
      return Response.json({ error: 'Provide { cases: [...] }' }, { status: 400 });
    }
    // Force lexical retrieval (no embeddings) to verify the fallback path,
    // especially that scope isolation still holds.
    const forceLexical = body?.mode === 'lexical';
    // Optionally exercise the Phase 3 governance gates (default off, matching
    // production defaults). { requireVerified?, requireIngestionOk? }.
    const governanceOpt = body?.governance && typeof body.governance === 'object'
      ? {
        requireVerified: body.governance.requireVerified === true,
        requireIngestionOk: body.governance.requireIngestionOk === true,
      }
      : undefined;

    const results = [];
    let recallHits = 0, recallTotal = 0;
    let confHits = 0, confTotal = 0;
    let scopeViolations = 0;

    for (const c of cases) {
      const clientId = clientIdFromScope(c.clientScope);

      // Same scoped query the production function uses.
      const scopeOr: Record<string, unknown>[] = [{ knowledge_scope: 'general' }];
      if (clientId) scopeOr.push({ knowledge_scope: 'client-specific', client_id: clientId });
      const candidates: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
        { $or: scopeOr },
        null,
        5000,
      );

      const lastUser = [...(c.conversation || [])].reverse().find((t) => t.role === 'user');
      const queryText = lastUser ? `${lastUser.content}\n${c.question}` : c.question;
      let queryVectors: number[][] = [];
      if (!forceLexical) {
        try {
          const [qv] = await embed([queryText], 'query');
          if (qv) queryVectors = [qv];
        } catch (_) { queryVectors = []; }
      }

      const { ranked, dropped, filteredOut, semanticActive } = rankChunks({
        chunks: candidates,
        queryVectors,
        standaloneQuery: queryText,
        clientId,
        governance: governanceOpt,
      });

      // Independent backstop check.
      const { dropped: wouldDrop } = assertInScope(candidates, clientId);
      const violations = wouldDrop.filter(
        (d) => d.knowledge_scope === 'client-specific' && d.client_id === clientId,
      ).length + dropped.filter((d) => d.knowledge_scope === 'general').length;
      scopeViolations += violations;

      const confidence = pickConfidence(ranked, { semanticActive });
      const retrieved = ranked.map((r) => ({
        training_id: r.chunk.training_id,
        title: r.chunk.title || '',
        chunk_type: r.chunk.chunk_type,
        knowledge_scope: r.chunk.knowledge_scope,
        client_id: r.chunk.client_id ?? null,
        sem: Number(r.sem.toFixed(4)),
        score: Number(r.score.toFixed(4)),
      }));

      // Any retrieved chunk outside the active scope is a hard failure.
      const outOfScope = retrieved.filter(
        (r) => !(r.knowledge_scope === 'general' || (r.knowledge_scope === 'client-specific' && r.client_id === clientId)),
      );
      scopeViolations += outOfScope.length;

      let recallPass: boolean | null = null;
      if (c.expectTrainingTitleIncludes?.length) {
        recallTotal++;
        const titles = retrieved.map((r) => r.title.toLowerCase());
        recallPass = c.expectTrainingTitleIncludes.some((sub) =>
          titles.some((t) => t.includes(sub.toLowerCase())),
        );
        if (recallPass) recallHits++;
      }

      let confidencePass: boolean | null = null;
      if (c.expectConfidence) {
        confTotal++;
        confidencePass = confidence === c.expectConfidence;
        if (confidencePass) confHits++;
      }

      const filteredCounts: Record<string, number> = {};
      for (const f of filteredOut) filteredCounts[f.reason] = (filteredCounts[f.reason] || 0) + 1;

      results.push({
        id: c.id || null,
        clientScope: c.clientScope || 'general',
        retrieval_mode: semanticActive ? 'semantic' : 'lexical',
        confidence,
        candidates: candidates.length,
        retrieved,
        out_of_scope_retrieved: outOfScope,
        filtered_out: filteredOut.map((f) => ({ id: f.id ?? null, reason: f.reason })),
        filtered_out_counts: filteredCounts,
        recall_pass: recallPass,
        confidence_pass: confidencePass,
        forbid_answer_substring: c.forbidAnswerSubstring || null,
      });
    }

    return Response.json({
      total_cases: cases.length,
      mode: forceLexical ? 'lexical' : 'auto',
      governance: governanceOpt || { requireVerified: false, requireIngestionOk: false },
      total_scope_violations: scopeViolations,
      recall_at_k: recallTotal ? Number((recallHits / recallTotal).toFixed(3)) : null,
      confidence_gate_accuracy: confTotal ? Number((confHits / confTotal).toFixed(3)) : null,
      results,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
