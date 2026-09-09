// MindVault Help — a small, curated synonym map so natural business
// phrasing matches the corpus without embeddings, a network call, or an LLM.
//
// It is deliberately conservative and one-directional: every value is a
// CANONICAL term that already appears in a real corpus topic's title / id /
// keywords (see corpus.js). Expansion is ADDITIVE — the original query token
// is always kept — so a synonym can only ever ADD relevance to a topic that
// is genuinely about that canonical concept. A word that is not a key here
// contributes nothing, so gibberish still scores zero and the
// "unknown words + a page cue ≠ a documented question" invariant in
// retrieval.js is untouched.
//
// Pure data. No imports, no Base44, no DOM, no network.

/** @type {Record<string, string>} raw token -> canonical corpus token */
export const SYNONYMS = {
  // --- modify an existing thing -> "update" ---
  change: 'update',
  changing: 'update',
  edit: 'update',
  editing: 'update',
  modify: 'update',
  modifying: 'update',
  rename: 'update',
  renaming: 'update',
  adjust: 'update',
  revise: 'update',
  revising: 'update',
  alter: 'update',
  amend: 'update',
  updating: 'update',
  correct: 'update',

  // --- create / bring in a new thing -> "add" ---
  create: 'add',
  creating: 'add',
  upload: 'add',
  uploading: 'add',
  import: 'add',
  importing: 'add',
  attach: 'add',
  adding: 'add',

  // --- company identity -> "company" ---
  business: 'company',
  organization: 'company',
  organisation: 'company',
  org: 'company',
  firm: 'company',
  info: 'company',
  information: 'company',
  profile: 'company',

  // --- branding fields -> "branding" ---
  brand: 'branding',
  logo: 'branding',
  colour: 'branding',
  color: 'branding',
  colours: 'branding',
  colors: 'branding',
  theme: 'branding',

  // --- people on the team -> "member" ---
  teammate: 'member',
  teammates: 'member',
  colleague: 'member',
  colleagues: 'member',
  coworker: 'member',
  coworkers: 'member',
  staff: 'member',
  personnel: 'member',
  people: 'member',
  someone: 'member',
  person: 'member',
  user: 'member',
  users: 'member',
  employee: 'member',
  employees: 'member',

  // --- access lifecycle -> "revoke" / "reactivate" ---
  remove: 'revoke',
  removing: 'revoke',
  deactivate: 'revoke',
  disable: 'revoke',
  revoking: 'revoke',
  restore: 'reactivate',
  restoring: 'reactivate',
  reenable: 'reactivate',

  // --- roles -> "role" ---
  roles: 'role',
  privilege: 'role',
  privileges: 'role',
  permission: 'role',
  permissions: 'role',

  // --- knowledge source shapes -> "knowledge" ---
  sop: 'knowledge',
  sops: 'knowledge',
  procedure: 'knowledge',
  procedures: 'knowledge',
  policy: 'knowledge',
  policies: 'knowledge',
  handbook: 'knowledge',
  handbooks: 'knowledge',
  documentation: 'knowledge',
  document: 'knowledge',
  documents: 'knowledge',
  doc: 'knowledge',
  docs: 'knowledge',
  guideline: 'knowledge',
  guidelines: 'knowledge',

  // --- workflow -> "process" ---
  workflow: 'process',
  workflows: 'process',
  procedureflow: 'process',

  // --- AI Assistant conversation history -> "question" / "history" ---
  conversation: 'question',
  conversations: 'question',
  transcript: 'question',
  transcripts: 'question',
  chats: 'question',
  asked: 'question',

  // --- getting around ---
  navigate: 'open',
  goto: 'open',
};

/**
 * Additive synonym expansion: returns the input tokens plus the canonical
 * term for any token that has one. Deterministic, order-preserving, deduped.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function expandSynonyms(tokens) {
  const out = [];
  const seen = new Set();
  const push = (w) => {
    if (w && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  };
  for (const t of tokens || []) {
    push(t);
    const canon = SYNONYMS[t];
    if (canon) push(canon);
  }
  return out;
}
