// MindVault-branded invitation core.
//
// The testable heart of the flow — `base44` is passed in (real client or an
// in-memory fake), so scripts/rag-eval/invite-flow.test.mjs exercises the
// real logic with no database. The entry.ts adapters only add the auth guard,
// request parsing, and HTTP shaping.
//
// Invariants:
//   - the raw token appears ONLY in the emailed accept URL; the DB holds its
//     SHA-256 hash and nothing else usable
//   - tenant + role for activation come ONLY from the stored Invitation row,
//     never the browser / URL / request body
//   - activation requires the authenticated Base44 email to match the invite
//   - single-use: a consumed invite is inert; a re-accept by the SAME user is
//     an idempotent no-op, by a different user is a conflict
//   - no cross-tenant activation; a non-active tenant blocks acceptance
//   - every state change writes an append-only AuditEvent (best-effort)

import {
  generateRawInviteToken,
  hashInviteToken,
  inviteExpiryFrom,
  normalizeInviteEmail,
  classifyInviteAcceptability,
} from "./inviteToken.ts";
import { renderInviteEmail, sendTransactionalEmail, emailSendingIsLive } from "./emailProvider.ts";
import { APP_ROLE_CLIENT_ADMIN, APP_ROLE_CLIENT_USER } from "./tenant.ts";

/** Thrown when a LIVE send is attempted without a usable accept base URL. */
export class InviteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteConfigError";
  }
}

const ROLE_LABELS: Record<string, string> = {
  [APP_ROLE_CLIENT_ADMIN]: "Client Admin",
  [APP_ROLE_CLIENT_USER]: "Client User",
};

export function inviteRoleLabel(appRole: string): string {
  return ROLE_LABELS[appRole] || "team member";
}

/** j***@acme.test — for audit summaries and the preview, never the raw address. */
export function maskEmail(email: string): string {
  const norm = normalizeInviteEmail(email);
  const at = norm.indexOf("@");
  if (at < 1) return "***";
  const user = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  const head = user.length <= 1 ? user : `${user[0]}***`;
  return `${head}@${domain}`;
}

// A strict https origin, optionally with a path prefix, no query / fragment /
// trailing slash. e.g. https://app.example.com  or  https://example.com/mv
const HTTPS_ORIGIN_RE = /^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9](:\d{2,5})?(\/[a-z0-9._~%/-]*)?$/i;

function readAcceptBaseEnv(): string {
  try {
    // @ts-ignore Deno is only defined in the Base44 runtime
    if (typeof Deno !== "undefined" && Deno?.env?.get) {
      return String(Deno.env.get("INVITE_ACCEPT_BASE_URL") || "").trim();
    }
  } catch {
    /* not the Deno runtime */
  }
  return "";
}

// Never a plausible production domain — if this ever appears in a real inbox
// it is unmistakably a misconfiguration, not a working link.
const MOCK_ACCEPT_BASE = "https://invite.mock.invalid";

/**
 * The https origin the accept link is built on. There is NO reliable Base44
 * runtime signal for an app's canonical public URL (createClientFromRequest
 * only exposes the API host), so this MUST be provided explicitly via the
 * INVITE_ACCEPT_BASE_URL secret.
 *
 * Pure and injectable for tests: pass the raw configured value and whether a
 * live send is in effect.
 *   - valid https origin            -> that origin (trailing slash trimmed)
 *   - missing / invalid + live send -> throws InviteConfigError (fail closed)
 *   - missing / invalid + mock mode -> an obviously-fake placeholder so
 *                                      dev/tests still produce a URL
 */
export function resolveAcceptBaseUrl(baseUrlRaw: string, live: boolean): string {
  const raw = String(baseUrlRaw || "").trim().replace(/\/+$/, "");
  if (raw && HTTPS_ORIGIN_RE.test(raw)) return raw;
  if (live) {
    throw new InviteConfigError(
      raw
        ? `INVITE_ACCEPT_BASE_URL is not a valid https origin: "${raw}". Set it to the published MindVault app URL before sending live invitations.`
        : "INVITE_ACCEPT_BASE_URL is not set — refusing to send a live invitation with an unknown accept URL. Set it to the published MindVault app URL.",
    );
  }
  return MOCK_ACCEPT_BASE;
}

/** Env-backed resolver used by createAndSendInvitation. */
export function acceptBaseUrlFromEnv(): string {
  return resolveAcceptBaseUrl(readAcceptBaseEnv(), emailSendingIsLive());
}

