/**
 * `model.ts` — the one call site `generate.ts` uses, dispatching to whichever transport
 * `MODKIT_BACKEND` names.
 *
 * `runClaude` and `runCodex` already share a result shape (`RunClaudeResult<T>`/`RunUsage`) by
 * construction (L8), so this file is a single `if`, not an abstraction. Its only job is to read
 * `config.backend` so `generate.ts`'s two call sites stay exactly what they were — an options
 * object in, the same result shape out — and never learn that a second transport exists.
 *
 * `config` is a second, optional argument rather than a field forced onto `RunClaudeOptions`,
 * specifically so a test can pass `{ backend: 'codex' }` directly without setting `MODKIT_BACKEND`
 * and restoring it afterwards. `generate.ts`'s call sites pass none, so each one re-reads
 * `resolveConfig()` — cheap (env lookups plus a `package.json` read) and correct, since a backend
 * choice made at daemon-config-resolution time already flows into `deps.model` the same way, and
 * the two must never disagree about which transport a given `model` string means.
 *
 * KNOWN GAP, left for whichever lane next touches `generate.ts`'s `PipelineDeps`: `resolveConfig()`
 * as a default parameter can throw (a bad `MODKIT_BACKEND`/`MODKIT_HOST`/etc.), which makes this the
 * one link in the chain that can reject synchronously despite both transports' own never-throws
 * contract. In practice the daemon would already have failed at boot on the same bad env, and
 * `generate.ts` awaits this inside an async function so it degrades to a rejection rather than a
 * crash — but the clean fix is threading `backend: config.backend` through `PipelineDeps` the way
 * `model: config.model` already is, and dropping this default entirely. Not done here: this lane's
 * fence is `generate.ts`'s import line and two call sites only.
 */

import { runClaude, type RunClaudeOptions, type RunClaudeResult } from './claude.js';
import { runCodex } from './codex.js';
import { resolveConfig, type Backend } from './state.js';

export function runModel<T = unknown>(
  options: RunClaudeOptions,
  config: { backend: Backend } = resolveConfig(),
): Promise<RunClaudeResult<T>> {
  return config.backend === 'codex' ? runCodex<T>(options) : runClaude<T>(options);
}
