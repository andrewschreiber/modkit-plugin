/**
 * `codex.ts` — the second model transport, beside `claude.ts`.
 *
 * `runCodex<T>(opts)` has the SAME options and result shape as `runClaude` (L8) — same
 * `RunClaudeOptions`/`RunClaudeResult`/`RunUsage`, imported from `./claude.js` rather than
 * redeclared, so `model.ts` can dispatch between the two without either caller knowing which one
 * answered. Everything else is a fresh reimplementation: `codex exec`'s shape shares almost
 * nothing with `claude -p`'s, and copying flags without re-measuring them is exactly the mistake
 * `claude.ts`'s own header warns about.
 *
 * Measured against **codex-cli 0.152.0** on this box, 2026-09-02. Raw transcripts are saved as
 * `test/fixtures/codex-*.jsonl` (success, bogus-model failure, and the sandbox-blocked-write
 * case) — read those before trusting a claim below over them.
 *
 * ## What `--json` actually emits
 *
 * A JSONL stream of events on stdout, not one object. The ones this module reads:
 *   - `{"type":"thread.started","thread_id":"…"}` — once, first line. `thread_id` is the closest
 *     thing to claude's `session_id`.
 *   - `{"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
 *     "cache_write_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}` — the only
 *     place usage appears. **Flat, not per-model** — unlike claude's `modelUsage`, there is no
 *     breakdown to fall back on, and no field anywhere names which model actually served the
 *     call. `reasoning_output_tokens` measured as a SUBSET of `output_tokens` (a schema-only
 *     turn: `output_tokens:28` with `reasoning_output_tokens:11`), so it is not added on top.
 *   - `{"type":"turn.failed","error":{"message":"…"}}` and a bare `{"type":"error",…}` — present
 *     on failure; `fixtures/codex-bogus-model-fail.jsonl` has both, plus an exit code of 1 and an
 *     EMPTY stderr (the whole diagnosis lives on stdout, same trap `claude.ts` documents for its
 *     own CLI).
 *
 * ## Where the structured answer actually lands
 *
 * **The `-o/--output-last-message <FILE>` file, not the JSONL.** With `--output-schema`, the
 * model's final turn is schema-constrained by the API itself (OpenAI structured outputs) — MEASURED
 * by asking it to "ignore the schema" and reply with plain text; it still returned
 * `{"count":0}`. So unlike `claude.ts`'s `structured_output` vs. string-`result` fallback, there is
 * only one shape to parse, and no observed way to make codex violate its own schema — the
 * "schema-violation path" `codex.ts`'s header was asked to measure could not be produced on this
 * version. A multi-item turn can still emit more than one `item.completed` `agent_message` (seen
 * once, chasing a sandbox-denied shell command), which is exactly why the `-o` file — "the LAST
 * message" by the CLI's own description — is read instead of scanning the JSONL for the answer.
 *
 * **The schema itself must set `additionalProperties: false` AND `required` covering every key in
 * `properties`, at every object level, or codex refuses the call outright.** This is OpenAI
 * structured-outputs "strict mode", surfaced through `--output-schema` — MEASURED twice, both as
 * `exit 1` / `invalid_json_schema` before any turn runs:
 *   - an ad-hoc schema missing `additionalProperties: false` — `"'additionalProperties' is required
 *     to be supplied and to be false"`.
 *   - **`prompt.ts`'s real `GENERATION_SCHEMA`** — 24 properties, `required: ['outcome',
 *     'explanation']`, which is the ordinary "optional fields just aren't in `required`" shape every
 *     other schema in this codebase uses — `"'required' is required to be supplied and to be an
 *     array including every key in properties. Missing 'refusalReason'"`. An earlier revision of this
 *     file read the first measurement and reasoned the second case away ("the one real caller already
 *     sets it") without running it; it does not, and `MODKIT_BACKEND=codex` could not complete a
 *     single real generation as a result. Caught by re-running the acceptance smoke test against the
 *     actual `GENERATION_SCHEMA` instead of a one-property toy schema.
 *
 *   `toStrictJsonSchema()` below fixes this mechanically, for any schema, before it is written to
 *   `--output-schema`: every object's `required` becomes all of its `properties`, and a field that
 *   was *not* originally required has its `type` (and `enum`, if any) widened to also accept `null`
 *   — OpenAI's documented way to keep a field optional once `required` can no longer omit it. The
 *   caller therefore sees the same "field present with a real value, or absent" shape it always
 *   would: `prompt.ts`'s `parseGenerationOutput` reads every optional field through `str()`, which
 *   already treats anything that is not a `string` — `undefined` *or* `null` — as absent
 *   (`prompt.ts:673-676`), so nothing there needed to change, only verifying that it didn't.
 *
 * ## Sandbox / approval flags — non-interactive, but NOT least-privilege on filesystem reads
 *
 * `codex exec` is not automatically non-interactive-safe. MEASURED: with the CLI's own default
 * approval policy, a prompt that made the model attempt a shell command **hung past a 60s
 * timeout with zero bytes ever written to stdout** — the model was waiting on an approval prompt
 * that a headless run can never answer. `-c approval_policy=never` fixes this: an escalation is
 * then auto-denied (fast, loud, exit 0 or a clear tool-error message) rather than blocking forever.
 *
 * **`--sandbox read-only` confines WRITES to nowhere, not reads to the working directory.** MEASURED
 * (this is a correction — an earlier revision of this file called the combination below "least
 * privilege" and that claim does not survive measurement): `touch pwned.txt` inside `workDir` under
 * this combination returns "Operation not permitted" and the file is never created, but a shell
 * command reading a file OUTSIDE `workDir` — `cat /some/other/path/canary.txt` — runs to completion
 * and returns the contents, machine-wide, exit 0, no denial of any kind. codex-cli 0.152.0 exposes no
 * flag that removes the shell tool itself: `--disable shell` is rejected ("Unknown feature flag:
 * shell"), `-c 'tools.shell=false'` is rejected under `--strict-config` ("unknown configuration field
 * `tools.shell`"), and `-c 'sandbox_permissions=[]'` — the exact example `codex exec --help` itself
 * prints — is *also* rejected the same way, meaning the CLI's own help text names a config key this
 * version does not accept. There is no flag on 0.152.0 equivalent to claude's `--tools ''` (no shell
 * tool at all). This matters here specifically because the generation prompt carries untrusted
 * third-party plugin source: a prompt injection inside a target plugin can make codex read files this
 * process can read — SSH keys, `daemon.token`, vault content — and return them as the generation's
 * `source`, which the pipeline then validates, signs, and offers to install. `state.ts`'s
 * `MODKIT_BACKEND=codex` gate makes an operator say so explicitly (`MODKIT_CODEX_ACKNOWLEDGE_SANDBOX`)
 * rather than this file quietly calling it safe.
 *
 * Two flags added specifically for this: `-c shell_environment_policy.inherit=none` so a spawned
 * shell does not inherit this process's environment (MEASURED: does not change the file-read result
 * above — filesystem access is a sandbox-policy question, not an env one — but keeps whatever secrets
 * live in *this process's* env, as opposed to files on disk, out of a shell run under `codex`'s
 * control), and `--strict-config`, which MEASURED turns an unrecognized `-c` key into a startup error
 * instead of a silent no-op — load-bearing if a future codex release renames `approval_policy` out
 * from under this file: without it, the safety override would vanish quietly and the timeout-hang
 * this file exists to prevent would come back with no signal at all.
 *
 * `--ignore-user-config` skips `~/.codex/config.toml` (profiles, MCP servers, personal
 * instructions) — the same reason `claude.ts` uses `--safe-mode`: a headless generation call must
 * not inherit whoever's machine it runs on. MEASURED as load-bearing, not just cautious: the same
 * trivial prompt used **13,921** input tokens with it and **14,797** without — the difference is
 * context this box's personal config was injecting into every call.
 *
 * `--skip-git-repo-check` is required, not optional, because the working directory below is a
 * fresh temp dir, never a git repo — MEASURED: without it, codex refuses immediately ("Not inside
 * a trusted directory") rather than running.
 *
 * `--ephemeral` — "run without persisting session files to disk." Nothing this call does should
 * leave a rollout file in `~/.codex/sessions/` next to a human's own history.
 *
 * There is no `--max-budget-usd` equivalent — absent from `codex exec --help` on 0.152.0 — so
 * `options.maxBudgetUsd` is accepted (for interface parity with `runClaude`) but not enforced by
 * any flag here; the timeout is the only hard ceiling this transport can give the caller.
 * `generate.ts` passes a non-`undefined` `maxBudgetUsd` on every call (`DEFAULT_MAX_BUDGET_USD`,
 * currently `1.5`), so silently dropping it would mean the daemon's per-run dollar ceiling stops
 * existing the moment `MODKIT_BACKEND=codex` — the exact silent-no-op shape this file's own header
 * warns about elsewhere. `runCodex` instead logs a warning naming the ignored value on every call
 * that supplies one, so the gap is discoverable from the daemon's own logs rather than only from
 * reading this comment.
 *
 * ## No system-prompt flag
 *
 * `codex exec --help` has nothing like claude's `--system-prompt`. `options.system`, when given,
 * is folded into the one message sent on stdin, separated from the user turn by a rule — the
 * plainest thing that could work, since there is no CLI-native alternative to measure.
 *
 * ## The prompt goes on stdin via `-`
 *
 * `codex exec -` reads the prompt from stdin instead of argv — MEASURED cleaner than passing the
 * prompt as the positional argument: with an argv prompt, codex still printed `Reading additional
 * input from stdin...` to stderr (it always checks stdin), where `-` reads it directly with no
 * such notice. Off argv also means it never appears in `ps`, matching `claude.ts`'s own reason for
 * using stdin.
 *
 * `runCodex` **never throws** — same contract as `runClaude`, same reason: a pipeline that has to
 * remember to wrap every model call in try/catch will eventually forget to.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RunClaudeOptions, RunClaudeResult, RunUsage } from './claude.js';
import { binFor } from './bin.js';

const DEFAULT_BIN = 'codex';
const DEFAULT_TIMEOUT_MS = 300_000;

/** The binary. Overridable for tests and for a box where `codex` is not on PATH. */
export function codexBin(): string {
  return process.env['MODKIT_CODEX_BIN'] || binFor('codex') || DEFAULT_BIN;
}

