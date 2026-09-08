// Client Admin guided setup — pure, deterministic derivation of the setup
// checklist. Every item is a plain function of data the product already
// reads: the caller's own workspace record, their tenant member list, their
// knowledge sources (RLS-scoped to their tenant), their processes, and the
// signed-in user's own saved setup flags.
//
// States: 'Complete' | 'In progress' | 'Not started' | 'Unknown'
//
// Manual steps (completed by the user rather than derived from data) persist
// on the signed-in user's own profile via the flags in
// CLIENT_SETUP_MANUAL_FLAGS — see useClientSetup's markStepDone.

export const CLIENT_SETUP_STATES = ['Complete', 'In progress', 'Not started', 'Unknown'];

export const CLIENT_SETUP_ITEM_IDS = [
  'company_details',
  'invite_team',
  'add_knowledge',
  'organize_knowledge',
  'add_process',
  'test_mindvault',
  'review_permissions',
];

export const CLIENT_SETUP_MANUAL_FLAGS = {
  company_details: 'setup_company_details_done',
  test_mindvault: 'setup_test_done',
  review_permissions: 'setup_permissions_reviewed',
};

/**
 * ctx fields (all optional):
 *   tenant:    object | null    — the caller's own Tenant record
 *   members:   object[] | null  — manageTenantMembers 'list' rows
 *   sources:   object[] | null  — Training.list() rows (RLS-scoped)
 *   processes: object[] | null  — OperationalProcess.list() rows
 *   manual:    object          — { company_details, test_mindvault, review_permissions } booleans
 *
 * @returns {{id:string,label:string,state:string,detail:string,why:string,how:string,doneWhen:string,required:boolean,actionLabel:string,actionHref:string,manual:boolean,markDoneLabel:(string|null)}[]}
 */
