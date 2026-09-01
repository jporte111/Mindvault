// Regression tests for base44/shared/extraction.ts. No Base44, no network
// (resolveSourceText uses an injected mock fetch).
//   node --test scripts/rag-eval/extraction.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_PASS1_KEYS,
  LEGACY_PASS2_KEYS,
  STRATEGY_ENGINE_KEYS,
  FEATURE_OPPORTUNITY_KEYS,
  NEW_PASS1_KEYS,
  pass1JsonSchema,
  pass2JsonSchema,
  buildPass1Prompt,
  buildPass2Prompt,
  assessIngestionQuality,
  looksLikeHttpUrl,
  resolveSourceText,
} from '../../base44/shared/extraction.ts';

const p1 = Object.keys(pass1JsonSchema.properties);
const p2 = Object.keys(pass2JsonSchema.properties);
const featureProps = Object.keys(pass2JsonSchema.properties.app_feature_opportunities.items.properties);

const TYPE_GUIDANCE_MARKERS = [
  'This source is a policy.',
  'This source is a checklist.',
  'This source is a standard operating procedure document.',
  'This source is a process document.',
  'This source is reference material.',
];

// --- Schema / key-array regressions ---

test('every exported key array is duplicate-free', () => {
  for (const [name, keys] of Object.entries({
    LEGACY_PASS1_KEYS, LEGACY_PASS2_KEYS, STRATEGY_ENGINE_KEYS, FEATURE_OPPORTUNITY_KEYS, NEW_PASS1_KEYS,
  })) {
    assert.equal(new Set(keys).size, keys.length, `${name} has duplicates`);
  }
});

test('legacy pass 1 + pass 2 keys are all still in the schemas', () => {
  for (const k of LEGACY_PASS1_KEYS) assert.ok(p1.includes(k), `pass1 schema missing legacy key ${k}`);
  for (const k of LEGACY_PASS2_KEYS) assert.ok(p2.includes(k), `pass2 schema missing legacy key ${k}`);
});

test('Strategy Engine keys are all still produced', () => {
  const all = new Set([...p1, ...p2]);
  for (const k of STRATEGY_ENGINE_KEYS) assert.ok(all.has(k), `Strategy Engine key ${k} no longer produced`);
});

test('app_feature_opportunities item shape is exactly the Strategy Engine contract', () => {
  assert.deepEqual([...featureProps].sort(), [...FEATURE_OPPORTUNITY_KEYS].sort());
});

test('new operational keys are additive and disjoint from legacy', () => {
  for (const k of NEW_PASS1_KEYS) {
    assert.ok(p1.includes(k), `pass1 schema missing new key ${k}`);
    assert.ok(!LEGACY_PASS1_KEYS.includes(k), `${k} collides with a legacy key`);
  }
});

// --- Prompt builders ---

test('pass 1: undefined / recording / transcript keep transcript wording', () => {
  for (const st of [undefined, null, 'recording', 'transcript']) {
    const prompt = buildPass1Prompt({ sourceText: 'BODY', sourceType: st });
    assert.ok(prompt.includes('training transcript'), `sourceType=${st}`);
    assert.ok(!prompt.includes('This source is a'), `sourceType=${st} leaked type guidance`);
  }
});

test('pass 1: legacy_unspecified gets generic document behavior, not transcript, not a specific type', () => {
  const prompt = buildPass1Prompt({ sourceText: 'BODY', sourceType: 'legacy_unspecified' });
  assert.ok(prompt.includes('operational knowledge source'));
  assert.ok(!prompt.includes('training transcript'));
  // generic no-fabrication rule IS present for a non-recording source
  assert.ok(prompt.includes('do not invent a presenter or a duration'));
  // but NO source-type-specific guidance
  for (const marker of TYPE_GUIDANCE_MARKERS) {
    assert.ok(!prompt.includes(marker), `legacy_unspecified leaked "${marker}"`);
  }
});

test('pass 1: document types get type guidance + no fabricated metadata rule', () => {
  const prompt = buildPass1Prompt({ sourceText: 'BODY', sourceType: 'policy' });
  assert.ok(prompt.includes('operational knowledge source'));
  assert.ok(prompt.includes('This source is a policy.'));
  assert.ok(prompt.includes('do not invent a presenter or a duration'));
});

