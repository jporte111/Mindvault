// MindVault Help — the product-support layer: system errors, internal
// terminology, and page locations. Deterministic, no network, no customer
// data. It runs BEFORE the setup copilot and the corpus retrieval (see
// answer.js) so a question about an error, an internal term, or where a
// page lives always gets THAT answer — never a generic onboarding response.
//
// Response-planner discipline:
//   - the user's CURRENT message is primary evidence. extractEvidence()
//     (messageEvidence.js) pulls out any quoted error, the page/feature and
//     the action named, and whether it is a question. The support layer
//     answers with what it already knows and asks ONLY for a genuinely
//     missing piece — it NEVER re-asks for the error wording when the user
//     has quoted it, nor for the page when the user has named it or the app
//     just captured it.
//   - structured runtime context (context.supportContext) carries the
//     current page/section, the caller's role, the workspace name, setup
//     progress, and the most recent captured application error/action — no
//     security-sensitive data (no tenant_id, tokens, membership rows,
//     stack traces).
//   - internal terms (tenant, tenant_id, RLS, membership record, Super
//     Admin) are EXPLAINED, never asked of the user or told to configure.
//   - a recognized error is TROUBLESHOOTING context: what it means, whether
//     the user caused it, what to do next, and whether MindVault needs a fix.
//   - troubleshooting is CONVERSATION-AWARE: a short follow-up in an open
//     thread is resolved against it, not re-answered from scratch.
//   - page locations use only the CURRENT Client Admin navigation names:
//     Home, Knowledge, AI Assistant, Processes, Team, Manage, Getting Started

import { extractEvidence, classifyError } from './messageEvidence.js';

export const SUPPORT_SOURCE = [{ id: 'mindvault_support', title: 'MindVault product support' }];

// ---------------------------------------------------------------------------
// Internal terminology — plain-English explanations. Entries are checked in
// order; the first pattern match wins. None of these are things a Client
// Admin is ever asked to configure.
// ---------------------------------------------------------------------------

const INTERNAL_TERMS = [
  {
    id: 'term_tenant_id',
    patterns: [/\btenant[_ ]?id\b/],
    answer:
      "tenant_id is the internal record identifier for your company's workspace — how MindVault tells your workspace apart from every other company's.\n\nIt is filled in automatically everywhere it is needed. You never have to find, copy, or type it. If a screen or message seemed to ask you for it, that is a system problem rather than something you are expected to provide — tell me what you were doing and I can help you sort it out.",
  },
  {
    id: 'term_tenant',
    patterns: [/\btenants?\b/, /\bworkspace\b/],
    answer:
      "A tenant is simply your company's private workspace in MindVault — the internal name for everything that belongs to your organization: your team, your knowledge, and your settings.\n\nYou never create, choose, or configure a tenant. Your workspace is assigned automatically when you sign in, so there is nothing for you to do. If you saw this word in a message or on a screen, it is internal terminology — tell me where you saw it if you would like me to explain that specific message.",
  },
  {
    id: 'term_rls',
    patterns: [/\brls\b/, /\brow[- ]level security\b/],
    answer:
      "RLS stands for row-level security — MindVault's built-in protection that keeps each company's records visible only to that company's members. It is part of the platform and always on.\n\nThere is no setting for it in your workspace and nothing for you to configure — you will only ever see this term in technical notes.",
  },
  {
    id: 'term_scope_resolution',
    patterns: [/\bscope resolution\b/],
    answer:
      "Scope resolution is MindVault's internal name for deciding which knowledge applies to the current situation — for example, whether a question can be answered from company-wide knowledge or only from knowledge tied to a specific client.\n\nIt runs automatically. Your part is simply choosing who can use each knowledge source when you add it — the rest is handled for you.",
  },
  {
    id: 'term_membership_record',
    patterns: [/\bmembership (record|row)\b/],
    answer:
      "A membership record is the internal entry that connects a person's account to your company's workspace and stores their role (Client Admin or Client User).\n\nYou never manage these directly — inviting or updating teammates on the Team page creates and maintains them for you.",
  },
  {
    id: 'term_guarded_function',
    patterns: [/\bguarded function\b/],
    answer:
      "A guarded function is a behind-the-scenes action MindVault runs only after verifying who you are and which company's workspace you belong to. The guard is part of the platform — it is not something you configure or see in your settings.",
  },
  {
    id: 'term_super_admin',
    patterns: [/\bsuper admin\b/, /\bplatform admin\b/],
    answer:
      '"Super Admin" (also called Platform Admin) is the MindVault platform team\'s own administrator role — it operates across all companies on the platform.\n\nAs a Client Admin you manage your own company\'s workspace; a Super Admin role is not something your company uses or needs.',
  },
];

