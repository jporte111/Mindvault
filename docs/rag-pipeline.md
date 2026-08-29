# MindVault RAG retrieval pipeline

A parallel, retrieval-augmented chatbot backend (`askKnowledgeBaseV2`) that
replaces "stuff every training into one prompt" with semantic + lexical
retrieval, conversation awareness, a confidence gate, real citations, and
**hard per-client isolation**.

The legacy chatbot (`askKnowledgeBase`) is untouched and stays the production
default until you flip a runtime flag.

## How it fits together

```
Chat.jsx ──(AppConfig.chat_engine / rollout %)──▶ askKnowledgeBase      (legacy, default)
                                              └─▶ askKnowledgeBaseV2    (RAG)
                                                     │
                        query understanding (gemini_3_flash)
                        embed search queries ──▶ shared/embeddings.ts ──▶ external embeddings API
                        scoped $or fetch of KnowledgeChunk
                        shared/retrieval.ts: assertInScope → hybrid rank → dedupe → confidence
                        answer (claude_sonnet_4_6) grounded in retrieved chunks, [S#] citations

Training ──(classify: general | client-specific)──▶ embedKnowledge ──▶ KnowledgeChunk rows
```

New entities (all additive): `Client`, `KnowledgeChunk`, `AppConfig`. New
optional `Training` fields: `knowledge_scope` (default `unclassified`),
`client_id`, `client_name`, `is_eval_fixture`.

## Scope model — the security boundary

Every `Training` (and each `KnowledgeChunk` derived from it) has a
`knowledge_scope`:

| scope | retrievable when | set by |
|---|---|---|
| `unclassified` (default) | **never** | default for all legacy + new records |
| `general` | any chat context | a human deliberately marks it firm-wide |
| `client-specific` | only when the active `clientId` **exactly** equals `chunk.client_id` | a human picks a `Client` |

Hard rules enforced in `base44/shared/retrieval.ts` (`assertInScope`) and
covered by `scripts/rag-eval/retrieval.test.mjs`:

1. `general` is retrievable only after explicit classification — absence of a
   `client_id` never implies `general`.
2. `client-specific` needs an exact `client_id` match with the active context.
3. Scope comes **only** from the `clientId` argument. A client name mentioned
   in the question never changes or widens scope (it only produces a soft
   notice).
4. Weak results trigger the confidence gate — there is **no** fallback that
   searches other clients.
5. `unclassified` chunks are never fetched and are dropped by `assertInScope`
   even if they somehow appear.

## One-time setup (you do this — nothing here runs automatically)

1. **Embeddings secret.** In the Base44 dashboard (or `base44 secrets set`):
   - `EMBEDDINGS_API_KEY` — required.
   - `EMBEDDINGS_PROVIDER` — `voyage` (default) or `openai`.
   - `EMBEDDINGS_MODEL` — optional override (`voyage-3-large` /
     `text-embedding-3-small` are the defaults).
2. **Create `Client` records** — Admin → Content → Clients.
3. **Classify trainings** — Admin → Content → "Needs review". Each save sets
   the scope and indexes that one training. There is no bulk auto-classify.
   (A paginated `embedKnowledge({ all: true })` exists for re-indexing
   *already classified* records; run it yourself only if you want it.)
4. **Tune thresholds.** The confidence thresholds in `shared/retrieval.ts`
   (`THRESHOLDS`) depend on the embedding model's cosine scale. Run the eval
   (below) and adjust `lowIfSemBelow` / `lowIfFinalBelow` / `highIfFinalAbove`.
5. **Flip the engine** — Admin → Content → "Chatbot engine" → RAG, or ramp the
   canary %. Only after the test matrix passes and you approve.

## Rollback

Admin → Content → "Chatbot engine" → **Legacy**. Instant, no deploy. All schema
changes are additive with safe defaults, so reverting the branch also leaves
production identical to today.

## Running the evaluation

**Pure tests (no Base44 I/O):**

```
npm run rag-eval
```

Covers the scope gate, client-name-doesn't-widen, hybrid ranking, dedupe /
per-training cap, confidence gate, citation parsing — against in-memory
fixtures.

**Retrieval quality (read-only, against real indexed data):** call the
admin-only `ragEval` function with `{ cases: [...] }` built from
`scripts/rag-eval/cases.example.jsonl` (copy to `cases.jsonl`, expand to
30–50 real questions). It reports `recall_at_k`, `confidence_gate_accuracy`,
and `total_scope_violations` (**must be 0**). It never writes.

**Seeded client-isolation end-to-end test (WRITES to Base44 — needs your
approval):**

```
export BASE44_APP_ID=... BASE44_TOKEN=<admin token> [BASE44_APP_BASE_URL=...]
node scripts/rag-eval/seed-isolation.mjs --i-understand-this-writes-to-base44
#   ... run ragEval isolation cases with the printed client ids ...
node scripts/rag-eval/cleanup.mjs --i-understand-this-writes-to-base44
```

Prefer a non-production Base44 app. Every seeded row is `is_eval_fixture: true`
and `ZZ_RAGEVAL_`-prefixed; `cleanup.mjs` only ever deletes rows carrying that
marker.

## Test matrix to clear before switching production

Semantic retrieval · hybrid ranking · conversation context · confidence
thresholds · source citations · **client isolation** · unclassified exclusion ·
existing SOP ingestion unchanged · legacy-vs-V2 parity · latency & cost within
budget.
