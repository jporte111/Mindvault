// MindVault Help — synonym expansion for product-help retrieval.
//
// The synonym map lets natural business phrasing match the curated corpus
// without embeddings / network / LLM. These tests pin its purity and its
// additive, gibberish-safe behavior; end-to-end topic retrieval through the
// expansion lives in help-product-retrieval.test.mjs.
//   node --test scripts/rag-eval/help-synonyms.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYNONYMS, expandSynonyms } from '../../src/lib/adminHelp/synonyms.js';
import { tokenize, scoreTopic } from '../../src/lib/adminHelp/retrieval.js';
import { ADMIN_HELP_TOPICS } from '../../src/lib/adminHelp/corpus.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('synonyms.js is pure data — no imports, no Base44/React/network/DOM/LLM', () => {
  const s = stripComments(read('src/lib/adminHelp/synonyms.js'));
  // "import" appears as a synonym KEY in the data — match only real module syntax.
  assert.doesNotMatch(s, /^\s*import\s|\brequire\(|\bfrom\s+['"]/m, 'no module imports');
  assert.doesNotMatch(s, /base44|fetch\(|XMLHttpRequest|WebSocket|document\.|window\.|localStorage/i);
  assert.doesNotMatch(s, /InvokeLLM|embedding|OpenAI|anthropic/i);
});

test('expandSynonyms is additive, deterministic, order-preserving and deduped', () => {
  // original tokens are always kept
  assert.deepEqual(expandSynonyms(['change', 'logo']), ['change', 'update', 'logo', 'branding']);
  // deterministic
  assert.deepEqual(expandSynonyms(['edit', 'business', 'name']), expandSynonyms(['edit', 'business', 'name']));
  // dedupe: two synonyms of the same canonical don't repeat it
  assert.deepEqual(expandSynonyms(['logo', 'colour']), ['logo', 'branding', 'colour']);
  // empty / nullish safe
  assert.deepEqual(expandSynonyms([]), []);
  assert.deepEqual(expandSynonyms(undefined), []);
});

test('a word with no synonym contributes nothing — gibberish stays gibberish', () => {
  assert.deepEqual(expandSynonyms(['xyzzy', 'flooble']), ['xyzzy', 'flooble']);
  // every canonical value must itself be a plain lowercase word (a real
  // corpus term), never a phrase or punctuation
  for (const [k, v] of Object.entries(SYNONYMS)) {
    assert.match(k, /^[a-z][a-z0-9]*$/, `synonym key "${k}" must be a single lowercase token`);
    assert.match(v, /^[a-z][a-z0-9]*$/, `synonym value "${v}" must be a single lowercase token`);
    assert.notEqual(k, v, `synonym "${k}" maps to itself`);
  }
});

test('gibberish still scores 0 against every topic even after expansion', () => {
  const words = tokenize('flibbertigibbet wockyjabber zorp');
  for (const t of ADMIN_HELP_TOPICS) {
    assert.equal(scoreTopic(t, words), 0, `"${t.id}" scored a gibberish query`);
  }
});
