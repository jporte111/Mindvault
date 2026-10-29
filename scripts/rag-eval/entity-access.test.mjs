// Entity access hardening: Training, Client, Tenant and AppConfig direct
// reads are admin-only, no RLS rule trusts the user-writable profile stamp
// (user.data.tenant_id), and member-facing UI reads through tenant-scoped
// backend functions:
//  * anonymous callers get 401 and no record;
//  * pending / inactive / no membership / forged stamp / suspended -> refused;
//  * a member sees only their verified membership tenant's records (plus
//    legacy untagged rows while LEGACY_UNTAGGED_VISIBLE — pinned below);
//  * another tenant's record is indistinguishable from a missing one;
//  * platform admins keep their all-workspace views.
// No Base44, no network.
//   node --test scripts/rag-eval/entity-access.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { loadHandler, post } from './_load-handler.mjs';
import { fetchInScope, filterToScope, inReadScope, LEGACY_UNTAGGED_VISIBLE, READ_LIMIT, readScopeFor } from '../../base44/shared/recordScope.ts';
import { MEMBER_VISIBLE_SETTINGS, memberView } from '../../base44/shared/appSettings.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
globalThis.fetch = () => Promise.reject(new Error('test: network is blocked'));
globalThis.Deno = { env: { get: () => undefined }, serve() {} };

