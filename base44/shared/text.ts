// Shared text utilities for MindVault RAG chunking + indexing.
// Pure, no Base44 or network calls.

/** Rough token estimate. Good enough for chunk sizing (≈4 chars/token). */
export function approxTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/** Hex SHA-256 of a string, via Web Crypto (available in Deno + browsers). */
export async function contentHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Split long text into overlapping chunks on sentence-ish boundaries.
 * Sizes are in approximate tokens. Short text returns a single chunk.
 */
export function chunkText(
  text: string,
  { targetTokens = 600, overlapTokens = 90 }: { targetTokens?: number; overlapTokens?: number } = {},
): string[] {
  const clean = (text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (approxTokens(clean) <= targetTokens) return [clean];

  // Split into sentence-like pieces, keeping the delimiter.
  const pieces = clean.match(/[^.!?\n]+[.!?]*\n*|\n+/g) || [clean];
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur.length + piece.length > targetChars && cur.trim()) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlapChars));
    }
    cur += piece;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i if in into is it its of on or " +
    "that the their them then there these they this to was were what when where which who " +
    "will with you your our we do does did not can could should would may might must about " +
    "so no yes than too very just also more most such only own same each any all some other")
    .split(" "),
);

/**
 * Lowercased salient terms for the lexical half of hybrid search.
 * Frequency-ranked, stopword-filtered, de-duplicated.
 */
export function extractKeywords(text: string, max = 14): string[] {
  const counts = new Map<string, number>();
  for (const raw of (text || "").toLowerCase().match(/[a-z0-9][a-z0-9'+.-]*/g) || []) {
    const w = raw.replace(/^[.'-]+|[.'-]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}
