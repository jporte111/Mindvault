// Structured runtime support context for MindVault Help.
//
// Assembles the read-only situational data the Help assistant reasons over
// BEFORE answering: the current route/page/section, the caller's app-level
// role, their workspace name, onboarding progress and current step, the last
// UI action, the most recent relevant application error, and a few live
// counts. It never carries security-sensitive data (no tenant_id, no tokens,
// no membership rows, no stack traces, no raw server payloads) — the tenant
// is authoritative server-side and the assistant only needs its display
// name and the caller's role.

// ---------------------------------------------------------------------------
// Recent application error / action — a tiny in-memory ring of the last few
// events, so the Help panel can troubleshoot the actual failure the user
// just hit even before they describe it. Session-only, never persisted,
// never sent anywhere (the whole Help assistant is client-side).
// ---------------------------------------------------------------------------

const RECENT_ERROR_TTL_MS = 90_000; // "recent" = the last minute and a half
const RECENT_ACTION_TTL_MS = 45_000;

let recentError = null; // { action, page, section, message, code, at }
let recentAction = null; // { action, page, section, at }

const SENSITIVE_KEY = /token|secret|authorization|auth[_-]?header|cookie|password|api[_-]?key|tenant_id|stack|\bsql\b/i;

// Only a short, human-readable message ever reaches the assistant — no stack
// trace, no payload, no headers. Long strings are truncated.
function safeMessage(raw) {
  let m = typeof raw === 'string' ? raw : (raw && raw.message) || '';
  m = String(m).split('\n')[0].trim();
  if (SENSITIVE_KEY.test(m)) return 'A system error occurred.';
  return m.length > 240 ? `${m.slice(0, 237)}…` : m;
}

/**
 * Record the most recent relevant application error, from a guarded
 * frontend action's catch block. Example:
 *   recordAppError({
 *     action: 'update company details',
 *     page: 'Getting Started', section: 'Company details',
 *     error: e, code: e?.response?.status,
 *   });
 *
 * @param {{ action?: string, page?: string, section?: string, error?: any, code?: any }} [o]
 */
export function recordAppError(o = {}) {
  const { action, page, section, error, code } = o;
  recentError = {
    action: action ? String(action).slice(0, 80) : null,
    page: page ? String(page).slice(0, 60) : null,
    section: section ? String(section).slice(0, 60) : null,
    message: safeMessage(error),
    code: code == null ? null : String(code).slice(0, 12),
    at: Date.now(),
  };
}

/**
 * Record a benign recent UI action (a successful/attempted operation).
 * @param {{ action?: string, page?: string, section?: string }} [o]
 */
export function recordAppAction(o = {}) {
  const { action, page, section } = o;
  recentAction = {
    action: action ? String(action).slice(0, 80) : null,
    page: page ? String(page).slice(0, 60) : null,
    section: section ? String(section).slice(0, 60) : null,
    at: Date.now(),
  };
}

/** Clears the recent error — call after it has been resolved / retried OK. */
export function clearRecentAppError() {
  recentError = null;
}

export function getRecentAppError() {
  if (!recentError) return null;
  if (Date.now() - recentError.at > RECENT_ERROR_TTL_MS) {
    recentError = null;
    return null;
  }
  return recentError;
}

export function getRecentAppAction() {
  if (!recentAction) return null;
  if (Date.now() - recentAction.at > RECENT_ACTION_TTL_MS) {
    recentAction = null;
    return null;
  }
  return recentAction;
}

// Test-only reset so unit tests start from a clean ring.
export function __resetSupportContextForTests() {
  recentError = null;
  recentAction = null;
}

// ---------------------------------------------------------------------------
// Route -> page/section labels, using the CURRENT Client Admin navigation.
// ---------------------------------------------------------------------------

const ROUTE_PAGES = {
  '/': { page: 'Home' },
  '/setup': { page: 'Getting Started' },
  '/manage': { page: 'Manage' },
  '/team': { page: 'Team' },
  '/processes': { page: 'Processes' },
  '/library': { page: 'Knowledge' },
  '/chat': { page: 'AI Assistant' },
  '/continuity': { page: 'Operational Continuity' },
  '/admin': { page: 'Settings' },
};

// A hash on /setup or /manage names the card the user is looking at.
const HASH_SECTIONS = {
  'company-details': 'Company details',
  'invite-team': 'Invite your team',
  'manage-knowledge': 'Add knowledge',
  'add-process': 'Processes',
};

export function pageForRoute(route) {
  const base = String(route || '').split('#')[0].split('?')[0];
  if (ROUTE_PAGES[base]) return ROUTE_PAGES[base].page;
  if (base.startsWith('/training/')) return 'Knowledge source';
  return null;
}

export function sectionForRoute(route) {
  const hash = String(route || '').split('#')[1];
  return hash && HASH_SECTIONS[hash] ? HASH_SECTIONS[hash] : null;
}

// ---------------------------------------------------------------------------
// Assemble the structured object the assistant consumes.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   route?: string,
 *   userRole?: 'super_admin'|'client_admin'|'client_user'|null,
 *   tenantName?: string,
 *   setup?: { progressPct?: number, setupComplete?: boolean, nextItem?: object|null,
 *            counts?: object, items?: object[] } | null,
 * }} input
 * @returns {object} the runtime support context (no security-sensitive fields)
 */
export function buildSupportContext(input = {}) {
  const route = input.route || null;
  const setup = input.setup || null;
  const recentErr = getRecentAppError();
  const recentAct = getRecentAppAction();

  const currentSetupStep =
    setup && setup.nextItem
      ? { id: setup.nextItem.id || null, label: setup.nextItem.label || null }
      : null;

  return {
    currentRoute: route,
    currentPage: pageForRoute(route),
    currentSection: sectionForRoute(route),
    currentUserRole: input.userRole || null,
    tenantName: input.tenantName || null,
    onboardingProgress: setup ? (setup.progressPct ?? null) : null,
    setupComplete: setup ? !!setup.setupComplete : null,
    currentSetupStep,
    recentAction: recentAct
      ? { action: recentAct.action, page: recentAct.page, section: recentAct.section }
      : null,
    recentError: recentErr
      ? {
          action: recentErr.action,
          page: recentErr.page,
          section: recentErr.section,
          message: recentErr.message,
          code: recentErr.code,
          ageMs: Date.now() - recentErr.at,
        }
      : null,
    recentErrorCode: recentErr ? recentErr.code : null,
    counts: (setup && setup.counts) || null,
  };
}
