// Phase 6 PERMANENT SAFETY INVARIANT — analyzeTraining never overwrites a
// served governed source in place, in EITHER feature-flag state. The decision
// is based on lifecycle / served STATE, not the flag.
//   node --test scripts/rag-eval/reanalysis-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { classifyReanalysisTarget } from '../../base44/shared/reanalysisGuard.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readFn = (p) => readFileSync(resolve(repo, p), 'utf8');
const analyze = readFn('base44/functions/analyzeTraining/entry.ts');
const guard = readFn('base44/shared/reanalysisGuard.ts');

// ======================================================================
// pure decision — the six required cases
// ======================================================================

test('active + classified (general) + has chunks -> served  (flag-independent)', () => {
  const base = { knowledge_scope: 'general', is_active_version: true };
  // verified
  assert.equal(classifyReanalysisTarget({ ...base, verification_status: 'verified' }, true).kind, 'served');
  // unverified-but-served
  assert.equal(classifyReanalysisTarget({ ...base, verification_status: 'unverified' }, true).kind, 'served');
  // verification_status missing (legacy default) + served
  assert.equal(classifyReanalysisTarget(base, true).kind, 'served');
  // client-specific too
  assert.equal(classifyReanalysisTarget({ knowledge_scope: 'client-specific', is_active_version: true }, true).kind, 'served');
  // is_active_version missing => treated active
  assert.equal(classifyReanalysisTarget({ knowledge_scope: 'general' }, true).kind, 'served');
});

test('active + classified + NO chunks -> legacy  (first-time onboarding preserved)', () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: 'general', is_active_version: true }, false).kind,
    'legacy',
  );
});

test('inactive draft -> draft  (in place allowed; not served)', () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: 'general', is_active_version: false }, true).kind,
    'draft',
  );
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: 'client-specific', is_active_version: false }, false).kind,
    'draft',
  );
});

test('never-classified / unclassified -> legacy  (existing behavior)', () => {
  assert.equal(classifyReanalysisTarget({ is_active_version: true }, false).kind, 'legacy');
  assert.equal(classifyReanalysisTarget({ knowledge_scope: 'unclassified', is_active_version: true }, true).kind, 'legacy');
});

test('archived / rejected inactive rows -> legacy  (no served chunks, not a live draft)', () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: 'general', is_active_version: false, is_archived: true }, true).kind,
    'legacy',
  );
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: 'general', is_active_version: false, verification_status: 'rejected' }, true).kind,
    'legacy',
  );
});

// ======================================================================
// the decision NEVER reads the feature flag
// ======================================================================

test('classifyReanalysisTarget is pure — it never reads the flag or AppConfig', () => {
  const code = guard.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  assert.equal(/AppConfig|asServiceRole|createClient|\.filter\(|source_lifecycle_enabled/.test(code), false,
    'the served/in-place decision must be based on lifecycle/served STATE only — no flag, no Base44 I/O');
  // signature takes (training, hasServedChunks) — no flag param
  assert.ok(/classifyReanalysisTarget\([^)]*hasServedChunks/.test(guard));
});

// ======================================================================
// analyzeTraining wiring — no flag-off in-place overwrite of a served source
// ======================================================================

test('analyzeTraining: the served-source guard precedes ANY content Training.update', () => {
  const guardIdx = analyze.indexOf('classifyReanalysisTarget(training');
  const passOneUpdate = analyze.search(/Training\.update\(trainingId,\s*\{\s*[\r\n\s]*summary:/);
  const pass2Update = analyze.indexOf('ai_knowledge_entry: pass2Data');
  assert.ok(guardIdx > 0, 'analyzeTraining must call classifyReanalysisTarget');
  assert.ok(passOneUpdate > guardIdx, 'Pass 1 content write must come AFTER the guard');
  assert.ok(pass2Update > guardIdx, 'Pass 2 content write must come AFTER the guard');
});

test("analyzeTraining: kind === 'served' returns 409 for BOTH flag states, no fallthrough", () => {
  assert.ok(/decision\.kind === ['"]served['"]/.test(analyze));
  assert.ok(/status:\s*409/.test(analyze));
  assert.ok(/['"]governed_source['"]/.test(analyze), 'flag ON error present');
  assert.ok(/['"]lifecycle_disabled['"]/.test(analyze), 'flag OFF error present');
  // the served branch RETURNS — it must not continue into Pass 1
  const servedBranch = analyze.slice(analyze.indexOf("decision.kind === 'served'"));
  const returnIdx = servedBranch.indexOf('return Response.json');
  const nextPassIdx = servedBranch.indexOf('Resolve source text');
  assert.ok(returnIdx > -1 && (nextPassIdx === -1 || returnIdx < nextPassIdx), 'served branch returns before analysis');
});

test('analyzeTraining: the flag is read ONLY inside the served-refusal branch (to phrase the error)', () => {
  const code = analyze.replace(/^\s*\/\/.*$/gm, ''); // ignore comments (one mentions the flag name)
  const servedIdx = code.indexOf("decision.kind === 'served'");
  // the ACTUAL code read of the flag
  const flagReadIdx = code.indexOf('?.source_lifecycle_enabled');
  assert.ok(servedIdx > -1);
  assert.ok(flagReadIdx > servedIdx, 'the flag is only consulted after kind === served');
  // exactly one code read of the flag
  assert.equal((code.match(/\?\.source_lifecycle_enabled/g) || []).length, 1);
});

test('analyzeTraining: NO code path falls back to legacy in-place analysis when the flag is off', () => {
  // there is no "if (!lifecycleOn) { ...analyze in place... }" and no comment
  // promising a legacy fallthrough
  assert.equal(/fall through to legacy behavior|treat(ed)? (as )?off.*fall through/i.test(analyze), false);
  assert.equal(/!\s*lifecycleOn|lifecycleOn\s*===\s*false|lifecycleOn\s*!==\s*true/.test(analyze), false);
});

test("analyzeTraining: the 'draft' branch re-pre-indexes via the engine (unconditional, no flag read)", () => {
  assert.ok(/isInactiveDraft\s*=\s*decision\.kind === ['"]draft['"]/.test(analyze));
  assert.ok(/if \(isInactiveDraft\)/.test(analyze));
  assert.ok(/buildDraftIndex\(/.test(analyze), 'draft branch must re-pre-index');
  // the re-pre-index block does not gate on the flag
  const draftBlock = analyze.slice(analyze.indexOf('if (isInactiveDraft)'));
  assert.equal(/source_lifecycle_enabled/.test(draftBlock.slice(0, 500)), false);
});

test('served-source signal is chunk existence, not the frontend-controlled status field', () => {
  assert.ok(/KnowledgeChunk\.filter\(\s*\{\s*training_id: trainingId\s*\}/.test(analyze));
  assert.ok(/hasServedChunks/.test(analyze));
  // unknown chunk query -> fail safe (treat as served)
  assert.ok(/hasServedChunks = true;\s*\/\/ unknown/.test(analyze));
});
