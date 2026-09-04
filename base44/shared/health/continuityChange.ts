// Phase 9 P9-3 — pure, deterministic historical continuity/gap change detection.
//
// It has NO Base44 SDK, NO Deno, NO LLM, NO embeddings, NO randomness. It never
// re-derives a Phase 7 health semantic — the fingerprint projection only reads
// fields the Phase 7 computeKnowledgeHealth payload already computed.
//
// Fingerprints carry ONLY: process ids, gap ids, times_asked (a topic
// aggregate), and single-letter status / promoted / criticality codes. NO
// employee/user/reporter identity, NO names, NO titles, NO questions, NO query
// text, NO normalized topics, NO keywords, NO missing facets, NO source content.
//
// "What changed" compares the latest persisted fingerprint-bearing monthly
// KnowledgeHealthSnapshot row against its immediately prior fingerprint-bearing
// row for the exact same client_scope. It NEVER compares a live current
// fingerprint against a stored one (the live payload has no resolved gaps).

import { monthsBetween } from "./trend.ts";

// --- constants -------------------------------------------------------------

export const FINGERPRINT_VERSION = 1;
export const MAX_EXPOSURE_TOKENS = 5000;
export const MAX_GAP_FINGERPRINTS = 800;
export const FREQ_RISE_MIN = 2;
export const LONG_UNRESOLVED_PERIODS = 3;
export const DISPLAY_ID_CAP = 25;

export const EXPOSURE_KINDS = [
  "at_risk",
  "key_person",
  "overdue_review",
  "critical_doc_gap",
  "governance_setup",
] as const;
export type ExposureKindP93 = (typeof EXPOSURE_KINDS)[number];

// --- small deterministic month helpers ----------------------------------

/** 'YYYY-MM' -> UTC ms at the first day of that month; NaN if unparseable. */
export function monthStartMs(periodKey: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ""));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
}

/** 'YYYY-MM' shifted by `delta` months (can be negative). '' if unparseable. */
export function shiftMonthKey(periodKey: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ""));
  if (!m) return "";
  const ord = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const y = Math.floor(ord / 12);
  const mm = (ord % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

// --- criticality code --------------------------------------------------

export function critChar(criticality?: string | null): string {
  switch (criticality) {
    case "mission_critical":
      return "m";
    case "high":
      return "h";
    case "medium":
      return "d";
    case "low":
      return "l";
    default:
      return "x";
  }
}

// --- fingerprint projection from the Phase 7 payload --------------------

export interface ExposureFingerprint {
  tokens: string[]; // sorted, deduped, '<processId>~<kind>~<critChar>'
  truncated: boolean;
}

export function exposureFingerprintFromPayload(payload: any): ExposureFingerprint {
  const rows: any[] = Array.isArray(payload?.processRows) ? payload.processRows : [];
  const set = new Set<string>();
  for (const r of rows) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    const c = critChar(r.criticality);
    const crit = r.criticality === "high" || r.criticality === "mission_critical";
    const push = (kind: ExposureKindP93) => set.add(`${id}~${kind}~${c}`);

    if (r.continuityState === "at_risk") push("at_risk");
    // Only an ESTABLISHED identifiable dependency — never manufactured from a
    // missing backup alone (that is what Phase 7 keyPersonLevel high/critical is).
    if (r.keyPersonLevel === "high" || r.keyPersonLevel === "critical") push("key_person");
    if (r.freshness === "overdue") push("overdue_review");
    // ABSENCE of documentation on a critical process only. Not needs_attention
    // (failed/stale existing docs) — that is the aggregate sources_needing_attention.
    if (crit && r.coverageState === "not_documented") push("critical_doc_gap");
    // Unambiguous setup fields only. NOT freshness === 'unknown' (that is not a
    // guaranteed "no review cadence" signal — cadence stays an aggregate metric).
    const noOwner = !(r.owner && r.owner.id);
    const noSme = !(r.sme && r.sme.id);
    const noCrit = !r.criticality;
    if (noOwner || noSme || noCrit) push("governance_setup");
  }
  const all = [...set].sort();
  const truncated = all.length > MAX_EXPOSURE_TOKENS;
  return { tokens: truncated ? all.slice(0, MAX_EXPOSURE_TOKENS) : all, truncated };
}

