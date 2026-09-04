// Phase 9 P9-2 — leadership-friendly "governance completeness" projection of a
// single Phase 7 processRow. Pure: no imports, no LLM, no embeddings, no
// randomness, NO NEW HEALTH RULES. Every cell is a plain-language restatement of
// a field the Phase 7 computeKnowledgeHealth payload already computed
// (owner / sme / backup presence, criticality, coverageState, freshness,
// keyPersonLevel, detail.linkedSources[].verification). Missing data is shown as
// missing / unknown / needs_attention per the existing semantics — never
// silently "bad".

export type GovernanceCellStatus = "present" | "missing" | "unknown" | "needs_attention";

export interface GovernanceCell {
  status: GovernanceCellStatus;
  label: string;
}

export interface GovernanceCompletenessRow {
  id: string;
  name: string;
  criticality: string; // 'Mission-critical' | 'High-criticality' | ... | 'Not set'
  owner: GovernanceCell;
  sme: GovernanceCell;
  reviewCadence: GovernanceCell;
  coverage: GovernanceCell;
  verification: GovernanceCell;
  backupKeyPerson: GovernanceCell;
  continuityLabel: string; // pass-through of the existing plain-language state
}

const CRIT_LABEL: Record<string, string> = {
  mission_critical: "Mission-critical",
  high: "High-criticality",
  medium: "Medium-criticality",
  low: "Low-criticality",
};

function isElevatedCriticality(c?: string | null): boolean {
  return c === "mission_critical" || c === "high";
}

function personCell(person: any, roleWord: string): GovernanceCell {
  return person && person.id
    ? { status: "present", label: person.name || "Assigned" }
    : { status: "missing", label: `No ${roleWord} assigned` };
}

function reviewCadenceCell(row: any): GovernanceCell {
  switch (row?.freshness) {
    case "current":
      return { status: "present", label: "Up to date" };
    case "due_soon":
      return { status: "needs_attention", label: "Due for review soon" };
    case "overdue":
      return { status: "needs_attention", label: "Overdue for review" };
    default: // 'unknown' — the Phase 7 vocab for "no review schedule"
      return { status: "missing", label: "No review schedule" };
  }
}

function coverageCell(row: any): GovernanceCell {
  const label = row?.coverageLabel || "Unknown";
  switch (row?.coverageState) {
    case "documented_verified":
      return { status: "present", label };
    case "documented_unverified":
      return { status: "needs_attention", label };
    case "needs_attention":
      return { status: "needs_attention", label };
    case "unknown":
      return { status: "unknown", label };
    default: // 'not_documented'
      return { status: "missing", label };
  }
}

function verificationCell(row: any): GovernanceCell {
  const hasDetail = !!row?.detail && Array.isArray(row.detail.linkedSources);
  if (!hasDetail) {
    // detail block absent — derive from the existing coverage state.
    return row?.coverageState === "documented_verified"
      ? { status: "present", label: "Verified knowledge linked" }
      : { status: "missing", label: "No linked knowledge" };
  }
  const linked: any[] = row.detail.linkedSources;
  if (linked.length === 0) return { status: "missing", label: "No linked knowledge" };
  if (linked.some((s) => s?.verification === "Verified")) {
    return { status: "present", label: "Verified knowledge linked" };
  }
  if (linked.some((s) => s?.verification === "Rejected")) {
    return { status: "needs_attention", label: "Linked knowledge was rejected" };
  }
  return { status: "needs_attention", label: "Linked knowledge not yet verified" };
}

function backupKeyPersonCell(row: any): GovernanceCell {
  const level = row?.keyPersonLevel;
  const hasBackup = !!(row?.backup && row.backup.id);
  if (hasBackup) {
    return { status: "present", label: `Backup: ${row.backup.name || "assigned"}` };
  }
  if (level === "high" || level === "critical") {
    return { status: "needs_attention", label: row?.keyPersonLabel || "Key-person dependency" };
  }
  if (level === "unknown") {
    return { status: "unknown", label: row?.keyPersonLabel || "Set criticality to assess" };
  }
  if (isElevatedCriticality(row?.criticality)) {
    return { status: "needs_attention", label: "No backup expert" };
  }
  return { status: "missing", label: "No backup expert" };
}

export function governanceCompletenessRow(row: any): GovernanceCompletenessRow {
  return {
    id: String(row?.id ?? ""),
    name: String(row?.name ?? "Untitled process"),
    criticality: (row?.criticality && CRIT_LABEL[row.criticality]) || "Not set",
    owner: personCell(row?.owner, "owner"),
    sme: personCell(row?.sme, "subject-matter expert"),
    reviewCadence: reviewCadenceCell(row),
    coverage: coverageCell(row),
    verification: verificationCell(row),
    backupKeyPerson: backupKeyPersonCell(row),
    continuityLabel: String(row?.continuityLabel ?? row?.continuityState ?? ""),
  };
}

export function governanceCompleteness(rows: any[]): GovernanceCompletenessRow[] {
  return (Array.isArray(rows) ? rows : []).map(governanceCompletenessRow);
}