// ---------------------------------------------------------------------------
// System errors — driven by the response planner (messageEvidence.js) and
// the runtime support context. A quoted / reported error, or one the app
// just captured, is TROUBLESHOOTING context: what it means, whether the user
// caused it, what to do next, and whether MindVault needs to fix it.
//
// The page/action is taken from what the user ALREADY said, then from the
// app-captured error, then from the page they're on. A follow-up is asked
// ONLY when none of those is available — and it is never a request for
// wording the user already supplied.
// ---------------------------------------------------------------------------

const ERROR_CUE =
  /\b(says?|said|shows?|showed|told me|gave me|keeps? (saying|getting)|error|message|warning|popup|toast|denied|blocked|when i (click|try|save|invite)|tried to|trying to|every ?time|whenever)\b/;

// Plain-language explanation per known error. No trailing question here —
// the composer decides whether a follow-up is warranted.
const ERROR_INFO = {
  error_tenant_scope: {
    meaning:
      "That message doesn't mean you need to pick anything. MindVault resolves your company's workspace — sometimes called a \"tenant\" — automatically from your account, and you never choose it by hand.",
    verdict:
      "Nothing you typed caused it, and it is not a setup step you are missing. It is an application issue: an admin-only save that briefly lost track of which company it was acting on.",
    // The underlying cause — a platform account that is also a Client Admin
    // being asked for an explicit tenant on a self-service save — is fixed.
    fixed: true,
  },
  error_unauthorized: {
    meaning:
      "That message means your account does not have permission for that specific action — it is a role check, not a sign-in problem.",
    verdict:
      "Client Admins manage settings, knowledge, and the team; Client Users ask questions and browse knowledge. If you expected the action to be allowed, ask a Client Admin to check your role on the Team page — otherwise there is nothing for you to fix.",
    fixed: false,
  },
  error_admin_only: {
    meaning:
      "That action is reserved for a Client Admin whose membership in your workspace is active — it is a role check, not an error in anything you did.",
    verdict:
      "If you are a Client User, ask a Client Admin to do it or to update your role on the Team page. If you ARE an active Client Admin and still see it, it is an application issue on MindVault's side.",
    fixed: false,
  },
  error_cross_tenant: {
    meaning:
      "That message means the action touched a different company's workspace than the one you belong to. MindVault blocks that on purpose — it is how each company's information stays private.",
    verdict:
      "Nothing you configure causes it and your own company's data is unaffected. If it appeared during normal use it is an application issue on MindVault's side.",
    fixed: false,
  },
};

