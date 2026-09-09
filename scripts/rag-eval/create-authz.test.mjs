// Create-authorization matrix for createKnowledgeSource (multi-tenant).
//
// NO LIVE DATA IS TOUCHED. The dynamic tests exercise the REAL
// ../../base44/shared/tenant.ts authorization (requireExplicitTenantAdminScope) and
// the REAL ../../base44/functions/createKnowledgeSource/entry.ts handler
// against an in-memory fake Base44 client. Verified matrix:
//   1. Client Admin in Tenant A creates a source        -> allowed, stamped A
//   2. Client User in Tenant A attempts a create         -> denied 403
//   3. Client Admin in Tenant A forges tenant_id = B    -> denied 403
//   4. The created record's tenant comes from the AUTHORITATIVE membership
//      scope (withTenant), never from the request payload — even when the
//      payload smuggles a tenant_id inside fields.
//   5. Super Admin creates across tenants ONLY via the intended explicit
//      tenant_id path; with no explicit tenant AND no own client_admin
//      membership it is a hard 400, never a silent default.
//   5b. A Super Admin who ALSO holds an active client_admin membership may
//      make a self-scoped write (no tenant_id) — it resolves to that OWN
//      membership tenant, exactly as a Client Admin's would.
//   node --test scripts/rag-eval/create-authz.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The REAL shared authorization module. Node strips the TS types on import —
// no bespoke transform to drift out of sync with tenant.ts.
import {
  requireExplicitTenantAdminScope,
  TenantAuthError,
  withTenant,
} from '../../base44/shared/tenant.ts';

// --- Load the REAL createKnowledgeSource handler the same way ---
// Strip ONLY the import statements — module-level constants (ALLOWED_FIELDS)
// must survive so the handler body is complete. Header comments are harmless
// inside a Function body.
const rawEntry = readFileSync(
  new URL('../../base44/functions/createKnowledgeSource/entry.ts', import.meta.url),
  'utf8'
);
let entryJs = rawEntry.replace(/^import[\s\S]*?;/gm, '');
entryJs = entryJs.replace(/export default async function \(req\) \{/, 'async function handler(req) {');
entryJs = entryJs.replace(/const fields: Record<string, any> = {};/, 'const fields = {};');
assert.ok(
  !/:\s*(Record|string|number|any)\b|Promise</.test(entryJs),
  'entry.ts still has TS annotations after transform'
);

const handlerFactory = new Function(
  'createClientFromRequest',
  'requireExplicitTenantAdminScope',
  'TenantAuthError',
  'withTenant',
  entryJs + '\nreturn handler;'
);

// --- Fake Base44 client: users, memberships, tenants, and created records all
// live only in memory. Nothing touches the real database.
const TENANT_A = { id: 'tenant-a', status: 'active' };
const TENANT_B = { id: 'tenant-b', status: 'active' };
const SUSPENDED = { id: 'tenant-s', status: 'suspended' };

const makeClient = (user, memberships, tenants = [TENANT_A, TENANT_B, SUSPENDED]) => {
  const created = [];
  const client = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        TenantMembership: {
          filter: async (q) =>
            memberships.filter((m) => Object.entries(q).every(([k, v]) => m[k] === v)),
        },
        Tenant: {
          get: async (id) => tenants.find((t) => t.id === id) || null,
        },
        Training: {
          create: async (payload) => {
            created.push(payload);
            return { id: 'training-new', ...payload };
          },
        },
      },
    },
  };
  return { client, created };
};

const adminUser = { id: 'u-admin', email: 'owner@firm.test', role: 'admin' };
const clientAdminA = { id: 'u-ca', email: 'ca@firm.test', role: 'user' };
const clientUserA = { id: 'u-cu', email: 'cu@firm.test', role: 'user' };
const activeMembership = (tenant_id, user_id, app_role) => [
  { tenant_id, user_id, email: null, app_role, status: 'active' },
];

