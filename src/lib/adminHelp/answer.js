// Admin Help Assistant — deterministic answer composition from the curated
// corpus. No LLM call, no network, no customer data. If the corpus doesn't
// support an answer, this says so — it never invents where a control lives
// or what a feature does.

import { ADMIN_HELP_TOPICS } from './corpus.js';
import { retrieveTopics } from './retrieval.js';
import { isPageRelativeIntent } from './routeContext.js';
import { answerSupportQuestion } from './support.js';

// Every navigation target this assistant can ever suggest. Defense in depth
// on top of the fact that the corpus is static, curated, and bundled with
// the app: even a future corpus edit cannot point the assistant at an
// arbitrary route, because buildNavigation() drops anything not in here.
export const NAV_ROUTE_ALLOWLIST = ['/', '/library', '/chat', '/admin', '/continuity', '/setup', '/team', '/manage', '/processes'];

// ---------------------------------------------------------------------------
// Contextual setup copilot — deterministic composition from the live setup
// state (see useClientSetup). Like the corpus path, it never invents
// controls or routes: everything it says comes from the derived checklist.
// ---------------------------------------------------------------------------

const SETUP_SOURCE = [{ id: 'setup', title: 'Setup checklist' }];

const SETUP_NEXT_STEP_PATTERNS = [
  /\bwhat should i do next\b/,
  /\bwhat(?:'s| is) next\b/,
  /\bnext step\b/,
  /\bwhere do i start\b/,
  /\bwhat should i (do|start with|set up) first\b/,
];

// Setup-guidance navigation is allowlisted the same way corpus navigation is.
function setupNav(label, route) {
  const base = String(route || '').split('#')[0];
  if (!NAV_ROUTE_ALLOWLIST.includes(base)) return null;
  return { label, route, topic: 'setup' };
}

function setupNextStepAnswer(setup) {
  if (setup.setupComplete) {
    return {
      answer:
        "You've completed the core setup — nice work.\n\nOptional next steps whenever you have time:\n• Add more knowledge — every SOP or policy makes answers richer\n• Invite the rest of your team\n• Review your processes so your knowledge stays organized",
      sources: SETUP_SOURCE,
      navigation: [setupNav('Add knowledge', '/manage#manage-knowledge')].filter(Boolean),
    };
  }
  const next = setup.nextItem;
  if (!next) {
    return {
      answer: 'Your setup checklist looks complete — nothing left to do right now.',
      sources: SETUP_SOURCE,
      navigation: [],
    };
  }
  return {
    answer: `Here's what's next: ${next.label}.\n\n${next.why}\n\nWhat to do: ${next.how}\n\nYou're done when: ${next.doneWhen}`,
    sources: SETUP_SOURCE,
    navigation: [setupNav(next.actionLabel, next.actionHref)].filter(Boolean),
  };
}

// Page guidance answers "what do I do here?" using the live state of THIS
// tenant (counts from the derived setup data), not a generic definition.
// Returns null for routes without tailored guidance — the caller falls
// back to the corpus retrieval path.
function pageGuidanceAnswer(setup, route) {
  const c = setup.counts || {};
  switch (route) {
    case '/library': {
      const lines = ["This is your Knowledge page — where you add and browse the information MindVault uses to answer your team's questions."];
      if (c.knowledge === 0) {
        lines.push("You currently have no knowledge sources. I recommend starting with one SOP or recurring process document — click 'Add Knowledge' and upload it as company-wide knowledge.");
      } else if (c.knowledge != null) {
        lines.push(`You currently have ${c.knowledge} knowledge source${c.knowledge === 1 ? '' : 's'}. If any of them are still marked as not available to the team, choose who can see each one on the Add knowledge page.`);
      }
      return {
        answer: lines.join('\n\n'),
        sources: SETUP_SOURCE,
        navigation: [setupNav('Add knowledge', '/manage#manage-knowledge')].filter(Boolean),
      };
    }
    case '/processes': {
      const lines = ['This is where you describe how your organization works — one recurring workflow at a time. Processes group related knowledge so it stays organized and gets reviewed on time.'];
      if (c.processes === 0) {
        lines.push("You haven't described a process yet. I recommend starting with one recurring workflow — for example, monthly invoicing.");
      } else if (c.processes != null) {
        lines.push(`You currently have ${c.processes} process${c.processes === 1 ? '' : 'es'} described.`);
      }
      return { answer: lines.join('\n\n'), sources: SETUP_SOURCE, navigation: [] };
    }
    case '/team': {
      const lines = ['This is your Team page — where you invite colleagues and decide who manages settings (Client Admin) and who uses MindVault day to day (Client User).'];
      if (c.members != null) {
        lines.push(`You currently have ${c.members} team member${c.members === 1 ? '' : 's'}${c.members <= 1 ? ' — inviting a teammate is one of your setup steps' : ''}.`);
      }
      return { answer: lines.join('\n\n'), sources: SETUP_SOURCE, navigation: [] };
    }
    case '/chat': {
      const lines = ['This is the AI Assistant — the page your team uses to ask questions. It answers only from your approved knowledge and shows the source behind every answer.'];
      if (c.knowledge === 0) {
        lines.push("You have no knowledge yet, so the assistant can't answer anything — add a source first, then come back and test it with a real question.");
      }
      return {
        answer: lines.join('\n\n'),
        sources: SETUP_SOURCE,
        navigation: [setupNav('Add knowledge', '/manage#manage-knowledge')].filter(Boolean),
      };
    }
    case '/manage': {
      const lines = [
        "This is where you add knowledge sources — SOPs, policies, handbooks, process documents. MindVault reads each one so the assistant can answer from it.",
        'Each upload asks who can use it: everyone in your company, or only when working on a specific client.',
      ];
      return { answer: lines.join('\n\n'), sources: SETUP_SOURCE, navigation: [] };
    }
    case '/setup':
    case '/': {
      const next = setup.nextItem;
      const lines = [`You're ${setup.progressPct}% through setup.`];
      if (next) {
        lines.push(`Next: ${next.label}. ${next.how}`);
      } else {
        lines.push('Your setup checklist is complete.');
      }
      return {
        answer: lines.join('\n\n'),
        sources: SETUP_SOURCE,
        navigation: next ? [setupNav(next.actionLabel, next.actionHref)].filter(Boolean) : [],
      };
    }
    default:
      return null;
  }
}

export const INSUFFICIENT_HELP_MESSAGE =
  'I don’t have enough product documentation to answer that reliably. Try rephrasing, or ask about a specific screen or concept — for example Operational Processes, Verification, or Operational Continuity.';

function buildNavigation(topicEntry) {
  return (topicEntry.navigation || [])
    .filter((n) => NAV_ROUTE_ALLOWLIST.includes(n.route))
    .map((n) => ({ label: n.label, route: n.route, topic: n.topic || topicEntry.id }));
}

function paragraphsFor(topicEntry) {
  const parts = [topicEntry.summary];
  if (topicEntry.whatItIs && topicEntry.whatItIs !== topicEntry.summary) {
    parts.push(topicEntry.whatItIs);
  }
  if (topicEntry.howToUse) parts.push(topicEntry.howToUse);
  return parts.filter(Boolean);
}

/**
 * Composes a deterministic answer from the curated corpus for a free-text
 * admin question. Never calls an LLM, never touches customer knowledge.
 *
 * @param {string} question
 * @param {{route?: string, topic?: string, topics?: object[]}} [context]
 * @returns {{answer: string, sources: {id:string,title:string}[], navigation: object[]}}
 */
export function answerAdminHelpQuestion(question, context = {}) {
  const topics = context.topics || ADMIN_HELP_TOPICS;
  const trimmed = String(question || '').trim();
  if (!trimmed) {
    return { answer: '', sources: [], navigation: [] };
  }

  // Product-support layer — system errors, internal terminology, and page
  // locations are answered directly, BEFORE the setup copilot or corpus
  // retrieval, so a question about an error message, an internal term, or
  // where a page lives is never substituted with a generic onboarding
  // response.
  const support = answerSupportQuestion(trimmed, context);
  if (support) {
    return {
      answer: support.answer,
      sources: support.sources,
      navigation: (support.navigation || [])
        .filter((n) => NAV_ROUTE_ALLOWLIST.includes(n.route))
        .map((n) => ({ label: n.label, route: n.route, topic: n.topic || 'support' })),
    };
  }

  // Contextual setup copilot — Client Admin setup state takes priority for
  // next-step and page-relative questions. Deterministic composition from
  // the derived checklist; falls through to the corpus otherwise.
  const lower = trimmed.toLowerCase();
  if (context.setup && !context.setup.loading) {
    if (SETUP_NEXT_STEP_PATTERNS.some((re) => re.test(lower))) {
      return setupNextStepAnswer(context.setup);
    }
    if (isPageRelativeIntent(trimmed)) {
      const guidance = pageGuidanceAnswer(context.setup, context.route);
      if (guidance) return guidance;
    }
  }

  const matched = retrieveTopics(topics, trimmed, { limit: 3, minScore: 1, route: context.route });
  if (matched.length === 0) {
    return { answer: INSUFFICIENT_HELP_MESSAGE, sources: [], navigation: [] };
  }

  const primary = matched[0];
  const lines = [...paragraphsFor(primary)];

  if (primary.whereToFind) {
    lines.push(`Where to go: ${primary.whereToFind}`);
  }
  if (primary.caveats) {
    lines.push(primary.caveats);
  }

  const relatedTitles = matched
    .slice(1)
    .map((t) => t.title)
    .filter(Boolean);
  if (relatedTitles.length > 0) {
    lines.push(`Related help: ${relatedTitles.join(', ')}`);
  }

  return {
    answer: lines.join('\n\n'),
    sources: matched.map((t) => ({ id: t.id, title: t.title })),
    navigation: buildNavigation(primary),
  };
}