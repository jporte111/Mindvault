import { base44 } from '@/api/base44Client';

// Helpers for classifying a Training's RAG retrieval scope and (re)indexing it.
//
// A training is one of:
//   - "unclassified" (default): never retrieved by the chatbot
//   - "general": deliberately firm-wide knowledge, retrievable in every context
//   - "client-specific": retrievable only in that client's context
//
// The UI represents scope as a single string value:
//   "unclassified" | "general" | "client:<clientId>"

export const SCOPE_UNCLASSIFIED = 'unclassified';
export const SCOPE_GENERAL = 'general';
export const CLIENT_PREFIX = 'client:';

export function scopeValueOf(training) {
  if (!training) return SCOPE_UNCLASSIFIED;
  if (training.knowledge_scope === 'client-specific' && training.client_id) {
    return CLIENT_PREFIX + training.client_id;
  }
  if (training.knowledge_scope === SCOPE_GENERAL) return SCOPE_GENERAL;
  return SCOPE_UNCLASSIFIED;
}

export function isClassified(value) {
  return value === SCOPE_GENERAL || (typeof value === 'string' && value.startsWith(CLIENT_PREFIX));
}

// Turn a UI scope value into the fields stored on a Training record.
export function resolveScopeFields(value, clients = []) {
  if (value === SCOPE_GENERAL) {
    return { knowledge_scope: 'general', client_id: null, client_name: null };
  }
  if (typeof value === 'string' && value.startsWith(CLIENT_PREFIX)) {
    const client_id = value.slice(CLIENT_PREFIX.length);
    const client = clients.find((c) => c.id === client_id);
    return {
      knowledge_scope: 'client-specific',
      client_id,
      client_name: client ? client.name : null,
    };
  }
  return { knowledge_scope: 'unclassified', client_id: null, client_name: null };
}

// Ask the backend to (re)build this training's KnowledgeChunks and RETURN the
// real outcome. embedKnowledge is idempotent and refuses unclassified trainings
// on its own. Phase 6: no longer fire-and-forget — a failed index must be
// visible, not silently swallowed.
export async function reindexTraining(trainingId) {
  try {
    const r = await base44.functions.invoke('embedKnowledge', { trainingId });
    const data = r?.data ?? r;
    return { ok: !data?.error, result: data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Set a training's scope, then reindex (which also clears chunks if the new
// scope is "unclassified"). Returns { fields, index } so the caller can report
// whether indexing actually succeeded.
export async function classifyTraining(trainingId, value, clients = []) {
  const fields = resolveScopeFields(value, clients);
  await base44.entities.Training.update(trainingId, fields);
  const index = await reindexTraining(trainingId);
  return { fields, index };
}
