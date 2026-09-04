// MindVault BINDING for Phase 8 P8-1 notifications.
//
// Loads governed entities via the Base44 client (passed in as a parameter, so
// this is node-loadable for tests with a stub client) and computes the six
// P8-1 findings as a deterministic projection of governed state. It reuses the
// Phase 6/7 primitives — it never re-implements their business rules.
//
// Kinds generated here (P8-1 only):
//   review_due_soon / review_overdue  — usable governed-active sources only
//   source_failure                    — explicit index_status 'failed' OR latest
//                                       lifecycle operation failed/compensating
//   gap_actionable                    — Phase 5 promotion semantics / assignment
//   process_governance                — Phase 7 exposure findings only
//   key_person                        — Phase 7 key-person dependency, high/critical
//   draft_stuck (P8-3)                — the ONE shared Phase 7 predicate
//                                       (assessStuckDraft) — never a second definition
//
// NO LLM, NO embeddings, NO randomness, NO retrieval changes, NO writes — this
// module only computes findings. Episode reconciliation lives in engine.ts and
// execution lives in the computeNotifications function.

import {
  assessContinuityExposure,
  assessKeyPersonDependency,
  assessStuckDraft,
  computeFreshness,
  deriveCoverageState,
  findConcentrationRisks,
  governedActiveSource,
  resolveReviewInterval,
  usableSources,
  worstFreshness,
} from "../health/index.ts";
import { legacyChunkExistence } from "../mindvaultHealth.ts";
import {
  actionFor,
  buildMessage,
  buildTitle,
  DAY_MS,
  makeDedupeKey,
  overdueSeverityForCriticality,
  pickFirstPresent,
  severityFromExposureSeverity,
  type FindingDraft,
  type FindingSeverity,
  type NotificationContext,
  type NotificationKind,
} from "./engine.ts";

const PAGE_LIMIT = 5000;

export interface NotificationFindingsResult {
  findings: FindingDraft[];
  stats: {
    processes: number;
    gas_sources: number;
    open_gaps: number;
    admins: number;
    findings: number;
  };
}

