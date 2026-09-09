// Delete-authorization matrix for manageOperationalProcess (multi-tenant).
//
// NO LIVE DATA IS TOUCHED. The dynamic tests exercise the REAL
// ../../base44/shared/tenant.ts authorization (requireTenantAdminScope) against
// an in-memory fake Base44 client; the static tests verify the deployed delete
// handler fetches the record and refuses a tenant mismatch BEFORE any write,
// and never trusts a tenant id from the payload.
//   node --test scripts/rag-eval/delete-authz.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The REAL shared authorization module. Node strips the TS types on import —
// no bespoke transform to drift out of sync with tenant.ts.
import {
  requireTenantAdminScope,
  requireExplicitTenantAdminScope,
  TenantAuthError,
} from '../../base44/shared/tenant.ts';

// --- Fake Base44 client: membership rows live only in memory ---
const fakeBase44 = (user, memberships) => ({
  auth: { me: async () => user },
  asServiceRole: {
    entities: {
      TenantMembership: {
        filter: async (q) =>
          memberships.filter((m) => Object.entries(q).every(([k, v]) => m[k] === v)),
      },
    },
  },
});

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const adminUser = { id: 'u-admin', email: 'owner@firm.test', role: 'admin' };
const clientAdminA = { id: 'u-ca', email: 'ca@firm.test', role: 'user' };
const clientUserA = { id: 'u-cu', email: 'cu@firm.test', role: 'user' };
const active = (tenant_id, user_id, app_role) => [
  { tenant_id, user_id, email: null, app_role, status: 'active' },
];

const attempt = (base44, tenantId) =>
  requireTenantAdminScope(base44, tenantId).then(
    (r) => ({ allowed: true, scope: r }),
    (e) => ({ allowed: false, error: e })
  );

// --- Dynamic matrix: the actual authorization decision for each role ---

test('Super Admin: delete allowed, targeting the record\'s tenant explicitly', async () => {
  const r = await attempt(fakeBase44(adminUser, []), TENANT_A);
  assert.ok(r.allowed, 'super admin denied: ' + r.error?.message);
  assert.equal(r.scope.tenantId, TENANT_A);
  assert.equal(r.scope.isSuperAdmin, true);
});

test('Super Admin with no membership and no explicit tenant: hard error, never a default scope', async () => {
  const r = await attempt(fakeBase44(adminUser, []), undefined);
  assert.equal(r.allowed, false);
  assert.ok(r.error instanceof TenantAuthError);
  assert.equal(r.error.status, 400);
});

test('Client Admin: delete allowed within their OWN tenant (no tenant id in payload)', async () => {
  const r = await attempt(fakeBase44(clientAdminA, active(TENANT_A, 'u-ca', 'client_admin')), undefined);
  assert.ok(r.allowed, 'client admin denied in own tenant: ' + r.error?.message);
  assert.equal(r.scope.tenantId, TENANT_A);
  assert.equal(r.scope.isSuperAdmin, false);
});

test('Client Admin: cross-tenant delete attempt (forged tenant id in payload) denied 403', async () => {
  const r = await attempt(fakeBase44(clientAdminA, active(TENANT_A, 'u-ca', 'client_admin')), TENANT_B);
  assert.equal(r.allowed, false);
  assert.ok(r.error instanceof TenantAuthError);
  assert.equal(r.error.status, 403);
});

test('Client User: delete ALWAYS denied 403 (no administrative access)', async () => {
  const r = await attempt(fakeBase44(clientUserA, active(TENANT_A, 'u-cu', 'client_user')), undefined);
  assert.equal(r.allowed, false);
  assert.ok(r.error instanceof TenantAuthError);
  assert.equal(r.error.status, 403);
  // even when the payload names their own tenant
  const r2 = await attempt(fakeBase44(clientUserA, active(TENANT_A, 'u-cu', 'client_user')), TENANT_A);
  assert.equal(r2.allowed, false);
  assert.equal(r2.error.status, 403);
});

test('No membership at all: delete denied 403', async () => {
  const r = await attempt(fakeBase44({ id: 'u-x', email: 'x@firm.test', role: 'user' }, []), TENANT_A);
  assert.equal(r.allowed, false);
  assert.equal(r.error.status, 403);
});

test('Inactive (revoked) membership: delete denied 403', async () => {
  const rows = [{ tenant_id: TENANT_A, user_id: 'u-ca', email: null, app_role: 'client_admin', status: 'inactive' }];
  const r = await attempt(fakeBase44(clientAdminA, rows), undefined);
  assert.equal(r.allowed, false);
  assert.equal(r.error.status, 403);
});

// --- Static contract of the deployed delete handler ---

const entry = readFileSync(
  new URL('../../base44/functions/manageOperationalProcess/entry.ts', import.meta.url),
  'utf8'
);
const deleteBlock = entry.slice(entry.indexOf("if (action === 'delete')"));

test('delete handler exists and refuses a record/scope tenant mismatch BEFORE deleting', () => {
  assert.ok(deleteBlock.includes("OperationalProcess.delete(id)"), 'no delete call found');
  const mismatchIdx = deleteBlock.indexOf('existing.tenant_id !== scope.tenantId');
  const denyIdx = deleteBlock.indexOf('403');
  const deleteIdx = deleteBlock.indexOf('OperationalProcess.delete(id)');
  assert.ok(mismatchIdx > -1, 'delete block has no tenant-match guard');
  assert.ok(denyIdx > mismatchIdx, 'guard does not 403');
  assert.ok(deleteIdx > mismatchIdx, 'delete happens only after the guard');
});

test('delete handler authorizes via the authoritative membership scope, never the payload', () => {
  assert.ok(entry.includes('requireExplicitTenantAdminScope(base44, body?.tenant_id)'));
  assert.ok(!/tenant_id\s*[:=]\s*body/.test(entry), 'payload tenant_id must never be written to a record');
});

test('requireExplicitTenantAdminScope: a Super Admin who is ALSO the active Client Admin of one tenant self-scopes to their OWN tenant; a membership-less Super Admin still 400s', async () => {
  // own client_admin membership -> unambiguous self-scope, no explicit id needed
  const ok = await requireExplicitTenantAdminScope(
    fakeBase44(adminUser, active(TENANT_A, 'u-admin', 'client_admin')),
    undefined,
  ).then((r) => ({ allowed: true, r }), (e) => ({ allowed: false, e }));
  assert.ok(ok.allowed, 'super-admin-also-client-admin self-scope denied: ' + ok.e?.message);
  assert.equal(ok.r.tenantId, TENANT_A);

  // no membership + no explicit id -> hard 400, never a default scope
  const bad = await requireExplicitTenantAdminScope(fakeBase44(adminUser, []), undefined)
    .then((r) => ({ allowed: true, r }), (e) => ({ allowed: false, e }));
  assert.equal(bad.allowed, false);
  assert.equal(bad.e.status, 400);

  // a client_USER membership does NOT unlock a defaulted admin scope
  const cu = await requireExplicitTenantAdminScope(
    fakeBase44(adminUser, active(TENANT_A, 'u-admin', 'client_user')),
    undefined,
  ).then((r) => ({ allowed: true, r }), (e) => ({ allowed: false, e }));
  assert.equal(cu.allowed, false);
  assert.equal(cu.e.status, 400);
});

test('create stamps the tenant from the VERIFIED scope (withTenant), not the payload', () => {
  const createBlock = entry.slice(entry.indexOf("if (action === 'create')"), entry.indexOf("if (action === 'update')"));
  assert.ok(createBlock.includes('withTenant(scope.tenantId'));
});