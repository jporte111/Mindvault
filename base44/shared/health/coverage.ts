// Phase 7 — CoverageState (F1 + F2 + F4). Pure. Authority and content length
// NEVER affect this calculation.

import type {
  CoverageState,
  HealthSourceLike,
  IndexState,
  LegacyChunkAnswer,
} from "./types.ts";

// --- F1: explicit effective-date semantics -------------------------------
// missing bound = unbounded; malformed bound = treated as absent;
// future effective_from = not effective; expired effective_until = not
// effective; equality to now = effective.

export function parseableDate(x: unknown): boolean {
  return typeof x === "string" && x.trim() !== "" && !Number.isNaN(Date.parse(x));
}

export function effectiveNow(
  s: { effective_from?: string | null; effective_until?: string | null },
  nowMs: number,
): boolean {
  const fromOk = !s.effective_from ||
    (parseableDate(s.effective_from) ? Date.parse(s.effective_from) <= nowMs : true);

  const untilOk = !s.effective_until ||
    (parseableDate(s.effective_until) ? Date.parse(s.effective_until) >= nowMs : true);

  return fromOk && untilOk;
}

// --- governed-active + classification ----------------------------------

export function isClassified(s: HealthSourceLike): boolean {
  return s.knowledge_scope === "general" || s.knowledge_scope === "client-specific";
}

export function governedActiveSource(s: HealthSourceLike): boolean {
  return (
    s.is_active_version !== false &&
    s.is_archived !== true &&
    s.verification_status !== "rejected" &&
    s.status === "ready" &&
    isClassified(s)
  );
}

// --- F2: legacy index-state resolution --------------------------------
// Explicit Training.index_status ALWAYS wins. `failed` is never inferred.

export function resolveIndexState(
  s: HealthSourceLike,
  hasLegacyChunk: LegacyChunkAnswer,
): IndexState {
  if (s.index_status) return s.index_status as IndexState; // explicit wins
  if (!isClassified(s)) return "skipped";
  if (hasLegacyChunk === true) return "indexed";
  if (hasLegacyChunk === false) return "absent"; // absence PROVEN
  return "unresolved"; // hasLegacyChunk === undefined — could not determine
}

// --- F4: 5-state CoverageState ---------------------------------------

/**
 * @param hasLegacyChunk  (sourceId) => true | false | undefined. Consulted ONLY
 *                         for sources with no explicit index_status.
 */
export function deriveCoverageState(
  linkedSources: HealthSourceLike[],
  nowMs: number,
  hasLegacyChunk: (sourceId: string) => LegacyChunkAnswer,
): CoverageState {
  const inForce = (s: HealthSourceLike) =>
    governedActiveSource(s) && effectiveNow(s, nowMs);
  const st = (s: HealthSourceLike) => resolveIndexState(s, hasLegacyChunk(s.id));

  const U = linkedSources.filter((s) => inForce(s) && st(s) === "indexed");
  const F = linkedSources.filter((s) => inForce(s) && s.index_status === "failed"); // explicit only
  const UN = linkedSources.filter((s) => inForce(s) && st(s) === "unresolved");

  if (U.some((s) => s.verification_status === "verified")) return "documented_verified";
  if (U.length >= 1) return "documented_unverified";
  if (F.length >= 1) return "needs_attention";
  if (UN.length >= 1) return "unknown"; // F4: unresolved legacy index state -> UNKNOWN, never not_documented
  return "not_documented";
}

/** USABLE linked sources — the set whose freshness is meaningful for continuity. */
export function usableSources(
  linkedSources: HealthSourceLike[],
  nowMs: number,
  hasLegacyChunk: (sourceId: string) => LegacyChunkAnswer,
): HealthSourceLike[] {
  return linkedSources.filter(
    (s) =>
      governedActiveSource(s) &&
      effectiveNow(s, nowMs) &&
      resolveIndexState(s, hasLegacyChunk(s.id)) === "indexed",
  );
}
