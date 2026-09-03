// scripts/rag-eval/operational-process.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// src/lib/operationalProcess.js
var SCOPE_UNCLASSIFIED = "unclassified";
var SCOPE_GENERAL = "general";
var CLIENT_PREFIX = "client:";
var PROCESS_CRITICALITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "mission_critical", label: "Mission critical" }
];
var CRITICALITY_LABEL = Object.fromEntries(
  PROCESS_CRITICALITY_OPTIONS.map((o) => [o.value, o.label])
);
var PROCESS_FRESHNESS_VALUES = ["unreviewed", "current", "due_soon", "stale", "review_requested"];
function processFreshness(process) {
  return process?.freshness_status || "unreviewed";
}
function processScopeValue(process) {
  if (!process) return SCOPE_UNCLASSIFIED;
  if (process.knowledge_scope === "client-specific" && process.client_id) {
    return CLIENT_PREFIX + process.client_id;
  }
  if (process.knowledge_scope === SCOPE_GENERAL) return SCOPE_GENERAL;
  return SCOPE_UNCLASSIFIED;
}
function isProcessScopeCompatible(source, process) {
  const s = source?.knowledge_scope || "unclassified";
  const p = process?.knowledge_scope || "unclassified";
  if (s !== p) return false;
  if (s === "client-specific") {
    return Boolean(source?.client_id) && source.client_id === process?.client_id;
  }
  return true;
}
function resolveProcessScopeFields(value) {
  if (value === SCOPE_GENERAL) {
    return { knowledge_scope: "general", client_id: null };
  }
  if (typeof value === "string" && value.startsWith(CLIENT_PREFIX)) {
    return { knowledge_scope: "client-specific", client_id: value.slice(CLIENT_PREFIX.length) };
  }
  return { knowledge_scope: "unclassified", client_id: null };
}

// base44/shared/processAccess.ts
function visibleProcesses(user, processes) {
  if (!user) return [];
  if (user.role === "admin") return processes;
  return (processes || []).filter((p) => p?.knowledge_scope === "general");
}

