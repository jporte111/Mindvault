// Admin Help Assistant — the curated, version-controlled product-help
// corpus. This is NOT customer knowledge: it teaches an admin how to
// configure and use MindVault itself. It is plain structured data (no
// entity, no embeddings), reviewed and shipped with the app, and it is the
// ONLY source the assistant may answer from.
//
// Every topic reuses the existing product vocabulary — Knowledge, Knowledge
// source, Operational Process, Owner, SME, Backup SME, Criticality, Review
// Cadence, Verification, Operational Continuity, Knowledge Gap — and never
// reintroduces "Training(s)". Where a definition already exists in
// CONCEPT_HELP (the Onboarding-1 popover copy), this corpus reuses that text
// verbatim rather than writing a second, possibly-drifting definition.
//
// Current-semantics discipline (do not relax without re-checking the code):
//   - no PDF ingestion claim
//   - key-person dependency is never inferred from Criticality alone
//   - Operational Continuity has four independent bands, never one combined score
//   - unverified knowledge is not automatically wrong — it still answers
//     questions unless an admin turns on a setting requiring verification
//   - firm-wide / client-specific scope isolation is described as real
//     isolation, not a soft preference
//   - no implementation jargon (embeddings, vector, retrieval mode, chunk,
//     schema, index, fingerprint) — those stay internal

// Neither module below imports from here, so reusing their exports is safe
// and keeps this corpus from drifting out of sync with the real product.
// Relative imports (not the @/ alias) so this module stays importable from
// plain `node --test`, the same way every other pure src/lib file is tested.
import { CONCEPT_HELP } from '../conceptHelp.js';
import { SUPPORTED_UPLOAD_HINT } from '../knowledgeSource.js';

const NAV_LIBRARY = { label: 'Open Knowledge', route: '/library' };
const NAV_CHAT = { label: 'Open AI Assistant', route: '/chat' };
const NAV_ADMIN = { label: 'Open Settings', route: '/admin' };
const NAV_CONTINUITY = { label: 'Open Operational Continuity', route: '/continuity' };
const NAV_GETTING_STARTED = { label: 'Open Getting Started', route: '/setup' };
const NAV_COMPANY_DETAILS = { label: 'Open Company Details', route: '/setup#company-details' };
const NAV_ADD_KNOWLEDGE = { label: 'Add Knowledge', route: '/manage#manage-knowledge' };
const NAV_TEAM = { label: 'Open Team', route: '/team' };
const NAV_PROCESSES = { label: 'Open Processes', route: '/processes' };

// Roles that manage a workspace and can reach the Client Admin pages.
const ADMIN_ROLES = ['client_admin', 'super_admin'];

function topic(t) {
  return {
    keywords: [],
    phrases: [],
    caveats: '',
    related: [],
    navigation: [],
    // Optional deep-link metadata: `route` (+ optional `anchor`) is the
    // canonical destination for this topic; `roles`, when non-empty, limits
    // which app roles are offered its navigation action.
    route: null,
    anchor: null,
    roles: [],
    ...t,
  };
}

