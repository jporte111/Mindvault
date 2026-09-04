import { base44 } from '@/api/base44Client';

// Phase 7 client helper. The dashboard shows ONLY plain-language states/actions;
// no engine internals ever surface here.

export function fetchKnowledgeHealth(scope) {
  const body = scope && scope !== 'general' ? { scope: { clientId: scope } } : {};
  return base44.functions.invoke('computeKnowledgeHealth', body).then((r) => r?.data ?? r);
}

// Phase 9 P9-1 — admin "Capture snapshot now" (write mode). The backend refuses
// the write unless knowledge_health_snapshots_enabled is true.
export function captureKnowledgeHealthSnapshot(dryRun = false) {
  return base44.functions
    .invoke('captureKnowledgeHealthSnapshot', { dryRun })
    .then((r) => r?.data ?? r);
}

// Phase 9 P9-2 — bounded (<=12) read-only history for the multi-period trend
// panel. Exact-scope; never merges clients.
export function fetchKnowledgeHealthTrendHistory(scope, limit = 12) {
  const body = scope && scope !== 'general'
    ? { scope: { clientId: scope }, limit }
    : { limit };
  return base44.functions
    .invoke('listKnowledgeHealthSnapshots', body)
    .then((r) => r?.data ?? r);
}

// Phase 9 P9-2 — plain-language labels for the trend-series keys the backend returns.
export const TREND_SERIES_LABELS = {
  processes_at_risk: 'Processes at risk',
  reviews_overdue: 'Overdue reviews',
  active_not_verified: 'Active not verified',
  gaps_open: 'Open gaps',
  key_person_high_or_critical: 'Key-person high/critical',
  sources_needing_attention: 'Sources needing attention',
  processes_without_owner_or_sme: 'Processes without owner/SME',
  sources_needing_cadence: 'Sources without a review schedule',
};

// Phase 9 P9-2 — governance completeness cell status -> tone.
export const GOV_STATUS_TONE = {
  present: 'ok',
  needs_attention: 'warn',
  unknown: 'muted',
  missing: 'error',
};

// trend direction -> tone
export const TREND_TONE = {
  improving: 'ok',
  stable: 'muted',
  deteriorating: 'error',
  unknown: 'muted',
};

// Phase 9 P9-1 — which trend dimensions the Overview "Since ..." strip shows,
// in display order, with plain-language labels. Bands + the derived coverage
// ratio + the leadership-facing counts. Deterministic; no score.
export const TREND_STRIP_DIMENSIONS = [
  { key: 'critical_coverage_ratio', label: 'Critical process coverage', kind: 'ratio' },
  { key: 'coverage_band', label: 'Coverage band', kind: 'band' },
  { key: 'currency_band', label: 'Currency band', kind: 'band' },
  { key: 'verification_band', label: 'Verification band', kind: 'band' },
  { key: 'key_person_resilience_band', label: 'Key-person resilience', kind: 'band' },
  { key: 'processes_at_risk', label: 'Processes at risk', kind: 'count' },
  { key: 'reviews_overdue', label: 'Overdue reviews', kind: 'count' },
  { key: 'active_not_verified', label: 'Active knowledge not yet verified', kind: 'count' },
  { key: 'gaps_open', label: 'Open knowledge gaps', kind: 'count' },
  { key: 'key_person_high_or_critical', label: 'Key-person dependencies', kind: 'count' },
  { key: 'sources_needing_attention', label: 'Sources needing attention', kind: 'count' },
  { key: 'processes_without_owner_or_sme', label: 'Processes without owner/SME', kind: 'count' },
];

// tone -> tailwind classes for badges / band pills
export const TONE = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  info: 'bg-sky-100 text-sky-700 border-sky-200',
  warn: 'bg-amber-100 text-amber-700 border-amber-200',
  error: 'bg-red-100 text-red-700 border-red-200',
  muted: 'text-muted-foreground border-border',
};

export const COVERAGE_TONE = {
  documented_verified: 'ok',
  documented_unverified: 'info',
  needs_attention: 'error',
  unknown: 'warn',
  not_documented: 'error',
};
export const CONTINUITY_TONE = {
  ready: 'ok',
  needs_setup: 'warn',
  at_risk: 'error',
  not_documented: 'error',
};
export const KEYPERSON_TONE = {
  none: 'muted', informational: 'info', elevated: 'warn', high: 'error', critical: 'error', unknown: 'muted',
};
export const BAND_TONE = {
  Strong: 'ok', Partial: 'warn', Weak: 'error',
  Current: 'ok', Slipping: 'warn', Overdue: 'error',
  Confirmed: 'ok', 'Mostly confirmed': 'warn', 'Review backlog': 'error',
  Resilient: 'ok', Watch: 'warn', Exposed: 'error',
  Unknown: 'muted',
};
