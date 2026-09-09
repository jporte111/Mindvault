// MindVault Help — the product-support layer: system errors, internal
// terminology, and page locations. Pure and deterministic, with no imports,
// no network, and no customer data. It runs BEFORE the setup copilot and the
// corpus retrieval (see answer.js) so a question about an error message, an
// internal term, or where a page lives always gets THAT answer — never a
// generic onboarding response.
//
// Plain-business-language discipline:
//   - internal terms (tenant, tenant_id, RLS, scope resolution, membership
//     record, guarded function, Super Admin) are EXPLAINED, never asked of
//     the user, and the user is never told to configure them
//   - a quoted or paraphrased system error is troubleshooting context:
//     what it means, whether anything is needed, where to go, and ONE
//     targeted follow-up question
//   - when the trigger of an error cannot be determined, this says so — it
//     never invents a workflow
//   - troubleshooting is CONVERSATION-AWARE: a follow-up reply ("whenever I
//     click 'save company details'...") is resolved against the thread it
//     answers — matched to a known action, given real retry steps, or
//     escalated — never re-answered as a context-free question
//   - page locations use only the CURRENT Client Admin navigation names:
//     Home, Knowledge, AI Assistant, Processes, Team, Manage, Getting Started

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
// System errors — a quoted or paraphrased error message is troubleshooting
// context, never a request for general setup instructions. "Strong" phrases
// fire on their own; "soft" paraphrases additionally require an
// error-reporting cue, so a question like "Where do I choose my tenant?"
// stays a terminology question rather than being treated as an error report.
// ---------------------------------------------------------------------------

const ERROR_CUE =
  /\b(says?|said|shows?|showed|told me|gave me|keeps? saying|keeps? getting|error|message|warning|popup|denied|blocked|when i (click|try|save|invite)|tried to|trying to)\b/;

