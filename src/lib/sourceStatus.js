// Business-facing status labels for knowledge sources. Purely derived from
// fields the app already stores (processing status, classification, index
// state, verification, archival) — no new data, no scores.

export const SOURCE_STATUSES = {
  processing: { key: 'processing', label: 'Processing', tone: 'amber' },
  review: { key: 'review', label: 'Needs your review', tone: 'blue' },
  available: { key: 'available', label: 'Available to the assistant', tone: 'green' },
  attention: { key: 'attention', label: 'Needs attention', tone: 'red' },
  archived: { key: 'archived', label: 'Archived', tone: 'muted' },
  superseded: { key: 'superseded', label: 'Superseded', tone: 'muted' },
};

// Fixed display order: problems first, then waiting, then healthy.
export const SOURCE_STATUS_ORDER = ['attention', 'review', 'processing', 'available', 'superseded', 'archived'];

/**
 * True only for the current, non-archived version of a knowledge source —
 * the record a user or analysis should actually see. Retired historical
 * versions (is_active_version === false) and archived sources stay reachable
 * from the source detail page's version history, but never appear in the
 * Library or feed content analyses.
 */
export function isCurrentLiveVersion(s) {
  if (!s) return false;
  return !s.is_archived && s.is_active_version !== false;
}

/**
 * Derive one business status for a knowledge source.
 * Returns { key, label, tone, reason, next, canSetAvailability, canRetryIndex, detailHref }
 */
export function sourceStatus(s) {
  if (!s) return null;
  const detailHref = `/training/${s.id}`;

  if (s.is_archived) {
    return {
      ...SOURCE_STATUSES.archived,
      reason: 'Archived — kept for history, not used by the assistant.',
      next: null,
      detailHref,
    };
  }
  if (s.is_active_version === false) {
    return {
      ...SOURCE_STATUSES.superseded,
      reason: 'An older version — it was replaced by a newer one.',
      next: null,
      detailHref,
    };
  }
  if (s.status === 'processing') {
    return {
      ...SOURCE_STATUSES.processing,
      reason: 'MindVault is reading and summarizing this source.',
      next: 'Check back in a few minutes.',
      detailHref,
    };
  }
  if (s.status === 'error') {
    return {
      ...SOURCE_STATUSES.attention,
      reason: 'Processing failed — the contents could not be read.',
      next: 'Open it to check what went wrong, or delete it and add it again.',
      detailHref,
    };
  }
  if (s.verification_status === 'rejected') {
    return {
      ...SOURCE_STATUSES.attention,
      reason: 'Rejected during review — the assistant does not use it.',
      next: 'Open it to fix the content and submit it for review again.',
      detailHref,
    };
  }
  const classified =
    s.knowledge_scope === 'general' || s.knowledge_scope === 'client-specific';
  if (!classified) {
    return {
      ...SOURCE_STATUSES.review,
      reason: 'Choose who can use it — until then the assistant cannot see it.',
      next: 'Pick “Whole company” or a client below, then use Make available.',
      canSetAvailability: true,
      detailHref,
    };
  }
  if (s.ingestion_quality === 'needs_review') {
    return {
      ...SOURCE_STATUSES.review,
      reason: 'The extracted content looked thin — worth a check before relying on it.',
      next: 'Open it to review what was extracted.',
      detailHref,
    };
  }
  if (s.index_status === 'failed') {
    return {
      ...SOURCE_STATUSES.attention,
      reason: 'Preparing it for the assistant failed.',
      next: 'Use Retry to try again.',
      canRetryIndex: true,
      detailHref,
    };
  }
  if (s.index_status === 'pending' || s.index_status === 'indexing') {
    return {
      ...SOURCE_STATUSES.processing,
      reason: 'Being prepared for the assistant after its availability was set.',
      next: 'This usually finishes within a minute or two.',
      detailHref,
    };
  }
  return {
    ...SOURCE_STATUSES.available,
    reason: s.verification_status === 'verified'
      ? 'Used by the assistant, and confirmed accurate by a reviewer.'
      : 'Used by the assistant in answers.',
    next: null,
    verified: s.verification_status === 'verified',
    detailHref,
  };
}