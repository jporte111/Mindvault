import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { embed, getEmbeddingModelName, getEmbeddingProvider } from '../../shared/embeddings.ts';
import { approxTokens, chunkText, contentHash, extractKeywords } from '../../shared/text.ts';
import { buildGovFields, buildScopeFields, lifecycleSkipReason, scopeFieldsDrift } from '../../shared/governance.ts';
import {
  cleanupChunks,
  restampChunks,
  setChunksStale,
  verifyChunks,
  verifyStaleCleared,
} from '../../shared/chunkLifecycle.ts';
import { redact } from '../../shared/redact.ts';

// TEMP DIAGNOSTIC (remove once the embedKnowledge 500 is root-caused):
// every failure logs a single JSON line { fn, stage, trainingId, error, name }
// and the HTTP response carries { error, stage } instead of an opaque 500.
// The error text is run through redact() so no API key / bearer token is
// logged or returned. No source content is logged.

// Map an error message to a sensible HTTP status.
function statusFor(message: string): number {
  const m = (message || '').toLowerCase();
  if (m.includes('embeddings_api_key is not set') || m.includes('is not supported')) return 400;
  if (m.includes('embeddings api')) return 502;
  return 500;
}

function logFailure(stage: string, trainingId: string | undefined, err: unknown) {
  const e = err as { message?: string; name?: string };
  console.error(JSON.stringify({
    fn: 'embedKnowledge',
    stage,
    trainingId: trainingId ?? null,
    name: e?.name ?? 'Error',
    error: redact(e?.message ?? String(err)).slice(0, 800),
  }));
}

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

// --- Phase 6 lifecycle sub-commands ------------------------------------
// The default invocation ({ trainingId }) is UNCHANGED — a full reindex that
// leaves chunks retrievable immediately (the legacy classify / "Re-index"
// path). These modes are the IndexWorker surface the lifecycle engine binding
// drives; they never run automatically.
//
//   mode 'mark_stale'    -> set index_stale=true on every chunk (fail-closed)
//   mode 'clear_stale'   -> clear index_stale; returns { cleared }
//   mode 'restamp'       -> refresh denormalized metadata on existing chunks
//                           (no generation, no stale change); returns mismatches
//   mode 'cleanup'       -> delete every chunk for the training
//   mode 'verify'        -> { unit_count, unit_set_complete, mismatches,
//                             fingerprint } for the engine's verification step
//   mode 'build_staged'  -> full reindex BUT every resulting chunk is
//                           index_stale=true (engine clears them after verify)

const LIFECYCLE_MODES = new Set([
  "mark_stale",
  "clear_stale",
  "restamp",
  "cleanup",
  "verify",
  "build_staged",
]);

