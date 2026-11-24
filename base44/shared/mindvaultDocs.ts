// MindVault product manual — the authoritative description of how the app
// works, used to ground the in-app Admin Help assistant (askAdminHelp).
//
// This is PRODUCT documentation, never customer data: no tenant content, no
// user records, no secrets. It describes the pages, vocabulary, states and
// counters that actually exist in this codebase, so the assistant can explain
// what a screen or a number means without inventing anything.
//
// Keep it in step with the app: if a page, label or state is renamed, update
// this file in the same change.

export const MINDVAULT_PRODUCT_MANUAL = `
# MindVault — product manual

## 1. What MindVault is
MindVault turns a company's own documents and recorded walkthroughs into
trustworthy answers for its team, and gives its admins a view of where
operational knowledge is at risk.

Two sides:
- The knowledge side: Knowledge (library), AI Assistant, My Questions. Used by
  everyone in the company.
- The administration side: Overview, Knowledge (admin), Processes, Assistant,
  Company & Team, Connections, and Operational Continuity when it is enabled.
Explaining how the product works is the job of THIS assistant (MindVault Help).
Answering questions FROM the company's knowledge is the job of the AI
Assistant — a different feature.

## 2. Roles and workspace
- Super Admin (platform admin): the MindVault platform team. Sees Platform
  administration (Strategy Engine, Platform settings) and may administer any
  company workspace.
- Client Admin (company admin): administers exactly their own company's
  workspace — knowledge, processes, team, connections.
- Client User (member): uses Knowledge, AI Assistant and My Questions inside
  their own company only.

A workspace (internally also called a "tenant") is one company's private space.
It is resolved automatically from the signed-in account. Users never choose,
create, copy or type a workspace identifier. Data of different companies is
kept strictly separate: nothing from one workspace is ever visible in another.

## 3. Navigation map
Everyone:
- Home (/): starting point; team members see the assistant entry, admins see
  setup progress and the next recommended step.
- Knowledge (/library): browse and search knowledge sources.
- AI Assistant (/chat): ask questions; every answer shows the sources it used.
- My Questions (/my-questions): a member's own questions and clarification
  threads.

Company administration (Company & Team admins):
- Overview (/overview): the admin's dashboard of attention items, counts and
  shortcuts.
- Knowledge admin (/knowledge): the admin view of knowledge sources with
  their status, classification and review actions.
- Processes (/processes): Operational Processes — the recurring workflows of
  the business, with owner, SME, criticality and review cadence.
- Assistant (/assistant): assistant-related settings and feature toggles.
- Company & Team (/company): company details, branding, members, invitations
  and roles.
- Connections (/connections): connected services (Google Drive read-only sync,
  Dropbox PDF export).
- Operational Continuity (/continuity): the knowledge-risk dashboard. It only
  appears once a platform admin enables it.

Platform administration (Super Admins):
- Strategy Engine (/roadmap): turns knowledge into product opportunities.
- Platform settings (/admin): platform-level tools and diagnostics.

Other routes that still exist and are reachable from links and setup cards:
Getting Started (/setup — the guided checklist and the Company details card),
Manage (/manage — add knowledge sources and processes), Team (/team — invite
members), knowledge source detail (/training/:id), About (/about), Contact
(/contact), Connect (/connect).

## 4. Knowledge sources
A knowledge source is one document or recorded walkthrough: an SOP, policy,
process document, checklist, reference, transcript or meeting session.
Supported upload formats: .txt, .md, .vtt, .srt and .docx. Audio and video are
not uploaded directly; a recording is added as its transcript. PDF and legacy
.doc are not accepted.

When a source is added, MindVault extracts its text, summarizes it and
classifies what it contains (steps, decision rules, common mistakes, required
inputs, exceptions, approvals, escalation paths, roles, deadlines, prohibited
actions, verification checkpoints). This extraction is what the AI Assistant
answers from.

Availability (who may use it):
- Unclassified — the default. The assistant CANNOT use it yet.
- Whole company (general) — available to every member.
- Client-specific — available only when working on that client.
Setting availability is a deliberate admin action; a source stays invisible to
the assistant until it is set.

Source status labels shown in the app:
- Processing — MindVault is reading and summarizing it.
- Needs your review — classified? no; or the extraction looked thin.
- Available to the assistant — used in answers (possibly also verified).
- Needs attention — processing failed, it was rejected, or preparing it for the
  assistant failed (a retry is offered).
- Superseded — an older version replaced by a newer one.
- Archived — kept for history, not used by the assistant.

Verification and versions:
- verification_status: unverified, verified, rejected. Rejected sources are
  never used.
- Every saved content change creates a new version; the previous version stays
  in history as superseded. Only the current version is shown, searched,
  analyzed or answered from.
- Sources and processes have a review cadence; the app derives freshness
  (current, due soon, stale) from the last review date plus the interval.
- Lifecycle states a source can be in: draft, in review, changes requested,
  verified, active, archived, rejected. Advanced lifecycle actions live behind
  the knowledge source's own review panel.

## 5. AI Assistant and My Questions
The AI Assistant answers only from knowledge a company admin has made
available, and shows the source behind each answer. If nothing relevant exists
it says so rather than guessing. Members can rate an answer, report a missing
detail, or say they still need help; "still need help" opens a clarification
thread with an SME that appears in My Questions.

## 6. Operational Processes
An Operational Process describes one recurring workflow: what it is, who owns
it, the subject-matter expert (and backup), how critical it is (low, medium,
high, mission critical) and how often it should be reviewed. Knowledge sources
can be linked to a process. Governance details (owner, SME, cadence,
criticality) live on the process, not duplicated on each source. Processes can
be company-wide or client-specific and are archived rather than deleted.

## 7. Operational Continuity (when enabled)
A read-only dashboard, not a score. It reports four independent bands plus
supporting counts:
- Coverage: Strong / Partial / Weak — how much of the critical work has
  documented knowledge.
- Currency: Current / Slipping / Overdue — how up to date that knowledge is
  against its review cadence.
- Verification: Confirmed / Mostly confirmed / Review backlog — how much has
  been human-verified.
- Key-person resilience: Resilient / Watch / Exposed — where knowledge or
  ownership sits with one person.
Additional views: knowledge gaps, review queue, monthly snapshots and trends
(compared with the same scope's previous month), and "what changed" between
periods. Nothing on this dashboard changes retrieval or answers.

## 8. Knowledge gaps and clarifications
A knowledge gap is recorded evidence that documented knowledge is missing,
unclear or disputed for a real question. Repeated asks are grouped into one
gap; a gap needs several asks from more than one person before it becomes
actionable ("open"). Admins can assign it, resolve it (source updated, new
source added, duplicate, not applicable), and every governance action is
audited. A clarification is a 1:1 question thread between a member and an SME.

## 9. Strategy Engine (platform admin)
Turns the analyzed knowledge into product opportunities. It has two views:
Feature Ideas from Individual Trainings, and Strategic Product Opportunities.

Running "Run Strategy Analysis" executes three phases in order:
1. Patterns — analyzes the current knowledge sources and writes recurring pain
   points, workflow patterns and decision-rule patterns. Each run REPLACES the
   previous patterns (they are a snapshot of the current knowledge).
2. Clusters — groups feature ideas and patterns into product opportunity
   clusters with scores and priority.
3. Recommendation — produces one product recommendation whose confidence is
   set by how many sources were analyzed: fewer than 15 = Low, 15–29 = Medium,
   30 or more = High.

What each number means:
- "Analyzed transcripts/trainings" in the page header and the dashboard's
  "Analyzed Transcripts" card count CURRENT knowledge sources only — the same
  set the engine analyzes: not archived and not a superseded older version,
  and already summarized (status ready or has a summary).
- The database holds MORE records than that: every saved content change adds a
  version, and archived sources remain stored. So "all stored records" is
  normally larger than "analyzed sources". That difference is version history,
  not extra knowledge.
- Feature ideas come from each analyzed source's own extracted opportunities,
  so one source can contribute several ideas; idea counts are therefore larger
  than the source count.
- Cluster and pattern counts are the number of grouped items produced by the
  last run, not the number of sources.

"Refresh Market Demand" re-researches external market signals for existing
feature ideas and records when each idea was last checked; it does not re-run
the three analysis phases.

## 10. Connections
- Google Drive (read-only): connect a Drive folder tree so documents sync in on
  a daily schedule. Syncing only reads; it never writes to Drive.
- Dropbox: each published knowledge source is exported as its own PDF into the
  configured folder, and its filename is updated when the source title changes.

## 11. Company details and branding
Company name, logo link and brand color are saved on the Company & Team page
(the same fields also appear in Getting Started's "Company details" card). They
change how the workspace looks to its members only.

## 12. Numbers that are easy to confuse
- Stored records vs current sources: history versions and archived sources are
  stored but are not current knowledge.
- Current sources vs available sources: a current source may still be
  unclassified, so the assistant cannot use it yet.
- Sources vs feature ideas: ideas are extracted per source and can be many per
  source.
- Coverage/currency/verification are separate bands — there is no single
  combined "knowledge score".

## 13. Troubleshooting playbook
- Source added but the assistant cannot use it: it is still unclassified.
  Set availability to Whole company or a specific client.
- Source shows "Needs attention": processing or preparing it failed. Open it
  and retry, or delete and add it again.
- Answer cites nothing useful: check that the relevant source is current
  (not superseded/archived), classified, and that its text actually contains
  the answer.
- Analysis button fails: strategy analysis depends on an external AI service;
  a single failure is usually transient. Run it once more. Existing results are
  kept if a run returns nothing usable.
- A permission message: the action is limited to Company & Team admins.
- Anything that keeps failing after a reload and a retry needs the MindVault
  team; send the exact message and the page it happened on.

## 14. How to answer
Be concrete and short. Use the app's current labels. Prefer the exact numbers
from the live facts you are given over general statements. If a fact you need
is not provided, say which page shows it rather than estimating. Never invent
pages, buttons, settings, integrations or numbers. Internal jargon (tenant,
RLS, embeddings, chunks, index) is only explained when the user asks what it
means — never used to tell someone what to configure.
`;