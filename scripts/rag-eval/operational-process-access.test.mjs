// Regression tests: non-admins must not be able to bypass the scoped
// listOperationalProcesses function and read OperationalProcess directly.
//
// Background: OperationalProcess read RLS was once widened to
// `data.tenant_id == {{user.data.tenant_id}}`. That profile stamp is written
// with the caller's own token (auth.updateMe), so it is user-controllable and
// is never cleared on revoke — any member could forge it to read another
// tenant's processes, and same-tenant members could skip the client-scope
// filter. Access is admin-only at the entity; members go through the function.
//
// Runs the REAL handler under plain Node against a mocked SDK client — no
// Base44, no network, no Deno.
//   node --test scripts/rag-eval/operational-process-access.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ENTRY = resolve(REPO, 'base44/functions/listOperationalProcesses/entry.ts');
const ENTRY_DIR = dirname(ENTRY);
const TMP = join(HERE, '.tmp-operational-process-access');

// --- Entity RLS: no user-controllable stamp may grant access ---

const jsonc = readFileSync(resolve(REPO, 'base44/entities/OperationalProcess.jsonc'), 'utf8');
const schema = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ''));

test('OperationalProcess RLS never grants access via a user profile stamp', () => {
  const rls = JSON.stringify(schema.rls);
  assert.ok(!/\{\{\s*user\./.test(rls), `RLS references a user template: ${rls}`);
  assert.ok(!rls.includes('data.tenant_id'), `RLS matches on data.tenant_id: ${rls}`);
  assert.ok(!rls.includes('$or'), `RLS widens access with $or: ${rls}`);
});

// --- Frontend: no direct entity reads outside admin-only surfaces ---

// Files allowed to read the entity directly. Each is gated to the Base44
// admin; RLS returns nothing to anyone else regardless.
const DIRECT_READ_ALLOWLIST = new Set([
  'src/components/admin/AdminOverview.jsx',
  'src/components/onboarding/SetupChecklist.jsx',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs|tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

test('useClientSetup reads processes through listOperationalProcesses, not the entity', () => {
  const src = readFileSync(resolve(REPO, 'src/hooks/useClientSetup.js'), 'utf8');
  assert.ok(!/entities\.OperationalProcess\b/.test(src), 'useClientSetup reads OperationalProcess directly');
  assert.ok(src.includes("functions.invoke('listOperationalProcesses')"));
});

// Any entity handle: base44.entities.OperationalProcess, entities['OperationalProcess'],
// or destructuring `{ OperationalProcess } = base44.entities`.
const DIRECT_ENTITY_USE = [
  /entities\s*\.\s*OperationalProcess\b/,
  /entities\s*\[\s*['"`]OperationalProcess['"`]\s*\]/,
  /\{[^}]*\bOperationalProcess\b[^}]*\}\s*=\s*[\w.]*entities\b/,
];

test('no new direct OperationalProcess entity access in src/', () => {
  const offenders = walk(resolve(REPO, 'src'))
    .filter((f) => {
      const src = readFileSync(f, 'utf8');
      return DIRECT_ENTITY_USE.some((re) => re.test(src));
    })
    .map((f) => relative(REPO, f))
    .filter((f) => !DIRECT_READ_ALLOWLIST.has(f));
  assert.deepEqual(offenders, [], 'route these through listOperationalProcesses');
});

// --- The scoped function: tenant + client-scope enforcement ---

async function loadHandler() {
  const raw = readFileSync(ENTRY, 'utf8');
  const sdkImport = /import \{ createClientFromRequest \} from 'npm:@base44\/sdk@[0-9.]+';/;
  if (!sdkImport.test(raw)) throw new Error('SDK import not found in listOperationalProcesses');
  const src = raw
    .replace(sdkImport, 'const createClientFromRequest = (req) => globalThis.__mockSdk(req);')
    .replace(
      /from '(\.\.\/\.\.\/shared\/[a-zA-Z0-9]+)\.ts';/g,
      (_m, p) => `from ${JSON.stringify(pathToFileURL(resolve(ENTRY_DIR, p + '.ts')).href)};`,
    );
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, 'entry.transformed.ts');
  writeFileSync(out, src);
  try {
    return (await import(pathToFileURL(out).href)).default;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

const handler = await loadHandler();

const PROCESSES = [
  { id: 'a-gen', tenant_id: 'A', knowledge_scope: 'general' },
  { id: 'a-cli', tenant_id: 'A', knowledge_scope: 'client-specific', client_id: 'c1' },
  { id: 'a-unc', tenant_id: 'A', knowledge_scope: 'unclassified' },
  { id: 'b-gen', tenant_id: 'B', knowledge_scope: 'general' },
  { id: 'b-cli', tenant_id: 'B', knowledge_scope: 'client-specific', client_id: 'c9' },
  { id: 'none-gen', knowledge_scope: 'general' }, // legacy row with no tenant
];

const matches = (row, q) => Object.entries(q).every(([k, v]) => row[k] === v);

function mockSdk({ user, memberships = [] }) {
  return () => ({
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        TenantMembership: { filter: async (q) => memberships.filter((m) => matches(m, q)) },
        OperationalProcess: { list: async () => PROCESSES.map((p) => ({ ...p })) },
      },
    },
  });
}

async function call(state, body = {}) {
  globalThis.__mockSdk = mockSdk(state);
  const res = await handler(new Request('http://test/fn', { method: 'POST', body: JSON.stringify(body) }));
  const json = await res.json();
  return { status: res.status, ids: (json.processes || []).map((p) => p.id).sort(), json };
}

const member = (id, tenant_id, app_role, status = 'active') => ({
  user: { id, email: `${id}@x.test`, role: 'user' },
  memberships: [{ user_id: id, tenant_id, app_role, status }],
});

test('client_user sees only general processes in their own tenant', async () => {
  const r = await call(member('u1', 'A', 'client_user'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.ids, ['a-gen']);
});

test('client_user with a forged profile tenant stamp still gets only their membership tenant', async () => {
  const s = member('u1', 'A', 'client_user');
  s.user = { ...s.user, tenant_id: 'B', data: { tenant_id: 'B' } };
  const r = await call(s);
  assert.deepEqual(r.ids, ['a-gen']);
});

test('client_user cannot pick another tenant via the request body', async () => {
  const r = await call(member('u1', 'A', 'client_user'), { tenant_id: 'B' });
  assert.deepEqual(r.ids, ['a-gen']);
});

test('client_admin sees every scope in their own tenant and nothing from others', async () => {
  const r = await call(member('ca', 'A', 'client_admin'), { tenant_id: 'B' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.ids, ['a-cli', 'a-gen', 'a-unc']);
});

for (const status of ['inactive', 'pending']) {
  test(`${status} membership is refused (403)`, async () => {
    const r = await call(member('u2', 'A', 'client_admin', status));
    assert.equal(r.status, 403);
    assert.deepEqual(r.ids, []);
  });
}

test('revoked membership in another tenant grants nothing there', async () => {
  const r = await call({
    user: { id: 'u4', email: 'u4@x.test', role: 'user', data: { tenant_id: 'B' } },
    memberships: [
      { user_id: 'u4', tenant_id: 'B', app_role: 'client_admin', status: 'inactive' },
      { user_id: 'u4', tenant_id: 'A', app_role: 'client_user', status: 'active' },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.ids, ['a-gen']);
});

test('signed-in user with no membership is refused, even with a forged stamp', async () => {
  const r = await call({ user: { id: 'u3', email: 'u3@x.test', role: 'user', data: { tenant_id: 'A' } } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.ids, []);
});

test('unauthenticated caller gets 401', async () => {
  const r = await call({ user: null });
  assert.equal(r.status, 401);
});

test('super admin sees all tenants, or exactly the tenant they target', async () => {
  const admin = { user: { id: 'sa', email: 'sa@x.test', role: 'admin' } };
  assert.deepEqual((await call(admin)).ids, PROCESSES.map((p) => p.id).sort());
  assert.deepEqual((await call(admin, { tenant_id: 'B' })).ids, ['b-cli', 'b-gen']);
});
