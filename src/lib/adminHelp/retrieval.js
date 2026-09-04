// Admin Help Assistant — pure lexical/topic matching over the curated corpus
// (src/lib/adminHelp/corpus.js). No embeddings, no network, no randomness,
// and no dependency on — or import of — the customer retrieval pipeline
// (base44/shared/{embeddings,retrieval,text}.ts) or askKnowledgeBaseV2. This
// module only ever sees the static, bundled product-help corpus.

import { isPageRelativeIntent, routeBias } from './routeContext.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'did', 'how', 'what', 'when',
  'where', 'why', 'which', 'who', 'i', 'my', 'me', 'to', 'of', 'for', 'in',
  'on', 'and', 'or', 'can', 'should', 'it', 'this', 'that', 'with', 'about',
  'be', 'if', 'you', 'your', 'am', 'so',
]);

/**
 * Lowercases, strips punctuation (keeping letters/digits/spaces only — a
 * hyphen and an apostrophe both become a space, so "key-person" and "isn't"
 * tokenize the same way whether they appear in a question or a keyword),
 * splits on whitespace, and drops stopwords and single-character tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function topicTermCounts(topicEntry) {
  const counts = new Map();
  const phrases = [
    topicEntry.title,
    topicEntry.id.replace(/_/g, ' '),
    ...(topicEntry.keywords || []),
  ];
  for (const phrase of phrases) {
    for (const w of tokenize(phrase)) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Deterministic overlap score between a topic and a tokenized question: one
 * point per distinct question token that appears among the topic's title /
 * id / keyword words, plus a small boost when the topic's own title phrase
 * appears verbatim (as tokens) in the question.
 *
 * @param {object} topicEntry
 * @param {string[]} queryWords
 * @returns {number}
 */
export function scoreTopic(topicEntry, queryWords) {
  const terms = topicTermCounts(topicEntry);
  let score = 0;
  for (const w of new Set(queryWords)) {
    if (terms.has(w)) score += 1;
  }
  const titleWords = tokenize(topicEntry.title);
  if (titleWords.length > 1) {
    // Multi-word title phrase bonus only — a single-word title would just
    // re-reward the word-overlap point above and skew short generic titles
    // (e.g. "Trends") ahead of a more specific multi-word match.
    const titlePhrase = titleWords.join(' ');
    const queryPhrase = queryWords.join(' ');
    if (queryPhrase.includes(titlePhrase)) score += 2;
  }
  // Exact-id bonus: when the topic's own id is a single word (owner, sme,
  // criticality, coverage, currency, trends, ...) and that exact word is a
  // token in the question, this is the strongest possible signal — it must
  // outrank a different topic that merely mentions the same word in passing
  // (e.g. "sme" should point at the `sme` topic before `backup_sme`, whose
  // title also happens to contain the word "SME").
  const idWords = topicEntry.id.split('_');
  if (idWords.length === 1 && queryWords.includes(idWords[0])) {
    score += 3;
  }
  return score;
}

/**
 * Retrieves the most relevant curated topics for a free-text admin question.
 * Returns an empty array when nothing scores at or above minScore — the
 * caller must treat that as "not documented," never invent an answer.
 *
 * `opts.route`, when given, is a lightweight relevance SIGNAL only (see
 * routeContext.js) — and critically, route bias alone is never enough to
 * produce a result: it is only ever applied to a topic when EITHER (A) that
 * topic already has real lexical relevance of its own (word/phrase/id
 * overlap with the question — the bias then only re-ranks it), OR (B) the
 * question matches one of routeContext.js's small set of explicit,
 * recognized page-relative intent patterns (isPageRelativeIntent). The bare
 * presence of a word like "here" or "page" is NOT that intent — "unknown
 * words + a page cue ≠ a documented question" is the invariant this
 * function protects. Route bias is also always smaller than a real keyword
 * match or the exact-id bonus, so an explicit term (e.g. "What is an SME?")
 * still resolves correctly regardless of which page it's asked from.
 *
 * @param {object[]} topics
 * @param {string} question
 * @param {{limit?: number, minScore?: number, route?: string}} [opts]
 * @returns {object[]}
 */
export function retrieveTopics(topics, question, opts = {}) {
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 1;
  const route = opts.route;
  const queryWords = tokenize(question);
  const pageIntent = isPageRelativeIntent(question);
  // Bail out only when there is truly nothing to go on: no real question
  // content AND no recognized page-relative intent a route bias could ever
  // attach to.
  if (queryWords.length === 0 && !pageIntent) return [];

  return topics
    .map((t) => {
      const lexicalScore = scoreTopic(t, queryWords);
      const biasAllowed = lexicalScore > 0 || pageIntent;
      const score = lexicalScore + (biasAllowed ? routeBias(route, t.id) : 0);
      return { topicEntry: t, score };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || a.topicEntry.id.localeCompare(b.topicEntry.id))
    .slice(0, limit)
    .map((r) => r.topicEntry);
}
