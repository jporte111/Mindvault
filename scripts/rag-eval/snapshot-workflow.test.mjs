// Phase 9 P9-1 — the 'Monthly Knowledge Health Snapshot' scheduled workflow and
// the knowledge_health_snapshots_enabled AppConfig flag.
//   node --test scripts/rag-eval/snapshot-workflow.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HERE = new URL('.', import.meta.url);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const appConfig = JSON.parse(stripComments(readFileSync(new URL('../../base44/entities/AppConfig.jsonc', HERE), 'utf8')));
const workflow = JSON.parse(stripComments(readFileSync(new URL('../../base44/workflows/Monthly Knowledge Health Snapshot.jsonc', HERE), 'utf8')));
const task = workflow.definition.do[0][Object.keys(workflow.definition.do[0])[0]];

test('AppConfig: knowledge_health_snapshots_enabled is boolean, default false', () => {
  const p = appConfig.properties.knowledge_health_snapshots_enabled;
  assert.ok(p, 'flag missing from AppConfig');
  assert.equal(p.type, 'boolean');
  assert.equal(p.default, false);
});

test('AppConfig: existing flags are untouched (defaults + presence)', () => {
  for (const k of ['knowledge_health_enabled', 'notifications_enabled', 'source_lifecycle_enabled', 'knowledge_gaps_enabled']) {
    assert.equal(appConfig.properties[k]?.default, false, `${k} default changed`);
  }
  assert.equal(appConfig.properties.governance_ranking_enabled.default, true, 'governance_ranking_enabled default changed');
  assert.deepEqual(appConfig.required, ['key']);
});

test('workflow: scheduled, recurring, monthly on the 1st at 06:00 America/New_York, never ends', () => {
  assert.equal(workflow.name, 'Monthly Knowledge Health Snapshot');
  assert.equal(workflow.trigger.config.trigger_type, 'scheduled');
  assert.equal(workflow.trigger.config.schedule_mode, 'recurring');
  assert.equal(workflow.trigger.config.cron_expression, '0 6 1 * *');
  assert.equal(workflow.trigger.config.timezone, 'America/New_York');
  assert.equal(workflow.trigger.config.ends_type, 'never');
});

test('workflow: its single task invokes only captureKnowledgeHealthSnapshot, in write mode', () => {
  assert.equal(workflow.definition.do.length, 1);
  assert.equal(task.call, 'invoke_backend_function');
  assert.equal(task.with.function_name, 'captureKnowledgeHealthSnapshot');
  assert.deepEqual(task.with.args, { dryRun: false });
  assert.equal(task.then, 'end');
  const names = [...JSON.stringify(workflow).matchAll(/"function_name":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['captureKnowledgeHealthSnapshot']);
});

test('workflow: scheduled only — no entity/connector hook, no email', () => {
  const src = JSON.stringify(workflow);
  assert.ok(!/entity_name|connector|integration_type/.test(src), 'must stay a scheduled trigger, not event-hooked');
  assert.ok(!/SendEmail|sendEmail|send_email/i.test(src), 'no email delivery');
});

test('workflow: flag OFF (the default) => the write-mode call is refused, zero rows written', () => {
  // The workflow calls with { dryRun: false }. captureKnowledgeHealthSnapshot
  // refuses the write while knowledge_health_snapshots_enabled is false — the
  // refusal precedes any planning or write (asserted in snapshot-capture.test.mjs).
  assert.equal(appConfig.properties.knowledge_health_snapshots_enabled.default, false);
  assert.equal(task.with.args.dryRun, false); // write mode
});
