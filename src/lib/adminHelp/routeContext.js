// Admin Help Assistant — deterministic route -> topic relevance bias.
//
// The current route is a lightweight relevance SIGNAL, never permission to
// fabricate an answer. It only ever helps disambiguate a vague,
// page-relative question ("What is this?", "What should I look at here?")
// — it never fires for an ordinary explicit question, and it never fires on
// a route this corpus has no help for. See routeBias() for how the two
// gates (a real page-reference cue in the question, and a known route)
// both have to hold before any bias is added.

const ROUTE_TOPIC_BIAS = {
  '/library': ['knowledge_library', 'adding_knowledge', 'knowledge_scope'],
  '/chat': ['ai_assistant', 'knowledge_scope', 'knowledge_gaps'],
  '/admin': ['setup_checklist', 'operational_processes', 'owner', 'sme', 'review_cadence', 'verification'],
  '/continuity': [
    'operational_continuity', 'coverage', 'currency', 'key_person_dependency',
    'knowledge_gaps', 'snapshots', 'trends', 'what_changed',
  ],
};

// /training/:id is a dynamic route, matched by prefix rather than exact string.
const TRAINING_DETAIL_TOPIC_BIAS = ['knowledge_library', 'verification', 'lifecycle', 'knowledge_scope'];

// A page-relative referent word — "here", "this", "page", "section",
// "screen" — is what distinguishes "What should I look at here?" (a
// legitimate vague question this route bias exists for) from an ordinary
// gibberish or off-topic question that merely happens to be asked on a
// mapped route. Checked against the raw question text, independent of
// tokenize()'s stopword filtering (which would otherwise drop "this"/"here").
const PAGE_REFERENCE_CUE = /\b(here|this|page|section|screen)\b/i;

/**
 * @param {string} question
 * @returns {boolean}
 */
export function hasPageReferenceCue(question) {
  return PAGE_REFERENCE_CUE.test(String(question || ''));
}

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

/**
 * The route-context bias score for one topic. Zero unless BOTH gates hold:
 * the question contains a page-reference cue, and the route has a known
 * bias list containing this topic. Deliberately small relative to a real
 * keyword match or the exact-id bonus in retrieval.js's scoreTopic(), so
 * explicit question terms always outrank route context.
 *
 * @param {string} route
 * @param {string} topicId
 * @param {string} question
 * @returns {number}
 */
export function routeBias(route, topicId, question) {
  if (!hasPageReferenceCue(question)) return 0;
  const topics = topicsForRoute(route);
  const idx = topics.indexOf(topicId);
  if (idx === -1) return 0;
  return idx === 0 ? 2 : 1;
}
