/**
 * `runCodex` parses codex-cli 0.152.0's measured output shapes correctly, and never throws.
 *
 * The three `fixtures/codex-*.jsonl` files are RAW captures from the real binary
 * (`codex.ts`'s header records the exact commands and what each measured) — this file replays
 * them through `fixtures/fake-codex.mjs`, a stand-in that accepts the same argv `runCodex` builds
 * and reproduces a chosen fixture's bytes, so the parsing code runs against a real child process
 * without a network call.
 *
 * `codex-success.jsonl` was RECAPTURED 2026-09-03 (review finding: the previous capture predated
 * `-c shell_environment_policy.inherit=none` and `--strict-config`, so its token count matched the
 * WITHOUT-`--ignore-user-config` figure the header cites as the bad case) — the exact argv
 * `runCodex` builds today, `-c approval_policy=never -c shell_environment_policy.inherit=none
 * --strict-config --skip-git-repo-check --ephemeral --ignore-user-config`, against a schema already
 * run through `toStrictJsonSchema`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCodex, toStrictJsonSchema } from '../dist/codex.js';
import { GENERATION_SCHEMA } from '../dist/prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = resolve(HERE, 'fixtures/fake-codex.mjs');
const fixture = (name) => resolve(HERE, 'fixtures', name);

/** Run with MODKIT_CODEX_BIN and the given FAKE_CODEX_* env vars set only for this call. */
async function withFakeCodex(env, fn) {
  const bin = process.env['MODKIT_CODEX_BIN'];
  const keys = Object.keys(env);
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env['MODKIT_CODEX_BIN'] = FAKE_CODEX;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    if (bin === undefined) delete process.env['MODKIT_CODEX_BIN'];
    else process.env['MODKIT_CODEX_BIN'] = bin;
    for (const k of keys) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Success — fixtures/codex-success.jsonl (a plain schema-constrained turn)
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: parses a successful turn — usage from turn.completed, answer from the -o file', async () => {
  const usages = [];
  const result = await withFakeCodex(
    {
      FAKE_CODEX_STDOUT_FILE: fixture('codex-success.jsonl'),
      FAKE_CODEX_LASTMSG: '{"greeting":"hello"}',
    },
    () =>
      runCodex({
        prompt: 'say hello',
        schema: { type: 'object', properties: { greeting: { type: 'string' } } },
        source: 'test-codex',
        onUsage: (u) => usages.push(u),
      }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { greeting: 'hello' });
  assert.equal(result.text, '{"greeting":"hello"}');
  // No model was passed and codex's `--json` output names no served model (MEASURED) — 'default'
  // is an honest placeholder, not a claim about what actually answered.
  assert.equal(result.model, 'default');

  const row = result.usage.models[0];
  assert.equal(row.model, 'default');
  assert.equal(row.inputTokens, 13879);
  assert.equal(row.outputTokens, 17);
  assert.equal(row.cacheReadInputTokens, 0);
  assert.equal(row.cacheCreationInputTokens, 0);
  assert.equal(row.costUsd, null, 'codex reports no dollar cost anywhere in --json output');
  assert.equal(row.canonicalModel, null);
  assert.equal(result.usage.totalCostUsd, null);
  assert.equal(result.usage.sessionId, '01a06497-af66-77d3-92dc-e07e49432c16', 'thread_id from thread.started');
  assert.equal(result.usage.uuid, null);
  assert.equal(typeof result.usage.durationMs, 'number');

  assert.equal(usages.length, 1, 'onUsage fires exactly once on success');
  assert.deepEqual(usages[0], result.usage);
});

