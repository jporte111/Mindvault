#!/usr/bin/env node
// Deterministic teardown of RAG eval fixtures. Deletes ONLY records that
// carry the eval marker (is_eval_fixture: true or a ZZ_RAGEVAL_ name/title).
// Safe to run repeatedly. WRITES to Base44 (deletes).
//
//   node scripts/rag-eval/cleanup.mjs --i-understand-this-writes-to-base44

import { buildClient, isEvalFixture, requireAckOrExit } from './_client.mjs';

requireAckOrExit(process.argv);
const base44 = buildClient();

let deleted = 0;

// KnowledgeChunks first (they reference trainings). Match by fixture training.
const fixtureTrainings = (await base44.entities.Training.list('-created_date', 5000)).filter(isEvalFixture);
const fixtureTrainingIds = new Set(fixtureTrainings.map((t) => t.id));

const allChunks = await base44.entities.KnowledgeChunk.list('-created_date', 5000);
for (const ch of allChunks) {
  if (ch.is_eval_fixture === true || fixtureTrainingIds.has(ch.training_id)) {
    await base44.entities.KnowledgeChunk.delete(ch.id);
    deleted++;
  }
}

for (const t of fixtureTrainings) {
  await base44.entities.Training.delete(t.id);
  deleted++;
}

const fixtureClients = (await base44.entities.Client.list('name', 5000)).filter(isEvalFixture);
for (const c of fixtureClients) {
  await base44.entities.Client.delete(c.id);
  deleted++;
}

console.log(`Removed ${deleted} eval fixture record(s). Nothing without the eval marker was touched.`);
