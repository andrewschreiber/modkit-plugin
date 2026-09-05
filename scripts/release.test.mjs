/**
 * release.mjs, against throwaway git repos under the OS temp dir — never this repo.
 *
 * `commitAndTag`/`checkPreconditions` run real `git` commands, and a mistake in the dirty-tree or
 * branch check is exactly the kind of thing that is invisible against a repo that is always clean
 * and always on main. Every git-touching test builds its own repo, and `afterEach` removes it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach, describe } from 'node:test'

import {
  FILES,
  ReleaseError,
  bumpPackageLockVersion,
  bumpVersion,
  checkPreconditions,
  commitAndTag,
  lastReleasedVersion,
  parseSemver,
  planRelease,
  publishRelease,
  restoreVersionBumpFiles,
  verifyBuildArtifacts,
  writeVersionBump,
} from './release.mjs'

/* ────────────────────────────────────────────────────────────────────────────
 * Version math
 * ──────────────────────────────────────────────────────────────────────────── */

describe('bumpVersion', () => {
  test('patch/minor/major', () => {
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
  })

  test('minor and major reset the components below them', () => {
    assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0')
    assert.equal(bumpVersion('0.9.9', 'major'), '1.0.0')
  })

  test('an explicit version is accepted if it is greater', () => {
    assert.equal(bumpVersion('0.1.0', '0.2.0'), '0.2.0')
    assert.equal(bumpVersion('0.1.0', '1.0.0'), '1.0.0')
  })

  test('an explicit version that is not greater is refused', () => {
    assert.throws(() => bumpVersion('0.2.0', '0.2.0'), ReleaseError)
    assert.throws(() => bumpVersion('0.2.0', '0.1.0'), ReleaseError)
  })

  test('a malformed version — current or explicit — is refused, not silently coerced', () => {
    assert.throws(() => parseSemver('v1.2.3'), ReleaseError)
    assert.throws(() => bumpVersion('0.1.0', '1.2'), ReleaseError)
    assert.throws(() => bumpVersion('not-a-version', 'patch'), ReleaseError)
  })

  // The guard is about what has SHIPPED, not about what the working tree happens to say. modkit sat
  // at 0.1.0 with zero tags from the day the repo was created, so measuring against the manifest
  // made its own first release impossible and would have forced a skip to 0.1.1 — a version bump
  // past a release nobody ever received.
  test('with nothing released yet, the manifest version itself is a legal first release', () => {
    assert.equal(bumpVersion('0.1.0', '0.1.0', null), '0.1.0')
    assert.equal(bumpVersion('0.1.0', '0.2.0', null), '0.2.0')
  })

  test('once something is released, the explicit version must beat the RELEASE, not the manifest', () => {
    // Manifest already bumped to 0.2.0 in the tree; 0.1.0 is what actually shipped.
    assert.equal(bumpVersion('0.2.0', '0.2.0', '0.1.0'), '0.2.0')
    assert.throws(() => bumpVersion('0.2.0', '0.1.0', '0.1.0'), ReleaseError)
    assert.throws(() => bumpVersion('0.5.0', '0.3.0', '0.4.0'), ReleaseError)
  })

  test('the refusal names the last release, so the fix is obvious from the message', () => {
    assert.throws(
      () => bumpVersion('0.2.0', '0.1.0', '0.1.0'),
      (err) => err instanceof ReleaseError && /last released version 0\.1\.0/.test(err.message),
    )
  })
})

