// scripts/rag-eval/redact.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/redact.ts
var PATTERNS = [
  // Provider API keys: OpenAI (sk-..., sk-proj-...), Voyage (pa-...), generic.
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bpa-[A-Za-z0-9_-]{8,}\b/g,
  // "Bearer <token>" / "Authorization: <token>"
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAuthorization"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}/gi,
  // key/token/secret/api_key = <value> (JSON or querystring style)
  /("?(?:api[_-]?key|apikey|access[_-]?token|token|secret|password)"?\s*[:=]\s*"?)[^"\s,&}]{6,}/gi
];
function redact(input) {
  let s = typeof input === "string" ? input : String(input ?? "");
  for (const re of PATTERNS) {
    s = s.replace(re, (m, p1) => p1 ? `${p1}[REDACTED]` : "[REDACTED]");
  }
  return s;
}

// scripts/rag-eval/redact.test.mjs
test("masks OpenAI-style keys (sk-, sk-proj-)", () => {
  const out = redact("Incorrect API key provided: sk-proj-abcDEF123456789ghiJKL. Check it.");
  assert.ok(!out.includes("sk-proj-abcDEF123456789ghiJKL"));
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(out.includes("Incorrect API key provided"));
});
test("masks Voyage-style keys (pa-)", () => {
  const out = redact("auth failed for pa-0123456789abcdefABCDEF");
  assert.ok(!out.includes("pa-0123456789abcdefABCDEF"));
  assert.ok(out.includes("[REDACTED]"));
});
test("masks Bearer tokens and Authorization headers", () => {
  assert.ok(!redact("Authorization: Bearer sk-liveKEY_00112233445566").includes("sk-liveKEY_00112233445566"));
  assert.ok(!redact('{"authorization":"tok_9f8e7d6c5b4a3210zzzz"}').includes("tok_9f8e7d6c5b4a3210zzzz"));
});
test('masks key=value / "api_key": "value" shapes', () => {
  assert.ok(!redact("api_key=SECRETvalue123456").includes("SECRETvalue123456"));
  assert.ok(!redact('{"api_key": "SECRETvalue123456", "model": "x"}').includes("SECRETvalue123456"));
  assert.ok(redact('{"api_key": "SECRETvalue123456", "model": "x"}').includes('"model": "x"'));
});
test("leaves ordinary diagnostic text untouched", () => {
  const msg = "Embeddings API 401 (provider=openai model=text-embedding-3-small): request failed";
  assert.equal(redact(msg), msg);
});
test("scrubs a realistic OpenAI 401 body", () => {
  const body = JSON.stringify({
    error: {
      message: "Incorrect API key provided: sk-proj-AAAABBBBCCCCDDDDEEEEFFFF00001111. You can find your API key at https://platform.openai.com/account/api-keys.",
      type: "invalid_request_error",
      param: null,
      code: "invalid_api_key"
    }
  });
  const out = redact(`Embeddings API 401: ${body}`);
  assert.ok(!out.includes("sk-proj-AAAABBBBCCCCDDDDEEEEFFFF00001111"));
  assert.ok(out.includes("invalid_api_key"));
});
test("scrubs a realistic Voyage 401 body", () => {
  const body = JSON.stringify({ detail: "Provided API key pa-abcDEF0123456789ghiJKLmnop is invalid." });
  const out = redact(`Embeddings API 401: ${body}`);
  assert.ok(!out.includes("pa-abcDEF0123456789ghiJKLmnop"));
});
test("scrubs a key accidentally pasted into EMBEDDINGS_PROVIDER", () => {
  const msg = 'EMBEDDINGS_PROVIDER "sk-proj-LEAKED9999888877776666" is not supported \u2014 use "voyage" or "openai".';
  const out = redact(msg);
  assert.ok(!out.includes("sk-proj-LEAKED9999888877776666"));
  assert.ok(out.includes("is not supported"));
});
test("handles non-strings without throwing", () => {
  assert.equal(redact(void 0), "");
  assert.equal(redact(null), "");
  assert.equal(redact(42), "42");
});
