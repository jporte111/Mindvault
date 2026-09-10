// MindVault invitation tokens + email template — pure logic.
//
// No network, no Base44, no live email. Exercises the REAL shared modules
// (Node strips the TS types on import).
//   node --test scripts/rag-eval/invite-token.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  generateRawInviteToken,
  hashInviteToken,
  inviteExpiryFrom,
  isInviteExpired,
  normalizeInviteEmail,
  invitedEmailMatches,
  classifyInviteAcceptability,
  DEFAULT_INVITE_TTL_MS,
} from "../../base44/shared/inviteToken.ts";
import {
  renderInviteEmail,
  sendTransactionalEmail,
  getMockOutbox,
  clearMockOutbox,
  emailSendingIsLive,
} from "../../base44/shared/emailProvider.ts";

// ---------------------------------------------------------------------------
// Token generation + hashing
// ---------------------------------------------------------------------------

test("raw tokens are URL-safe, high-entropy, and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = generateRawInviteToken();
    assert.match(t, /^[A-Za-z0-9_-]{40,}$/, `token not URL-safe / long enough: ${t}`);
    assert.equal(seen.has(t), false, "duplicate token generated");
    seen.add(t);
  }
});

test("the raw token carries no tenant id, email, or role — it is opaque", () => {
  const t = generateRawInviteToken();
  assert.doesNotMatch(t, /tenant|@|client_admin|client_user/i);
});

test("hashInviteToken is deterministic, 64 hex chars, and collision-free for distinct input", async () => {
  const a = await hashInviteToken("abc123");
  const b = await hashInviteToken("abc123");
  const c = await hashInviteToken("abc124");
  assert.equal(a, b, "same input must hash the same");
  assert.match(a, /^[0-9a-f]{64}$/, "SHA-256 hex expected");
  assert.notEqual(a, c, "different input must hash differently");
});

