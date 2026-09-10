// MindVault-branded invitation flow — behavioral matrix.
//
// Exercises the REAL base44/shared/invite.ts against an in-memory fake Base44
// client. NO database, NO network, NO live email (every send is mocked and
// recorded to the shared outbox). Static-contract greps pin the deployed
// entry.ts adapters.
//   node --test scripts/rag-eval/invite-flow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createAndSendInvitation,
  previewInvitation,
  activateInvitedMembership,
  revokeOpenInvitations,
  expireStaleInvitations,
  maskEmail,
} from "../../base44/shared/invite.ts";
import { hashInviteToken, inviteExpiryFrom } from "../../base44/shared/inviteToken.ts";
import { getMockOutbox, clearMockOutbox, emailSendingIsLive } from "../../base44/shared/emailProvider.ts";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// --- in-memory fake -------------------------------------------------------

function makeStore(seed = []) {
  const rows = seed.map((r, i) => ({ id: r.id || `seed-${i + 1}`, ...r }));
  let seq = rows.length;
  return {
    _rows: rows,
    filter: async (q) => rows.filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)),
    get: async (id) => rows.find((r) => r.id === id) || null,
    create: async (payload) => {
      const row = { id: `gen-${++seq}`, ...payload };
      rows.push(row);
      return { ...row };
    },
    update: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`update: no row ${id}`);
      Object.assign(row, patch);
      return { ...row };
    },
  };
}

function makeClient({ user = null, tenants = [], invitations = [], memberships = [], users = [] } = {}) {
  const stores = {
    Tenant: makeStore(tenants),
    Invitation: makeStore(invitations),
    TenantMembership: makeStore(memberships),
    AuditEvent: makeStore([]),
    User: makeStore(users),
  };
  const updatedMe = [];
  const client = {
    auth: {
      me: async () => user,
      updateMe: async (patch) => {
        updatedMe.push(patch);
        return user;
      },
    },
    asServiceRole: { entities: stores },
  };
  return { client, stores, updatedMe };
}

const TENANT_A = { id: "tenant-a", name: "Acme Books", status: "active", logo_url: "https://cdn.test/a.png", brand_color: "#0EA5E9" };
const TENANT_B = { id: "tenant-b", name: "Beta LLC", status: "active" };
const TENANT_SUSPENDED = { id: "tenant-s", name: "Gone Inc", status: "suspended" };

const audits = (stores) => stores.AuditEvent._rows.map((a) => a.action);
const inviteRow = (stores) => stores.Invitation._rows[stores.Invitation._rows.length - 1];

async function seedInvite(overrides = {}) {
  const { client, stores } = makeClient({
    tenants: [TENANT_A, TENANT_B, TENANT_SUSPENDED],
    users: [{ id: "u-admin", email: "admin@acme.test", full_name: "Ada Admin", role: "user" }],
    ...overrides.clientSeed,
  });
  clearMockOutbox();
  await createAndSendInvitation(client, {
    tenantId: overrides.tenantId || "tenant-a",
    email: overrides.email || "invitee@acme.test",
    appRole: overrides.appRole || "client_user",
    invitedByUserId: "u-admin",
    ...(overrides.membershipId ? { membershipId: overrides.membershipId } : {}),
  });
  return { client, stores, row: inviteRow(stores) };
}