test('pass 2: source-type aware, contract intact, no legacy firm name', () => {
  const t = buildPass2Prompt({ sourceText: 'BODY' });
  const d = buildPass2Prompt({ sourceText: 'BODY', sourceType: 'sop' });
  assert.ok(t.includes('training transcript'));
  assert.ok(d.includes('operational knowledge source'));
  for (const s of [t, d]) {
    assert.ok(!s.includes('Hormozi'), 'legacy firm name still present');
    assert.ok(s.includes('app_feature_opportunities'));
    assert.ok(s.includes('priority_reason'));
  }
});

// --- assessIngestionQuality ---

test('ingestion quality: empty extraction -> needs_review', () => {
  assert.equal(assessIngestionQuality({}), 'needs_review');
  assert.equal(assessIngestionQuality({ sop_steps: ['only one step'] }), 'needs_review');
});

test('ingestion quality: real extraction -> ok', () => {
  assert.equal(
    assessIngestionQuality({ summary: 'A genuine multi-sentence summary of the process.', sop_steps: ['a', 'b', 'c'] }),
    'ok',
  );
});

// --- Source-text resolution (the URL vs raw-text regression) ---

const okFetch = (body) => async () => ({ ok: true, status: 200, text: async () => body });
const failFetch = (status) => async () => ({ ok: false, status, text: async () => '' });
const throwFetch = () => async () => { throw new Error('getaddrinfo ENOTFOUND'); };
let calls;
const spy = (impl) => (...a) => { calls++; return impl()(...a); };

test('resolve: transcript as a valid URL is fetched', async () => {
  calls = 0;
  const r = await resolveSourceText('https://files.example.com/t.txt', spy(() => okFetch('This is a sufficiently long transcript body.')));
  assert.deepEqual(r, { ok: true, text: 'This is a sufficiently long transcript body.' });
  assert.equal(calls, 1);
});

test('resolve: transcript as raw pasted text is used as-is, not fetched', async () => {
  calls = 0;
  const raw = 'Pasted SOP: 1. Do the first thing. 2. Do the second thing.';
  const r = await resolveSourceText(raw, spy(() => okFetch('SHOULD NOT BE USED')));
  assert.deepEqual(r, { ok: true, text: raw });
  assert.equal(calls, 0);
});

test('resolve: raw text that merely contains a URL is not fetched', async () => {
  calls = 0;
  const raw = 'See the policy at https://intra.example.com/policy and follow it carefully every month.';
  const r = await resolveSourceText(raw, spy(() => okFetch('X')));
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
  assert.equal(calls, 0);
});

test('resolve: only http/https is fetched — an ftp:// value is treated as raw text', async () => {
  calls = 0;
  const raw = 'ftp://legacy.example.com/archive/really-old-procedure-document-v3-final.txt';
  const r = await resolveSourceText(raw, spy(() => okFetch('SHOULD NOT BE USED')));
  assert.deepEqual(r, { ok: true, text: raw });
  assert.equal(calls, 0);
});

test('resolve: unreachable URL -> fetch_failed (no status write upstream)', async () => {
  const r = await resolveSourceText('https://nope.invalid/x.txt', throwFetch());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch_failed');
  assert.equal(r.status, 500);
});

test('resolve: URL returning 404 -> fetch_failed', async () => {
  const r = await resolveSourceText('https://files.example.com/missing.txt', failFetch(404));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fetch_failed');
});

test('resolve: empty / whitespace / missing -> no_source', async () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = await resolveSourceText(v, throwFetch());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_source');
    assert.equal(r.status, 400);
  }
});

test('resolve: HTML returned from a supposed text URL -> invalid_content', async () => {
  const r = await resolveSourceText('https://files.example.com/t.txt', okFetch('<!doctype html><html><body>Not text</body></html>'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_content');
  assert.equal(r.status, 400);
});

test('resolve: too-short raw text -> invalid_content', async () => {
  const r = await resolveSourceText('too short', throwFetch());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_content');
});

test('looksLikeHttpUrl: only whitespace-free http(s) URLs', () => {
  assert.equal(looksLikeHttpUrl('https://x.com/a.txt'), true);
  assert.equal(looksLikeHttpUrl('http://x'), true);
  assert.equal(looksLikeHttpUrl('  https://x.com/a  '), true); // outer trim is fine
  assert.equal(looksLikeHttpUrl('ftp://x/a'), false);
  assert.equal(looksLikeHttpUrl('not a url'), false);
  assert.equal(looksLikeHttpUrl('https://x.com/a b'), false); // internal whitespace
  assert.equal(looksLikeHttpUrl('text with https://x.com in it'), false);
  assert.equal(looksLikeHttpUrl(undefined), false);
});
