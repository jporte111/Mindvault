// Parity check for the source_type vocabulary, which is (temporarily)
// duplicated across three runtime boundaries. base44/entities/Training.jsonc is
// canonical; this test fails if the frontend picker or syncFromDrive drift.
//   node --test scripts/rag-eval/source-types.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SOURCE_TYPE_OPTIONS } from '../../src/lib/knowledgeSource.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Pull the quoted strings out of a bracketed array snippet.
const quotedStrings = (arrayBody) => (arrayBody.match(/"([^"]+)"|'([^']+)'/g) || [])
  .map((s) => s.slice(1, -1));

// Canonical: the `source_type.enum` block in Training.jsonc. Extract just that
// array rather than parsing the whole JSONC file (which may carry comments /
// trailing commas). Fail clearly if it cannot be located.
const trainingJsonc = readFileSync(resolve(repo, 'base44/entities/Training.jsonc'), 'utf8');
const enumMatch = trainingJsonc.match(/"source_type"\s*:\s*\{[\s\S]*?"enum"\s*:\s*\[([\s\S]*?)\]/);
if (!enumMatch) {
  assert.fail('Could not locate "source_type".enum in base44/entities/Training.jsonc');
}
const canonical = quotedStrings(enumMatch[1]);
assert.ok(canonical.length > 0, 'source_type.enum in Training.jsonc is empty');

// syncFromDrive's inline allow-list.
const syncSrc = readFileSync(resolve(repo, 'base44/functions/syncFromDrive/entry.ts'), 'utf8');
const m = syncSrc.match(/KNOWN_SOURCE_TYPES\s*=\s*\[([\s\S]*?)\]/);
if (!m) {
  assert.fail('Could not locate KNOWN_SOURCE_TYPES array in base44/functions/syncFromDrive/entry.ts');
}
const backendList = quotedStrings(m[1]);

const pickerValues = SOURCE_TYPE_OPTIONS.map((o) => o.value);

test('canonical enum has no duplicates and includes legacy_unspecified', () => {
  assert.equal(new Set(canonical).size, canonical.length);
  assert.ok(canonical.includes('legacy_unspecified'));
});

test('syncFromDrive KNOWN_SOURCE_TYPES matches the canonical enum exactly', () => {
  assert.deepEqual([...backendList].sort(), [...canonical].sort());
});

test('frontend picker = canonical enum minus legacy_unspecified', () => {
  assert.equal(new Set(pickerValues).size, pickerValues.length, 'picker has duplicate values');
  assert.ok(!pickerValues.includes('legacy_unspecified'), 'picker must not expose legacy_unspecified');
  assert.deepEqual(
    [...pickerValues].sort(),
    canonical.filter((v) => v !== 'legacy_unspecified').sort(),
  );
});

test('every picker option has a non-empty label', () => {
  for (const o of SOURCE_TYPE_OPTIONS) {
    assert.equal(typeof o.label, 'string');
    assert.ok(o.label.trim().length > 0, `empty label for ${o.value}`);
  }
});
