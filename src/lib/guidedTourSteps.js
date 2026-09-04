// Guided Product Tour — pure, data-driven step definitions. No React, no
// Base44, no driver.js import here: this module only describes WHAT the tour
// says and WHERE it points; src/components/onboarding/GuidedTour.jsx is the
// only place that knows HOW to render/drive it (via driver.js).
//
// Each step is a plain object:
//   id                — unique, stable, kebab-case
//   route              — the page the step belongs to
//   selector           — primary `[data-tour="..."]` CSS selector to highlight
//   fallbackSelector    — used when the primary target has no data yet
//                         (e.g. an empty knowledge library) — optional
//   optional           — true when the control legitimately may not exist in
//                         the current state (e.g. the chat scope selector,
//                         only shown on the RAG engine) — missing here is
//                         normal, not a resilience failure; the tour skips it
//   title / description — the popover copy
//   final              — true on the one step that ends the tour

export const GUIDED_TOUR_SEEN_KEY = 'mv_guided_tour_seen_v1';

// ---------------------------------------------------------------------------
// A. Knowledge Library — /library
// ---------------------------------------------------------------------------
const LIBRARY_STEPS = [
  {
    id: 'library-intro',
    route: '/library',
    selector: '[data-tour="library-page"]',
    title: 'This is your knowledge library',
    description: 'MindVault uses the operational knowledge stored here to help employees understand how work gets done.',
  },
  {
    id: 'library-add-knowledge',
    route: '/library',
    selector: '[data-tour="add-knowledge"]',
    title: 'Add Knowledge',
    description: 'Add SOPs, policies, process documents, recordings and other knowledge your team depends on.',
  },
  {
    id: 'library-search',
    route: '/library',
    selector: '[data-tour="knowledge-search"]',
    title: 'Search',
    description: 'Search across your knowledge library to find a specific procedure, policy or source quickly.',
  },
  {
    id: 'library-filters',
    route: '/library',
    selector: '[data-tour="knowledge-filters"]',
    title: 'Filters / scope',
    description: 'Use filters to narrow the library by source type, status or scope. Firm-wide knowledge can support the whole organization; client-specific knowledge stays isolated to that client.',
  },
  {
    id: 'library-results',
    route: '/library',
    selector: '[data-tour="knowledge-results"]',
    fallbackSelector: '[data-tour="knowledge-empty-state"]',
    title: 'Knowledge source cards',
    description: 'Each source shows the knowledge MindVault can use, along with its governance and classification status. Open a source to review or manage it.',
  },
];

// ---------------------------------------------------------------------------
// B. AI Assistant — /chat
// ---------------------------------------------------------------------------
const CHAT_STEPS = [
  {
    id: 'chat-intro',
    route: '/chat',
    selector: '[data-tour="chat-page"]',
    title: 'AI Assistant',
    description: 'Employees use the AI Assistant to ask how work gets done in plain language.',
  },
  {
    id: 'chat-scope',
    route: '/chat',
    selector: '[data-tour="chat-scope-selector"]',
    optional: true,
    title: 'Scope / client selector',
    description: 'Choose the appropriate firm-wide or client context before asking a question. Client-specific knowledge stays isolated to that client.',
  },
  {
    id: 'chat-input',
    route: '/chat',
    selector: '[data-tour="chat-input"]',
    title: 'Question box',
    description: 'Ask a real operational question here — for example, how to complete a workflow, what approval is required, or what to do when an exception occurs.',
  },
  {
    id: 'chat-results',
    route: '/chat',
    selector: '[data-tour="chat-results"]',
    title: 'Answers and citations',
    description: 'MindVault grounds answers in your organization’s knowledge and shows the supporting sources so employees can verify where the guidance came from.',
  },
];