const SYSTEM_ERRORS = [
  {
    id: 'error_tenant_scope',
    strong: [/a tenant must be specified/, /tenant must be (specified|chosen|selected)/],
    soft: [
      /specif(y|ies|ied|ying) (a |the |my )?tenant/,
      /\bchoose a tenant\b/,
      /\bselect a tenant\b/,
      /\btenant (is )?required\b/,
    ],
    answer:
      "That message doesn't mean you need to pick anything. MindVault assigns your company's workspace — sometimes called a \"tenant\" — automatically when you sign in, and you never choose it manually.\n\nIt usually means one of two things: a system error, or an admin-only action that lost track of which company it was acting on. Either way it is on MindVault's side, not a setting you are missing.\n\nWhat page or button produced the message? Tell me and I can help you fix it.",
  },
  {
    id: 'error_unauthorized',
    strong: [/\bunauthorized\b/, /\bnot authorized\b/, /permission denied/],
    soft: [/\b403\b/, /don'?t have permission/],
    answer:
      "That message means your account doesn't have permission for that specific action — it is a role check, not a sign-in problem.\n\nClient Admins manage their company's settings, knowledge, and team; Client Users ask questions and browse knowledge. You don't need to do anything unless you expected the action to be allowed — in that case, ask a Client Admin to check your role on the Team page.\n\nWhat were you trying to do when it appeared?",
  },
  {
    id: 'error_admin_only',
    strong: [/active tenant admins? only/, /tenant admins? only/],
    soft: [],
    answer:
      "That action is reserved for a Client Admin whose membership in your company's workspace is active — it is a role check, not an error in anything you did.\n\nIf you are a Client User, ask one of your company's Client Admins to perform it, or to update your role on the Team page. If you are a Client Admin and still see the message, it is a system problem on MindVault's side.\n\nWhat action were you trying to perform?",
  },
  {
    id: 'error_cross_tenant',
    strong: [/cross[- ]tenant/],
    soft: [/cross[- ]company/],
    answer:
      "That message means the action touched a different company's workspace than the one you belong to. MindVault blocks that on purpose — it is how each company's information stays private — and it is not something you can or should work around.\n\nNothing you configure causes it, and your own company's data is unaffected. If it appeared during normal use, it is a system problem on MindVault's side.\n\nWhat were you clicking when it appeared?",
  },
];

const GENERIC_ERROR = {
  id: 'error_unknown',
  answer:
    "I can't tell from your description which action produced that message, and I would rather not guess.\n\nWhat were you clicking when it appeared — and what did the message say, exactly? With that I can tell you what it means and what to do.",
};

function matchSystemError(lower) {
  for (const e of SYSTEM_ERRORS) {
    if (e.strong.some((re) => re.test(lower))) return e;
  }
  for (const e of SYSTEM_ERRORS) {
    if (e.soft.length > 0 && ERROR_CUE.test(lower) && e.soft.some((re) => re.test(lower))) return e;
  }
  if (/\b(error|message|warning)\b/.test(lower) && ERROR_CUE.test(lower)) return GENERIC_ERROR;
  return null;
}

// ---------------------------------------------------------------------------
// Page locations — "Where is X?" answered with the current navigation and
// current page names only (no deprecated "Library"/"Admin" pages).
// ---------------------------------------------------------------------------

const LOCATOR = /\bwhere\b|\bhow do i (get to|find|open|go to)\b/;

const PAGE_LOCATIONS = [
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
  /what were you (clicking|trying to do) when/i,
  /what action were you trying/i,
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
    patterns: [/company details/, /company information/, /sav(e|ing) (my |the |our )?company/],
    label: 'save your company details',
    where: 'on the Getting Started page, in the "Company details" card',
    whatItDoes: "Saving company details only updates your company's name, logo, and branding — it never changes which workspace you're in, and nothing you type there can cause this.",
    navigation: [{ label: 'Open Getting Started', route: '/setup' }],
  },
  {
    id: 'trigger_invite',
    patterns: [/\binvit(e|ing|ed)\b/, /add(ing)? (a |a new )?(team )?member/],
    label: 'invite a teammate',
    where: 'on the Team page',
    whatItDoes: "Inviting a teammate only creates their invitation — it doesn't touch your workspace settings, so nothing you enter there can cause this.",
    navigation: [{ label: 'Open Team', route: '/team' }],
  },
  {
    id: 'trigger_add_knowledge',
    patterns: [/add(ing)? knowledge/, /\bupload(ing)?\b/, /sav(e|ing) (a |the )?source/, /add(ing)? (a |the )?source/],
    label: 'add a knowledge source',
    where: 'on the Add knowledge page',
    whatItDoes: "Adding knowledge only stores the document for your assistant — it doesn't touch your workspace settings, so nothing you enter there can cause this.",
    navigation: [{ label: 'Open Manage', route: '/manage' }],
  },
  {
    id: 'trigger_process',
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

function genericTriggerAnswer(trigger) {
  return (
    `You're seeing a message when you ${trigger.label} ${trigger.where} — that already narrows it down.\n\n` +
    `What did the message say, exactly? Even a few words of its wording tell me which of MindVault's checks produced it — then I can tell you what it means and what to do.`
  );
}

function answerConversational(lower, history) {
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
  const awaitingFollowUp = !!lastAssistant && FOLLOWUP_MARKERS.some((re) => re.test(lastAssistant.text));

  // A clearly new, unrelated question is never hijacked by the open thread.
  const newQuestion =
    /^(what|where|how|why|when|who|which|is|are|can|does|do|should)\b/.test(lower) &&
    !/\b(when(ever)? i|i (click|click(ed)?|try|tried|was)|the (button|page|form|card))\b/.test(lower);
  const stillFailing =
    /\b(still|again)\b/.test(lower) &&
    /\b(doesn.?t|does not|not work(ing)?|comes up|happens|failing|error|message|issue|problem)\b/.test(lower);

  if (awaitingFollowUp) {
    if (newQuestion) return null;
    const trigger = matchTrigger(lower);
    if (trigger) return { answer: triggerAnswer(trigger), sources: SUPPORT_SOURCE, navigation: trigger.navigation };
    if (stillFailing) return { answer: escalationAnswer(), sources: SUPPORT_SOURCE, navigation: [] };
    return { answer: reAskAnswer(), sources: SUPPORT_SOURCE, navigation: [] };
  }
  if (stillFailing) return { answer: escalationAnswer(), sources: SUPPORT_SOURCE, navigation: [] };
  return null;
}

// ---------------------------------------------------------------------------
// Entry point — checked in this exact order: (0) conversation awareness,
// (1) system errors, (2) internal terminology, (3) page locations. Returns
// null when none applies, and the caller falls through to the setup copilot /
// corpus retrieval.
// ---------------------------------------------------------------------------

/**
 * @param {string} question
 * @param {{route?: string, setup?: object, topics?: object[]}} [context]
 * @returns {{answer: string, sources: object[], navigation: object[]} | null}
 */
export function answerSupportQuestion(question, context = {}) {
  const lower = String(question || '').toLowerCase();

  const convo = answerConversational(lower, context.history);
  if (convo) return convo;

  const error = matchSystemError(lower);
  if (error) {
    if (error === GENERIC_ERROR) {
      const trigger = matchTrigger(lower);
      if (trigger) {
        return { answer: genericTriggerAnswer(trigger), sources: SUPPORT_SOURCE, navigation: trigger.navigation };
      }
    }
    return { answer: error.answer, sources: SUPPORT_SOURCE, navigation: [] };
  }

  for (const term of INTERNAL_TERMS) {
    if (term.patterns.some((re) => re.test(lower))) {
      return { answer: term.answer, sources: SUPPORT_SOURCE, navigation: [] };
    }
  }

  const location = matchPageLocation(lower, context);
  if (location) return { answer: location.answer, sources: SUPPORT_SOURCE, navigation: location.navigation };

  return null;
}