# MindVault-branded invitations & password reset

Replaces the generic `Base44 App <no-reply@base44-apps.com>` invitation with a
MindVault-branded, tenant-branded flow, and adds branded Forgot / Reset
Password screens. Base44 stays the credential + session authority — no custom
password hashing, sessions, or JWTs.

## Prerequisite (Base44 dashboard)

The app must be **Public (login required)** with **Google**, **Microsoft**,
and **Email & password** enabled (Settings → Authentication). Confirmed set on
2026‑09‑10. Under an invite-only mode `auth.register()` for a new email is
rejected and this flow does not work.

## Invitation flow

1. **Client Admin invites** on the Team page → `manageTenantMembers` action
   `invite` creates the pending `TenantMembership` (unchanged) and then calls
   `createAndSendInvitation` (`base44/shared/invite.ts`). **The generic Base44
   invite (`base44.users.inviteUser`) is no longer sent.**
2. `createAndSendInvitation` mints a 256-bit random token, stores **only its
   SHA-256 hash** in the new `Invitation` entity (bound to email + tenant_id +
   app_role + a 7-day `expires_at`), supersedes any prior open invite for that
   pair, and sends the branded email via `base44/shared/emailProvider.ts`.
3. The invitee opens `/invite/accept?token=…` (`src/pages/AcceptInvite.jsx`,
   a public route). `getInvitePreview` (anonymous) returns display strings
   only — company name/logo/brand colour, role label, masked email. **No
   tenant id in the URL or the preview.**
4. The invitee authenticates: **Google / Microsoft** (primary) or **email +
   password** (fallback: `register` → OTP → `verifyOtp` →
   `loginViaEmailPassword`).
5. `acceptTenantInvite` (authenticated) verifies the authenticated Base44
   email matches the invitation, then activates the authoritative
   `TenantMembership`. **Tenant and role come only from the stored Invitation
   row.** Single-use: same-user replay is idempotent, a different user is
   `409`. Never cross-tenant. A non-active tenant is refused.
6. `resolveMyTenantContext` remains the fallback activation path (pending
   membership + email match) for resilience.

### Revoke / expire

- `manageTenantMembers` `revoke` marks the member inactive **and** calls
  `revokeOpenInvitations` — a not-yet-accepted link cannot be used afterwards.
- `manageTenantMembers` `reactivate` of a never-signed-in member re-issues a
  fresh branded invitation.
- `expireTenantInvites` (function + `Daily Invitation Expiry Sweep` workflow)
  flips past-due pending rows to `expired`. `getInvitePreview` /
  `acceptTenantInvite` also expire lazily.

### Audit

Every state change writes an append-only `AuditEvent` (`entity: "Invitation"`):
`invite_sent`, `invite_accepted`, `invite_revoked`, `invite_expired`,
`invite_email_mismatch`, `invite_send_failed`. Summaries use a **masked**
email; the raw token never appears.

## Email: mock by default

`base44/shared/emailProvider.ts` transmits nothing unless **all** of these are
set as Base44 secrets:

| Secret | Purpose |
|---|---|
| `INVITE_EMAIL_MODE` | must be the exact string `live` |
| `INVITE_ESP_API_KEY` | Resend-compatible API key |
| `INVITE_FROM` | e.g. `MindVault <invite@send.mindvault.app>` (domain must be verified: SPF/DKIM/DMARC) |
| `INVITE_ACCEPT_BASE_URL` | **Required for live send.** The published MindVault app's https origin (no trailing slash, no query), e.g. `https://<app>.base44.app` or a custom domain. There is no reliable Base44 runtime signal for this, so it must be explicit. |

Otherwise every send records to an in-memory outbox and returns a `mock-…`
id. Development and the whole test suite never send real mail.

**Fail-closed on the accept URL.** `createAndSendInvitation` calls
`acceptBaseUrlFromEnv()` before it writes anything. If a **live** send is in
effect (`INVITE_EMAIL_MODE=live` + key + from) and `INVITE_ACCEPT_BASE_URL` is
missing or not a valid https origin, it throws `InviteConfigError` — no
`Invitation` row is created and no email is sent. `manageTenantMembers`
surfaces this as `{ member, email_error }` (the pending membership still
exists; use **Resend invite** once the secret is set). In mock mode the
resolver returns `https://invite.mock.invalid` — an unmistakably fake
placeholder that can never be confused for a real link. The production domain
is **not** hard-coded anywhere.

### Enabling a live test (only when explicitly authorised)

1. `base44 secrets set INVITE_ESP_API_KEY … INVITE_FROM … INVITE_ACCEPT_BASE_URL … INVITE_EMAIL_MODE live`
2. Send one invite to a mailbox you control; confirm it renders and the accept
   link resolves.
3. Set `INVITE_EMAIL_MODE` back to `mock` (or leave live once verified).

## Forgot / Reset password

`src/pages/ForgotPassword.jsx` → `base44.auth.resetPasswordRequest`;
`src/pages/ResetPassword.jsx` → `base44.auth.resetPassword`.

- Enumeration-safe: a resolved request always shows the same neutral message.
- Never claims "sent" on a rejected request.
- OAuth-only accounts have no password — both screens say so.
- Base44 still sends the reset email itself (no from-address / template
  override on the platform). We brand the **screens**, not that email.

## Known limitations (Base44 platform)

- Email/password sign-up still triggers Base44's OTP verification email
  (a 6-digit code, not an "invitation"). OAuth sign-in sends nothing.
- No server-side "create user / set password" API — an invitee must
  authenticate themselves.
- The password-reset email is Base44-branded; only its landing screen is ours.
