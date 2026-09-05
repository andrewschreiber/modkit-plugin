#!/usr/bin/env node
/**
 * Minimal test double for the `claude` binary — just enough of the measured `runClaude` contract
 * (a JSON array on stdout, one `type: "result"` entry) for model.test.mjs to prove `runModel`
 * dispatches to `runClaude` rather than `runCodex` when `MODKIT_BACKEND=claude`. Not a claim about
 * real claude output; `claude.ts`'s own header is the measured source for that.
 *
 *   FAKE_CLAUDE_STDOUT — the exact stdout to emit (a JSON array string)
 *   FAKE_CLAUDE_EXIT   — exit code (default 0)
 */
const exitCode = Number(process.env['FAKE_CLAUDE_EXIT'] ?? '0');
const stdout = process.env['FAKE_CLAUDE_STDOUT'] ?? '[]';

process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(stdout);
  process.exit(exitCode);
});
