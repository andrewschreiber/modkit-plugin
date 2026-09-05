/**
 * `claude.ts` — the model transport, self-contained.
 *
 * This is modkit's own `runClaude`. It is deliberately a reimplementation rather than an import:
 * the measured contract was learned from another repo's wrapper, but modkit must not depend on that
 * repo, and a transport whose flags are copied without their reasons is a transport nobody can
 * safely change. Every flag below is load-bearing and says why.
 *
 * Two hard rules, both from measurement rather than from the CLI's help text:
 *
 * 1. **`--output-format json` emits an ARRAY of transcript events**, not one object. The payload is
 *    the entry whose `type` is `"result"`. With `--json-schema`, that entry carries the answer twice:
 *    `structured_output` (already parsed) and `result` (the same JSON as a *string*). We prefer
 *    `structured_output` and keep the string parse as the fallback — the fallback is the path with
 *    years of evidence behind it, and the parsed field is newer than the wrapper this was learned
 *    from.
 * 2. **`result.model` does not exist.** The model that actually served the request is
 *    `Object.keys(result.modelUsage)[0]`, which also survives a server-side fallback where echoing
 *    back the requested id would quietly lie.
 *
 * And one accounting rule that is not guessable: **read `modelUsage`, never the top-level `usage`.**
 * They disagree — measured at `usage.input_tokens 1007` against `modelUsage[…].inputTokens 1909` in
 * the same response — and only `modelUsage` reconciles to `total_cost_usd`. Building a ledger on
 * `usage` under-reports by roughly a third while looking entirely plausible.
 *
 * `runClaude` **never throws.** Every failure path resolves `{ ok: false, error }`, because a
 * generation pipeline that has to wrap the model call in try/catch will eventually forget to.
 */

import { spawn } from 'node:child_process';

import { binFor } from './bin.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A JSON Schema object, passed through to `--json-schema` verbatim. */
export type JsonSchema = Record<string, unknown>;

/**
 * Per-model token counters for one call.
 *
 * Counters, never a cost, are the durable record: a price table changes and an unknown model must
 * surface as *unpriced* rather than as silently costing nothing. `costUsd` is recorded here only
 * because the CLI now reports it — as an observed value beside the counters, not instead of them.
 */
export interface ModelTokenUsage {
  /** The `modelUsage` key — the model that actually served this call. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** As reported by the CLI, when it reports one. Never computed here. */
  costUsd: number | null;
  canonicalModel: string | null;
}

/** Everything worth writing to a ledger about one model call. */
export interface RunUsage {
  /** Attribution — which part of modkit spent this. */
  source: string;
  at: string;
  /** One entry per model; a server-side fallback produces two honest rows rather than one wrong total. */
  models: ModelTokenUsage[];
  totalCostUsd: number | null;
  durationMs: number | null;
  sessionId: string | null;
  uuid: string | null;
}

export interface RunClaudeOptions {
  /** The user turn. Delivered on **stdin**, never on argv — closing stdin is what ends the prompt. */
  prompt: string;
  /**
   * Replaces the coding-agent persona outright (`--system-prompt`, not `--append-`). modkit always
   * sets one: the default persona is wrong for an author whose only output is a patch.
   */
  system?: string;
  /** `'opus' | 'sonnet' | 'haiku'` or a full model id. */
  model?: string;
  /** When set, the resolved value carries `.json`. */
  schema?: JsonSchema;
  /**
   * Generation is a whole patch with a real plugin's source in the prompt, not a one-line
   * brief. 300s is the floor: `claude -p` pays CLI startup *plus* model latency, and a 90s cap was
   * measured killing real calls.
   */
  timeoutMs?: number;
  /** A real per-run ceiling. Set it deliberately per route — an un-instrumented call is not undercounted, it is absent. */
  maxBudgetUsd?: number;
  /** Attribution for the ledger, e.g. `'modkit-generate'` / `'modkit-correct'`. */
  source?: string;
  /** Called with the usage of a *successful* call. Must never throw; it is wrapped here regardless. */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Cancellation. A generation can run for minutes, so a job that is cancelled or a daemon that is
   * shutting down must be able to stop paying for one — and the only way to stop a `claude -p` is to
   * kill it. Resolves `{ok:false}` like every other failure rather than rejecting.
   */
  signal?: AbortSignal;
}

