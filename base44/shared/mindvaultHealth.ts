// MindVault BINDING for the Phase 7 Operational Continuity dashboard.
//
// Maps Training / OperationalProcess / KnowledgeGap / ClarificationRequest /
// KnowledgeLifecycleOperation onto the pure primitives in base44/shared/health/,
// applies client-scope isolation, runs the bounded legacy KnowledgeChunk
// existence lookup (F2/F2a), resolves person names, and returns one JSON payload.
//
// Takes the Base44 client as a parameter (no `npm:@base44/sdk` import) so it is
// node-loadable for tests with a stub client.
//
// NO embeddings, NO LLM, NO randomness, NO retrieval changes. Reads
// Training.index_status (the ops rollup) — never KnowledgeChunk.index_stale or
// chunk content.

import {
  assessContinuityExposure,
  assessKeyPersonDependency,
  bucketFreshness,
  computeFreshness,
  coverageBand,
  currencyBand,
  deriveContinuityState,
  deriveCoverageState,
  effectiveNow,
  findConcentrationRisks,
  governedActiveSource,
  HEALTH_VOCABULARY,
  highestContinuityExposureSeverity,
  keyPersonResilienceBand,
  prioritizeQueue,
  resolveHealthVocabulary,
  resolveIndexState,
  resolveReviewInterval,
  topAddressFirst,
  usableSources,
  verificationBand,
  worstFreshness,
} from "./health/index.ts";
import type {
  CoverageState,
  HealthSourceLike,
  QueueItemInput,
} from "./health/index.ts";

// --- constants (F2b) --------------------------------------------------

export const MAX_LEGACY_LOOKUP = 500;
export const BATCH = 50;
export const PAGE_LIMIT = 5000;
export const MAX_PAGES_PER_BATCH = 4;

// A draft revision open (or sitting in changes-requested / in-review) at least
// this long is surfaced as review-queue work. Deterministic threshold — no
// notification is sent (that is Phase 8).
export const DRAFT_STUCK_DAYS = 14;
const DAY_MS = 86_400_000;

// --- scope --------------------------------------------------------

export type HealthScope = { kind: "general" } | { kind: "client"; clientId: string };

function scopeMatchesSource(s: any, scope: HealthScope): boolean {
  if (s.knowledge_scope === "general") return true;
  if (scope.kind === "client" && s.knowledge_scope === "client-specific") {
    return s.client_id === scope.clientId;
  }
  return false;
}
function scopeMatchesProcess(p: any, scope: HealthScope): boolean {
  return scopeMatchesSource(p, scope);
}
function scopeMatchesGapish(g: any, scope: HealthScope): boolean {
  const cs = g.client_scope || "";
  if (cs === "general") return true;
  if (scope.kind === "client") return cs === `client:${scope.clientId}`;
  return false;
}

// --- bounded legacy KnowledgeChunk existence lookup (F2 / F2a) ---------

export interface LegacyLookupStats {
  evaluated: number;
  proven_present: number;
  proven_absent: number;
  undetermined: number;
  truncated: boolean;
  truncated_count: number;
  calls: number;
}

export async function legacyChunkExistence(
  base44: any,
  legacyIds: string[],
): Promise<{ answer: (id: string) => boolean | undefined; stats: LegacyLookupStats }> {
  const result = new Map<string, boolean | undefined>();
  const evaluated = legacyIds.slice(0, MAX_LEGACY_LOOKUP);
  const truncated = legacyIds.slice(MAX_LEGACY_LOOKUP);
  for (const id of truncated) result.set(id, undefined);

  let calls = 0;
  for (let i = 0; i < evaluated.length; i += BATCH) {
    const batch = evaluated.slice(i, i + BATCH);
    const present = new Set<string>();
    let drained = false;
    let pages = 0;
    let skip = 0;
    try {
      while (pages < MAX_PAGES_PER_BATCH) {
        const rows = await base44.asServiceRole.entities.KnowledgeChunk.filter(
          { training_id: { $in: batch } },
          "-created_date",
          PAGE_LIMIT,
          skip,
        );
        calls++;
        pages++;
        if (Array.isArray(rows)) {
          for (const r of rows) if (r && r.training_id) present.add(r.training_id);
          if (rows.length < PAGE_LIMIT) {
            drained = true;
            break;
          }
        } else {
          break; // ambiguous shape -> leave undrained -> undefined
        }
        skip += PAGE_LIMIT;
      }
    } catch (_) {
      for (const id of batch) result.set(id, undefined); // never false on error
      continue;
    }
    for (const id of batch) {
      if (present.has(id)) result.set(id, true);
      else if (drained) result.set(id, false); // absence PROVEN only after a full drain
      else result.set(id, undefined);
    }
  }

  let proven_present = 0;
  let proven_absent = 0;
  let undetermined = 0;
  for (const id of evaluated) {
    const v = result.get(id);
    if (v === true) proven_present++;
    else if (v === false) proven_absent++;
    else undetermined++;
  }

  return {
    answer: (id: string) => result.get(id),
    stats: {
      evaluated: evaluated.length,
      proven_present,
      proven_absent,
      undetermined,
      truncated: truncated.length > 0,
      truncated_count: truncated.length,
      calls,
    },
  };
}

