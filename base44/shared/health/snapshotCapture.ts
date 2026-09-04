// Phase 9 P9-1 — MindVault binding for periodic KnowledgeHealthSnapshot capture.
// Takes the Base44 client as a parameter (no npm:@base44/sdk import) so it is
// node-loadable for tests with a stub client. The Deno entry shell
// (base44/functions/captureKnowledgeHealthSnapshot) only adds auth, the
// dryRun/flag write gate, and the HTTP Response.
//
// It runs the EXISTING Phase 7 current-health computation per scope
// (computeKnowledgeHealth — unchanged), projects each payload to an aggregate
// row (snapshotFromHealthPayload), and upserts exactly one row per
// (period_key, client_scope). It writes ONLY KnowledgeHealthSnapshot — never
// Training / KnowledgeChunk / OperationalProcess / KnowledgeGap / Notification.
// No LLM, no embeddings, no randomness.

import { computeKnowledgeHealth } from "../mindvaultHealth.ts";
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotFromHealthPayload,
  type KnowledgeHealthSnapshotRow,
} from "./snapshotProjection.ts";

/** 'YYYY-MM' in UTC — deterministic given a millisecond timestamp. */
export function snapshotPeriodKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export interface SnapshotPlan {
  period_key: string;
  generated_at: string;
  rows: KnowledgeHealthSnapshotRow[];
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

  const rows: KnowledgeHealthSnapshotRow[] = [];
  for (const scope of scopes) {
    const payload = await computeKnowledgeHealth(base44, { scope, now });
    rows.push(
      snapshotFromHealthPayload(payload, { period_key, schema_version: SNAPSHOT_SCHEMA_VERSION }),
    );
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
  rows: KnowledgeHealthSnapshotRow[],
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
