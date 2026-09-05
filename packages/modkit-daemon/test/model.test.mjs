/**
 * `runModel` dispatches on `config.backend` to the right transport, and nowhere else.
 *
 * Both fakes are real, separately-executed child processes (`fixtures/fake-claude.mjs` and
 * `fixtures/fake-codex.mjs`) so this proves the actual dispatch in `model.ts`, not a mocked
 * stand-in for it: each fake answers with a value only it could produce, and the test checks
 * which one came back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runModel } from '../dist/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(HERE, 'fixtures/fake-claude.mjs');
const FAKE_CODEX = resolve(HERE, 'fixtures/fake-codex.mjs');

function withEnv(env, fn) {
  const keys = Object.keys(env);
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
}

test('runModel: backend "codex" calls runCodex, not runClaude', async () => {
  const codexStdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    }),
  ].join('\n');
  const result = await withEnv(
    {
      MODKIT_CODEX_BIN: FAKE_CODEX,
      FAKE_CODEX_STDOUT: codexStdout,
      FAKE_CODEX_LASTMSG: '{"which":"codex"}',
      MODKIT_CLAUDE_BIN: '/nonexistent/should-not-run',
    },
    () => runModel({ prompt: 'x', schema: { type: 'object' }, source: 'test-model' }, { backend: 'codex' }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { which: 'codex' });
});

test('runModel: backend "claude" calls runClaude, not runCodex', async () => {
  const claudeStdout = JSON.stringify([
    {
      type: 'result',
      is_error: false,
      result: '{"which":"claude"}',
      modelUsage: { 'fake-claude-model': { inputTokens: 1, outputTokens: 1 } },
    },
  ]);
  const result = await withEnv(
    { MODKIT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_STDOUT: claudeStdout, MODKIT_CODEX_BIN: '/nonexistent/should-not-run' },
    () => runModel({ prompt: 'x', schema: { type: 'object' }, source: 'test-model' }, { backend: 'claude' }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { which: 'claude' });
  assert.equal(result.model, 'fake-claude-model');
});

test('runModel: with no explicit config, defaults come from resolveConfig() — MODKIT_BACKEND unset means claude', async () => {
  const claudeStdout = JSON.stringify([
    { type: 'result', is_error: false, result: '{"which":"claude-default"}', modelUsage: { m: { inputTokens: 1, outputTokens: 1 } } },
  ]);
  const priorBackend = process.env['MODKIT_BACKEND'];
  delete process.env['MODKIT_BACKEND'];
  try {
    const result = await withEnv(
      { MODKIT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_STDOUT: claudeStdout, MODKIT_CODEX_BIN: '/nonexistent/should-not-run' },
      () => runModel({ prompt: 'x', schema: { type: 'object' }, source: 'test-model' }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { which: 'claude-default' });
  } finally {
    if (priorBackend === undefined) delete process.env['MODKIT_BACKEND'];
    else process.env['MODKIT_BACKEND'] = priorBackend;
  }
});
