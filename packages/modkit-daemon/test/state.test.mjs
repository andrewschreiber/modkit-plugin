/**
 * `resolveConfig()`'s `MODKIT_BACKEND` parsing (L8): default, explicit values, the
 * explicit-error-by-name rejection `MODKIT_LOG_LEVEL` already uses, the backend-aware
 * `MODKIT_MODEL` default this state.ts change is really for — `''` for codex (meaning "omit
 * `--model`, never guess one"), `'sonnet'` for claude, an explicit `MODKIT_MODEL` overriding
 * either — and the `MODKIT_CODEX_ACKNOWLEDGE_SANDBOX` gate (review finding: codex's shell tool has
 * machine-wide filesystem read access under every sandbox flag on codex-cli 0.152.0, so switching
 * the backend on must be a deliberate, named act).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../dist/state.js';

/** A minimal, valid env — resolveConfig() only needs MODKIT_STATE_DIR set to skip repo-root probing. */
function baseEnv(overrides = {}) {
  return { MODKIT_STATE_DIR: '/tmp/modkit-state-test-does-not-need-to-exist', ...overrides };
}

/** baseEnv() plus the codex sandbox acknowledgment, for tests that are about something else. */
function codexEnv(overrides = {}) {
  return baseEnv({ MODKIT_BACKEND: 'codex', MODKIT_CODEX_ACKNOWLEDGE_SANDBOX: '1', ...overrides });
}

test('resolveConfig: MODKIT_BACKEND unset defaults to claude, with the claude model default', () => {
  const config = resolveConfig(baseEnv());
  assert.equal(config.backend, 'claude');
  assert.equal(config.model, 'sonnet');
});

test('resolveConfig: MODKIT_BACKEND=codex without the sandbox acknowledgment is refused, not silently allowed', () => {
  assert.throws(
    () => resolveConfig(baseEnv({ MODKIT_BACKEND: 'codex' })),
    /MODKIT_CODEX_ACKNOWLEDGE_SANDBOX/,
    'codex can read any file this process can read under every sandbox flag 0.152.0 offers — opting in must be explicit',
  );
});

test('resolveConfig: MODKIT_BACKEND=codex with the acknowledgment switches the model default to "" (omit --model)', () => {
  const config = resolveConfig(codexEnv());
  assert.equal(config.backend, 'codex');
  assert.equal(config.model, '', 'empty, not a guessed model name — runCodex omits --model on falsy model');
});

test('resolveConfig: MODKIT_BACKEND is case-insensitive, like MODKIT_LOG_LEVEL', () => {
  const config = resolveConfig(codexEnv({ MODKIT_BACKEND: 'CODEX' }));
  assert.equal(config.backend, 'codex');
});

test('resolveConfig: MODKIT_CODEX_ACKNOWLEDGE_SANDBOX also accepts "true" and "yes", case-insensitively', () => {
  assert.equal(resolveConfig(codexEnv({ MODKIT_CODEX_ACKNOWLEDGE_SANDBOX: 'TRUE' })).backend, 'codex');
  assert.equal(resolveConfig(codexEnv({ MODKIT_CODEX_ACKNOWLEDGE_SANDBOX: 'yes' })).backend, 'codex');
  assert.throws(() => resolveConfig(codexEnv({ MODKIT_CODEX_ACKNOWLEDGE_SANDBOX: '0' })), /MODKIT_CODEX_ACKNOWLEDGE_SANDBOX/);
});

test('resolveConfig: an explicit MODKIT_MODEL overrides the backend-aware default either way', () => {
  const claudeConfig = resolveConfig(baseEnv({ MODKIT_MODEL: 'opus' }));
  assert.equal(claudeConfig.model, 'opus');
  const codexConfig = resolveConfig(codexEnv({ MODKIT_MODEL: 'some-codex-model' }));
  assert.equal(codexConfig.model, 'some-codex-model');
});

test('resolveConfig: an unknown MODKIT_BACKEND is refused by name, not silently defaulted', () => {
  assert.throws(() => resolveConfig(baseEnv({ MODKIT_BACKEND: 'bogus' })), /MODKIT_BACKEND must be claude\|codex, got "bogus"/);
});
