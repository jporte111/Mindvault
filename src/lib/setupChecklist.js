// Onboarding-1 — pure, deterministic derivation of the Admin Setup Checklist.
//
// 10 configuration areas, each a plain function of data the product ALREADY
// computes: raw Training / OperationalProcess fields, plus (for the one item
// that needs it) the established P9-2 governance / key-person signal on the
// computeKnowledgeHealth payload. It NEVER recomputes continuity health,
// coverage, or key-person risk, and it produces NO score / percentage /
// weighted value — the only summary is a count of Complete items.
//
// States: 'Complete' | 'In progress' | 'Needs attention' | 'Not started' | 'Unknown'

export const CHECKLIST_STATES = ['Complete', 'In progress', 'Needs attention', 'Not started', 'Unknown'];

export const CHECKLIST_ITEM_IDS = [
  'knowledge_classified',
  'processes_created',
  'criticality_assigned',
  'owners_assigned',
  'smes_assigned',
  'backup_coverage',
  'review_cadence',
  'knowledge_linked',
  'knowledge_verification',
  'continuity_reviewed',
];

const CRITICAL = new Set(['high', 'mission_critical']);
const isCritical = (c) => CRITICAL.has(c);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * ctx fields (all optional):
 *   healthFlagOn: boolean            — knowledge_health_enabled
 *   health: object | null            — computeKnowledgeHealth({scope:'general'}) when healthFlagOn, else null
 *   sources: object[] | null         — Training.list('-created_date'); null if not loaded
 *   processes: object[] | null       — OperationalProcess.list(); null if not loaded
 *   continuityVisited: boolean       — has an admin opened /continuity (passed in by the caller)
 *
 * @param {object} [ctx]
 * @returns {{id:string,label:string,state:string,detail:string,actionLabel:string,actionHref:string}[]}
 */
