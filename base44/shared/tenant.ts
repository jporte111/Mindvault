// Multi-tenant resolution for MindVault SaaS. THE authoritative source for a
// user's tenant is the TenantMembership entity — NEVER user.data.tenant_id
// (that field is only a denormalized RLS stamp the app maintains).
//
// Roles:
//   Super Admin   = Base44 role 'admin' (the platform owner). May administer
//                   every tenant; never scoped to record-level tenant RLS.
//   Client Admin  = TenantMembership.app_role 'client_admin' (Base44 role
//                   'user'). Administers exactly their own tenant.
//   Client User   = TenantMembership.app_role 'client_user' (Base44 role
//                   'user'). Uses the app within their own tenant only.
//
// Pure-ish helpers + Base44 calls. Deno + Node both import it. No secrets.

export const APP_ROLE_CLIENT_ADMIN = "client_admin";
export const APP_ROLE_CLIENT_USER = "client_user";

export class TenantAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface TenantContext {
  userId: string;
  email: string | null;
  isSuperAdmin: boolean; // Base44 role 'admin' — platform owner
  tenantId: string | null; // authoritative tenant id from TenantMembership
  appRole: string | null; // 'client_admin' | 'client_user' | null
  hasTenantAccess: boolean; // super admin OR active membership
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

/**
 * Resolve the caller's tenant context. Always server-side: reads
 * base44.auth.me() and the TenantMembership table (service role, so pending
 * pre-provisioned rows are visible too). Never accepts a tenant id from the
 * request payload.
 */
export async function resolveTenantContext(base44: any): Promise<TenantContext> {
  const user = await base44.auth.me();
  if (!user || !user.id) throw new TenantAuthError(401, "Unauthorized");

  const isSuperAdmin = user.role === "admin";
  const email = normalizeEmail(user.email);

  let membership: any = null;
  const byId = await base44.asServiceRole.entities.TenantMembership.filter({
    user_id: user.id,
  });
  if (byId && byId.length) {
    membership = byId.find((m: any) => m.status === "active") || byId[0];
  } else if (email) {
    // Pre-provisioned invite rows match on email until first sign-in.
    const byEmail = await base44.asServiceRole.entities.TenantMembership.filter({
      email,
      status: "pending",
    });
    if (byEmail && byEmail.length) membership = byEmail[0];
  }

  return {
    userId: user.id,
    email,
    isSuperAdmin,
    tenantId: membership?.tenant_id || null,
    appRole: membership?.app_role || null,
    hasTenantAccess: isSuperAdmin || membership?.status === "active",
  };
}

/**
 * Tenant id a caller may operate on for TENANT-ADMIN actions (dashboards,
 * governance, invitations). A Client Admin is pinned to their own tenant and
 * a mismatched requestedTenantId is a hard 403. A Super Admin may target any
 * tenant explicitly (or defaults to their own membership's tenant).
 */
export async function requireTenantAdminScope(
  base44: any,
  requestedTenantId?: string | null,
): Promise<{ isSuperAdmin: boolean; tenantId: string; appRole: string | null }> {
  const ctx = await resolveTenantContext(base44);
  if (ctx.isSuperAdmin) {
    const tenantId =
      requestedTenantId && String(requestedTenantId).trim()
        ? String(requestedTenantId).trim()
        : ctx.tenantId;
    if (!tenantId) {
      throw new TenantAuthError(400, "A tenant must be specified");
    }
    return { isSuperAdmin: true, tenantId, appRole: ctx.appRole };
  }
  // Status is enforced here, not just in hasTenantAccess: a revoked
  // ('inactive') or never-signed-in ('pending') membership grants nothing.
  if (!ctx.hasTenantAccess || ctx.appRole !== APP_ROLE_CLIENT_ADMIN || !ctx.tenantId) {
    throw new TenantAuthError(403, "Forbidden — active tenant admins only");
  }
  if (
    requestedTenantId &&
    String(requestedTenantId).trim() &&
    String(requestedTenantId).trim() !== ctx.tenantId
  ) {
    throw new TenantAuthError(403, "Forbidden — cross-tenant access is not allowed");
  }
  return { isSuperAdmin: false, tenantId: ctx.tenantId, appRole: ctx.appRole };
}

/**
 * Tenant-admin scope for WRITE actions on tenant-specific data. A Super Admin
 * must target a tenant EXPLICITLY — there is deliberately NO silent fallback
 * to their own/default membership tenant, so an ambiguous request can never
 * produce an unintended write. Client Admins are pinned exactly as in
 * requireTenantAdminScope (own tenant only, mismatched id -> hard 403).
 */
export async function requireExplicitTenantAdminScope(
  base44: any,
  requestedTenantId?: string | null,
): Promise<{ isSuperAdmin: boolean; tenantId: string; appRole: string | null }> {
  const ctx = await resolveTenantContext(base44);
  if (ctx.isSuperAdmin) {
    const explicit = requestedTenantId ? String(requestedTenantId).trim() : "";
    if (explicit) {
      return { isSuperAdmin: true, tenantId: explicit, appRole: ctx.appRole };
    }
    // No explicit target given. A Super Admin who is ALSO the active Client
    // Admin of exactly one tenant (their own firm) is unambiguously acting
    // on their own workspace when they use a self-service screen — resolve
    // to it, exactly as a Client Admin would. This is NOT the removed silent
    // "default to Tenant #1" fallback: it fires ONLY when the caller
    // actually holds an active client_admin membership. A Super Admin with
    // no such membership still gets the hard 400 below, so a membership-less
    // platform account can never produce an unintended write.
    if (
      ctx.tenantId &&
      ctx.hasTenantAccess &&
      ctx.appRole === APP_ROLE_CLIENT_ADMIN
    ) {
      return { isSuperAdmin: true, tenantId: ctx.tenantId, appRole: ctx.appRole };
    }
    throw new TenantAuthError(400, "A tenant must be specified");
  }
  return requireTenantAdminScope(base44, requestedTenantId);
}

/**
 * Tenant scope for MEMBER actions (asking the knowledge base, feedback,
 * clarifications). Super Admin falls back to their own membership's tenant
 * (the platform owner's firm, Tenant #1).
 */
export async function requireTenantMemberScope(
  base44: any,
): Promise<{ isSuperAdmin: boolean; tenantId: string; appRole: string | null }> {
  const ctx = await resolveTenantContext(base44);
  if (ctx.isSuperAdmin && ctx.tenantId) {
    return { isSuperAdmin: true, tenantId: ctx.tenantId, appRole: ctx.appRole };
  }
  if (ctx.isSuperAdmin) {
    throw new TenantAuthError(400, "No tenant context for this platform account");
  }
  if (!ctx.hasTenantAccess || !ctx.tenantId || ctx.appRole !== APP_ROLE_CLIENT_USER && ctx.appRole !== APP_ROLE_CLIENT_ADMIN) {
    throw new TenantAuthError(403, "Forbidden — no active tenant membership");
  }
  return { isSuperAdmin: false, tenantId: ctx.tenantId, appRole: ctx.appRole };
}

/** Mongo filter for tenant-owned rows, for service-role (RLS-bypassing) queries. */
export function tenantFilter(tenantId: string): { tenant_id: string } {
  return { tenant_id: tenantId };
}

/** Stamp a create payload with its owning tenant (service-role writes). */
export function withTenant<T extends Record<string, any>>(tenantId: string, payload: T): T {
  return { ...payload, tenant_id: tenantId };
}