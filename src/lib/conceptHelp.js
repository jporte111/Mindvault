// Onboarding-1 — central plain-language definitions for the product concepts a
// new admin has to understand. This map is the single source of truth for
// onboarding copy: the setup checklist, the empty states, and (in Onboarding-2)
// the inline help popovers all read from here so wording stays consistent.
//
// Copy rule: describe what the concept MEANS to the business. No implementation
// jargon — never "embeddings", "vector", "retrieval / RAG", "schema",
// "fingerprint", "lifecycle engine", "index", "chunk", "payload".

export const CONCEPT_HELP = {
  scope: {
    term: 'Firm-wide vs client-specific',
    text:
      'Firm-wide knowledge is available to everyone. Client-specific knowledge is only ever used when someone is working in that client’s context — it never crosses over to another client.',
  },
  owner: {
    term: 'Owner',
    text:
      'The person accountable for keeping an operational process and its knowledge current. One owner per process.',
  },
  sme: {
    term: 'Subject-matter expert (SME)',
    text:
      'The person who actually knows how the process works — who can answer detailed questions or correct the documentation.',
  },
  backup_sme: {
    term: 'Backup SME',
    text:
      'A second person who could keep the process running if the SME is unavailable. Worth adding for the processes the business depends on most.',
  },
  criticality: {
    term: 'Criticality',
    text:
      'How badly the business is affected if this process stops working. It decides what shows up first on the Operational Continuity dashboard.',
  },
  review_cadence: {
    term: 'Review cadence',
    text:
      'How often this knowledge should be checked to confirm it is still accurate — for example every 90 days.',
  },
  verification: {
    term: 'Verification',
    text:
      'An admin has confirmed the knowledge is accurate and current. Unverified knowledge still answers questions unless you choose to require verification.',
  },
  coverage: {
    term: 'Coverage',
    text:
      'Whether a process has documented, usable knowledge behind it — and whether that knowledge has been verified.',
  },
  continuity_exposure: {
    term: 'Continuity exposure',
    text:
      'A general risk to a process continuing smoothly: no documentation, no owner, an overdue review, an open knowledge gap, or a source that failed to update.',
  },
  key_person: {
    term: 'Key-person dependency',
    text:
      'The process relies on one identifiable person with no backup. This is about resilience, not about monitoring anyone.',
  },
  knowledge_gap: {
    term: 'Knowledge gap',
    text:
      'A real question employees asked that the knowledge base could not fully answer. It is a signal to check or add knowledge — it is not itself an answer.',
  },
  snapshot: {
    term: 'Snapshot / Trends',
    text:
      'A monthly saved summary of your continuity numbers, so leadership can see whether things are improving or slipping over time.',
  },
  what_changed: {
    term: 'What changed',
    text:
      'A plain list of what got better or worse between the last two monthly summaries — for example “2 processes moved out of At Risk”.',
  },
};

export const CONCEPT_HELP_KEYS = Object.keys(CONCEPT_HELP);