export function deriveChecklistItems(ctx = {}) {
  const sources = Array.isArray(ctx.sources) ? ctx.sources : null;
  const processes = Array.isArray(ctx.processes) ? ctx.processes : null;
  const health = ctx.health || null;
  const flagOn = ctx.healthFlagOn === true;

  // --- raw intermediates (all from existing entity fields) ---
  const activeSources = sources ? sources.filter((s) => s && s.status === 'ready') : null;
  const classified = activeSources
    ? activeSources.filter((s) => s.knowledge_scope && s.knowledge_scope !== 'unclassified')
    : null;
  const unclassified = activeSources
    ? activeSources.filter((s) => !s.knowledge_scope || s.knowledge_scope === 'unclassified')
    : null;

  const activeProcs = processes ? processes.filter((p) => p && p.status === 'active') : null;
  const criticalProcs = activeProcs ? activeProcs.filter((p) => isCritical(p.criticality)) : null;
  const criticalProcIds = new Set((criticalProcs || []).map((p) => p.id));

  const procCadence = new Map((processes || []).map((p) => [p.id, num(p.review_interval_days)]));
  const sourceHasCadence = (s) =>
    num(s.source_review_interval_days) > 0 ||
    (!!s.operational_process_id && procCadence.get(s.operational_process_id) > 0);

  // --- P9-2 governance signal (only when the health feature is on) ---
  const healthRows = flagOn && Array.isArray(health?.processRows) ? health.processRows : null;
  const backupCanEvaluate = healthRows != null;
  const backupNeedsAttention = healthRows
    ? healthRows.filter((r) => r?.governance?.backupKeyPerson?.status === 'needs_attention').length
    : 0;

  const items = [];
  const push = (id, label, state, detail, actionLabel, actionHref) =>
    items.push({ id, label, state, detail, actionLabel, actionHref });

  // 1 — Knowledge classified
  {
    let state;
    let detail;
    if (activeSources == null) {
      state = 'Unknown';
      detail = 'Could not load knowledge sources.';
    } else if (activeSources.length === 0) {
      state = 'Not started';
      detail = 'No active knowledge yet. Add your first source or connect Google Drive.';
    } else if (unclassified.length > 0) {
      state = 'In progress';
      detail = `${classified.length} of ${activeSources.length} sources classified · ${unclassified.length} still awaiting classification.`;
    } else {
      state = 'Complete';
      detail = `${classified.length} sources classified.`;
    }
    // Legacy re-index problems may elevate to Needs attention — only using the
    // established setup.legacyNeedingReindex field, and never from Not started.
    const legacy = flagOn ? num(health?.setup?.legacyNeedingReindex) : 0;
    if (legacy > 0 && (state === 'Complete' || state === 'In progress')) {
      state = 'Needs attention';
      detail = `${detail} ${legacy} older sources still need attention before their documentation status can be confirmed.`;
    }
    push('knowledge_classified', 'Knowledge classified', state, detail, 'Manage knowledge', '/admin');
  }

  // 2 — Operational processes created  (existence only — NOT criticality)
  {
    let state;
    let detail;
    if (activeProcs == null) {
      state = 'Unknown';
      detail = 'Could not load operational processes.';
    } else if (activeProcs.length === 0) {
      state = 'Not started';
      detail = 'No operational processes yet. Start with the 3–5 workflows the business could least afford to lose.';
    } else {
      state = 'Complete';
      detail = `${activeProcs.length} operational processes. Aim to cover the 3–5 workflows the business could least afford to lose.`;
    }
    push('processes_created', 'Operational processes created', state, detail, 'Manage processes', '/admin');
  }

  // 3 — Criticality assigned  (separate from "processes created")
  {
    let state;
    let detail;
    if (activeProcs == null) {
      state = 'Unknown';
      detail = 'Could not load operational processes.';
    } else if (activeProcs.length === 0) {
      state = 'Not started';
      detail = 'Add operational processes first.';
    } else {
      const missing = activeProcs.filter((p) => !p.criticality).length;
      state = missing > 0 ? 'In progress' : 'Complete';
      detail =
        missing > 0
          ? `${activeProcs.length - missing} of ${activeProcs.length} processes have a criticality set.`
          : `All ${activeProcs.length} processes have a criticality set.`;
    }
    push('criticality_assigned', 'Criticality assigned', state, detail, 'Set criticality', '/admin');
  }

  // 4 — Owners assigned
  push(...personItem(
    'owners_assigned', 'Owners assigned', 'owner', 'process_owner',
    activeProcs, criticalProcs, 'Assign owners',
  ));

  // 5 — SMEs assigned
  push(...personItem(
    'smes_assigned', 'SMEs assigned', 'subject-matter expert', 'subject_matter_expert',
    activeProcs, criticalProcs, 'Assign SMEs',
  ));

  // 6 — Backup coverage where needed  (established key-person signal ONLY)
  {
    let state;
    let detail;
    if (activeProcs == null) {
      state = 'Unknown';
      detail = 'Could not load operational processes.';
    } else if (activeProcs.length === 0) {
      state = 'Not started';
      detail = 'Add operational processes first.';
    } else if (!backupCanEvaluate) {
      state = 'Unknown';
      detail = 'Turn on the Operational Continuity dashboard to evaluate key-person dependencies.';
    } else if (backupNeedsAttention > 0) {
      state = 'Needs attention';
      detail = `${backupNeedsAttention} process${backupNeedsAttention === 1 ? '' : 'es'} depend on one expert with no backup.`;
    } else {
      state = 'Complete';
      detail = 'No process currently depends on one person with no backup.';
    }
    push('backup_coverage', 'Backup coverage where needed', state, detail, 'Review key-person exposure', flagOn ? '/continuity' : '/admin');
  }

  // 7 — Review cadence configured  (raw source-override / process-inherit)
  {
    let state;
    let detail;
    if (activeSources == null || processes == null) {
      state = 'Unknown';
      detail = 'Could not load knowledge sources.';
    } else if (classified.length === 0) {
      state = 'Not started';
      detail = 'Classify knowledge first, then set how often each source should be reviewed.';
    } else {
      const missing = classified.filter((s) => !sourceHasCadence(s)).length;
      state = missing > 0 ? 'In progress' : 'Complete';
      detail =
        missing > 0
          ? `${classified.length - missing} of ${classified.length} sources have a review cadence (their own or an inherited one).`
          : `All ${classified.length} sources have a review cadence.`;
    }
    push('review_cadence', 'Review cadence configured', state, detail, 'Set review cadence', '/admin');
  }

  // 8 — Knowledge linked to processes  (raw Training.operational_process_id)
  {
    let state;
    let detail;
    if (activeSources == null || activeProcs == null) {
      state = 'Unknown';
      detail = 'Could not load knowledge sources or processes.';
    } else if (activeProcs.length === 0 || classified.length === 0) {
      state = 'Not started';
      detail = 'Add processes and classified knowledge, then link each source to the process it documents.';
    } else {
      const unlinked = classified.filter((s) => !s.operational_process_id).length;
      state = unlinked > 0 ? 'In progress' : 'Complete';
      detail =
        unlinked > 0
          ? `${classified.length - unlinked} of ${classified.length} sources linked to a process · ${unlinked} unlinked.`
          : `All ${classified.length} sources linked to a process.`;
    }
    push('knowledge_linked', 'Knowledge linked to processes', state, detail, 'Link knowledge', '/admin');
  }

  // 9 — Knowledge verification  (describes the actual verification state)
  {
    let state;
    let detail;
    if (activeSources == null) {
      state = 'Unknown';
      detail = 'Could not load knowledge sources.';
    } else if (activeSources.length === 0) {
      state = 'Not started';
      detail = 'No active knowledge yet.';
    } else {
      const unverified = activeSources.filter((s) => s.verification_status !== 'verified');
      const unverifiedCriticalLinked = unverified.filter(
        (s) => s.operational_process_id && criticalProcIds.has(s.operational_process_id),
      ).length;
      if (unverified.length === 0) {
        state = 'Complete';
        detail = 'All active knowledge is verified.';
      } else if (unverifiedCriticalLinked > 0) {
        state = 'Needs attention';
        detail = `${unverified.length} active sources are not verified — ${unverifiedCriticalLinked} of them support a critical process.`;
      } else {
        state = 'In progress';
        detail = `${unverified.length} active sources are not verified (legacy knowledge counts here; verifying it is optional but recommended for critical processes).`;
      }
    }
    push('knowledge_verification', 'Knowledge verification', state, detail, 'Review verification', '/admin');
  }

  // 10 — Continuity dashboard reviewed  (flag + visit flag; NEVER snapshot count)
  {
    let state;
    let detail;
    let href;
    if (!flagOn) {
      state = 'Not started';
      detail = 'The Operational Continuity dashboard is turned off. Enable it under Admin → System.';
      href = '/admin';
    } else if (ctx.continuityVisited === true) {
      state = 'Complete';
      detail = 'You have opened the Operational Continuity dashboard.';
      href = '/continuity';
    } else {
      state = 'In progress';
      detail = 'The dashboard is on. Open it to review coverage, review backlog, verification, and key-person exposure.';
      href = '/continuity';
    }
    push('continuity_reviewed', 'Continuity dashboard reviewed', state, detail, 'Open Operational Continuity', href);
  }

  return items;
}

function personItem(id, label, roleWord, field, activeProcs, criticalProcs, actionLabel) {
  let state;
  let detail;
  if (activeProcs == null) {
    state = 'Unknown';
    detail = 'Could not load operational processes.';
  } else if (activeProcs.length === 0) {
    state = 'Not started';
    detail = 'Add operational processes first.';
  } else {
    const missing = activeProcs.filter((p) => !p[field]).length;
    const criticalMissing = (criticalProcs || []).filter((p) => !p[field]).length;
    if (criticalMissing > 0) {
      state = 'Needs attention';
      detail = `${criticalMissing} critical process${criticalMissing === 1 ? '' : 'es'} have no ${roleWord} assigned.`;
    } else if (missing > 0) {
      state = 'In progress';
      detail = `${activeProcs.length - missing} of ${activeProcs.length} processes have a ${roleWord} assigned.`;
    } else {
      state = 'Complete';
      detail = `All ${activeProcs.length} processes have a ${roleWord} assigned.`;
    }
  }
  return [id, label, state, detail, actionLabel, '/admin'];
}

/** The header count — the number of items in state 'Complete'. Not a score. */
export function completeCount(items) {
  return (items || []).filter((i) => i.state === 'Complete').length;
}
