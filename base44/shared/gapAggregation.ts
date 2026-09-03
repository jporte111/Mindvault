// Phase 5 gap-aggregation with Base44 I/O. Takes the client as a parameter so
// both submitKnowledgeFeedback and logKnowledgeGap (and, behind a flag,
// askKnowledgeBaseV2) share one code path. The pure decision logic it calls
// lives in ./knowledgeGap.ts and is unit-tested; this wrapper only does reads
// and writes to the Phase 5 entities.
//
// It NEVER writes to Training / KnowledgeChunk / OperationalProcess. The single
// Training.get() below is a write-time lookup to inherit a process id — not a
// retrieval-path live join.

import {
  GAP_DEDUP_JACCARD,
  type GapOrigin,
  mergeGapUpdate,
  newGapFields,
  normalizeTopic,
  parseClientScope,
  relatedSourceInGapScope,
  shouldDedupe,
  topicKeywords,
  topicSignature,
} from "./knowledgeGap.ts";

export interface GapEventInput {
  question?: string; // raw question (preferred for keyword extraction)
  normalizedTopic?: string; // OR a pre-normalized topic string
  clientScope: string; // "general" | "client:<id>" — verbatim from the answer
  operationalProcessId?: string | null;
  relatedSourceIds?: string[];
  missingFacets?: string[];
  origin: GapOrigin;
  reporterHmac: string;
  // PASSIVE capture — the caller passes null unless answer_logging_enabled is on.
  exampleQuestion?: string | null;
}

export interface GapAggregationResult {
  knowledge_gap_id: string;
  status: string;
  deduped: boolean;
  promoted: boolean;
}

/**
 * Resolve the incoming related-source ids to Training rows and keep ONLY the
 * ones whose scope is compatible with the gap's client_scope (Phase 5
 * hardening — `relatedSourceInGapScope`). Unknown / unresolvable / malformed /
 * other-client ids are dropped. Caller order is preserved. One bounded `$in`
 * read; never a write.
 */
async function resolveInScopeSources(
  base44: any,
  sourceIds: string[] | undefined,
  gapClientScope: string,
): Promise<{ ids: string[]; byId: Map<string, any> }> {
  const ids = [...new Set((sourceIds || []).filter((x) => typeof x === "string" && x))];
  if (!ids.length) return { ids: [], byId: new Map() };
  let rows: any[] = [];
  try {
    rows = (await base44.asServiceRole.entities.Training.filter(
      { id: { $in: ids } },
      null,
      ids.length,
    )) || [];
  } catch (_) {
    rows = [];
  }
  const byId = new Map<string, any>((rows as any[]).map((r) => [r.id, r]));
  const kept = ids.filter((id) => relatedSourceInGapScope(byId.get(id), gapClientScope));
  return { ids: kept, byId };
}

/**
 * A derived process id may come ONLY from an in-scope related source (same
 * check as storage). Walks the kept sources in caller order; the first that
 * carries an operational_process_id wins. No qualifying source -> null (never
 * a guess).
 */
function deriveProcessIdFromScoped(byId: Map<string, any>, keptIds: string[]): string | null {
  for (const id of keptIds) {
    const pid = byId.get(id)?.operational_process_id;
    if (pid) return pid;
  }
  return null;
}

export async function aggregateGap(
  base44: any,
  input: GapEventInput,
): Promise<GapAggregationResult> {
  const now = new Date().toISOString();
  const basis = input.question || input.normalizedTopic || "";
  const normalized = input.normalizedTopic || normalizeTopic(basis);
  const keywords = topicKeywords(basis);
  const signature = topicSignature(normalized);
  const { clientId } = parseClientScope(input.clientScope);

  // Phase 5 hardening: a gap may only ever store related_source_ids that are
  // in-scope for its client_scope, and may only inherit a process from such a
  // source. Sanitize the incoming ids ONCE here; every persist path below uses
  // the sanitized list. Existing records are never touched (no backfill).
  const { ids: scopedSourceIds, byId: scopedById } = await resolveInScopeSources(
    base44,
    input.relatedSourceIds,
    input.clientScope,
  );
  const processId = input.operationalProcessId ??
    deriveProcessIdFromScoped(scopedById, scopedSourceIds);

  // Bounded, scope-partitioned fetch of not-yet-closed gaps, newest activity first.
  const openish: any[] = await base44.asServiceRole.entities.KnowledgeGap
    .filter(
      { client_scope: input.clientScope, status: { $in: ["candidate", "open", "under_review"] } },
      "-last_seen_at",
      500,
    )
    .catch(() => []);

  const match = openish.find((g) =>
    shouldDedupe(
      { clientScope: input.clientScope, normalizedTopic: normalized, signature, keywords, processId },
      g,
      GAP_DEDUP_JACCARD,
    )
  );

  if (match) {
    const patch = mergeGapUpdate(match, {
      origin: input.origin,
      sourceIds: scopedSourceIds,
      missingFacets: input.missingFacets,
      reporterHmac: input.reporterHmac,
      exampleQuestion: input.exampleQuestion ?? null,
      now,
    });
    if (!match.operational_process_id && processId) patch.operational_process_id = processId;
    await base44.asServiceRole.entities.KnowledgeGap.update(match.id, patch);

    const promoted = patch.status === "open" && (match.status || "candidate") === "candidate";
    if (promoted) {
      await base44.asServiceRole.entities.AuditEvent.create({
        entity: "KnowledgeGap",
        entity_id: match.id,
        action: "gap_promoted",
        actor_type: "system",
        summary:
          `Auto-promoted candidate -> open (times_asked=${patch.times_asked}, distinct_reporters=${patch.distinct_reporters}).`,
      }).catch(() => {});
    }
    return {
      knowledge_gap_id: match.id,
      status: (patch.status as string) || match.status || "candidate",
      deduped: true,
      promoted,
    };
  }

  const fields = newGapFields({
    origin: input.origin,
    title: normalized || "Untitled gap",
    normalizedTopic: normalized,
    keywords,
    signature,
    clientScope: input.clientScope,
    clientId,
    processId,
    sourceIds: scopedSourceIds,
    missingFacets: input.missingFacets,
    reporterHmac: input.reporterHmac,
    exampleQuestion: input.exampleQuestion ?? null,
    now,
  });
  const created = await base44.asServiceRole.entities.KnowledgeGap.create(fields);
  return { knowledge_gap_id: created.id, status: "candidate", deduped: false, promoted: false };
}
