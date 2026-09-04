// Admin Help Assistant — deterministic answer composition from the curated
// corpus. No LLM call, no network, no customer data. If the corpus doesn't
// support an answer, this says so — it never invents where a control lives
// or what a feature does.

import { ADMIN_HELP_TOPICS } from './corpus.js';
import { retrieveTopics } from './retrieval.js';

// Every navigation target this assistant can ever suggest. Defense in depth
// on top of the fact that the corpus is static, curated, and bundled with
// the app: even a future corpus edit cannot point the assistant at an
// arbitrary route, because buildNavigation() drops anything not in here.
export const NAV_ROUTE_ALLOWLIST = ['/library', '/chat', '/admin', '/continuity'];

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

  const matched = retrieveTopics(topics, trimmed, { limit: 3, minScore: 1 });
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
