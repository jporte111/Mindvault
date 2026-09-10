// Outbound transactional email for MindVault (invitations, and reserved for
// future branded notifications).
//
// SAFE BY DEFAULT: nothing leaves the system unless ALL of these hold —
//   INVITE_EMAIL_MODE === 'live'   (exact string)
//   INVITE_ESP_API_KEY is set
//   INVITE_FROM is set             (e.g. "MindVault <invite@send.mindvault.app>")
// Otherwise every send is recorded to an in-memory outbox and returns a
// `mock-…` id. Development and tests never send real mail.
//
// Base44's own Core.SendEmail cannot be used here: it is plain-text only,
// its from-address is Base44-controlled, and it only delivers to already-
// registered users — an invitee is not one yet. So a real send is a direct
// fetch to a domain-verified provider (Resend-compatible payload).

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  id: string;
  mocked: boolean;
}

interface OutboxRecord {
  to: string;
  subject: string;
  html: string;
  text: string;
  id: string;
  at: string;
}

// Optional chaining does not guard an *undeclared* identifier, so `Deno` must
// be probed with typeof.
function env(key: string): string | undefined {
  try {
    // @ts-ignore - Deno is only defined in the Base44 runtime
    if (typeof Deno !== "undefined" && Deno?.env?.get) return Deno.env.get(key) || undefined;
  } catch {
    /* not the Deno runtime */
  }
  return undefined;
}

function liveEnabled(): boolean {
  return (
    (env("INVITE_EMAIL_MODE") || "mock").trim().toLowerCase() === "live" &&
    !!env("INVITE_ESP_API_KEY") &&
    !!env("INVITE_FROM")
  );
}

const _outbox: OutboxRecord[] = [];

/** Test/inspection hook — the messages a mock send recorded, newest last. */
export function getMockOutbox(): OutboxRecord[] {
  return _outbox.slice();
}

/** Test hook — empty the mock outbox between cases. */
export function clearMockOutbox(): void {
  _outbox.length = 0;
}

