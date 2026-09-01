// Shared embeddings helper for MindVault RAG.
//
// Base44 bundles the entire base44/shared/ directory into every function
// deployment, so functions import this as "../../shared/embeddings.ts".
//
// Provider + key come from Base44 secrets (set in the dashboard or via
// `base44 secrets set`), read here with Deno.env.get:
//   EMBEDDINGS_PROVIDER  "voyage" (default) | "openai"
//   EMBEDDINGS_API_KEY   provider API key
//   EMBEDDINGS_MODEL     optional override of the default model name

type Provider = "voyage" | "openai";
export type EmbeddingInputType = "document" | "query";

const PROVIDER = ((Deno.env.get("EMBEDDINGS_PROVIDER") || "voyage").toLowerCase() as Provider);

const DEFAULT_MODEL: Record<Provider, string> = {
  voyage: "voyage-3-large",
  openai: "text-embedding-3-small",
};

const BATCH_SIZE = 96;
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

export function getEmbeddingModelName(): string {
  return Deno.env.get("EMBEDDINGS_MODEL") || DEFAULT_MODEL[PROVIDER];
}

function apiKey(): string {
  const key = Deno.env.get("EMBEDDINGS_API_KEY");
  if (!key) {
    throw new Error(
      "EMBEDDINGS_API_KEY is not set. Add it as a Base44 secret before using the RAG pipeline.",
    );
  }
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postWithRetry(url: string, body: unknown): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`Embeddings API ${res.status}: ${text.slice(0, 500)}`);
      }
      lastErr = new Error(`Embeddings API ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS - 1) break;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
  const model = getEmbeddingModelName();

  if (PROVIDER === "voyage") {
    const json = await postWithRetry("https://api.voyageai.com/v1/embeddings", {
      input: texts,
      model,
      input_type: inputType,
    });
    return (json.data as Array<{ embedding: number[]; index: number }>)
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  // openai
  const json = await postWithRetry("https://api.openai.com/v1/embeddings", {
    input: texts,
    model,
  });
  return (json.data as Array<{ embedding: number[]; index: number }>)
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Embed an array of texts. Batches internally and preserves input order.
 * Use inputType "document" when indexing and "query" when searching — Voyage
 * uses this to specialise the vector; OpenAI ignores it.
 */
export async function embed(
  texts: string[],
  inputType: EmbeddingInputType = "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    out.push(...(await embedBatch(batch, inputType)));
  }
  return out;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function l2normalize(a: number[]): number[] {
  const m = norm(a) || 1;
  return a.map((x) => x / m);
}

export function cosineSim(a: number[], b: number[]): number {
  const denom = (norm(a) || 1) * (norm(b) || 1);
  return dot(a, b) / denom;
}
