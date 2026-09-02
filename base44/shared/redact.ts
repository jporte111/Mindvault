// Redact secrets / bearer tokens from strings before logging or returning them.
// Pure — no Base44 / network / Deno APIs, so it is unit-testable under Node.
//
// Used by diagnostic logging in embedKnowledge and by the embeddings helper's
// error messages so a provider response that echoes a key fragment never lands
// in logs or an HTTP body.

const PATTERNS: RegExp[] = [
  // Provider API keys: OpenAI (sk-..., sk-proj-...), Voyage (pa-...), generic.
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bpa-[A-Za-z0-9_-]{8,}\b/g,
  // "Bearer <token>" / "Authorization: <token>"
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAuthorization"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}/gi,
  // key/token/secret/api_key = <value> (JSON or querystring style)
  /("?(?:api[_-]?key|apikey|access[_-]?token|token|secret|password)"?\s*[:=]\s*"?)[^"\s,&}]{6,}/gi,
];

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  for (const re of PATTERNS) {
    s = s.replace(re, (m, p1) => (p1 ? `${p1}[REDACTED]` : '[REDACTED]'));
  }
  return s;
}