/* ────────────────────────────────────────────────────────────────────────────
 * OpenAI strict-mode schema normalization — see the file header's "additionalProperties" section.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Rewrite a JSON Schema so codex's `--output-schema` (OpenAI structured-outputs "strict mode")
 * accepts it: `additionalProperties: false` and `required` covering every key of `properties`, at
 * every object level. A property that was not originally required gets its `type` (and `enum`, if
 * it has one) widened to also allow `null`, which is strict mode's documented way to keep a field
 * optional once `required` can no longer omit it. Schema-agnostic and recursive, so it works for
 * `prompt.ts`'s real `GENERATION_SCHEMA` and for anything else handed to `runCodex` without either
 * needing to know about the other. See the file header for what happens without this.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeSchemaNode(schema) as Record<string, unknown>;
}

function normalizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeSchemaNode);
  if (typeof node !== 'object' || node === null) return node;

  const rec = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    out[key] = normalizeSchemaNode(value);
  }

  const props = out['properties'];
  if (out['type'] === 'object' && typeof props === 'object' && props !== null && !Array.isArray(props)) {
    const propsRec = props as Record<string, unknown>;
    const keys = Object.keys(propsRec);
    const originallyRequired = new Set(
      Array.isArray(rec['required']) ? (rec['required'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    );
    out['additionalProperties'] = false;
    out['required'] = keys;
    for (const key of keys) {
      if (originallyRequired.has(key)) continue; // already mandatory — no null-widening needed
      const prop = propsRec[key];
      if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) continue;
      const p = prop as Record<string, unknown>;
      const t = p['type'];
      if (typeof t === 'string') {
        if (t !== 'null') p['type'] = [t, 'null'];
      } else if (Array.isArray(t) && !t.includes('null')) {
        p['type'] = [...t, 'null'];
      }
      if (Array.isArray(p['enum']) && !p['enum'].includes(null)) {
        p['enum'] = [...p['enum'], null];
      }
    }
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Narrowing helpers — codex's JSONL is untrusted, same rule as claude.ts.
 * ──────────────────────────────────────────────────────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function countOf(rec: Record<string, unknown>, key: string): number {
  return asNumber(rec[key]) ?? 0;
}

/** Parse one JSONL line, or `null` for anything that is not a bare JSON object — never throws. */
function parseEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Pull the best available failure detail out of the JSONL stream: a `turn.failed`'s error message
 * first, then a bare `{"type":"error",…}` item, else `null` so the caller falls back to the raw
 * streams. MEASURED shape: `fixtures/codex-bogus-model-fail.jsonl`.
 */
