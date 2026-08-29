import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { embed, getEmbeddingModelName } from '../../shared/embeddings.ts';
import { approxTokens, chunkText, contentHash, extractKeywords } from '../../shared/text.ts';

// Builds and refreshes KnowledgeChunk rows for a Training record so the RAG
// chatbot (askKnowledgeBaseV2) has something to retrieve.
//
// Hard rule: a training whose knowledge_scope is missing or "unclassified" is
// NEVER indexed. "general" means a human deliberately marked it firm-wide.
//
// Input: { trainingId }  -> index/refresh one training
//        { all: true, skip?, limit? }  -> batch mode, MANUAL/approved use only
//
// Idempotent: unchanged chunks (same content_hash) are kept, drifted scope
// fields are re-stamped, removed chunks are deleted.

const CHUNK_TARGET_TOKENS = 600;
const CHUNK_OVERLAP_TOKENS = 90;
const BULK_PAGE = 100;
const MAX_TRANSCRIPT_CHARS = 60000;

interface DraftChunk {
  chunk_type: string;
  content: string;
}

function buildDraftChunks(training: any, transcript: string | null): DraftChunk[] {
  const drafts: DraftChunk[] = [];
  const push = (chunk_type: string, content: unknown) => {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text) drafts.push({ chunk_type, content: text });
  };

  push('summary', training.summary);
  for (const part of chunkText(training.ai_knowledge_entry || '', {
    targetTokens: CHUNK_TARGET_TOKENS,
    overlapTokens: CHUNK_OVERLAP_TOKENS,
  })) {
    push('ai_knowledge_entry', part);
  }
  for (const t of training.key_takeaways || []) push('key_takeaway', t);
  for (const s of training.sop_steps || []) push('sop_step', s);
  for (const r of training.decision_rules || []) push('decision_rule', r);
  for (const m of training.common_mistakes || []) push('common_mistake', m);

  if (transcript) {
    for (const part of chunkText(transcript.slice(0, MAX_TRANSCRIPT_CHARS), {
      targetTokens: CHUNK_TARGET_TOKENS,
      overlapTokens: CHUNK_OVERLAP_TOKENS,
    })) {
      push('transcript', part);
    }
  }
  return drafts;
}

async function fetchTranscript(training: any): Promise<string | null> {
  const ref = training.transcript;
  if (!ref || typeof ref !== 'string') return null;
  if (!ref.startsWith('http')) return ref.trim() || null;
  try {
    const res = await fetch(ref);
    if (!res.ok) return null;
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.length < 20 || trimmed.startsWith('<')) return null;
    return trimmed;
  } catch (_) {
    return null;
  }
}

