// Single-use, expiring MindVault invitation tokens.
//
// The RAW token is 32 bytes of CSPRNG randomness, base64url-encoded, and
// appears ONLY in the emailed accept URL (/invite/accept?token=…). We persist
// nothing but its SHA-256 hash, so a database read never yields a usable
// token. No custom cryptography — Web Crypto (crypto.getRandomValues +
// crypto.subtle.digest) only, available identically in Deno and Node.
//
// Deno + Node both import this file. No secrets, no Base44 calls, no I/O.

const RAW_TOKEN_BYTES = 32;

/** Default invitation lifetime: 7 days. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64"));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fresh random token. High entropy (256 bits), URL-safe, opaque — it
 * carries no tenant id, email, or role; those live only in the stored row.
 */
export function generateRawInviteToken(): string {
  const bytes = new Uint8Array(RAW_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** SHA-256 hex digest of a raw token — this is what gets stored and looked up. */
export async function hashInviteToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(String(raw || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** An ISO expiry `ttlMs` in the future (default 7 days). */
export function inviteExpiryFrom(now: number = Date.now(), ttlMs: number = DEFAULT_INVITE_TTL_MS): string {
  return new Date(now + ttlMs).toISOString();
}

/** True when `expiresAt` is missing, unparseable, or in the past. */
export function isInviteExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  const t = Date.parse(String(expiresAt || ""));
  return !Number.isFinite(t) || t <= now;
}

/** Lowercased, trimmed email — the canonical form the invitation binds to. */
export function normalizeInviteEmail(email: string | null | undefined): string {
  return String(email || "").trim().toLowerCase();
}

/** Case-insensitive email equality. Both sides must be non-empty to match. */
export function invitedEmailMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeInviteEmail(a);
  const nb = normalizeInviteEmail(b);
  return na.length > 0 && na === nb;
}

/**
 * The single place that decides whether an invitation row may still be
 * accepted. Pure — the caller supplies the row, the authenticated email, the
 * tenant's status, and `now`. Returns a machine-readable reason so the
 * handler can map it to an HTTP status and an audit action.
 */
export function classifyInviteAcceptability(
  row: {
    status?: string;
    email?: string;
    expires_at?: string;
    tenant_id?: string;
  } | null,
  authedEmail: string | null | undefined,
  tenantStatus: string | null | undefined,
  now: number = Date.now(),
): { ok: boolean; reason: "ok" | "not_found" | "revoked" | "already_accepted" | "expired" | "email_mismatch" | "tenant_inactive" } {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "revoked") return { ok: false, reason: "revoked" };
  if (row.status === "accepted") return { ok: false, reason: "already_accepted" };
  if (row.status === "expired" || isInviteExpired(row.expires_at, now)) {
    return { ok: false, reason: "expired" };
  }
  if (!invitedEmailMatches(row.email, authedEmail)) {
    return { ok: false, reason: "email_mismatch" };
  }
  if (tenantStatus && tenantStatus !== "active") {
    return { ok: false, reason: "tenant_inactive" };
  }
  return { ok: true, reason: "ok" };
}
