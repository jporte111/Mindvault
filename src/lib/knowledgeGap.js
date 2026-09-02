// Phase 5 client-side vocabulary + labels. Dependency-free (mirrors
// src/lib/operationalProcess.js) so it can be imported anywhere.

export const FEEDBACK_TYPES = [
  { value: 'didnt_answer', label: "Didn't answer my question" },
  { value: 'missing_detail', label: 'Missing a detail' },
  { value: 'incorrect_or_outdated', label: 'Looks incorrect or outdated' },
  { value: 'still_need_help', label: 'I still need help' },
];

export const GAP_STATUS_LABEL = {
  candidate: 'Candidate',
  open: 'Open',
  under_review: 'Under review',
  resolved: 'Resolved',
  not_applicable: 'Not applicable',
};

export const GAP_STATUS_TABS = ['open', 'candidate', 'under_review', 'resolved', 'not_applicable'];

export const RESOLUTION_TYPES = [
  { value: 'source_updated', label: 'Existing source updated (verified)', needsSource: true },
  { value: 'new_source_added', label: 'New source added (verified)', needsSource: true },
  { value: 'clarified_no_change', label: 'Clarified — no source change', needsSource: false },
  { value: 'duplicate', label: 'Duplicate of another gap', needsSource: false },
  { value: 'not_applicable', label: 'Not applicable / out of scope', needsSource: false },
  { value: 'deferred', label: 'Real but deferred', needsSource: false },
];

export const GAP_PRIORITIES = ['low', 'medium', 'high'];

export const GAP_ORIGIN_LABEL = {
  explicit_feedback: 'Employee feedback',
  answer_status_partial: 'Partial answer',
  answer_status_insufficient: 'Insufficient answer',
  clarification: 'Clarification',
  manual: 'Manual',
};

export function scopeLabel(clientScope, clients = []) {
  if (!clientScope || clientScope === 'general') return 'General';
  if (clientScope.startsWith('client:')) {
    const id = clientScope.slice('client:'.length);
    const c = clients.find((x) => x.id === id);
    return c ? `Client: ${c.name}` : 'Client (unknown)';
  }
  return clientScope;
}