const ADMIN = { user_condition: { role: 'admin' } };
const readEntity = (n) => JSON.parse(readFileSync(resolve(REPO, `base44/entities/${n}.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const entityNames = readdirSync(resolve(REPO, 'base44/entities')).filter((f) => f.endsWith('.jsonc')).map((f) => f.replace('.jsonc', ''));

// ---------------------------------------------------------------- RLS (static)

test('no RLS rule trusts user-writable data: the only template allowed is {{user.id}}', () => {
  for (const n of entityNames) {
    const rls = JSON.stringify(readEntity(n).rls ?? {});
    for (const [t] of rls.matchAll(/\{\{[^}]*\}\}/g)) {
      assert.equal(t, '{{user.id}}', `${n} RLS uses ${t} (profile fields like user.data.* / user.tenant_id are user-writable)`);
    }
  }
});

test('every app entity declares RLS for read, create, update and delete (no implicit defaults)', () => {
  for (const n of entityNames.filter((x) => x !== 'User')) {
    const rls = readEntity(n).rls;
    assert.ok(rls, `${n} has no rls block`);
    for (const op of ['read', 'create', 'update', 'delete']) assert.ok(op in rls, `${n}.rls.${op} missing`);
  }
});

test('hardened entities are admin-only for every operation', () => {
  for (const n of ['Training', 'Client', 'Tenant', 'AppConfig', 'KnowledgeGap', 'KnowledgeFeedback',
    'RecurringPainPoint', 'WorkflowPattern', 'DecisionRulePattern', 'ProductOpportunityCluster', 'ProductRecommendation',
    'KnowledgeChunk', 'OperationalProcess']) {
    for (const op of ['read', 'create', 'update', 'delete']) {
      assert.deepEqual(readEntity(n).rls[op], ADMIN, `${n}.rls.${op} is not admin-only`);
    }
  }
});

test('no entity is world-readable (read: true)', () => {
  for (const n of entityNames) assert.notEqual(readEntity(n).rls?.read, true, `${n} is readable by anyone`);
});

// ---------------------------------------------------------------- frontend (static)

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(jsx?|tsx?)$/.test(f) ? [p] : [];
});
const SRC_FILES = walk(resolve(REPO, 'src')).map((p) => relative(REPO, p));
const src = (f) => readFileSync(resolve(REPO, f), 'utf8');

// Platform-admin-only screens that may keep direct (admin-RLS) reads, and why.
const ADMIN_DIRECT_READS = {
  'src/pages/Admin.jsx': 'platform settings page',
  'src/pages/Roadmap.jsx': 'platform Strategy Engine page',
  'src/components/admin/KnowledgeScopeManager.jsx': 'mounted only by pages/Admin.jsx',
  'src/components/admin/KnowledgeGapManager.jsx': 'mounted only by pages/Admin.jsx',
  'src/components/onboarding/SetupChecklist.jsx': 'mounted only by pages/Admin.jsx',
  'src/components/admin/AdminOverview.jsx': 'queries enabled only for isSuperAdmin',
  'src/components/admin/OperationalProcessManager.jsx': 'Tenant list enabled only for isSuperAdmin',
  'src/components/admin/UploadTraining.jsx': 'Tenant list enabled only for isSuperAdmin',
  'src/components/admin/TenantMembersManager.jsx': 'Tenant list enabled only for isSuperAdmin',
  'src/components/admin/DriveSyncCard.jsx': 'Tenant list enabled only for isSuperAdmin',
  'src/components/knowledge/SubmitRecordingModal.jsx': 'Tenant list enabled only for isSuperAdmin',
  'src/components/knowledge/TrainingCard.jsx': 'Client list enabled only for isAdmin (platform)',
  'src/pages/Continuity.jsx': 'Client list enabled only for isAdmin (platform)',
};
const DIRECT_READ = /base44\.entities\.(Training|Client|Tenant|AppConfig)\.(list|filter|get)\(/g;

test('member-facing code never reads Training, Client, Tenant or AppConfig directly', () => {
  for (const f of SRC_FILES) {
    if (!src(f).match(DIRECT_READ)) continue;
    assert.ok(ADMIN_DIRECT_READS[f], `${f} reads a hardened entity directly — use src/lib/scopedData.js`);
  }
});

test('allowed direct reads are really platform-admin-only', () => {
  const mountedOnlyByAdmin = (f) => {
    const name = f.split('/').pop().replace('.jsx', '');
    const importers = SRC_FILES.filter((g) => g !== f && new RegExp(`^import [^;]*\\b${name}\\b[^;]*from`, 'm').test(src(g)));
    return importers.length > 0 && importers.every((g) => g === 'src/pages/Admin.jsx');
  };
  for (const [f, why] of Object.entries(ADMIN_DIRECT_READS)) {
    const s = src(f);
    if (/^src\/pages\/(Admin|Roadmap)\.jsx$/.test(f)) continue;
    if (why.startsWith('mounted only by')) { assert.ok(mountedOnlyByAdmin(f), `${f} is mounted outside the platform Admin page`); continue; }
    // every direct read in the file sits in a query enabled only for platform admins
    for (const m of s.matchAll(DIRECT_READ)) {
      const window = s.slice(m.index, m.index + 200);
      assert.match(window, /enabled:\s*(isSuperAdmin|isAdmin)\b/, `${f}: direct ${m[1]} read is not gated to platform admins`);
    }
  }
});

test('member-facing code never writes Client directly (manageClients enforces tenant + linked-knowledge checks)', () => {
  for (const f of SRC_FILES) assert.ok(!/base44\.entities\.Client\.(create|update|delete)\(/.test(src(f)), `${f} writes Client directly`);
});

// ---------------------------------------------------------------- pure scope

test('read scope: platform admins see all; members only their tenant (never another)', () => {
  const rows = [{ id: 'a', tenant_id: 'A' }, { id: 'b', tenant_id: 'B' }, { id: 'u' }, { id: 'e', tenant_id: '  ' }];
  assert.deepEqual(filterToScope(rows, readScopeFor({ isSuperAdmin: true, tenantId: null })).map((r) => r.id), ['a', 'b', 'u', 'e']);
  const member = readScopeFor({ isSuperAdmin: false, tenantId: 'A' });
  assert.ok(!inReadScope({ id: 'b', tenant_id: 'B' }, member));
  assert.ok(inReadScope({ id: 'a', tenant_id: 'A' }, member));
  assert.throws(() => readScopeFor({ isSuperAdmin: false, tenantId: null }));
});

test('KNOWN INTERIM (until the tenant-data migration is verified): legacy untagged rows stay visible to members', () => {
  assert.equal(LEGACY_UNTAGGED_VISIBLE, true, 'flip to false (strict) only after the migration is verified');
  const member = readScopeFor({ isSuperAdmin: false, tenantId: 'A' });
  assert.ok(inReadScope({ id: 'u' }, member));
  assert.ok(inReadScope({ id: 'u', tenant_id: null }, member));
  assert.ok(!inReadScope({ id: 'u' }, { kind: 'tenant', tenantId: 'A', includeUntagged: false }), 'strict mode hides them');
});

test('settings allowlist: members never see administrative switches or row ids', () => {
  const row = { id: 'cfg1', key: 'system', knowledge_gaps_enabled: true, require_verification_for_retrieval: true, answer_logging_enabled: true, notifications_enabled: true };
  const v = memberView('system', row);
  // require_verification / answer_logging are shown read-only to client admins (AssistantToggles).
  assert.deepEqual(Object.keys(v).sort(), ['answer_logging_enabled', 'key', 'knowledge_gaps_enabled', 'require_verification_for_retrieval']);
  assert.ok(!('id' in v) && !('notifications_enabled' in v));
  assert.deepEqual(Object.keys(MEMBER_VISIBLE_SETTINGS).sort(), ['chat', 'system']);
  for (const f of ['retrieval_mode', 'require_ingestion_review', 'governance_ranking_enabled',
    'auto_gap_from_answer_status', 'notifications_enabled', 'knowledge_health_snapshots_enabled', 'operational_answer_mode']) {
    assert.ok(![...MEMBER_VISIBLE_SETTINGS.chat, ...MEMBER_VISIBLE_SETTINGS.system].includes(f), `${f} is administrative`);
  }
});

// ---------------------------------------------------------------- handler mocks

const TENANTS = {
  A: { id: 'A', name: 'Alpha', slug: 'alpha', status: 'active', logo_url: 'a.png', brand_color: '#a00', config: { secret: 1 }, plan: 'pro', plan_limits: {}, sso_config: { x: 1 }, drive_folder_ids: ['fA'], notes: 'internal' },
  B: { id: 'B', name: 'Beta', slug: 'beta', status: 'active', drive_folder_ids: ['fB'] },
  S: { id: 'S', name: 'Suspended', status: 'suspended' },
};

function db(init) {
  const tables = structuredClone(init);
  const reads = [];
  const writes = [];
  const matches = (row, q) => Object.entries(q || {}).every(([k, v]) => row[k] === v);
  const table = (name) => ({
    filter: async (q) => { reads.push(name); return (tables[name] || []).filter((r) => matches(r, q)).map((r) => ({ ...r })); },
    list: async () => { reads.push(name); return (tables[name] || []).map((r) => ({ ...r })); },
    get: async (id) => { reads.push(name); const r = (tables[name] || []).find((x) => x.id === id); if (!r) throw new Error('not found'); return { ...r }; },
    create: async (p) => { writes.push([`${name}.create`, p]); const r = { id: `${name}-${(tables[name] || []).length + 1}`, ...p }; (tables[name] ||= []).push(r); return { ...r }; },
    update: async (id, p) => { writes.push([`${name}.update`, id, p]); const r = tables[name].find((x) => x.id === id); Object.assign(r, p); return { ...r }; },
    delete: async (id) => { writes.push([`${name}.delete`, id]); tables[name] = tables[name].filter((x) => x.id !== id); return {}; },
  });
  return { tables, reads, writes, table };
}

function sdk({ user, memberships = [], data = {} }) {
  const d = db({
    Tenant: Object.values(TENANTS),
    TenantMembership: memberships,
    Training: [
      { id: 'tA', tenant_id: 'A', title: 'Alpha SOP', status: 'ready', created_date: '2026-01-02' },
      { id: 'tB', tenant_id: 'B', title: 'BETA-CANARY payroll', status: 'ready', created_date: '2026-01-03' },
      { id: 'tU', title: 'Legacy untagged', status: 'ready', created_date: '2026-01-01' },
      { id: 'tA2', tenant_id: 'A', title: 'Alpha draft', status: 'processing', created_date: '2026-01-04' },
    ],
    Client: [
      { id: 'cA', tenant_id: 'A', name: 'Acme', status: 'active' },
      { id: 'cB', tenant_id: 'B', name: 'BETA-CANARY Bolt', status: 'active' },
      { id: 'cU', name: 'Legacy client', status: 'active' },
      { id: 'cA2', tenant_id: 'A', name: 'Apex', status: 'active' },
    ],
    AppConfig: [
      { id: 'cfgChat', key: 'chat', chat_engine: 'rag', rag_rollout_pct: 0, retrieval_mode: 'lexical' },
      { id: 'cfgSys', key: 'system', knowledge_gaps_enabled: true, clarifications_enabled: false, require_verification_for_retrieval: true, answer_logging_enabled: true, notifications_enabled: true },
    ],
    OperationalProcess: [],
    AuditEvent: [],
    ...data,
  });
  const anon = user === 'throw' || user == null || !user?.id;
  return {
    auth: { me: async () => { if (user === 'throw') throw new Error('401'); return user; } },
    // Member-scoped entity access must not be used by these functions.
    entities: new Proxy({}, { get: () => { throw new Error('user-scoped entity access in a scoped-read function'); } }),
    asServiceRole: { entities: new Proxy({}, { get: (_t, name) => d.table(String(name)) }), integrations: { Core: { InvokeLLM: async () => { throw new Error('no LLM in this test'); } } } },
    __db: d,
    __anon: anon,
  };
}

const m = (user_id, tenant_id, app_role = 'client_user', status = 'active') =>
  ({ id: `${user_id}-${tenant_id}`, user_id, email: `${user_id}@x.test`, tenant_id, app_role, status });
const person = (id, extra = {}) => ({ id, email: `${id}@x.test`, role: 'user', ...extra });
const platformAdmin = { id: 'pa', email: 'pa@x.test', role: 'admin' };

const H = {};
for (const fn of ['listKnowledgeSources', 'getKnowledgeSource', 'listMyClients', 'getMyWorkspace', 'getAppSettings', 'manageClients', 'analyzeTraining']) {
  H[fn] = await loadHandler(fn);
}
async function call(fn, client, body = {}) {
  globalThis.__mockSdk = () => client;
  const res = await post(H[fn], body);
  return { status: res.status, data: await res.json(), db: client.__db };
}
const knowledgeReads = (d) => d.reads.filter((n) => !['TenantMembership', 'Tenant'].includes(n));

const READS = [
  ['listKnowledgeSources', {}],
  ['getKnowledgeSource', { id: 'tB' }],
  ['listMyClients', {}],
  ['getMyWorkspace', {}],
];

// ---------------------------------------------------------------- refusals

for (const [fn, body] of [...READS, ['getAppSettings', {}], ['manageClients', { action: 'delete', clientId: 'cB' }], ['analyzeTraining', { trainingId: 'tB' }]]) {
  for (const [label, user] of [['SDK throws', 'throw'], ['no user', null]]) {
    test(`${fn}: anonymous (${label}) -> 401, no record read, nothing written`, async () => {
      const r = await call(fn, sdk({ user }), body);
      assert.equal(r.status, 401);
      assert.deepEqual(r.db.reads, []);
      assert.deepEqual(r.db.writes, []);
      assert.ok(!JSON.stringify(r.data).includes('CANARY'));
    });
  }
}

const REFUSALS = [
  ['no membership', person('u'), [], 403],
  ['pending invitation only', person('u'), [m('u', 'A', 'client_user', 'pending')], 403],
  ['inactive membership only', person('u'), [m('u', 'A', 'client_user', 'inactive')], 403],
  ['forged profile stamp, no membership', person('u', { data: { tenant_id: 'B' }, tenant_id: 'B' }), [], 403],
  ['active membership in a suspended workspace', person('u'), [m('u', 'S')], 403],
  ['active membership in an unknown workspace', person('u'), [m('u', 'GONE')], 400],
];
for (const [fn, body] of READS) {
  for (const [label, user, memberships, status] of REFUSALS) {
    test(`${fn}: ${label} -> ${status}, no record read`, async () => {
      const r = await call(fn, sdk({ user, memberships }), body);
      assert.equal(r.status, status);
      assert.deepEqual(knowledgeReads(r.db), []);
      assert.ok(!JSON.stringify(r.data).includes('CANARY'));
    });
  }
  test(`${fn}: several workspaces without a valid selection -> 409, no record read`, async () => {
    for (const workspaceId of [undefined, 'S', 'nope']) {
      const r = await call(fn, sdk({ user: person('u'), memberships: [m('u', 'A'), m('u', 'B')] }), { ...body, workspaceId });
      assert.equal(r.status, 409);
      assert.deepEqual(knowledgeReads(r.db), []);
    }
  });
}

// ---------------------------------------------------------------- tenant scoping

test('listKnowledgeSources: a member sees their tenant (+ legacy untagged), never another tenant; order kept', async () => {
  const r = await call('listKnowledgeSources', sdk({ user: person('u'), memberships: [m('u', 'A')] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.sources.map((s) => s.id), ['tA2', 'tA', 'tU']);
  assert.ok(!JSON.stringify(r.data).includes('CANARY'));
});

test('listKnowledgeSources: status filter and forged workspaceId / tenant_id in the body change nothing', async () => {
  const r = await call('listKnowledgeSources', sdk({ user: person('u', { data: { tenant_id: 'B' } }), memberships: [m('u', 'A')] }), { status: 'ready', workspaceId: 'B', tenant_id: 'B', tenantId: 'B' });
  assert.deepEqual(r.data.sources.map((s) => s.id), ['tA', 'tU']);
});

// Production has no workspace selection: a body workspaceId is ignored and a
// member of two workspaces is refused (409) instead of being scoped to one.
test('listKnowledgeSources: a two-workspace member is refused even with a workspaceId (production: no selection)', async () => {
  const r = await call('listKnowledgeSources', sdk({ user: person('u'), memberships: [m('u', 'A'), m('u', 'B')] }), { workspaceId: 'B' });
  assert.equal(r.status, 409);
});

test('getKnowledgeSource: another tenant\'s source is indistinguishable from a missing one', async () => {
  const other = await call('getKnowledgeSource', sdk({ user: person('u'), memberships: [m('u', 'A')] }), { id: 'tB' });
  const missing = await call('getKnowledgeSource', sdk({ user: person('u'), memberships: [m('u', 'A')] }), { id: 'nope' });
  assert.equal(other.status, 404);
  assert.deepEqual(other.data, missing.data);
  assert.equal(missing.status, 404);
  const own = await call('getKnowledgeSource', sdk({ user: person('u'), memberships: [m('u', 'A')] }), { id: 'tA' });
  assert.equal(own.status, 200);
  assert.equal(own.data.source.id, 'tA');
});

test('listMyClients: a member sees their tenant\'s clients (+ legacy untagged), sorted, never another tenant', async () => {
  const r = await call('listMyClients', sdk({ user: person('u'), memberships: [m('u', 'A')] }));
  assert.deepEqual(r.data.clients.map((c) => c.id), ['cA', 'cA2', 'cU']);
  assert.ok(!JSON.stringify(r.data).includes('CANARY'));
});

test('getMyWorkspace: own workspace display fields only — never config, plan, SSO, Drive folders or notes', async () => {
  const r = await call('getMyWorkspace', sdk({ user: person('u', { data: { tenant_id: 'B' } }), memberships: [m('u', 'A')] }));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data.workspace).sort(), ['brand_color', 'id', 'logo_url', 'name', 'slug', 'status']);
  assert.equal(r.data.workspace.id, 'A', 'from the membership, not the forged stamp');
});

test('platform admin: all sources and clients; workspace null without a membership', async () => {
  const s = await call('listKnowledgeSources', sdk({ user: platformAdmin }));
  assert.deepEqual(s.data.sources.map((x) => x.id).sort(), ['tA', 'tA2', 'tB', 'tU']);
  const c = await call('listMyClients', sdk({ user: platformAdmin }));
  assert.equal(c.data.clients.length, 4);
  const g = await call('getKnowledgeSource', sdk({ user: platformAdmin }), { id: 'tB' });
  assert.equal(g.status, 200);
  const w = await call('getMyWorkspace', sdk({ user: platformAdmin }));
  assert.equal(w.data.workspace, null);
});

// ---------------------------------------------------------------- settings

test('getAppSettings: members get only the allowlist (no ids, no administrative switches); admins get full rows', async () => {
  const mem = await call('getAppSettings', sdk({ user: person('u'), memberships: [m('u', 'A')] }));
  assert.equal(mem.status, 200);
  assert.deepEqual(mem.data.settings.chat, { key: 'chat', chat_engine: 'rag', rag_rollout_pct: 0 });
  assert.deepEqual(mem.data.settings.system, { key: 'system', knowledge_gaps_enabled: true, clarifications_enabled: false, require_verification_for_retrieval: true, answer_logging_enabled: true });
  const invited = await call('getAppSettings', sdk({ user: person('v'), memberships: [] }));
  assert.equal(invited.status, 200, 'global flags: the app shell works before joining a workspace');
  const adm = await call('getAppSettings', sdk({ user: platformAdmin }));
  assert.equal(adm.data.settings.chat.id, 'cfgChat');
  assert.equal(adm.data.settings.system.answer_logging_enabled, true);
});

// ---------------------------------------------------------------- client management

test('manageClients: client users are refused; nothing written', async () => {
  const r = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_user')] }), { action: 'create', name: 'X' });
  assert.equal(r.status, 403);
  assert.deepEqual(r.db.writes, []);
});

test('manageClients: a client admin creates only in their own tenant (stamped server-side)', async () => {
  const ok = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] }), { action: 'create', name: '  New Co ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.db.writes[0], ['Client.create', { name: 'New Co', status: 'active', tenant_id: 'A' }]);
  const cross = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] }), { action: 'create', name: 'X', tenantId: 'B' });
  assert.equal(cross.status, 403);
  assert.deepEqual(cross.db.writes, []);
});

test('manageClients: a client admin cannot touch another tenant\'s or a legacy untagged client (404, nothing written)', async () => {
  for (const clientId of ['cB', 'cU', 'nope']) {
    for (const action of ['update', 'delete']) {
      const r = await call('manageClients', sdk({ user: person('u', { data: { tenant_id: 'B' } }), memberships: [m('u', 'A', 'client_admin')] }), { action, clientId, status: 'archived' });
      assert.equal(r.status, 404, `${action} ${clientId}`);
      assert.deepEqual(r.db.writes, []);
    }
  }
});

test('manageClients: update allows only name/status — tenant_id is never changed', async () => {
  const r = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] }), { action: 'update', clientId: 'cA', status: 'archived', tenant_id: 'B', tenantId: 'B' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.db.writes[0], ['Client.update', 'cA', { status: 'archived' }]);
  const bad = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] }), { action: 'update', clientId: 'cA', status: 'deleted' });
  assert.equal(bad.status, 400);
});

test('manageClients: delete refuses while knowledge or processes reference the client — nothing deleted', async () => {
  const withSource = sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')], data: {} });
  withSource.__db.tables.Training.push({ id: 'tC', tenant_id: 'A', client_id: 'cA' });
  const r = await call('manageClients', withSource, { action: 'delete', clientId: 'cA' });
  assert.equal(r.status, 409);
  assert.ok(!r.db.writes.some(([op]) => op === 'Client.delete'));
  const withProcess = sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')], data: { OperationalProcess: [{ id: 'p1', client_id: 'cA' }] } });
  const r2 = await call('manageClients', withProcess, { action: 'delete', clientId: 'cA' });
  assert.equal(r2.status, 409);
  const free = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] }), { action: 'delete', clientId: 'cA2' });
  assert.equal(free.status, 200);
  assert.deepEqual(free.db.writes.map(([op]) => op), ['Client.delete', 'AuditEvent.create']);
});

test('manageClients: platform admin manages any client; create needs an explicit tenant', async () => {
  const upd = await call('manageClients', sdk({ user: platformAdmin }), { action: 'update', clientId: 'cB', name: 'Renamed' });
  assert.equal(upd.status, 200);
  const noTenant = await call('manageClients', sdk({ user: platformAdmin }), { action: 'create', name: 'X' });
  assert.equal(noTenant.status, 400);
  const explicit = await call('manageClients', sdk({ user: platformAdmin }), { action: 'create', name: 'X', tenantId: 'B' });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.db.writes[0][1].tenant_id, 'B');
  const suspended = await call('manageClients', sdk({ user: platformAdmin }), { action: 'create', name: 'X', tenantId: 'S' });
  assert.equal(suspended.status, 403);
});

// ---------------------------------------------------------------- analyzeTraining

test('analyzeTraining: another tenant\'s, a legacy untagged, or a missing source -> same 404, nothing written', async () => {
  const bodies = ['tB', 'tU', 'nope'].map((trainingId) => ({ trainingId }));
  const results = [];
  for (const body of bodies) {
    const r = await call('analyzeTraining', sdk({ user: person('u', { data: { tenant_id: 'B' } }), memberships: [m('u', 'A', 'client_admin')] }), body);
    assert.equal(r.status, 404);
    assert.deepEqual(r.db.writes, []);
    results.push(r.data);
  }
  for (const d of results) assert.deepEqual(d, results[0]);
});

test('analyzeTraining: pending / no membership / client user / suspended workspace -> 403 before the source is read', async () => {
  for (const memberships of [[], [m('u', 'A', 'client_admin', 'pending')], [m('u', 'A', 'client_user')], [m('u', 'S', 'client_admin')]]) {
    const r = await call('analyzeTraining', sdk({ user: person('u'), memberships }), { trainingId: 'tA' });
    assert.equal(r.status, 403);
    assert.ok(!r.db.reads.includes('Training'));
    assert.deepEqual(r.db.writes, []);
  }
});

test('analyzeTraining: the source read uses the service role (Training direct reads are admin-only)', () => {
  const s = src('base44/functions/analyzeTraining/entry.ts');
  assert.ok(!/[^e]\.entities\.Training\.get/.test(s.replace(/asServiceRole\.entities/g, 'SR')), 'no user-scoped Training read');
  assert.ok(s.indexOf('requireTenantAdminScope(') < s.indexOf('entities.Training.get('), 'authorized before the read');
});

test('analyzeTraining: a client admin of the source\'s tenant, and a platform admin, pass authorization', async () => {
  for (const [user, memberships, id] of [[person('u'), [m('u', 'A', 'client_admin')], 'tA'], [platformAdmin, [], 'tB'], [platformAdmin, [], 'tU']]) {
    const r = await call('analyzeTraining', sdk({ user, memberships }), { trainingId: id });
    assert.ok(![401, 403, 404].includes(r.status), `${user.id} on ${id}: ${r.status} ${JSON.stringify(r.data)}`);
    assert.ok(r.db.reads.includes('Training'));
  }
});

// ---------------------------------------------------------------- query shape + limits

test('fetchInScope: members query their tenant server-side; truncation at the read limit is reported', async () => {
  const queries = [];
  const fake = (n) => ({ filter: async (q) => { queries.push(q); return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tenant_id: q.tenant_id ?? 'A' })); } });
  const r = await fetchInScope(fake(3), readScopeFor({ isSuperAdmin: false, tenantId: 'A' }), { status: 'ready' });
  assert.deepEqual(queries, [{ status: 'ready', tenant_id: 'A' }, { status: 'ready' }], 'tenant query + legacy scan (interim)');
  assert.equal(r.truncated, false);
  queries.length = 0;
  await fetchInScope(fake(1), { kind: 'tenant', tenantId: 'A', includeUntagged: false });
  assert.deepEqual(queries, [{ tenant_id: 'A' }], 'strict mode: no unscoped scan at all');
  const big = await fetchInScope(fake(READ_LIMIT), readScopeFor({ isSuperAdmin: true, tenantId: null }));
  assert.equal(big.truncated, true);
});

test('fetchInScope: a query that returns too much still never leaks another tenant', async () => {
  const leaky = { filter: async () => [{ id: 'b', tenant_id: 'B' }, { id: 'a', tenant_id: 'A' }] };
  const r = await fetchInScope(leaky, readScopeFor({ isSuperAdmin: false, tenantId: 'A' }));
  assert.deepEqual(r.rows.map((x) => x.id), ['a']);
});

test('platform admin with several memberships is never asked to pick a workspace for reads', async () => {
  const r = await call('listKnowledgeSources', sdk({ user: platformAdmin, memberships: [m('pa', 'A', 'client_admin'), m('pa', 'B', 'client_admin')] }));
  assert.equal(r.status, 200);
  assert.equal(r.data.sources.length, 4);
});

// ---------------------------------------------------------------- manageClients edge cases

test('manageClients: a client admin of a suspended workspace changes nothing', async () => {
  const d = { Client: [{ id: 'cS', tenant_id: 'S', name: 'Sus', status: 'active' }] };
  for (const body of [{ action: 'create', name: 'X' }, { action: 'update', clientId: 'cS', name: 'Y' }, { action: 'delete', clientId: 'cS' }]) {
    const r = await call('manageClients', sdk({ user: person('u'), memberships: [m('u', 'S', 'client_admin')], data: d }), body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.deepEqual(r.db.writes, []);
  }
});

test('manageClients: delete fails closed when the linked-knowledge check cannot run', async () => {
  const client = sdk({ user: person('u'), memberships: [m('u', 'A', 'client_admin')] });
  const orig = client.asServiceRole.entities;
  client.asServiceRole.entities = new Proxy({}, { get: (_t, name) => (name === 'OperationalProcess'
    ? { filter: async () => { throw new Error('backend down'); } }
    : orig[name]) });
  const r = await call('manageClients', client, { action: 'delete', clientId: 'cA2' });
  assert.equal(r.status, 503);
  assert.ok(!client.__db.writes.some(([op]) => op === 'Client.delete'));
});
