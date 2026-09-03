// Phase 6. The KnowledgeChunk-side operations the lifecycle engine's IndexWorker
// needs, factored out of embedKnowledge/entry.ts so BOTH that function and the
// lifecycle functions (reviewKnowledgeSource / reindexKnowledgeSource) can use
// one implementation — backend functions cannot import each other's dirs.
//
// These never call the embeddings provider: a staged build writes lexical-only
// chunks (index_stale=true); a later `embedKnowledge { trainingId }` backfills
// vectors. Embeddings stay strictly optional.
//
// Pure chunk-shaping helpers (buildDraftChunks, fetchTranscript) live here too;
// the Base44-touching functions take the client as a parameter.

import { approxTokens, chunkText, contentHash, extractKeywords } from "./text.ts";
import { buildGovFields, buildScopeFields, scopeFieldsDrift } from "./governance.ts";

const CHUNK_TARGET_TOKENS = 600;
const CHUNK_OVERLAP_TOKENS = 90;
const MAX_TRANSCRIPT_CHARS = 60000;

export interface DraftChunk {
  chunk_type: string;
  content: string;
}

export function buildDraftChunks(training: any, transcript: string | null): DraftChunk[] {
  const drafts: DraftChunk[] = [];
  const push = (chunk_type: string, content: unknown) => {
    const text = typeof content === "string" ? content.trim() : "";
    if (text) drafts.push({ chunk_type, content: text });
  };

  push("summary", training.summary);
  for (
    const part of chunkText(training.ai_knowledge_entry || "", {
      targetTokens: CHUNK_TARGET_TOKENS,
      overlapTokens: CHUNK_OVERLAP_TOKENS,
    })
  ) {
    push("ai_knowledge_entry", part);
  }
  for (const t of training.key_takeaways || []) push("key_takeaway", t);
  for (const s of training.sop_steps || []) push("sop_step", s);
  for (const r of training.decision_rules || []) push("decision_rule", r);
  for (const m of training.common_mistakes || []) push("common_mistake", m);

  for (const x of training.exceptions || []) push("exception", x);
  for (const x of training.approvers || []) push("approval", x);
  for (const x of training.escalation_paths || []) push("escalation", x);
  for (const x of training.prerequisites || []) push("required_input", x);
  for (const x of training.prohibited_actions || []) push("prohibited_action", x);
  for (const x of training.verification_checkpoints || []) push("verification", x);
  for (const x of training.roles_involved || []) push("role", x);
  for (const x of training.deadlines || []) push("deadline", x);

  if (transcript) {
    for (
      const part of chunkText(transcript.slice(0, MAX_TRANSCRIPT_CHARS), {
        targetTokens: CHUNK_TARGET_TOKENS,
        overlapTokens: CHUNK_OVERLAP_TOKENS,
      })
    ) {
      push("transcript", part);
    }
  }
  return drafts;
}

export async function fetchTranscript(training: any): Promise<string | null> {
  const ref = training.transcript;
  if (!ref || typeof ref !== "string") return null;
  if (!ref.startsWith("http")) return ref.trim() || null;
  try {
    const res = await fetch(ref);
    if (!res.ok) return null;
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.length < 20 || trimmed.startsWith("<")) return null;
    return trimmed;
  } catch (_) {
    return null;
  }
}

export async function loadChunks(base44: any, trainingId: string): Promise<any[]> {
  return await base44.asServiceRole.entities.KnowledgeChunk.filter(
    { training_id: trainingId },
    null,
    5000,
  );
}

/** Set / clear index_stale on every chunk of a training. Returns how many rows
 *  actually changed. This is the fail-closed retrieval gate. */
export async function setChunksStale(
  base44: any,
  trainingId: string,
  value: boolean,
): Promise<number> {
  const chunks = await loadChunks(base44, trainingId);
  let changed = 0;
  for (const c of chunks) {
    if ((c.index_stale === true) !== (value === true)) {
      await base44.asServiceRole.entities.KnowledgeChunk.update(c.id, {
        index_stale: value ? true : null,
      });
      changed++;
    }
  }
  return changed;
}

export async function verifyStaleCleared(base44: any, trainingId: string): Promise<boolean> {
  const chunks = await loadChunks(base44, trainingId);
  return chunks.every((c) => c.index_stale !== true);
}

interface Desired {
  desired: Array<{ chunk_index: number; chunk_type: string; content: string; content_hash: string }>;
  fingerprint: string;
  scopeFields: ReturnType<typeof buildScopeFields>;
  govFields: Record<string, unknown>;
}

/** Desired chunk set + denormalized field targets, without writing anything. */
export async function computeDesired(base44: any, training: any): Promise<Desired> {
  const transcript = await fetchTranscript(training);
  const drafts = buildDraftChunks(training, transcript);
  const desired = await Promise.all(
    drafts.map(async (d, i) => ({
      chunk_index: i,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: await contentHash(d.content),
    })),
  );
  const fingerprint = await contentHash(desired.map((d) => d.content_hash).join("|"));
  const scopeFields = buildScopeFields(training);
  let processFreshness = "";
  if (training.operational_process_id) {
    const proc = await base44.asServiceRole.entities.OperationalProcess
      .get(training.operational_process_id).catch(() => null);
    processFreshness = proc?.freshness_status || "";
  }
  const govFields = buildGovFields(training, processFreshness);
  return { desired, fingerprint, scopeFields, govFields };
}

