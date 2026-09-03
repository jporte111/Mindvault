import { base44 } from '@/api/base44Client';

// Phase 7 client helper. The dashboard shows ONLY plain-language states/actions;
// no engine internals ever surface here.

export function fetchKnowledgeHealth(scope) {
  const body = scope && scope !== 'general' ? { scope: { clientId: scope } } : {};
  return base44.functions.invoke('computeKnowledgeHealth', body).then((r) => r?.data ?? r);
}

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
