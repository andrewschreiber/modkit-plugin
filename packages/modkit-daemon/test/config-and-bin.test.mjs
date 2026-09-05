/**
 * The settings file, the CLI resolver, and the two gates that ride on them.
 *
 * These four areas are tested together because they are one story: modkit has to be configurable
 * without env vars, has to find a CLI on a machine whose PATH it did not set, and must not let
 * either of those become a way around the codex acknowledgment.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { withConfigFile, resolveConfig, CONFIG_KEYS, CODEX_SANDBOX_REFUSAL } from '../dist/state.js'
import { resolveBin, binCandidates, missingBinHint } from '../dist/bin.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'modkit-config-'))
}

/* ── the settings file ──────────────────────────────────────────────────────── */

test('a config file supplies settings as if they had been environment variables', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ port: 9999, backend: 'claude', model: 'opus', logLevel: 'debug' }))
    const env = withConfigFile({ MODKIT_CONFIG: file })
    assert.equal(env.MODKIT_PORT, '9999')
    assert.equal(env.MODKIT_BACKEND, 'claude')
    assert.equal(env.MODKIT_MODEL, 'opus')
    assert.equal(env.MODKIT_LOG_LEVEL, 'debug')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit environment variable beats the file — an existing setup does not change under it', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ model: 'from-file', port: 1234 }))
    const env = withConfigFile({ MODKIT_CONFIG: file, MODKIT_MODEL: 'from-env' })
    assert.equal(env.MODKIT_MODEL, 'from-env', 'env must win')
    assert.equal(env.MODKIT_PORT, '1234', 'the file still supplies what env did not')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('booleans become the flag spelling the env reader already understands', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ codexAcknowledgeSandbox: true }))
    assert.equal(withConfigFile({ MODKIT_CONFIG: file }).MODKIT_CODEX_ACKNOWLEDGE_SANDBOX, '1')
    writeFileSync(file, JSON.stringify({ codexAcknowledgeSandbox: false }))
    assert.equal(withConfigFile({ MODKIT_CONFIG: file }).MODKIT_CODEX_ACKNOWLEDGE_SANDBOX, '0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown setting is refused by name, and the message lists what is accepted', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ portt: 8501 }))
    assert.throws(() => withConfigFile({ MODKIT_CONFIG: file }), (e) => {
      assert.match(e.message, /unknown setting "portt"/)
      assert.match(e.message, /backend/, 'the message should list the known settings')
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed config file throws rather than being silently skipped', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, '{ not json')
    assert.throws(() => withConfigFile({ MODKIT_CONFIG: file }), /not valid JSON/)
    writeFileSync(file, '[1,2,3]')
    assert.throws(() => withConfigFile({ MODKIT_CONFIG: file }), /must contain a JSON object/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing config file is simply absent — not an error', () => {
  const env = withConfigFile({ MODKIT_CONFIG: join(tmpdir(), 'modkit-does-not-exist-9e7f.json') })
  assert.equal(env.MODKIT_PORT, undefined)
})

test('the whole config file round-trips through resolveConfig', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ port: 8777, model: 'haiku', stateDir: join(dir, 'state'), concurrency: 2 }))
    const config = resolveConfig({ MODKIT_CONFIG: file })
    assert.equal(config.port, 8777)
    assert.equal(config.model, 'haiku')
    assert.equal(config.concurrency, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every documented key maps to a MODKIT_ variable, so the table can be the documentation', () => {
  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    assert.match(envName, /^MODKIT_[A-Z0-9_]+$/, `${key} maps to ${envName}`)
  }
  assert.ok(Object.keys(CONFIG_KEYS).length >= 14)
})

/* ── the codex gate ─────────────────────────────────────────────────────────── */

test('a config file cannot turn on codex without the acknowledgment', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify({ backend: 'codex' }))
    assert.throws(() => resolveConfig({ MODKIT_CONFIG: file }), /MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the acknowledgment is resolved even when the daemon booted on claude', () => {
  const onClaude = resolveConfig({ MODKIT_BACKEND: 'claude' })
  assert.equal(onClaude.codexAcknowledged, false)
  const acknowledged = resolveConfig({ MODKIT_BACKEND: 'claude', MODKIT_CODEX_ACKNOWLEDGE_SANDBOX: '1' })
  assert.equal(acknowledged.codexAcknowledged, true, 'a claude daemon can still permit a codex override')
})