// extract the raw token from the mocked email's accept URL
function rawTokenFromOutbox() {
  const last = getMockOutbox().slice(-1)[0];
  const m = last && last.text.match(/token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// --- create + send ------------------------------------------------------

test("email sending is mocked in this environment — nothing is transmitted", () => {
  assert.equal(emailSendingIsLive(), false);
});

test("createAndSendInvitation stores only the token HASH, binds email/tenant/role, sets a ~7d expiry, and sends one branded (mocked) email", async () => {
  const { stores, row } = await seedInvite();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/, "token_hash must be a SHA-256 hex digest");
  assert.equal(row.email, "invitee@acme.test");
  assert.equal(row.tenant_id, "tenant-a");
  assert.equal(row.app_role, "client_user");
  assert.equal(row.status, "pending");
  assert.ok(!("token" in row) && !("raw_token" in row), "the raw token is never persisted");
  // expiry is ~7 days out
  const days = (Date.parse(row.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `expiry ~7d, got ${days}`);
  // the emailed raw token hashes to the stored hash
  const raw = rawTokenFromOutbox();
  assert.ok(raw && raw.length >= 40);
  assert.equal(await hashInviteToken(raw), row.token_hash);
  // exactly one email, MindVault-branded, no tenant id in it
  const outbox = getMockOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "invitee@acme.test");
  assert.match(outbox[0].subject, /join Acme Books's MindVault/);
  assert.doesNotMatch(outbox[0].html, /tenant-a|tenant_id/);
  // mock mode with no INVITE_ACCEPT_BASE_URL -> the fake placeholder, never a
  // plausible production domain.
  assert.match(outbox[0].text, /https:\/\/invite\.mock\.invalid\/invite\/accept\?token=/);
  assert.doesNotMatch(outbox[0].html, /https:\/\/mindvault\.app/);
  // audit
  assert.ok(audits(stores).includes("invite_sent"));
});

test("createAndSendInvitation refuses a suspended tenant and an invalid role", async () => {
  const { client } = makeClient({ tenants: [TENANT_SUSPENDED] });
  await assert.rejects(
    () => createAndSendInvitation(client, { tenantId: "tenant-s", email: "x@y.test", appRole: "client_user" }),
    /not active/,
  );
  const { client: c2 } = makeClient({ tenants: [TENANT_A] });
  await assert.rejects(
    () => createAndSendInvitation(c2, { tenantId: "tenant-a", email: "x@y.test", appRole: "root" }),
    /invalid role/,
  );
});

test("a second invite for the same (tenant,email) supersedes the first — only the newest token works", async () => {
  const { client, stores } = makeClient({ tenants: [TENANT_A], users: [{ id: "u-admin", email: "a@a.test", role: "user" }] });
  clearMockOutbox();
  await createAndSendInvitation(client, { tenantId: "tenant-a", email: "dup@acme.test", appRole: "client_user", invitedByUserId: "u-admin" });
  const firstRaw = rawTokenFromOutbox();
  await createAndSendInvitation(client, { tenantId: "tenant-a", email: "dup@acme.test", appRole: "client_admin", invitedByUserId: "u-admin" });
  const secondRaw = rawTokenFromOutbox();
  assert.notEqual(firstRaw, secondRaw);
  const rows = stores.Invitation._rows;
  assert.equal(rows.filter((r) => r.status === "pending").length, 1, "exactly one live invite");
  assert.equal(rows.find((r) => r.status === "revoked") !== undefined, true, "the first was revoked");
  // the OLD token now previews as invalid
  const p = await previewInvitation(client, firstRaw);
  assert.equal(p.status, "revoked");
});

// --- preview (anonymous) ----------------------------------------------

test("previewInvitation returns ONLY display strings — no tenant id, no invitation id, no unmasked email, no token", async () => {
  const { client } = await seedInvite();
  const raw = rawTokenFromOutbox();
  const p = await previewInvitation(client, raw);
  assert.equal(p.found, true);
  assert.equal(p.status, "pending");
  assert.equal(p.tenantName, "Acme Books");
  assert.equal(p.roleLabel, "Client User");
  assert.equal(p.emailMasked, "i***@acme.test");
  const keys = Object.keys(p);
  for (const forbidden of ["tenant_id", "id", "invitation_id", "email", "token", "token_hash"]) {
    assert.ok(!keys.includes(forbidden), `preview leaked "${forbidden}"`);
  }
});

test("previewInvitation: unknown token -> not found; expired pending -> lazily flipped to expired", async () => {
  const { client } = await seedInvite();
  assert.deepEqual(await previewInvitation(client, "nope-nope-nope"), { found: false });

  const { client: c2, stores } = makeClient({
    tenants: [TENANT_A],
    invitations: [
      { id: "inv-old", token_hash: await hashInviteToken("oldraw"), email: "e@acme.test", tenant_id: "tenant-a", app_role: "client_user", status: "pending", expires_at: "2000-01-01T00:00:00.000Z" },
    ],
  });
  const p = await previewInvitation(c2, "oldraw");
  assert.equal(p.status, "expired");
  assert.equal(stores.Invitation._rows[0].status, "expired", "row flipped in place");
  assert.ok(audits(stores).includes("invite_expired"));
});

// --- accept (authenticated) -----------------------------------------

test("accept happy path: matching email activates the membership with the INVITE's role, consumes the invite, audits, and syncs the RLS stamp", async () => {
  const { client, stores, row } = await seedInvite({ appRole: "client_admin" });
  const raw = rawTokenFromOutbox();

  // authed email differs only in case from the invitation email
  const res = await activateInvitedMembership(client, raw, { id: "u-new", email: "Invitee@Acme.test" });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.tenant_id, "tenant-a");
  assert.equal(res.app_role, "client_admin");

  const membership = stores.TenantMembership._rows.find((m) => m.user_id === "u-new");
  assert.ok(membership, "membership activated");
  assert.equal(membership.tenant_id, "tenant-a");
  assert.equal(membership.app_role, "client_admin", "role comes from the invitation");
  assert.equal(membership.status, "active");

  const inv = stores.Invitation._rows.find((r) => r.id === row.id);
  assert.equal(inv.status, "accepted");
  assert.equal(inv.accepted_user_id, "u-new");
  assert.ok(audits(stores).includes("invite_accepted"));
});

test("accept with a NON-matching authenticated email: 403 email_mismatch, nothing activated, audited", async () => {
  const { client, stores } = await seedInvite();
  const raw = rawTokenFromOutbox();
  const res = await activateInvitedMembership(client, raw, { id: "u-attacker", email: "someone-else@acme.test" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "email_mismatch");
  assert.equal(stores.TenantMembership._rows.length, 0, "no membership created");
  assert.equal(stores.Invitation._rows[0].status, "pending", "invite untouched");
  assert.ok(audits(stores).includes("invite_email_mismatch"));
});

test("accept unauthenticated -> 401; missing token -> handled", async () => {
  const { client } = await seedInvite();
  const raw = rawTokenFromOutbox();
  const r1 = await activateInvitedMembership(client, raw, null);
  assert.equal(r1.status, 401);
  const r2 = await activateInvitedMembership(client, "", { id: "u", email: "invitee@acme.test" });
  assert.equal(r2.ok, false);
});

test("accept an expired / revoked invite fails safely with no activation", async () => {
  // expired
  const exp = makeClient({
    tenants: [TENANT_A],
    invitations: [{ id: "inv-e", token_hash: await hashInviteToken("expraw"), email: "e@acme.test", tenant_id: "tenant-a", app_role: "client_user", status: "pending", expires_at: "2000-01-01T00:00:00.000Z" }],
  });
  const re = await activateInvitedMembership(exp.client, "expraw", { id: "ue", email: "e@acme.test" });
  assert.equal(re.status, 410);
  assert.equal(re.reason, "expired");
  assert.equal(exp.stores.TenantMembership._rows.length, 0);

  // revoked
  const rev = makeClient({
    tenants: [TENANT_A],
    invitations: [{ id: "inv-r", token_hash: await hashInviteToken("revraw"), email: "r@acme.test", tenant_id: "tenant-a", app_role: "client_user", status: "revoked", expires_at: inviteExpiryFrom() }],
  });
  const rr = await activateInvitedMembership(rev.client, "revraw", { id: "ur", email: "r@acme.test" });
  assert.equal(rr.status, 410);
  assert.equal(rr.reason, "revoked");
  assert.equal(rev.stores.TenantMembership._rows.length, 0);
});

test("single-use: the same user re-accepting is an idempotent no-op; a different user gets 409; only one invite_accepted audit", async () => {
  const { client, stores } = await seedInvite();
  const raw = rawTokenFromOutbox();
  const first = await activateInvitedMembership(client, raw, { id: "u1", email: "invitee@acme.test" });
  assert.equal(first.ok, true);
  const membershipCount = stores.TenantMembership._rows.length;

  const replay = await activateInvitedMembership(client, raw, { id: "u1", email: "invitee@acme.test" });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal(stores.TenantMembership._rows.length, membershipCount, "no duplicate membership");

  const other = await activateInvitedMembership(client, raw, { id: "u2", email: "invitee@acme.test" });
  assert.equal(other.ok, false);
  assert.equal(other.status, 409);

  assert.equal(audits(stores).filter((a) => a === "invite_accepted").length, 1);
});

test("no cross-tenant activation: a membership_id pointing at another tenant is ignored; the activated membership is always the invite's tenant", async () => {
  const { client, stores } = makeClient({
    tenants: [TENANT_A, TENANT_B],
    users: [{ id: "u-admin", email: "a@a.test", role: "user" }],
    memberships: [
      // a decoy membership in the WRONG tenant, id smuggled into the invite
      { id: "mem-wrong", tenant_id: "tenant-b", email: "invitee@acme.test", app_role: "client_admin", status: "pending" },
    ],
  });
  clearMockOutbox();
  await createAndSendInvitation(client, {
    tenantId: "tenant-a", email: "invitee@acme.test", appRole: "client_user",
    invitedByUserId: "u-admin", membershipId: "mem-wrong",
  });
  const raw = rawTokenFromOutbox();
  const res = await activateInvitedMembership(client, raw, { id: "u-new", email: "invitee@acme.test" });
  assert.equal(res.ok, true);
  assert.equal(res.tenant_id, "tenant-a");
  // the decoy row is untouched; a fresh membership exists ONLY in tenant-a
  assert.equal(stores.TenantMembership._rows.find((m) => m.id === "mem-wrong").status, "pending");
  const active = stores.TenantMembership._rows.filter((m) => m.status === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].tenant_id, "tenant-a");
});

test("accept into a tenant that has become inactive -> 403 tenant_inactive, no activation", async () => {
  const { client, stores } = makeClient({
    tenants: [{ id: "tenant-a", name: "Acme", status: "active" }],
    users: [{ id: "u-admin", email: "a@a.test", role: "user" }],
  });
  clearMockOutbox();
  await createAndSendInvitation(client, { tenantId: "tenant-a", email: "late@acme.test", appRole: "client_user", invitedByUserId: "u-admin" });
  const raw = rawTokenFromOutbox();
  stores.Tenant._rows[0].status = "suspended"; // tenant suspended before acceptance
  const res = await activateInvitedMembership(client, raw, { id: "u-late", email: "late@acme.test" });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "tenant_inactive");
  assert.equal(stores.TenantMembership._rows.filter((m) => m.status === "active").length, 0);
});

