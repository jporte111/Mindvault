import { base44 } from '@/api/base44Client';

// Phase 6 client helper. The UI speaks ONLY plain-language states/actions; the
// backend engine internals (lifecycle_seq, index_stale, operation ids,
// compensation stages) never surface here — they live in the advanced
// diagnostics view (listKnowledgeSourceHistory with ?diag).

// DisplayState -> { label, tone } for badges. Overridable later via the
// AppConfig vocabulary row; these are the MindVault defaults.
export const STATE_LABELS = {
  draft: { label: 'Draft', tone: 'muted' },
  in_review: { label: 'Ready for review', tone: 'info' },
  changes_requested: { label: 'Changes requested', tone: 'warn' },
  verified: { label: 'Verified', tone: 'info' },
  published: { label: 'Published', tone: 'ok' },
  previous_version: { label: 'Previous version', tone: 'muted' },
  outdated: { label: 'Outdated', tone: 'warn' },
  indexing: { label: 'Indexing', tone: 'info' },
  needs_attention: { label: 'Needs attention', tone: 'error' },
  archived: { label: 'Archived', tone: 'muted' },
  rejected: { label: 'Not approved', tone: 'error' },
};

export const ACTION_LABELS = {
  edit: 'Edit',
  send_for_review: 'Send for review',
  request_changes: 'Request changes',
  approve: 'Approve',
  reject: 'Reject',
  publish: 'Publish',
  archive: 'Archive',
  restore: 'Restore',
  reindex: 'Re-index',
};

// action -> { fn, backendAction } mapping to the two backend functions.
const REVIEW_ACTIONS = {
  send_for_review: 'submit',
  request_changes: 'request_changes',
  approve: 'verify',
  reject: 'reject',
  publish: 'activate',
  archive: 'archive',
  restore: 'restore',
};

export async function runLifecycleAction(action, versionId, extra = {}) {
  if (action === 'reindex') {
    return unwrap(base44.functions.invoke('reindexKnowledgeSource', { versionId }));
  }
  const backendAction = REVIEW_ACTIONS[action];
  if (!backendAction) throw new Error(`unknown lifecycle action: ${action}`);
  return unwrap(base44.functions.invoke('reviewKnowledgeSource', { versionId, action: backendAction, ...extra }));
}

// Content / metadata edit — always routes through updateKnowledgeSource, which
// forks an unverified draft for an active version and never edits served
// content in place. Superficial changes (a rename) and metadata apply in place
// without touching verification. Returns { ok, mode, draftId?, displayState, error? }.
export async function saveKnowledgeEdit(trainingId, patch, changeReason) {
  return unwrap(base44.functions.invoke('updateKnowledgeSource', { trainingId, patch, changeReason }));
}

export function fetchSourceHistory(trainingId) {
  return unwrap(base44.functions.invoke('listKnowledgeSourceHistory', { trainingId }));
}

export function runReconcile() {
  return unwrap(base44.functions.invoke('reconcileSourceLifecycle', {}));
}

// One-click verification: forks an identical draft, prepares it, verifies it,
// and publishes it — the same steps the Knowledge Lifecycle panel runs by hand.
export function verifyKnowledgeSource(trainingId) {
  return unwrap(base44.functions.invoke('verifyKnowledgeSource', { trainingId }));
}

async function unwrap(p) {
  const r = await p;
  return r?.data ?? r;
}