test('runCodex: an explicit model is reported back, but is not a confirmation of what served the call', async () => {
  const result = await withFakeCodex(
    { FAKE_CODEX_STDOUT_FILE: fixture('codex-success.jsonl'), FAKE_CODEX_LASTMSG: '{"greeting":"hello"}' },
    () => runCodex({ prompt: 'say hello', model: 'gpt-5.1-fake', schema: { type: 'object' }, source: 'test-codex' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.1-fake');
  assert.equal(result.usage.models[0].model, 'gpt-5.1-fake');
});

/* ────────────────────────────────────────────────────────────────────────────
 * reasoning_output_tokens is a SUBSET of output_tokens, not additional (MEASURED,
 * codex-sandbox-denied-write.jsonl: output_tokens 229 >= reasoning_output_tokens 71)
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: outputTokens is output_tokens as reported, not output_tokens + reasoning_output_tokens', async () => {
  const result = await withFakeCodex(
    {
      FAKE_CODEX_STDOUT_FILE: fixture('codex-sandbox-denied-write.jsonl'),
      FAKE_CODEX_LASTMSG: '{"greeting":"Command failed: touch: pwned.txt: Operation not permitted"}',
    },
    () => runCodex({ prompt: 'touch a file', schema: { type: 'object' }, source: 'test-codex' }),
  );
  assert.equal(result.ok, true);
  const row = result.usage.models[0];
  assert.equal(row.inputTokens, 28109);
  assert.equal(row.outputTokens, 229);
  assert.equal(row.cacheReadInputTokens, 13696);
  assert.equal(row.cacheCreationInputTokens, 0);
  assert.match(result.json.greeting, /Operation not permitted/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Failure — fixtures/codex-bogus-model-fail.jsonl (exit 1, empty stderr, everything on stdout)
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: a failed turn resolves { ok: false }, never a rejection, with no usage row', async () => {
  const result = await withFakeCodex(
    { FAKE_CODEX_STDOUT_FILE: fixture('codex-bogus-model-fail.jsonl'), FAKE_CODEX_EXIT: '1' },
    () => runCodex({ prompt: 'say hello', model: 'bogus-model-xyz', source: 'test-codex' }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not supported when using Codex with a ChatGPT account/);
  assert.equal(result.usage, null, 'no turn.completed event in this fixture — no row to report');
});

test('runCodex: a failed call that DID produce usage carries it on `result.usage`, not through onUsage', async () => {
  // Same shape claude.ts uses: onUsage fires only on success; a failure's usage rides back on the
  // result object, and the CALLER records it (generate.ts's `if (!first.ok) { if (first.usage)
  // record(first.usage); }`). Firing onUsage here too would double the ledger row.
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
    }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'something went wrong after usage was already spent' } }),
  ].join('\n');
  const usages = [];
  const result = await withFakeCodex({ FAKE_CODEX_STDOUT: stdout, FAKE_CODEX_EXIT: '1' }, () =>
    runCodex({ prompt: 'x', source: 'test-codex', onUsage: (u) => usages.push(u) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.usage, 'a failed call can still have consumed tokens');
  assert.equal(result.usage.models[0].inputTokens, 5);
  assert.equal(usages.length, 0, 'onUsage must not fire on the failure path — the caller records result.usage instead');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Schema violation — SYNTHETIC. MEASURED on codex-cli 0.152.0: --output-schema is enforced by the
 * API itself (structured outputs), and asking the model to "ignore the schema" still produced
 * valid JSON. This exercises the code path that would fire if that contract ever changes, using a
 * fake binary rather than a real transcript, because a real one could not be produced.
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: synthetic schema violation — an unparseable -o file is a clean refusal, not a throw', async () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    }),
  ].join('\n');
  const result = await withFakeCodex(
    { FAKE_CODEX_STDOUT: stdout, FAKE_CODEX_LASTMSG: 'not json at all, sorry' },
    () => runCodex({ prompt: 'x', schema: { type: 'object' }, source: 'test-codex' }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /schema output was not JSON/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Missing binary and a hung process — both resolve, neither throws
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: a missing binary resolves { ok: false }, not a rejection', async () => {
  const prior = process.env['MODKIT_CODEX_BIN'];
  process.env['MODKIT_CODEX_BIN'] = '/nonexistent/codex-binary-that-does-not-exist';
  try {
    const result = await runCodex({ prompt: 'x', source: 'test-codex' });
    assert.equal(result.ok, false);
    assert.match(result.error, /codex-binary-that-does-not-exist/);
    assert.equal(result.usage, null);
  } finally {
    if (prior === undefined) delete process.env['MODKIT_CODEX_BIN'];
    else process.env['MODKIT_CODEX_BIN'] = prior;
  }
});

test('runCodex: a hung process is killed after timeoutMs, reported as ok:false', async () => {
  const result = await withFakeCodex({ FAKE_CODEX_HANG: '1' }, () =>
    runCodex({ prompt: 'x', source: 'test-codex', timeoutMs: 300 }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /^killed by/);
});

test('runCodex: an already-aborted signal never spawns the child', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await withFakeCodex({ FAKE_CODEX_EXIT: '0' }, () =>
    runCodex({ prompt: 'x', source: 'test-codex', signal: controller.signal }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cancelled before the model was called');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Review finding: nothing pinned the actual argv `runCodex` builds, so every safety flag this
 * file's header spends four paragraphs justifying could be deleted with the suite still green.
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: builds the exact expected argv — the whole sandbox argument rests on this not silently drifting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modkit-codex-argv-test-'));
  const argvFile = join(dir, 'argv.json');
  try {
    const result = await withFakeCodex(
      { FAKE_CODEX_ARGV_FILE: argvFile, FAKE_CODEX_STDOUT_FILE: fixture('codex-success.jsonl'), FAKE_CODEX_LASTMSG: '{"greeting":"hi"}' },
      () => runCodex({ prompt: 'say hello', schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] }, source: 'test-codex' }),
    );
    assert.equal(result.ok, true);

    const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
    const cIdx = argv.indexOf('-C');
    const oIdx = argv.indexOf('-o');
    const schemaIdx = argv.indexOf('--output-schema');
    assert.ok(cIdx >= 0 && argv[cIdx + 1], '-C <dir> present with a value');
    assert.ok(oIdx >= 0 && argv[oIdx + 1].endsWith('output.txt'), '-o <file> present, inside the -C dir');
    assert.ok(schemaIdx >= 0 && argv[schemaIdx + 1].endsWith('schema.json'), '--output-schema present when a schema was passed');

    // Strip the three dynamic values (the -C dir and the two files it contains) so the rest can be
    // compared as an exact, ordered list — every flag here is load-bearing (see the file header).
    const dynamic = new Set([argv[cIdx + 1], argv[oIdx + 1], argv[schemaIdx + 1]]);
    const stable = argv.filter((a) => !dynamic.has(a));
    assert.deepEqual(stable, [
      'exec',
      '-',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=never',
      '-c',
      'shell_environment_policy.inherit=none',
      '--strict-config',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '-C',
      '-o',
      '--output-schema',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodex: omits --output-schema with no schema, and --model when model is falsy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modkit-codex-argv-test-'));
  const argvFile = join(dir, 'argv.json');
  try {
    await withFakeCodex({ FAKE_CODEX_ARGV_FILE: argvFile }, () => runCodex({ prompt: 'x', source: 'test-codex' }));
    const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.equal(argv.includes('--output-schema'), false);
    assert.equal(argv.includes('--model'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Review finding: `maxBudgetUsd` was silently dropped with no runtime signal at all.
 * ──────────────────────────────────────────────────────────────────────────── */

test('runCodex: an unenforced maxBudgetUsd is logged, not silently dropped', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await withFakeCodex({ FAKE_CODEX_STDOUT_FILE: fixture('codex-success.jsonl'), FAKE_CODEX_LASTMSG: '{"greeting":"hi"}' }, () =>
    runCodex({ prompt: 'x', maxBudgetUsd: 1.5, source: 'test-codex' }),
  );
  assert.equal(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /maxBudgetUsd=1\.5/);
  assert.match(warn.mock.calls[0].arguments[0], /NOT enforced/);
});

test('runCodex: no maxBudgetUsd means no warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await withFakeCodex({ FAKE_CODEX_STDOUT_FILE: fixture('codex-success.jsonl'), FAKE_CODEX_LASTMSG: '{"greeting":"hi"}' }, () =>
    runCodex({ prompt: 'x', source: 'test-codex' }),
  );
  assert.equal(warn.mock.calls.length, 0);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Review finding: the real GENERATION_SCHEMA is rejected outright by codex's strict-mode API
 * (required must cover every key of properties) — toStrictJsonSchema() is the fix.
 * ──────────────────────────────────────────────────────────────────────────── */

test('toStrictJsonSchema: the real GENERATION_SCHEMA comes out with required covering every property', () => {
  const strict = toStrictJsonSchema(GENERATION_SCHEMA);
  const keys = Object.keys(strict.properties);
  assert.ok(keys.length > 1, 'sanity: GENERATION_SCHEMA actually has more than one property');
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual([...strict.required].sort(), [...keys].sort());
});

test('toStrictJsonSchema: a field that was already required is left alone, not null-widened', () => {
  const strict = toStrictJsonSchema(GENERATION_SCHEMA);
  assert.deepEqual(strict.properties.outcome.enum, ['patch', 'refusal'], 'outcome was already required — no null added');
  assert.equal(strict.properties.outcome.type, 'string');
});

test('toStrictJsonSchema: a field that was optional gets its type and enum widened to allow null', () => {
  const strict = toStrictJsonSchema(GENERATION_SCHEMA);
  // refusalReason: enum, optional in the original schema.
  assert.deepEqual(strict.properties.refusalReason.type, ['string', 'null']);
  assert.ok(strict.properties.refusalReason.enum.includes(null));
  // explanation: plain string, optional... no — explanation IS required; pick a genuinely optional
  // plain-string field instead.
  assert.deepEqual(strict.properties.modName.type, ['string', 'null']);
});

test('toStrictJsonSchema: is schema-agnostic — a small synthetic schema normalizes the same way', () => {
  const strict = toStrictJsonSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a'],
  });
  assert.deepEqual(strict.required.sort(), ['a', 'b']);
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.a.type, 'string', 'a was already required — untouched');
  assert.deepEqual(strict.properties.b.type, ['number', 'null'], 'b was optional — widened');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture sanity — anchors the numbers above to the real captures
 * ──────────────────────────────────────────────────────────────────────────── */

test('fixture sanity: codex-success.jsonl really is the shape these tests assume', () => {
  const lines = readFileSync(fixture('codex-success.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'thread.started');
  const turnCompleted = lines.find((l) => l.type === 'turn.completed');
  assert.ok(turnCompleted, 'fixture must contain a turn.completed event');
  assert.equal(turnCompleted.usage.input_tokens, 13879);
});
