/**
 * `probe.ts` — answer "can this daemon actually reach a model right now?" before a generation
 * has to find out the expensive way.
 *
 * The failure this exists for, verbatim from a real run:
 *
 *     result: "Failed to authenticate: OAuth session expired and could not be refreshed"
 *
 * which modkit reported as `model-failed`, "The model call failed.", retryable, with the CLI's
 * whole JSON transcript in a disclosure triangle. Every part of that is true and none of it says
 * `claude login`. `generate.ts` now classifies it (`model-auth`), but classification only helps
 * someone who has already spent a generation to trigger it. This is the same answer, on demand,
 * for the price of a `--version` call and — only when asked — a few tokens.
 *
 * ## Two questions, deliberately separate
 *
 * 1. **Is the CLI there?** A filesystem question, answered by `bin.ts`, free, and the one that a
 *    machine with an unusual PATH fails. A daemon whose PATH came from whichever shell ran
 *    `npm run setup` cannot see `~/.local/bin` if that directory reaches PATH through an rc file.
 * 2. **Is it signed in?** Only a real call can answer this. `claude --version` succeeds fine with
 *    a dead OAuth session, so a version check is evidence the binary runs and no evidence at all
 *    about auth. `deep: true` therefore spends one minimal model turn; `deep: false` reports
 *    `signedIn: null`, which means "not asked", never "fine".
 */

import { execFile } from 'node:child_process';

import type { ModelBackend } from '@modkit/types';

import { binFor, missingBinHint, resolveBin } from './bin.js';
import { runModel } from './model.js';

/** How long a `--version` call may take before we call the binary broken rather than slow. */
const VERSION_TIMEOUT_MS = 10_000;
/** A deep probe is one real turn. Small budget, small timeout: it is a check, not a generation. */
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_BUDGET_USD = 0.05;

export interface BackendCheck {
  backend: ModelBackend;
  /** Absolute path that will be spawned, or `null` when nothing executable was found. */
  binPath: string | null;
  /** Directories and files that were looked at, so "not found" can name them. */
  searched: string[];
  /** `<bin> --version` output, trimmed, when the binary ran at all. */
  version: string | null;
  /**
   * `true` signed in, `false` definitely not, `null` not asked (shallow probe).
   * Never `true` on a guess — only a completed model turn sets it.
   */
  signedIn: boolean | null;
  /** The one sentence a human should act on, or `null` when there is nothing to fix. */
  hint: string | null;
}

function versionOf(bin: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolvePromise(null);
        return;
      }
      resolvePromise(String(stdout).trim() || null);
    });
  });
}

/**
 * Check one backend.
 *
 * Never throws — it is called from a request handler and from setup, and a diagnostic that can
 * fail its caller is worse than no diagnostic.
 */
export async function checkBackend(backend: ModelBackend, options: { deep?: boolean } = {}): Promise<BackendCheck> {
  const resolved = resolveBin(backend);
  const base: BackendCheck = {
    backend,
    binPath: resolved.path,
    searched: resolved.searched,
    version: null,
    signedIn: null,
    hint: null,
  };

  if (!resolved.path) {
    return { ...base, hint: missingBinHint(backend) };
  }

  const version = await versionOf(resolved.path);
  if (version === null) {
    return {
      ...base,
      hint: `\`${resolved.path}\` is there but did not answer \`--version\`. It may be a broken install or the wrong file.`,
    };
  }
  if (!options.deep) return { ...base, version };

  // The cheapest turn that still proves the credential: no schema, no tools, one word back.
  const result = await runModel(
    {
      prompt: 'Reply with the single word: ok',
      system: 'You are a connectivity probe. Reply with exactly one word.',
      source: 'modkit-probe',
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBudgetUsd: PROBE_BUDGET_USD,
    },
    { backend },
  );

  if (result.ok) return { ...base, version, signedIn: true };

  const e = result.error.toLowerCase();
  const looksLikeAuth =
    e.includes('oauth session expired') ||
    e.includes('failed to authenticate') ||
    e.includes('authentication_error') ||
    e.includes('invalid api key') ||
    e.includes('not logged in') ||
    e.includes('unauthorized');

  if (looksLikeAuth) {
    return {
      ...base,
      version,
      signedIn: false,
      hint:
        backend === 'codex'
          ? 'The codex CLI is not signed in, or its session expired. Run `codex login` in a terminal, then check again.'
          : 'The claude CLI is not signed in, or its session expired. Run `claude login` in a terminal, then check again.',
    };
  }

  // A non-auth failure is still worth reporting, but it is not a sign-in problem and must not be
  // labelled as one — sending someone to `claude login` for a network error wastes their afternoon.
  return { ...base, version, signedIn: null, hint: `The probe call failed: ${result.error.slice(0, 300)}` };
}

/** The command a human runs to fix a signed-out backend. Also used by setup's output. */
export function loginCommand(backend: ModelBackend): string {
  return backend === 'codex' ? 'codex login' : 'claude login';
}

/** Re-exported so callers that only want the spawn target need one import. */
export { binFor };
