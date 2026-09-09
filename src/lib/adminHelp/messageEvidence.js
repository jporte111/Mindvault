// MindVault Help — the response planner's evidence extractor.
//
// The user's CURRENT message is primary evidence. Before any canned answer
// is chosen, this pulls out what the user already told us so the assistant
// never asks for information already supplied:
//   - quotedError      : an error string the user quoted ("a tenant must be
//                        specified"), verbatim, from "..." or '...' or after
//                        "it says" / "the message" etc.
//   - errorKey         : which known system error that quoted/paraphrased
//                        text maps to, if any (see KNOWN_ERRORS)
//   - pageOrFeature    : a page / card / feature named in the message
//                        ("Company details", "Team", "the setup checklist")
//   - actionAttempted  : the verb+object the user was doing ("save company
//                        details", "invite a teammate", "click Save")
//   - objectInvolved   : the noun the action acted on, when distinct
//   - isErrorReport    : the message describes something that went wrong
//   - isQuestion       : the message is a question (definition / how-to /
//                        location), not (only) an error report
//
// Pure and deterministic. No imports, no network, no DOM, no customer data.

// --- quoted error text -----------------------------------------------------

// Straight and curly quotes — a message can contain several quoted spans
// (a button name AND an error), so EVERY span is examined (with the text
// immediately before it, for context), not just the first.
const QUOTE_SPANS = /(.{0,24})["'“‘]([^"'”’\n]{4,200})["'”’]/g;
// The "it says X" / "the message X" / "an error saying X" forms, quote
// marks optional.
const SAYS_LEAD =
  /\b(?:(?:the |an? |this )?(?:message|error|popup|warning|toast|dialog|box|prompt) (?:says?|said|saying|reads?|is|was|that says?)|it (?:says?|said|saying|reads?)|says?|said|saying|reads?)\s*:?\s*["'“‘]?([a-z][^."'”’\n]{6,160})/i;

// A quoted span is an "error quote" if it either reads like a system
// message, or the words right before it flag it as one.
const ERROR_LEAD_CONTEXT = /\b(error|message|says?|said|saying|shows?|showed|warning|popup|toast|dialog|reads?)\b[^"'“‘]{0,12}$/i;

/**
 * @param {string} message
 * @returns {string|null} the quoted / clearly-reported error text, trimmed
 */
export function extractQuotedError(message) {
  const s = String(message || '');
  const errorLike = [];
  const contextual = [];
  for (const m of s.matchAll(QUOTE_SPANS)) {
    const before = m[1] || '';
    const span = m[2];
    if (looksLikeErrorText(span)) errorLike.push(span);
    else if (ERROR_LEAD_CONTEXT.test(before)) contextual.push(span);
  }
  const say = s.match(SAYS_LEAD);
  if (say) {
    if (looksLikeErrorText(say[1])) errorLike.unshift(say[1]);
    else contextual.push(say[1]);
  }
  const pick = errorLike[0] || contextual[0] || null;
  return pick ? pick.trim() : null;
}

// A quoted fragment is "error text" if it reads like a system message rather
// than a page name or a normal noun phrase.
function looksLikeErrorText(fragment) {
  const f = String(fragment || '').trim().toLowerCase();
  if (f.length < 6) return false;
  if (/\b(must|cannot|can't|can not|not allowed|denied|required|unauthorized|forbidden|failed|invalid|no (tenant|permission|access)|unable|error|specified|specify)\b/.test(f)) {
    return true;
  }
  // "a tenant must be specified" style: 3+ words and contains a verb-ish token
  return f.split(/\s+/).length >= 3 && /\b(is|are|was|were|has|have|been|be)\b/.test(f);
}

// --- known system errors -------------------------------------------------
// Same catalogue the support layer keys its explanations off. Kept here so
// the planner can identify the error the user is describing even when the
// support layer's own matcher (which also handles paraphrases + cues) is
// not consulted.

export const KNOWN_ERRORS = [
  {
    key: 'error_tenant_scope',
    patterns: [
      /a tenant must be specified/i,
      /tenant must be (?:specified|chosen|selected|provided|set)/i,
      /(?:must|need to|have to) (?:specify|choose|select|pick|set) (?:a |the |your )?tenant/i,
      /no tenant (?:context|specified|selected)/i,
      /tenant (?:is )?required/i,
    ],
  },
  {
    key: 'error_unauthorized',
    patterns: [/\bunauthorized\b/i, /not authorized/i, /permission denied/i, /\b403\b/, /don'?t have permission/i, /forbidden/i],
  },
  {
    key: 'error_admin_only',
    patterns: [/active tenant admins? only/i, /tenant admins? only/i],
  },
  {
    key: 'error_cross_tenant',
    patterns: [/cross[- ]tenant/i, /cross[- ]company/i],
  },
];

/**
 * @param {string} text  quoted error, or the whole message
 * @returns {string|null} a KNOWN_ERRORS key
 */
export function classifyError(text) {
  const s = String(text || '');
  for (const e of KNOWN_ERRORS) {
    if (e.patterns.some((re) => re.test(s))) return e.key;
  }
  return null;
}

// --- page / feature named in the message --------------------------------

const PAGE_OR_FEATURE = [
  { id: 'company_details', label: 'Company details', patterns: [/company details/i, /company info(?:rmation)?/i, /company name|logo|brand colou?r/i] },
  { id: 'team', label: 'Team', patterns: [/\bteam page\b/i, /\bteam members?\b/i, /\binvit(?:e|ing|ation)\b/i] },
  { id: 'getting_started', label: 'Getting Started', patterns: [/getting started/i, /setup checklist/i, /set ?up checklist/i, /\bthe checklist\b/i] },
  { id: 'manage', label: 'Manage', patterns: [/\bmanage page\b/i, /add(?:ing)? knowledge/i, /upload(?:ing)?/i] },
  { id: 'processes', label: 'Processes', patterns: [/\bprocesses? page\b/i, /\bprocess form\b/i] },
  { id: 'knowledge', label: 'Knowledge', patterns: [/\bknowledge page\b/i, /\blibrary\b/i] },
  { id: 'chat', label: 'AI Assistant', patterns: [/\bai assistant\b/i, /\bchat page\b/i] },
  { id: 'home', label: 'Home', patterns: [/\bhome page\b/i] },
];

/** @returns {{id:string,label:string}|null} */
export function extractPageOrFeature(message) {
  const s = String(message || '');
  for (const p of PAGE_OR_FEATURE) {
    if (p.patterns.some((re) => re.test(s))) return { id: p.id, label: p.label };
  }
  return null;
}

// --- action attempted --------------------------------------------------

const ACTION_VERB =
  /\b(sav(?:e|ing|ed)|click(?:ed|ing)?|press(?:ed|ing)?|hit|submit(?:ted|ting)?|invit(?:e|ed|ing)|add(?:ed|ing)?|updat(?:e|ed|ing)|creat(?:e|ed|ing)|upload(?:ed|ing)?|open(?:ed|ing)?|tr(?:y|ied|ying))\b/i;

/** A short "verb + object" phrase for what the user was doing, or null. */
export function extractActionAttempted(message) {
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  // "click/save <quoted-button>"  -> just the button (the verb is implied)
  const quotedBtn = s.match(/\b(?:sav(?:e|ing)|click(?:ed|ing)?|press(?:ed|ing)?|hit|submit(?:ted|ting)?|tap(?:ped|ping)?)\b[^"'“‘]{0,15}["'“‘]([^"'”’]{2,40})["'”’]/i);
  if (quotedBtn) return `${quotedBtn[1].trim()}`;
  // "clicked Save" / "hit Save" — an unquoted Capitalised button label
  const capBtn = s.match(/\b(?:click(?:ed|ing)?|press(?:ed|ing)?|hit|tap(?:ped|ping)?)\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2})\b/);
  if (capBtn && !/^(I|My|The|A|An|It|This)$/.test(capBtn[1])) return capBtn[1].trim();
  // "verb + object" up to a boundary
  const m = s.match(new RegExp(`${ACTION_VERB.source}\\s+((?:my |the |a |our |an )?[a-z][a-z ]{2,40}?)(?=\\s+(?:the message|it |and |but |,|\\.|$))`, 'i'));
  if (m) return `${normalizeVerb(m[1])} ${m[2].trim()}`;
  const v = s.match(ACTION_VERB);
  return v ? normalizeVerb(v[1]) : null;
}

function normalizeVerb(v) {
  const l = String(v).toLowerCase();
  if (l.startsWith('sav')) return 'save';
  if (l.startsWith('click') || l === 'press' || l === 'pressed' || l === 'hit') return 'click';
  if (l.startsWith('invit')) return 'invite';
  if (l.startsWith('add')) return 'add';
  if (l.startsWith('updat')) return 'update';
  if (l.startsWith('creat')) return 'create';
  if (l.startsWith('upload')) return 'upload';
  if (l.startsWith('submit')) return 'submit';
  if (l.startsWith('open')) return 'open';
  if (l.startsWith('tr')) return 'try';
  return l;
}

// --- question vs error report ----------------------------------------

const QUESTION_LEAD = /^(what|where|how|why|when|who|which|is|are|can|does|do|should|could|would)\b/i;

export function isErrorReport(message) {
  const s = String(message || '').toLowerCase();
  return (
    /\b(error|message|warning|popup|toast|says?|said|shows?|showed|told me|gave me|fail(?:s|ed|ing)?|denied|blocked|unauthori[sz]ed|forbidden|not work|doesn'?t work|won'?t (?:save|let)|can'?t (?:save|get|do)|keeps? (?:saying|getting|happening)|every ?time|whenever)\b/.test(s) ||
    /\bi (?:got|get|keep getting|received|see|saw)\b.{0,24}\b(error|unauthori[sz]ed|denied|forbidden|blocked|message|warning|problem)\b/.test(s) ||
    !!extractQuotedError(message)
  );
}

export function isQuestion(message) {
  return QUESTION_LEAD.test(String(message || '').trim());
}

// --- the planner ----------------------------------------------------

/**
 * Extract everything the user's message already tells us. The support layer
 * uses this to answer with what it knows and to ask ONLY for a genuinely
 * missing piece.
 *
 * @param {string} message
 * @returns {{
 *   quotedError: string|null,
 *   errorKey: string|null,
 *   pageOrFeature: {id:string,label:string}|null,
 *   actionAttempted: string|null,
 *   isErrorReport: boolean,
 *   isQuestion: boolean,
 * }}
 */
export function extractEvidence(message) {
  const quotedError = extractQuotedError(message);
  // Classify from the quote first, then from the whole message (covers
  // "it says a tenant must be specified" with no quote marks).
  const errorKey = classifyError(quotedError) || classifyError(message);
  return {
    quotedError,
    errorKey,
    pageOrFeature: extractPageOrFeature(message),
    actionAttempted: extractActionAttempted(message),
    isErrorReport: isErrorReport(message),
    isQuestion: isQuestion(message),
  };
}
