// Tests for base44/shared/redact.ts — the secret scrubber used by
// embedKnowledge diagnostics and the embeddings error messages.
//   node --test scripts/rag-eval/redact.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../base44/shared/redact.ts';

test('masks OpenAI-style keys (sk-, sk-proj-)', () => {
  const out = redact('Incorrect API key provided: sk-proj-abcDEF123456789ghiJKL. Check it.');
  assert.ok(!out.includes('sk-proj-abcDEF123456789ghiJKL'));
  assert.ok(out.includes('[REDACTED]'));
  assert.ok(out.includes('Incorrect API key provided'));
});

test('masks Voyage-style keys (pa-)', () => {
  const out = redact('auth failed for pa-0123456789abcdefABCDEF');
  assert.ok(!out.includes('pa-0123456789abcdefABCDEF'));
  assert.ok(out.includes('[REDACTED]'));
});

test('masks Bearer tokens and Authorization headers', () => {
  assert.ok(!redact('Authorization: Bearer sk-liveKEY_00112233445566').includes('sk-liveKEY_00112233445566'));
  assert.ok(!redact('{"authorization":"tok_9f8e7d6c5b4a3210zzzz"}').includes('tok_9f8e7d6c5b4a3210zzzz'));
});

test('masks key=value / "api_key": "value" shapes', () => {
  assert.ok(!redact('api_key=SECRETvalue123456').includes('SECRETvalue123456'));
  assert.ok(!redact('{"api_key": "SECRETvalue123456", "model": "x"}').includes('SECRETvalue123456'));
  // the surrounding structure survives
  assert.ok(redact('{"api_key": "SECRETvalue123456", "model": "x"}').includes('"model": "x"'));
});

test('leaves ordinary diagnostic text untouched', () => {
  const msg = 'Embeddings API 401 (provider=openai model=text-embedding-3-small): request failed';
  assert.equal(redact(msg), msg);
});

test('handles non-strings without throwing', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '42');
});