describe('lastReleasedVersion', () => {
  let repo = null
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = null
  })

  const tag = (...tags) => {
    for (const t of tags) execFileSync('git', ['tag', t], { cwd: repo, stdio: 'ignore' })
  }

  test('no tags at all → null, which is what unblocks the first release', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    assert.equal(lastReleasedVersion(repo), null)
  })

  test('picks the newest by VERSION order, not lexically — 0.10.0 beats 0.9.0', () => {
    repo = makeRepo({ pluginVersion: '0.10.0' })
    tag('0.9.0', '0.10.0', '0.2.0')
    assert.equal(lastReleasedVersion(repo), '0.10.0')
  })

  test('a tag that is not a bare X.Y.Z is ignored, never allowed to block a release', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    tag('nightly', 'v9.9.9', '0.1.0')
    assert.equal(lastReleasedVersion(repo), '0.1.0')
  })

  test('not a git repo → null rather than a throw; the precondition checks report that', () => {
    repo = mkdtempSync(join(tmpdir(), 'modkit-release-notgit-'))
    assert.equal(lastReleasedVersion(repo), null)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * A throwaway repo shaped enough like modkit for planRelease/writeVersionBump to run against
 * ──────────────────────────────────────────────────────────────────────────── */

function makeRepo({ pluginVersion = '0.1.0', rootVersion = '0.1.0', minAppVersion = '1.7.2', existingVersionsJson = null, withLockfile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'modkit-release-'))
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  // This box's global core.hooksPath (Focusbase's post-commit telemetry, see AGENTS.md) still
  // applies to a freshly `git init`'d repo. It's harmless here but noisy — it shells out to
  // `git diff --stat HEAD~1` and fails loudly on every commit a fresh repo makes. A per-repo,
  // local override of a throwaway test repo's own config is not the global config this vault's
  // "never touch git config" rule is about.
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir })

  mkdirSync(join(dir, 'plugin'), { recursive: true })
  writeFileSync(
    join(dir, FILES.pluginManifest),
    `{\n\t"id": "modkit",\n\t"name": "modkit",\n\t"version": "${pluginVersion}",\n\t"minAppVersion": "${minAppVersion}"\n}\n`,
  )
  writeFileSync(join(dir, FILES.pluginPackage), `{\n  "name": "modkit-plugin",\n  "version": "${pluginVersion}"\n}\n`)
  writeFileSync(join(dir, FILES.rootPackage), `{\n  "name": "modkit",\n  "version": "${rootVersion}"\n}\n`)
  if (existingVersionsJson) writeFileSync(join(dir, FILES.versions), `${JSON.stringify(existingVersionsJson, null, 2)}\n`)
  if (withLockfile) {
    // Shaped like the real lockfile just enough to exercise bumpPackageLockVersion: a root entry,
    // a "plugin" workspace entry (both must move with the release version), and one workspace with
    // its OWN version this process must leave alone (packages/modkit-types, in the real lockfile).
    writeFileSync(
      join(dir, FILES.packageLock),
      `${JSON.stringify(
        {
          name: 'modkit',
          version: rootVersion,
          lockfileVersion: 3,
          packages: {
            '': { name: 'modkit', version: rootVersion, workspaces: ['plugin'] },
            plugin: { name: 'modkit-plugin', version: pluginVersion },
            'packages/modkit-types': { name: '@modkit/types', version: '0.1.0' },
          },
        },
        null,
        2,
      )}\n`,
    )
  }

  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir })
  return dir
}

let repo
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

/* ────────────────────────────────────────────────────────────────────────────
 * planRelease — the file set and the versions.json merge, without writing anything
 * ──────────────────────────────────────────────────────────────────────────── */