export const ADMIN_HELP_TOPICS = [
  topic({
    id: 'product_overview',
    title: 'What MindVault is',
    keywords: ['overview', 'what is mindvault', 'about mindvault', 'product overview'],
    summary: 'MindVault turns your team’s know-how into answers employees can trust, and gives leadership a clear view of where operational knowledge is at risk.',
    whatItIs: 'MindVault has two sides: the Knowledge page your team searches and asks questions against through the AI Assistant, and the Client Admin side — Home, Getting Started, Manage, Processes, and Team — where you add knowledge, describe how your organization works, and invite your team. Platform admins can additionally review Operational Continuity when it’s turned on.',
    whyItMatters: 'The Knowledge page and AI Assistant are only as good as what an admin has put into them — MindVault does not know anything about your business beyond the knowledge you’ve added and classified.',
    howToUse: 'Start at Home: it shows your setup progress and your next recommended step, with links to Getting Started (the full checklist), Manage (add knowledge), and Team (invite your team).',
    whereToFind: 'Home, Knowledge, AI Assistant, Processes, and Team are the main areas in the left navigation; Home and Getting Started guide initial setup.',
    caveats: 'This assistant explains how MindVault works. It does not answer questions from your company’s own knowledge — use the AI Assistant for that.',
    related: ['getting_started', 'knowledge_library', 'operational_processes', 'operational_continuity'],
  }),

  topic({
    id: 'getting_started',
    title: 'What to set up first',
    keywords: ['getting started', 'first', 'set up', 'setup', 'configure', 'start', 'where do i start'],
    summary: 'Add a few knowledge sources, create the 3–5 Operational Processes the business could least afford to lose, then work through the 7-step guided setup on the Getting Started page.',
    whatItIs: 'A recommended order of operations for a new admin — not a required workflow. You can use MindVault before every step is done.',
    whyItMatters: 'Doing these in roughly this order means the AI Assistant has something useful to answer from, and Operational Continuity (once enabled) has real data instead of a mostly-empty dashboard.',
    howToUse: 'Follow the 7 guided steps: company details, invite your team, upload your first knowledge source, make it available, describe a process, test the AI Assistant, then optionally review team permissions. Progress is tracked automatically.',
    whereToFind: 'Home shows your progress; the Getting Started page has the full checklist.',
    caveats: 'There is no scored “health grade” anywhere in MindVault — the checklist only counts how many of its 7 steps are Complete.',
    related: ['setup_checklist', 'company_details', 'adding_knowledge', 'operational_processes', 'guided_tour'],
    route: '/setup',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_GETTING_STARTED, topic: 'getting_started' }],
  }),

  topic({
    id: 'company_details',
    title: 'Company details',
    keywords: [
      'company details', 'company information', 'company info', 'company profile',
      'company name', 'business name', 'organization name', 'org name', 'rename company',
      'logo', 'logo link', 'company logo', 'brand color', 'brand colour', 'branding',
      'company settings', 'update company details', 'change company information', 'edit company name',
    ],
    phrases: [
      'update company details', 'change company information', 'edit company name',
      'update company logo', 'change company logo', 'update brand color', 'change brand color',
      'company name', 'business name', 'company settings',
    ],
    summary: 'Your company name, logo, and brand color are set on the Getting Started page in the “Company details” card. You can change them any time — the form is always pre-filled with what’s saved.',
    whatItIs: 'Three fields that control how your company appears to your team inside MindVault: the company name shown in the sidebar, an optional link to a logo image, and a brand color used for small accents.',
    whyItMatters: 'It makes the workspace recognisably yours, and your team sees the change everywhere MindVault shows your company identity.',
    howToUse: 'Open Getting Started → Company details, change the company name, logo link, or brand color, and click “Save company details”. Your updated name, logo, and color then appear across MindVault.',
    whereToFind: 'Getting Started → the “Company details” card (the first setup step). Reach Getting Started from Home.',
    caveats: 'There is no separate “Company settings” page — this card is the only place these live. Adding a logo or brand color also marks the “Add your company details” setup step complete.',
    related: ['getting_started', 'setup_checklist', 'permissions'],
    route: '/setup',
    anchor: 'company-details',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_COMPANY_DETAILS, topic: 'company_details' }],
  }),

  topic({
    id: 'knowledge_library',
    title: 'Knowledge page',
    keywords: ['library', 'knowledge library', 'browse knowledge', 'search knowledge'],
    summary: 'The Knowledge page is where every knowledge source lives — SOPs, process docs, policies, recordings, and other operational knowledge the AI Assistant answers from.',
    whatItIs: 'A searchable, filterable list of every knowledge source your team has added.',
    whyItMatters: 'It’s the one place to see everything MindVault has to work with, and to spot what’s missing or still unclassified.',
    howToUse: 'Search by keyword, or use the filters to narrow by topic, client segment, or software. Open any source to review its details.',
    whereToFind: 'The Knowledge page, in the left navigation.',
    caveats: 'Only classified, active knowledge answers questions in the AI Assistant — a source still awaiting classification (“Needs review”) is visible here but won’t be used to answer.',
    related: ['adding_knowledge', 'knowledge_scope', 'ai_assistant'],
    route: '/library',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_LIBRARY, topic: 'knowledge_library' }],
  }),

  topic({
    id: 'adding_knowledge',
    title: 'Adding knowledge',
    keywords: [
      'add knowledge', 'upload knowledge', 'add a source', 'add a knowledge source',
      'submit a recording', 'sync google drive', 'import knowledge',
      'sop', 'policy', 'handbook', 'procedure document',
    ],
    phrases: [
      'add knowledge', 'upload knowledge', 'add a knowledge source', 'upload an sop',
      'add a policy', 'upload a document', 'import a handbook', 'upload a handbook',
    ],
    summary: 'Add knowledge from the Knowledge page’s “Add Knowledge” button, or from the Manage page — upload a file, paste text, or sync a Google Drive folder.',
    whatItIs: 'A knowledge source can be an SOP, policy, handbook, process document, recording, pasted text, or a Google Drive sync.',
    whyItMatters: 'The more real operational knowledge you add — and classify — the more the AI Assistant can actually help with.',
    howToUse: 'Click “Add Knowledge” on the Knowledge page, or use the upload area on Manage. Give it a clear title, and pick the source type when asked.',
    whereToFind: 'Knowledge → Add Knowledge, or the Manage page (the “Add knowledge” section).',
    caveats: `Newly added knowledge starts out unclassified (“Needs review”) and won’t answer questions until you set its scope. ${SUPPORTED_UPLOAD_HINT} — PDF is not currently a supported upload format.`,
    related: ['knowledge_library', 'knowledge_scope'],
    route: '/manage',
    anchor: 'manage-knowledge',
    roles: ADMIN_ROLES,
    navigation: [
      { ...NAV_ADD_KNOWLEDGE, topic: 'adding_knowledge' },
      { ...NAV_LIBRARY, topic: 'adding_knowledge' },
    ],
  }),

  topic({
    id: 'knowledge_scope',
    title: CONCEPT_HELP.scope.term,
    keywords: ['scope', 'firm-wide', 'client-specific', 'client isolation', 'general knowledge', 'make knowledge client specific'],
    summary: CONCEPT_HELP.scope.text,
    whatItIs: CONCEPT_HELP.scope.text,
    whyItMatters: 'Getting scope right keeps one client’s information from ever showing up in another client’s answers, while keeping genuinely firm-wide knowledge available to everyone.',
    howToUse: 'When you add a source on the Manage page, choose who can use it: everyone in your company, or only when working on a specific client. Unclassified knowledge stays out of the AI Assistant until you do this.',
    whereToFind: 'Manage → the availability choice on each knowledge source.',
    caveats: 'There is no partial or fuzzy scope — a source is either firm-wide, tied to exactly one client, or unclassified. Client-specific knowledge is only ever used in that client’s own context; it never crosses over to another client.',
    related: ['adding_knowledge', 'ai_assistant'],
    phrases: ['company wide knowledge', 'client specific knowledge', 'make knowledge client specific', 'who can see knowledge'],
    route: '/manage',
    anchor: 'manage-knowledge',
    roles: ADMIN_ROLES,
    navigation: [{ label: 'Add Knowledge', route: '/manage#manage-knowledge', topic: 'knowledge_scope' }],
  }),

  topic({
    id: 'ai_assistant',
    title: 'AI Assistant',
    keywords: ['ai assistant', 'chat', 'ask a question', 'chatbot', 'assistant'],
    summary: 'Employees ask questions in plain language in the AI Assistant and get answers grounded in your classified knowledge, with sources cited.',
    whatItIs: 'A chat interface for employees, separate from this Admin Help Assistant.',
    whyItMatters: 'It’s how the knowledge you add and classify actually reaches employees, in their own words.',
    howToUse: 'Type a real operational question — how to complete a workflow, what approval is needed, what to do for an exception. If a client-context selector is shown, pick the right firm-wide/client scope first.',
    whereToFind: 'AI Assistant, in the main navigation.',
    caveats: 'Answers are grounded in your classified knowledge, not automatically organization-“approved” — Verification is a separate, optional signal. If nothing relevant is classified, the assistant says so rather than guessing.',
    related: ['knowledge_scope', 'verification', 'knowledge_gaps', 'question_history'],
    route: '/chat',
    roles: ['client_admin', 'client_user', 'super_admin'],
    navigation: [{ ...NAV_CHAT, topic: 'ai_assistant' }],
  }),

  topic({
    id: 'operational_processes',
    title: 'Operational Processes',
    keywords: ['operational process', 'process', 'workflow', 'processes', 'operational processes'],
    phrases: [
      'create a process', 'edit a process', 'archive a process', 'restore a process',
      'add a process', 'update a process',
    ],
    summary: 'An Operational Process is a business workflow — like monthly bank reconciliation — not an individual document. Knowledge sources link to the process they document.',
    whatItIs: 'A process record with an Owner, SME, optional Backup SME, Criticality, and a review cadence. It’s the unit Operational Continuity is organized around.',
    whyItMatters: 'Linking knowledge to processes is what lets MindVault tell you which important workflows are actually documented, owned, and current — versus which ones are running on nobody’s calendar.',
    howToUse: 'On the Processes page: click “Add process” to create one, name it after the real workflow, then set its Owner, SME, Backup SME (where it matters), Criticality, and review interval. Use the pencil to edit a process, and Archive / Restore to retire or bring one back. Link the knowledge sources that document it.',
    whereToFind: 'Processes, in the left navigation.',
    caveats: 'Start with the 3–5 workflows the business could least afford to lose — you don’t need to model everything on day one. Archiving a process keeps its history; it doesn’t delete anything.',
    related: ['owner', 'sme', 'backup_sme', 'criticality', 'review_cadence'],
    route: '/processes',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_PROCESSES, topic: 'operational_processes' }],
  }),

  topic({
    id: 'owner',
    title: CONCEPT_HELP.owner.term,
    keywords: ['owner', 'process owner', 'difference between owner and sme'],
    summary: CONCEPT_HELP.owner.text,
    whatItIs: CONCEPT_HELP.owner.text,
    whyItMatters: 'Without an Owner, nobody is accountable for keeping a process’s knowledge current — it shows up as a gap in both the Setup Checklist and Operational Continuity.',
    howToUse: 'Set the Owner field when creating or editing an Operational Process.',
    whereToFind: 'Processes, in the left navigation.',
    caveats: 'Exactly one Owner per process — it’s a single field, not a list. An Owner and an SME can be the same person on a small team.',
    related: ['operational_processes', 'sme', 'backup_sme'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'owner' }],
  }),

  topic({
    id: 'sme',
    title: CONCEPT_HELP.sme.term,
    keywords: ['sme', 'subject matter expert', 'subject-matter expert', 'difference between owner and sme'],
    summary: CONCEPT_HELP.sme.text,
    whatItIs: CONCEPT_HELP.sme.text,
    whyItMatters: 'The SME is who you’d actually ask if the documentation didn’t cover something — distinct from the Owner, who is accountable but may not do the work day to day.',
    howToUse: 'Set the Subject-matter expert field on the Operational Process.',
    whereToFind: 'Processes, in the left navigation.',
    caveats: 'MindVault doesn’t require the Owner and SME to be different people.',
    related: ['owner', 'backup_sme', 'operational_processes'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'sme' }],
  }),

  topic({
    id: 'backup_sme',
    title: CONCEPT_HELP.backup_sme.term,
    keywords: ['backup sme', 'backup', 'when should i assign a backup', 'single point of failure'],
    summary: CONCEPT_HELP.backup_sme.text,
    whatItIs: CONCEPT_HELP.backup_sme.text,
    whyItMatters: 'A process with only one person who can run it is a key-person dependency — the exact thing Operational Continuity’s key-person signal watches for.',
    howToUse: 'Set the Backup SME field where a real second person could keep the process running if the SME were unavailable.',
    whereToFind: 'Processes, in the left navigation.',
    caveats: 'A high or mission-critical process is NOT automatically flagged just because it lacks a Backup SME — MindVault only raises a key-person finding from an actual established dependency in your Owner/SME/Backup data, never from Criticality alone.',
    related: ['sme', 'key_person_dependency', 'criticality'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'backup_sme' }],
  }),

  topic({
    id: 'criticality',
    title: CONCEPT_HELP.criticality.term,
    keywords: ['criticality', 'priority', 'critical', 'what does criticality mean'],
    summary: CONCEPT_HELP.criticality.text,
    whatItIs: CONCEPT_HELP.criticality.text,
    whyItMatters: 'It decides what shows up first on the Operational Continuity dashboard and in the review queue.',
    howToUse: 'Set Criticality (low / medium / high / mission critical) when creating or editing an Operational Process.',
    whereToFind: 'Processes, in the left navigation.',
    caveats: 'Criticality alone doesn’t imply a Backup SME is required, and it doesn’t feed into any single combined score — MindVault uses it to prioritize attention, not to compute a grade.',
    related: ['operational_processes', 'operational_continuity'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'criticality' }],
  }),

  topic({
    id: 'review_cadence',
    title: CONCEPT_HELP.review_cadence.term,
    keywords: ['review cadence', 'review interval', 'how often should knowledge be reviewed', 'cadence'],
    summary: CONCEPT_HELP.review_cadence.text,
    whatItIs: CONCEPT_HELP.review_cadence.text,
    whyItMatters: 'It’s what Operational Continuity’s Currency signal is built from — how much of your reviewable knowledge is actually on schedule.',
    howToUse: 'Set a review interval (for example, every 90 days) on a knowledge source directly, or on its Operational Process — a source without its own cadence inherits its process’s cadence.',
    whereToFind: 'Processes, or a knowledge source’s own settings.',
    caveats: 'There’s no single global cadence — every source or process can have its own, and having none set is treated as “no schedule,” not as overdue.',
    related: ['verification', 'operational_processes', 'currency'],
    navigation: [{ label: 'Open Processes', route: '/processes', topic: 'review_cadence' }],
  }),

  topic({
    id: 'verification',
    title: CONCEPT_HELP.verification.term,
    keywords: ['verification', 'verified', 'unverified', 'why is knowledge unverified', 'confirm knowledge'],
    summary: CONCEPT_HELP.verification.text,
    whatItIs: CONCEPT_HELP.verification.text,
    whyItMatters: 'It’s the clearest signal to employees and leadership that someone has actually confirmed a piece of knowledge, rather than it just having been collected.',
    howToUse: 'Mark a source verified from its detail page or the knowledge management tools once you’ve confirmed it’s accurate and current.',
whereToFind: 'A source’s own detail page, or the knowledge-management tools on the Settings page (platform admins).',
    caveats: 'Unverified is not the same as wrong — most knowledge starts unverified and still answers questions normally. You can turn on a setting that requires verification before knowledge is used at all, but that setting is off by default.',
    related: ['review_cadence', 'lifecycle', 'common_troubleshooting'],
    navigation: [{ ...NAV_ADMIN, topic: 'verification' }],
  }),

  topic({
    id: 'lifecycle',
    title: 'Knowledge Lifecycle',
    keywords: ['lifecycle', 'draft', 'in review', 'published', 'version history', 'source lifecycle'],
    summary: 'An optional, flag-gated workflow that moves a knowledge source through draft → in review → verified → published, and keeps its version history.',
    whatItIs: 'When turned on, editing a published source creates a new draft version; only the active/published version answers questions, and every prior version stays inspectable.',
    whyItMatters: 'It adds a formal review-and-approve step, and a record of what changed and when, for knowledge that needs tighter governance than “just edit it.”',
    howToUse: 'Open the lifecycle tools on the Settings page (platform admins) to send a draft for review, approve it, publish it, or archive an old version.',
    whereToFind: 'Settings → Knowledge Lifecycle (platform admins).',
    caveats: 'This is optional and off by default — most teams can manage knowledge fine without it. Turn it on under Settings → System (platform admins) if you need formal review and versioning.',
    related: ['verification', 'review_cadence'],
    navigation: [{ ...NAV_ADMIN, topic: 'lifecycle' }],
  }),

  topic({
    id: 'setup_checklist',
    title: 'Setup Checklist',
    keywords: ['setup checklist', 'checklist', 'what to configure', 'what does the checklist mean', 'setup progress', 'review setup progress', 'onboarding progress'],
    phrases: ['review setup progress', 'setup checklist', 'onboarding progress', 'what is left to set up'],
    summary: 'A 7-step guided checklist on the Getting Started page — it shows what’s already done and what still needs attention. There is no score, just a count of completed steps.',
    whatItIs: 'Seven plain-language steps: add your company details, invite your team, upload your first knowledge source, make it available to your team, describe a process, test MindVault, and review team permissions (optional).',
    whyItMatters: 'It’s the fastest way to see, at a glance, what’s left to configure without digging through every admin screen.',
    howToUse: 'Open Getting Started (linked from Home) — each step’s action link takes you straight to the page where you do it.',
    whereToFind: 'Home → Getting Started.',
    caveats: 'Progress is derived automatically from your own workspace data, so it is always current and resumable. You don’t need to finish it before using MindVault; nothing is blocked by an incomplete checklist.',
    related: ['getting_started', 'company_details', 'operational_processes', 'verification'],
    route: '/setup',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_GETTING_STARTED, topic: 'setup_checklist' }],
  }),

  topic({
    id: 'operational_continuity',
    title: 'Operational Continuity',
    keywords: ['operational continuity', 'continuity', 'health dashboard', 'business continuity', 'what is operational continuity'],
    summary: 'Operational Continuity is an admin dashboard showing where important work depends on stale or missing knowledge, unclear ownership, or a single person with no backup.',
    whatItIs: 'A dashboard organized around your Operational Processes, with an overview, a filterable process table, a review queue, a key-person view, and knowledge gaps.',
    whyItMatters: 'It turns “we should probably document more” into a specific, prioritized list of what’s actually at risk.',
    howToUse: 'Review the overview bands, the “Address first” list, and the review queue for what to tackle next. Switch the scope selector to see a specific client instead of firm-wide.',
    whereToFind: 'Operational Continuity, in the main navigation — admin-only, and only visible once the feature is turned on.',
    caveats: 'It’s turned off by default — a platform admin can enable it under Settings → System. It reports four independent signals (Coverage, Currency, Verification, Key-person resilience); there is no single combined score.',
    related: ['coverage', 'currency', 'key_person_dependency', 'knowledge_gaps', 'snapshots'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'operational_continuity' }],
  }),

  topic({
    id: 'coverage',
    title: CONCEPT_HELP.coverage.term,
    keywords: ['coverage', 'what does coverage mean'],
    summary: CONCEPT_HELP.coverage.text,
    whatItIs: CONCEPT_HELP.coverage.text,
    whyItMatters: 'It’s the first question for any critical process: does usable, verified knowledge actually exist behind it, or not?',
    howToUse: 'Check the Coverage band on Operational Continuity’s overview, and the Process Continuity tab for which specific processes are missing documentation.',
    whereToFind: 'Operational Continuity → Overview.',
    caveats: 'Coverage needs a handful of critical processes with a known documentation status before it reports a real band — with too few, or too many “unknown,” it shows Unknown rather than guessing.',
    related: ['operational_continuity', 'verification'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'coverage' }],
  }),

  topic({
    id: 'currency',
    title: CONCEPT_HELP.currency.term,
    keywords: ['currency', 'current', 'overdue review', 'stale knowledge', 'slipping'],
    summary: CONCEPT_HELP.currency.text,
    whatItIs: CONCEPT_HELP.currency.text,
    whyItMatters: 'It’s the difference between knowledge that was accurate once and knowledge that’s still being kept accurate.',
    howToUse: 'If Currency is Slipping or Overdue, open the review queue to see which sources need attention.',
    whereToFind: 'Operational Continuity → Overview.',
    caveats: 'This is separate from Verification — a source can be verified but overdue for its next review, or current on schedule but never verified.',
    related: ['review_cadence', 'verification', 'operational_continuity'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'currency' }],
  }),

  topic({
    id: 'key_person_dependency',
    title: CONCEPT_HELP.key_person.term,
    keywords: ['key person', 'key-person dependency', 'single person', 'no backup', 'what is a key person dependency'],
    summary: CONCEPT_HELP.key_person.text,
    whatItIs: CONCEPT_HELP.key_person.text,
    whyItMatters: 'It’s a resilience question, not a performance one: if this one person were out, could the process still run?',
    howToUse: 'Check the Key-Person Exposure view on Operational Continuity, and add a Backup SME where it’s genuinely warranted.',
    whereToFind: 'Operational Continuity → Key-Person Exposure.',
    caveats: 'This is only raised from an actual established dependency in your Owner/SME/Backup data — never inferred from Criticality alone, and it is not a monitoring tool aimed at any individual.',
    related: ['backup_sme', 'sme', 'operational_continuity'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'key_person_dependency' }],
  }),

  topic({
    id: 'knowledge_gaps',
    title: CONCEPT_HELP.knowledge_gap.term,
    keywords: ['knowledge gap', 'knowledge gaps', 'gap', 'what are knowledge gaps', 'didnt answer'],
    summary: CONCEPT_HELP.knowledge_gap.text,
    whatItIs: CONCEPT_HELP.knowledge_gap.text,
    whyItMatters: 'It turns real employee questions the knowledge base couldn’t fully answer into a concrete, prioritized to-do list for admins.',
    howToUse: 'Review open gaps on Operational Continuity’s Knowledge Gaps tab, and add or correct the knowledge that would resolve each one.',
    whereToFind: 'Operational Continuity → Knowledge Gaps.',
    caveats: 'A gap is evidence, never an answer — it doesn’t change what the AI Assistant says until you actually add or update the knowledge behind it.',
    related: ['ai_assistant', 'operational_continuity'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'knowledge_gaps' }],
  }),

  topic({
    id: 'snapshots',
    title: CONCEPT_HELP.snapshot.term,
    keywords: ['snapshot', 'snapshots', 'monthly snapshot', 'what are snapshots'],
    summary: CONCEPT_HELP.snapshot.text,
    whatItIs: CONCEPT_HELP.snapshot.text,
    whyItMatters: 'Without a monthly history, leadership only ever sees a single point-in-time picture — snapshots are what make trend and “what changed” views possible.',
    howToUse: 'Turn on Knowledge Health Snapshots under Settings → System (platform admins), then check back on Operational Continuity month over month.',
    whereToFind: 'Operational Continuity → Trends.',
    caveats: 'Snapshots only exist once the feature is turned on and at least one month has actually been captured; missing months are shown as gaps, never estimated.',
    related: ['trends', 'what_changed', 'operational_continuity'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'snapshots' }],
  }),

  topic({
    id: 'trends',
    title: 'Trends',
    keywords: ['trends', 'over time', 'improving', 'slipping over time', 'what are trends'],
    summary: 'Trends shows each continuity number’s monthly history so you can see whether things are improving or slipping, not just a single point-in-time reading.',
    whatItIs: 'A per-metric monthly line built from your captured Snapshots.',
    whyItMatters: 'A single “Coverage: Partial” reading doesn’t tell you if you’re getting better or worse — Trends does.',
    howToUse: 'Open the Trends panel on Operational Continuity once at least two months are captured.',
    whereToFind: 'Operational Continuity → Trends.',
    caveats: 'Deterministic counts only — no interpolation and no prediction for months that weren’t captured.',
    related: ['snapshots', 'what_changed'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'trends' }],
  }),

  topic({
    id: 'what_changed',
    title: CONCEPT_HELP.what_changed.term,
    keywords: ['what changed', 'since last month', 'change summary', 'what improved'],
    summary: CONCEPT_HELP.what_changed.text,
    whatItIs: CONCEPT_HELP.what_changed.text,
    whyItMatters: 'It’s the fastest way to answer “is this getting better?” without reading every number yourself.',
    howToUse: 'Open the What Changed card on Operational Continuity’s overview.',
    whereToFind: 'Operational Continuity → What Changed.',
    caveats: 'It compares only the two most recent monthly snapshots — it needs at least two captured periods before it can show anything.',
    related: ['snapshots', 'trends'],
    navigation: [{ ...NAV_CONTINUITY, topic: 'what_changed' }],
  }),

  topic({
    id: 'notifications',
    title: 'Notifications',
    keywords: ['notifications', 'notification bell', 'alerts', 'bell icon'],
    summary: 'An in-app notification bell surfaces items that need attention — like an overdue review, a knowledge gap that’s become actionable, or a process missing an Owner.',
    whatItIs: 'A list of deterministic, rule-based notifications tied to specific conditions (overdue reviews, missing governance fields, key-person findings, and similar).',
    whyItMatters: 'It’s a way to notice something needs attention without having to check Operational Continuity yourself every day.',
    howToUse: 'Open the bell icon to review, mark read, or dismiss a notification.',
    whereToFind: 'The bell icon in the top navigation.',
    caveats: 'Dismissing hides a notification; it only reopens on its own if the underlying condition is still there later. Notifications are in-app only in the current version.',
    related: ['operational_continuity'],
  }),

  topic({
    id: 'permissions',
    title: 'Client Admin and Client User roles',
    keywords: [
      'permissions', 'roles', 'role', 'admin role', 'user role',
      'client admin', 'client user', 'who can see what', 'who can do what',
      'difference between client admin and client user', 'what can a client admin do',
      'what can a client user do',
    ],
    phrases: [
      'difference between client admin and client user', 'client admin vs client user',
      'what can a client user do', 'what can a client admin do',
    ],
    summary: 'MindVault has two member roles: Client Admin — who manages their company’s settings, knowledge, and team — and Client User — who asks questions and browses knowledge.',
    whatItIs: 'A simple two-role model — there is no finer-grained per-process permission system yet.',
    whyItMatters: 'It’s what keeps configuration and governance actions restricted to admins, while everyone else gets a focused, simple experience.',
    howToUse: 'You choose a teammate’s role when you invite them on the Team page, and you can change it any time. See the “Team” help topic for the invite / change-role / revoke steps.',
    whereToFind: 'Team, in the left navigation.',
    caveats: 'Governance actions (owners, SMEs, criticality, verification, and this Help panel itself) are Client Admin-only. A Client User cannot open Getting Started, Manage, Processes, or Team.',
    related: ['team_management', 'operational_continuity', 'setup_checklist'],
    route: '/team',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_TEAM, topic: 'permissions' }],
  }),

  topic({
    id: 'team_management',
    title: 'Team — inviting and managing members',
    keywords: [
      'invite', 'invite a teammate', 'invite someone', 'invite a member', 'invite a colleague',
      'add a team member', 'add a user', 'send an invitation',
      'change a role', 'change someones role', 'promote to admin', 'make someone an admin',
      'revoke access', 'remove a teammate', 'deactivate a member', 'take away access',
      'reactivate', 'restore access', 'reinstate a member', 'manage the team', 'team members',
    ],
    phrases: [
      'invite a teammate', 'invite someone', 'add a team member', 'send an invitation',
      'change a role', 'revoke access', 'reactivate a member', 'restore access',
    ],
    summary: 'Invite, re-role, and revoke or restore teammates on the Team page. Invite by email and pick their role (Client User or Client Admin); change a role or revoke / reactivate access any time from the member list.',
    whatItIs: 'The Team page has an invite box (email + role) and a list of current members with per-member actions.',
    whyItMatters: 'It’s how colleagues get access to ask questions, and how you decide who can also manage settings and knowledge.',
    howToUse: 'Open Team. To invite: enter the email, choose Client User or Client Admin, and send — they join automatically when they first sign in. To change a role, or to revoke or reactivate access, use the controls on that person’s row in the member list.',
    whereToFind: 'Team, in the left navigation.',
    caveats: 'A pending invitation activates on its own when the person accepts and signs in. Revoking access doesn’t delete the person’s account — you can reactivate them later.',
    related: ['permissions', 'setup_checklist'],
    route: '/team',
    roles: ADMIN_ROLES,
    navigation: [{ ...NAV_TEAM, topic: 'team_management' }],
  }),

  topic({
    id: 'common_troubleshooting',
    title: 'Why a source isn’t showing up in AI answers',
    keywords: ['not showing up', 'why isnt', 'missing from ai assistant', 'troubleshoot', 'not appearing', 'source not found'],
    summary: 'The most common reasons a source doesn’t show up in AI Assistant answers: it’s still unclassified (“Needs review”), it’s archived or an older version, it was rejected during verification, it’s outside its effective date window, or — only if your organization requires verification first — it hasn’t been verified yet.',
    whatItIs: 'A short checklist for the single most common admin support question.',
    whyItMatters: 'It’s usually one of a handful of causes, and every one of them is fixable from Admin in a couple of clicks.',
    howToUse: 'Open the source’s own detail page and check its availability, its status, and (if the lifecycle workflow is on) its version state.',
whereToFind: 'A source’s own detail page, or the knowledge-management tools on the Settings page (platform admins).',
    caveats: 'A source being unverified is not, by itself, a reason it’s excluded — unverified knowledge answers questions normally unless your organization has turned on the setting that requires verification first.',
    related: ['knowledge_scope', 'verification', 'lifecycle'],
    navigation: [{ ...NAV_ADMIN, topic: 'common_troubleshooting' }],
  }),

  topic({
    id: 'guided_tour',
    title: 'The guided product tour',
    keywords: ['guided tour', 'product tour', 'restart the tour', 'restart tour', 'walkthrough'],
    summary: 'The guided product tour is a short, admin-only, page-to-page walkthrough of MindVault’s main screens. You can restart it any time.',
    whatItIs: 'An orientation tour that highlights real controls across Knowledge, the AI Assistant, Manage, and Processes.',
    whyItMatters: 'It’s the fastest way for a brand-new admin to see where everything lives, before diving into day-to-day configuration.',
    howToUse: 'Click Help in the sidebar (or the top bar on mobile) to restart it from the beginning, on any page.',
    whereToFind: 'The Help button, admin-only.',
    caveats: 'The guided tour is a one-time orientation; this Admin Help Assistant is for ongoing questions after that.',
    related: ['product_overview', 'setup_checklist'],
  }),

  topic({
    id: 'question_history',
    title: 'AI Assistant question history',
    keywords: [
      'question history', 'previous questions', 'past questions', 'previous ai questions',
      'chat history', 'conversation history', 'previous conversations', 'earlier questions',
      'old questions', 'see what i asked', 'question log', 'my questions',
    ],
    phrases: [
      'previous questions', 'past questions', 'previous ai questions', 'chat history',
      'conversation history', 'see previous questions',
    ],
    summary: 'MindVault does not keep a searchable history of AI Assistant questions. Your current conversation stays on screen, but it is cleared when you reload the page.',
    whatItIs: 'There is no “past questions” page for ordinary AI Assistant chats — each visit starts a fresh conversation.',
    whyItMatters: 'If you need to keep an answer, copy it before you leave or reload the page.',
    howToUse: 'Ask again in the AI Assistant if you need the answer once more — it re-answers from your current knowledge.',
    whereToFind: 'Normal chat history is not saved anywhere. If your organization has turned on the clarification workflow, questions you deliberately escalated to a subject-matter expert (not ordinary chats) appear under “My questions”, reached from a link on the AI Assistant page.',
    caveats: '“My questions” only holds questions you escalated to an expert — it is not a log of everything you have asked. A saved, searchable chat history is a possible future addition, not something MindVault does today.',
    related: ['ai_assistant', 'knowledge_gaps'],
  }),

  topic({
    id: 'mindvault_help',
    title: 'MindVault Help',
    keywords: [
      'mindvault help', 'help panel', 'this assistant', 'what is this help', 'admin help',
      'help assistant', 'what does help do', 'how does help work',
    ],
    phrases: ['what is mindvault help', 'what does this assistant do', 'how does help work'],
    summary: 'MindVault Help — this panel — explains how to set up and use MindVault itself. It is separate from the AI Assistant, which answers from your company’s own knowledge.',
    whatItIs: 'A deterministic, built-in product guide for the people who configure MindVault. It reads your live setup progress and the page you are on, never your company’s knowledge.',
    whyItMatters: 'Ask it “how do I …” questions about MindVault; ask the AI Assistant your day-to-day operational questions.',
    howToUse: 'Type a question about a MindVault screen or task. Where it helps, the answer includes a button that takes you straight to the right page.',
    whereToFind: 'The Help button in the sidebar (or the top bar on mobile).',
    caveats: 'It does not answer from your company knowledge and it makes no changes on your behalf — it only explains and links.',
    related: ['product_overview', 'guided_tour', 'ai_assistant'],
  }),
];

export const ADMIN_HELP_TOPIC_IDS = ADMIN_HELP_TOPICS.map((t) => t.id);