/** True when this process would actually transmit mail. */
export function emailSendingIsLive(): boolean {
  return liveEnabled();
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Send one transactional email. In mock mode (the default) it records the
 * message and returns `{ id: 'mock-…', mocked: true }` — no network call.
 */
export async function sendTransactionalEmail(
  to: string,
  rendered: RenderedEmail,
): Promise<EmailSendResult> {
  const recipient = String(to || "").trim();
  if (!recipient) throw new Error("email recipient is required");

  if (!liveEnabled()) {
    const rec: OutboxRecord = {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      id: `mock-${randomId()}`,
      at: new Date().toISOString(),
    };
    _outbox.push(rec);
    return { id: rec.id, mocked: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("INVITE_ESP_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env("INVITE_FROM"),
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`email provider responded ${res.status}`);
  }
  const data = await res.json().catch(() => ({} as any));
  return { id: (data && data.id) || "sent", mocked: false };
}

// ---------------------------------------------------------------------------
// Branded invitation template. MindVault-first, tenant-branded. No tenant id,
// no token beyond the accept URL, no raw HTML from tenant data (every
// interpolated value is escaped).
// ---------------------------------------------------------------------------

export interface InviteEmailInput {
  tenantName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresAt: string;
  tenantLogoUrl?: string;
  brandColor?: string;
  inviterName?: string;
}

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHttpUrl(u: string | undefined): string {
  const s = String(u || "").trim();
  return /^https:\/\//i.test(s) ? s : "";
}

function safeHexColor(c: string | undefined): string {
  const s = String(c || "").trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s) ? s : "#4F46E5";
}

function formatExpiry(iso: string): string {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "soon";
  try {
    return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

// Hosted icon assets. Email clients (Gmail, Outlook) don't render inline SVG
// or data URIs, so the feature icons are public PNG URLs.
const IMG_ICON_RESOURCES =
  "https://media.base44.com/images/public/6a0211352401fa8c3c1ed722/591f75c79_generated_image.png";
const IMG_ICON_TEAM =
  "https://media.base44.com/images/public/6a0211352401fa8c3c1ed722/437179243_generated_image.png";
const IMG_ICON_SHIELD =
  "https://media.base44.com/images/public/6a0211352401fa8c3c1ed722/2abc1d051_generated_image.png";
const IMG_ICON_CALENDAR =
  "https://media.base44.com/images/public/6a0211352401fa8c3c1ed722/131247dc5_generated_image.png";

export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const tenantName = String(input.tenantName || "your company");
  const roleLabel = String(input.roleLabel || "team member");
  const acceptUrl = safeHttpUrl(input.acceptUrl);
  const logo = safeHttpUrl(input.tenantLogoUrl);
  const brand = safeHexColor(input.brandColor);
  const expiry = formatExpiry(input.expiresAt);
  const inviter = input.inviterName ? String(input.inviterName) : "";

  const subject = `You're invited to join ${tenantName}'s MindVault`;

  const eTenant = escapeHtml(tenantName);
  const eRole = escapeHtml(roleLabel);
  const eInviter = escapeHtml(inviter);
  const eUrl = escapeHtml(acceptUrl);
  const eExpiry = escapeHtml(expiry);

  // Header: the tenant's own logo; a MindVault wordmark fallback when none.
  const headerBlock = logo
    ? `<tr><td style="padding:32px 32px 0;text-align:center">
          <img src="${escapeHtml(logo)}" alt="${eTenant}" height="56" style="height:56px;width:auto;border:0;display:block;margin:0 auto" />
        </td></tr>`
    : `<tr><td style="padding:32px 32px 0;text-align:center">
          <div style="font-weight:700;font-size:15px;letter-spacing:.2px;color:#4F46E5">MindVault</div>
        </td></tr>`;

  const inviterLine = inviter
    ? `${eInviter} invited you to join ${eTenant} as a <strong>${eRole}</strong>.`
    : `You've been invited to join ${eTenant} as a <strong>${eRole}</strong>.`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">
        ${headerBlock}
        <tr><td style="padding:20px 32px 0;text-align:center">
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#1f2937">You're invited to join<br/>${eTenant}'s MindVault</h1>
        </td></tr>
        <tr><td style="padding:12px 40px 0;text-align:center">
          <p style="margin:0;font-size:14px;line-height:1.6;color:#5b6472">${inviterLine}</p>
          <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#5b6472">MindVault is our centralized knowledge hub where you'll have access to important resources, documents, and tools.</p>
        </td></tr>
        <tr><td style="padding:24px 32px 0;text-align:center">
          <a href="${eUrl}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 32px;border-radius:10px">Join MindVault &rarr;</a>
        </td></tr>
        <tr><td style="padding:28px 40px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="33.33%" align="center" style="padding:0 6px;vertical-align:top">
                <img src="${IMG_ICON_RESOURCES}" width="48" height="48" alt="" style="border:0;display:block;margin:0 auto" />
                <p style="margin:10px 0 0;font-size:12px;line-height:1.4;color:#5b6472">Access key resources</p>
              </td>
              <td width="33.33%" align="center" style="padding:0 6px;vertical-align:top">
                <img src="${IMG_ICON_TEAM}" width="48" height="48" alt="" style="border:0;display:block;margin:0 auto" />
                <p style="margin:10px 0 0;font-size:12px;line-height:1.4;color:#5b6472">Collaborate with your team</p>
              </td>
              <td width="33.33%" align="center" style="padding:0 6px;vertical-align:top">
                <img src="${IMG_ICON_SHIELD}" width="48" height="48" alt="" style="border:0;display:block;margin:0 auto" />
                <p style="margin:10px 0 0;font-size:12px;line-height:1.4;color:#5b6472">Stay aligned and informed</p>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:28px 32px 0;text-align:center">
          <p style="margin:0;font-size:13px;color:#5b6472">
            <img src="${IMG_ICON_CALENDAR}" width="14" height="14" alt="" style="border:0;vertical-align:-2px" />&nbsp;This invitation expires on <strong>${eExpiry}</strong>.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 32px">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;text-align:center">
            <p style="margin:0 0 6px;font-size:12px;color:#8a93a2">If the button doesn't work, copy and paste this link into your browser:</p>
            <p style="margin:0;font-size:12px;color:#5b6472;word-break:break-all">${eUrl}</p>
          </div>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#a0a7b4">Powered by MindVault.<br/>If you weren't expecting this, you can ignore this email.</p>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `You've been invited to join ${tenantName}'s MindVault.`,
    inviter
      ? `${inviter} invited you to join ${tenantName} as a ${roleLabel}.`
      : `You've been invited to join ${tenantName} as a ${roleLabel}.`,
    `MindVault is our centralized knowledge hub where you'll have access to important resources, documents, and tools.`,
    ``,
    `Join MindVault: ${acceptUrl}`,
    ``,
    `This invitation expires on ${expiry}.`,
    `Powered by MindVault. If you weren't expecting this, you can ignore this email.`,
  ].join("\n");

  return { subject, html, text };
}