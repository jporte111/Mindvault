#!/usr/bin/env node
// Local entry point for the RAG evaluation harness.
//
//   node scripts/rag-eval/run.mjs
//
// Runs the pure-module test suite (scope gate, hybrid ranking, dedupe,
// confidence gate, citation parsing) against in-memory fixtures. This step
// touches NOTHING in Base44 — no reads, no writes.
//
// The retrieval-QUALITY checks (semantic recall on paraphrased questions,
// hybrid vs semantic-only, conversation rewrite, end-to-end citations) need
// real embeddings over real indexed data. Run those with the admin-only
// `ragEval` backend function against a Base44 environment, feeding it
// scripts/rag-eval/cases.example.jsonl (copy to cases.jsonl and expand).
//
// The seeded client-isolation end-to-end test WRITES fixture records to
// Base44 and must be run deliberately and separately:
//   node scripts/rag-eval/seed-isolation.mjs --i-understand-this-writes-to-base44
//   node scripts/rag-eval/cleanup.mjs        # deterministic teardown

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const r = spawnSync(
  process.execPath,
  ['--test', join(here, 'retrieval.test.mjs')],
  { stdio: 'inherit' },
);

process.exit(r.status ?? 1);
