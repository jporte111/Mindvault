// Onboarding-2 — pure step data for the admin walkthrough (max 6 steps), plus
// the one piece of step logic that depends on live state: whether Step 5's
// action can safely send an admin to /continuity. No React, no Base44 SDK,
// no localStorage — those live in the Walkthrough component.

export const WALKTHROUGH_SEEN_KEY = 'mv_onboarding_seen';

export const WALKTHROUGH_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to MindVault',
    copy:
      'MindVault turns your team’s know-how into answers employees can trust — and gives leadership a clear view of where operational knowledge is at risk.',
    secondary: 'This tour takes about a minute. You can skip it and reopen it any time from Help.',
    actionLabel: null,
    actionHref: null,
  },
  {
    id: 'knowledge',
    title: 'Your knowledge library',
    copy:
      'SOPs, process docs, policies, recordings and other operational knowledge live here. Each source can be firm-wide or client-specific.',
    secondary: null,
    actionLabel: 'Open Knowledge',
    actionHref: '/library',
  },
  {
    id: 'assistant',
    title: 'Ask how work gets done',
    copy:
      'Employees ask questions in plain language and get answers grounded in your company’s knowledge, with sources cited.',
    secondary: null,
    actionLabel: 'Open AI Assistant',
    actionHref: '/chat',
  },
  {
    id: 'admin',
    title: 'Keep operations governed',
    copy:
      'Admins classify knowledge, define operational processes, assign owners and subject-matter experts, set criticality and review cadence, and manage verification.',
    secondary: null,
    actionLabel: 'Open Admin',
    actionHref: '/admin',
  },
  {
    id: 'continuity',
    title: 'See where the business is exposed',
    copy:
      'Operational Continuity shows where important work depends on stale or missing knowledge, unclear ownership, or established key-person dependencies.',
    secondary: 'Monthly snapshots and What changed help leadership see whether those risks are improving over time.',
    actionLabel: 'Open Operational Continuity',
    actionHref: '/continuity',
  },
  {
    id: 'checklist',
    title: 'Start with the setup checklist',
    copy: 'The checklist at the top of Admin shows what is configured, what still needs attention, and what to do next.',
    secondary: 'You do not need to finish it before using MindVault.',
    actionLabel: 'Open Admin',
    actionHref: '/admin',
  },
];

/**
 * Step 5 ("continuity") is the only step whose action depends on live state:
 * the Operational Continuity dashboard is behind its own existing feature
 * flag (reused here, never re-implemented or duplicated), and an admin must
 * never be routed to a disabled/unauthorized page. Every other step's action
 * is fixed and returned as-is.
 *
 * @param {{id:string,actionLabel:string|null,actionHref:string|null}} step
 * @param {{knowledgeHealthEnabled?: boolean}} [state]
 * @returns {{label:string|null,href:string|null,disabledNote:string|null}}
 */
export function resolveStepAction(step, state = {}) {
  if (!step) return { label: null, href: null, disabledNote: null };
  if (step.id === 'continuity' && state.knowledgeHealthEnabled !== true) {
    return {
      label: 'Open Admin',
      href: '/admin',
      disabledNote: 'Enable Operational Continuity under Admin → System.',
    };
  }
  return { label: step.actionLabel, href: step.actionHref, disabledNote: null };
}
