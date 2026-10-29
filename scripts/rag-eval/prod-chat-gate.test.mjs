// Production emergency gate for BOTH chat engines (askKnowledgeBase V1,
// askKnowledgeBaseV2). Both read and generate as the service role, so they
// must refuse before touching any data:
//  * anonymous (auth.me throws or returns null) -> 401;
//  * signed-in without an ACTIVE membership (none / pending / revoked) -> 403;
//  * active membership in a missing or non-active tenant -> 403;
//  * active members of an active tenant and platform admins proceed.
// No Base44, no network.
//   node --test scripts/rag-eval/prod-chat-gate.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, post } from './_load-handler.mjs';

globalThis.fetch = () => Promise.reject(new Error('test: network is blocked'));
globalThis.Deno = { env: { get: () => undefined }, serve() {} };

const TENANTS = { A: { id: 'A', status: 'active' }, S: { id: 'S', status: 'suspended' } };

function sdk({ user, memberships = [] }) {
  const reads = [];
  const deny = (name) => async (...a) => { reads.push([name, ...a]); return []; };
  const entityProxy = new Proxy({}, {
    get: (_t, entity) => {
      if (entity === 'TenantMembership') {
        return { filter: async (q) => memberships.filter((m) => Object.entries(q).every(([k, v]) => m[k] === v)) };
      }
      if (entity === 'Tenant') return { get: async (id) => (TENANTS[id] ? { ...TENANTS[id] } : null) };
      return { filter: deny(`${entity}.filter`), list: deny(`${entity}.list`), get: async (id) => { reads.push([`${entity}.get`, id]); return null; }, create: deny(`${entity}.create`) };
    },
  });
  return {
    auth: { me: async () => { if (user === 'throw') throw new Error('401 not authenticated'); return user; } },
    asServiceRole: {
      entities: entityProxy,
      integrations: { Core: { InvokeLLM: async () => { reads.push(['InvokeLLM']); return 'ok'; } } },
    },
    entities: entityProxy,
    __reads: reads,
  };
}

const m = (user_id, tenant_id, status = 'active', role = 'client_user') => ({ id: `${user_id}-${tenant_id}`, user_id, email: `${user_id}@x.test`, tenant_id, app_role: role, status });
const person = (id, extra = {}) => ({ id, email: `${id}@x.test`, role: 'user', ...extra });

for (const fn of ['askKnowledgeBase', 'askKnowledgeBaseV2']) {
  const run = async (opts, body = { question: 'How do we close the month?' }) => {
    const client = sdk(opts);
    globalThis.__mockSdk = () => client;
    const handler = await loadHandler(fn);
    const res = await handler(new Request('http://test/fn', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json().catch(() => null), reads: client.__reads };
  };
  const refusedBeforeData = (r) => assert.deepEqual(r.reads, [], `${fn}: nothing read or generated before refusal`);

  test(`${fn}: anonymous (auth.me throws) -> 401, nothing read`, async () => {
    const r = await run({ user: 'throw' });
    assert.equal(r.status, 401);
    refusedBeforeData(r);
  });

  test(`${fn}: anonymous (auth.me null) -> 401, nothing read`, async () => {
    const r = await run({ user: null });
    assert.equal(r.status, 401);
    refusedBeforeData(r);
  });

  test(`${fn}: signed in, no membership -> 403`, async () => {
    const r = await run({ user: person('u0') });
    assert.equal(r.status, 403);
    refusedBeforeData(r);
  });

  test(`${fn}: pending (email-matched) membership -> 403`, async () => {
    const r = await run({ user: person('u1'), memberships: [{ ...m('other', 'A', 'pending'), user_id: undefined, email: 'u1@x.test' }] });
    assert.equal(r.status, 403);
    refusedBeforeData(r);
  });

  test(`${fn}: revoked membership -> 403`, async () => {
    const r = await run({ user: person('u2'), memberships: [m('u2', 'A', 'revoked')] });
    assert.equal(r.status, 403);
    refusedBeforeData(r);
  });

  test(`${fn}: active membership in a suspended tenant -> 403`, async () => {
    const r = await run({ user: person('u3'), memberships: [m('u3', 'S')] });
    assert.equal(r.status, 403);
    refusedBeforeData(r);
  });

  test(`${fn}: active membership in a missing tenant -> 403`, async () => {
    const r = await run({ user: person('u4'), memberships: [m('u4', 'GONE')] });
    assert.equal(r.status, 403);
    refusedBeforeData(r);
  });

  test(`${fn}: active member of an active tenant passes the gate`, async () => {
    const r = await run({ user: person('u5'), memberships: [m('u5', 'A')] });
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });

  test(`${fn}: platform admin passes the gate without a membership`, async () => {
    const r = await run({ user: person('pa', { role: 'admin' }) });
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });

  test(`${fn}: missing question is still a 400 for an allowed caller (gate first, then validation)`, async () => {
    const r = await run({ user: person('u6'), memberships: [m('u6', 'A')] }, {});
    assert.equal(r.status, 400);
  });
}