export async function computeNotificationFindings(
  base44: any,
  opts: { now?: number } = {},
): Promise<NotificationFindingsResult> {
  const now = opts.now ?? Date.now();
  const svc = base44.asServiceRole.entities;

  const [allProcesses, allTrainings, allGaps, allOps, allUsers] = await Promise.all([
    svc.OperationalProcess.filter({}, "-created_date", PAGE_LIMIT).catch(() => []),
    svc.Training.filter({ status: "ready" }, "-created_date", PAGE_LIMIT).catch(() => []),
    svc.KnowledgeGap.filter(
      { status: { $in: ["open", "under_review"] } },
      "-last_seen_at",
      PAGE_LIMIT,
    ).catch(() => []),
    svc.KnowledgeLifecycleOperation.filter(
      { status: { $in: ["failed", "compensating", "completed"] } },
      "-started_at",
      2000,
    ).catch(() => []),
    svc.User.filter({}, null, PAGE_LIMIT).catch(() => []),
  ]);

  // Recipients must be live users; dead ids fall through to admin.
  const users = (allUsers as any[]).filter((u) => u && u.id);
  const validUserIds = new Set(users.map((u) => u.id));
  const adminIds = users.filter((u) => u.role === "admin").map((u) => u.id);

  // Same in-scope population as the Phase 7 health binding: active, classified
  // processes; ready, classified trainings; governed-active sources (GAS).
  const processes = (allProcesses as any[]).filter(
    (p) =>
      p.status === "active" &&
      (p.knowledge_scope === "general" || p.knowledge_scope === "client-specific"),
  );
  const scopedReady = (allTrainings as any[]).filter(
    (t) => t.knowledge_scope === "general" || t.knowledge_scope === "client-specific",
  );
  const gas = scopedReady.filter((t) => governedActiveSource(t));
  const gaps = allGaps as any[];

  // Client names for client-scoped message context only. scopedReady (not just
  // gas) so DRAFT revisions — which the P8-3 draft_stuck finding describes —
  // also resolve their client name for the message.
  const clientIds = new Set<string>();
  for (const x of [...scopedReady, ...processes]) {
    if (x.knowledge_scope === "client-specific" && x.client_id) clientIds.add(x.client_id);
  }
  const clients = clientIds.size
    ? await svc.Client.filter({ id: { $in: [...clientIds] } }, null, PAGE_LIMIT).catch(() => [])
    : [];
  const clientName = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const c = (clients as any[]).find((x) => x.id === id);
    return c?.name || null;
  };

  const procById = new Map<string, any>(processes.map((p) => [p.id, p]));
  const sourcesByProcess = new Map<string, any[]>();
  for (const t of gas) {
    if (!t.operational_process_id) continue;
    const arr = sourcesByProcess.get(t.operational_process_id) || [];
    arr.push(t);
    sourcesByProcess.set(t.operational_process_id, arr);
  }
  const gapsByProcess = new Map<string, any[]>();
  for (const g of gaps) {
    if (!g.operational_process_id) continue;
    const arr = gapsByProcess.get(g.operational_process_id) || [];
    arr.push(g);
    gapsByProcess.set(g.operational_process_id, arr);
  }

  // Bounded legacy chunk-existence lookup (same primitive the health binding uses).
  const legacyIds = gas.filter((t) => !t.index_status).map((t) => t.id);
  const { answer: hasLegacyChunk } = await legacyChunkExistence(base44, legacyIds);
  const hlc = (id: string) => hasLegacyChunk(id);

  // Latest lifecycle operation per lineage root — a lineage is failing only if
  // its LATEST relevant operation is failed/compensating (no newer completed op).
  const latestOpByRoot = new Map<string, any>();
  for (const o of allOps as any[]) {
    if (!o || !o.root_source_id) continue;
    const cur = latestOpByRoot.get(o.root_source_id);
    if (!cur || String(o.started_at || "") > String(cur.started_at || "")) {
      latestOpByRoot.set(o.root_source_id, o);
    }
  }
  const lineageFailing = (t: any): boolean => {
    const op = latestOpByRoot.get(t.root_source_id || t.id);
    return !!op && (op.status === "failed" || op.status === "compensating");
  };

  const findings: FindingDraft[] = [];
  const scopeOf = (x: any): string =>
    x.knowledge_scope === "client-specific" && x.client_id ? `client:${x.client_id}` : "general";

  const addFinding = (x: {
    kind: NotificationKind;
    finding: string | null;
    severity: FindingSeverity;
    dedupeKey: string;
    recipients: string[];
    clientScope: string;
    ctx: NotificationContext;
    refs: { processId?: string | null; sourceId?: string | null; gapId?: string | null };
  }) => {
    const act = actionFor(x.kind, { sourceId: x.refs.sourceId, processId: x.refs.processId });
    const title = buildTitle(x.kind, x.finding, x.ctx);
    const message = buildMessage(x.kind, x.finding, x.ctx);
    for (const r of new Set(x.recipients)) {
      findings.push({
        kind: x.kind,
        finding: x.finding,
        severity: x.severity,
        dedupeKey: x.dedupeKey,
        recipientUserId: r,
        clientScope: x.clientScope,
        title,
        message,
        actionLabel: act.label,
        actionHref: act.href,
        operationalProcessId: x.refs.processId ?? null,
        sourceId: x.refs.sourceId ?? null,
        knowledgeGapId: x.refs.gapId ?? null,
      });
    }
  };

  // Portfolio concentration (same binding semantics as Phase 7).
  const concentration = findConcentrationRisks(
    processes.map((p) => ({
      id: p.id,
      criticality: p.criticality,
      subjectMatterExpert: p.subject_matter_expert,
      backupSme: p.backup_sme,
    })),
  );
  const concentrationLevelByProcess = new Map<string, "high" | "critical">();
  for (const c of concentration) {
    for (const pid of c.criticalProcessIds) {
      const cur = concentrationLevelByProcess.get(pid);
      if (!cur || c.level === "critical") concentrationLevelByProcess.set(pid, c.level);
    }
  }

  // Usable-source index (review kinds are about USABLE sources only — F4).
  const usableIds = new Set<string>();
  for (const p of processes) {
    for (const s of usableSources(sourcesByProcess.get(p.id) || [], now, hlc)) {
      usableIds.add(s.id);
    }
  }
  for (const t of gas) {
    if (t.operational_process_id) continue;
    if (usableSources([t], now, hlc).some((s: any) => s.id === t.id)) usableIds.add(t.id);
  }

  // --- per-process findings: process_governance + key_person ----------------
  for (const p of processes) {
    const linked = sourcesByProcess.get(p.id) || [];
    const coverageState = deriveCoverageState(linked, now, hlc);
    const usable = usableSources(linked, now, hlc);
    const fr = usable.map((s: any) =>
      computeFreshness(
        s.next_review_due_at,
        resolveReviewInterval(s.source_review_interval_days, p.review_interval_days),
        now,
      ),
    );
    const worstUsableFreshness = worstFreshness(fr);
    const reviewCadenceResolved =
      !!p.review_interval_days ||
      linked.some(
        (s: any) =>
          typeof s.source_review_interval_days === "number" && s.source_review_interval_days > 0,
      );
    const openProcessGaps = gapsByProcess.get(p.id) || [];
    const hasPromotedGap = openProcessGaps.some(
      (g: any) => (g.times_asked || 0) >= 3 && (g.distinct_reporters || 0) >= 2,
    );

    // process_governance — ONLY the Phase 7 exposure findings, severity mapped
    // from that same exposure. Missing backup SME is deliberately absent here:
    // in the validated Phase 7 model that is a key-person driver, not a
    // governance exposure.
    const exposures = assessContinuityExposure({
      criticality: p.criticality,
      coverageState,
      worstUsableFreshness,
      ownerPresent: !!p.process_owner,
      smePresent: !!p.subject_matter_expert,
      openGapCount: openProcessGaps.length,
      hasPromotedGap,
      reviewCadenceResolved,
    });
    const exposureSeverity = (kind: string) => {
      const e = exposures.find((x) => x.kind === kind);
      return e ? severityFromExposureSeverity(e.severity) : null;
    };
    const govCtx: NotificationContext = {
      subjectTitle: p.name || "Process",
      processName: p.name || null,
      clientName: p.knowledge_scope === "client-specific" ? clientName(p.client_id) : null,
    };
    const ownerOrAdmin = () => {
      const owner = pickFirstPresent([p.process_owner], validUserIds);
      return owner ? [owner] : adminIds;
    };
    if (!p.process_owner && exposureSeverity("missing_owner")) {
      addFinding({
        kind: "process_governance",
        finding: "missing_owner",
        severity: exposureSeverity("missing_owner") as FindingSeverity,
        dedupeKey: makeDedupeKey("process_governance", "missing_owner", p.id),
        recipients: adminIds, // by definition there is no owner to notify
        clientScope: scopeOf(p),
        ctx: govCtx,
        refs: { processId: p.id },
      });
    }
    if (!p.subject_matter_expert && exposureSeverity("missing_sme")) {
      addFinding({
        kind: "process_governance",
        finding: "missing_sme",
        severity: exposureSeverity("missing_sme") as FindingSeverity,
        dedupeKey: makeDedupeKey("process_governance", "missing_sme", p.id),
        recipients: ownerOrAdmin(),
        clientScope: scopeOf(p),
        ctx: govCtx,
        refs: { processId: p.id },
      });
    }
    if (!reviewCadenceResolved && exposureSeverity("missing_review_cadence")) {
      addFinding({
        kind: "process_governance",
        finding: "missing_review_cadence",
        severity: exposureSeverity("missing_review_cadence") as FindingSeverity,
        dedupeKey: makeDedupeKey("process_governance", "missing_review_cadence", p.id),
        recipients: ownerOrAdmin(),
        clientScope: scopeOf(p),
        ctx: govCtx,
        refs: { processId: p.id },
      });
    }
    if (!p.criticality && exposureSeverity("criticality_unset")) {
      addFinding({
        kind: "process_governance",
        finding: "criticality_unset",
        severity: exposureSeverity("criticality_unset") as FindingSeverity,
        dedupeKey: makeDedupeKey("process_governance", "criticality_unset", p.id),
        recipients: ownerOrAdmin(),
        clientScope: scopeOf(p),
        ctx: govCtx,
        refs: { processId: p.id },
      });
    }

    // key_person — Phase 7 dependency assessment (+ concentration fold, exactly
    // as the health binding computes it). Only high/critical findings notify.
    const soleSme =
      p.subject_matter_expert && !p.backup_sme ? p.subject_matter_expert : null;
    const gapFunnel = soleSme
      ? openProcessGaps.filter((g: any) => g.assigned_sme === soleSme).length
      : 0;
    const kp = assessKeyPersonDependency({
      criticality: p.criticality,
      processOwner: p.process_owner,
      subjectMatterExpert: p.subject_matter_expert,
      backupSme: p.backup_sme,
      coverageState,
      worstUsableFreshness,
      gapFunnelToSoleSmeCount: gapFunnel,
    });
    let kpLevel = kp.level;
    const concLevel = concentrationLevelByProcess.get(p.id);
    if (concLevel && kpLevel !== "high" && kpLevel !== "critical") {
      kpLevel = concLevel;
    }
    if (kpLevel === "high" || kpLevel === "critical") {
      // NEVER notify the flagged person merely for being the dependency
      // subject. Messages describe process risk, never the employee.
      const subjects = new Set<string>(kp.persons.map((x) => x.userId));
      if (p.subject_matter_expert) subjects.add(p.subject_matter_expert);
      const recipients = [...adminIds];
      if (p.process_owner && validUserIds.has(p.process_owner) && !subjects.has(p.process_owner)) {
        recipients.push(p.process_owner);
      }
      addFinding({
        kind: "key_person",
        finding: null,
        severity: "urgent",
        dedupeKey: makeDedupeKey("key_person", null, p.id),
        recipients,
        clientScope: scopeOf(p),
        ctx: {
          subjectTitle: p.name || "Process",
          processName: p.name || null,
          clientName: p.knowledge_scope === "client-specific" ? clientName(p.client_id) : null,
        },
        refs: { processId: p.id },
      });
    }
  }

  // --- per-source findings: review_due_soon / review_overdue / source_failure -
  for (const s of gas) {
    const p = s.operational_process_id ? procById.get(s.operational_process_id) : null;
    const clientScope = scopeOf(s);
    const clientNm = s.knowledge_scope === "client-specific" ? clientName(s.client_id) : null;
    const baseCtx = {
      subjectTitle: s.title || "Untitled source",
      processName: p ? p.name : null,
      clientName: clientNm,
    };

    // Reviews: usable governed-active sources only. A source is in exactly one
    // freshness state, so an overdue source never also emits due_soon — and any
    // older open due_soon episode for it is closed by reconciliation.
    if (usableIds.has(s.id)) {
      const interval = resolveReviewInterval(
        s.source_review_interval_days,
        p ? p.review_interval_days : null,
      );
      const freshness = computeFreshness(s.next_review_due_at, interval, now);
      const daysOverdue =
        freshness === "overdue" && s.next_review_due_at
          ? Math.max(0, Math.floor((now - Date.parse(s.next_review_due_at)) / DAY_MS))
          : null;
      const recipients = p
        ? pickFirstPresent(
            [p.process_owner, p.subject_matter_expert, p.backup_sme],
            validUserIds,
          )
        : null;
      const reviewRecipients = recipients ? [recipients] : adminIds; // no linked process -> admin
      if (freshness === "due_soon") {
        addFinding({
          kind: "review_due_soon",
          finding: null,
          severity: "info",
          dedupeKey: makeDedupeKey("review_due_soon", null, s.id),
          recipients: reviewRecipients,
          clientScope,
          ctx: { ...baseCtx, dueDate: s.next_review_due_at || null },
          refs: { processId: p ? p.id : null, sourceId: s.id },
        });
      } else if (freshness === "overdue") {
        addFinding({
          kind: "review_overdue",
          finding: null,
          severity: overdueSeverityForCriticality(p ? p.criticality : null),
          dedupeKey: makeDedupeKey("review_overdue", null, s.id),
          recipients: reviewRecipients,
          clientScope,
          ctx: { ...baseCtx, daysOverdue },
          refs: { processId: p ? p.id : null, sourceId: s.id },
        });
      }
    }

    // source_failure — ONLY an actual governed source/lifecycle/index failure.
    // Process-level coverage rollups (needs_attention, not_documented, unknown,
    // legacy_coverage_unresolved, active_not_verified, expired_active) remain
    // Phase 7 dashboard findings and never become notifications.
    const failed = s.index_status === "failed" || lineageFailing(s);
    if (failed) {
      const critical = !!p && (p.criticality === "high" || p.criticality === "mission_critical");
      const severity: FindingSeverity = critical ? "urgent" : "needs_attention";
      const primary = p
        ? pickFirstPresent([p.process_owner, p.subject_matter_expert], validUserIds)
        : null;
      // Urgent failures always copy admins; non-critical ones go up the chain
      // with admin as the fallback.
      const recipients = critical
        ? [...(primary ? [primary] : []), ...adminIds]
        : primary
        ? [primary]
        : adminIds;
      addFinding({
        kind: "source_failure",
        finding: null,
        severity,
        dedupeKey: makeDedupeKey("source_failure", null, s.id),
        recipients,
        clientScope,
        ctx: baseCtx,
        refs: { processId: p ? p.id : null, sourceId: s.id },
      });
    }
  }

  // --- per-gap findings: gap_actionable -------------------------------------
  for (const g of gaps) {
    // Actionable = status 'open' (the existing Phase 5 promotion semantics put a
    // gap there: >=3 asked, >=2 reporters) OR an open/under_review gap with an
    // assigned SME. No new promotion rule.
    const actionable = g.status === "open" || (g.status === "under_review" && !!g.assigned_sme);
    if (!actionable) continue;
    const p = g.operational_process_id ? procById.get(g.operational_process_id) : null;
    const promoted = (g.times_asked || 0) >= 3 && (g.distinct_reporters || 0) >= 2;
    const critical = !!p && (p.criticality === "high" || p.criticality === "mission_critical");
    const severity: FindingSeverity = promoted && critical ? "urgent" : "needs_attention";
    const primary = pickFirstPresent([g.assigned_sme, p ? p.process_owner : null], validUserIds);
    const recipients = primary ? [primary] : adminIds;
    // Safe context ONLY: the gap title (SME-edited human label) or the normalized
    // topic signature. Never raw question text, never reporter identity.
    const subjectTitle = g.title || g.normalized_topic || "Knowledge gap";
    addFinding({
      kind: "gap_actionable",
      finding: null,
      severity,
      dedupeKey: makeDedupeKey("gap_actionable", null, g.id),
      recipients,
      clientScope: g.client_scope || "general",
      ctx: {
        subjectTitle,
        processName: p ? p.name : null,
        // clientName for a client-scoped gap message context:
        clientName:
          g.client_scope && g.client_scope.startsWith("client:")
            ? clientName(g.client_scope.slice("client:".length))
            : null,
      },
      refs: { processId: p ? p.id : null, gapId: g.id },
    });
  }

  // --- per-source finding: draft_stuck (P8-3) -------------------------------
  // The ONE shared Phase 7 predicate (assessStuckDraft from ../health/draftStuck.ts)
  // — no second definition. Only kind 'draft_stuck' notifies; Phase 7's
  // changes_requested queue kind stays dashboard work, deliberately not a
  // notification. Superseded history, archived/rejected rows, and completed
  // reviews fail the predicate and never notify.
  const draftLineageGroups = new Map<string, any[]>();
  for (const t of scopedReady) {
    const key = t.root_source_id || t.id;
    const arr = draftLineageGroups.get(key) || [];
    arr.push(t);
    draftLineageGroups.set(key, arr);
  }
  for (const t of scopedReady) {
    const a = assessStuckDraft(t, draftLineageGroups.get(t.root_source_id || t.id) || [t], now);
    if (a.kind !== "draft_stuck") continue;
    const p = t.operational_process_id ? procById.get(t.operational_process_id) : null;
    const primary = p
      ? pickFirstPresent([p.process_owner, p.subject_matter_expert, p.backup_sme], validUserIds)
      : null;
    addFinding({
      kind: "draft_stuck",
      finding: null,
      severity: "needs_attention",
      dedupeKey: makeDedupeKey("draft_stuck", null, t.id),
      recipients: primary ? [primary] : adminIds,
      clientScope: scopeOf(t),
      ctx: {
        subjectTitle: t.title || "Draft revision",
        processName: p ? p.name : null,
        clientName: t.knowledge_scope === "client-specific" ? clientName(t.client_id) : null,
        sinceDate: t.review_requested_at || t.created_date || null,
      },
      refs: { processId: p ? p.id : null, sourceId: t.id },
    });
  }

  return {
    findings,
    stats: {
      processes: processes.length,
      gas_sources: gas.length,
      open_gaps: gaps.length,
      admins: adminIds.length,
      findings: findings.length,
    },
  };
}