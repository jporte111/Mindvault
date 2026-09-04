// Phase 9 P9-1 — MindVault binding for periodic KnowledgeHealthSnapshot capture.
// Takes the Base44 client as a parameter (no npm:@base44/sdk import) so it is
// node-loadable for tests with a stub client. The Deno entry shell
// (base44/functions/captureKnowledgeHealthSnapshot) only adds auth, the
// dryRun/flag write gate, and the HTTP Response.
//
// It runs the EXISTING Phase 7 current-health computation per scope
// (computeKnowledgeHealth — unchanged), projects each payload to an aggregate
// row (snapshotFromHealthPayload) plus the P9-3 fingerprint fields
// (fingerprintsFromHealthPayload), and upserts exactly one row per
// (period_key, client_scope). It READS KnowledgeGap (a bounded, exact-scope
// lookup of gaps resolved during the completed period) but WRITES ONLY
// KnowledgeHealthSnapshot — never Training / KnowledgeChunk / OperationalProcess
// / KnowledgeGap / Notification. No LLM, no embeddings, no randomness.

import { computeKnowledgeHealth } from "../mindvaultHealth.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotFromHealthPayload,
  type KnowledgeHealthSnapshotRow,
} from "./snapshotProjection.ts";
import {
  fingerprintsFromHealthPayload,
  monthStartMs,
  shiftMonthKey,
  type FingerprintFields,
} from "./continuityChange.ts";

export type SnapshotRowWithFingerprints = KnowledgeHealthSnapshotRow & FingerprintFields;

/** 'YYYY-MM' in UTC — deterministic given a millisecond timestamp. */
export function snapshotPeriodKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export interface SnapshotPlan {
  period_key: string;
  generated_at: string;
  rows: SnapshotRowWithFingerprints[];
}

/**
 * Bounded lookup of gaps that resolved DURING the completed capture period — the
 * single calendar month immediately before `period_key`:
 *
 *   monthStartMs(prevMonth(period_key))  <=  resolved_at  <  monthStartMs(period_key)
 *
 * The window is anchored to `period_key` and has BOTH bounds, so a later rerun in
 * the current month can never widen the set or mutate the same monthly
 * fingerprint by run date.
 *
 * Scope follows existing client-health semantics: a `general` snapshot sees only
 * `general` resolved gaps; a `client:<id>` snapshot sees `general` + that
 * client's own (two bounded reads, combined and deduped by gap id — no $in
 * dependency, no new scope model), and never another client's.
 *
 * Returns only { id, times_asked, operational_process_id }-shaped rows.
 */
async function resolvedGapsForPeriod(
  base44: any,
  client_scope: string,
  period_key: string,
): Promise<any[]> {
  const windowStart = monthStartMs(shiftMonthKey(period_key, -1)); // first day of the prior month
  const windowEnd = monthStartMs(period_key); // first day of period_key's month (exclusive)
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return [];

  const scopesToRead = client_scope === "general" ? ["general"] : ["general", client_scope];
  const byId = new Map<string, any>();
  for (const cs of scopesToRead) {
    const rows = await base44.asServiceRole.entities.KnowledgeGap
      .filter({ client_scope: cs, status: "resolved" }, "-resolved_at", 2000)
      .catch(() => []);
    for (const g of rows as any[]) {
      if (!g || g.id == null) continue;
      const t = g.resolved_at ? Date.parse(g.resolved_at) : NaN;
      if (Number.isNaN(t) || t < windowStart || t >= windowEnd) continue;
      if (!byId.has(g.id)) byId.set(g.id, g); // deterministic: general read wins on a duplicate id
    }
  }
  return [...byId.values()];
}

/**
 * Compute the planned snapshot rows for the current period: one per scope
 * (general + every ACTIVE client). Pure read — no writes.
 */
export async function planKnowledgeHealthSnapshots(
  base44: any,
  opts: { now?: number } = {},
): Promise<SnapshotPlan> {
  const now = opts.now ?? Date.now();
  const period_key = snapshotPeriodKey(now);

  const clients = await base44.asServiceRole.entities.Client
    .filter({ status: "active" }, "-created_date", 5000)
    .catch(() => []);

  const scopes: Array<{ kind: "general" } | { kind: "client"; clientId: string }> = [
    { kind: "general" },
    ...(clients as any[]).map((c) => ({ kind: "client" as const, clientId: c.id })),
  ];

  const rows: SnapshotRowWithFingerprints[] = [];
  for (const scope of scopes) {
    const payload = await computeKnowledgeHealth(base44, { scope, now });
    const client_scope = scope.kind === "client" ? `client:${scope.clientId}` : "general";
    const base = snapshotFromHealthPayload(payload, {
      period_key,
      schema_version: SNAPSHOT_SCHEMA_VERSION,
    });
    const resolvedGapRows = await resolvedGapsForPeriod(base44, client_scope, period_key);
    const fingerprints = fingerprintsFromHealthPayload(payload, resolvedGapRows);
    rows.push({ ...base, ...fingerprints });
  }

  return { period_key, generated_at: new Date(now).toISOString(), rows };
}

export interface UpsertResult {
  client_scope: string;
  action: "created" | "updated";
}

/**
 * Idempotent upsert on (period_key, client_scope). Re-running for the same month
 * overwrites the existing rows; it never duplicates and never deletes.
 */
export async function upsertSnapshotRows(
  base44: any,
  rows: SnapshotRowWithFingerprints[],
): Promise<UpsertResult[]> {
  const svc = base44.asServiceRole.entities.KnowledgeHealthSnapshot;
  const results: UpsertResult[] = [];
  for (const row of rows) {
    const existing = await svc
      .filter({ period_key: row.period_key, client_scope: row.client_scope }, null, 1)
      .catch(() => []);
    if (existing?.[0]) {
      await svc.update(existing[0].id, row);
      results.push({ client_scope: row.client_scope, action: "updated" });
    } else {
      await svc.create(row);
      results.push({ client_scope: row.client_scope, action: "created" });
    }
  }
  return results;
}
