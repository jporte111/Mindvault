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

// Fire-and-forget: ask the backend to (re)build this training's KnowledgeChunks.
// embedKnowledge is idempotent and refuses unclassified trainings on its own.
export function reindexTraining(trainingId) {
  return base44.functions
    .invoke('embedKnowledge', { trainingId })
    .catch((err) => {
      // Non-fatal: indexing can be retried from the Admin panel.
      console.warn('embedKnowledge failed for', trainingId, err?.message || err);
    });
}

// Set a training's scope, then reindex (which also clears chunks if the new
// scope is "unclassified").
export async function classifyTraining(trainingId, value, clients = []) {
  const fields = resolveScopeFields(value, clients);
  await base44.entities.Training.update(trainingId, fields);
  await reindexTraining(trainingId);
  return fields;
}