export type GapTuple = [string, number, string, number, string]; // [id, times_asked, statusChar, promoted, critChar]

export interface GapFingerprint {
  tuples: GapTuple[]; // sorted by id[0]
  truncated: boolean;
}

const GAP_STATUS_CHAR: Record<string, string> = {
  open: "o",
  under_review: "u",
  candidate: "c",
  resolved: "r",
  not_applicable: "n",
};

/**
 * @param resolvedGapRows  rows from a bounded, exact-scope KnowledgeGap lookup
 *   of gaps RESOLVED during the completed capture period. Each needs only
 *   { id, times_asked, operational_process_id }.
 */
export function gapFingerprintFromPayload(payload: any, resolvedGapRows: any[] = []): GapFingerprint {
  const liveGaps: any[] = Array.isArray(payload?.gaps) ? payload.gaps : [];
  const procRows: any[] = Array.isArray(payload?.processRows) ? payload.processRows : [];
  const critByProc = new Map<string, string>();
  for (const p of procRows) if (p && p.id != null) critByProc.set(String(p.id), critChar(p.criticality));

  const byId = new Map<string, GapTuple>();
  for (const g of liveGaps) {
    if (!g || g.id == null) continue;
    const id = String(g.id);
    const s = GAP_STATUS_CHAR[String(g.state)] ?? "c";
    const c = g.processId != null ? (critByProc.get(String(g.processId)) ?? "x") : "n";
    byId.set(id, [id, Number(g.timesAsked) || 0, s, g.promoted ? 1 : 0, c]);
  }
  for (const g of resolvedGapRows || []) {
    if (!g || g.id == null) continue;
    const id = String(g.id);
    const c = g.operational_process_id != null
      ? (critByProc.get(String(g.operational_process_id)) ?? "x")
      : "n";
    // A 'resolved' entry always wins over a stale live 'candidate' echo.
    byId.set(id, [id, Number(g.times_asked) || 0, "r", 0, c]);
  }

  const all = [...byId.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const truncated = all.length > MAX_GAP_FINGERPRINTS;
  return { tuples: truncated ? all.slice(0, MAX_GAP_FINGERPRINTS) : all, truncated };
}

export interface FingerprintFields {
  fingerprint_version: number;
  exposure_fingerprint: string;
  exposure_truncated: boolean;
  gap_fingerprint: string;
  gap_truncated: boolean;
}

export function fingerprintsFromHealthPayload(payload: any, resolvedGapRows: any[] = []): FingerprintFields {
  const exp = exposureFingerprintFromPayload(payload);
  const gap = gapFingerprintFromPayload(payload, resolvedGapRows);
  return {
    fingerprint_version: FINGERPRINT_VERSION,
    exposure_fingerprint: JSON.stringify(exp.tokens),
    exposure_truncated: exp.truncated,
    gap_fingerprint: JSON.stringify(gap.tuples),
    gap_truncated: gap.truncated,
  };
}

// --- parsing --------------------------------------------------------------

export interface ParsedExposureRow {
  kinds: Set<string>;
  crit: string;
}

export function parseExposureFingerprint(str: unknown): Map<string, ParsedExposureRow> {
  const out = new Map<string, ParsedExposureRow>();
  let arr: unknown;
  try {
    arr = JSON.parse(typeof str === "string" ? str : "[]");
  } catch (_) {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const t of arr) {
    if (typeof t !== "string") continue;
    const parts = t.split("~");
    if (parts.length !== 3) continue;
    const [pid, kind, c] = parts;
    const row = out.get(pid) || { kinds: new Set<string>(), crit: c };
    row.kinds.add(kind);
    row.crit = c;
    out.set(pid, row);
  }
  return out;
}

export interface ParsedGap {
  a: number;
  s: string;
  p: number;
  c: string;
}

export function parseGapFingerprint(str: unknown): Map<string, ParsedGap> {
  const out = new Map<string, ParsedGap>();
  let arr: unknown;
  try {
    arr = JSON.parse(typeof str === "string" ? str : "[]");
  } catch (_) {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const t of arr) {
    if (!Array.isArray(t) || t.length < 5) continue;
    const [id, a, s, p, c] = t;
    if (typeof id !== "string") continue;
    out.set(id, { a: Number(a) || 0, s: String(s), p: Number(p) || 0, c: String(c) });
  }
  return out;
}

// --- change detection --------------------------------------------------

export interface ChangeCell {
  count: number | null; // null => unknown
  ids: string[]; // bounded to DISPLAY_ID_CAP; [] when unknown
}

const UNKNOWN_CELL = (): ChangeCell => ({ count: null, ids: [] });

export interface ContinuityChange {
  comparable: boolean;
  reason: string | null; // 'insufficient_history' | 'version_changed' | 'truncated' | null
  previous_period_key: string | null;
  latest_period_key: string | null;
  periods_elapsed: number | null;
  categories: {
    atRisk: { new: ChangeCell; resolved: ChangeCell; newCritical: ChangeCell };
    keyPerson: { new: ChangeCell; resolved: ChangeCell };
    overdueReview: { new: ChangeCell; resolved: ChangeCell };
    criticalDocGap: { new: ChangeCell; resolved: ChangeCell };
    governanceSetup: { regressed: ChangeCell; improved: ChangeCell };
  };
}

function allUnknownCategories(): ContinuityChange["categories"] {
  return {
    atRisk: { new: UNKNOWN_CELL(), resolved: UNKNOWN_CELL(), newCritical: UNKNOWN_CELL() },
    keyPerson: { new: UNKNOWN_CELL(), resolved: UNKNOWN_CELL() },
    overdueReview: { new: UNKNOWN_CELL(), resolved: UNKNOWN_CELL() },
    criticalDocGap: { new: UNKNOWN_CELL(), resolved: UNKNOWN_CELL() },
    governanceSetup: { regressed: UNKNOWN_CELL(), improved: UNKNOWN_CELL() },
  };
}

function cell(ids: string[]): ChangeCell {
  return { count: ids.length, ids: ids.slice(0, DISPLAY_ID_CAP) };
}

/** processIds whose parsed exposure set contains `kind` in `a` but not in `b`. */
function diffKind(
  a: Map<string, ParsedExposureRow>,
  b: Map<string, ParsedExposureRow>,
  kind: string,
): string[] {
  const out: string[] = [];
  for (const [pid, row] of a) {
    if (row.kinds.has(kind) && !(b.get(pid)?.kinds.has(kind))) out.push(pid);
  }
  return out.sort();
}

export interface FingerprintRowLike {
  period_key?: string;
  fingerprint_version?: number | null;
  exposure_fingerprint?: string | null;
  exposure_truncated?: boolean;
  gap_fingerprint?: string | null;
  gap_truncated?: boolean;
}

/** A row is fingerprint-bearing iff it declares a fingerprint_version. */
export function isFingerprintBearing(row: any): boolean {
  return row != null && row.fingerprint_version != null;
}

export function computeContinuityChange(
  latest: FingerprintRowLike | null | undefined,
  prior: FingerprintRowLike | null | undefined,
): ContinuityChange {
  const latest_period_key = latest?.period_key ?? null;

  if (!latest || !prior) {
    return {
      comparable: false,
      reason: "insufficient_history",
      previous_period_key: prior?.period_key ?? null,
      latest_period_key,
      periods_elapsed: null,
      categories: allUnknownCategories(),
    };
  }

  const previous_period_key = prior.period_key ?? null;
  const periods_elapsed = previous_period_key && latest_period_key
    ? monthsBetween(previous_period_key, latest_period_key)
    : null;

  // Do NOT silently skip a newer incompatible period and compare older rows.
  if (
    latest.fingerprint_version !== FINGERPRINT_VERSION ||
    prior.fingerprint_version !== FINGERPRINT_VERSION ||
    latest.fingerprint_version !== prior.fingerprint_version
  ) {
    return {
      comparable: false,
      reason: "version_changed",
      previous_period_key,
      latest_period_key,
      periods_elapsed,
      categories: allUnknownCategories(),
    };
  }

  if (latest.exposure_truncated || prior.exposure_truncated) {
    return {
      comparable: false,
      reason: "truncated",
      previous_period_key,
      latest_period_key,
      periods_elapsed,
      categories: allUnknownCategories(),
    };
  }

  const L = parseExposureFingerprint(latest.exposure_fingerprint);
  const P = parseExposureFingerprint(prior.exposure_fingerprint);

  const newAtRisk = diffKind(L, P, "at_risk");
  const newCritical = newAtRisk.filter((pid) => {
    const c = L.get(pid)?.crit;
    return c === "m" || c === "h";
  });

  return {
    comparable: true,
    reason: null,
    previous_period_key,
    latest_period_key,
    periods_elapsed,
    categories: {
      atRisk: {
        new: cell(newAtRisk),
        resolved: cell(diffKind(P, L, "at_risk")),
        newCritical: cell(newCritical),
      },
      keyPerson: {
        new: cell(diffKind(L, P, "key_person")),
        resolved: cell(diffKind(P, L, "key_person")),
      },
      overdueReview: {
        new: cell(diffKind(L, P, "overdue_review")),
        resolved: cell(diffKind(P, L, "overdue_review")),
      },
      criticalDocGap: {
        new: cell(diffKind(L, P, "critical_doc_gap")),
        resolved: cell(diffKind(P, L, "critical_doc_gap")),
      },
      governanceSetup: {
        regressed: cell(diffKind(L, P, "governance_setup")),
        improved: cell(diffKind(P, L, "governance_setup")),
      },
    },
  };
}

// --- gap intelligence ------------------------------------------------

export interface GapFreqRise {
  id: string;
  from: number;
  to: number;
}

export interface GapChange {
  comparable: boolean;
  reason: string | null;
  previous_period_key: string | null;
  latest_period_key: string | null;
  periods_elapsed: number | null;
  recurring: { count: number | null; ids: string[] };
  frequencyRises: { count: number | null; items: GapFreqRise[] };
  criticalProcessGaps: { count: number | null; ids: string[] };
  newlyPromoted: { count: number | null; ids: string[] };
  resolvedSincePrior: { count: number | null };
  longUnresolved: { state: "known" | "unknown"; reason: string | null; items: { id: string; since: string }[] };
}

const OPEN_S = new Set(["o", "u"]);

export interface DatedGapMap {
  period_key: string;
  map: Map<string, ParsedGap>;
}

export function computeGapChange(
  latest: FingerprintRowLike | null | undefined,
  prior: FingerprintRowLike | null | undefined,
  consecutiveHistory: FingerprintRowLike[] = [],
): GapChange {
  const latest_period_key = latest?.period_key ?? null;
  const base = (reason: string | null): GapChange => ({
    comparable: false,
    reason,
    previous_period_key: prior?.period_key ?? null,
    latest_period_key,
    periods_elapsed: prior?.period_key && latest_period_key ? monthsBetween(prior.period_key, latest_period_key) : null,
    recurring: { count: null, ids: [] },
    frequencyRises: { count: null, items: [] },
    criticalProcessGaps: { count: null, ids: [] },
    newlyPromoted: { count: null, ids: [] },
    resolvedSincePrior: { count: null },
    longUnresolved: { state: "unknown", reason, items: [] },
  });

  if (!latest || !prior) return base("insufficient_history");
  if (
    latest.fingerprint_version !== FINGERPRINT_VERSION ||
    prior.fingerprint_version !== FINGERPRINT_VERSION ||
    latest.fingerprint_version !== prior.fingerprint_version
  ) return base("version_changed");
  if (latest.gap_truncated || prior.gap_truncated) return base("truncated");

  const previous_period_key = prior.period_key ?? null;
  const periods_elapsed = previous_period_key && latest_period_key
    ? monthsBetween(previous_period_key, latest_period_key)
    : null;

  const L = parseGapFingerprint(latest.gap_fingerprint);
  const P = parseGapFingerprint(prior.gap_fingerprint);

  const recurring: string[] = [];
  const freqRises: GapFreqRise[] = [];
  const criticalGaps: string[] = [];
  const newlyPromoted: string[] = [];
  let resolvedCount = 0;

  for (const [id, lg] of L) {
    const pg = P.get(id);
    const lActionable = OPEN_S.has(lg.s) || lg.p === 1;
    if (lActionable && pg && (OPEN_S.has(pg.s) || pg.p === 1)) recurring.push(id);
    if (pg && lg.a - pg.a >= FREQ_RISE_MIN) freqRises.push({ id, from: pg.a, to: lg.a });
    if ((lg.c === "m" || lg.c === "h") && lActionable) criticalGaps.push(id);
    if (lg.p === 1 && (!pg || pg.p !== 1)) newlyPromoted.push(id);
    if (lg.s === "r" && pg && (OPEN_S.has(pg.s) || pg.s === "c")) resolvedCount += 1;
  }

  // long-unresolved: a run of >= LONG_UNRESOLVED_PERIODS *adjacent calendar
  // month* fingerprint rows, ending at `latest`, where the gap is open in every
  // row of the run.
  const long = computeLongUnresolved(consecutiveHistory);

  return {
    comparable: true,
    reason: null,
    previous_period_key,
    latest_period_key,
    periods_elapsed,
    recurring: { count: recurring.length, ids: recurring.sort().slice(0, DISPLAY_ID_CAP) },
    frequencyRises: {
      count: freqRises.length,
      items: freqRises.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, DISPLAY_ID_CAP),
    },
    criticalProcessGaps: { count: criticalGaps.length, ids: criticalGaps.sort().slice(0, DISPLAY_ID_CAP) },
    newlyPromoted: { count: newlyPromoted.length, ids: newlyPromoted.sort().slice(0, DISPLAY_ID_CAP) },
    resolvedSincePrior: { count: resolvedCount },
    longUnresolved: long,
  };
}