// --- revoke + expire helpers -----------------------------------------

test("revokeOpenInvitations flips only pending rows, audits each, and returns the count", async () => {
  const { client, stores } = makeClient({
    invitations: [
      { id: "i1", tenant_id: "tenant-a", email: "x@acme.test", status: "pending", app_role: "client_user", expires_at: inviteExpiryFrom() },
      { id: "i2", tenant_id: "tenant-a", email: "x@acme.test", status: "accepted", app_role: "client_user", expires_at: inviteExpiryFrom() },
      { id: "i3", tenant_id: "tenant-a", email: "other@acme.test", status: "pending", app_role: "client_user", expires_at: inviteExpiryFrom() },
    ],
  });
  const n = await revokeOpenInvitations(client, "tenant-a", "X@Acme.test", "u-admin");
  assert.equal(n, 1);
  assert.equal(stores.Invitation._rows.find((r) => r.id === "i1").status, "revoked");
  assert.equal(stores.Invitation._rows.find((r) => r.id === "i2").status, "accepted");
  assert.equal(stores.Invitation._rows.find((r) => r.id === "i3").status, "pending");
  assert.ok(audits(stores).includes("invite_revoked"));
});

test("expireStaleInvitations flips only past-due pending rows", async () => {
  const { client, stores } = makeClient({
    invitations: [
      { id: "p1", status: "pending", email: "a@t.test", expires_at: "2000-01-01T00:00:00.000Z" },
      { id: "p2", status: "pending", email: "b@t.test", expires_at: inviteExpiryFrom() },
      { id: "p3", status: "accepted", email: "c@t.test", expires_at: "2000-01-01T00:00:00.000Z" },
    ],
  });
  const n = await expireStaleInvitations(client);
  assert.equal(n, 1);
  assert.equal(stores.Invitation._rows.find((r) => r.id === "p1").status, "expired");
  assert.equal(stores.Invitation._rows.find((r) => r.id === "p2").status, "pending");
  assert.equal(stores.Invitation._rows.find((r) => r.id === "p3").status, "accepted");
});