async function indexOne(base44: any, trainingId: string) {
  const training = await base44.asServiceRole.entities.Training.get(trainingId);
  if (!training) return { trainingId, error: 'Training not found', status: 404 };

  const scope = training.knowledge_scope || 'unclassified';
  if (scope === 'unclassified') {
    // Never retrievable -> make sure no stale chunks linger (e.g. after an
    // admin moves a training back from general/client-specific to unclassified).
    const stale: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
      { training_id: trainingId },
      null,
      5000,
    );
    for (const c of stale) await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
    return {
      trainingId,
      skipped: true,
      reason: 'unclassified — classify it before indexing',
      deleted: stale.length,
    };
  }
  if (scope === 'client-specific' && !training.client_id) {
    return { trainingId, error: 'client-specific training is missing client_id', status: 400 };
  }

  const model = getEmbeddingModelName();
  const transcript = await fetchTranscript(training);
  const drafts = buildDraftChunks(training, transcript);

  // Compute hashes for the desired chunk set.
  const desired = await Promise.all(
    drafts.map(async (d, i) => ({
      chunk_index: i,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: await contentHash(d.content),
    })),
  );
  const desiredHashes = new Set(desired.map((d) => d.content_hash));

  const scopeFields = {
    knowledge_scope: scope,
    client_id: scope === 'client-specific' ? training.client_id : undefined,
    title: training.title || '',
    topic_category: training.topic_category || training.category || '',
    client_segment: training.client_segment || '',
  };

  // Existing chunks for this training.
  const existing: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
    { training_id: trainingId },
    null,
    5000,
  );
  const existingByHash = new Map<string, any>();
  for (const c of existing) existingByHash.set(c.content_hash, c);

  const toCreate: any[] = [];
  const toEmbed: string[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  for (const d of desired) {
    const match = existingByHash.get(d.content_hash);
    if (match) {
      // Re-stamp denormalized fields if they drifted (e.g. after reclassify).
      const drift: Record<string, unknown> = {};
      if ((match.knowledge_scope || '') !== scopeFields.knowledge_scope) drift.knowledge_scope = scopeFields.knowledge_scope;
      if ((match.client_id || undefined) !== scopeFields.client_id) drift.client_id = scopeFields.client_id ?? null;
      if ((match.chunk_index ?? -1) !== d.chunk_index) drift.chunk_index = d.chunk_index;
      if ((match.title || '') !== scopeFields.title) drift.title = scopeFields.title;
      if ((match.topic_category || '') !== scopeFields.topic_category) drift.topic_category = scopeFields.topic_category;
      if ((match.client_segment || '') !== scopeFields.client_segment) drift.client_segment = scopeFields.client_segment;
      if (Object.keys(drift).length) updates.push({ id: match.id, data: drift });
      continue;
    }
    toEmbed.push(d.content);
    toCreate.push({
      training_id: trainingId,
      chunk_index: d.chunk_index,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: d.content_hash,
      token_count: approxTokens(d.content),
      keywords: extractKeywords(d.content),
      embedding_model: model,
      ...scopeFields,
    });
  }

  // Embed only the genuinely new chunks.
  if (toEmbed.length) {
    const vectors = await embed(toEmbed, 'document');
    for (let i = 0; i < toCreate.length; i++) toCreate[i].embedding = vectors[i];
  }

  // Orphans: existing chunks no longer in the desired set.
  const toDelete = existing.filter((c) => !desiredHashes.has(c.content_hash));

  let created = 0;
  for (let i = 0; i < toCreate.length; i += BULK_PAGE) {
    const page = toCreate.slice(i, i + BULK_PAGE);
    await base44.asServiceRole.entities.KnowledgeChunk.bulkCreate(page);
    created += page.length;
  }
  for (const u of updates) {
    await base44.asServiceRole.entities.KnowledgeChunk.update(u.id, u.data);
  }
  for (const c of toDelete) {
    await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
  }

  return {
    trainingId,
    knowledge_scope: scope,
    created,
    reused: desired.length - created,
    restamped: updates.length,
    deleted: toDelete.length,
    total: desired.length,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    if (body.all) {
      // Batch/backfill mode. Only classified, ready trainings. Paginated so the
      // caller drives it explicitly — this is never triggered automatically.
      const skip = Number(body.skip) || 0;
      const limit = Math.min(25, Number(body.limit) || 10);
      const batch: any[] = await base44.asServiceRole.entities.Training.filter(
        { status: 'ready', knowledge_scope: { $in: ['general', 'client-specific'] } },
        '-created_date',
        limit,
        skip,
      );
      const results = [];
      for (const t of batch) results.push(await indexOne(base44, t.id));
      return Response.json({
        mode: 'all',
        processed: batch.length,
        next_skip: batch.length === limit ? skip + limit : null,
        results,
      });
    }

    if (!body.trainingId) {
      return Response.json({ error: 'trainingId is required' }, { status: 400 });
    }
    const result = await indexOne(base44, body.trainingId);
    const status = (result as any).status;
    if (status) {
      const { status: _omit, ...rest } = result as any;
      return Response.json(rest, { status });
    }
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
});
