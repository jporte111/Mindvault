// scripts/rag-eval/source-types.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// src/lib/knowledgeSource.js
var SOURCE_TYPE_OPTIONS = [
  { value: "recording", label: "Meeting or training session" },
  { value: "transcript", label: "Transcript" },
  { value: "sop", label: "SOP document" },
  { value: "process_doc", label: "Process document" },
  { value: "policy", label: "Policy" },
  { value: "checklist", label: "Checklist" },
  { value: "reference", label: "Reference document" },
  { value: "other", label: "Other" }
];
var SUPPORTED_UPLOAD_EXTENSIONS = [".txt", ".md", ".vtt", ".srt", ".docx"];
var SUPPORTED_UPLOAD_ACCEPT = SUPPORTED_UPLOAD_EXTENSIONS.join(",");

// scripts/rag-eval/source-types.test.mjs
var repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var quotedStrings = (arrayBody) => (arrayBody.match(/"([^"]+)"|'([^']+)'/g) || []).map((s) => s.slice(1, -1));
var trainingJsonc = readFileSync(resolve(repo, "base44/entities/Training.jsonc"), "utf8");
var enumMatch = trainingJsonc.match(/"source_type"\s*:\s*\{[\s\S]*?"enum"\s*:\s*\[([\s\S]*?)\]/);
if (!enumMatch) {
  assert.fail('Could not locate "source_type".enum in base44/entities/Training.jsonc');
}
var canonical = quotedStrings(enumMatch[1]);
assert.ok(canonical.length > 0, "source_type.enum in Training.jsonc is empty");
var syncSrc = readFileSync(resolve(repo, "base44/functions/syncFromDrive/entry.ts"), "utf8");
var m = syncSrc.match(/KNOWN_SOURCE_TYPES\s*=\s*\[([\s\S]*?)\]/);
if (!m) {
  assert.fail("Could not locate KNOWN_SOURCE_TYPES array in base44/functions/syncFromDrive/entry.ts");
}
var backendList = quotedStrings(m[1]);
var pickerValues = SOURCE_TYPE_OPTIONS.map((o) => o.value);
test("canonical enum has no duplicates and includes legacy_unspecified", () => {
  assert.equal(new Set(canonical).size, canonical.length);
  assert.ok(canonical.includes("legacy_unspecified"));
});
test("syncFromDrive KNOWN_SOURCE_TYPES matches the canonical enum exactly", () => {
  assert.deepEqual([...backendList].sort(), [...canonical].sort());
});
test("frontend picker = canonical enum minus legacy_unspecified", () => {
  assert.equal(new Set(pickerValues).size, pickerValues.length, "picker has duplicate values");
  assert.ok(!pickerValues.includes("legacy_unspecified"), "picker must not expose legacy_unspecified");
  assert.deepEqual(
    [...pickerValues].sort(),
    canonical.filter((v) => v !== "legacy_unspecified").sort()
  );
});
test("every picker option has a non-empty label", () => {
  for (const o of SOURCE_TYPE_OPTIONS) {
    assert.equal(typeof o.label, "string");
    assert.ok(o.label.trim().length > 0, `empty label for ${o.value}`);
  }
});