// --- helpers -----------------------------------------------------

const CRITICAL = new Set(["high", "mission_critical"]);
const isCritical = (c?: string | null) => !!c && CRITICAL.has(c);

async function resolveNames(base44: any, ids: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out: Record<string, string> = {};
  if (!uniq.length) return out;
  try {
    const users = await base44.asServiceRole.entities.User.filter({ id: { $in: uniq } }, null, uniq.length);
    for (const u of users || []) {
      out[u.id] = u.full_name || u.name || u.email || u.id;
    }
  } catch (_) { /* names optional */ }
  for (const id of uniq) if (!out[id]) out[id] = id;
  return out;
}

// --- payload ----------------------------------------------------

export interface KnowledgeHealthOptions {
  scope?: HealthScope;
  now?: number;
  vocabularyOverride?: any;
}

export async function computeKnowledgeHealth(base44: any, opts: KnowledgeHealthOptions = {}) {
  const scope: HealthScope = opts.scope || { kind: "general" };
  const now = opts.now ?? Date.now();
  const vocab = resolveHealthVocabulary(opts.vocabularyOverride);
  const svc = base44.asServiceRole.entities;

  // --- read entities (broad, then scope + GAS in memory) ------------
  const [allProcesses, allTrainings, allGaps, allClarifs, allOps] = await Promise.all([
    svc.OperationalProcess.filter({}, "-created_date", 5000).catch(() => []),
    svc.Training.filter({ status: "ready" }, "-created_date", 5000).catch(() => []),
    svc.KnowledgeGap.filter(
      { status: { $in: ["candidate", "open", "under_review"] } },
      "-last_seen_at",
      5000,
    ).catch(() => []),
    svc.ClarificationRequest.filter(
      { status: { $in: ["open", "awaiting_employee"] } },
      "-last_message_at",
      5000,
    ).catch(() => []),
    svc.KnowledgeLifecycleOperation.filter(
      { status: { $in: ["failed", "compensating"] } },
      "-started_at",
      2000,
    ).catch(() => []),
  ]);

  // processes
  const processes = (allProcesses as any[]).filter(
    (p) => p.status === "active" && scopeMatchesProcess(p, scope) && p.knowledge_scope !== "unclassified",
  );
  // firm-wide: count client-specific processes per client (COUNT ONLY, no content)
  const clientProcessCounts: Record<string, number> = {};
  if (scope.kind === "general") {
    for (const p of allProcesses as any[]) {
      if (p.status === "active" && p.knowledge_scope === "client-specific" && p.client_id) {
        clientProcessCounts[p.client_id] = (clientProcessCounts[p.client_id] || 0) + 1;
      }
    }
  }

  // sources
  const unclassifiedCount = (allTrainings as any[]).filter(
    (t) => (t.knowledge_scope || "unclassified") === "unclassified",
  ).length;
  const scopedReady = (allTrainings as any[]).filter(
    (t) => scopeMatchesSource(t, scope) && t.knowledge_scope !== "unclassified",
  );
  const gas: any[] = scopedReady.filter((t) => governedActiveSource(t as HealthSourceLike));

  // legacy chunk existence
  const legacyIds = gas.filter((t) => !t.index_status).map((t) => t.id);
  const { answer: hasLegacyChunk, stats: legacyStats } = await legacyChunkExistence(base44, legacyIds);
  const hlc = (id: string) => hasLegacyChunk(id);

  // gaps / clarifications (scoped)
  const gaps = (allGaps as any[]).filter((g) => scopeMatchesGapish(g, scope));
  const clarifs = (allClarifs as any[]).filter((c) => scopeMatchesGapish(c, scope));
  const openGaps = gaps.filter((g) => g.status === "open" || g.status === "under_review");
  const candidateGaps = gaps.filter((g) => g.status === "candidate");
  const promotedGapIds = new Set(
    openGaps.filter((g) => (g.times_asked || 0) >= 3 && (g.distinct_reporters || 0) >= 2).map((g) => g.id),
  );

  // failed operations -> the lineage roots they touch
  const failedOpRoots = new Set((allOps as any[]).map((o) => o.root_source_id).filter(Boolean));

  // --- per-process rows -----------------------------------------
  const gapsByProcess = new Map<string, any[]>();
  for (const g of openGaps) {
    if (g.operational_process_id) {
      (gapsByProcess.get(g.operational_process_id) || gapsByProcess.set(g.operational_process_id, []).get(g.operational_process_id))!.push(g);
    }
  }
  const clarifsByProcess = new Map<string, number>();
  for (const c of clarifs) {
    if (c.operational_process_id) {
      clarifsByProcess.set(c.operational_process_id, (clarifsByProcess.get(c.operational_process_id) || 0) + 1);
    }
  }
  const sourcesByProcess = new Map<string, any[]>();
  for (const t of gas) {
    if (t.operational_process_id) {
      (sourcesByProcess.get(t.operational_process_id) ||
        sourcesByProcess.set(t.operational_process_id, []).get(t.operational_process_id))!.push(t);
    }
  }

  const nameIds: string[] = [];
  for (const p of processes) nameIds.push(p.process_owner, p.subject_matter_expert, p.backup_sme);
  for (const g of openGaps) nameIds.push(g.assigned_sme);
  const names = await resolveNames(base44, nameIds.filter(Boolean));

  const concentration = findConcentrationRisks(
    processes.map((p) => ({
      id: p.id,
      criticality: p.criticality,
      subjectMatterExpert: p.subject_matter_expert,
      backupSme: p.backup_sme,
    })),
  );
  const concentratedProcessIds = new Set(concentration.flatMap((c) => c.criticalProcessIds));
  const concentrationLevelByProcess = new Map<string, "high" | "critical">();
  for (const c of concentration) for (const pid of c.criticalProcessIds) {
    const cur = concentrationLevelByProcess.get(pid);
    if (!cur || c.level === "critical") concentrationLevelByProcess.set(pid, c.level);
  }

  const rows: any[] = [];
  const queueItems: QueueItemInput[] = [];
  const ageOf = (d?: string | null) => (d ? Math.max(0, now - Date.parse(d)) : 0);
  const procById = new Map<string, any>(processes.map((p) => [p.id, p]));
  const gasById = new Map<string, any>(gas.map((t) => [t.id, t]));

  for (const p of processes) {
    const linked = sourcesByProcess.get(p.id) || [];
    const coverageState: CoverageState = deriveCoverageState(linked as HealthSourceLike[], now, hlc);
    const usable = usableSources(linked as HealthSourceLike[], now, hlc) as any[];
    const usableFreshnessStates = usable.map((s) =>
      computeFreshness(
        s.next_review_due_at,
        resolveReviewInterval(s.source_review_interval_days, p.review_interval_days),
        now,
      ),
    );
    const worstUsableFreshness = worstFreshness(usableFreshnessStates);
    const reviewCadenceResolved = !!p.review_interval_days ||
      linked.some((s) => typeof s.source_review_interval_days === "number" && s.source_review_interval_days > 0);

    const soleSme = p.subject_matter_expert && !p.backup_sme ? p.subject_matter_expert : null;
    const gapFunnel = soleSme
      ? (gapsByProcess.get(p.id) || []).filter((g) => g.assigned_sme === soleSme).length
      : 0;

    let kp = assessKeyPersonDependency({
      criticality: p.criticality,
      processOwner: p.process_owner,
      subjectMatterExpert: p.subject_matter_expert,
      backupSme: p.backup_sme,
      coverageState,
      worstUsableFreshness,
      gapFunnelToSoleSmeCount: gapFunnel,
    });
    // fold in portfolio concentration
    const concLevel = concentrationLevelByProcess.get(p.id);
    let kpLevel = kp.level;
    if (concLevel && (kpLevel === "none" || kpLevel === "informational" || kpLevel === "elevated" || kpLevel === "unknown")) {
      kpLevel = concLevel;
      kp = { ...kp, level: concLevel, drivers: [...kp.drivers, "expertise_concentration"] };
    }

    const openGapCount = (gapsByProcess.get(p.id) || []).length;
    const hasPromotedGap = (gapsByProcess.get(p.id) || []).some((g) => promotedGapIds.has(g.id));
    const exposures = assessContinuityExposure({
      criticality: p.criticality,
      coverageState,
      worstUsableFreshness,
      ownerPresent: !!p.process_owner,
      smePresent: !!p.subject_matter_expert,
      openGapCount,
      hasPromotedGap,
      reviewCadenceResolved,
    });
    const highestExposureSeverity = highestContinuityExposureSeverity(exposures);

    const continuityState = deriveContinuityState({
      coverageState,
      keyPersonLevel: kpLevel,
      highestExposureSeverity,
      ownerPresent: !!p.process_owner,
      smePresent: !!p.subject_matter_expert,
      criticalitySet: !!p.criticality,
      reviewCadenceResolved,
    });

    // --- Process Detail (P7-B1): plain-language drill-down for one process ---
    const failedLinked = linked.find((s) => s.index_status === "failed") || null;
    const unresolvedLinked =
      linked.find((s) => !s.index_status && hlc(s.id) === undefined) || null;
    const overdueLinked = usable.find((_s, i) => usableFreshnessStates[i] === "overdue") || null;
    const firstUnverifiedUsable = usable.find((s) => s.verification_status !== "verified") || null;

    const linkedSourceDetail = linked.map((s) => {
      const iv = resolveReviewInterval((s as any).source_review_interval_days, p.review_interval_days);
      const fr = computeFreshness((s as any).next_review_due_at, iv, now);
      const idx = resolveIndexState(s as HealthSourceLike, hlc(s.id));
      const inEffect = effectiveNow(s, now);
      return {
        id: s.id,
        title: (s as any).title || "Untitled source",
        verification: s.verification_status === "verified"
          ? "Verified"
          : s.verification_status === "rejected"
          ? "Rejected"
          : "Not yet verified",
        freshnessLabel: vocab.freshness[fr],
        effectiveLabel: inEffect ? "In effect" : "Outside its effective dates",
        documentationStatus: idx === "indexed"
          ? "Indexed and answering"
          : idx === "failed"
          ? "Failed to update — needs re-indexing"
          : idx === "unresolved"
          ? "Legacy — needs re-indexing to confirm"
          : idx === "absent"
          ? "No indexed content"
          : "Not indexed yet",
      };
    });

    const keyPersonReasons: string[] = [];
    for (const d of kp.drivers) {
      if (d === "sole_sme_no_backup") {
        keyPersonReasons.push("The subject-matter expert has no named backup on a critical process.");
      } else if (d === "owner_is_sole_sme") {
        keyPersonReasons.push("The same person is both the process owner and the only subject-matter expert.");
      } else if (d === "gaps_funnel_to_sole_sme") {
        keyPersonReasons.push("Several open questions on this process all depend on that one expert.");
      } else if (d === "expertise_concentration") {
        keyPersonReasons.push("This person is the sole expert on more than one critical process.");
      }
    }
    if (kp.amplified) {
      keyPersonReasons.push(
        "The documentation behind this dependency is unverified or overdue for review, which widens the exposure.",
      );
    }

    const recommendedActions: Array<{ label: string; href?: string; processId?: string }> = [];
    if (coverageState === "not_documented") {
      recommendedActions.push({ label: "Add or link a knowledge source for this process", href: "/admin" });
    }
    if (coverageState === "needs_attention" && failedLinked) {
      recommendedActions.push({ label: "Re-index the source that failed to update", href: `/training/${failedLinked.id}` });
    }
    if (coverageState === "unknown" && unresolvedLinked) {
      recommendedActions.push({
        label: "Re-index legacy knowledge to confirm documentation status",
        href: `/training/${unresolvedLinked.id}`,
      });
    }
    if (!p.process_owner || !p.subject_matter_expert) {
      recommendedActions.push({ label: "Assign an owner and a subject-matter expert", href: "/admin" });
    }
    if ((kpLevel === "high" || kpLevel === "critical") && !p.backup_sme) {
      recommendedActions.push({ label: "Name a backup subject-matter expert", href: "/admin" });
    }
    if (worstUsableFreshness === "overdue" && overdueLinked) {
      recommendedActions.push({ label: "Run a review check-in on the overdue source", href: `/training/${overdueLinked.id}` });
    }
    if (coverageState === "documented_unverified" && firstUnverifiedUsable) {
      recommendedActions.push({
        label: "Verify the active knowledge for this process",
        href: `/training/${firstUnverifiedUsable.id}`,
      });
    }
    if (hasPromotedGap) {
      recommendedActions.push({ label: "Review the recurring question this process can’t fully answer", href: "/admin" });
    }
    if (!reviewCadenceResolved) {
      recommendedActions.push({ label: "Set a review schedule for this process", href: "/admin" });
    }

    rows.push({
      id: p.id,
      name: p.name,
      department: p.department || null,
      criticality: p.criticality || null,
      owner: p.process_owner ? { id: p.process_owner, name: names[p.process_owner] } : null,
      sme: p.subject_matter_expert ? { id: p.subject_matter_expert, name: names[p.subject_matter_expert] } : null,
      backup: p.backup_sme ? { id: p.backup_sme, name: names[p.backup_sme] } : null,
      coverageState,
      coverageLabel: vocab.coverageState[coverageState],
      continuityState,
      continuityLabel: vocab.continuityState[continuityState],
      keyPersonLevel: kpLevel,
      keyPersonLabel: vocab.keyPersonLevel[kpLevel],
      keyPersonDrivers: kp.drivers,
      keyPersonPersons: kp.persons.map((x) => ({ ...x, name: names[x.userId] })),
      freshness: worstUsableFreshness,
      freshnessLabel: vocab.freshness[worstUsableFreshness],
      openGaps: openGapCount,
      clarifications: clarifsByProcess.get(p.id) || 0,
      linkedSourceCount: linked.length,
      detail: {
        description: p.description || null,
        linkedSources: linkedSourceDetail,
        openGaps: (gapsByProcess.get(p.id) || []).map((g) => ({
          id: g.id,
          title: g.title || g.normalized_topic || "Knowledge gap",
          state: g.status,
          promoted: promotedGapIds.has(g.id),
          timesAsked: g.times_asked || 0,
          distinctReporters: g.distinct_reporters || 0,
          missingFacets: g.missing_facets || [],
        })),
        clarifications: {
          total: clarifsByProcess.get(p.id) || 0,
          awaitingEmployee: clarifs.filter(
            (c) => c.operational_process_id === p.id && c.status === "awaiting_employee",
          ).length,
        },
        keyPersonReasons,
        recommendedActions,
      },
    });

    // queue item — one per process, the most severe issue. Criticality is a
    // sort tier (prioritizeQueue), NOT a gate: a proven-undocumented process is
    // queued at every criticality, including unset (P7-B3).
    const critTag = p.criticality;
    const dept = p.department || null;
    const pushQ = (
      kind: QueueItemInput["kind"],
      ageMs: number,
      sourceId: string | null = null,
    ) =>
      queueItems.push({
        id: `proc:${p.id}:${kind}`,
        kind,
        criticality: critTag,
        ageMs,
        processId: p.id,
        sourceId,
        department: dept,
        title: p.name,
      });
    const pAge = ageOf(p.created_date);
    if (coverageState === "needs_attention") pushQ("source_failure", pAge, failedLinked?.id ?? null);
    else if (coverageState === "not_documented") pushQ("not_documented", pAge);
    else if (kpLevel === "high" || kpLevel === "critical") pushQ("key_person_dependency", pAge);
    else if (coverageState === "unknown") pushQ("legacy_coverage_unresolved", pAge, unresolvedLinked?.id ?? null);
    else if (worstUsableFreshness === "overdue") pushQ("overdue_review", pAge, overdueLinked?.id ?? null);
    else if (!p.process_owner || !p.subject_matter_expert) pushQ("missing_owner_sme", pAge);
    else if (!reviewCadenceResolved) pushQ("no_review_cadence", pAge);
  }

  // active-not-verified queue items (linked to a process for criticality)
  for (const t of gas) {
    if (t.verification_status === "verified") continue;
    const p = t.operational_process_id ? procById.get(t.operational_process_id) : null;
    queueItems.push({
      id: `src:${t.id}:verify`,
      kind: "active_not_verified",
      criticality: p?.criticality || null,
      ageMs: ageOf(t.created_date),
      processId: t.operational_process_id || null,
      sourceId: t.id,
      department: p?.department || t.department || null,
      title: t.title || "Untitled source",
    });
  }

  // expired-active queue items: a published, in-effect-indexed source now past
  // its effective_until (P7-B2).
  for (const t of gas) {
    if (!(t.effective_until && Date.parse(t.effective_until) < now && (t.index_status ?? "indexed") === "indexed")) {
      continue;
    }
    const p = t.operational_process_id ? procById.get(t.operational_process_id) : null;
    queueItems.push({
      id: `src:${t.id}:expired`,
      kind: "expired_active",
      criticality: p?.criticality || null,
      ageMs: Math.max(0, now - Date.parse(t.effective_until)),
      processId: t.operational_process_id || null,
      sourceId: t.id,
      department: p?.department || t.department || null,
      title: t.title || "Published source",
    });
  }

  // draft-revision queue items: changes-requested drafts, and drafts that have
  // been sitting open past DRAFT_STUCK_DAYS (P7-B2). Active versions and
  // archived/rejected drafts are excluded.
  for (const t of scopedReady) {
    if (t.is_active_version === true || t.is_archived === true || t.verification_status === "rejected") continue;
    const ls: string = t.lifecycle_state ||
      (t.review_outcome === "changes_requested" ? "changes_requested" : "draft");
    if (ls !== "draft" && ls !== "in_review" && ls !== "changes_requested") continue;
    const p = t.operational_process_id ? procById.get(t.operational_process_id) : null;
    const age = ageOf(t.review_requested_at || t.created_date);
    if (ls === "changes_requested") {
      queueItems.push({
        id: `src:${t.id}:changes_requested`,
        kind: "changes_requested",
        criticality: p?.criticality || null,
        ageMs: age,
        processId: t.operational_process_id || null,
        sourceId: t.id,
        department: p?.department || t.department || null,
        title: t.title || "Draft revision",
      });
    } else if (age >= DRAFT_STUCK_DAYS * DAY_MS) {
      queueItems.push({
        id: `src:${t.id}:draft_stuck`,
        kind: "draft_stuck",
        criticality: p?.criticality || null,
        ageMs: age,
        processId: t.operational_process_id || null,
        sourceId: t.id,
        department: p?.department || t.department || null,
        title: t.title || "Draft revision",
      });
    }
  }

  // clarification threads waiting on the employee (P7-B2). No employee text is
  // carried — the title is the process name or a generic label.
  for (const c of clarifs) {
    if (c.status !== "awaiting_employee") continue;
    const p = c.operational_process_id ? procById.get(c.operational_process_id) : null;
    queueItems.push({
      id: `clarif:${c.id}`,
      kind: "awaiting_employee",
      criticality: p?.criticality || null,
      ageMs: ageOf(c.last_message_at || c.created_date),
      processId: c.operational_process_id || null,
      sourceId: null,
      department: p?.department || null,
      title: p ? p.name : "Clarification thread",
    });
  }

  // promoted / open gap queue items
  for (const g of openGaps) {
    const p = g.operational_process_id ? procById.get(g.operational_process_id) : null;
    queueItems.push({
      id: `gap:${g.id}`,
      kind: promotedGapIds.has(g.id) ? "promoted_gap" : "open_gap",
      criticality: p?.criticality || null,
      ageMs: ageOf(g.first_seen_at),
      processId: g.operational_process_id || null,
      sourceId: null,
      department: p?.department || null,
      title: g.title || g.normalized_topic || "Knowledge gap",
    });
  }

  // "What should I do next?" — a link into an EXISTING governed workflow. The
  // dashboard never mutates lifecycle state itself (P7-B5).
  const queueAction = (
    it: QueueItemInput,
  ): { label: string; href?: string; processId?: string } | null => {
    switch (it.kind) {
      case "source_failure":
      case "legacy_coverage_unresolved":
      case "active_not_verified":
      case "expired_active":
      case "overdue_review":
        return it.sourceId
          ? { label: "Open the source", href: `/training/${it.sourceId}` }
          : it.processId
          ? { label: "Open process detail", processId: it.processId }
          : null;
      case "changes_requested":
        return it.sourceId ? { label: "Review the draft revision", href: `/training/${it.sourceId}` } : null;
      case "draft_stuck":
        return it.sourceId ? { label: "Open the stalled draft", href: `/training/${it.sourceId}` } : null;
      case "not_documented":
      case "key_person_dependency":
      case "missing_owner_sme":
      case "no_review_cadence":
        return it.processId ? { label: "Open process detail", processId: it.processId } : null;
      case "promoted_gap":
      case "open_gap":
        return it.processId
          ? { label: "Open process detail", processId: it.processId }
          : { label: "Open Knowledge Gaps", href: "/admin" };
      case "awaiting_employee":
        return { label: "Open the clarification queue", href: "/admin" };
      default:
        return null;
    }
  };

  const orderedQueue = prioritizeQueue(queueItems);
  const addressFirst = topAddressFirst(queueItems, 10).map((it) => ({
    ...it,
    label: vocab.queueKind[it.kind],
    action: queueAction(it),
  }));

  // --- metrics --------------------------------------------------
  const inScopeCritical = rows.filter((r) => isCritical(r.criticality));
  const evaluableCritical = inScopeCritical.filter((r) => r.coverageState !== "unknown");
  const coveredCritical = evaluableCritical.filter((r) => r.coverageState === "documented_verified");
  const unknownCritical = inScopeCritical.filter((r) => r.coverageState === "unknown");

  const gasCount = gas.length;
  const verifiedCount = gas.filter((t) => t.verification_status === "verified").length;
  const unverifiedCount = gasCount - verifiedCount;
  const unverifiedCriticalLinked = gas.filter(
    (t) => t.verification_status !== "verified" && isCritical(procById.get(t.operational_process_id)?.criticality),
  ).length;

  const scheduled = gas
    .map((t) => ({
      nextReviewDueAt: t.next_review_due_at,
      intervalDays: resolveReviewInterval(
        t.source_review_interval_days,
        procById.get(t.operational_process_id)?.review_interval_days,
      ),
    }))
    .filter((x) => x.intervalDays != null && x.nextReviewDueAt);
  const freshBuckets = bucketFreshness(scheduled, now);
  const scheduledCount = scheduled.length;
  const overdueCount = freshBuckets.overdue;

  const m6ProcessIds = new Set([
    ...rows.filter((r) => r.keyPersonLevel === "high" || r.keyPersonLevel === "critical").map((r) => r.id),
    ...concentratedProcessIds,
  ]);
  const keyPersonHighCritical = m6ProcessIds.size;
  const concentrationPeople = concentration.length;

  const sourcesNeedingAttention = gas.filter(
    (t) => t.index_status === "failed" || failedOpRoots.has(t.root_source_id || t.id),
  ).length;

  const expiredActive = gas.filter(
    (t) => t.effective_until && Date.parse(t.effective_until) < now && (t.index_status ?? "indexed") === "indexed",
  ).length;

  const missingOwnerOrSme = processes.filter((p) => !p.process_owner || !p.subject_matter_expert).length;

  // --- bands --------------------------------------------------
  const bands = {
    coverage: {
      band: coverageBand({
        evaluableCritical: evaluableCritical.length,
        coveredCritical: coveredCritical.length,
        inScopeCritical: inScopeCritical.length,
        unknownCritical: unknownCritical.length,
      }),
    },
    currency: { band: currencyBand({ scheduledCount, overdueCount }) },
    verification: { band: verificationBand({ gasCount, verifiedCount }) },
    keyPersonResilience: {
      band: keyPersonResilienceBand({ highOrCriticalKeyPersonProcesses: keyPersonHighCritical }),
    },
  };
  const bandsLabelled = {
    coverage: { ...bands.coverage, label: vocab.bands.coverage[bands.coverage.band] },
    currency: { ...bands.currency, label: vocab.bands.currency[bands.currency.band] },
    verification: {
      ...bands.verification,
      label: vocab.bands.verification[bands.verification.band],
      caveat: unverifiedCount > 0 ? vocab.copy.legacyVerificationCaveat : null,
    },
    keyPersonResilience: {
      ...bands.keyPersonResilience,
      label: vocab.bands.keyPersonResilience[bands.keyPersonResilience.band],
    },
  };

  // --- key-person exposure (people, not processes) ------------
  const exposurePeople = new Map<string, { userId: string; name: string; processes: any[]; concentration: boolean }>();
  for (const r of rows) {
    for (const person of r.keyPersonPersons) {
      const e = exposurePeople.get(person.userId) ||
        exposurePeople.set(person.userId, { userId: person.userId, name: person.name, processes: [], concentration: false }).get(person.userId)!;
      e.processes.push({ id: r.id, name: r.name, criticality: r.criticality, role: person.role });
    }
  }
  for (const c of concentration) {
    const e = exposurePeople.get(c.userId) ||
      exposurePeople.set(c.userId, { userId: c.userId, name: names[c.userId] || c.userId, processes: [], concentration: false }).get(c.userId)!;
    e.concentration = true;
    e.name = names[c.userId] || e.name;
  }

  // --- setup / governance ---------------------------------------
  const setup = {
    processesNeedingOwner: processes.filter((p) => !p.process_owner).length,
    processesNeedingSme: processes.filter((p) => !p.subject_matter_expert).length,
    processesNeedingCriticality: processes.filter((p) => !p.criticality).length,
    sourcesNeedingCadence: gas.filter(
      (t) =>
        resolveReviewInterval(
          t.source_review_interval_days,
          procById.get(t.operational_process_id)?.review_interval_days,
        ) == null,
    ).length,
    unlinkedSources: gas.filter((t) => !t.operational_process_id).length,
    unclassifiedItems: unclassifiedCount,
    legacyNeedingReindex: legacyStats.undetermined + legacyStats.truncated_count,
  };

  return {
    scope: scope.kind === "client" ? { kind: "client", clientId: scope.clientId } : { kind: "general" },
    generated_at: new Date(now).toISOString(),
    snapshot: bandsLabelled,
    metrics: {
      criticalCoverage: {
        covered: coveredCritical.length,
        evaluable: evaluableCritical.length,
        unknown: unknownCritical.length,
        display: `${coveredCritical.length} of ${evaluableCritical.length} evaluated critical processes covered`,
        unknownDisplay: unknownCritical.length > 0
          ? `${unknownCritical.length} critical processes need documentation status confirmed.`
          : null,
      },
      knowledgeNeedingReview: { overdue: freshBuckets.overdue, due_soon: freshBuckets.due_soon },
      activeNotVerified: { total: unverifiedCount, criticalLinked: unverifiedCriticalLinked },
      openGaps: { open: openGaps.length, watching: candidateGaps.length },
      processesWithoutOwnerOrSme: missingOwnerOrSme,
      keyPersonDependencyRisk: { processes: keyPersonHighCritical, concentrationPeople },
      sourcesNeedingAttention,
      effectiveDateExposure: { expiredActive },
    },
    processRows: rows,
    keyPersonExposure: [...exposurePeople.values()],
    concentrationFindings: concentration.map((c) => ({ ...c, name: names[c.userId] || c.userId })),
    reviewQueue: orderedQueue.slice(0, 300).map((it) => ({
      ...it,
      label: vocab.queueKind[it.kind],
      action: queueAction(it),
    })),
    addressFirst,
    // Watching (candidate) + Open + Under review — a candidate gap is surfaced
    // as evidence being watched, never as an actionable open gap (P7-B6).
    gaps: [...openGaps, ...candidateGaps].map((g) => {
      const p = g.operational_process_id ? procById.get(g.operational_process_id) : null;
      const relIds = (g.related_source_ids || []).filter((sid: string) => gasById.has(sid));
      return {
        id: g.id,
        title: g.title || g.normalized_topic,
        state: g.status, // 'candidate' | 'open' | 'under_review'
        actionable: g.status === "open" || g.status === "under_review",
        promoted: promotedGapIds.has(g.id),
        timesAsked: g.times_asked || 0,
        distinctReporters: g.distinct_reporters || 0,
        processId: g.operational_process_id || null,
        processName: p ? p.name : null,
        missingFacets: g.missing_facets || [],
        firstSeenAt: g.first_seen_at || null,
        lastSeenAt: g.last_seen_at || null,
        ageDays: g.first_seen_at
          ? Math.max(0, Math.floor((now - Date.parse(g.first_seen_at)) / DAY_MS))
          : null,
        relatedSourceCount: relIds.length,
        relatedSourceTitles: relIds
          .slice(0, 5)
          .map((sid: string) => gasById.get(sid)?.title || "Untitled source"),
        hasUnresolvedClarification: !!(
          g.operational_process_id && (clarifsByProcess.get(g.operational_process_id) || 0) > 0
        ),
      };
    }),
    gapInvariantNote: vocab.copy.gapNotKnowledge,
    setup,
    legacy_index_lookup: legacyStats,
    clientProcessCounts: scope.kind === "general" ? clientProcessCounts : undefined,
    freshnessNote: vocab.copy.freshnessNotCorrectness,
  };
}
