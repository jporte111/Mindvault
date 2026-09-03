// Phase 6 PERMANENT SAFETY INVARIANT.
//
// After Phase 6 ships, no SERVED / governed source content may ever be
// overwritten in place — regardless of the source_lifecycle_enabled flag. The
// flag only controls access to the new workflow/UI; it must never restore the
// old unsafe in-place content-mutation path.
//
// This decision is based on the source's lifecycle / SERVED STATE, not on the
// feature flag. Pure — no Base44 client, no flag read — so it is unit-testable
// and can never accidentally consult AppConfig.

export interface ReanalysisTargetLike {
  knowledge_scope?: string;
  is_active_version?: boolean;
  is_archived?: boolean;
  verification_status?: string;
}

export type ReanalysisDecision =
  // Active + classified + already has retrievable chunks: NEVER re-analyze in
  // place. Caller refuses (flag ON -> point at the draft workflow; flag OFF ->
  // point at enabling Source Lifecycle). No legacy fallback.
  | { kind: "served" }
  // Inactive draft (not archived, not rejected): not served, so safe to
  // re-analyze in place — but the caller MUST re-pre-index the draft after.
  | { kind: "draft" }
  // Never-classified / unclassified onboarding content, or an archived/rejected
  // inactive row: no chunks, never served — the existing first-time analysis
  // path is preserved, unchanged.
  | { kind: "legacy" };

/**
 * @param t                the Training row being asked to (re)analyze
 * @param hasServedChunks   does this training_id currently have >= 1
 *                          KnowledgeChunk? This is the definitive "is it served"
 *                          signal — immune to the frontend flipping `status` to
 *                          'processing' just before a re-analyze.
 */
export function classifyReanalysisTarget(
  t: ReanalysisTargetLike,
  hasServedChunks: boolean,
): ReanalysisDecision {
  const scope = t.knowledge_scope || "unclassified";
  const isClassified = scope === "general" || scope === "client-specific";
  const isActive = t.is_active_version !== false; // missing => active

  if (isClassified && isActive && hasServedChunks) return { kind: "served" };

  if (!isActive && t.is_archived !== true && t.verification_status !== "rejected") {
    return { kind: "draft" };
  }

  return { kind: "legacy" };
}
