// scripts/rag-eval/operational-answer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

// base44/shared/operationalAnswer.ts
var OPERATIONAL_SECTION_KEYS = [
  "steps",
  "prerequisites",
  "approvals",
  "exceptions",
  "prohibited_actions",
  "verification_checkpoints",
  "escalation",
  "watch_outs",
  "systems",
  "expected_result"
];
var SECTION_TITLES = {
  steps: "Steps",
  prerequisites: "Prerequisites",
  approvals: "Approvals",
  exceptions: "Exceptions",
  prohibited_actions: "Do not",
  verification_checkpoints: "Verification checkpoints",
  escalation: "Escalation",
  watch_outs: "Watch out for",
  systems: "Systems",
  expected_result: "Expected result"
};
var SECTION_FOR_CHUNK_TYPE = {
  sop_step: "steps",
  decision_rule: "steps",
  required_input: "prerequisites",
  approval: "approvals",
  exception: "exceptions",
  prohibited_action: "prohibited_actions",
  verification: "verification_checkpoints",
  escalation: "escalation",
  common_mistake: "watch_outs"
};
var AUTHORITATIVE = /* @__PURE__ */ new Set(["policy", "approved_sop", "approved_procedure"]);
var ADVISORY = /* @__PURE__ */ new Set(["training", "reference", "notes"]);
var PROCESS_INTENTS = /* @__PURE__ */ new Set(["procedure", "decision_rule", "troubleshooting"]);
function isOperationalIntent(intent) {
  return !!intent && PROCESS_INTENTS.has(intent);
}
function validateRequestedFacets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v === "string" && OPERATIONAL_SECTION_KEYS.includes(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
function buildFacetInventory(ranked) {
  const present = /* @__PURE__ */ new Set();
  for (const r of ranked || []) {
    const s = SECTION_FOR_CHUNK_TYPE[r?.chunk?.chunk_type || ""];
    if (s) present.add(s);
  }
  return OPERATIONAL_SECTION_KEYS.filter((k) => present.has(k));
}
function validateSections(input) {
  const keep = [];
  for (const s of input.sections || []) {
    if (!s || !OPERATIONAL_SECTION_KEYS.includes(s.key)) continue;
    const items = (s.items || []).filter(
      (it) => it && typeof it.text === "string" && it.text.trim() && it.citations.length > 0
    );
    if (items.length) keep.push({ key: s.key, items });
  }
  const directAnswerValid = !!input.directAnswer && typeof input.directAnswer.text === "string" && input.directAnswer.text.trim().length > 0 && input.directAnswer.citations.length > 0;
  return { sections: keep, directAnswerValid };
}
function classifySectionAuthority(citations, ranked) {
  let hasAuth = false;
  let hasAdv = false;
  let hasUnknown = false;
  for (const i of citations || []) {
    const a = ranked[i]?.chunk?.source_authority;
    if (a && AUTHORITATIVE.has(a)) hasAuth = true;
    else if (a && ADVISORY.has(a)) hasAdv = true;
    else hasUnknown = true;
  }
  const kinds = (hasAuth ? 1 : 0) + (hasAdv ? 1 : 0) + (hasUnknown ? 1 : 0);
  if (kinds === 0) return "unknown";
  if (kinds > 1) return "mixed";
  if (hasAuth) return "authoritative";
  if (hasAdv) return "advisory";
  return "unknown";
}
function shouldKeepContradictionNote(noteCitations) {
  return new Set(noteCitations || []).size >= 2;
}
function deriveAnswerStatus(input) {
  if (input.baseBand === "low" || !input.directAnswerValid) {
    return { status: "INSUFFICIENT", missingFacets: [] };
  }
  const covered = new Set(input.survivingSectionKeys || []);
  const missingFacets = (input.requestedFacets || []).filter((f) => !covered.has(f));
  if (input.baseBand === "medium") return { status: "PARTIAL", missingFacets };
  if (input.contradictionNoteKept) return { status: "PARTIAL", missingFacets };
  if (missingFacets.length) return { status: "PARTIAL", missingFacets };
  return { status: "HIGH", missingFacets: [] };
}
function stalenessFlags(citedChunks) {
  const stale = /* @__PURE__ */ new Map();
  let unverified = false;
  for (const c of citedChunks || []) {
    if (!c) continue;
    if (c.process_freshness_status === "stale") {
      stale.set(c.training_id || c.id || `k${stale.size}`, c.title || "Untitled");
    }
    if (c.verification_status !== "verified") unverified = true;
  }
  return {
    stale_sources: [...stale].map(([id, title]) => ({ id, title })),
    unverified_used: unverified
  };
}
var INSUFFICIENT_MESSAGE = "The knowledge base doesn't clearly document this operational question yet. It may not be covered, or the question may need more specific terms (a system, a step, a document type).";
function flattenToMarkdown(answer, status) {
  if (status === "INSUFFICIENT" || !answer.direct_answer && answer.sections.length === 0) {
    return INSUFFICIENT_MESSAGE;
  }
  const parts = [];
  if (answer.direct_answer) parts.push(answer.direct_answer.text.trim());
  for (const s of answer.sections) {
    const ordered = s.key === "steps";
    const lines = s.items.map(
      (it, i) => ordered ? `${i + 1}. ${it.text.trim()}` : `- ${it.text.trim()}`
    );
    parts.push(`**${s.title}**
${lines.join("\n")}`);
  }
  if (answer.missing_facets.length) {
    const names = answer.missing_facets.map((f) => SECTION_TITLES[f] || f).join("; ");
    parts.push(`**Not documented:** ${names}.`);
  }
  if (answer.contradiction_note) parts.push(`_${answer.contradiction_note.trim()}_`);
  if (answer.stale_sources.length) {
    parts.push(
      `_\u26A0 Some sources for this answer are overdue for review: ${answer.stale_sources.map((s) => s.title).join(", ")}._`
    );
  }
  if (answer.unverified_used) parts.push("_Based on unverified knowledge._");
  return parts.join("\n\n");
}

// base44/shared/retrieval.ts
var STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these they this to was were what when where which who will with you your our we do does did not can could should would may might must about".split(" ")
);
function parseCitations(answerText, rankedCount) {
  const seen = /* @__PURE__ */ new Set();
  for (const m of (answerText || "").matchAll(/\[S(\d+)\]/g)) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < rankedCount) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