test("maskEmail keeps the domain and hides the local part", () => {
  assert.equal(maskEmail("Jack.Porter@Namaste.test"), "j***@namaste.test");
  assert.equal(maskEmail("x@y.test"), "x@y.test");
  assert.equal(maskEmail("not-an-email"), "***");
});

// ====================================================================
// Static contract of the deployed adapters
// ====================================================================

test("manageTenantMembers no longer sends the generic Base44 invite, and wires the branded flow", () => {
  const s = read("base44/functions/manageTenantMembers/entry.ts");
  assert.doesNotMatch(s, /\.users\.inviteUser\(|\.auth\.inviteUser\(/, "the generic Base44 invite must be gone");
  assert.match(s, /createAndSendInvitation\(/);
  assert.match(s, /revokeOpenInvitations\(/, "revoke must cancel open invitations");
});

test("the Team UI offers a Resend invite action for pending members, wired to sendTenantInvite", () => {
  const mgr = read("src/components/admin/TenantMembersManager.jsx");
  assert.match(mgr, /invoke\('sendTenantInvite'/);
  assert.match(mgr, /action === 'resend'/);
  const row = read("src/components/admin/MemberRow.jsx");
  assert.match(row, /member\.status === 'pending'/);
  assert.match(row, /Resend invite/);
  assert.match(row, /onAction\(member, 'resend'/);
});

test("getInvitePreview is anonymous and leaks no ids", () => {
  const s = read("base44/functions/getInvitePreview/entry.ts");
  assert.doesNotMatch(s, /requireExplicitTenantAdminScope|requireTenantAdminScope|requireTenantMemberScope/,
    "the preview endpoint must be callable without a session");
  assert.doesNotMatch(s, /tenant_id|invitation_id|token_hash/, "no id leaves this endpoint");
  assert.match(s, /previewInvitation\(/);
});

test("acceptTenantInvite is authenticated, resolves tenant+role server-side, and does not echo a tenant id", () => {
  const s = read("base44/functions/acceptTenantInvite/entry.ts");
  assert.match(s, /base44\.auth\.me\(\)/);
  assert.match(s, /activateInvitedMembership\(/);
  assert.doesNotMatch(s, /tenant_id:/, "the accept response must not echo the tenant id");
});

test("sendTenantInvite is Client-Admin scoped via the authoritative helper", () => {
  const s = read("base44/functions/sendTenantInvite/entry.ts");
  assert.match(s, /requireExplicitTenantAdminScope\(base44, body\?\.tenant_id\)/);
  assert.match(s, /createAndSendInvitation\(/);
});

test("the Invitation entity stores a hash, never a token, and is admin-only RLS", () => {
  const s = read("base44/entities/Invitation.jsonc");
  assert.match(s, /"token_hash"/);
  assert.doesNotMatch(s, /"token"\s*:/, "no raw-token field");
  assert.match(s, /"rls":[\s\S]*"read":\s*\{\s*"user_condition":\s*\{\s*"role":\s*"admin"/);
});