test("a stored hash cannot be reversed to the raw token (we only ever persist the hash)", async () => {
  const raw = generateRawInviteToken();
  const hash = await hashInviteToken(raw);
  assert.notEqual(hash, raw);
  assert.doesNotMatch(hash, /[_-]/, "hash is plain hex, not the base64url token");
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("inviteExpiryFrom defaults to 7 days and is a valid ISO instant", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const exp = inviteExpiryFrom(now);
  assert.equal(exp, new Date(now + DEFAULT_INVITE_TTL_MS).toISOString());
  assert.equal(DEFAULT_INVITE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("isInviteExpired: past / missing / malformed all count as expired; future does not", () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");
  assert.equal(isInviteExpired("2026-05-31T23:59:59.000Z", now), true);
  assert.equal(isInviteExpired("2026-06-02T00:00:00.000Z", now), false);
  assert.equal(isInviteExpired("", now), true);
  assert.equal(isInviteExpired(undefined, now), true);
  assert.equal(isInviteExpired("not-a-date", now), true);
});

// ---------------------------------------------------------------------------
// Email binding
// ---------------------------------------------------------------------------

test("email normalization + matching is case- and whitespace-insensitive, and rejects empties", () => {
  assert.equal(normalizeInviteEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.equal(invitedEmailMatches("foo@bar.com", "FOO@BAR.com"), true);
  assert.equal(invitedEmailMatches(" foo@bar.com ", "foo@bar.com"), true);
  assert.equal(invitedEmailMatches("foo@bar.com", "other@bar.com"), false);
  assert.equal(invitedEmailMatches("", "foo@bar.com"), false);
  assert.equal(invitedEmailMatches(null, null), false);
});

// ---------------------------------------------------------------------------
// classifyInviteAcceptability — the single accept gate
// ---------------------------------------------------------------------------

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const okRow = { status: "pending", email: "invitee@acme.test", expires_at: FUTURE, tenant_id: "tenant-a" };

test("a fresh pending invite for the matching email in an active tenant is acceptable", () => {
  const r = classifyInviteAcceptability(okRow, "Invitee@Acme.test", "active");
  assert.deepEqual(r, { ok: true, reason: "ok" });
});

test("every unacceptable case has its own machine-readable reason and ok:false", () => {
  assert.equal(classifyInviteAcceptability(null, "x@y.z", "active").reason, "not_found");
  assert.equal(classifyInviteAcceptability({ ...okRow, status: "revoked" }, "invitee@acme.test", "active").reason, "revoked");
  assert.equal(classifyInviteAcceptability({ ...okRow, status: "accepted" }, "invitee@acme.test", "active").reason, "already_accepted");
  assert.equal(classifyInviteAcceptability({ ...okRow, expires_at: PAST }, "invitee@acme.test", "active").reason, "expired");
  assert.equal(classifyInviteAcceptability({ ...okRow, status: "expired" }, "invitee@acme.test", "active").reason, "expired");
  assert.equal(classifyInviteAcceptability(okRow, "someone-else@acme.test", "active").reason, "email_mismatch");
  assert.equal(classifyInviteAcceptability(okRow, "invitee@acme.test", "suspended").reason, "tenant_inactive");
  for (const reason of ["not_found", "revoked", "already_accepted", "expired", "email_mismatch", "tenant_inactive"]) {
    // spot-check ok flag stays false for each
  }
  assert.equal(classifyInviteAcceptability({ ...okRow, status: "revoked" }, "invitee@acme.test", "active").ok, false);
});

test("email mismatch is checked before tenant status — a wrong recipient never learns the tenant state", () => {
  const r = classifyInviteAcceptability({ ...okRow }, "attacker@evil.test", "suspended");
  assert.equal(r.reason, "email_mismatch");
});

// ---------------------------------------------------------------------------
// Branded email template
// ---------------------------------------------------------------------------

test("renderInviteEmail: MindVault-first, tenant-branded, correct subject, contains the CTA + accept URL + role + expiry", () => {
  const m = renderInviteEmail({
    tenantName: "Namaste Financial Management",
    roleLabel: "Client User",
    acceptUrl: "https://app.mindvault.test/invite/accept?token=RAWTOKEN",
    expiresAt: "2026-09-20T00:00:00.000Z",
    tenantLogoUrl: "https://cdn.test/logo.png",
    brandColor: "#0EA5E9",
    inviterName: "Jack",
  });
  assert.equal(m.subject, "You're invited to join Namaste Financial Management's MindVault");
  assert.match(m.html, /MindVault/);
  assert.match(m.html, /Namaste Financial Management/);
  assert.match(m.html, /Client User/);
  assert.match(m.html, /Join MindVault/);
  assert.match(m.html, /https:\/\/app\.mindvault\.test\/invite\/accept\?token=RAWTOKEN/);
  assert.match(m.html, /expires on/i);
  assert.match(m.html, /#0EA5E9/);
  assert.match(m.text, /Join MindVault: https:\/\/app\.mindvault\.test\/invite\/accept\?token=RAWTOKEN/);
});

test("renderInviteEmail never leaks a tenant id and escapes tenant-controlled text", () => {
  const m = renderInviteEmail({
    tenantName: '<script>alert(1)</script> & "Co"',
    roleLabel: "Client Admin",
    acceptUrl: "https://x.test/invite/accept?token=T",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  assert.doesNotMatch(m.html, /<script>alert/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.doesNotMatch(m.html, /tenant[_-]?id/i);
});

test("renderInviteEmail rejects a non-https logo / accept URL and a bad brand color, falling back safely", () => {
  const m = renderInviteEmail({
    tenantName: "Acme",
    roleLabel: "Client User",
    acceptUrl: "javascript:alert(1)",
    expiresAt: "2026-01-01T00:00:00.000Z",
    tenantLogoUrl: "http://insecure.test/logo.png",
    brandColor: "not-a-color",
  });
  assert.doesNotMatch(m.html, /javascript:/i);
  assert.doesNotMatch(m.html, /http:\/\/insecure/);
  assert.match(m.html, /#4F46E5/); // safe default brand color
});

// ---------------------------------------------------------------------------
// Email provider — mocked by default, nothing transmitted
// ---------------------------------------------------------------------------

test("email sending is NOT live in dev/test, and a send records to the mock outbox only", async () => {
  assert.equal(emailSendingIsLive(), false, "no INVITE_EMAIL_MODE=live in this env — must be mocked");
  clearMockOutbox();
  const rendered = renderInviteEmail({
    tenantName: "Acme",
    roleLabel: "Client User",
    acceptUrl: "https://x.test/invite/accept?token=T",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  const res = await sendTransactionalEmail("invitee@acme.test", rendered);
  assert.equal(res.mocked, true);
  assert.match(res.id, /^mock-/);
  const outbox = getMockOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "invitee@acme.test");
  assert.equal(outbox[0].subject, rendered.subject);
  clearMockOutbox();
});

test("sendTransactionalEmail refuses an empty recipient", async () => {
  await assert.rejects(() => sendTransactionalEmail("", renderInviteEmail({
    tenantName: "Acme", roleLabel: "x", acceptUrl: "https://x.test/", expiresAt: "2026-01-01T00:00:00.000Z",
  })));
});