// scripts/rag-eval/operational-answer.test.mjs
var rc = (o, withEmbedding = false) => ({
  chunk: {
    id: o.id,
    training_id: o.training_id || o.id,
    title: o.title || o.id,
    chunk_type: o.chunk_type,
    source_authority: o.source_authority,
    process_freshness_status: o.process_freshness_status,
    verification_status: o.verification_status,
    ...withEmbedding ? { embedding: [0.1, 0.9, 0, 0] } : {}
  }
});
test("isOperationalIntent: procedure/decision_rule/troubleshooting -> true; others -> false", () => {
  for (const i of ["procedure", "decision_rule", "troubleshooting"]) assert.equal(isOperationalIntent(i), true);
  for (const i of ["definition", "overview", "other", "", null, void 0]) assert.equal(isOperationalIntent(i), false);
});
test("validateRequestedFacets: keeps known keys, drops unknown, dedupes, non-array -> []", () => {
  assert.deepEqual(
    validateRequestedFacets(["approvals", "steps", "approvals", "nonsense", 42, null]),
    ["approvals", "steps"]
  );
  assert.deepEqual(validateRequestedFacets("approvals"), []);
  assert.deepEqual(validateRequestedFacets(void 0), []);
  assert.deepEqual(validateRequestedFacets([]), []);
});
test("buildFacetInventory: maps chunk_types to sections, ordered, deduped", () => {
  const ranked = [
    rc({ id: "a", chunk_type: "sop_step" }),
    rc({ id: "b", chunk_type: "approval" }),
    rc({ id: "c", chunk_type: "decision_rule" }),
    // also -> steps
    rc({ id: "d", chunk_type: "summary" })
    // -> nothing
  ];
  assert.deepEqual(buildFacetInventory(ranked), ["steps", "approvals"]);
  assert.deepEqual(buildFacetInventory([]), []);
});
test("validateSections: drops items with no citation, removes emptied sections", () => {
  const { sections, directAnswerValid } = validateSections({
    directAnswer: { text: "Do X then Y [S1]", citations: [0] },
    sections: [
      { key: "steps", items: [
        { text: "grounded [S1]", citations: [0] },
        { text: "ungrounded, no marker", citations: [] }
      ] },
      { key: "approvals", items: [{ text: "uncited [S9]", citations: [] }] },
      // -> emptied -> removed
      { key: "not_a_real_key", items: [{ text: "x [S1]", citations: [0] }] }
      // -> unknown key -> removed
    ]
  });
  assert.equal(directAnswerValid, true);
  assert.deepEqual(sections.map((s) => s.key), ["steps"]);
  assert.equal(sections[0].items.length, 1);
});
test("validateSections: direct answer with no citation -> directAnswerValid false", () => {
  const { directAnswerValid } = validateSections({
    directAnswer: { text: "a confident but ungrounded claim", citations: [] },
    sections: []
  });
  assert.equal(directAnswerValid, false);
});
var AUTH_POOL = [
  rc({ id: "0", source_authority: "policy" }),
  rc({ id: "1", source_authority: "approved_sop" }),
  rc({ id: "2", source_authority: "training" }),
  rc({ id: "3", source_authority: "notes" }),
  rc({ id: "4" }),
  // no source_authority
  rc({ id: "5", source_authority: "weird_value" })
];
test("classifySectionAuthority: all authoritative -> authoritative", () => {
  assert.equal(classifySectionAuthority([0, 1], AUTH_POOL), "authoritative");
});
test("classifySectionAuthority: all explicit training/reference/notes -> advisory", () => {
  assert.equal(classifySectionAuthority([2, 3], AUTH_POOL), "advisory");
});
test("classifySectionAuthority: all missing source_authority -> unknown (NOT advisory)", () => {
  assert.equal(classifySectionAuthority([4], AUTH_POOL), "unknown");
  assert.equal(classifySectionAuthority([4, 5], AUTH_POOL), "unknown");
  assert.equal(classifySectionAuthority([], AUTH_POOL), "unknown");
});
test("classifySectionAuthority: any category mix -> mixed", () => {
  assert.equal(classifySectionAuthority([0, 2], AUTH_POOL), "mixed");
  assert.equal(classifySectionAuthority([0, 4], AUTH_POOL), "mixed");
  assert.equal(classifySectionAuthority([2, 4], AUTH_POOL), "mixed");
});
test("shouldKeepContradictionNote: >=2 distinct citations -> true; fewer -> false", () => {
  assert.equal(shouldKeepContradictionNote([0, 2]), true);
  assert.equal(shouldKeepContradictionNote([1]), false);
  assert.equal(shouldKeepContradictionNote([3, 3]), false);
  assert.equal(shouldKeepContradictionNote([]), false);
});
var baseInput = {
  baseBand: "high",
  directAnswerValid: true,
  requestedFacets: [],
  survivingSectionKeys: [],
  contradictionNoteKept: false
};
test("deriveAnswerStatus: base band low -> INSUFFICIENT even with valid sections", () => {
  const r = deriveAnswerStatus({ ...baseInput, baseBand: "low", survivingSectionKeys: ["steps", "approvals"] });
  assert.equal(r.status, "INSUFFICIENT");
  assert.deepEqual(r.missingFacets, []);
});
test("deriveAnswerStatus: no citation-valid direct answer -> INSUFFICIENT", () => {
  assert.equal(deriveAnswerStatus({ ...baseInput, directAnswerValid: false }).status, "INSUFFICIENT");
});
test("deriveAnswerStatus: every requested facet has a surviving section -> HIGH", () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ["steps", "approvals"],
    survivingSectionKeys: ["steps", "approvals", "watch_outs"]
  });
  assert.equal(r.status, "HIGH");
  assert.deepEqual(r.missingFacets, []);
});
test("deriveAnswerStatus: requested facet with NO surviving section -> PARTIAL + missingFacets", () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ["steps", "approvals"],
    survivingSectionKeys: ["steps"]
  });
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(r.missingFacets, ["approvals"]);
});
test("deriveAnswerStatus: coverage comes from surviving sections, NOT buildFacetInventory", () => {
  const ranked = [rc({ id: "a", chunk_type: "sop_step" }), rc({ id: "b", chunk_type: "approval" })];
  assert.ok(buildFacetInventory(ranked).includes("approvals"), "inventory has approvals");
  const { sections } = validateSections({
    directAnswer: { text: "answer [S1]", citations: [0] },
    sections: [
      { key: "steps", items: [{ text: "step [S1]", citations: [0] }] },
      { key: "approvals", items: [{ text: "guess about approver", citations: [] }] }
    ]
  });
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ["approvals"],
    survivingSectionKeys: sections.map((s) => s.key)
  });
  assert.equal(r.status, "PARTIAL", "inventory must not mask an unanswered facet");
  assert.deepEqual(r.missingFacets, ["approvals"]);
});
test("deriveAnswerStatus: kept contradiction note caps status at PARTIAL even with full coverage", () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    requestedFacets: ["approvals"],
    survivingSectionKeys: ["approvals"],
    contradictionNoteKept: true
  });
  assert.equal(r.status, "PARTIAL");
});
test("deriveAnswerStatus: no requested facets + valid direct answer -> HIGH", () => {
  assert.equal(deriveAnswerStatus(baseInput).status, "HIGH");
});
test("stalenessFlags: stale chunk listed (deduped by training_id); unverified flips the bool", () => {
  const cited = [
    { training_id: "t1", title: "Recon SOP", process_freshness_status: "stale", verification_status: "verified" },
    { training_id: "t1", title: "Recon SOP", process_freshness_status: "stale", verification_status: "verified" },
    { training_id: "t2", title: "Payroll", process_freshness_status: "current", verification_status: "unverified" }
  ];
  const r = stalenessFlags(cited);
  assert.deepEqual(r.stale_sources, [{ id: "t1", title: "Recon SOP" }]);
  assert.equal(r.unverified_used, true);
});
test("stalenessFlags: all verified + current -> nothing flagged", () => {
  const r = stalenessFlags([{ training_id: "t1", title: "X", process_freshness_status: "current", verification_status: "verified" }]);
  assert.deepEqual(r.stale_sources, []);
  assert.equal(r.unverified_used, false);
});
test("stalenessFlags: missing verification_status counts as unverified", () => {
  assert.equal(stalenessFlags([{ training_id: "t1", title: "X" }]).unverified_used, true);
});
var sampleAnswer = {
  direct_answer: { text: "Post the invoice against the draw schedule [S1].", citations: [0], authority: "authoritative" },
  sections: [
    { key: "steps", title: "Steps", authority: "authoritative", items: [
      { text: "Pull the draw request [S1].", citations: [0] },
      { text: "Attach the wire confirmation [S2].", citations: [1] }
    ] },
    { key: "approvals", title: "Approvals", authority: "advisory", items: [
      { text: "The controller signs off [S2].", citations: [1] }
    ] }
  ],
  missing_facets: ["exceptions"],
  contradiction_note: null,
  stale_sources: [],
  unverified_used: false
};
test("flattenToMarkdown: INSUFFICIENT -> the standard message", () => {
  assert.equal(flattenToMarkdown(sampleAnswer, "INSUFFICIENT"), INSUFFICIENT_MESSAGE);
  assert.equal(
    flattenToMarkdown({ ...sampleAnswer, direct_answer: null, sections: [] }, "HIGH"),
    INSUFFICIENT_MESSAGE
  );
});
test("flattenToMarkdown: deterministic, numbered steps, every [S#] preserved", () => {
  const md = flattenToMarkdown(sampleAnswer, "PARTIAL");
  assert.equal(md, flattenToMarkdown(sampleAnswer, "PARTIAL"));
  assert.ok(md.includes("1. Pull the draw request [S1]."));
  assert.ok(md.includes("2. Attach the wire confirmation [S2]."));
  assert.ok(md.includes("**Approvals**"));
  assert.ok(md.includes("**Not documented:** Exceptions."));
  const flat = parseCitations(md, 3);
  const declared = /* @__PURE__ */ new Set([0, 1]);
  for (const c of flat) assert.ok(declared.has(c), `flattened text cited [S${c + 1}] which no item declared`);
});
test("flattenToMarkdown: contradiction / stale / unverified footnotes render when present", () => {
  const md = flattenToMarkdown({
    ...sampleAnswer,
    contradiction_note: "[S1] says the controller approves; [S2] says the partner does.",
    stale_sources: [{ id: "t9", title: "Old Vendor Policy" }],
    unverified_used: true
  }, "PARTIAL");
  assert.ok(md.includes("_[S1] says the controller approves; [S2] says the partner does._"));
  assert.ok(md.includes("overdue for review: Old Vendor Policy"));
  assert.ok(md.includes("_Based on unverified knowledge._"));
});
test("parity: validateSections / classifySectionAuthority / deriveAnswerStatus ignore embeddings", () => {
  const mk = (withEmb) => [
    rc({ id: "0", source_authority: "policy", chunk_type: "sop_step" }, withEmb),
    rc({ id: "1", source_authority: "notes", chunk_type: "approval" }, withEmb)
  ];
  const sectionsInput = {
    directAnswer: { text: "answer [S1]", citations: [0] },
    sections: [
      { key: "steps", items: [{ text: "step [S1]", citations: [0] }] },
      { key: "approvals", items: [{ text: "approver [S2]", citations: [1] }] }
    ]
  };
  const run = (withEmb) => {
    const ranked = mk(withEmb);
    const { sections, directAnswerValid } = validateSections(sectionsInput);
    return {
      keys: sections.map((s) => s.key),
      directAnswerValid,
      auth: sections.map((s) => classifySectionAuthority(s.items.flatMap((i) => i.citations), ranked)),
      status: deriveAnswerStatus({
        baseBand: "high",
        directAnswerValid,
        requestedFacets: ["steps", "approvals"],
        survivingSectionKeys: sections.map((s) => s.key),
        contradictionNoteKept: false
      })
    };
  };
  assert.deepEqual(run(true), run(false));
  assert.deepEqual(run(false).status, { status: "HIGH", missingFacets: [] });
  assert.deepEqual(run(false).auth, ["authoritative", "advisory"]);
});
test("deriveAnswerStatus: base band medium -> PARTIAL, never HIGH", () => {
  const r = deriveAnswerStatus({
    ...baseInput,
    baseBand: "medium",
    requestedFacets: ["steps"],
    survivingSectionKeys: ["steps"]
    // facet fully covered
  });
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(r.missingFacets, []);
  const r2 = deriveAnswerStatus({
    ...baseInput,
    baseBand: "medium",
    requestedFacets: ["steps", "approvals"],
    survivingSectionKeys: ["steps"]
  });
  assert.equal(r2.status, "PARTIAL");
  assert.deepEqual(r2.missingFacets, ["approvals"]);
  assert.equal(deriveAnswerStatus({ ...baseInput, baseBand: "high", requestedFacets: ["steps"], survivingSectionKeys: ["steps"] }).status, "HIGH");
});
test("OPERATIONAL_SECTION_KEYS is the requested-facet vocabulary and has no dupes", () => {
  assert.equal(new Set(OPERATIONAL_SECTION_KEYS).size, OPERATIONAL_SECTION_KEYS.length);
  assert.deepEqual(validateRequestedFacets([...OPERATIONAL_SECTION_KEYS]), [...OPERATIONAL_SECTION_KEYS]);
});