// scripts/rag-eval/operational-process.test.mjs
var repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var jsonc = readFileSync(resolve(repo, "base44/entities/OperationalProcess.jsonc"), "utf8");
var schema = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ""));
var props = schema.properties;
test("OperationalProcess entity parses and has the expected shape", () => {
  assert.equal(schema.name, "OperationalProcess");
  assert.deepEqual(schema.required, ["name"]);
  assert.equal(props.name.minLength, 1);
  assert.equal(props.review_interval_days.minimum, 1);
});
test("knowledge_scope defaults to unclassified, never general", () => {
  assert.equal(props.knowledge_scope.default, "unclassified");
  assert.deepEqual(props.knowledge_scope.enum, ["unclassified", "general", "client-specific"]);
});
test("freshness_status is unreviewed-first and has no archived value", () => {
  assert.deepEqual(props.freshness_status.enum, ["unreviewed", "current", "due_soon", "stale", "review_requested"]);
  assert.ok(!props.freshness_status.enum.includes("archived"));
});
test("archival lives only on the status field", () => {
  assert.deepEqual(props.status.enum, ["active", "archived"]);
  assert.equal(props.status.default, "active");
});
test("criticality enum matches the four documented levels", () => {
  assert.deepEqual(props.criticality.enum, ["low", "medium", "high", "mission_critical"]);
});
test("entity RLS restricts EVERY operation (incl. read) to admins", () => {
  assert.ok(schema.rls, "no rls block on OperationalProcess");
  for (const op of ["create", "read", "update", "delete"]) {
    assert.deepEqual(schema.rls[op], { user_condition: { role: "admin" } }, `${op} not admin-gated`);
  }
});
test("PROCESS_FRESHNESS_VALUES matches the entity enum exactly", () => {
  assert.deepEqual([...PROCESS_FRESHNESS_VALUES], [...props.freshness_status.enum]);
});
test("PROCESS_CRITICALITY_OPTIONS values match the entity enum", () => {
  assert.deepEqual(PROCESS_CRITICALITY_OPTIONS.map((o) => o.value), props.criticality.enum);
  for (const o of PROCESS_CRITICALITY_OPTIONS) assert.ok(o.label && o.label.trim());
});
test("inlined scope constants mirror src/lib/knowledgeScope.js", () => {
  const ks = readFileSync(resolve(repo, "src/lib/knowledgeScope.js"), "utf8");
  const grab = (name) => ks.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1];
  assert.equal(SCOPE_UNCLASSIFIED, grab("SCOPE_UNCLASSIFIED"));
  assert.equal(SCOPE_GENERAL, grab("SCOPE_GENERAL"));
  assert.equal(CLIENT_PREFIX, grab("CLIENT_PREFIX"));
});
test("processFreshness treats missing as unreviewed", () => {
  assert.equal(processFreshness(null), "unreviewed");
  assert.equal(processFreshness({}), "unreviewed");
  assert.equal(processFreshness({ freshness_status: "stale" }), "stale");
});
test("processScopeValue round-trips scope", () => {
  assert.equal(processScopeValue(null), "unclassified");
  assert.equal(processScopeValue({ knowledge_scope: "general" }), "general");
  assert.equal(processScopeValue({ knowledge_scope: "client-specific", client_id: "c1" }), "client:c1");
  assert.equal(processScopeValue({ knowledge_scope: "client-specific" }), "unclassified");
});
test("resolveProcessScopeFields maps UI value -> stored fields (no client_name)", () => {
  assert.deepEqual(resolveProcessScopeFields("general"), { knowledge_scope: "general", client_id: null });
  assert.deepEqual(resolveProcessScopeFields("client:abc"), { knowledge_scope: "client-specific", client_id: "abc" });
  assert.deepEqual(resolveProcessScopeFields("unclassified"), { knowledge_scope: "unclassified", client_id: null });
  assert.deepEqual(resolveProcessScopeFields(""), { knowledge_scope: "unclassified", client_id: null });
});
test("isProcessScopeCompatible: same scope required", () => {
  const u = { knowledge_scope: "unclassified" };
  const g = { knowledge_scope: "general" };
  assert.equal(isProcessScopeCompatible(u, { knowledge_scope: "unclassified" }), true);
  assert.equal(isProcessScopeCompatible(u, { knowledge_scope: "general" }), false);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: "general" }), true);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: "unclassified" }), false);
  assert.equal(isProcessScopeCompatible(g, { knowledge_scope: "client-specific", client_id: "c1" }), false);
});
test("isProcessScopeCompatible: client-specific needs exact same client_id", () => {
  const src = { knowledge_scope: "client-specific", client_id: "c1" };
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: "client-specific", client_id: "c1" }), true);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: "client-specific", client_id: "c2" }), false);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: "client-specific" }), false);
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: "general" }), false);
});
test("isProcessScopeCompatible: client-specific source missing its own client_id never matches", () => {
  const src = { knowledge_scope: "client-specific" };
  assert.equal(isProcessScopeCompatible(src, { knowledge_scope: "client-specific", client_id: "c1" }), false);
});
test("isProcessScopeCompatible: missing knowledge_scope treated as unclassified on both sides", () => {
  assert.equal(isProcessScopeCompatible({}, {}), true);
  assert.equal(isProcessScopeCompatible({}, { knowledge_scope: "general" }), false);
  assert.equal(isProcessScopeCompatible(void 0, { knowledge_scope: "unclassified" }), true);
});
var SAMPLE = [
  { id: "g1", knowledge_scope: "general" },
  { id: "g2", knowledge_scope: "general", status: "archived" },
  { id: "c1", knowledge_scope: "client-specific", client_id: "acme" },
  { id: "c2", knowledge_scope: "client-specific", client_id: "beta" },
  { id: "u1", knowledge_scope: "unclassified" },
  { id: "x1" }
];
test("visibleProcesses: no user -> nothing", () => {
  assert.deepEqual(visibleProcesses(null, SAMPLE), []);
  assert.deepEqual(visibleProcesses(void 0, SAMPLE), []);
});
test("visibleProcesses: admin -> everything", () => {
  assert.deepEqual(visibleProcesses({ role: "admin" }, SAMPLE), SAMPLE);
});
test("visibleProcesses: non-admin -> ONLY organization-wide (general)", () => {
  const seen = visibleProcesses({ role: "user" }, SAMPLE).map((p) => p.id);
  assert.deepEqual(seen, ["g1", "g2"]);
});
test("visibleProcesses: non-admin never sees client-specific or unclassified", () => {
  for (const role of ["user", void 0, "viewer"]) {
    const scopes = visibleProcesses({ role }, SAMPLE).map((p) => p.knowledge_scope);
    assert.ok(scopes.every((s) => s === "general"), `role=${role} leaked ${JSON.stringify(scopes)}`);
    assert.ok(!scopes.includes("client-specific"));
    assert.ok(!scopes.includes("unclassified"));
  }
});
