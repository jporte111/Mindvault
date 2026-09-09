// Admin Help Assistant — deterministic route -> topic relevance bias.
//
// The current route is a lightweight relevance SIGNAL, never permission to
// fabricate an answer. The invariant this module exists to protect:
//
//   unknown words + a page cue word ≠ a documented question
//
// Route bias may only ever do one of two things (both enforced by the
// caller, retrieval.js's retrieveTopics — this module only supplies the
// raw ingredients):
//   A. RE-RANK a topic that already has real lexical/topic relevance, or
//   B. answer a question that matches a small, explicit, deterministic set
//      of recognized page-relative intent PATTERNS (isPageRelativeIntent) —
//      never the bare presence of a word like "here" or "page" on its own.
// Route bias must never be the sole basis for a result unless (B) holds.

const ROUTE_TOPIC_BIAS = {
  // ClientHome — the Client Admin's setup command center.
  '/': ['setup_checklist', 'getting_started', 'adding_knowledge'],
  '/team': ['permissions'],
  '/library': ['knowledge_library', 'adding_knowledge', 'knowledge_scope'],
  '/chat': ['ai_assistant', 'knowledge_scope', 'knowledge_gaps'],
  '/admin': ['setup_checklist', 'operational_processes', 'owner', 'sme', 'review_cadence', 'verification'],
  '/continuity': [
    'operational_continuity', 'coverage', 'currency', 'key_person_dependency',
    'knowledge_gaps', 'snapshots', 'trends', 'what_changed',
  ],
  '/setup': ['setup_checklist', 'adding_knowledge', 'knowledge_scope'],
  '/manage': ['adding_knowledge', 'knowledge_scope', 'operational_processes'],
  '/processes': ['operational_processes', 'owner', 'sme', 'review_cadence'],
};

// /training/:id is a dynamic route, matched by prefix rather than exact string.
const TRAINING_DETAIL_TOPIC_BIAS = ['knowledge_library', 'verification', 'lifecycle', 'knowledge_scope'];

/**
 * The ordered list of topics this route is biased toward, or an empty array
 * for a route this corpus has no page-relative help for. Order matters: the
 * first topic is the route's primary topic and gets the strongest bias.
 *
 * @param {string} [route]
 * @returns {string[]}
 */
export function topicsForRoute(route) {
  if (!route) return [];
  if (ROUTE_TOPIC_BIAS[route]) return ROUTE_TOPIC_BIAS[route];
  if (route.startsWith('/training/')) return TRAINING_DETAIL_TOPIC_BIAS;
  return [];
}

// A small, explicit, deterministic set of recognized page-relative
// intents — the ONLY way an admin's question can, by itself (with no real
// lexical/topic relevance of its own), qualify a route's bias to produce a
// result. Each pattern is a real, specific way of asking "explain this
// page to me" — never just a bare cue word like "here" or "page" occurring
// anywhere in the text, which "flibbertigibbet here" or "banana section"
// would also satisfy.
const PAGE_RELATIVE_INTENT_PATTERNS = [
  /\bwhat is this\b/,
  /\bwhat's this\b/,
  /\bwhat does this (page|section|screen) (mean|do|show)\b/,
  /\bhow does this work\b/,
  /\bwhat should i (look at|check|review) here\b/,
  /\bwhat should i (look at|check|review) (on|in) (this|the) (page|section|screen)\b/,
  /\bwhat should i do first\b/,
  /\bwhat should i (do|configure|set up|start with) (here|on this page|in this section)\b/,
  /\bwhat (do|should) i do here\b/,
  /\bwhat do i do (on|in) (this|the) (page|screen)\b/,
  /\bwhat am i (looking at|supposed to do)( here)?\b/,
];

/**
 * True only when the raw question matches one of the small set of
 * recognized page-relative intent patterns above — never merely because it
 * contains a word like "here", "this", "page", "section", or "screen".
 *
 * @param {string} question
 * @returns {boolean}
 */
export function isPageRelativeIntent(question) {
  const q = String(question || '').toLowerCase();
  return PAGE_RELATIVE_INTENT_PATTERNS.some((re) => re.test(q));
}

/**
 * The raw route-context bias for one topic: 2 for the route's primary
 * (first-listed) topic, 1 for the rest of its bias list, 0 for a topic not
 * in that route's list (or an unmapped route). This is deliberately smaller
 * than a real keyword match or the exact-id bonus in retrieval.js's
 * scoreTopic(), so explicit question terms always outrank route context.
 *
 * This function does NOT decide whether the bias is allowed to apply on
 * its own — that gating (real lexical relevance, or a recognized
 * page-relative intent) is retrieveTopics()'s responsibility, so that a
 * nonsense question can never borrow "permission" from a route alone.
 *
 * @param {string} route
 * @param {string} topicId
 * @returns {number}
 */
export function routeBias(route, topicId) {
  const topics = topicsForRoute(route);
  const idx = topics.indexOf(topicId);
  if (idx === -1) return 0;
  return idx === 0 ? 2 : 1;
}