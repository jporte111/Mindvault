// scripts/rag-eval/prose-retry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
var HERE = dirname(fileURLToPath(import.meta.url));
var ENTRY = resolve(HERE, "../../base44/functions/askKnowledgeBaseV2/entry.ts");
var ENTRY_DIR = dirname(ENTRY);
var TMP = join(HERE, ".tmp-prose-retry");
globalThis.Deno = {
  env: { get: (k) => k === "EMBEDDINGS_API_KEY" ? "test-key-present" : void 0 },
  serve() {
  }
};
var fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls++;
  return Promise.reject(new Error("test: network is blocked"));
};
async function loadHandler() {
  const raw = readFileSync(ENTRY, "utf8");
  if (!raw.includes("stage: 'prose_generation'")) {
    throw new Error("Fix 1 prose-retry wrapper not found in entry.ts");
  }
  if (process.env.PROSE_RETRY_COMPILED_ENTRY) {
    const mod = await import(process.env.PROSE_RETRY_COMPILED_ENTRY);
    return mod.handler;
  }
  let src = raw;
  src = src.replace(
    "import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';",
    "const createClientFromRequest = (req) => globalThis.__mockSdk(req);"
  ).replace("Deno.serve(async (req) => {", "export const handler = (async (req) => {").replace(
    /from '(\.\.\/\.\.\/shared\/[a-zA-Z0-9]+)\.ts';/g,
    (_m, p) => `from ${JSON.stringify(pathToFileURL(resolve(ENTRY_DIR, p + ".ts")).href)};`
  );
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, "entry.transformed.ts");
  writeFileSync(out, src);
  try {
    const mod = await import(pathToFileURL(out).href);
    return mod.handler;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}
var handler = await loadHandler();
var PROVIDER_ERROR = "InvokeLLM upstream 500 (provider key sk-SECRET-1234)";
var FIXTURE_CHUNKS = [
  {
    id: "chunk-1",
    training_id: "training-1",
    chunk_index: 0,
    chunk_type: "sop_step",
    title: "Invoice filing",
    topic_category: "Operations",
    knowledge_scope: "general",
    client_id: null,
    content: "File invoices the same day they are received, before adding them to the active draw request.",
    content_hash: "hash-1",
    keywords: ["invoice", "filing", "draw"]
  },
  {
    id: "chunk-2",
    training_id: "training-1",
    chunk_index: 1,
    chunk_type: "sop_step",
    title: "Invoice filing",
    topic_category: "Operations",
    knowledge_scope: "general",
    client_id: null,
    content: "After you file invoices in the vendor folder, add them to the draw request for internal review.",
    content_hash: "hash-2",
    keywords: ["invoice", "vendor", "draw"]
  }
];
var PROSE_ANSWER = "Yes \u2014 file invoices before adding them to the draw request. [S1] Then add the invoice to the active draw and categorize it. [S2]";
function makeSdk({ proseFailures = 0, clientMention = null } = {}) {
  const state = { proseCalls: [], geminiCalls: 0, chunkQueries: 0 };
  const invoke = async (payload) => {
    if (payload.model === "gemini_3_flash") {
      state.geminiCalls++;
      return {
        response: {
          standalone_query: "should i save and file invoices before a draw request",
          search_queries: ["file invoices draw request"],
          intent: "procedure",
          detected_client_mention: clientMention,
          requested_facets: []
        }
      };
    }
    state.proseCalls.push({ model: payload.model, prompt: payload.prompt });
    if (state.proseCalls.length <= proseFailures) throw new Error(PROVIDER_ERROR);
    return PROSE_ANSWER;
  };
  const sdk = {
    auth: { me: async () => ({ id: "user-1" }) },
    asServiceRole: {
      integrations: { Core: { InvokeLLM: invoke } },
      entities: {
        Client: { get: async (id) => ({ id, name: "JLM" }) },
        AppConfig: {
          filter: async (q) => q?.key === "chat" ? [{ key: "chat", chat_engine: "rag", retrieval_mode: "lexical" }] : []
        },
        KnowledgeChunk: {
          filter: async () => {
            state.chunkQueries++;
            return FIXTURE_CHUNKS.map((c) => ({ ...c }));
          }
        }
      }
    }
  };
  globalThis.__mockSdk = () => sdk;
  return state;
}
function request(body) {
  return new Request("http://localhost/functions/askKnowledgeBaseV2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
var QUESTION = {
  question: "should i save and file invoices before a draw request?",
  clientId: "client-jlm"
};
async function withCapturedLogs(run) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const res = await run();
    return { res, lines };
  } finally {
    console.error = orig;
  }
}
var proseLogLines = (lines) => lines.filter((l) => l.includes("prose_generation")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
test("first prose generation fails, retry succeeds with the identical prompt/model/context", async () => {
  const state = makeSdk({ proseFailures: 1 });
  const { res, lines } = await withCapturedLogs(() => handler(request(QUESTION)));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.answer, /\[S1\]/);
  assert.equal(body.confidence, "high");
  assert.ok(body.sources.length >= 1);
  assert.equal(body.sources[0].id, "training-1");
  assert.equal(state.proseCalls.length, 2);
  assert.equal(state.proseCalls[0].model, state.proseCalls[1].model);
  assert.equal(state.proseCalls[0].prompt, state.proseCalls[1].prompt);
  assert.equal(state.chunkQueries, 1, "retrieval must not repeat on retry");
  assert.equal(state.geminiCalls, 1, "understandQuery must not repeat on retry");
  assert.equal(body.retrieval_mode, "lexical");
  const logged = proseLogLines(lines);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].fn, "askKnowledgeBaseV2");
  assert.equal(logged[0].stage, "prose_generation");
  assert.equal(logged[0].attempt, 1);
  assert.equal(typeof logged[0].error, "string");
});
test("both attempts fail -> HTTP 200 safe fallback, no provider text leak", async () => {
  const state = makeSdk({ proseFailures: 2, clientMention: "Acme" });
  const { res, lines } = await withCapturedLogs(() => handler(request(QUESTION)));
  assert.equal(res.status, 200, "must never surface HTTP 500 to the employee");
  const body = await res.json();
  assert.equal(body.confidence, "low");
  assert.match(body.answer, /couldn't complete the answer/i);
  assert.ok(!JSON.stringify(body).includes("sk-SECRET-1234"), "provider error text leaked");
  assert.ok(!body.answer.includes("upstream 500"), "provider error text leaked");
  assert.deepEqual(body.sources, [], "must not fabricate cited sources");
  assert.deepEqual(body.used_chunk_ids, ["chunk-1", "chunk-2"]);
  assert.deepEqual(body.client_context, { id: "client-jlm", name: "JLM" });
  assert.ok(body.scope_notice, "scope_notice must be preserved");
  assert.equal(body.retrieval_mode, "lexical");
  assert.equal(state.proseCalls.length, 2);
  const logged = proseLogLines(lines);
  assert.deepEqual(logged.map((l) => l.attempt).sort(), [1, 2]);
  for (const l of logged) {
    assert.equal(l.fn, "askKnowledgeBaseV2");
    assert.equal(l.stage, "prose_generation");
    assert.equal(typeof l.error, "string");
  }
});
test("lexical mode performs zero embeddings/network calls even with a key configured", async () => {
  const state = makeSdk({ proseFailures: 0 });
  const res = await handler(request(QUESTION));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retrieval_mode, "lexical");
  assert.equal(state.proseCalls.length, 1, "no retry when generation succeeds");
  assert.equal(state.chunkQueries, 1);
  assert.equal(fetchCalls, 0, "lexical mode must never call the embeddings provider");
});