// Which known error a message describes. Strong phrases fire alone; soft
// paraphrases additionally need an error-reporting cue, so "Where do I
// choose my tenant?" stays a terminology question.
const ERROR_KEY_PATTERNS = {
  error_tenant_scope: {
    strong: [
      /a tenant must be specified/,
      /tenant must be (specified|chosen|selected|provided|set)/,
      /no tenant (context|specified|selected)/,
    ],
    soft: [
      /specif(y|ies|ied|ying) (a |the |my )?tenant/,
      /\b(choose|select|pick|set) a tenant\b/,
      /\btenant (is )?required\b/,
    ],
  },
  error_unauthorized: {
    strong: [/\bunauthorized\b/, /\bnot authorized\b/, /permission denied/],
    soft: [/\b403\b/, /don'?t have permission/, /\bforbidden\b/],
  },
  error_admin_only: { strong: [/active tenant admins? only/, /tenant admins? only/], soft: [] },
  error_cross_tenant: { strong: [/cross[- ]tenant/], soft: [/cross[- ]company/] },
};

function matchSystemErrorKey(lower) {
  for (const [key, p] of Object.entries(ERROR_KEY_PATTERNS)) {
    if (p.strong.some((re) => re.test(lower))) return key;
  }
  if (ERROR_CUE.test(lower)) {
    for (const [key, p] of Object.entries(ERROR_KEY_PATTERNS)) {
      if (p.soft.some((re) => re.test(lower))) return key;
    }
  }
  return null;
}

// Where the error happened: the user's own words first, then the
// app-captured error, then the page they are currently on.
function resolveErrorLocus(evidence, sc) {
  const re = sc && sc.recentError;
  const page =
    (evidence && evidence.pageOrFeature && evidence.pageOrFeature.label) ||
    (re && (re.section || re.page)) ||
    (sc && (sc.currentSection || sc.currentPage)) ||
    null;
  const action =
    (evidence && evidence.actionAttempted) ||
    (re && re.action) ||
    null;
  const known = !!(
    (evidence && (evidence.pageOrFeature || evidence.actionAttempted)) ||
    (re && (re.section || re.page || re.action)) ||
    (sc && sc.currentSection)
  );
  return { page, action, known };
}

function nextStepsFixed() {
  return (
    'What to do now:\n' +
    '1. Reload the page and save once more — this has already been corrected on MindVault\'s side.\n' +
    '2. If it still appears, sign out and back in to refresh your session, then try again.\n' +
    '3. If it still appears after that, contact MindVault support with the page you were on.'
  );
}
function nextStepsGeneric() {
  return (
    'What to do now:\n' +
    '1. Reload the page and try again.\n' +
    '2. If it persists, sign out and back in, then retry.\n' +
    '3. If it still appears, contact MindVault support with the exact message and the page or button that produces it.'
  );
}

const GENERIC_ACTION = /^(save|saving|click|clicking|clicked|hit|press|pressed|tap|tapped|submit|submitting|open|opening)$/i;

function locusPhrase(locus) {
  const { page, action } = locus;
  const generic = !action || GENERIC_ACTION.test(action);
  if (page && generic) return page; // "coming from Company details."
  if (action && page) {
    const a = action.replace(/^(save|saving|click|clicking|clicked|hit|press|pressed|tap|tapped) /i, '').trim();
    const pl = page.toLowerCase();
    const al = a.toLowerCase();
    if (pl.includes(al) || al.includes(pl)) return `the ${page} save`;
    return `the "${action}" action on ${page}`;
  }
  if (action && !generic) return `the ${action} action`;
  if (action) return `the ${action} button`;
  if (page) return page;
  return null;
}

function composeErrorAnswer(key, evidence, sc, lower) {
  const info = ERROR_INFO[key] || ERROR_INFO.error_tenant_scope;
  const trigger = triggerFromEvidence(lower || '', evidence, sc);
  const locus = resolveErrorLocus(evidence, sc);
  const parts = [];

  // Prefer a specific recorded/extracted action phrase ("revoke a
  // teammate's access", "save a process") for the sentence; fall back to
  // the trigger's short label, then to the generic locus phrasing. The
  // trigger is still used for navigation.
  const actionPhrase = locus.action && /\s/.test(locus.action) ? locus.action : null;
  const where = actionPhrase
    ? `the ${actionPhrase} action`
    : trigger
      ? (trigger.locusLabel || `the ${trigger.label} action`)
      : locusPhrase(locus);
  if (where) {
    parts.push(`That error is coming from ${where}.`);
  }
  parts.push(info.meaning);
  parts.push(info.verdict);
  parts.push(info.fixed ? nextStepsFixed() : nextStepsGeneric());
  // Ask for the one genuinely-missing piece ONLY when we truly don't know
  // where it happened — and NEVER for the wording, which we already have.
  if (!trigger && !locus.known) {
    parts.push('If you can tell me which page or button produced it, I can be more specific.');
  }
  return {
    answer: parts.join('\n\n'),
    sources: SUPPORT_SOURCE,
    navigation: trigger ? trigger.navigation : [],
  };
}

function composeGenericErrorAnswer(evidence, sc, lower) {
  const trigger = triggerFromEvidence(lower || '', evidence, sc);
  const locus = resolveErrorLocus(evidence, sc);

  if (evidence && evidence.quotedError) {
    // They quoted something we don't recognize — do NOT re-ask for the
    // wording.
    const wherePhrase = trigger
      ? ` You saw it while you ${trigger.label} ${trigger.where}.`
      : locus.page
        ? ` You saw it ${locus.action ? `while you ${locus.action} ` : ''}on ${locus.page}.`
        : '';
    return {
      answer:
        `I don't recognize "${evidence.quotedError}" as one of MindVault's standard messages.${wherePhrase}\n\n` +
        'Try reloading and repeating the action. If it keeps happening, contact MindVault support with that exact wording and the page.',
      sources: SUPPORT_SOURCE,
      navigation: trigger ? trigger.navigation : [],
    };
  }

  // The action is known but not the wording — acknowledge the action, ask
  // ONLY for the message text.
  if (trigger) {
    return { answer: genericTriggerAnswer(trigger), sources: SUPPORT_SOURCE, navigation: trigger.navigation };
  }
  if (locus.page || locus.action) {
    return {
      answer:
        `You're seeing a message ${locus.action ? `when you ${locus.action}` : `on ${locus.page}`}${locus.action && locus.page ? ` on ${locus.page}` : ''} — that already narrows it down.\n\n` +
        'What does the message say, exactly? Even a few words tell me which of MindVault\'s checks produced it.',
      sources: SUPPORT_SOURCE,
      navigation: [],
    };
  }
  // Nothing to go on — an honest "I can't tell" plus ONE targeted follow-up.
  return {
    answer:
      "I can't tell from your description which action produced that message, and I'd rather not guess.\n\n" +
      'What were you clicking when it appeared, and what did the message say?',
    sources: SUPPORT_SOURCE,
    navigation: [],
  };
}

// ---------------------------------------------------------------------------
// Page locations — "Where is X?" answered with the current navigation and
// current page names only (no deprecated "Library"/"Admin" pages).
// ---------------------------------------------------------------------------

const LOCATOR = /\bwhere\b|\bhow do i (get to|find|open|go to)\b/;

const PAGE_LOCATIONS = [
  {
    id: 'loc_tenant',
    patterns: [/\btenant\b/, /\bworkspace\b/, /\bcompany.? workspace\b/],
    answer:
      "There is no tenant (workspace) selector to find — MindVault resolves your company's workspace automatically from your account every time you sign in.\n\nYou never pick it, and there is no screen for it. If a message asked you to specify one, that is an application issue, not a setting you are missing.",
    navigation: [],
  },
  {
    id: 'loc_knowledge',
    patterns: [/\blibrary\b/, /\bknowledge page\b/],
    answer:
      '"Library" is the former name of the Knowledge page — same place, current name. Open it from the left navigation (Knowledge), or from the top bar on mobile.',
    navigation: [{ label: 'Open Knowledge', route: '/library' }],
  },
  {
    id: 'loc_setup',
    patterns: [/setup checklist/, /set up checklist/, /getting started/, /checklist/],
    answer:
      'Your setup checklist lives on the Getting Started page — Home shows the same progress at a glance.',
    navigation: [{ label: 'Open Getting Started', route: '/setup' }],
  },
  {
    id: 'loc_company_details',
    patterns: [/company details/],
    answer:
      'Company details are set on the Getting Started page, in the "Company details" card — you can reach Getting Started from Home.',
    navigation: [{ label: 'Open Getting Started', route: '/setup' }],
  },
  {
    id: 'loc_admin',
    patterns: [/\badmin\b/],
    answer: (context) => {
      if (context?.setup?.role === 'client_admin') {
        return 'There is no separate "Admin" page in the Client Admin navigation. Your admin tasks live across:\n• Home — your setup progress and next recommended step\n• Getting Started — the full 7-step setup checklist\n• Manage — add knowledge and describe processes (linked from Home and Getting Started)\n• Processes and Team — day-to-day management\n\nWhich were you looking for? Tell me the task and I will point you to the exact page.';
      }
      return 'Platform admin tools live on the Settings page — in the left navigation, under Administration.';
    },
    navigation: (context) =>
      context?.setup?.role === 'client_admin'
        ? [
            { label: 'Open Home', route: '/' },
            { label: 'Open Getting Started', route: '/setup' },
            { label: 'Open Manage', route: '/manage' },
          ]
        : [{ label: 'Open Settings', route: '/admin' }],
  },
  {
    id: 'loc_manage',
    patterns: [/\bmanage\b/],
    answer:
      'The Manage page is where you add knowledge sources and describe processes. It is linked from Home and from Getting Started — it has no sidebar item of its own.',
    navigation: [{ label: 'Open Manage', route: '/manage' }],
  },
  {
    id: 'loc_processes',
    patterns: [/\bprocesses\b/, /\bprocess page\b/],
    answer: 'The Processes page is in the left navigation (Processes).',
    navigation: [{ label: 'Open Processes', route: '/processes' }],
  },
  {
    id: 'loc_team',
    patterns: [/\bteam\b/],
    answer:
      'The Team page is in the left navigation (Team) — it is where you invite teammates and manage roles.',
    navigation: [{ label: 'Open Team', route: '/team' }],
  },
  {
    id: 'loc_chat',
    patterns: [/\bchat\b/, /\bai assistant\b/],
    answer: 'The AI Assistant is in the left navigation (AI Assistant).',
    navigation: [{ label: 'Open AI Assistant', route: '/chat' }],
  },
  {
    id: 'loc_continuity',
    patterns: [/\bcontinuity\b/],
    answer:
      'Operational Continuity appears in the left navigation once a platform admin has enabled it.',
    navigation: [{ label: 'Open Operational Continuity', route: '/continuity' }],
  },
  {
    id: 'loc_home',
    patterns: [/\bhome( page)?\b/],
    answer:
      'Home is the first item in the left navigation — it shows your setup progress and your next recommended step.',
    navigation: [{ label: 'Open Home', route: '/' }],
  },
];

function matchPageLocation(lower, context) {
  if (!LOCATOR.test(lower)) return null;
  for (const loc of PAGE_LOCATIONS) {
    if (!loc.patterns.some((re) => re.test(lower))) continue;
    const answer = typeof loc.answer === 'function' ? loc.answer(context) : loc.answer;
    const navigation = typeof loc.navigation === 'function' ? loc.navigation(context) : loc.navigation || [];
    return { answer, navigation };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversation awareness. A troubleshooting thread spans turns: the first
// answer identifies the message and asks ONE follow-up ("What page or button
// produced it?"); the user's reply is then resolved against that thread. A
// short reply like "whenever I click 'save company details'" is matched to a
// known action and answered with what that action does, why the error is on
// MindVault's side, and concrete retry steps — never a repeat of
// "I can't tell". History shape: [{ role: 'user'|'assistant', text }].
// ---------------------------------------------------------------------------

const FOLLOWUP_MARKERS = [
  /what page or button produced/i,
  /which page or button produced/i,
  /tell me which page or button/i,
  /if you can tell me which page or button/i,
  /what were you (clicking|trying to do) when/i,
  /what action were you trying/i,
  /what does the message say/i,
];

// Signatures detect which error a thread is about, across BOTH the user's
// phrasing and the assistant's own prior answers.
const ERROR_SIGNATURES = [
  { id: 'error_tenant_scope', patterns: [/tenant must be (specified|chosen|selected)/, /specif(y|ies|ied|ying) (a |the |my )?tenant/, /lost track of which company/] },
  { id: 'error_cross_tenant', patterns: [/cross[- ]tenant/, /blocks that on purpose/] },
  { id: 'error_admin_only', patterns: [/active tenant admins? only/, /reserved for a Client Admin/] },
  { id: 'error_unauthorized', patterns: [/\bunauthorized\b/, /permission denied/, /role check, not a sign-in problem/] },
  { id: 'error_unknown', patterns: [/can.?t tell from your description/] },
];

function findThreadError(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const sig = ERROR_SIGNATURES.find((s) => s.patterns.some((re) => re.test(history[i].text)));
    if (sig) return sig.id;
  }
  return null;
}

// Known actions that can produce a message — each with a plain-English note
// on why nothing the user enters there can cause a workspace/permission error.
const TRIGGERS = [
  {
    id: 'trigger_company_details',
    feature: 'company_details',
    locusLabel: 'the company-details save',
    patterns: [/company details/, /company information/, /sav(e|ing) (my |the |our )?company/],
    label: 'save your company details',
    where: 'on the Getting Started page, in the "Company details" card',
    whatItDoes: "Saving company details only updates your company's name, logo, and branding — it never changes which workspace you're in, and nothing you type there can cause this.",
    navigation: [{ label: 'Open Getting Started', route: '/setup' }],
  },
  {
    id: 'trigger_invite',
    feature: 'team',
    locusLabel: 'the Team invite',
    patterns: [/\binvit(e|ing|ed)\b/, /add(ing)? (a |a new )?(team )?member/],
    label: 'invite a teammate',
    where: 'on the Team page',
    whatItDoes: "Inviting a teammate only creates their invitation — it doesn't touch your workspace settings, so nothing you enter there can cause this.",
    navigation: [{ label: 'Open Team', route: '/team' }],
  },
  {
    id: 'trigger_add_knowledge',
    feature: 'manage',
    locusLabel: 'the add-knowledge save',
    patterns: [/add(ing)? knowledge/, /\bupload(ing)?\b/, /sav(e|ing) (a |the )?source/, /add(ing)? (a |the )?source/],
    label: 'add a knowledge source',
    where: 'on the Add knowledge page',
    whatItDoes: "Adding knowledge only stores the document for your assistant — it doesn't touch your workspace settings, so nothing you enter there can cause this.",
    navigation: [{ label: 'Open Manage', route: '/manage' }],
  },
  {
    id: 'trigger_process',
    feature: 'processes',
    locusLabel: 'the process save',
    patterns: [/sav(e|ing) (a |the )?process/, /add(ing)? (a |the )?process/, /\bprocess form\b/],
    label: 'save a process',
    where: 'on the Processes page',
    whatItDoes: "Describing a process only records how the workflow runs — it doesn't touch your workspace settings, so nothing you enter there can cause this.",
    navigation: [{ label: 'Open Processes', route: '/processes' }],
  },
];

function matchTrigger(lower) {
  for (const t of TRIGGERS) {
    if (t.patterns.some((re) => re.test(lower))) return t;
  }
  return null;
}

function triggerForFeature(featureId) {
  if (!featureId) return null;
  return TRIGGERS.find((t) => t.feature === featureId) || null;
}

// A known trigger from the message text, then from the page/feature the
// planner already extracted, then from a captured error's section.
function triggerFromEvidence(lower, evidence, sc) {
  return (
    matchTrigger(lower) ||
    (evidence && evidence.pageOrFeature && triggerForFeature(evidence.pageOrFeature.id)) ||
    (sc && sc.recentError && sectionToTrigger(sc.recentError.section)) ||
    null
  );
}

function sectionToTrigger(section) {
  if (!section) return null;
  const l = String(section).toLowerCase();
  if (l.includes('company')) return triggerForFeature('company_details');
  if (l.includes('invite') || l.includes('team')) return triggerForFeature('team');
  if (l.includes('knowledge')) return triggerForFeature('manage');
  if (l.includes('process')) return triggerForFeature('processes');
  return null;
}

// The action already names both a page and an action, but the user has NOT
// told us what the message said — acknowledge the action, ask only for the
// wording. Never used when the user already quoted an error.
function genericTriggerAnswer(trigger) {
  return (
    `You're seeing a message when you ${trigger.label} ${trigger.where} — that already narrows it down.\n\n` +
    `What does the message say, exactly? Even a few words of its wording tell me which of MindVault's checks produced it — then I can tell you what it means and what to do.`
  );
}

function triggerAnswer(trigger) {
  return (
    `Thanks — that pinpoints it. You're seeing the message when you ${trigger.label} ${trigger.where}.\n\n` +
    `${trigger.whatItDoes} So this is a system problem on MindVault's side — nothing you entered is wrong.\n\n` +
    `Try this, in order:\n` +
    `1. Reload the page and try the save once more.\n` +
    `2. Sign out and sign back in — that refreshes your workspace connection and clears most cases like this.\n` +
    `3. If it still appears after that, it needs the MindVault team's attention — contact MindVault support with the exact message and the page you were on.`
  );
}

function escalationAnswer() {
  return (
    `Since it's still happening, work through these in order:\n\n` +
    `1. Sign out and sign back in — this refreshes your workspace connection and clears most cases.\n` +
    `2. Try the action once more right after signing back in.\n` +
    `3. If the message still appears, it needs the MindVault team's attention — contact MindVault support with the exact message and the page or button that produces it.\n\n` +
    `Nothing in your settings causes this, so there is nothing further to fix on your side.`
  );
}

function reAskAnswer() {
  return (
    `I still can't tell which action produces the message. Name the button or page you were using — for example ` +
    `"Save company details" on Getting Started, "Invite" on Team, or "Add knowledge" on Manage — ` +
    `and I'll tell you what's happening and what to do.`
  );
}

function answerConversational(lower, history, evidence, sc) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const errorId = findThreadError(history);
  if (!errorId) return null;

  let lastAssistant = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      lastAssistant = history[i];
      break;
    }
  }
  const askedForMore = !!lastAssistant && FOLLOWUP_MARKERS.some((re) => re.test(lastAssistant.text));

  // Is THIS message a contextual follow-up in the open thread, rather than a
  // brand-new unrelated question? A named action, "when(ever) I …", or a
  // "that message / it happens" reference all count.
  const isFollowUp =
    /\b(when(ever)? i|i (click|clicked|try|tried|was|hit|press|pressed)|the (button|page|form|card)|that (message|error)|it (happens|comes up|does that|still)|happens when|only when)\b/.test(lower) ||
    !!(evidence && evidence.actionAttempted && !evidence.isQuestion) ||
    !!(evidence && evidence.pageOrFeature && !evidence.isQuestion);
  const newUnrelatedQuestion =
    /^(what|where|how|why|when|who|which|is|are|can|does|do|should)\b/.test(lower) && !isFollowUp;
  const stillFailing =
    /\b(still|again|tried (that|again)|did that)\b/.test(lower) &&
    /\b(doesn.?t|does not|not work(ing)?|comes up|happens|failing|error|message|issue|problem)\b/.test(lower);

  if (newUnrelatedQuestion) return null;
  if (stillFailing) return { answer: escalationAnswer(), sources: SUPPORT_SOURCE, navigation: [] };

  if (isFollowUp || askedForMore) {
    const trigger = triggerFromEvidence(lower, evidence, sc);
    if (trigger) return { answer: triggerAnswer(trigger), sources: SUPPORT_SOURCE, navigation: trigger.navigation };
    if (askedForMore) return { answer: reAskAnswer(), sources: SUPPORT_SOURCE, navigation: [] };
  }
  return null;
}