async function lifecycleModeOp(base44: any, trainingId: string, mode: string) {
  if (mode === "mark_stale") {
    const changed = await setChunksStale(base44, trainingId, true);
    return { trainingId, mode, marked_stale: changed };
  }
  if (mode === "clear_stale") {
    await setChunksStale(base44, trainingId, false);
    return { trainingId, mode, cleared: await verifyStaleCleared(base44, trainingId) };
  }
  const training = await base44.asServiceRole.entities.Training.get(trainingId).catch(() => null);
  if (!training) return { trainingId, mode, error: "Training not found", status: 404 };
  if (mode === "cleanup") {
    return { trainingId, mode, deleted: await cleanupChunks(base44, trainingId) };
  }
  if (mode === "verify") {
    return { trainingId, mode, ...(await verifyChunks(base44, training)) };
  }
  if (mode === "restamp") {
    return { trainingId, mode, ...(await restampChunks(base44, training)) };
  }
  return { trainingId, mode, error: "unknown lifecycle mode", status: 400 };
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

  // Phase 3: operational facets extracted by analyzeTraining (Phase 1). Each is
  // an optional array; absent/empty on legacy records, so those chunk sets are
  // unchanged. Additive chunk_type values only.
  for (const x of training.exceptions || []) push('exception', x);
  for (const x of training.approvers || []) push('approval', x);
  for (const x of training.escalation_paths || []) push('escalation', x);
  for (const x of training.prerequisites || []) push('required_input', x);
  for (const x of training.prohibited_actions || []) push('prohibited_action', x);
  for (const x of training.verification_checkpoints || []) push('verification', x);
  for (const x of training.roles_involved || []) push('role', x);
  for (const x of training.deadlines || []) push('deadline', x);

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

async function indexOne(base44: any, trainingId: string, leaveStale = false) {
  let stage = 'training_lookup';
  try {
    const training = await base44.asServiceRole.entities.Training.get(trainingId);
    if (!training) return { trainingId, error: 'Training not found', stage, status: 404 };

    stage = 'scope_guard';
    const scope = training.knowledge_scope || 'unclassified';
    if (scope === 'unclassified') {
      // Never retrievable -> make sure no stale chunks linger (e.g. after an
      // admin moves a training back from general/client-specific to unclassified).
      stage = 'stale_cleanup';
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
      return { trainingId, error: 'client-specific training is missing client_id', stage, status: 400 };
    }

    // Phase 3 lifecycle gate: a source that is superseded, rejected, or archived
    // holds NO chunks. Delete any that linger (e.g. it was just archived) and
    // stop. This is the primary enforcement; askKnowledgeBaseV2 also filters at
    // retrieval time as a backstop. (ingestion_quality === 'needs_review' is NOT
    // gated here — it is a retrieval-time flag only, so a later review can make
    // it retrievable without a re-index.)
    stage = 'lifecycle_guard';
    const lifecycleSkip = lifecycleSkipReason(training);
    if (lifecycleSkip) {
      stage = 'lifecycle_cleanup';
      const stale: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
        { training_id: trainingId },
        null,
        5000,
      );
      for (const c of stale) await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
      return {
        trainingId,
        skipped: true,
        reason: `${lifecycleSkip} — no chunks indexed for this source`,
        deleted: stale.length,
      };
    }

    stage = 'fetch_source_text';
    const transcript = await fetchTranscript(training);

    stage = 'build_chunks';
    const drafts = buildDraftChunks(training, transcript);

    stage = 'hash_chunks';
    const desired = await Promise.all(
      drafts.map(async (d, i) => ({
        chunk_index: i,
        chunk_type: d.chunk_type,
        content: d.content,
        content_hash: await contentHash(d.content),
      })),
    );
    const desiredHashes = new Set(desired.map((d) => d.content_hash));

    const scopeFields = buildScopeFields(training);

    // Phase 3: governance metadata denormalized onto every chunk so retrieval
    // reads a last-indexed copy and never a live join. `undefined` = "leave
    // unset" (missing means pass/neutral at retrieval time). Freshness comes
    // from the linked OperationalProcess with a single guarded lookup.
    stage = 'process_lookup';
    let processFreshness = '';
    if (training.operational_process_id) {
      const proc = await base44.asServiceRole.entities.OperationalProcess
        .get(training.operational_process_id).catch(() => null);
      processFreshness = proc?.freshness_status || '';
    }
    const govFields = buildGovFields(training, processFreshness);

    stage = 'load_existing_chunks';
    const existing: any[] = await base44.asServiceRole.entities.KnowledgeChunk.filter(
      { training_id: trainingId },
      null,
      5000,
    );
    const existingByHash = new Map<string, any>();
    for (const c of existing) existingByHash.set(c.content_hash, c);

    const toCreate: any[] = [];
    const toEmbed: string[] = [];
    // Reused chunks that still lack a vector — backfilled if embeddings work now.
    const toBackfill: Array<{ id: string; content: string }> = [];
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

    for (const d of desired) {
      const match = existingByHash.get(d.content_hash);
      if (match) {
        // Re-stamp denormalized fields if they drifted (e.g. after reclassify).
        // Pure helper in shared/governance.ts — exercised by the client-scoping
        // regression test. A blanked client_id is re-stamped, never lost.
        const drift: Record<string, unknown> = scopeFieldsDrift(match, scopeFields, d.chunk_index);
        // Phase 3: re-stamp governance metadata when the source changed (e.g.
        // verified, effective dates edited, process freshness recomputed).
        // `undefined` on our side clears the chunk field (-> null).
        for (const [k, v] of Object.entries(govFields)) {
          const cur = (match as Record<string, unknown>)[k] ?? undefined;
          if (cur !== (v ?? undefined)) drift[k] = v ?? null;
        }
        // Phase 6: a staged build (draft pre-index / cutover) leaves every
        // resulting chunk index_stale=true; a normal reindex clears it.
        if ((match.index_stale === true) !== (leaveStale === true)) {
          drift.index_stale = leaveStale ? true : null;
        }
        if (Object.keys(drift).length) updates.push({ id: match.id, data: drift });
        if (!Array.isArray(match.embedding) || match.embedding.length === 0) {
          toBackfill.push({ id: match.id, content: d.content });
        }
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
        embedding_model: 'lexical-only',
        ...(leaveStale ? { index_stale: true } : {}),
        ...scopeFields,
        ...govFields,
      });
    }

    // Embeddings are OPTIONAL. Attempt them; on ANY failure (missing/invalid
    // key, bad provider, provider outage) create lexical-only chunks and keep
    // going. A later re-index with a working key backfills the vectors.
    let embedded = false;
    let embedError: string | undefined;
    let modelUsed = 'lexical-only';
    const wantEmbed = toEmbed.length + toBackfill.length;
    if (wantEmbed > 0) {
      stage = 'embed';
      try {
        const model = getEmbeddingModelName();
        const inputs = [...toEmbed, ...toBackfill.map((b) => b.content)];
        const vectors = await embed(inputs, 'document');
        if (vectors.length !== inputs.length) {
          throw new Error(`Embedding count mismatch: got ${vectors.length} vectors for ${inputs.length} inputs`);
        }
        for (let i = 0; i < toCreate.length; i++) {
          toCreate[i].embedding = vectors[i];
          toCreate[i].embedding_model = model;
        }
        for (let j = 0; j < toBackfill.length; j++) {
          updates.push({
            id: toBackfill[j].id,
            data: { embedding: vectors[toEmbed.length + j], embedding_model: model },
          });
        }
        embedded = true;
        modelUsed = model;
      } catch (err) {
        embedError = redact((err as Error)?.message ?? String(err)).slice(0, 300);
        console.error(JSON.stringify({
          fn: 'embedKnowledge',
          stage: 'embed',
          trainingId,
          mode: 'lexical-only',
          name: (err as Error)?.name ?? 'Error',
          error: embedError,
        }));
      }
    }

    // One diagnostic line per invocation — no key, no content.
    console.log(JSON.stringify({
      fn: 'embedKnowledge',
      trainingId,
      provider: getEmbeddingProvider(),
      model: modelUsed,
      embedded,
      drafts: drafts.length,
      existing: existing.length,
      new_chunks: toEmbed.length,
      backfilled: embedded ? toBackfill.length : 0,
      restamp: updates.length,
    }));

    // Orphans: existing chunks no longer in the desired set.
    const toDelete = existing.filter((c) => !desiredHashes.has(c.content_hash));

    stage = 'create_chunks';
    let created = 0;
    for (let i = 0; i < toCreate.length; i += BULK_PAGE) {
      const page = toCreate.slice(i, i + BULK_PAGE);
      await base44.asServiceRole.entities.KnowledgeChunk.bulkCreate(page);
      created += page.length;
    }
    stage = 'update_chunks';
    for (const u of updates) {
      await base44.asServiceRole.entities.KnowledgeChunk.update(u.id, u.data);
    }
    stage = 'delete_chunks';
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
      embedded,
      lexical_only: !embedded && desired.length > 0,
      ...(embedError ? { embed_error: embedError } : {}),
    };
  } catch (err) {
    logFailure(stage, trainingId, err);
    const message = redact((err as Error)?.message ?? String(err));
    return { trainingId, error: message, stage, status: statusFor(message) };
  }
}