export function buildAcceptUrl(rawToken: string): string {
  return `${acceptBaseUrlFromEnv()}/invite/accept?token=${encodeURIComponent(rawToken)}`;
}

async function writeAudit(
  base44: any,
  invitationId: string,
  action: string,
  actorUserId: string | null,
  summary: string,
): Promise<void> {
  try {
    await base44.asServiceRole.entities.AuditEvent.create({
      entity: "Invitation",
      entity_id: invitationId,
      action,
      actor_type: actorUserId ? "user" : "system",
      actor_user_id: actorUserId || null,
      summary,
    });
  } catch (err) {
    // Audit is best-effort — a logging failure must not fail the invite.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ fn: "invite.writeAudit", action, error: (err as any)?.message }));
  }
}

// ---------------------------------------------------------------------------
// Create + send
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  tenantId: string;
  email: string;
  appRole: string;
  invitedByUserId?: string | null;
  membershipId?: string | null;
  ttlMs?: number;
}

export interface CreateInviteResult {
  invitationId: string;
  emailMessageId: string;
  mocked: boolean;
}

/**
 * Supersede any still-open invitation for this (tenant, email), mint a fresh
 * single-use token, persist only its hash, and send the branded email
 * (mocked unless the deployment is explicitly configured for live send).
 */
