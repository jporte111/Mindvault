// Test helper (not a test: run.mjs only runs *.test.mjs). Loads a REAL
// Base44 function handler under plain Node with a mocked SDK:
//   * the npm: SDK import becomes globalThis.__mockSdk(req)
//   * Deno.serve(handler) / export default handler are both supported
//   * ../../shared/*.ts imports resolve against the function's directory
//   * extra import lines can be stubbed (e.g. base44:runtime, npm: libraries)
// No Base44, no network.

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

// `source` (optional) loads alternative source text AS IF it were
// base44/functions/<fn>/entry.ts (e.g. the base-branch version), without
// writing anything into base44/functions.
export async function loadHandler(fn, { stubs = {}, source = null } = {}) {
  const entry = resolve(REPO, `base44/functions/${fn}/entry.ts`);
  let src = source ?? readFileSync(entry, 'utf8');
  const sdkImport = /import \{ createClientFromRequest \} from 'npm:@base44\/sdk@[0-9.]+';/;
  if (!sdkImport.test(src)) throw new Error(`SDK import not found in ${fn}`);
  src = src.replace(sdkImport, 'const createClientFromRequest = (req) => globalThis.__mockSdk(req);');
  for (const [line, replacement] of Object.entries(stubs)) {
    if (!src.includes(line)) throw new Error(`${fn}: import to stub not found: ${line}`);
    src = src.replace(line, replacement);
  }
  src = src
    .replace('Deno.serve(async (req) => {', 'export const handler = (async (req) => {')
    .replace(/export default async function\s*\(/, 'export const handler = async function (')
    .replace(
      /from '(\.\.\/\.\.\/shared\/[a-zA-Z0-9/]+)\.ts';/g,
      (_m, p) => `from ${JSON.stringify(pathToFileURL(resolve(dirname(entry), p + '.ts')).href)};`,
    );
  const tmp = join(HERE, `.tmp-handler-${fn}-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'entry.transformed.ts');
  writeFileSync(out, src);
  try {
    return (await import(pathToFileURL(out).href)).handler;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const post = (handler, body) =>
  handler(new Request('http://test/fn', { method: 'POST', body: JSON.stringify(body ?? {}) }));