// ---------------------------------------------------------------------------
// C. Admin — /admin
// ---------------------------------------------------------------------------
const ADMIN_STEPS = [
  {
    id: 'admin-checklist',
    route: '/admin',
    selector: '[data-tour="setup-checklist"]',
    title: 'Setup Checklist',
    description: 'This checklist shows what is already configured and what still needs attention. You can use MindVault before every item is complete.',
  },
  {
    id: 'admin-knowledge-management',
    route: '/admin',
    selector: '[data-tour="knowledge-management"]',
    title: 'Knowledge management',
    description: 'Admins add, classify and manage the operational knowledge MindVault relies on.',
  },
  {
    id: 'admin-operational-processes',
    route: '/admin',
    selector: '[data-tour="operational-processes"]',
    title: 'Operational Processes',
    description: 'Operational processes connect individual knowledge sources to the workflows the business actually depends on. Start with the 3–5 workflows you could least afford to lose.',
  },
  {
    id: 'admin-process-people',
    route: '/admin',
    selector: '[data-tour="process-people"]',
    title: 'Owner / SME / Backup',
    description: 'Assign the process owner and subject-matter expert so MindVault knows who is responsible for the process and its knowledge. Where a true key-person dependency exists, a backup SME improves continuity.',
  },
  {
    id: 'admin-process-criticality-cadence',
    route: '/admin',
    selector: '[data-tour="process-criticality-cadence"]',
    title: 'Criticality and review cadence',
    description: 'Criticality helps prioritize important processes. Review cadence determines how often operational knowledge should be checked to make sure it is still current.',
  },
  {
    id: 'admin-verification',
    route: '/admin',
    selector: '[data-tour="verification"]',
    title: 'Verification',
    description: 'Verification tells employees and leadership whether operational knowledge has been confirmed by the organization rather than simply collected.',
  },
];

// ---------------------------------------------------------------------------
// D. Operational Continuity — /continuity (only when knowledge_health_enabled)
// ---------------------------------------------------------------------------
const CONTINUITY_STEPS = [
  {
    id: 'continuity-overview',
    route: '/continuity',
    selector: '[data-tour="continuity-overview"]',
    title: 'Health overview',
    description: 'This page gives leadership a high-level view of how well critical operational knowledge is documented, governed and protected from continuity risk.',
  },
  {
    id: 'continuity-coverage',
    route: '/continuity',
    selector: '[data-tour="continuity-coverage"]',
    title: 'Coverage',
    description: 'Coverage shows whether important processes have usable operational knowledge behind them.',
  },
  {
    id: 'continuity-review',
    route: '/continuity',
    selector: '[data-tour="continuity-verification"]',
    title: 'Review / verification',
    description: 'Use the review and verification views to find knowledge that is stale, overdue for review or still awaiting confirmation.',
  },
  {
    id: 'continuity-keyperson',
    route: '/continuity',
    selector: '[data-tour="continuity-keyperson"]',
    title: 'Key-person dependency / gaps',
    description: 'MindVault surfaces established dependencies and recurring knowledge gaps so leadership can see where important work may still rely too heavily on one person or undocumented know-how.',
  },
  {
    id: 'continuity-trends',
    route: '/continuity',
    selector: '[data-tour="continuity-trends"]',
    title: "You're ready to use MindVault",
    description: 'Monthly snapshots let leadership see how operational continuity changes over time instead of relying on a one-time picture.',
    secondary: 'You can restart this tour any time from Help.',
    final: true,
  },
];

// The final step when Operational Continuity is disabled — stays on Admin,
// never routes to a disabled/unauthorized page.
const ADMIN_FINISH_STEP_DISABLED = {
  id: 'admin-tour-finish-continuity-disabled',
  route: '/admin',
  selector: '[data-tour="admin-system-settings"]',
  fallbackSelector: '[data-tour="verification"]',
  title: "You're ready to use MindVault",
  description: 'Operational Continuity is currently turned off. You can enable it under Admin → System when you want leadership visibility into coverage, review health and continuity risk.',
  secondary: 'You can restart this tour any time from Help.',
  final: true,
};

/**
 * Builds the ordered step list for the current environment. The Continuity
 * section only appears when the existing knowledge_health_enabled flag is
 * on — this reuses that flag, it never introduces a new one, and it never
 * routes an admin to a disabled/unauthorized page.
 *
 * @param {{knowledgeHealthEnabled?: boolean}} [state]
 * @returns {Array<object>}
 */
export function resolveGuidedTourSteps(state = {}) {
  const base = [...LIBRARY_STEPS, ...CHAT_STEPS, ...ADMIN_STEPS];
  if (state.knowledgeHealthEnabled === true) {
    return [...base, ...CONTINUITY_STEPS];
  }
  return [...base, ADMIN_FINISH_STEP_DISABLED];
}

// Exported for tests / introspection only — not the list a consumer should
// drive from directly (use resolveGuidedTourSteps, which applies the
// Continuity flag).
export const GUIDED_TOUR_ALL_STEPS_ENABLED = resolveGuidedTourSteps({ knowledgeHealthEnabled: true });
export const GUIDED_TOUR_ALL_STEPS_DISABLED = resolveGuidedTourSteps({ knowledgeHealthEnabled: false });
