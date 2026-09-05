#!/usr/bin/env node
/**
 * Test double for the `codex` binary, driven entirely by env vars. Used by codex.test.mjs and
 * model.test.mjs so `runCodex`'s argv-building and JSONL/`-o`-file parsing get exercised against
 * a real child process — matching how `runCodex` itself is written — without a network call.
 *
 * This is NOT a fixture of real codex output; the measured transcripts are
 * `test/fixtures/codex-*.jsonl`. This script only has to accept the argv shape `runCodex` builds
 * (in particular, find `-o <file>`) and reproduce a chosen fixture's bytes on stdout.
 *
 *   FAKE_CODEX_STDOUT_FILE  — path to a file whose contents are written to stdout verbatim
 *   FAKE_CODEX_STDOUT       — inline string written to stdout instead of a file
 *   FAKE_CODEX_LASTMSG      — written to the `-o` file, if one was passed on argv
 *   FAKE_CODEX_EXIT         — exit code (default 0)
 *   FAKE_CODEX_HANG         — "1": never exit on our own (for the timeout/kill test)
 *   FAKE_CODEX_ARGV_FILE    — path to write `process.argv.slice(2)` to, as JSON (review finding:
 *                             nothing pinned runCodex's actual argv, so every safety flag could be
 *                             deleted with the suite still green — this lets a test assert on it)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const oIdx = argv.indexOf('-o');
const outFile = oIdx >= 0 ? argv[oIdx + 1] : null;

const argvFile = process.env['FAKE_CODEX_ARGV_FILE'];
if (argvFile) writeFileSync(argvFile, JSON.stringify(argv));

const exitCode = Number(process.env['FAKE_CODEX_EXIT'] ?? '0');
const stdoutFile = process.env['FAKE_CODEX_STDOUT_FILE'];
const stdoutInline = process.env['FAKE_CODEX_STDOUT'];
const lastMessage = process.env['FAKE_CODEX_LASTMSG'];
const hang = process.env['FAKE_CODEX_HANG'] === '1';

if (stdoutFile) process.stdout.write(readFileSync(stdoutFile, 'utf8'));
else if (stdoutInline !== undefined) process.stdout.write(stdoutInline);

if (outFile && lastMessage !== undefined) writeFileSync(outFile, lastMessage);

// The real binary reads the prompt from stdin (`codex exec -`); drain it so the parent's
// `child.stdin.end(prompt)` always completes regardless of what this double does afterwards.
process.stdin.resume();
if (!hang) {
  process.stdin.on('end', () => process.exit(exitCode));
} else {
  // Never exit on our own — used to prove the timeout+SIGKILL path actually fires. Without a live
  // handle, the process would exit as soon as the parent closes stdin (nothing else is keeping the
  // event loop open), which defeats the point — so pin it open until SIGKILL ends it forcibly.
  setInterval(() => {}, 60_000);
}