test('the refusal sentence names the measured risk, not just the variable', () => {
  assert.match(CODEX_SANDBOX_REFUSAL, /READ access/)
  assert.match(CODEX_SANDBOX_REFUSAL, /MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1/)
})

/* ── finding the CLI ────────────────────────────────────────────────────────── */

test('an explicit override is checked before anything on PATH', () => {
  const dir = tempDir()
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, '#!/bin/sh\necho hi\n')
    chmodSync(bin, 0o755)
    const resolved = resolveBin('claude', { MODKIT_CLAUDE_BIN: bin, PATH: '/usr/bin' })
    assert.equal(resolved.path, bin)
    assert.equal(resolved.fromOverride, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CLI on PATH is found without an override', () => {
  const dir = tempDir()
  try {
    const bin = join(dir, 'codex')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    const resolved = resolveBin('codex', { PATH: dir })
    assert.equal(resolved.path, bin)
    assert.equal(resolved.fromOverride, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-executable file of the right name is not accepted as the CLI', () => {
  const dir = tempDir()
  try {
    const bin = join(dir, 'claude')
    writeFileSync(bin, 'not executable')
    chmodSync(bin, 0o644)
    assert.equal(resolveBin('claude', { PATH: dir, HOME: dir }).path, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nothing found reports null and names where it looked', () => {
  const dir = tempDir()
  try {
    const resolved = resolveBin('claude', { PATH: join(dir, 'nowhere'), HOME: dir })
    assert.equal(resolved.path, null)
    assert.ok(resolved.searched.length > 0, 'a "not found" must be able to say where it looked')
    assert.match(missingBinHint('claude'), /MODKIT_CLAUDE_BIN/)
    assert.match(missingBinHint('codex'), /MODKIT_CODEX_BIN/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the search covers the installer locations that a daemon PATH misses', () => {
  const candidates = binCandidates('claude', { PATH: '/usr/bin', HOME: '/home/someone' })
  assert.ok(candidates.includes('/home/someone/.local/bin/claude'), 'the claude installer default')
  assert.ok(candidates.includes('/home/someone/.claude/local/claude'), 'the self-update location')
  assert.ok(candidates.some((c) => c.includes('/opt/homebrew/')), 'apple-silicon homebrew')
  assert.ok(candidates.indexOf('/usr/bin/claude') < candidates.indexOf('/home/someone/.local/bin/claude'),
    'PATH is searched before the guesses')
})

/* ── the documentation ──────────────────────────────────────────────────────── */

test('AGENTS.md documents every setting, and invents none', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const doc = readFileSync(join(repo, 'AGENTS.md'), 'utf8')

  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    assert.ok(doc.includes(`\`${key}\``), `AGENTS.md does not document the setting "${key}"`)
    assert.ok(doc.includes(envName), `AGENTS.md does not mention ${envName}`)
  }

  // The reverse direction: a MODKIT_ variable named in the table must be real, or the doc is
  // telling an agent to set something nothing reads.
  const known = new Set(Object.values(CONFIG_KEYS))
  const extras = ['MODKIT_CONFIG'] // documented, read by withConfigFile itself rather than via the table
  for (const m of doc.matchAll(/\|\s*`?(MODKIT_[A-Z0-9_]+)`?\s*\|/g)) {
    const name = m[1]
    assert.ok(known.has(name) || extras.includes(name), `AGENTS.md documents ${name}, which nothing reads`)
  }
})

test('the example config only uses keys the loader accepts', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const example = JSON.parse(readFileSync(join(repo, 'modkit.config.example.json'), 'utf8'))
  const dir = tempDir()
  try {
    const file = join(dir, 'modkit.config.json')
    writeFileSync(file, JSON.stringify(example))
    // Would throw on any unknown key — which is the whole assertion.
    const env = withConfigFile({ MODKIT_CONFIG: file })
    assert.equal(env.MODKIT_BACKEND, 'claude')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the search list is deduplicated — a real PATH repeats itself', () => {
  const repetitive = ['/a', '/b', '/a', '/b', '/a'].join(':')
  const candidates = binCandidates('claude', { PATH: repetitive, HOME: '/home/someone' })
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicates may reach a user-facing list')
  assert.ok(candidates.includes('/a/claude') && candidates.includes('/b/claude'))
})
