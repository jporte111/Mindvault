// Stable pseudonymous reporter id for abuse-prevention + gap de-duplication.
//
// A keyed HMAC of the Base44 user id with a LONG-LIVED secret. Stable across
// sessions and days so `distinct_reporters` counts the same person
// consistently (a rotating salt would defeat the very counting it exists for).
// It is NOT a raw user id, is admin-hidden, and must never be exposed to
// employees.
//
// There is NO fallback / default secret: callers must pass a real
// GAP_HMAC_SECRET. If it is missing, the caller fails the write safely with a
// configuration error rather than hashing under a guessable key. When Phase 5
// feedback is disabled the secret is never needed.
//
// crypto.subtle is a global in both Deno and Node >= 16 — no import needed, so
// the eval harness can load this module directly.

export class MissingGapSecretError extends Error {
  constructor() {
    super("GAP_HMAC_SECRET is not configured");
    this.name = "MissingGapSecretError";
  }
}

export async function reporterHmac(userId: string, secret: string | null | undefined): Promise<string> {
  const s = typeof secret === "string" ? secret.trim() : "";
  if (!s) throw new MissingGapSecretError();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(s),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(userId || "")));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
