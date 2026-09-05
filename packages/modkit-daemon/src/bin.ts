/**
 * `bin.ts` — find the backend CLI on a machine whose PATH is not ours to predict.
 *
 * ## Why this exists
 *
 * `claude.ts` and `codex.ts` used to spawn the bare names `claude` and `codex` and let `execvp`
 * resolve them against whatever PATH the daemon inherited. That works on the box modkit was built
 * on and fails on a surprising number of others, because the daemon's PATH is the PATH of the
 * shell that ran `npm run setup` — and the CLIs install into directories that are on an
 * *interactive* PATH by way of a shell rc file:
 *
 *   - `~/.local/bin` — the `claude` installer's default, added by an rc line
 *   - `~/.claude/local` — the older self-update location
 *   - a Homebrew prefix that differs by architecture (`/opt/homebrew` vs `/usr/local`)
 *   - an nvm-managed npm global bin, whose path contains the active Node version
 *
 * A `spawn` failure there surfaces as `ENOENT`, which the transports correctly report but which
 * reads as "modkit is broken" rather than "modkit cannot see your CLI". Resolving to an absolute
 * path up front turns that into a fact the daemon can *report* — see `/v1/model-check` — and one
 * a settings screen can act on.
 *
 * ## What it deliberately does not do
 *
 * It does not run a shell. Resolving PATH by shelling out to `zsh -l -c 'which claude'` is the
 * obvious fix and a bad one: it executes the user's entire rc chain inside a daemon that holds a
 * signing key, for a string. The candidate list below is boring, inspectable, and covers the
 * installers' documented locations; `MODKIT_CLAUDE_BIN` / `MODKIT_CODEX_BIN` remain the escape
 * hatch for anything exotic, and they are checked first.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { ModelBackend } from '@modkit/types';

/** True for a path that exists, is a file, and is executable by this process. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every `<dir>/<name>` on the inherited PATH, in order. */
function pathCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATH'] ?? '';
  return raw
    .split(delimiter)
    .filter((d) => d.length > 0)
    .map((d) => join(d, name));
}

/**
 * Where a backend's CLI plausibly lives, most-specific first.
 *
 * Order matters and is not alphabetical: an explicit override beats everything, the inherited PATH
 * beats a guess, and the guesses are last so that a machine with a working PATH never resolves to
 * a stale copy in some other prefix.
 */
export function binCandidates(backend: ModelBackend, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = backend === 'codex' ? 'codex' : 'claude';
  const override = backend === 'codex' ? env['MODKIT_CODEX_BIN'] : env['MODKIT_CLAUDE_BIN'];
  const home = env['HOME'] ?? homedir();
  const guesses =
    backend === 'codex'
      ? [join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']
      : [
          join(home, '.local', 'bin', 'claude'),
          join(home, '.claude', 'local', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
        ];
  // Deduplicated, first occurrence winning, because this list is shown to a human when nothing is
  // found. Measured on a real machine: an un-deduplicated search reported 57 paths of which 20 were
  // repeats — `~/.local/bin/claude` three times, both homebrew prefixes three times — because npm
  // prepends its own `node_modules/.bin` entries and rc files append the same directories more than
  // once. A "here is where I looked" that begins with twenty duplicates is not a diagnosis.
  const all = [...(override ? [override] : []), ...pathCandidates(name, env), ...guesses];
  return [...new Set(all)];
}

/** What the daemon knows about a backend's CLI on this machine. */
export interface ResolvedBin {
  backend: ModelBackend;
  /** The absolute path that will be spawned, or `null` when nothing executable was found. */
  path: string | null;
  /** True when `MODKIT_CLAUDE_BIN`/`MODKIT_CODEX_BIN` chose it — worth saying out loud in a report. */
  fromOverride: boolean;
  /** Every place that was looked, so a "not found" message can name them instead of shrugging. */
  searched: string[];
}

/**
 * Resolve a backend's CLI to an absolute path.
 *
 * Falls back to the bare name when nothing matched, rather than throwing: the transports' contract
 * is that they never throw, and a bare name still lets `execvp` succeed in the case this function
 * failed to anticipate. The difference is that `path === null` is now *knowable*, so the daemon can
 * say "I could not find `claude`" before spending a generation finding out.
 */
export function resolveBin(backend: ModelBackend, env: NodeJS.ProcessEnv = process.env): ResolvedBin {
  const searched = binCandidates(backend, env);
  const override = backend === 'codex' ? env['MODKIT_CODEX_BIN'] : env['MODKIT_CLAUDE_BIN'];
  for (const candidate of searched) {
    const abs = resolve(candidate);
    if (isExecutableFile(abs)) {
      return { backend, path: abs, fromOverride: Boolean(override) && candidate === override, searched };
    }
  }
  return { backend, path: null, fromOverride: false, searched };
}

/** The string to actually spawn: the resolved absolute path, else the bare name. */
export function binFor(backend: ModelBackend, env: NodeJS.ProcessEnv = process.env): string {
  return resolveBin(backend, env).path ?? (backend === 'codex' ? 'codex' : 'claude');
}

/** What to tell a human when a backend's CLI cannot be found at all. */
export function missingBinHint(backend: ModelBackend): string {
  return backend === 'codex'
    ? 'modkit could not find the `codex` CLI. Install it, or set MODKIT_CODEX_BIN to its absolute path and restart the daemon.'
    : 'modkit could not find the `claude` CLI. Install it, or set MODKIT_CLAUDE_BIN to its absolute path and restart the daemon.';
}