export async function createAndSendInvitation(
  base44: any,
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const email = normalizeInviteEmail(input.email);
  if (!email) throw new Error("email is required");
  if (input.appRole !== APP_ROLE_CLIENT_ADMIN && input.appRole !== APP_ROLE_CLIENT_USER) {
    throw new Error("invalid role");
  }

  // Fail CLOSED before any write: a live send with no valid INVITE_ACCEPT_BASE_URL
  // throws here, so no Invitation row is created and no email goes out with a
  // wrong / placeholder domain. In mock mode this returns the fake placeholder.
  const acceptBase = acceptBaseUrlFromEnv();

  const tenant = await base44.asServiceRole.entities.Tenant.get(input.tenantId);
  if (!tenant) throw new Error("tenant not found");
  if (tenant.status && tenant.status !== "active") throw new Error("tenant is not active");

  // Only the newest link should work: revoke prior open invites for this pair.
  const prior = await base44.asServiceRole.entities.Invitation.filter({
    tenant_id: input.tenantId,
    email,
  });
  for (const row of prior || []) {
    if (row.status === "pending") {
      await base44.asServiceRole.entities.Invitation.update(row.id, { status: "revoked" });
      await writeAudit(base44, row.id, "invite_revoked", input.invitedByUserId || null,
        `Superseded by a newer invitation for ${maskEmail(email)}`);
    }
  }

  const rawToken = generateRawInviteToken();
  const tokenHash = await hashInviteToken(rawToken);
  const expiresAt = inviteExpiryFrom(Date.now(), input.ttlMs);

  const invitation = await base44.asServiceRole.entities.Invitation.create({
    token_hash: tokenHash,
    email,
    tenant_id: input.tenantId,
    app_role: input.appRole,
    status: "pending",
    expires_at: expiresAt,
    invited_by: input.invitedByUserId || null,
    membership_id: input.membershipId || null,
    sent_at: new Date().toISOString(),
  });

  let inviterName = "";
  if (input.invitedByUserId) {
    try {
      const u = await base44.asServiceRole.entities.User.get(input.invitedByUserId);
      inviterName = u?.full_name || "";
    } catch {
      /* inviter name is optional */
    }
  }

  const rendered = renderInviteEmail({
    tenantName: tenant.name || "your company",
    roleLabel: inviteRoleLabel(input.appRole),
    acceptUrl: `${acceptBase}/invite/accept?token=${encodeURIComponent(rawToken)}`,
    expiresAt,
    tenantLogoUrl: tenant.logo_url || "",
    brandColor: tenant.brand_color || "",
    inviterName,
  });

  let send: { id: string; mocked: boolean };
  try {
    send = await sendTransactionalEmail(base44, email, rendered);
  } catch (err) {
    // Record the REAL error so a failed send is diagnosable from the audit
    // trail, not just "Email send failed".
    const reason = String((err as any)?.message || err || "unknown error").slice(0, 300);
    await writeAudit(base44, invitation.id, "invite_send_failed", input.invitedByUserId || null,
      `Email send failed for ${maskEmail(email)}: ${reason}`);
    throw err;
  }

  await base44.asServiceRole.entities.Invitation.update(invitation.id, {
    email_message_id: send.id,
  });
  await writeAudit(base44, invitation.id, "invite_sent", input.invitedByUserId || null,
    `Invitation sent to ${maskEmail(email)} as ${inviteRoleLabel(input.appRole)} (tenant ${tenant.name || input.tenantId})`);

  return { invitationId: invitation.id, emailMessageId: send.id, mocked: !!send.mocked };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/** Mark every still-open invitation for (tenant, email) as revoked. */
export async function revokeOpenInvitations(
  base44: any,
  tenantId: string,
  email: string,
  actorUserId: string | null,
): Promise<number> {
  const norm = normalizeInviteEmail(email);
  const rows = await base44.asServiceRole.entities.Invitation.filter({
    tenant_id: tenantId,
    email: norm,
  });
  let revoked = 0;
  for (const row of rows || []) {
    if (row.status === "pending") {
      await base44.asServiceRole.entities.Invitation.update(row.id, { status: "revoked" });
      await writeAudit(base44, row.id, "invite_revoked", actorUserId,
        `Invitation for ${maskEmail(norm)} revoked`);
      revoked++;
    }
  }
  return revoked;
}

// ---------------------------------------------------------------------------
// Preview (anonymous)
// ---------------------------------------------------------------------------

export interface InvitePreview {
  found: boolean;
  status?: "pending" | "accepted" | "expired" | "revoked";
  tenantName?: string;
  tenantLogoUrl?: string;
  brandColor?: string;
  roleLabel?: string;
  emailMasked?: string;
}

/**
 * Public, unauthenticated preview for the accept page. Returns ONLY display
 * strings — no tenant id, no invitation id, no raw email, no token.
 */
export async function previewInvitation(base44: any, rawToken: string): Promise<InvitePreview> {
  const tokenHash = await hashInviteToken(String(rawToken || ""));
  if (!tokenHash) return { found: false };

  const rows = await base44.asServiceRole.entities.Invitation.filter({ token_hash: tokenHash });
  const row = (rows || [])[0];
  if (!row) return { found: false };

  let status = row.status as InvitePreview["status"];
  if (
    status === "pending" &&
    classifyInviteAcceptability(row, row.email, "active").reason === "expired"
  ) {
    try {
      await base44.asServiceRole.entities.Invitation.update(row.id, { status: "expired" });
    } catch {
      /* lazy flip is best-effort */
    }
    await writeAudit(base44, row.id, "invite_expired", null, "Invitation expired");
    status = "expired";
  }

  let tenantName = "";
  let tenantLogoUrl = "";
  let brandColor = "";
  try {
    const tenant = await base44.asServiceRole.entities.Tenant.get(row.tenant_id);
    tenantName = tenant?.name || "";
    tenantLogoUrl = tenant?.logo_url || "";
    brandColor = tenant?.brand_color || "";
  } catch {
    /* tenant lookup is best-effort for display */
  }

  return {
    found: true,
    status,
    tenantName,
    tenantLogoUrl,
    brandColor,
    roleLabel: inviteRoleLabel(row.app_role),
    emailMasked: maskEmail(row.email),
  };
}

// ---------------------------------------------------------------------------
// Accept (authenticated)
// ---------------------------------------------------------------------------

export interface AcceptResult {
  ok: boolean;
  status: number;
  tenant_id?: string;
  app_role?: string;
  membership_id?: string;
  idempotent?: boolean;
  reason?: string;
}

async function upsertActiveMembership(
  base44: any,
  args: {
    tenantId: string;
    appRole: string;
    email: string;
    userId: string;
    membershipId?: string | null;
    invitedBy?: string | null;
  },
): Promise<any> {
  const norm = normalizeInviteEmail(args.email);
  let row: any = null;

  if (args.membershipId) {
    try {
      row = await base44.asServiceRole.entities.TenantMembership.get(args.membershipId);
    } catch {
      row = null;
    }
    if (row && row.tenant_id !== args.tenantId) row = null; // never cross-tenant
  }
  if (!row) {
    const byUser = await base44.asServiceRole.entities.TenantMembership.filter({
      tenant_id: args.tenantId,
      user_id: args.userId,
    });
    row = (byUser || [])[0] || null;
  }
  if (!row) {
    const byEmail = await base44.asServiceRole.entities.TenantMembership.filter({
      tenant_id: args.tenantId,
      email: norm,
    });
    row = (byEmail || []).find((m: any) => m.status === "pending") || (byEmail || [])[0] || null;
  }

  if (row) {
    return await base44.asServiceRole.entities.TenantMembership.update(row.id, {
      user_id: args.userId,
      app_role: args.appRole,
      status: "active",
      activated_at: row.activated_at || new Date().toISOString(),
    });
  }
  return await base44.asServiceRole.entities.TenantMembership.create({
    tenant_id: args.tenantId,
    user_id: args.userId,
    email: norm,
    app_role: args.appRole,
    status: "active",
    invited_by: args.invitedBy || null,
    activated_at: new Date().toISOString(),
  });
}

const REASON_STATUS: Record<string, number> = {
  not_found: 404,
  revoked: 410,
  already_accepted: 409,
  expired: 410,
  email_mismatch: 403,
  tenant_inactive: 403,
};

/**
 * Consume the invitation and activate the membership. Tenant + role are taken
 * only from the stored row; activation requires `authedUser.email` to match
 * the invitation email.
 */
export async function activateInvitedMembership(
  base44: any,
  rawToken: string,
  authedUser: { id?: string; email?: string } | null,
): Promise<AcceptResult> {
  const authedUserId = authedUser?.id;
  const authedEmail = normalizeInviteEmail(authedUser?.email);
  if (!authedUserId) return { ok: false, status: 401, reason: "unauthorized" };

  const tokenHash = await hashInviteToken(String(rawToken || ""));
  const rows = await base44.asServiceRole.entities.Invitation.filter({ token_hash: tokenHash });
  const row = (rows || [])[0] || null;

  // Idempotent replay by the same user.
  if (row && row.status === "accepted" && row.accepted_user_id === authedUserId) {
    return { ok: true, status: 200, tenant_id: row.tenant_id, app_role: row.app_role, idempotent: true };
  }

  let tenantStatus: string | null = null;
  if (row) {
    try {
      const t = await base44.asServiceRole.entities.Tenant.get(row.tenant_id);
      tenantStatus = t?.status || "active";
    } catch {
      tenantStatus = null;
    }
  }

  const gate = classifyInviteAcceptability(row, authedEmail, tenantStatus);
  if (!gate.ok) {
    if (row && gate.reason === "email_mismatch") {
      await writeAudit(base44, row.id, "invite_email_mismatch", null,
        `Accept attempt for ${maskEmail(row.email)} by a different authenticated address`);
    }
    return { ok: false, status: REASON_STATUS[gate.reason] || 400, reason: gate.reason };
  }

  // Compare-and-set: re-read immediately before the flip to narrow the
  // concurrent-accept window.
  const fresh = await base44.asServiceRole.entities.Invitation.get(row.id);
  if (fresh?.status === "accepted") {
    if (fresh.accepted_user_id === authedUserId) {
      return { ok: true, status: 200, tenant_id: fresh.tenant_id, app_role: fresh.app_role, idempotent: true };
    }
    return { ok: false, status: 409, reason: "already_accepted" };
  }

  const membership = await upsertActiveMembership(base44, {
    tenantId: row.tenant_id,
    appRole: row.app_role,
    email: row.email,
    userId: authedUserId,
    membershipId: row.membership_id,
    invitedBy: row.invited_by,
  });

  await base44.asServiceRole.entities.Invitation.update(row.id, {
    status: "accepted",
    accepted_at: new Date().toISOString(),
    accepted_user_id: authedUserId,
  });
  await writeAudit(base44, row.id, "invite_accepted", authedUserId,
    `Invitation for ${maskEmail(row.email)} accepted as ${inviteRoleLabel(row.app_role)}`);

  try {
    await base44.auth.updateMe({ tenant_id: row.tenant_id });
  } catch {
    /* denormalized RLS stamp resyncs on next sign-in via resolveMyTenantContext */
  }

  return {
    ok: true,
    status: 200,
    tenant_id: row.tenant_id,
    app_role: row.app_role,
    membership_id: membership?.id,
  };
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

/** Flip every past-due pending invitation to 'expired'. Idempotent. */
export async function expireStaleInvitations(base44: any, now: number = Date.now()): Promise<number> {
  const pending = await base44.asServiceRole.entities.Invitation.filter({ status: "pending" });
  let expired = 0;
  for (const row of pending || []) {
    if (classifyInviteAcceptability(row, row.email, "active", now).reason === "expired") {
      await base44.asServiceRole.entities.Invitation.update(row.id, { status: "expired" });
      await writeAudit(base44, row.id, "invite_expired", null, "Invitation expired");
      expired++;
    }
  }
  return expired;
}