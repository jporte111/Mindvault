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

// --- Load the real shared tenant module (TS annotations stripped for Node 20) ---
// Explicit, exact-string transforms for THIS file; a transform miss fails loudly.
const raw = readFileSync(new URL('../../base44/shared/tenant.ts', import.meta.url), 'utf8');
const strips = [
  [/export interface TenantContext \{[\s\S]*?\n\}/, ''],
  [/  status: number;\n  constructor\(status: number, message: string\) \{/, '  constructor(status, message) {'],
  [/resolveTenantContext\(base44: any\): Promise<TenantContext> \{/, 'resolveTenantContext(base44) {'],
  [/normalizeEmail\(email: string \| null \| undefined\): string \| null \{/, 'normalizeEmail(email) {'],
  [/let membership: any = null;/, 'let membership = null;'],
  [/\(m: any\) =>/, '(m) =>'],
  [
    /\(\n  base44: any,\n  requestedTenantId\?: string \| null,\n\): Promise<\{ isSuperAdmin: boolean; tenantId: string; appRole: string \| null \}> \{/,
    '(\n  base44,\n  requestedTenantId,\n) {',
  ],
  [
    /\(\n  base44: any,\n\): Promise<\{ isSuperAdmin: boolean; tenantId: string; appRole: string \| null \}> \{/,
    '(\n  base44,\n) {',
  ],
  [/export function tenantFilter\(tenantId: string\): \{ tenant_id: string \} \{/, 'export function tenantFilter(tenantId) {'],
  [
    /export function withTenant<T extends Record<string, any>>\(tenantId: string, payload: T\): T \{/,
    'export function withTenant(tenantId, payload) {',
  ],
];
let js = raw;
for (const [re, rep] of strips) {
  if (!re.test(js)) throw new Error('tenant.ts transform miss: ' + re);
  js = js.replace(re, rep);
}
assert.ok(!/:\s*any|Promise<|: string|: number/.test(js), 'tenant.ts still has TS annotations after transform');

// Node 20's test runner cannot dynamic-import (known sandbox limitation), so
// the self-contained module is evaluated directly instead of imported.
// tenant.ts has no imports of its own, which makes this safe.
const moduleBody = js.replace(/^export /gm, '') + [
  '',
  'return { requireTenantAdminScope, requireTenantMemberScope, resolveTenantContext, TenantAuthError, tenantFilter, withTenant };',
].join('\n');
const { requireTenantAdminScope, TenantAuthError } = new Function(moduleBody)();

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
  assert.ok(entry.includes('requireTenantAdminScope(base44, body?.tenant_id)'));
  assert.ok(!/tenant_id\s*[:=]\s*body/.test(entry), 'payload tenant_id must never be written to a record');
});

test('create stamps the tenant from the VERIFIED scope (withTenant), not the payload', () => {
  const createBlock = entry.slice(entry.indexOf("if (action === 'create')"), entry.indexOf("if (action === 'update')"));
  assert.ok(createBlock.includes('withTenant(scope.tenantId'));
});