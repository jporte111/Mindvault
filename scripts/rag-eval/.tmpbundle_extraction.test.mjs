// scripts/rag-eval/extraction.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// base44/shared/extraction.ts
var LEGACY_PASS1_KEYS = Object.freeze([
  "summary",
  "key_takeaways",
  "sop_steps",
  "decision_rules",
  "common_mistakes",
  "required_inputs",
  "final_output",
  "client_segment",
  "topic_category",
  "software_systems",
  "presenter",
  "duration_minutes"
]);
var LEGACY_PASS2_KEYS = Object.freeze([
  "ai_knowledge_entry",
  "app_feature_opportunities"
]);
var STRATEGY_ENGINE_KEYS = Object.freeze([
  "summary",
  "key_takeaways",
  "sop_steps",
  "decision_rules",
  "client_segment",
  "topic_category",
  "app_feature_opportunities"
]);
var FEATURE_OPPORTUNITY_KEYS = Object.freeze([
  "feature_name",
  "problem_solved",
  "user_type",
  "required_inputs",
  "output",
  "facing",
  "internal_need_score",
  "market_demand_score",
  "business_value_score",
  "implementation_complexity_score",
  "priority",
  "priority_reason"
]);
var NEW_PASS1_KEYS = Object.freeze([
  "exceptions",
  "roles_involved",
  "approvers",
  "escalation_paths",
  "prerequisites",
  "deadlines",
  "verification_checkpoints",
  "prohibited_actions",
  "process_name",
  "department"
]);
function isTranscriptLike(sourceType) {
  return sourceType === void 0 || sourceType === null || sourceType === "recording" || sourceType === "transcript";
}
function sourceNoun(sourceType) {
  return isTranscriptLike(sourceType) ? "training transcript" : "operational knowledge source";
}
var pass1JsonSchema = {
  type: "object",
  properties: {
    // legacy
    summary: { type: "string" },
    key_takeaways: { type: "array", items: { type: "string" } },
    sop_steps: { type: "array", items: { type: "string" } },
    decision_rules: { type: "array", items: { type: "string" } },
    common_mistakes: { type: "array", items: { type: "string" } },
    required_inputs: { type: "array", items: { type: "string" } },
    final_output: { type: "string" },
    client_segment: { type: "string" },
    topic_category: { type: "string" },
    software_systems: { type: "array", items: { type: "string" } },
    presenter: { type: "string" },
    duration_minutes: { type: "number" },
    // new operational (optional)
    exceptions: { type: "array", items: { type: "string" } },
    roles_involved: { type: "array", items: { type: "string" } },
    approvers: { type: "array", items: { type: "string" } },
    escalation_paths: { type: "array", items: { type: "string" } },
    prerequisites: { type: "array", items: { type: "string" } },
    deadlines: { type: "array", items: { type: "string" } },
    verification_checkpoints: { type: "array", items: { type: "string" } },
    prohibited_actions: { type: "array", items: { type: "string" } },
    process_name: { type: "string" },
    department: { type: "string" }
  }
};
var pass2JsonSchema = {
  type: "object",
  properties: {
    ai_knowledge_entry: { type: "string" },
    app_feature_opportunities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feature_name: { type: "string" },
          problem_solved: { type: "string" },
          user_type: { type: "string" },
          required_inputs: { type: "string" },
          output: { type: "string" },
          facing: { type: "string" },
          internal_need_score: { type: "number" },
          market_demand_score: { type: "number" },
          business_value_score: { type: "number" },
          implementation_complexity_score: { type: "number" },
          priority: { type: "string" },
          priority_reason: { type: "string" }
        }
      }
    }
  }
};
var SOURCE_TYPE_GUIDANCE = {
  sop: "This source is a standard operating procedure document. It should already contain explicit, ordered steps \u2014 preserve their order and wording closely rather than paraphrasing.",
  process_doc: "This source is a process document. Reconstruct the end-to-end process, its inputs, and its outputs.",
  policy: "This source is a policy. Focus on the rules it establishes, the thresholds and conditions, who it applies to, and its exceptions. Do not invent thresholds, roles, or dollar values that are not stated.",
  checklist: "This source is a checklist. Each item is typically a required action or a validation \u2014 capture them as sop_steps and verification_checkpoints. Do not invent items.",
  reference: "This source is reference material. Summarize what it documents; only extract steps and rules that are explicitly stated."
};
var OPERATIONAL_FIELDS_BLOCK = `
Also extract the following operational fields when the source supports them. Leave an array empty when the source does not clearly document it, and omit an optional string field entirely when it is not stated. Never guess names, roles, titles, thresholds, deadlines, or dollar values:
- exceptions: Array of situations where the normal procedure changes (strings).
- roles_involved: Array of job roles or titles that participate (strings).
- approvers: Array of roles or titles who must approve or sign off, and what they approve (strings).
- escalation_paths: Array of "if X then escalate to Y" statements (strings).
- prerequisites: Array of things that must be true or done before starting (strings).
- deadlines: Array of timing constraints or due dates mentioned (strings).
- verification_checkpoints: Array of checks or validations performed during or after the work (strings).
- prohibited_actions: Array of explicit "do not" statements or known bad practices (strings).
- process_name: The name of the operational process this source describes, only if explicitly stated. Omit this field otherwise.
- department: The owning department, only if explicitly stated. Omit this field otherwise.`;
function buildPass1Prompt({ sourceText, sourceType }) {
  const noun = sourceNoun(sourceType);
  const guidance = sourceType && SOURCE_TYPE_GUIDANCE[sourceType] ? SOURCE_TYPE_GUIDANCE[sourceType] + "\n\n" : "";
  const metadataRule = isTranscriptLike(sourceType) ? "" : "\nThis source is a document, not a recorded session: do not invent a presenter or a duration \u2014 omit presenter and duration_minutes entirely.";
  return `You are a financial operations analyst processing a ${noun} for a financial concierge firm. Extract structured business logic from the ${noun} below.

${guidance}Source:
${sourceText}

Return a JSON object with ALL of the following fields:
- summary: A concise 2-3 sentence summary of what this covers.
- key_takeaways: Array of 4-7 most important lessons (strings).
- sop_steps: Array of numbered step-by-step operating procedure steps (strings, e.g. "1. Log into QuickBooks and navigate to...").
- decision_rules: Array of if/then rules extracted from the source (strings, e.g. "If a client has multiple entities, then...").
- common_mistakes: Array of errors, risks, misclassifications, or watchouts to avoid (strings).
- required_inputs: Array of documents, data, software access, or client info needed to complete this workflow (strings).
- final_output: A string describing what this workflow produces (e.g. "Reconciled bank statement, journal entries, and monthly close report").
- client_segment: One of: "Small Business", "High-Net-Worth Household", "Both", "Internal Only".
- topic_category: One of: "Bookkeeping", "Payroll", "Tax Prep", "Reconciliation", "Reporting", "Cash Flow", "Entity Management", "Client Communication", "Operations", "Compliance", "Troubleshooting", "Other".
- software_systems: Array of software tools, portals, or systems mentioned (strings, e.g. "QuickBooks Online", "Excel", "ADP").
- presenter: The presenter's name if clearly identifiable. Omit this field if it is not clearly identifiable \u2014 do not guess.
- duration_minutes: Estimated duration in minutes as a number, only for a recorded session. Omit this field otherwise.${metadataRule}
${OPERATIONAL_FIELDS_BLOCK}`;
}
function buildPass2Prompt({ sourceText, sourceType }) {
  const noun = sourceNoun(sourceType);
  const featureCaveat = isTranscriptLike(sourceType) ? "" : " If this source is an operational document rather than a training session and surfaces no genuine product or feature ideas, return an empty app_feature_opportunities array rather than inventing entries.";
  return `You are a financial operations analyst processing a ${noun} for a financial concierge firm.

Source:
${sourceText}

Return a JSON object with the following fields:
- ai_knowledge_entry: A clean, well-written knowledge base entry (2-4 paragraphs) that an AI assistant can use to answer questions about this topic accurately.
- app_feature_opportunities: Array of objects, each with:
    - feature_name: Short name for the feature
    - problem_solved: What problem this feature solves
    - user_type: Who uses it (e.g. "Bookkeeper", "Small Business Owner", "HNW Client", "CFO", "Internal Employee")
    - required_inputs: What data the feature needs
    - output: What the feature produces
    - facing: One of "Internal", "Client-Facing", "Both"
    - internal_need_score: Integer 1-5 based on how clearly the source shows this feature would solve a real workflow problem (5 = clearly solves a painful, recurring problem; 1 = vague or minor need).
    - market_demand_score: Integer 1-5 based on whether this feature aligns with current financial services, wealth management, accounting, bookkeeping, fintech, AI automation, or client experience trends (5 = strongly aligned with multiple trends; 1 = little/no market relevance).
    - business_value_score: Integer 1-5 based on how useful this feature would be for the firm's internal team, clients, or both (5 = high value for both; 1 = limited value).
    - implementation_complexity_score: Integer 1-5 where 1 is easy to build and 5 is complex (requires integrations, heavy logic, or significant data infrastructure).
    - priority: One of "High", "Medium", "Low" \u2014 assigned using the rules below.
    - priority_reason: A plain-English explanation of WHY the feature was marked High, Medium, or Low, referencing the scores.

PRIORITY ASSIGNMENT RULES (do not assign a priority without a matching reason):
- High priority: Strong internal need (internal_need_score 4-5), strong market demand (market_demand_score 4-5), clear business value (business_value_score 4-5), and reasonable complexity OR very high upside that justifies the effort.
- Medium priority: Useful feature with moderate internal need or market demand, good business value but not urgent, may be more niche or department-specific.
- Low priority: Nice-to-have feature, weak market demand, limited business value, or high complexity compared to expected impact.

Never assign High, Medium, or Low without also providing a clear priority_reason that explains the decision based on the scores.${featureCaveat}`;
}
function assessIngestionQuality(pass1Data) {
  const arr = (k) => Array.isArray(pass1Data?.[k]) ? pass1Data[k] : [];
  const str = (k) => typeof pass1Data?.[k] === "string" ? pass1Data[k].trim() : "";
  const structuredCount = arr("sop_steps").length + arr("key_takeaways").length + arr("decision_rules").length + arr("common_mistakes").length + arr("required_inputs").length;
  const hasSummary = str("summary").length >= 20;
  if (!hasSummary && structuredCount === 0) return "needs_review";
  if (structuredCount <= 1 && !hasSummary) return "needs_review";
  return "ok";
}
function looksLikeHttpUrl(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t || /\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
async function resolveSourceText(field, fetchImpl = fetch) {
  if (typeof field !== "string" || !field.trim()) {
    return { ok: false, reason: "no_source", error: "Knowledge source has no source text", status: 400 };
  }
  let raw;
  if (looksLikeHttpUrl(field)) {
    let res;
    try {
      res = await fetchImpl(field.trim());
    } catch (e) {
      return {
        ok: false,
        reason: "fetch_failed",
        error: `Failed to fetch source text: ${e.message}`,
        status: 500
      };
    }
    if (!res.ok) {
      return { ok: false, reason: "fetch_failed", error: `Failed to fetch source text: ${res.status}`, status: 500 };
    }
    raw = await res.text();
  } else {
    raw = field;
  }
  const trimmed = raw.trim();
  if (trimmed.length < 20 || trimmed.startsWith("<")) {
    return { ok: false, reason: "invalid_content", error: "Source text is empty or invalid content", status: 400 };
  }
  return { ok: true, text: raw };
}

// scripts/rag-eval/extraction.test.mjs
var p1 = Object.keys(pass1JsonSchema.properties);
var p2 = Object.keys(pass2JsonSchema.properties);
var featureProps = Object.keys(pass2JsonSchema.properties.app_feature_opportunities.items.properties);
var TYPE_GUIDANCE_MARKERS = [
  "This source is a policy.",
  "This source is a checklist.",
  "This source is a standard operating procedure document.",
  "This source is a process document.",
  "This source is reference material."
];
test("every exported key array is duplicate-free", () => {
  for (const [name, keys] of Object.entries({
    LEGACY_PASS1_KEYS,
    LEGACY_PASS2_KEYS,
    STRATEGY_ENGINE_KEYS,
    FEATURE_OPPORTUNITY_KEYS,
    NEW_PASS1_KEYS
  })) {
    assert.equal(new Set(keys).size, keys.length, `${name} has duplicates`);
  }
});
test("legacy pass 1 + pass 2 keys are all still in the schemas", () => {
  for (const k of LEGACY_PASS1_KEYS) assert.ok(p1.includes(k), `pass1 schema missing legacy key ${k}`);
  for (const k of LEGACY_PASS2_KEYS) assert.ok(p2.includes(k), `pass2 schema missing legacy key ${k}`);
});
test("Strategy Engine keys are all still produced", () => {
  const all = /* @__PURE__ */ new Set([...p1, ...p2]);
  for (const k of STRATEGY_ENGINE_KEYS) assert.ok(all.has(k), `Strategy Engine key ${k} no longer produced`);
});
test("app_feature_opportunities item shape is exactly the Strategy Engine contract", () => {
  assert.deepEqual([...featureProps].sort(), [...FEATURE_OPPORTUNITY_KEYS].sort());
});
test("new operational keys are additive and disjoint from legacy", () => {
  for (const k of NEW_PASS1_KEYS) {
    assert.ok(p1.includes(k), `pass1 schema missing new key ${k}`);
    assert.ok(!LEGACY_PASS1_KEYS.includes(k), `${k} collides with a legacy key`);
  }
});
var repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
var trainingJsonc = readFileSync(resolve(repoRoot, "base44/entities/Training.jsonc"), "utf8");
var analyzeSrc = readFileSync(resolve(repoRoot, "base44/functions/analyzeTraining/entry.ts"), "utf8");
var OPERATIONAL_ARRAY_FIELDS = [
  "exceptions",
  "roles_involved",
  "approvers",
  "escalation_paths",
  "prerequisites",
  "deadlines",
  "verification_checkpoints",
  "prohibited_actions"
];
var OPERATIONAL_STRING_FIELDS = ["process_name", "department"];
function propertyBlock(jsonc, prop) {
  const start = new RegExp(`(^|\\n)\\s*"${prop}"\\s*:\\s*\\{`).exec(jsonc);
  if (!start) return null;
  const open = start.index + start[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < jsonc.length; i++) {
    const ch = jsonc[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return jsonc.slice(open, i + 1);
  }
  return null;
}
test("operational contract: NEW_PASS1_KEYS is exactly the 8 array + 2 string fields", () => {
  assert.deepEqual(
    [...NEW_PASS1_KEYS].sort(),
    [...OPERATIONAL_ARRAY_FIELDS, ...OPERATIONAL_STRING_FIELDS].sort()
  );
});
test("operational contract: pass1JsonSchema \u2014 8 array<string>, process_name/department string", () => {
  for (const f of OPERATIONAL_ARRAY_FIELDS) {
    const s = pass1JsonSchema.properties[f];
    assert.ok(s, `pass1JsonSchema missing ${f}`);
    assert.equal(s.type, "array", `${f} must be array`);
    assert.equal(s.items?.type, "string", `${f}.items must be string`);
  }
  for (const f of OPERATIONAL_STRING_FIELDS) {
    const s = pass1JsonSchema.properties[f];
    assert.ok(s, `pass1JsonSchema missing ${f}`);
    assert.equal(s.type, "string", `${f} must be string`);
    assert.ok(!("items" in s), `${f} must not have items`);
  }
});
test("operational contract: analyzeTraining routes only process_name + department through optStr", () => {
  const route = analyzeSrc.match(
    /const v = \(([^)]*)\)\s*\?\s*optStr\(pass1Data\[k\]\)\s*:\s*optArr\(pass1Data\[k\]\)/
  );
  if (!route) assert.fail("Could not locate the optStr/optArr routing in analyzeTraining/entry.ts");
  const strRouted = (route[1].match(/'([^']+)'|"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
  assert.deepEqual(
    [...strRouted].sort(),
    [...OPERATIONAL_STRING_FIELDS].sort(),
    "optStr branch must name exactly process_name + department; everything else goes through optArr"
  );
});
test("operational contract: Training.jsonc declares the 8 fields as array<string>", () => {
  for (const f of OPERATIONAL_ARRAY_FIELDS) {
    const block = propertyBlock(trainingJsonc, f);
    if (!block) assert.fail(`Could not locate "${f}" in base44/entities/Training.jsonc`);
    assert.match(block, /"type"\s*:\s*"array"/, `${f}: not type array`);
    assert.match(block, /"items"\s*:\s*\{\s*"type"\s*:\s*"string"\s*\}/, `${f}: items not {type:string}`);
  }
});
test("operational contract: Training.jsonc declares process_name + department as string, not array", () => {
  for (const f of OPERATIONAL_STRING_FIELDS) {
    const block = propertyBlock(trainingJsonc, f);
    if (!block) assert.fail(`Could not locate "${f}" in base44/entities/Training.jsonc`);
    assert.match(block, /"type"\s*:\s*"string"/, `${f}: not type string`);
    assert.doesNotMatch(block, /"type"\s*:\s*"array"/, `${f}: must not be array`);
    assert.doesNotMatch(block, /"items"\s*:/, `${f}: must not have items`);
  }
});
test("operational contract: every field analyzeTraining writes has a same-typed Training.jsonc declaration", () => {
  for (const f of NEW_PASS1_KEYS) {
    const block = propertyBlock(trainingJsonc, f);
    if (!block) assert.fail(`Training.jsonc has no declaration for written field "${f}"`);
    const t = pass1JsonSchema.properties[f]?.type;
    assert.ok(t, `pass1JsonSchema missing ${f}`);
    assert.match(
      block,
      new RegExp(`"type"\\s*:\\s*"${t}"`),
      `${f}: Training.jsonc type disagrees with pass1JsonSchema ("${t}")`
    );
  }
});
test("pass 1: undefined / recording / transcript keep transcript wording", () => {
  for (const st of [void 0, null, "recording", "transcript"]) {
    const prompt = buildPass1Prompt({ sourceText: "BODY", sourceType: st });
    assert.ok(prompt.includes("training transcript"), `sourceType=${st}`);
    assert.ok(!prompt.includes("This source is a"), `sourceType=${st} leaked type guidance`);
  }
});
test("pass 1: legacy_unspecified gets generic document behavior, not transcript, not a specific type", () => {
  const prompt = buildPass1Prompt({ sourceText: "BODY", sourceType: "legacy_unspecified" });
  assert.ok(prompt.includes("operational knowledge source"));
  assert.ok(!prompt.includes("training transcript"));
  assert.ok(prompt.includes("do not invent a presenter or a duration"));
  for (const marker of TYPE_GUIDANCE_MARKERS) {
    assert.ok(!prompt.includes(marker), `legacy_unspecified leaked "${marker}"`);
  }
});
test("pass 1: document types get type guidance + no fabricated metadata rule", () => {
  const prompt = buildPass1Prompt({ sourceText: "BODY", sourceType: "policy" });
  assert.ok(prompt.includes("operational knowledge source"));
  assert.ok(prompt.includes("This source is a policy."));
  assert.ok(prompt.includes("do not invent a presenter or a duration"));
});
test("pass 2: source-type aware, contract intact, no legacy firm name", () => {
  const t = buildPass2Prompt({ sourceText: "BODY" });
  const d = buildPass2Prompt({ sourceText: "BODY", sourceType: "sop" });
  assert.ok(t.includes("training transcript"));
  assert.ok(d.includes("operational knowledge source"));
  for (const s of [t, d]) {
    assert.ok(!s.includes("Hormozi"), "legacy firm name still present");
    assert.ok(s.includes("app_feature_opportunities"));
    assert.ok(s.includes("priority_reason"));
  }
});
test("ingestion quality: empty extraction -> needs_review", () => {
  assert.equal(assessIngestionQuality({}), "needs_review");
  assert.equal(assessIngestionQuality({ sop_steps: ["only one step"] }), "needs_review");
});
test("ingestion quality: real extraction -> ok", () => {
  assert.equal(
    assessIngestionQuality({ summary: "A genuine multi-sentence summary of the process.", sop_steps: ["a", "b", "c"] }),
    "ok"
  );
});
var okFetch = (body) => async () => ({ ok: true, status: 200, text: async () => body });
var failFetch = (status) => async () => ({ ok: false, status, text: async () => "" });
var throwFetch = () => async () => {
  throw new Error("getaddrinfo ENOTFOUND");
};
var calls;
var spy = (impl) => (...a) => {
  calls++;
  return impl()(...a);
};
test("resolve: transcript as a valid URL is fetched", async () => {
  calls = 0;
  const r = await resolveSourceText("https://files.example.com/t.txt", spy(() => okFetch("This is a sufficiently long transcript body.")));
  assert.deepEqual(r, { ok: true, text: "This is a sufficiently long transcript body." });
  assert.equal(calls, 1);
});
test("resolve: transcript as raw pasted text is used as-is, not fetched", async () => {
  calls = 0;
  const raw = "Pasted SOP: 1. Do the first thing. 2. Do the second thing.";
  const r = await resolveSourceText(raw, spy(() => okFetch("SHOULD NOT BE USED")));
  assert.deepEqual(r, { ok: true, text: raw });
  assert.equal(calls, 0);
});
test("resolve: raw text that merely contains a URL is not fetched", async () => {
  calls = 0;
  const raw = "See the policy at https://intra.example.com/policy and follow it carefully every month.";
  const r = await resolveSourceText(raw, spy(() => okFetch("X")));
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
  assert.equal(calls, 0);
});
test("resolve: only http/https is fetched \u2014 an ftp:// value is treated as raw text", async () => {
  calls = 0;
  const raw = "ftp://legacy.example.com/archive/really-old-procedure-document-v3-final.txt";
  const r = await resolveSourceText(raw, spy(() => okFetch("SHOULD NOT BE USED")));
  assert.deepEqual(r, { ok: true, text: raw });
  assert.equal(calls, 0);
});
test("resolve: unreachable URL -> fetch_failed (no status write upstream)", async () => {
  const r = await resolveSourceText("https://nope.invalid/x.txt", throwFetch());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "fetch_failed");
  assert.equal(r.status, 500);
});
test("resolve: URL returning 404 -> fetch_failed", async () => {
  const r = await resolveSourceText("https://files.example.com/missing.txt", failFetch(404));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "fetch_failed");
});
test("resolve: empty / whitespace / missing -> no_source", async () => {
  for (const v of ["", "   ", void 0, null]) {
    const r = await resolveSourceText(v, throwFetch());
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_source");
    assert.equal(r.status, 400);
  }
});
test("resolve: HTML returned from a supposed text URL -> invalid_content", async () => {
  const r = await resolveSourceText("https://files.example.com/t.txt", okFetch("<!doctype html><html><body>Not text</body></html>"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_content");
  assert.equal(r.status, 400);
});
test("resolve: too-short raw text -> invalid_content", async () => {
  const r = await resolveSourceText("too short", throwFetch());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_content");
});
test("looksLikeHttpUrl: only whitespace-free http(s) URLs", () => {
  assert.equal(looksLikeHttpUrl("https://x.com/a.txt"), true);
  assert.equal(looksLikeHttpUrl("http://x"), true);
  assert.equal(looksLikeHttpUrl("  https://x.com/a  "), true);
  assert.equal(looksLikeHttpUrl("ftp://x/a"), false);
  assert.equal(looksLikeHttpUrl("not a url"), false);
  assert.equal(looksLikeHttpUrl("https://x.com/a b"), false);
  assert.equal(looksLikeHttpUrl("text with https://x.com in it"), false);
  assert.equal(looksLikeHttpUrl(void 0), false);
});