export function deriveClientSetupItems(ctx = {}) {
  const tenant = ctx.tenant && typeof ctx.tenant === 'object' ? ctx.tenant : null;
  const members = Array.isArray(ctx.members) ? ctx.members : null;
  const sources = Array.isArray(ctx.sources) ? ctx.sources : null;
  const processes = Array.isArray(ctx.processes) ? ctx.processes : null;
  const manual = ctx.manual && typeof ctx.manual === 'object' ? ctx.manual : {};
  const manualDone = (id) => manual[id] === true;

  const items = [];
  const push = (item) => items.push(item);

  // 1 — Add your company details
  {
    let state;
    let detail;
    if (manualDone('company_details') || tenant?.logo_url || tenant?.brand_color) {
      state = 'Complete';
      detail = 'Company name and branding saved.';
    } else if (tenant == null) {
      state = 'Unknown';
      detail = 'Could not load your workspace details.';
    } else {
      state = 'Not started';
      detail = 'Set the company name and logo your team will see.';
    }
    push({
      id: 'company_details',
      label: 'Add your company details',
      state,
      detail,
      why: 'Your company name and logo appear to your team across MindVault — it makes the space feel like yours.',
      how: 'Set your company name, add a link to your logo, and pick a brand color.',
      doneWhen: 'Your company name and logo are saved.',
      required: true,
      actionLabel: 'Update company details',
      actionHref: '/setup#company-details',
      manual: true,
      markDoneLabel: null, // completed by saving the form, not a manual button
    });
  }

  // 2 — Invite your team
  {
    let state;
    let detail;
    if (members == null) {
      state = 'Unknown';
      detail = 'Could not load your team.';
    } else {
      const active = members.filter((m) => m.status === 'active').length;
      const pending = members.filter((m) => m.status === 'pending').length;
      if (active + pending <= 1) {
        state = 'Not started';
        detail = "You're the only team member right now.";
      } else {
        state = 'Complete';
        detail = `${active} active${pending ? ` · ${pending} pending invitation${pending === 1 ? '' : 's'}` : ''}.`;
      }
    }
    push({
      id: 'invite_team',
      label: 'Invite your team',
      state,
      detail,
      why: 'MindVault works best with your whole team. Colleagues you invite can ask questions and get answers; you decide who can manage settings.',
      how: 'Add your first team member by email and choose their role — Client Admin (manages settings and knowledge) or Client User (asks questions).',
      doneWhen: 'At least one teammate has been invited.',
      required: true,
      actionLabel: 'Invite your team',
      actionHref: '/team',
      manual: false,
      markDoneLabel: null,
    });
  }

  // 3 — Upload your first knowledge source
  {
    let state;
    let detail;
    if (sources == null) {
      state = 'Unknown';
      detail = 'Could not load your knowledge sources.';
    } else if (sources.length === 0) {
      state = 'Not started';
      detail = 'No knowledge added yet.';
    } else {
      state = 'Complete';
      detail = `${sources.length} knowledge source${sources.length === 1 ? '' : 's'} added.`;
    }
    push({
      id: 'add_knowledge',
      label: 'Upload your first knowledge source',
      state,
      detail,
      why: "MindVault needs source material before it can answer your team's questions. Start with one recurring process, policy, or SOP.",
      how: 'Upload an SOP, policy, process document, or handbook. MindVault reads it and turns it into answers your team can search.',
      doneWhen: 'At least one document has been added and is being read by MindVault.',
      required: true,
      actionLabel: 'Upload knowledge',
      actionHref: '/manage#manage-knowledge',
      manual: false,
      markDoneLabel: null,
    });
  }

  // 4 — Make it available to your team (scope is chosen when each source is added)
  {
    let state;
    let detail;
    if (sources == null) {
      state = 'Unknown';
      detail = 'Could not load your knowledge sources.';
    } else if (sources.length === 0) {
      state = 'Not started';
      detail = 'Add a knowledge source first.';
    } else {
      const available = sources.filter(
        (s) => s.knowledge_scope === 'general' || s.knowledge_scope === 'client-specific',
      );
      if (available.length === 0) {
        state = 'In progress';
        detail = `${sources.length} source${sources.length === 1 ? '' : 's'} waiting — the assistant cannot use them until you choose who can see each one.`;
      } else {
        state = 'Complete';
        detail = `${available.length} source${available.length === 1 ? '' : 's'} available to the assistant.`;
      }
    }
    push({
      id: 'organize_knowledge',
      label: 'Make it available to your team',
      state,
      detail,
      why: 'New uploads wait until you say who can use them. Choosing this lets the assistant answer from them.',
      how: 'For each source, choose company-wide, or client-specific (only used when working on that client).',
      doneWhen: 'At least one source is available to the assistant.',
      required: true,
      actionLabel: 'Choose availability',
      actionHref: '/manage#manage-knowledge',
      manual: false,
      markDoneLabel: null,
    });
  }

  // 5 — Add or review a process
  {
    let state;
    let detail;
    if (processes == null) {
      state = 'Unknown';
      detail = 'Could not load your processes.';
    } else if (processes.length === 0) {
      state = 'Not started';
      detail = 'No processes described yet.';
    } else {
      state = 'Complete';
      detail = `${processes.length} process${processes.length === 1 ? '' : 'es'} described.`;
    }
    push({
      id: 'add_process',
      label: 'Add or review a process',
      state,
      detail,
      why: 'Processes group your knowledge by how your business actually runs, keeping it organized and easy to keep current.',
      how: "Describe one recurring workflow — for example 'Monthly invoicing' — and who owns it.",
      doneWhen: 'You have described at least one process.',
      required: true,
      actionLabel: 'Describe a process',
      actionHref: '/processes',
      manual: false,
      markDoneLabel: null,
    });
  }

  // 6 — Test MindVault (manual: the user confirms they asked a real question)
  push({
    id: 'test_mindvault',
    label: 'Test MindVault',
    state: manualDone('test_mindvault') ? 'Complete' : 'Not started',
    detail: manualDone('test_mindvault')
      ? 'You asked a question and saw the source behind the answer.'
      : 'Not tested yet.',
    why: 'The fastest way to see the value: ask a real question and check the answer against the source it cites.',
    how: 'Open the AI Assistant and ask something covered by what you just uploaded.',
    doneWhen: "You've asked a question and seen MindVault show its source.",
    required: true,
    actionLabel: 'Open the AI Assistant',
    actionHref: '/chat',
    manual: true,
    markDoneLabel: "I've asked a question",
  });

  // 7 — Review team permissions (manual, optional)
  push({
    id: 'review_permissions',
    label: 'Review team permissions',
    state: manualDone('review_permissions') ? 'Complete' : 'Not started',
    detail: manualDone('review_permissions')
      ? "You've confirmed each team member's role."
      : 'Optional — worth a quick look once your team is in.',
    why: 'Confirm who manages settings (Client Admin) and who uses MindVault day to day (Client User).',
    how: "Open Team and check each member's role — change any that don't look right.",
    doneWhen: "You've confirmed each team member's role.",
    required: false,
    actionLabel: 'Review roles',
    actionHref: '/team',
    manual: true,
    markDoneLabel: "I've reviewed the roles",
  });

  return items;
}

/** The number of items in state 'Complete'. */
export function clientSetupCompleteCount(items) {
  return (items || []).filter((i) => i.state === 'Complete').length;
}

/** Completion percentage (0-100) for the progress bar. */
export function clientSetupProgressPct(items) {
  const list = items || [];
  if (list.length === 0) return 0;
  return Math.round((clientSetupCompleteCount(list) / list.length) * 100);
}

/** True when every REQUIRED step is complete (optional steps don't block). */
export function clientSetupRequiredComplete(items) {
  return (items || []).filter((i) => i.required).every((i) => i.state === 'Complete');
}