function computeLongUnresolved(
  history: FingerprintRowLike[],
): GapChange["longUnresolved"] {
  // history is newest-first, fingerprint-bearing only.
  const bearing = (history || []).filter(
    (r) => r && r.fingerprint_version === FINGERPRINT_VERSION && !r.gap_truncated,
  );
  if (bearing.length < LONG_UNRESOLVED_PERIODS) {
    return { state: "unknown", reason: "insufficient_consecutive_history", items: [] };
  }
  // Build the consecutive run that ENDS AT the latest row.
  const run: FingerprintRowLike[] = [bearing[0]];
  for (let i = 1; i < bearing.length; i++) {
    const gap = monthsBetween(String(bearing[i].period_key), String(bearing[i - 1].period_key));
    if (gap === 1) run.push(bearing[i]);
    else break;
  }
  if (run.length < LONG_UNRESOLVED_PERIODS) {
    return { state: "unknown", reason: "insufficient_consecutive_history", items: [] };
  }
  const window = run.slice(0, LONG_UNRESOLVED_PERIODS); // newest N adjacent months
  const maps = window.map((r) => parseGapFingerprint(r.gap_fingerprint));
  const oldestKey = String(window[window.length - 1].period_key);

  const items: { id: string; since: string }[] = [];
  for (const [id, g] of maps[0]) {
    if (!OPEN_S.has(g.s)) continue;
    let openEverywhere = true;
    for (let i = 1; i < maps.length; i++) {
      const gi = maps[i].get(id);
      if (!gi || !OPEN_S.has(gi.s)) {
        openEverywhere = false;
        break;
      }
    }
    if (openEverywhere) items.push({ id, since: oldestKey });
  }
  items.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { state: "known", reason: null, items: items.slice(0, DISPLAY_ID_CAP) };
}
