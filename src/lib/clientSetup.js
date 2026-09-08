// Client Admin self-serve setup — pure, deterministic derivation of the
// Getting Started checklist. Everything here is a plain function of data the
// product already computes: the caller's own tenant member list, their
// knowledge sources (RLS-scoped to their tenant), and their operational
// processes. No scores, no percentages — the only summary is a count of
// Complete items.
//
// States: 'Complete' | 'In progress' | 'Not started' | 'Unknown'

export const CLIENT_SETUP_STATES = ['Complete', 'In progress', 'Not started', 'Unknown'];

export const CLIENT_SETUP_ITEM_IDS = [
  'invite_team',
  'add_knowledge',
  'make_knowledge_searchable',
  'describe_process',
];

/**
 * ctx fields (all optional):
 *   members:   object[] | null  — manageTenantMembers 'list' rows; null if unavailable
 *   sources:   object[] | null   — Training.list() rows; null if not loaded
 *   processes: object[] | null   — OperationalProcess.list() rows; null if not loaded
 *
 * @param {object} [ctx]
 * @returns {{id:string,label:string,state:string,detail:string,actionLabel:string,actionHref:string}[]}
 */
export function deriveClientSetupItems(ctx = {}) {
  const members = Array.isArray(ctx.members) ? ctx.members : null;
  const sources = Array.isArray(ctx.sources) ? ctx.sources : null;
  const processes = Array.isArray(ctx.processes) ? ctx.processes : null;

  const items = [];
  const push = (id, label, state, detail, actionLabel, actionHref) =>
    items.push({ id, label, state, detail, actionLabel, actionHref });

  // 1 — Invite your team (the caller's own membership row counts as a member)
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
        detail = 'Invite colleagues so they can search the knowledge base and ask questions.';
      } else {
        state = 'Complete';
        detail = `${active} active${pending ? ` · ${pending} pending invitation${pending === 1 ? '' : 's'}` : ''}.`;
      }
    }
    push('invite_team', 'Invite your team', state, detail, 'Manage team', '/team');
  }

  // 2 — Add your first knowledge source
  {
    let state;
    let detail;
    if (sources == null) {
      state = 'Unknown';
      detail = 'Could not load your knowledge sources.';
    } else if (sources.length === 0) {
      state = 'Not started';
      detail = 'Add a document, recording transcript, or process note — MindVault reads it so the assistant can answer from it.';
    } else {
      state = 'Complete';
      detail = `${sources.length} knowledge source${sources.length === 1 ? '' : 's'} added.`;
    }
    push('add_knowledge', 'Add your first knowledge source', state, detail, 'Add knowledge', '/manage#manage-knowledge');
  }

  // 3 — Make knowledge searchable (scope is chosen when each source is added)
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
      const classified = sources.filter(
        (s) => s.knowledge_scope === 'general' || s.knowledge_scope === 'client-specific',
      );
      if (classified.length === 0) {
        state = 'In progress';
        detail = `${sources.length} source${sources.length === 1 ? '' : 's'} added — choose a scope (organization-wide or a client) when you add each one, or the assistant cannot use it.`;
      } else {
        state = 'Complete';
        detail = `${classified.length} source${classified.length === 1 ? '' : 's'} available to the assistant.`;
      }
    }
    push('make_knowledge_searchable', 'Make knowledge searchable', state, detail, 'Choose a scope', '/manage#manage-knowledge');
  }

  // 4 — Describe an operational process
  {
    let state;
    let detail;
    if (processes == null) {
      state = 'Unknown';
      detail = 'Could not load your processes.';
    } else if (processes.length === 0) {
      state = 'Not started';
      detail = 'Describe one recurring workflow — it becomes the governance home for the knowledge linked to it.';
    } else {
      state = 'Complete';
      detail = `${processes.length} process${processes.length === 1 ? '' : 'es'} described.`;
    }
    push('describe_process', 'Describe an operational process', state, detail, 'Describe a process', '/manage#manage-processes');
  }

  return items;
}

/** The header count — the number of items in state 'Complete'. Not a score. */
export function clientSetupCompleteCount(items) {
  return (items || []).filter((i) => i.state === 'Complete').length;
}