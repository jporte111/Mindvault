// Regression tests for the Fix 1 reliability wrapper around prose answer
// generation in askKnowledgeBaseV2 (base44/functions/askKnowledgeBaseV2/entry.ts).
//
// Runs the REAL handler under plain Node against a mocked SDK client — no
// Base44, no network, no Deno, no embeddings provider. The handler source is
// transformed at load time: the npm: SDK import becomes a test-controlled hook
// and Deno.serve(...) becomes a plain exported handler. All retrieval, scope,
// governance, and citation logic executed is the production code.
//
//   node scripts/rag-eval/prose-retry.test.mjs   (Node >= 22, type stripping)
//   // or via run.mjs; CI may precompile and point
//   // PROSE_RETRY_COMPILED_ENTRY at the compiled copy.
//
// Covers:
//   1. first prose generation fails -> retry succeeds with the identical
//      prompt/model/context; retrieval and understandQuery are NOT rerun
//   2. both attempts fail -> HTTP 200 safe fallback (never 500); client_context,
//      scope_notice, retrieval_mode and used_chunk_ids preserved
//   3. provider error text never reaches the employee response
//   4. retrieval (the KnowledgeChunk query) runs exactly once per request
//   5. retrieval_mode='lexical' performs zero embeddings/network calls even
//      when an embeddings key is configured

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../../base44/functions/askKnowledgeBaseV2/entry.ts');
const TMP = join(HERE, '.tmp-prose-retry');

// Deno shim BEFORE any module load: shared/embeddings.ts reads env at import
// time. An embeddings key is deliberately PRESENT so a lexical-mode leak (an
// embeddings fetch) would be recorded by the fetch guard instead of silently
// skipped.
globalThis.Deno = {
  env: { get: (k) => (k === 'EMBEDDINGS_API_KEY' ? 'test-key-present' : undefined) },
  serve() {},
};

// Any accidental network call (embeddings provider) is recorded and blocked.
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls++;
  return Promise.reject(new Error('test: network is blocked'));
};

async function loadHandler() {
  const raw = readFileSync(ENTRY, 'utf8');
  if (!raw.includes("stage: 'prose_generation'")) {
    throw new Error('Fix 1 prose-retry wrapper not found in entry.ts');
  }
  if (process.env.PROSE_RETRY_COMPILED_ENTRY) {
    const mod = await import(process.env.PROSE_RETRY_COMPILED_ENTRY);
    return mod.handler;
  }
  let src = raw;
  src = src
    .replace(
      "import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';",
      'const createClientFromRequest = (req) => globalThis.__mockSdk(req);',
    )
    .replace('Deno.serve(async (req) => {', 'export const handler = (async (req) => {')
    .replace(
      /from '(\.\.\/\.\.\/shared\/[a-zA-Z]+)\.ts';/g,
      (_m, p) => `from ${JSON.stringify(pathToFileURL(resolve(HERE, p + '.ts')).href)};`,
    );
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, 'entry.transformed.ts');
  writeFileSync(out, src);
  try {
    const mod = await import(pathToFileURL(out).href);
    return mod.handler;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

const handler = await loadHandler();

// --- Fixtures ---------------------------------------------------------------

const PROVIDER_ERROR = 'InvokeLLM upstream 500 (provider key sk-SECRET-1234)';

const FIXTURE_CHUNKS = [
  {
    id: 'chunk-1',
    training_id: 'training-1',
    chunk_index: 0,
    chunk_type: 'sop_step',
    title: 'Invoice filing',
    topic_category: 'Operations',
    knowledge_scope: 'general',
    client_id: null,
    content:
      'File invoices the same day they are received, before adding them to the active draw request.',
    content_hash: 'hash-1',
    keywords: ['invoice', 'filing', 'draw'],
  },
  {
    id: 'chunk-2',
    training_id: 'training-1',
    chunk_index: 1,
    chunk_type: 'sop_step',
    title: 'Invoice filing',
    topic_category: 'Operations',
    knowledge_scope: 'general',
    client_id: null,
    content:
      'After you file invoices in the vendor folder, add them to the draw request for internal review.',
    content_hash: 'hash-2',
    keywords: ['invoice', 'vendor', 'draw'],
  },
];

const PROSE_ANSWER =
  'Yes — file invoices before adding them to the draw request. [S1] Then add the invoice to the active draw and categorize it. [S2]';

function makeSdk({ proseFailures = 0, clientMention = null } = {}) {
  const state = { proseCalls: [], geminiCalls: 0, chunkQueries: 0 };
  const invoke = async (payload) => {
    if (payload.model === 'gemini_3_flash') {
      state.geminiCalls++;
      return {
        response: {
          standalone_query: 'should i save and file invoices before a draw request',
          search_queries: ['file invoices draw request'],
          intent: 'procedure',
          detected_client_mention: clientMention,
          requested_facets: [],
        },
      };
    }
    state.proseCalls.push({ model: payload.model, prompt: payload.prompt });
    if (state.proseCalls.length <= proseFailures) throw new Error(PROVIDER_ERROR);
    return PROSE_ANSWER;
  };
  const sdk = {
    auth: { me: async () => ({ id: 'user-1' }) },
    asServiceRole: {
      integrations: { Core: { InvokeLLM: invoke } },
      entities: {
        Client: { get: async (id) => ({ id, name: 'JLM' }) },
        AppConfig: {
          filter: async (q) =>
            q?.key === 'chat'
              ? [{ key: 'chat', chat_engine: 'rag', retrieval_mode: 'lexical' }]
              : [],
        },
        KnowledgeChunk: {
          filter: async () => {
            state.chunkQueries++;
            return FIXTURE_CHUNKS.map((c) => ({ ...c }));
          },
        },
      },
    },
  };
  globalThis.__mockSdk = () => sdk;
  return state;
}

function request(body) {
  return new Request('http://localhost/functions/askKnowledgeBaseV2', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const QUESTION = {
  question: 'should i save and file invoices before a draw request?',
  clientId: 'client-jlm',
};

async function withCapturedLogs(run) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const res = await run();
    return { res, lines };
  } finally {
    console.error = orig;
  }
}

const proseLogLines = (lines) =>
  lines
    .filter((l) => l.includes('prose_generation'))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))));