export function projectionMismatchFields(
  chunk: any,
  scopeFields: Record<string, unknown>,
  govFields: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const norm = (v: unknown) => (v === undefined || v === null || v === "" ? "" : String(v));
  const check = (k: string, want: unknown) => {
    if (norm((chunk as Record<string, unknown>)[k]) !== norm(want ?? undefined)) out.push(k);
  };
  for (const [k, v] of Object.entries(scopeFields)) check(k, v);
  for (const [k, v] of Object.entries(govFields)) check(k, v);
  return out;
}

/** Restamp denormalized metadata on existing chunks (no generation). Returns the
 *  residual mismatches after restamping (should be []). */
export async function restampChunks(base44: any, training: any) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const existing = await loadChunks(base44, training.id);
  let restamped = 0;
  for (const c of existing) {
    const patch: Record<string, unknown> = scopeFieldsDrift(c, scopeFields, c.chunk_index);
    for (const [k, v] of Object.entries(govFields)) {
      const cur = (c as Record<string, unknown>)[k] ?? undefined;
      if (cur !== (v ?? undefined)) patch[k] = v ?? null;
    }
    if (Object.keys(patch).length) {
      await base44.asServiceRole.entities.KnowledgeChunk.update(c.id, patch);
      restamped++;
    }
  }
  const after = await loadChunks(base44, training.id);
  const mismatches = after
    .map((c) => ({ id: c.id, fields: projectionMismatchFields(c, scopeFields, govFields) }))
    .filter((m) => m.fields.length);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const unit_set_complete = desired.every((d) => after.some((c) => c.content_hash === d.content_hash)) &&
    after.every((c) => desiredHashes.has(c.content_hash));
  return { restamped, mismatches, fingerprint, unit_count: after.length, unit_set_complete };
}

export async function cleanupChunks(base44: any, trainingId: string): Promise<number> {
  const chunks = await loadChunks(base44, trainingId);
  for (const c of chunks) await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
  return chunks.length;
}

export async function verifyChunks(base44: any, training: any) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const existing = await loadChunks(base44, training.id);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const existingHashes = new Set(existing.map((c) => c.content_hash));
  const unit_set_complete = desired.every((d) => existingHashes.has(d.content_hash)) &&
    existing.every((c) => desiredHashes.has(c.content_hash));
  const mismatches = existing
    .map((c) => ({ id: c.id, fields: projectionMismatchFields(c, scopeFields, govFields) }))
    .filter((m) => m.fields.length);
  return { unit_count: existing.length, unit_set_complete, mismatches, fingerprint };
}

/**
 * Staged (re)build: converge the chunk set to `desired`, leaving EVERY resulting
 * chunk index_stale=true. Lexical-only (no embeddings) — a later
 * `embedKnowledge { trainingId }` backfills vectors. The engine clears stale
 * only after its verification step.
 */
export async function stagedBuild(base44: any, training: any) {
  const { desired, fingerprint, scopeFields, govFields } = await computeDesired(base44, training);
  const desiredHashes = new Set(desired.map((d) => d.content_hash));
  const existing = await loadChunks(base44, training.id);
  const existingByHash = new Map<string, any>();
  for (const c of existing) existingByHash.set(c.content_hash, c);

  let created = 0;
  for (const d of desired) {
    const match = existingByHash.get(d.content_hash);
    if (match) {
      const patch: Record<string, unknown> = scopeFieldsDrift(match, scopeFields, d.chunk_index);
      for (const [k, v] of Object.entries(govFields)) {
        const cur = (match as Record<string, unknown>)[k] ?? undefined;
        if (cur !== (v ?? undefined)) patch[k] = v ?? null;
      }
      if (match.index_stale !== true) patch.index_stale = true;
      if (Object.keys(patch).length) {
        await base44.asServiceRole.entities.KnowledgeChunk.update(match.id, patch);
      }
      continue;
    }
    await base44.asServiceRole.entities.KnowledgeChunk.create({
      training_id: training.id,
      chunk_index: d.chunk_index,
      chunk_type: d.chunk_type,
      content: d.content,
      content_hash: d.content_hash,
      token_count: approxTokens(d.content),
      keywords: extractKeywords(d.content),
      embedding_model: "lexical-only",
      index_stale: true,
      ...scopeFields,
      ...govFields,
    });
    created++;
  }
  for (const c of existing) {
    if (!desiredHashes.has(c.content_hash)) {
      await base44.asServiceRole.entities.KnowledgeChunk.delete(c.id);
    }
  }
  return { created, total: desired.length, fingerprint };
}
