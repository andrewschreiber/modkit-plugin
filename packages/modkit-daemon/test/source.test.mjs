/**
 * Regression test for the measured selection bug: against Tasks 7.14.0
 * (obsidian-tasks-group/obsidian-tasks), the old scoring picked up 11 of 14 files as *vendored*
 * `main.js` bundles of other plugins under `resources/sample_vaults/…/.obsidian/plugins/…` and
 * `contributing/.obsidian/plugins/…` — dataview's alone is 2.36 MB — while only one of Tasks' own
 * 181 `src/` files made it in. `PATH_EXCLUDE` did not exclude `.obsidian/`, `resources/` or
 * `contributing/`, and `scorePath` gave any file named `main.js`/`main.ts`, anywhere in the tree, a
 * +600 bonus meant for the plugin's own entry point.
 *
 * The fixture is the real cached tree listing for this repo@version (copied from a live daemon run),
 * so this is anchored to the actual bug rather than a synthetic tree shaped to make the fix look
 * good.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { SourceFetcher } from '../dist/source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/tasks-7.14.0-tree.json'), 'utf8'),
);

const REPO = FIXTURE.repo;
const TAG = FIXTURE.tag;

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture sanity — the test must be anchored to the real bug.
 * ──────────────────────────────────────────────────────────────────────────── */

test('fixture: contains the vendored dataview bundle that triggered the bug', () => {
  const hit = FIXTURE.entries.find(
    (e) => e.path === 'resources/sample_vaults/Tasks-Demo/.obsidian/plugins/dataview/main.js',
  );
  assert.ok(hit, 'fixture should still contain the vendored dataview main.js');
  assert.ok(hit.size > 1_000_000, 'dataview main.js should be large, as measured (2.36 MB)');
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fake fetch — tag probe, tree API, raw blobs.
 * ──────────────────────────────────────────────────────────────────────────── */

function makeFetchImpl() {
  return async (url) => {
    const href = typeof url === 'string' ? url : url.toString();

    // Tag probe: raw.githubusercontent.com/<repo>/<tag>/manifest.json
    if (href === `https://raw.githubusercontent.com/${REPO}/${TAG}/manifest.json`) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'obsidian-tasks-plugin', version: TAG }),
        headers: { get: () => null },
      };
    }

    // Tree API
    if (href.startsWith(`https://api.github.com/repos/${REPO}/git/trees/`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: FIXTURE.sha,
          truncated: FIXTURE.truncated,
          tree: FIXTURE.entries.map((e) => ({
            path: e.path,
            type: e.type,
            size: e.size,
            sha: e.sha,
          })),
        }),
        headers: { get: () => null },
      };
    }

    // Raw blobs: any path under raw.githubusercontent.com/<repo>/<tag>/...
    const rawPrefix = `https://raw.githubusercontent.com/${REPO}/${TAG}/`;
    if (href.startsWith(rawPrefix)) {
      const path = decodeURIComponent(href.slice(rawPrefix.length));
      let body = `// ${path}\nexport const marker = ${JSON.stringify(path)};\n`;
      if (path === 'src/main.ts') {
        body += `\nexport function getTasks() {\n  return [];\n}\n`;
      }
      return {
        ok: true,
        status: 200,
        text: async () => body,
        headers: { get: () => null },
      };
    }

    return { ok: false, status: 404, text: async () => '', json: async () => ({}), headers: { get: () => null } };
  };
}

async function withFetcher(fn) {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'modkit-source-test-'));
  try {
    const fetcher = new SourceFetcher({ stateDir, fetchImpl: makeFetchImpl() });
    return await fn(fetcher);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The fix.
 * ──────────────────────────────────────────────────────────────────────────── */

test('fetchSource: excludes vendored plugin bundles and favors the target\'s own src/', async () => {
  await withFetcher(async (fetcher) => {
    const result = await fetcher.fetchSource(REPO, TAG, { symbols: ['getTasks'] });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    const { bundle } = result;

    const selected = bundle.files.map((f) => f.path);
    assert.ok(selected.length > 0, 'should select at least one file');

    for (const path of selected) {
      assert.ok(!path.includes('/.obsidian/'), `selected ${path} should not be under .obsidian/`);
      assert.ok(!path.startsWith('resources/'), `selected ${path} should not start with resources/`);
      assert.ok(!path.startsWith('contributing/'), `selected ${path} should not start with contributing/`);
    }

    const srcFiles = bundle.files.filter((f) => f.path.startsWith('src/'));
    assert.ok(
      srcFiles.length >= 10,
      `expected at least 10 files under src/ with default budgets, got ${srcFiles.length}: ${srcFiles
        .map((f) => f.path)
        .join(', ')}`,
    );

    const bySrcScore = [...srcFiles].sort((a, b) => b.score - a.score);
    assert.equal(
      bySrcScore[0]?.path,
      'src/main.ts',
      `src/main.ts should be the highest-scored src/ file, got ${bySrcScore[0]?.path}`,
    );
  });
});