describe('planRelease', () => {
  test('computes the next version from plugin/manifest.json and the exact file set to touch', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    assert.equal(plan.currentVersion, '0.1.0')
    assert.equal(plan.version, '0.1.1')
    assert.equal(plan.tag, '0.1.1')
    assert.deepEqual(
      [...plan.filesToWrite].sort(),
      [FILES.pluginManifest, FILES.pluginPackage, FILES.rootPackage, FILES.versions, FILES.rootManifest].sort(),
    )
    assert.match(plan.commitMessage, /^release: v0\.1\.1/)
    assert.match(plan.commitMessage, /Co-Authored-By: Claude Fable 5\.1/)
  })

  test('a fresh versions.json gets exactly one entry: the new version to its minAppVersion', () => {
    repo = makeRepo({ pluginVersion: '0.1.0', minAppVersion: '1.7.2' })
    const plan = planRelease({ repo, spec: 'minor' })
    assert.deepEqual(plan.nextVersions, { '0.2.0': '1.7.2' })
    assert.equal(plan.versionsChanged, true)
  })

  test('an existing versions.json is merged, not replaced — history accumulates', () => {
    repo = makeRepo({ pluginVersion: '0.2.0', minAppVersion: '1.7.2', existingVersionsJson: { '0.1.0': '1.7.0' } })
    const plan = planRelease({ repo, spec: 'patch' })
    assert.deepEqual(plan.nextVersions, { '0.1.0': '1.7.0', '0.2.1': '1.7.2' })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * writeVersionBump — the actual file writes, and that they preserve each file's own indent style
 * ──────────────────────────────────────────────────────────────────────────── */

describe('writeVersionBump', () => {
  test('bumps all four files and creates the root manifest copy, preserving indent style', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    writeVersionBump(plan)

    assert.equal(JSON.parse(readFileSync(join(repo, FILES.pluginManifest), 'utf8')).version, '0.1.1')
    assert.equal(JSON.parse(readFileSync(join(repo, FILES.pluginPackage), 'utf8')).version, '0.1.1')
    assert.equal(JSON.parse(readFileSync(join(repo, FILES.rootPackage), 'utf8')).version, '0.1.1')
    assert.equal(JSON.parse(readFileSync(join(repo, FILES.rootManifest), 'utf8')).version, '0.1.1')
    assert.deepEqual(JSON.parse(readFileSync(join(repo, FILES.versions), 'utf8')), { '0.1.1': '1.7.2' })

    // plugin/manifest.json was tab-indented; the bump must not have reformatted it to spaces.
    const rawManifest = readFileSync(join(repo, FILES.pluginManifest), 'utf8')
    assert.match(rawManifest, /\n\t"id"/)
    // package.json was 2-space; same check the other direction.
    const rawPackage = readFileSync(join(repo, FILES.rootPackage), 'utf8')
    assert.match(rawPackage, /\n {2}"name"/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * package-lock.json — only in the file set when the repo has one, and only two entries in it move
 * ──────────────────────────────────────────────────────────────────────────── */

describe('bumpPackageLockVersion', () => {
  test('bumps the root and "plugin" entries, leaves an unrelated workspace alone', () => {
    const lock = {
      version: '0.1.0',
      packages: {
        '': { name: 'modkit', version: '0.1.0', workspaces: ['plugin'] },
        plugin: { name: 'modkit-plugin', version: '0.1.0' },
        'packages/modkit-types': { name: '@modkit/types', version: '0.1.0' },
      },
    }
    const next = bumpPackageLockVersion(lock, '0.1.1')
    assert.equal(next.version, '0.1.1')
    assert.equal(next.packages[''].version, '0.1.1')
    assert.equal(next.packages.plugin.version, '0.1.1')
    // packages/modkit-types versions independently of the release — this process never touches it.
    assert.equal(next.packages['packages/modkit-types'].version, '0.1.0')
    // Key order is untouched — spreading onto the existing objects, not building new ones.
    assert.deepEqual(Object.keys(next.packages), ['', 'plugin', 'packages/modkit-types'])
  })

  test('a lockfile with no "packages" object is left otherwise untouched', () => {
    const next = bumpPackageLockVersion({ version: '0.1.0' }, '0.1.1')
    assert.equal(next.version, '0.1.1')
    assert.equal(next.packages, undefined)
  })
})

describe('writeVersionBump — package-lock.json', () => {
  test('is excluded from filesToWrite when the repo has none', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    assert.equal(plan.filesToWrite.includes(FILES.packageLock), false)
  })

  test('is bumped and included when the repo has one', () => {
    repo = makeRepo({ pluginVersion: '0.1.0', rootVersion: '0.1.0', withLockfile: true })
    const plan = planRelease({ repo, spec: 'patch' })
    assert.equal(plan.filesToWrite.includes(FILES.packageLock), true)

    writeVersionBump(plan)
    const lock = JSON.parse(readFileSync(join(repo, FILES.packageLock), 'utf8'))
    assert.equal(lock.version, '0.1.1')
    assert.equal(lock.packages[''].version, '0.1.1')
    assert.equal(lock.packages.plugin.version, '0.1.1')
    assert.equal(lock.packages['packages/modkit-types'].version, '0.1.0')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * restoreVersionBumpFiles — undoing writeVersionBump after a later step fails
 * ──────────────────────────────────────────────────────────────────────────── */

describe('restoreVersionBumpFiles', () => {
  test('restores tracked files and removes files the bump created fresh', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    // versions.json and root manifest.json don't exist in this fixture repo before the bump —
    // exactly the "created fresh, nothing to check out" case this function has to handle.
    assert.equal(existsSync(join(repo, FILES.versions)), false)
    assert.equal(existsSync(join(repo, FILES.rootManifest)), false)

    const plan = planRelease({ repo, spec: 'patch' })
    writeVersionBump(plan)
    assert.equal(JSON.parse(readFileSync(join(repo, FILES.pluginManifest), 'utf8')).version, '0.1.1')

    restoreVersionBumpFiles(plan)

    assert.equal(JSON.parse(readFileSync(join(repo, FILES.pluginManifest), 'utf8')).version, '0.1.0')
    assert.equal(JSON.parse(readFileSync(join(repo, FILES.rootPackage), 'utf8')).version, '0.1.0')
    assert.equal(existsSync(join(repo, FILES.versions)), false)
    assert.equal(existsSync(join(repo, FILES.rootManifest)), false)
    // The whole point: a failed attempt must leave checkPreconditions exactly as it found the tree.
    assert.deepEqual(checkPreconditions(repo).blockers, [])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * checkPreconditions — dirty tree and branch, including the node_modules-symlink carve-out
 * ──────────────────────────────────────────────────────────────────────────── */

describe('checkPreconditions', () => {
  test('a clean repo on main has no blockers', () => {
    repo = makeRepo()
    const result = checkPreconditions(repo)
    assert.deepEqual(result.blockers, [])
    assert.equal(result.branch, 'main')
  })

  test('refuses a dirty tree', () => {
    repo = makeRepo()
    writeFileSync(join(repo, FILES.rootPackage), '{\n  "name": "modkit",\n  "version": "0.1.0",\n  "extra": true\n}\n')
    const result = checkPreconditions(repo)
    assert.equal(result.blockers.length, 1)
    // Exact match, not just /dirty tree/ — a whole-string .trim() on porcelain output eats the
    // leading space off the FIRST line only (' M package.json' → 'M package.json'), which
    // mis-parses exactly this, the single-dirty-file case, while leaving a second dirty file fine.
    assert.equal(result.blockers[0], 'dirty tree: package.json')
  })

  test('refuses a non-main branch', () => {
    repo = makeRepo()
    execFileSync('git', ['checkout', '-b', 'wt/something'], { cwd: repo })
    const result = checkPreconditions(repo)
    assert.equal(result.blockers.length, 1)
    assert.match(result.blockers[0], /not on main/)
  })

  test('an untracked node_modules (the modkit-wt/* symlink shape) is not a blocker', () => {
    repo = makeRepo()
    // Not an actual symlink — the point of this check is "ignore this path entirely", which covers
    // the symlink case without this test depending on symlink semantics of the host filesystem.
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'node_modules', 'marker'), 'x')
    const result = checkPreconditions(repo)
    assert.deepEqual(result.blockers, [])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * commitAndTag — the actual git operations
 * ──────────────────────────────────────────────────────────────────────────── */

describe('commitAndTag', () => {
  test('commits the bumped files with the trailer and tags the bare version (no v prefix)', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    writeVersionBump(plan)
    commitAndTag(plan)

    const log = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: repo, encoding: 'utf8' })
    assert.match(log, /^release: v0\.1\.1/)
    assert.match(log, /Claude-Session: https:\/\/claude\.ai/)

    const tags = execFileSync('git', ['tag', '--list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(tags, ['0.1.1'])

    assert.equal(checkPreconditions(repo).blockers.length, 0, 'the tree is clean again after commit')
  })

  // The first 0.1.0 run died here on 2026-09-03: the build had already succeeded, the bump wrote the
  // same bytes back, nothing was staged, and `git commit` exited non-zero on "nothing to commit" —
  // clean tree, no tag, no release.
  test('a no-op bump tags HEAD instead of failing on "nothing to commit"', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })

    // Reach the real repo's state: every file the bump touches already committed AT 0.1.0, which is
    // what makes the second write a genuine no-op. A bare makeRepo has no versions.json or root
    // manifest.json, so the first bump legitimately creates them and does stage something.
    writeVersionBump(planRelease({ repo, spec: '0.1.0' }))
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'at 0.1.0, never released'], { cwd: repo, stdio: 'ignore' })

    const plan = planRelease({ repo, spec: '0.1.0' }) // still no tags → 0.1.0 is a legal first release
    assert.equal(plan.version, '0.1.0')

    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    writeVersionBump(plan)
    const result = commitAndTag(plan)

    assert.equal(result.committed, false, 'there was nothing to commit')
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    assert.equal(headAfter, headBefore, 'no empty release commit was fabricated')

    const tagged = execFileSync('git', ['rev-list', '-1', '0.1.0'], { cwd: repo, encoding: 'utf8' }).trim()
    assert.equal(tagged, headBefore, 'the tag points at HEAD')
    assert.equal(checkPreconditions(repo).blockers.length, 0, 'the tree is still clean')
  })

  test('a bump that DOES change files still makes a real commit', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    writeVersionBump(plan)
    const result = commitAndTag(plan)
    assert.equal(result.committed, true)
    assert.match(execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: repo, encoding: 'utf8' }), /^release: v0\.1\.1/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * verifyBuildArtifacts — the BRAT contract checks, against a fabricated plugin/dist
 * ──────────────────────────────────────────────────────────────────────────── */

describe('verifyBuildArtifacts', () => {
  function writeDist(repo, { mainJsBytes, version, includeStyles = true, includeManifest = true }) {
    const dist = join(repo, 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'main.js'), 'x'.repeat(mainJsBytes))
    if (includeManifest) writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ id: 'modkit', version }))
    if (includeStyles) writeFileSync(join(dist, 'styles.css'), '/* ok */')
  }

  test('passes a real-shaped build', () => {
    repo = makeRepo()
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.1.1' })
    const artifacts = verifyBuildArtifacts({ repo, version: '0.1.1' })
    assert.match(artifacts.mainJs, /main\.js$/)
    assert.match(artifacts.manifest, /manifest\.json$/)
    assert.match(artifacts.styles, /styles\.css$/)
  })

  test('rejects a bundle under 10 KB', () => {
    repo = makeRepo()
    writeDist(repo, { mainJsBytes: 2 * 1024, version: '0.1.1' })
    assert.throws(() => verifyBuildArtifacts({ repo, version: '0.1.1' }), /too small/)
  })

  test('rejects a bundle carrying this machine\'s absolute paths', () => {
    repo = makeRepo()
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.1.1' })
    writeFileSync(join(repo, 'plugin', 'dist', 'main.js'), `${'x'.repeat(20 * 1024)}\n// /Users/someone/git/modkit\n`)
    assert.throws(() => verifyBuildArtifacts({ repo, version: '0.1.1' }), /absolute path/)
  })

  test('rejects a version mismatch between the built manifest and the release', () => {
    repo = makeRepo()
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.0.9' })
    assert.throws(() => verifyBuildArtifacts({ repo, version: '0.1.1' }), /expected 0\.1\.1/)
  })

  test('rejects a missing styles.css', () => {
    repo = makeRepo()
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.1.1', includeStyles: false })
    assert.throws(() => verifyBuildArtifacts({ repo, version: '0.1.1' }), /styles\.css/)
  })

  test('falls back to plugin/manifest.json when dist/manifest.json is absent', () => {
    repo = makeRepo({ pluginVersion: '0.1.1' })
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.1.1', includeManifest: false })
    const artifacts = verifyBuildArtifacts({ repo, version: '0.1.1' })
    assert.match(artifacts.manifest, /plugin[\\/]manifest\.json$/)
  })

  test('the manifest.json fallback rejects a main.js older than the bump, not just a version mismatch', () => {
    // Without this, the fallback compares plugin/manifest.json's version against itself (both were
    // just written by the same writeVersionBump call) and can never fail — a build whose emitAssets()
    // silently didn't copy a manifest into dist/ would pass verification on a stale bundle.
    repo = makeRepo({ pluginVersion: '0.1.1' })
    writeDist(repo, { mainJsBytes: 20 * 1024, version: '0.1.1', includeManifest: false })
    const manifestFile = join(repo, FILES.pluginManifest)
    const mainJsFile = join(repo, 'plugin', 'dist', 'main.js')
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 60_000)
    // main.js older than the manifest it's supposedly built from — the stale-build shape.
    utimesSync(mainJsFile, past, past)
    utimesSync(manifestFile, future, future)
    assert.throws(() => verifyBuildArtifacts({ repo, version: '0.1.1' }), /older than/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * The dry-run CLI, end to end against a throwaway repo — no build, no gh, no network
 * ──────────────────────────────────────────────────────────────────────────── */

describe('CLI --dry-run', () => {
  test('prints a complete plan and writes nothing, even off main with a dirty tree', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    execFileSync('git', ['checkout', '-b', 'wt/dry-run-test'], { cwd: repo })
    writeFileSync(join(repo, 'scratch.txt'), 'uncommitted')

    const before = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })

    const releaseScript = new URL('./release.mjs', import.meta.url).pathname
    const run = execFileSync('node', [releaseScript, 'patch', '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, MODKIT_RELEASE_REPO: repo },
    })

    assert.match(run, /0\.1\.0 → 0\.1\.1/)
    assert.match(run, /would refuse: not on main/)
    assert.match(run, /would refuse: dirty tree/)
    assert.match(run, /Dry run only — nothing was written/)

    const after = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    assert.equal(after, before, 'a dry run must not change git status at all')
  })

  test('publishing is opt-in: plain --dry-run reports it as not requested', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const releaseScript = new URL('./release.mjs', import.meta.url).pathname
    const run = execFileSync('node', [releaseScript, 'patch', '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, MODKIT_RELEASE_REPO: repo },
    })
    assert.match(run, /not requested; pass --publish/)
    assert.doesNotMatch(run, /would push and publish/)
  })

  test('--dry-run --publish reports it would push and publish', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const releaseScript = new URL('./release.mjs', import.meta.url).pathname
    const run = execFileSync('node', [releaseScript, 'patch', '--dry-run', '--publish'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, MODKIT_RELEASE_REPO: repo },
    })
    assert.match(run, /would push and publish/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * publishRelease — the parts safe to exercise without a real network call
 * ──────────────────────────────────────────────────────────────────────────── */

describe('publishRelease', () => {
  test('reports not-published, with a reason, when the repo has no "origin" remote', () => {
    repo = makeRepo({ pluginVersion: '0.1.0' })
    const plan = planRelease({ repo, spec: 'patch' })
    // No `git remote add origin` in makeRepo — this exercises the "gh missing" and "no origin"
    // branches without depending on whether `gh` happens to be installed on the machine running
    // the test: whichever check publishRelease reaches first, this repo fails it, and it must
    // never attempt a network call (a passing test here after either path is silent proof of that).
    const result = publishRelease({ repo, plan, artifacts: { mainJs: '', styles: '' }, notesFile: undefined })
    assert.equal(result.published, false)
    assert.equal(typeof result.reason, 'string')
    assert.match(result.reason, /gh CLI not found|no "origin" remote configured/)
  })
})
