/**
 * generate.ts — `neededSourcePaths`, the source-pinned retry's decision.
 *
 * This is the half of §4b worth testing in isolation: what a `no-source-available` refusal is
 * allowed to pull into the next turn. The orchestration around it (fetch once, ask once, keep the
 * first refusal if the retry comes back malformed) needs a pipeline harness this package does not
 * have yet, and is not covered here.
 *
 * The property that matters is containment. `neededSourcePaths` reads model output — a field the
 * model fills in and, failing that, its free prose — and turns it into paths the daemon will fetch.
 * Every path is checked against `bundle.omitted` first, so the model can only ever ask for a file
 * this repo has and this fetch left out.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { neededSourcePaths } from '../dist/generate.js';

/** A bundle carrying only what `neededSourcePaths` reads. */
function bundle({ omitted = [], files = [] } = {}) {
  return {
    repo: 'obsidian-tasks-group/obsidian-tasks',
    tag: '7.14.0',
    resolvedVia: 'raw-probe',
    commitSha: null,
    files: files.map((path) => ({ path, bytes: 10, text: '', truncated: false, score: 100 })),
    totalBytes: 0,
    omitted: omitted.map((path) => ({ path, bytes: 20_000 })),
    treeTruncated: false,
    symbolsFound: [],
    symbolsMissing: [],
  };
}

function refusal(extra = {}) {
  return {
    reason: 'no-source-available',
    explanation: 'I could not find the code that does this.',
    detail: '',
    ...extra,
  };
}

describe('neededSourcePaths', () => {
  test('takes the structured field when the model fills it', () => {
    const got = neededSourcePaths(
      refusal({ neededPaths: ['src/Obsidian/Cache.ts'] }),
      bundle({ omitted: ['src/Obsidian/Cache.ts', 'src/Query/Query.ts'] }),
    );
    assert.deepEqual(got, ['src/Obsidian/Cache.ts']);
  });

  // The live 2026-09-03 refusals named the file in prose and left no structured field, because the
  // field did not exist yet. A model that explains itself well should not be punished for it.
  test('falls back to prose, which is how the real refusals named the file', () => {
    const got = neededSourcePaths(
      refusal({
        detail:
          'The place that assembles and publishes the cached task list is the Cache class ' +
          '(src/Obsidian/Cache.ts), and that file was not included in the source provided.',
      }),
      bundle({ omitted: ['src/Obsidian/Cache.ts', 'src/Query/Query.ts'] }),
    );
    assert.deepEqual(got, ['src/Obsidian/Cache.ts']);
  });

  test('the structured field wins; prose is not also scanned when it produced something', () => {
    const got = neededSourcePaths(
      refusal({
        neededPaths: ['src/Obsidian/Cache.ts'],
        detail: 'though src/Query/Query.ts also looked relevant',
      }),
      bundle({ omitted: ['src/Obsidian/Cache.ts', 'src/Query/Query.ts'] }),
    );
    assert.deepEqual(got, ['src/Obsidian/Cache.ts']);
  });

  /* ── containment: the reason the prose scan is safe ── */

  test('a path this repo does not have is dropped, however confidently it is named', () => {
    const got = neededSourcePaths(
      refusal({ neededPaths: ['src/Invented/NotReal.ts', '/etc/passwd', '../../secrets.env'] }),
      bundle({ omitted: ['src/Obsidian/Cache.ts'] }),
    );
    assert.deepEqual(got, [], 'only a path in the omitted list may be pinned');
  });

  test('a file the model ALREADY had is never re-pinned', () => {
    const got = neededSourcePaths(
      refusal({ neededPaths: ['src/main.ts'] }),
      bundle({ omitted: ['src/Obsidian/Cache.ts'], files: ['src/main.ts'] }),
    );
    assert.deepEqual(got, [], 'asking again with the same files earns the same refusal');
  });

  test('nothing was omitted → nothing to ask for, and no retry', () => {
    const got = neededSourcePaths(
      refusal({ neededPaths: ['src/Obsidian/Cache.ts'] }),
      bundle({ omitted: [], files: ['src/main.ts'] }),
    );
    assert.deepEqual(got, []);
  });

  test('prose mentioning a file it already has does not trigger a retry', () => {
    const got = neededSourcePaths(
      refusal({ detail: 'src/main.ts shows getTasks() but it is not the display path' }),
      bundle({ omitted: ['src/Obsidian/Cache.ts'], files: ['src/main.ts'] }),
    );
    assert.deepEqual(got, [], 'src/main.ts is not omitted, so it is not a request');
  });

  /* ── shape ── */

  test('caps the pin, so "send me the repo" cannot evict everything that scored in', () => {
    const omitted = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    const got = neededSourcePaths(refusal({ neededPaths: omitted }), bundle({ omitted }));
    assert.equal(got.length, 4);
    assert.deepEqual(got, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'kept in the order asked for');
  });

  test('duplicates collapse', () => {
    const got = neededSourcePaths(
      refusal({ neededPaths: ['src/Obsidian/Cache.ts', 'src/Obsidian/Cache.ts'] }),
      bundle({ omitted: ['src/Obsidian/Cache.ts'] }),
    );
    assert.deepEqual(got, ['src/Obsidian/Cache.ts']);
  });

  test('a missing or malformed field is no request, not a throw', () => {
    const omit = bundle({ omitted: ['src/Obsidian/Cache.ts'] });
    assert.deepEqual(neededSourcePaths(refusal(), omit), []);
    assert.deepEqual(neededSourcePaths(refusal({ neededPaths: [] }), omit), []);
    assert.deepEqual(neededSourcePaths(refusal({ suggestion: undefined }), omit), []);
  });
});