export type RunClaudeResult<T = unknown> =
  | {
      ok: true;
      /** `result.result`, trimmed. With a schema this is the JSON as a string. */
      text: string;
      /** The parsed structured output. `null` only when no schema was requested. */
      json: T | null;
      /** The model that actually served the call, read from `modelUsage`. */
      model: string;
      usage: RunUsage;
    }
  | {
      ok: false;
      error: string;
      /** Present when the call reached a `result` event before failing (an `is_error` result still bills). */
      usage: RunUsage | null;
    };

const DEFAULT_BIN = 'claude';
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUDGET_USD = 1.5;

/**
 * The binary. Overridable for tests and for a box where `claude` is not on PATH.
 *
 * Resolves to an ABSOLUTE path when one can be found (`bin.ts`), because the daemon's PATH is
 * whatever the shell that ran `npm run setup` had, and the `claude` installer's directory reaches
 * an interactive PATH through a shell rc file the daemon never sources. Falls back to the bare
 * name so `execvp` still gets its chance in the case `bin.ts` did not anticipate.
 */
export function claudeBin(): string {
  return process.env['MODKIT_CLAUDE_BIN'] || binFor('claude') || DEFAULT_BIN;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Narrowing helpers — the CLI's output is untrusted JSON, so nothing below
 * indexes it without checking what it got.
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

/**
 * Extract the per-model counters. Tolerant by construction: a shape change upstream must degrade to
 * a thinner ledger row, never to a thrown exception inside the thing being measured.
 */
function readUsage(result: Record<string, unknown>, source: string): RunUsage {
  const models: ModelTokenUsage[] = [];
  const modelUsage = asRecord(result['modelUsage']);
  if (modelUsage) {
    for (const [model, raw] of Object.entries(modelUsage)) {
      const entry = asRecord(raw);
      if (!entry) continue;
      models.push({
        model,
        inputTokens: countOf(entry, 'inputTokens'),
        outputTokens: countOf(entry, 'outputTokens'),
        cacheReadInputTokens: countOf(entry, 'cacheReadInputTokens'),
        cacheCreationInputTokens: countOf(entry, 'cacheCreationInputTokens'),
        costUsd: asNumber(entry['costUSD']),
        canonicalModel: asString(entry['canonicalModel']),
      });
    }
  }
  return {
    source,
    at: new Date().toISOString(),
    models,
    totalCostUsd: asNumber(result['total_cost_usd']),
    durationMs: asNumber(result['duration_ms']),
    sessionId: asString(result['session_id']),
    uuid: asString(result['uuid']),
  };
}

/**
 * Call the model.
 *
 * The argv, and why each flag is here:
 *
 * - **`--safe-mode`** disables CLAUDE.md, skills, plugins, hooks and MCP for the run. Two
 *   independent reasons, and modkit inherits both: without it a `claude -p` launched from a repo
 *   root inherits *that repo's whole operating manual* as its system prompt, and without it a
 *   headless call fires hooks — so a hook-triggered generation can spend money that triggers itself.
 * - **NOT `--bare`.** `--bare` also strips customizations but forces auth to `ANTHROPIC_API_KEY` and
 *   never reads the OAuth credentials. The point of the CLI transport is that it carries the
 *   subscription credential and needs no API key on the box.
 * - **`--tools ''`** — no tool access, so a headless run cannot stall on a permission prompt.
 * - **`--no-session-persistence`** — no resumable transcripts accumulating on disk. It is also why
 *   token accounting has to be explicit: there is no transcript to reconcile against later.
 * - **`--max-budget-usd`** — a real ceiling, not advice.
 */
export function runClaude<T = unknown>(options: RunClaudeOptions): Promise<RunClaudeResult<T>> {
  const {
    prompt,
    system,
    model = 'sonnet',
    schema,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
    source = 'modkit',
    onUsage,
    signal,
  } = options;

  const args = [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--max-budget-usd',
    String(maxBudgetUsd),
  ];
  if (model) args.push('--model', model);
  if (system) args.push('--system-prompt', system);
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  const bin = claudeBin();

  return new Promise<RunClaudeResult<T>>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'cancelled before the model was called', usage: null });
      return;
    }

    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
    } catch (e) {
      resolve({ ok: false, error: `spawn ${bin}: ${(e as Error).message}`, usage: null });
      return;
    }

    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      // SIGKILL, not SIGTERM: the point of cancelling is to stop spending, and a CLI that catches
      // the signal and finishes its turn has not been cancelled.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = <R extends RunClaudeResult<T>>(result: R): void => {
      signal?.removeEventListener('abort', onAbort);
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

    // EPIPE here only means the child already died; the `close` handler owns the reporting.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);

    child.on('error', (e: Error) => {
      done({ ok: false, error: `${bin}: ${e.message}`, usage: null });
    });

    child.on('close', (code: number | null, killedBy: NodeJS.Signals | null) => {
      if (cancelled) {
        // Named distinctly from the timeout. "Cancelled" and "the model took too long" send whoever
        // is debugging to two different places, and only one of them is a modkit problem.
        done({ ok: false, error: 'cancelled', usage: null });
        return;
      }
      if (killedBy) {
        done({ ok: false, error: `killed by ${killedBy} after ${timeoutMs}ms`, usage: null });
        return;
      }
      if (code !== 0) {
        // Report BOTH streams, and keep the whole thing on disk.
        //
        // In `--output-format json` the CLI puts its failure on stdout and often leaves stderr
        // empty, so the original stderr-only message read as `exit 1:` with nothing after the
        // colon (2026-08-31, and it cost the diagnosis). An excerpt is not enough either: the
        // interesting part of a transcript is at the END, after a multi-KB `init` event, so a
        // head-slice shows only that the CLI started. Dump the full streams next to the daemon's
        // own logs and name the file in the error.
        const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);
        let dumped = '';
        try {
          const dir = process.env['MODKIT_STATE_DIR'];
          if (dir) {
            const file = join(dir, 'logs', `claude-fail-${Date.now()}.log`);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, `exit ${code}\n\n=== stderr ===\n${err}\n\n=== stdout ===\n${out}\n`, { mode: 0o600 });
            dumped = ` — full transcript at ${file}`;
          }
        } catch {
          /* diagnostics must never be the reason a call fails */
        }
        const parts = [err.trim() && `stderr: ${tail(err.trim(), 400)}`, out.trim() && `stdout(tail): ${tail(out.trim(), 700)}`]
          .filter(Boolean)
          .join(' | ');
        done({
          ok: false,
          error: `exit ${code}${parts ? `: ${parts}` : ' with both streams empty'}${dumped}`,
          usage: null,
        });
        return;
      }

      let events: unknown;
      try {
        events = JSON.parse(out);
      } catch (e) {
        done({ ok: false, error: `unparseable CLI output: ${(e as Error).message}`, usage: null });
        return;
      }

      // An array of transcript events today; tolerate a future collapse to a single object.
      const found = Array.isArray(events)
        ? events.find((e) => asRecord(e)?.['type'] === 'result')
        : events;
      const result = asRecord(found);
      if (!result) {
        done({ ok: false, error: 'no result event in CLI output', usage: null });
        return;
      }

      // An errored result still consumed tokens, so usage is read before the error branch.
      const usage = readUsage(result, source);

      if (result['is_error'] === true) {
        const subtype = asString(result['subtype']) ?? 'error';
        const detail = String(result['result'] ?? '').slice(0, 400);
        done({ ok: false, error: `${subtype}: ${detail}`, usage });
        return;
      }

      // Measuring must never break the measured.
      try {
        onUsage?.(usage);
      } catch {
        /* ignore */
      }

      const text = String(result['result'] ?? '').trim();
      const served = usage.models[0]?.model ?? model;

      if (!schema) {
        done({ ok: true, text, json: null, model: served, usage });
        return;
      }

      const structured = result['structured_output'];
      if (structured !== null && structured !== undefined && typeof structured === 'object') {
        done({ ok: true, text, json: structured as T, model: served, usage });
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

/**
 * Append one JSONL row per model to a ledger file.
 *
 * The one hard rule, and the reason the whole body is inside a `catch` that returns: **the recorder
 * must never throw and never break the thing it measures.** A ledger that can fail a generation is
 * worse than no ledger.
 *
 * The caller owns the path — the daemon's state layout is not this module's business.
 */
export async function appendUsageJsonl(file: string, usage: RunUsage): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const lines = usage.models
      .map((m) =>
        JSON.stringify({
          ts: usage.at,
          source: usage.source,
          model: m.model,
          canonicalModel: m.canonicalModel,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheReadInputTokens: m.cacheReadInputTokens,
          cacheCreationInputTokens: m.cacheCreationInputTokens,
          costUsd: m.costUsd,
          totalCostUsd: usage.totalCostUsd,
          durationMs: usage.durationMs,
          sessionId: usage.sessionId,
          uuid: usage.uuid,
        }),
      )
      .join('\n');
    if (!lines) return;
    await appendFile(file, `${lines}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* never break the run over accounting */
  }
}
