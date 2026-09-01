// OperationalProcess vocabulary + helpers for the admin UI.
//
// CANONICAL enum values live in base44/entities/OperationalProcess.jsonc.
// scripts/rag-eval/operational-process.test.mjs asserts this file stays in sync.
//
// The scope-value constants below mirror src/lib/knowledgeScope.js. They are
// inlined (not imported) so this module has no dependencies and can be unit
// tested directly under `node --test`.

export const SCOPE_UNCLASSIFIED = 'unclassified';
export const SCOPE_GENERAL = 'general';
export const CLIENT_PREFIX = 'client:';

export const PROCESS_CRITICALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'mission_critical', label: 'Mission critical' },
];

export const CRITICALITY_LABEL = Object.fromEntries(
  PROCESS_CRITICALITY_OPTIONS.map((o) => [o.value, o.label]),
);

// Suggested cadences; a custom value is also allowed.
export const REVIEW_INTERVAL_OPTIONS = [7, 30, 60, 90, 180, 365];

// Freshness is computed by a later phase. Missing = "unreviewed".
export const PROCESS_FRESHNESS_VALUES = ['unreviewed', 'current', 'due_soon', 'stale', 'review_requested'];

export function processFreshness(process) {
  return process?.freshness_status || 'unreviewed';
}

// UI scope value, mirroring knowledgeScope.js:
//   "unclassified" | "general" | "client:<clientId>"
export function processScopeValue(process) {
  if (!process) return SCOPE_UNCLASSIFIED;
  if (process.knowledge_scope === 'client-specific' && process.client_id) {
    return CLIENT_PREFIX + process.client_id;
  }
  if (process.knowledge_scope === SCOPE_GENERAL) return SCOPE_GENERAL;
  return SCOPE_UNCLASSIFIED;
}

// A knowledge source may only link to a process with a compatible scope:
//   unclassified source     -> unclassified process only
//   general source          -> general process only
//   client-specific source  -> client-specific process with the SAME client_id
// Missing knowledge_scope is treated as 'unclassified' on both sides.
export function isProcessScopeCompatible(source, process) {
  const s = source?.knowledge_scope || 'unclassified';
  const p = process?.knowledge_scope || 'unclassified';
  if (s !== p) return false;
  if (s === 'client-specific') {
    return Boolean(source?.client_id) && source.client_id === process?.client_id;
  }
  return true;
}

// Turn a UI scope value into the fields stored on an OperationalProcess.
// (No client_name — the entity does not carry one.)
export function resolveProcessScopeFields(value) {
  if (value === SCOPE_GENERAL) {
    return { knowledge_scope: 'general', client_id: null };
  }
  if (typeof value === 'string' && value.startsWith(CLIENT_PREFIX)) {
    return { knowledge_scope: 'client-specific', client_id: value.slice(CLIENT_PREFIX.length) };
  }
  return { knowledge_scope: 'unclassified', client_id: null };
}