function findFailureDetail(events: Record<string, unknown>[]): string | null {
  for (const e of events) {
    if (e['type'] === 'turn.failed') {
      const err = asRecord(e['error']);
      const msg = err ? asString(err['message']) : null;
      if (msg) return msg;
    }
  }
  for (const e of events) {
    if (e['type'] === 'error') {
      const msg = asString(e['message']);
      if (msg) return msg;
    }
  }
  return null;
}

/**
 * Build the usage row from the (single, flat) `turn.completed` event. `null` when that event
 * never arrived — a failed run before any turn completed reports no usage, honestly, rather than
 * a row of invented zeros.
 *
 * Every counter codex does not report — cost, canonical model, a confirmed served-model name — is
 * `null`, per the brief's rule: represent unknown as null/0, never invent it.
 */
function readUsage(events: Record<string, unknown>[], source: string, model: string | undefined, threadId: string | null, durationMs: number): RunUsage | null {
  const turnCompleted = events.find((e) => e['type'] === 'turn.completed');
  if (!turnCompleted) return null;
  const usage = asRecord(turnCompleted['usage']);
  if (!usage) return null;

  return {
    source,
    at: new Date().toISOString(),
    models: [
      {
        // Not a confirmation of what served the call — codex's `--json` output names no model
        // anywhere (MEASURED). This is the requested model, or the literal string 'default' when
        // none was given, unlike claude's `modelUsage` key which IS the serving model.
        model: model && model.length > 0 ? model : 'default',
        inputTokens: countOf(usage, 'input_tokens'),
        outputTokens: countOf(usage, 'output_tokens'),
        cacheReadInputTokens: countOf(usage, 'cached_input_tokens'),
        cacheCreationInputTokens: countOf(usage, 'cache_write_input_tokens'),
        // codex reports no dollar cost anywhere in `--json` output (MEASURED) — never computed here.
        costUsd: null,
        canonicalModel: null,
      },
    ],
    // Not CLI-reported (no duration field exists in any measured event) — this is the daemon's
    // own wall-clock measurement of the spawned process, not a value invented on codex's behalf.
    totalCostUsd: null,
    durationMs,
    sessionId: threadId,
    uuid: null,
  };
}