// --- Tests ------------------------------------------------------------------

test('first prose generation fails, retry succeeds with the identical prompt/model/context', async () => {
  const state = makeSdk({ proseFailures: 1 });
  const { res, lines } = await withCapturedLogs(() => handler(request(QUESTION)));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.answer, /\[S1\]/);
  assert.equal(body.confidence, 'high');
  assert.ok(body.sources.length >= 1);
  assert.equal(body.sources[0].id, 'training-1');

  // The retry used the exact same request — nothing upstream was rerun.
  assert.equal(state.proseCalls.length, 2);
  assert.equal(state.proseCalls[0].model, state.proseCalls[1].model);
  assert.equal(state.proseCalls[0].prompt, state.proseCalls[1].prompt);
  assert.equal(state.chunkQueries, 1, 'retrieval must not repeat on retry');
  assert.equal(state.geminiCalls, 1, 'understandQuery must not repeat on retry');
  assert.equal(body.retrieval_mode, 'lexical');

  // Exactly one failure log line, from the wrapper, with attempt 1.
  const logged = proseLogLines(lines);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].fn, 'askKnowledgeBaseV2');
  assert.equal(logged[0].stage, 'prose_generation');
  assert.equal(logged[0].attempt, 1);
  assert.equal(typeof logged[0].error, 'string');
});

test('both attempts fail -> HTTP 200 safe fallback, no provider text leak', async () => {
  const state = makeSdk({ proseFailures: 2, clientMention: 'Acme' });
  const { res, lines } = await withCapturedLogs(() => handler(request(QUESTION)));

  assert.equal(res.status, 200, 'must never surface HTTP 500 to the employee');
  const body = await res.json();
  assert.equal(body.confidence, 'low');
  assert.match(body.answer, /couldn't complete the answer/i);
  assert.ok(!JSON.stringify(body).includes('sk-SECRET-1234'), 'provider error text leaked');
  assert.ok(!body.answer.includes('upstream 500'), 'provider error text leaked');
  assert.deepEqual(body.sources, [], 'must not fabricate cited sources');
  assert.deepEqual(body.used_chunk_ids, ['chunk-1', 'chunk-2']);
  assert.deepEqual(body.client_context, { id: 'client-jlm', name: 'JLM' });
  assert.ok(body.scope_notice, 'scope_notice must be preserved');
  assert.equal(body.retrieval_mode, 'lexical');
  assert.equal(state.proseCalls.length, 2);

  // Both failures logged, attempts 1 and 2, redacted error only.
  const logged = proseLogLines(lines);
  assert.deepEqual(logged.map((l) => l.attempt).sort(), [1, 2]);
  for (const l of logged) {
    assert.equal(l.fn, 'askKnowledgeBaseV2');
    assert.equal(l.stage, 'prose_generation');
    assert.equal(typeof l.error, 'string');
  }
});

test("lexical mode performs zero embeddings/network calls even with a key configured", async () => {
  const state = makeSdk({ proseFailures: 0 });
  const res = await handler(request(QUESTION));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retrieval_mode, 'lexical');
  assert.equal(state.proseCalls.length, 1, 'no retry when generation succeeds');
  assert.equal(state.chunkQueries, 1);
  assert.equal(fetchCalls, 0, 'lexical mode must never call the embeddings provider');
});