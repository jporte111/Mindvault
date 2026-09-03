// Shared in-memory fakes for the Phase 6 lifecycle-engine tests. NOT a
// *.test.mjs file, so run.mjs does not execute it directly. It models a
// DIFFERENT product's persistence + index store to prove the engine's reuse.

import { createLifecycleEngine } from '../../base44/shared/lifecycle/engine.ts';
import { StaleSeqError } from '../../base44/shared/lifecycle/types.ts';

export const fp = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
};

export const staleFlag = (h, id) => h.idx.get(id).stale;

export function makeHarness(opts = {}) {
  const flags = { ...opts };
  const versions = new Map();
  const operations = new Map();
  const revisions = [];
  const audits = [];
  const manualFlags = [];
  const idx = new Map(); // versionId -> { units:[{id,fingerprint,projection}], stale }
  let seq = 0;
  let nowMs = Date.parse('2026-09-02T00:00:00Z');
  const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs, tick: (ms) => { nowMs += ms; } };
  const idGen = { operationId: () => `op_${++seq}` };

  const projectionOf = (v) => ({
    scopeKey: v.scopeKey,
    is_active_version: v.isActiveVersion ? 'true' : 'false',
    effective_from: v.effectiveFrom ?? '',
    version_number: String(v.versionNumber),
  });

  const persistence = {
    async getVersion(id) { const v = versions.get(id); return v ? { ...v } : null; },
    async listLineage(lineageId) {
      return [...versions.values()].filter((v) => v.lineageId === lineageId).map((v) => ({ ...v }));
    },
    async writeVersion(id, patch, expectedSeq) {
      const v = versions.get(id);
      if (!v) throw new Error('no version ' + id);
      if (flags.staleWriteOnce) { flags.staleWriteOnce = false; throw new StaleSeqError(); }
      if (v.lifecycleSeq !== expectedSeq) throw new StaleSeqError();
      Object.assign(v, patch, { lifecycleSeq: v.lifecycleSeq + 1 });
      return { ...v };
    },
    async createVersionRow(fromVersion, overrides) {
      const id = `v_${versions.size + 1}`;
      const row = { ...fromVersion, ...overrides, id, lifecycleSeq: 0, lineageId: overrides.lineageId || fromVersion.lineageId };
      versions.set(id, row);
      idx.set(id, { units: [], stale: false });
      return { ...row };
    },
    async putOperation(op) { operations.set(op.operationId, { ...op }); },
    async getOperation(id) { const o = operations.get(id); return o ? { ...o } : null; },
    async listOpenOperations() { return [...operations.values()].map((o) => ({ ...o })); },
    async lastCompletedOperation(lineageId, action) {
      return [...operations.values()].reverse().find(
        (o) => o.lineageId === lineageId && o.action === action && o.status === 'completed',
      ) || null;
    },
    async appendRevision(r) { revisions.push(r); },
    async appendAudit(a) { audits.push(a); },
    async auditExists(operationId, code) {
      return !!operationId && audits.some((a) => a.operationId === operationId && a.code === code);
    },
    async revisionExists(operationId, versionId) {
      return !!operationId && revisions.some((r) => r.operationId === operationId && r.versionId === versionId);
    },
    async markNeedsManualReconciliation(lineageId, reason) { manualFlags.push({ lineageId, reason }); },
  };

  const indexWorker = {
    async build(v) {
      flags.buildCount = (flags.buildCount || 0) + 1;
      const store = idx.get(v.id) || { units: [], stale: false };
      const content = versions.get(v.id).__content ?? 'body';
      store.units = [
        { id: `${v.id}#0`, fingerprint: fp(content), projection: projectionOf(versions.get(v.id)) },
        { id: `${v.id}#1`, fingerprint: fp(content), projection: projectionOf(versions.get(v.id)) },
      ];
      store.stale = true;
      idx.set(v.id, store);
      if (flags.failBuild) throw new Error('injected build failure');
    },
    async restamp(v) {
      (flags.restampTargets ||= []).push(v.id);
      const store = idx.get(v.id) || { units: [], stale: false };
      for (const u of store.units) u.projection = projectionOf(versions.get(v.id));
      idx.set(v.id, store);
      if (flags.failRestamp) throw new Error('injected restamp failure');
    },
    async cleanup(v) {
      (flags.cleanupTargets ||= []).push(v.id);
      idx.set(v.id, { units: [], stale: false });
      if (flags.failCleanup) throw new Error('injected cleanup failure');
    },
    async markStale(ids) {
      (flags.markStaleTargets ||= []).push(...ids);
      for (const id of ids) { const s = idx.get(id); if (s) s.stale = true; }
      if (flags.failStaleMark) throw new Error('injected stale-mark failure');
    },
    async clearStale(id) {
      if (flags.failStaleClear) throw new Error('injected stale-clear failure');
      const s = idx.get(id); if (s) s.stale = false;
    },
    async verifyStaleCleared(id) { const s = idx.get(id); return !!s && s.stale === false; },
    async fingerprint(v) { return fp(versions.get(v.id).__content ?? 'body'); },
    async unitSetComplete(v) {
      if (flags.forceIncompleteSet) return false;
      const s = idx.get(v.id); return !!s && s.units.length > 0;
    },
    async projectionMismatches(v) {
      if (flags.forceMismatch) return [{ field: 'scopeKey', expected: 'x', actual: 'y', unitId: v.id + '#0' }];
      const s = idx.get(v.id);
      if (!s) return [];
      const want = projectionOf(versions.get(v.id));
      const out = [];
      for (const u of s.units) {
        for (const k of Object.keys(want)) {
          if (String(u.projection[k] ?? '') !== String(want[k] ?? '')) {
            out.push({ field: k, expected: want[k], actual: u.projection[k], unitId: u.id });
          }
        }
      }
      return out;
    },
    async unitCount(id) { const s = idx.get(id); return s ? s.units.length : 0; },
  };

  const authorizer = {
    authorize: (actor) => (actor && actor.role === 'admin' ? { ok: true } : (flags.openAuthz ? { ok: true } : { ok: false, reason: 'admin only' })),
  };

  const policy = {
    requireVerifiedToPublish: true,
    allowForceUnverifiedPublish: false,
    disallowTransitions: [],
    stuckAfterMs: 1000,
    reconcileMaxAttempts: 2,
    gracePolicyMs: (d) => d * 3600_000,
    combinedApproveAndPublish: false,
    ...(opts.policy || {}),
  };

  const engine = createLifecycleEngine({ persistence, indexWorker, authorizer, clock, idGen, policy });

  const v1 = {
    id: 'v_1', lineageId: 'lin_1', versionNumber: 1, isActiveVersion: true,
    verificationStatus: 'verified', isArchived: false, scopeKey: 'general:',
    lifecycleSeq: 0, indexState: 'indexed', indexedVersionNumber: 1,
    indexedFingerprint: fp('body-v1'),
    reviewOutcome: null, reviewRequestedAt: null, __content: 'body-v1',
  };
  versions.set('v_1', v1);
  idx.set('v_1', { units: [{ id: 'v_1#0', fingerprint: fp('body-v1'), projection: projectionOf(v1) }], stale: false });

  return { engine, versions, operations, revisions, audits, manualFlags, idx, clock, projectionOf, flags };
}