/**
 * Call codex. See the file header for what every flag measures and why.
 */
export function runCodex<T = unknown>(options: RunClaudeOptions): Promise<RunClaudeResult<T>> {
  const { prompt, system, model, schema, timeoutMs = DEFAULT_TIMEOUT_MS, maxBudgetUsd, source = 'modkit', onUsage, signal } = options;

  // No flag here enforces this — see the file header's `--max-budget-usd` section. Logged on every
  // call that supplies a value (not deduped) so a long-running daemon's logs keep the signal rather
  // than dropping it after the first line scrolls off.
  if (maxBudgetUsd !== undefined) {
    console.warn(
      `[modkit-daemon] runCodex: maxBudgetUsd=${maxBudgetUsd} was requested but is NOT enforced — ` +
        'codex exec on 0.152.0 has no per-call cost ceiling; the timeout is the only hard limit.',
    );
  }

  const bin = codexBin();
  const startedAt = Date.now();

  // A fresh, empty, non-git temp dir per call: the sandbox root codex is confined to, and the
  // schema/output files live here too so nothing this call does touches the daemon's own state or
  // the vault. Removed best-effort when the call finishes.
  let workDir: string;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'modkit-codex-'));
  } catch (e) {
    return Promise.resolve({ ok: false, error: `mkdtemp: ${(e as Error).message}`, usage: null });
  }
  const outFile = join(workDir, 'output.txt');
  const schemaFile = join(workDir, 'schema.json');
  const cleanup = (): void => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort; a leftover empty temp dir is not worth failing the call over */
    }
  };

  if (schema) {
    try {
      writeFileSync(schemaFile, JSON.stringify(toStrictJsonSchema(schema)));
    } catch (e) {
      cleanup();
      return Promise.resolve({ ok: false, error: `writing --output-schema file: ${(e as Error).message}`, usage: null });
    }
  }

  const args = [
    'exec',
    '-', // read the prompt from stdin — see header
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
    workDir,
    '-o',
    outFile,
  ];
  if (schema) args.push('--output-schema', schemaFile);
  if (model) args.push('--model', model);

  // No `--system-prompt` equivalent (see header) — fold it into the one turn.
  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;

  return new Promise<RunClaudeResult<T>>((resolve) => {
    if (signal?.aborted) {
      cleanup();
      resolve({ ok: false, error: 'cancelled before the model was called', usage: null });
      return;
    }

    let child;
    try {
      // Deliberately NOT `spawn(..., { timeout: timeoutMs })`, unlike claude.ts. MEASURED: Node's
      // built-in spawn timeout leaves its internal timer running past a FAILED spawn (ENOENT) —
      // `close` fires immediately, but the process stays alive until the full `timeoutMs` elapses
      // regardless, because that path never reaches whatever clears the timer on a normal exit. A
      // missing `codex` binary would otherwise hang the daemon process for up to `timeoutMs` on
      // every call. The timer below is armed only once the child actually exists and is always
      // cleared in `done()`, on every exit path.
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      cleanup();
      resolve({ ok: false, error: `spawn ${bin}: ${(e as Error).message}`, usage: null });
      return;
    }

    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      // SIGKILL: the point of cancelling is to stop spending, not to give the CLI a chance to
      // finish its turn on the signal — same reasoning as claude.ts.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // A failed spawn (e.g. ENOENT for a missing binary) fires BOTH `error` and `close` — MEASURED,
    // same shape claude.ts inherits unfixed. Without this guard, `close` runs a second time with
    // `code: null` after `error` already resolved the promise: `code !== 0` is true for `null`, so it
    // takes the failure branch again and (with MODKIT_STATE_DIR set) writes a second, useless
    // transcript file to disk on every missing-binary call — `settled` stops that second pass before
    // it does anything observable, not just before it resolves twice.
    let settled = false;
    const done = <R extends RunClaudeResult<T>>(result: R): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cleanup();
      resolve(result);
    };

    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });

    // EPIPE here only means the child already died; `close` owns the reporting.
    child.stdin?.on('error', () => {});
    child.stdin?.end(fullPrompt);

    child.on('error', (e: Error) => {
      done({ ok: false, error: `${bin}: ${e.message}`, usage: null });
    });

    child.on('close', (code: number | null) => {
      if (settled) return; // `error` already resolved this call — see the comment on `settled` above
      const durationMs = Date.now() - startedAt;

      if (cancelled) {
        done({ ok: false, error: 'cancelled', usage: null });
        return;
      }
      if (timedOut) {
        // Named distinctly from `cancelled` for the same reason claude.ts gives: "the model took
        // too long" and "the caller asked to stop" send whoever is debugging to different places.
        done({ ok: false, error: `killed by SIGKILL after ${timeoutMs}ms`, usage: null });
        return;
      }

      const events = out
        .split('\n')
        .map(parseEvent)
        .filter((e): e is Record<string, unknown> => e !== null);
      const threadStarted = events.find((e) => e['type'] === 'thread.started');
      const threadId = threadStarted ? asString(threadStarted['thread_id']) : null;
      const usage = readUsage(events, source, model, threadId, durationMs);

      if (code !== 0) {
        const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);
        let dumped = '';
        try {
          const dir = process.env['MODKIT_STATE_DIR'];
          if (dir) {
            const file = join(dir, 'logs', `codex-fail-${Date.now()}.log`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `exit ${code}\n\n=== stderr ===\n${err}\n\n=== stdout ===\n${out}\n`, { mode: 0o600 });
            dumped = ` — full transcript at ${file}`;
          }
        } catch {
          /* diagnostics must never be the reason a call fails */
        }
        const detail = findFailureDetail(events);
        const parts = [detail, err.trim() && `stderr: ${tail(err.trim(), 400)}`, out.trim() && `stdout(tail): ${tail(out.trim(), 700)}`]
          .filter(Boolean)
          .join(' | ');
        // NOT `onUsage?.(usage)` here — claude.ts only fires `onUsage` on the success path too;
        // a failed call's usage rides back on `result.usage` instead, and the caller (`generate.ts`)
        // is the one that records it (`if (!first.ok) { if (first.usage) record(first.usage); }`).
        // Calling `onUsage` here as well would double the ledger row for every failed generation.
        done({
          ok: false,
          error: `exit ${code}${parts ? `: ${parts}` : ' with both streams empty'}${dumped}`,
          usage,
        });
        return;
      }

      if (!usage) {
        done({ ok: false, error: 'no turn.completed event in codex output', usage: null });
        return;
      }

      // Measuring must never break the measured.
      try {
        onUsage?.(usage);
      } catch {
        /* ignore */
      }

      let text = '';
      try {
        text = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* the turn completed with no final message on disk — text stays empty, not fatal */
      }
      const served = usage.models[0]?.model ?? (model && model.length > 0 ? model : 'default');

      if (!schema) {
        done({ ok: true, text, json: null, model: served, usage });
        return;
      }

      try {
        done({ ok: true, text, json: JSON.parse(text) as T, model: served, usage });
      } catch (e) {
        done({ ok: false, error: `schema output was not JSON: ${(e as Error).message}`, usage });
      }
    });
  });
}