Deno.serve(async (req) => {
  let stage = 'auth';
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized', stage }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admins only', stage }, { status: 403 });

    stage = 'parse_body';
    const body = await req.json().catch(() => ({}));

    // Phase 6 lifecycle sub-commands. These are the IndexWorker surface the
    // lifecycle engine binding drives — never triggered automatically. The
    // default (no `mode`) path below is unchanged.
    if (body.mode && LIFECYCLE_MODES.has(String(body.mode))) {
      stage = 'lifecycle_mode';
      if (!body.trainingId) {
        return Response.json({ error: 'trainingId is required', stage }, { status: 400 });
      }
      if (String(body.mode) === 'build_staged') {
        const r = await indexOne(base44, String(body.trainingId), true);
        const st = (r as any).status;
        if (st) { const { status: _o, ...rest } = r as any; return Response.json(rest, { status: st }); }
        return Response.json({ ...r, staged: true });
      }
      const r = await lifecycleModeOp(base44, String(body.trainingId), String(body.mode));
      const st = (r as any).status;
      if (st) { const { status: _o, ...rest } = r as any; return Response.json(rest, { status: st }); }
      return Response.json(r);
    }

    if (body.all) {
      // Batch/backfill mode. Only classified, ready trainings. Paginated so the
      // caller drives it explicitly — this is never triggered automatically.
      stage = 'batch_query';
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
      return Response.json({ error: 'trainingId is required', stage }, { status: 400 });
    }
    stage = 'index_one';
    const result = await indexOne(base44, body.trainingId);
    const status = (result as any).status;
    if (status) {
      const { status: _omit, ...rest } = result as any;
      return Response.json(rest, { status });
    }
    return Response.json(result);
  } catch (error) {
    logFailure(stage, undefined, error);
    const message = redact((error as Error)?.message ?? String(error));
    return Response.json(
      { error: message, stage, name: (error as Error)?.name ?? 'Error' },
      { status: statusFor(message) },
    );
  }
});