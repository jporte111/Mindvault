// Phase 7 — Key-Person Dependency. A finding is produced ONLY when the governed
// data contains an IDENTIFIABLE person dependency. Undocumented-process-alone
// and missing-SME-alone are Continuity Exposure, NOT key-person risk.
//
// This is continuity risk, never employee monitoring: inputs are structural
// (owner / SME / backup presence, criticality, coverage, concentration).
// `source_authority` is NOT an input.

import type {
  ConcentrationFinding,
  CoverageState,
  FreshnessState,
  KeyPersonDriver,
  KeyPersonLevel,
  KeyPersonPerson,
  KeyPersonResult,
} from "./types.ts";

export interface KeyPersonInput {
  criticality?: string | null;
  processOwner?: string | null;
  subjectMatterExpert?: string | null;
  backupSme?: string | null;
  coverageState: CoverageState;
  worstUsableFreshness: FreshnessState; // USABLE sources only (F4)
  gapFunnelToSoleSmeCount: number; // open/under-review gaps on this process assigned to its sole SME
}

export function assessKeyPersonDependency(x: KeyPersonInput): KeyPersonResult {
  // Cannot assess severity without knowing how important the process is.
  if (!x.criticality) return { level: "unknown", drivers: [], persons: [], amplified: false };

  const critical = x.criticality === "high" || x.criticality === "mission_critical";
  const mc = x.criticality === "mission_critical";
  const smeNoBackup = !!x.subjectMatterExpert && !x.backupSme;
  const ownerIsSme = !!x.processOwner &&
    x.processOwner === x.subjectMatterExpert &&
    !x.backupSme;

  const drivers: KeyPersonDriver[] = [];
  const persons: KeyPersonPerson[] = [];
  const addPerson = (p: KeyPersonPerson) => {
    if (!persons.some((q) => q.userId === p.userId)) persons.push(p);
  };

  // KP1 — critical process has an SME but no backup
  if (critical && smeNoBackup) {
    drivers.push("sole_sme_no_backup");
    addPerson({ userId: x.subjectMatterExpert as string, role: "sole_sme" });
  }
  // KP2 — process_owner === subject_matter_expert and no backup (any criticality; severity scales)
  if (ownerIsSme) {
    drivers.push("owner_is_sole_sme");
    addPerson({ userId: x.subjectMatterExpert as string, role: "owner_sme" });
  }

  const established = drivers.length > 0;

  // KP4 — repeated/open gaps on a critical process funnel to the SAME sole SME.
  // Only meaningful once a person dependency is established.
  if (critical && established && x.gapFunnelToSoleSmeCount >= 2) {
    drivers.push("gaps_funnel_to_sole_sme");
  }

  // KP5 — AMPLIFIER ONLY: stale/unverified docs behind an established dependency.
  const amplified = established &&
    (x.worstUsableFreshness === "overdue" || x.coverageState === "documented_unverified");

  if (drivers.length === 0) {
    return { level: "none", drivers: [], persons: [], amplified: false };
  }

  let level: KeyPersonLevel;
  if (drivers.includes("gaps_funnel_to_sole_sme")) level = "high";
  else if (mc) level = "high";
  else if (critical) level = amplified ? "high" : "elevated";
  else level = "informational"; // KP2 on a low/medium-criticality process
  if (amplified && level === "elevated") level = "high";

  return { level, drivers, persons, amplified };
}

// --- Portfolio-level (KP3): expertise concentration across CRITICAL processes -

export interface ConcentrationProcessLike {
  id: string;
  criticality?: string | null;
  subjectMatterExpert?: string | null;
  backupSme?: string | null;
}

export function findConcentrationRisks(
  processes: ConcentrationProcessLike[],
): ConcentrationFinding[] {
  const byPerson = new Map<string, string[]>();
  for (const p of processes || []) {
    const crit = p.criticality === "high" || p.criticality === "mission_critical";
    if (!crit) continue;
    if (!p.subjectMatterExpert || p.backupSme) continue; // sole SME only
    const arr = byPerson.get(p.subjectMatterExpert) || [];
    arr.push(p.id);
    byPerson.set(p.subjectMatterExpert, arr);
  }
  const out: ConcentrationFinding[] = [];
  for (const [userId, ids] of byPerson) {
    if (ids.length >= 2) {
      out.push({
        userId,
        level: ids.length >= 3 ? "critical" : "high",
        criticalProcessIds: ids,
      });
    }
  }
  return out;
}
