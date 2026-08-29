#!/usr/bin/env node
// Seeds two isolated fixture clients (Acme / Beta) with one distinctive fact
// each, for the end-to-end client-isolation test. WRITES to Base44.
//
//   node scripts/rag-eval/seed-isolation.mjs --i-understand-this-writes-to-base44
//
// Every record it creates is marked is_eval_fixture: true and ZZ_RAGEVAL_-
// prefixed. Tear it all down afterwards with cleanup.mjs.

import { buildClient, EVAL_PREFIX, requireAckOrExit } from './_client.mjs';

requireAckOrExit(process.argv);
const base44 = buildClient();

const FIXTURES = [
  { client: `${EVAL_PREFIX}Acme`, fact: 'Acme Holdings closes its books on the 5th of every month and files sales tax quarterly.' },
  { client: `${EVAL_PREFIX}Beta`, fact: 'Beta Retail closes its books on the 12th of every month and files sales tax monthly.' },
];

for (const f of FIXTURES) {
  const client = await base44.entities.Client.create({
    name: f.client,
    status: 'active',
    is_eval_fixture: true,
  });

  const training = await base44.entities.Training.create({
    title: `${EVAL_PREFIX}${f.client} close process`,
    status: 'ready',
    is_eval_fixture: true,
    knowledge_scope: 'client-specific',
    client_id: client.id,
    client_name: f.client,
    summary: f.fact,
    ai_knowledge_entry: f.fact,
    sop_steps: [f.fact],
    decision_rules: [f.fact],
  });

  const res = await base44.functions.invoke('embedKnowledge', { trainingId: training.id });
  console.log(`seeded ${f.client}: client=${client.id} training=${training.id}`, res?.data ?? res);
}

console.log('\nDone. Add the printed client ids to your cases.jsonl isolation cases.');
console.log('Run cleanup.mjs when finished.');
