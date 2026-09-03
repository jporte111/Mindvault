// scripts/rag-eval/reanalysis-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// base44/shared/reanalysisGuard.ts
function classifyReanalysisTarget(t, hasServedChunks) {
  const scope = t.knowledge_scope || "unclassified";
  const isClassified = scope === "general" || scope === "client-specific";
  const isActive = t.is_active_version !== false;
  if (isClassified && isActive && hasServedChunks) return { kind: "served" };
  if (!isActive && t.is_archived !== true && t.verification_status !== "rejected") {
    return { kind: "draft" };
  }
  return { kind: "legacy" };
}

// scripts/rag-eval/reanalysis-guard.test.mjs
var repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var readFn = (p) => readFileSync(resolve(repo, p), "utf8");
var analyze = readFn("base44/functions/analyzeTraining/entry.ts");
var guard = readFn("base44/shared/reanalysisGuard.ts");
test("active + classified (general) + has chunks -> served  (flag-independent)", () => {
  const base = { knowledge_scope: "general", is_active_version: true };
  assert.equal(classifyReanalysisTarget({ ...base, verification_status: "verified" }, true).kind, "served");
  assert.equal(classifyReanalysisTarget({ ...base, verification_status: "unverified" }, true).kind, "served");
  assert.equal(classifyReanalysisTarget(base, true).kind, "served");
  assert.equal(classifyReanalysisTarget({ knowledge_scope: "client-specific", is_active_version: true }, true).kind, "served");
  assert.equal(classifyReanalysisTarget({ knowledge_scope: "general" }, true).kind, "served");
});
test("active + classified + NO chunks -> legacy  (first-time onboarding preserved)", () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: "general", is_active_version: true }, false).kind,
    "legacy"
  );
});
test("inactive draft -> draft  (in place allowed; not served)", () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: "general", is_active_version: false }, true).kind,
    "draft"
  );
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: "client-specific", is_active_version: false }, false).kind,
    "draft"
  );
});
test("never-classified / unclassified -> legacy  (existing behavior)", () => {
  assert.equal(classifyReanalysisTarget({ is_active_version: true }, false).kind, "legacy");
  assert.equal(classifyReanalysisTarget({ knowledge_scope: "unclassified", is_active_version: true }, true).kind, "legacy");
});
test("archived / rejected inactive rows -> legacy  (no served chunks, not a live draft)", () => {
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: "general", is_active_version: false, is_archived: true }, true).kind,
    "legacy"
  );
  assert.equal(
    classifyReanalysisTarget({ knowledge_scope: "general", is_active_version: false, verification_status: "rejected" }, true).kind,
    "legacy"
  );
});
test("classifyReanalysisTarget is pure \u2014 it never reads the flag or AppConfig", () => {
  const code = guard.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(
    /AppConfig|asServiceRole|createClient|\.filter\(|source_lifecycle_enabled/.test(code),
    false,
    "the served/in-place decision must be based on lifecycle/served STATE only \u2014 no flag, no Base44 I/O"
  );
  assert.ok(/classifyReanalysisTarget\([^)]*hasServedChunks/.test(guard));
});
test("analyzeTraining: the served-source guard precedes ANY content Training.update", () => {
  const guardIdx = analyze.indexOf("classifyReanalysisTarget(training");
  const passOneUpdate = analyze.search(/Training\.update\(trainingId,\s*\{\s*[\r\n\s]*summary:/);
  const pass2Update = analyze.indexOf("ai_knowledge_entry: pass2Data");
  assert.ok(guardIdx > 0, "analyzeTraining must call classifyReanalysisTarget");
  assert.ok(passOneUpdate > guardIdx, "Pass 1 content write must come AFTER the guard");
  assert.ok(pass2Update > guardIdx, "Pass 2 content write must come AFTER the guard");
});
test("analyzeTraining: kind === 'served' returns 409 for BOTH flag states, no fallthrough", () => {
  assert.ok(/decision\.kind === ['"]served['"]/.test(analyze));
  assert.ok(/status:\s*409/.test(analyze));
  assert.ok(/['"]governed_source['"]/.test(analyze), "flag ON error present");
  assert.ok(/['"]lifecycle_disabled['"]/.test(analyze), "flag OFF error present");
  const servedBranch = analyze.slice(analyze.indexOf("decision.kind === 'served'"));
  const returnIdx = servedBranch.indexOf("return Response.json");
  const nextPassIdx = servedBranch.indexOf("Resolve source text");
  assert.ok(returnIdx > -1 && (nextPassIdx === -1 || returnIdx < nextPassIdx), "served branch returns before analysis");
});
test("analyzeTraining: the flag is read ONLY inside the served-refusal branch (to phrase the error)", () => {
  const code = analyze.replace(/^\s*\/\/.*$/gm, "");
  const servedIdx = code.indexOf("decision.kind === 'served'");
  const flagReadIdx = code.indexOf("?.source_lifecycle_enabled");
  assert.ok(servedIdx > -1);
  assert.ok(flagReadIdx > servedIdx, "the flag is only consulted after kind === served");
  assert.equal((code.match(/\?\.source_lifecycle_enabled/g) || []).length, 1);
});
test("analyzeTraining: NO code path falls back to legacy in-place analysis when the flag is off", () => {
  assert.equal(/fall through to legacy behavior|treat(ed)? (as )?off.*fall through/i.test(analyze), false);
  assert.equal(/!\s*lifecycleOn|lifecycleOn\s*===\s*false|lifecycleOn\s*!==\s*true/.test(analyze), false);
});
test("analyzeTraining: the 'draft' branch re-pre-indexes via the engine (unconditional, no flag read)", () => {
  assert.ok(/isInactiveDraft\s*=\s*decision\.kind === ['"]draft['"]/.test(analyze));
  assert.ok(/if \(isInactiveDraft\)/.test(analyze));
  assert.ok(/buildDraftIndex\(/.test(analyze), "draft branch must re-pre-index");
  const draftBlock = analyze.slice(analyze.indexOf("if (isInactiveDraft)"));
  assert.equal(/source_lifecycle_enabled/.test(draftBlock.slice(0, 500)), false);
});
test("served-source signal is chunk existence, not the frontend-controlled status field", () => {
  assert.ok(/KnowledgeChunk\.filter\(\s*\{\s*training_id: trainingId\s*\}/.test(analyze));
  assert.ok(/hasServedChunks/.test(analyze));
  assert.ok(/hasServedChunks = true;\s*\/\/ unknown/.test(analyze));
});