// A generic "I need help" cue that isn't itself a definition/how-to/location
// question — used only to route a message to the recently-captured error.
const HELP_CUE =
  /\b(help|stuck|problem|issue|something.?s wrong|what.?s wrong|not work(ing)?|doesn.?t work|won.?t (save|let|work)|can.?t (save|get|do)|failing|broke(n)?|what do i do)\b/;

// ---------------------------------------------------------------------------
// Entry point. Order: (0) conversation awareness, (1) errors — from the
// user's own words, a paraphrase + cue, OR a just-captured application
// error, (2) internal terminology, (3) page locations. Returns null when
// none applies and the caller falls through to the setup copilot / corpus.
// ---------------------------------------------------------------------------

/**
 * @param {string} question
 * @param {{
 *   route?: string,
 *   setup?: object,
 *   topics?: object[],
 *   history?: {role:string,text:string}[],
 *   supportContext?: object,
 * }} [context]
 * @returns {{answer: string, sources: object[], navigation: object[]} | null}
 */
export function answerSupportQuestion(question, context = {}) {
  const lower = String(question || '').toLowerCase();
  const evidence = extractEvidence(question);
  const sc = context.supportContext || null;

  // (0) An in-thread follow-up reply.
  const convo = answerConversational(lower, context.history, evidence, sc);
  if (convo) return convo;

  // (1) An error the user is asking about — identified from their own words
  // (evidence.errorKey), a paraphrase backed by an error cue, or the most
  // recent error the app captured for this session.
  const capturedKey = sc && sc.recentError ? classifyError(sc.recentError.message) : null;
  const errorKey = evidence.errorKey || matchSystemErrorKey(lower) || capturedKey;
  if (errorKey) {
    // The paraphrase path must still require an error cue so a plain
    // terminology/location question ("where do I choose my tenant?") isn't
    // treated as an error report.
    const viaWords = !!(evidence.errorKey || matchSystemErrorKey(lower));
    if (viaWords || evidence.isErrorReport || HELP_CUE.test(lower)) {
      return composeErrorAnswer(errorKey, evidence, sc, lower);
    }
  }
  // A clear error report we can't classify — never re-ask for wording the
  // user already quoted.
  if (evidence.isErrorReport && (/\b(error|message|warning|popup|toast|dialog)\b/.test(lower) || evidence.quotedError)) {
    return composeGenericErrorAnswer(evidence, sc, lower);
  }

  // (2) Page locations — a "where is X?" question is a location answer even
  // when X is also an internal term (e.g. "where do I select my tenant?").
  const location = matchPageLocation(lower, context);
  if (location) return { answer: location.answer, sources: SUPPORT_SOURCE, navigation: location.navigation };

  // (3) Internal terminology.
  for (const term of INTERNAL_TERMS) {
    if (term.patterns.some((re) => re.test(lower))) {
      return { answer: term.answer, sources: SUPPORT_SOURCE, navigation: [] };
    }
  }

  return null;
}