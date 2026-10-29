// AppConfig entity contract: retrieval_mode vocabulary + admin-only-write RLS.
// AppConfig.retrieval_mode is an admin system setting that can force paid
// semantic embedding calls, so non-admins must not be able to mutate it.
//   node --test scripts/rag-eval/appconfig.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const jsonc = readFileSync(resolve(repo, 'base44/entities/AppConfig.jsonc'), 'utf8');
const schema = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ''));
const props = schema.properties;

test('retrieval_mode is auto|lexical|semantic, default auto', () => {
  assert.deepEqual(props.retrieval_mode.enum, ['auto', 'lexical', 'semantic']);
  assert.equal(props.retrieval_mode.default, 'auto');
});

test('AppConfig reads and writes are admin-only (members read the allowlist via getAppSettings)', () => {
  assert.ok(schema.rls, 'AppConfig has no rls block — any authenticated user could flip retrieval_mode');
  for (const op of ['create', 'update', 'delete']) {
    assert.deepEqual(
      schema.rls[op],
      { user_condition: { role: 'admin' } },
      `AppConfig.rls.${op} is not admin-gated`,
    );
  }
  // The Chat page reads engine routing through getAppSettings (member
  // allowlist); direct reads would expose every administrative switch.
  assert.deepEqual(schema.rls.read, { user_condition: { role: 'admin' } }, 'AppConfig direct read must be admin-only');
});

test('existing chat-engine fields are untouched by this change', () => {
  assert.deepEqual(props.chat_engine.enum, ['legacy', 'rag']);
  assert.equal(props.chat_engine.default, 'legacy');
  assert.equal(props.rag_rollout_pct.default, 0);
  assert.deepEqual(schema.required, ['key']);
});

test('Phase 6: source_lifecycle_enabled exists and defaults to false', () => {
  assert.ok(props.source_lifecycle_enabled, 'source_lifecycle_enabled flag missing');
  assert.equal(props.source_lifecycle_enabled.type, 'boolean');
  assert.equal(props.source_lifecycle_enabled.default, false);
});

test('Phase 6: NO freshness_warnings_enabled flag (freshness is admin/Phase-7 data only)', () => {
  assert.equal(props.freshness_warnings_enabled, undefined,
    'Phase 6 must not add an answer-path freshness flag');
});

test('Phase 6: optional vocabulary / taxonomy overrides are string (JSON) and default-absent', () => {
  assert.equal(props.lifecycle_vocabulary?.type, 'string');
  assert.equal(props.lifecycle_vocabulary?.default, undefined);
  assert.equal(props.source_taxonomy?.type, 'string');
  assert.equal(props.source_taxonomy?.default, undefined);
});
