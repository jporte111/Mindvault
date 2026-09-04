// Admin Help Assistant — public API. Everything here is pure, deterministic,
// and client-side: no network call, no Base44, no LLM, no embeddings, no
// customer data. See corpus.js for the content and the safety discipline it
// follows, retrieval.js for the lexical matcher, and answer.js for how a
// question becomes a response.

export { ADMIN_HELP_TOPICS, ADMIN_HELP_TOPIC_IDS } from './corpus.js';
export { tokenize, scoreTopic, retrieveTopics } from './retrieval.js';
export { answerAdminHelpQuestion, NAV_ROUTE_ALLOWLIST, INSUFFICIENT_HELP_MESSAGE } from './answer.js';
export { getStarterPrompts, GENERIC_STARTER_PROMPTS } from './routePrompts.js';