// Invoke the real handler for one identity; returns { status, data, created }.
const runCreate = ({ user, memberships, tenants }, body) => {
  const { client, created } = makeClient(user, memberships, tenants);
  const handler = handlerFactory(() => client, requireExplicitTenantAdminScope, TenantAuthError, withTenant);
  return handler({ json: async () => body }).then(async (res) => ({
    status: res.status,
    data: await res.json(),
    created,
  }));
};

const VALID_FIELDS = {
  title: 'ZZ Test SOP',
  transcript: 'https://example.test/transcript.txt',
  source_type: 'sop',
};

// --- The matrix ---

test('1. Client Admin in Tenant A creates a source in Tenant A -> allowed, stamped A', async () => {
  const r = await runCreate(
    { user: clientAdminA, memberships: activeMembership('tenant-a', 'u-ca', 'client_admin') },
    { action: 'create', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 200, 'client admin denied in own tenant: ' + JSON.stringify(r.data));
  assert.equal(r.created.length, 1, 'exactly one record written');
  assert.equal(r.created[0].tenant_id, 'tenant-a', 'record stamped with OWN tenant');
  assert.equal(r.created[0].status, 'processing');
});

test('2. Client User in Tenant A attempts a create -> denied 403, nothing written', async () => {
  const r = await runCreate(
    { user: clientUserA, memberships: activeMembership('tenant-a', 'u-cu', 'client_user') },
    { action: 'create', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 403, 'client user was not denied');
  assert.equal(r.created.length, 0, 'a denied create must write nothing');
  // denied even when the payload names their own tenant
  const r2 = await runCreate(
    { user: clientUserA, memberships: activeMembership('tenant-a', 'u-cu', 'client_user') },
    { action: 'create', tenant_id: 'tenant-a', fields: VALID_FIELDS }
  );
  assert.equal(r2.status, 403);
  assert.equal(r2.created.length, 0);
});

test('3. Client Admin in Tenant A forges tenant_id = Tenant B -> denied 403, nothing written', async () => {
  const r = await runCreate(
    { user: clientAdminA, memberships: activeMembership('tenant-a', 'u-ca', 'client_admin') },
    { action: 'create', tenant_id: 'tenant-b', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 403, 'cross-tenant forgery was not denied');
  assert.ok(r.data.error, 'denial explains itself');
  assert.equal(r.created.length, 0, 'a denied create must write nothing');
});

test('4. Payload tenant_id is NEVER trusted — the record is stamped from the authoritative membership scope', async () => {
  const r = await runCreate(
    { user: clientAdminA, memberships: activeMembership('tenant-a', 'u-ca', 'client_admin') },
    {
      action: 'create',
      fields: {
        ...VALID_FIELDS,
        tenant_id: 'tenant-b', // smuggled inside fields
      },
    }
  );
  assert.equal(r.status, 200);
  assert.equal(r.created.length, 1);
  assert.equal(
    r.created[0].tenant_id,
    'tenant-a',
    'the forged tenant_id must not reach the record'
  );
});

test('5. Super Admin creates across tenants ONLY through the intended explicit path', async () => {
  // explicit target -> allowed and stamped with the target
  const r = await runCreate(
    { user: adminUser, memberships: [] },
    { action: 'create', tenant_id: 'tenant-b', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 200, 'super admin explicit-tenant path denied: ' + JSON.stringify(r.data));
  assert.equal(r.created[0].tenant_id, 'tenant-b', 'stamped with the explicitly targeted tenant');

  // no explicit tenant -> hard 400, never a silent default scope
  const r2 = await runCreate({ user: adminUser, memberships: [] }, { action: 'create', fields: VALID_FIELDS });
  assert.equal(r2.status, 400, 'super admin without an explicit tenant must get 400');
  assert.equal(r2.created.length, 0, 'no record may be written from a defaulted scope');
});

test('5b. A Super Admin who is ALSO the active Client Admin of one tenant: self-scoped create (no explicit tenant) resolves to their OWN membership tenant', async () => {
  // The platform-owner account that also runs its own firm's workspace. Using
  // a self-service screen (no tenant_id in the payload) is unambiguous — it
  // resolves exactly as a Client Admin would, to their own tenant. This is
  // NOT the removed "silent default to Tenant #1" fallback: it requires an
  // active client_admin membership (see test 5, which still 400s without one).
  const r = await runCreate(
    { user: adminUser, memberships: activeMembership('tenant-a', 'u-admin', 'client_admin') },
    { action: 'create', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 200, 'super-admin-who-is-also-client-admin self-scoped create denied: ' + JSON.stringify(r.data));
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].tenant_id, 'tenant-a', 'stamped with their OWN membership tenant');

  // but they still cannot self-scope past their membership: an explicit
  // OTHER tenant is honored only because Super Admins may target explicitly.
  const r2 = await runCreate(
    { user: adminUser, memberships: activeMembership('tenant-a', 'u-admin', 'client_admin') },
    { action: 'create', tenant_id: 'tenant-b', fields: VALID_FIELDS }
  );
  assert.equal(r2.status, 200, 'super admin explicit cross-tenant still allowed');
  assert.equal(r2.created[0].tenant_id, 'tenant-b');
});

test('5c. A Super Admin whose only membership is client_USER (not admin): self-scoped create still 400s — no admin authority to borrow', async () => {
  const r = await runCreate(
    { user: adminUser, memberships: activeMembership('tenant-a', 'u-admin', 'client_user') },
    { action: 'create', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 400, 'a non-admin membership must not unlock a defaulted admin scope');
  assert.equal(r.created.length, 0);
});

test('Suspended tenant: create refused 403 regardless of role', async () => {
  const r = await runCreate(
    { user: adminUser, memberships: [] },
    { action: 'create', tenant_id: 'tenant-s', fields: VALID_FIELDS }
  );
  assert.equal(r.status, 403);
  assert.equal(r.created.length, 0);
});

test('Client-specific scope requires a client; client fields stripped otherwise', async () => {
  const noClient = await runCreate(
    { user: clientAdminA, memberships: activeMembership('tenant-a', 'u-ca', 'client_admin') },
    { action: 'create', fields: { ...VALID_FIELDS, knowledge_scope: 'client-specific' } }
  );
  assert.equal(noClient.status, 400, 'client-specific without a client must be rejected');

  const stray = await runCreate(
    { user: clientAdminA, memberships: activeMembership('tenant-a', 'u-ca', 'client_admin') },
    {
      action: 'create',
      fields: { ...VALID_FIELDS, knowledge_scope: 'general', client_id: 'client-x', client_name: 'X' },
    }
  );
  assert.equal(stray.status, 200);
  assert.equal(stray.created[0].client_id, undefined, 'client fields must be stripped for general scope');
  assert.equal(stray.created[0].client_name, undefined);
});

// --- Static contract of the deployed handler ---

const entry = readFileSync(
  new URL('../../base44/functions/createKnowledgeSource/entry.ts', import.meta.url),
  'utf8'
);

test('handler authorizes via the authoritative membership scope, never the payload', () => {
  assert.ok(entry.includes('requireExplicitTenantAdminScope(base44, body?.tenant_id)'));
});

test('create stamps the tenant from the VERIFIED scope (withTenant), and tenant_id is not a writable field', () => {
  assert.ok(entry.includes('withTenant(scope.tenantId'));
  assert.ok(!entry.includes("'tenant_id'"), 'tenant_id must not appear in the field allowlist');
  assert.ok(!/tenant_id\s*[:=]\s*(body|input|fields)/.test(entry), 'payload tenant_id must never be copied');
});

test('the create handler performs no delete or update of existing knowledge', () => {
  assert.ok(!/\.delete\(|\.update\(|deleteMany|updateMany/.test(entry), 'create path must not touch existing records');
});