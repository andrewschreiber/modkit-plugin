#!/usr/bin/env node
// Cut a release BRAT (obsidian42-brat) can install: bump the version everywhere it has to agree,
// build, verify the three plugin files, commit + tag, and (best-effort) publish a GitHub release.
//
//   node scripts/release.mjs <version|patch|minor|major> [--dry-run] [--publish] [--notes <file>]
//
// BRAT's contract, from PLAN.md L6: the release TAG must equal manifest.json's `version` (no `v`
// prefix), and the release's assets must include main.js, manifest.json and styles.css. Obsidian
// separately expects a `manifest.json` at the repo root — today the source of truth is
// `plugin/manifest.json`, so this script keeps the root copy in sync on every release.
//
// `--publish` pushes the release commit + tag and runs `gh release create`. It is opt-in, not the
// default: `origin` is a real, populated GitHub remote (see publishRelease's doc comment below), so
// a plain `node scripts/release.mjs patch` only ever cuts the LOCAL commit + tag — it never touches
// the network unless asked to.
//
// It is a module first and a CLI second, same shape as install-to-vault.mjs: every step is an
// exported function taking an explicit `repo` root, so a test can point the whole pipeline at a
// throwaway git repo under the OS temp dir instead of this one. `--dry-run` computes the exact
// same plan a real run would and prints it, but calls none of the writing functions — so "prints a
// complete plan and changes nothing" is true by construction, not by a parallel no-op code path
// that could drift from the real one.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `MODKIT_RELEASE_REPO` is a test hook only — it lets release.test.mjs run the real CLI (as a
// subprocess, so it exercises the actual argv/exit-code contract) against a throwaway repo instead
// of this one. A real invocation never sets it; the script always means "release the repo it lives
// in".
const REPO = resolve(process.env.MODKIT_RELEASE_REPO || fileURLToPath(new URL('..', import.meta.url)))

/** Paths are repo-relative everywhere in this file — `plan.repo` is the only place they get joined. */
export const FILES = {
  pluginManifest: 'plugin/manifest.json',
  pluginPackage: 'plugin/package.json',
  rootPackage: 'package.json',
  versions: 'versions.json',
  rootManifest: 'manifest.json',
  packageLock: 'package-lock.json',
}

/** The trailers this build session's commits carry; the release commit is one of them too (L6 brief). */
const TRAILER =
  'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n' +
  'Claude-Session: https://claude.ai/code/session_01TFeuV8ZbwScB9P2mZp1TFi'

/** An error a caller can act on: `hint` is the sentence that tells a human what to do next. */
export class ReleaseError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'ReleaseError'
    this.hint = hint
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Version math
 * ──────────────────────────────────────────────────────────────────────────── */

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''))
  if (!m) throw new ReleaseError(`not a valid semver: ${JSON.stringify(v)}`, 'Versions here are plain X.Y.Z — no pre-release or build metadata.')
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function compareSemver(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

/**
 * `spec` is `patch` | `minor` | `major` | an explicit `X.Y.Z`.
 *
 * An explicit version must be greater than the last **released** version, which is not the same
 * thing as the version in the manifest. `released` is the newest existing tag, or `null` when the
 * repo has never cut one — and in that case the manifest's own version is a legal target, because
 * nothing has claimed it yet. Measured 2026-09-03: with `released` defaulting to `current`, the
 * very first release could never be the version the working tree was already sitting on (modkit
 * had been at 0.1.0 with zero tags since the repo was created), so the first release was forced to
 * skip a version for no reason. Bumping past a version nobody ever received is a lie in the
 * changelog.
 */
export function bumpVersion(current, spec, released = current) {
  if (spec === 'patch' || spec === 'minor' || spec === 'major') {
    const { major, minor, patch } = parseSemver(current)
    if (spec === 'patch') return `${major}.${minor}.${patch + 1}`
    if (spec === 'minor') return `${major}.${minor + 1}.0`
    return `${major + 1}.0.0`
  }
  parseSemver(spec) // throws ReleaseError on a malformed explicit version
  if (released !== null && compareSemver(spec, released) <= 0) {
    throw new ReleaseError(`${spec} is not greater than the last released version ${released}`, 'Pass patch/minor/major, or a version above the last release.')
  }
  return spec
}

/**
 * The newest tag that parses as a release version, or `null` if there are none. Tags here carry no
 * `v` prefix (see `plan.tag`). `--sort=-v:refname` is git's own version-aware ordering, so 0.10.0
 * sorts above 0.9.0 — a plain lexical sort gets that backwards. Anything that isn't a bare X.Y.Z is
 * ignored rather than rejected: an unrelated tag in the repo is not a release and must not be able
 * to block one.
 */
export function lastReleasedVersion(repo) {
  let out
  try {
    out = gitRaw(['tag', '--list', '--sort=-v:refname'], repo)
  } catch {
    return null // not a git repo, or git unavailable — the caller's other checks will say so
  }
  for (const line of out.split('\n')) {
    const tag = line.trim()
    if (/^\d+\.\d+\.\d+$/.test(tag)) return tag
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * JSON read/write that preserves the file's own indent style
 *
 * plugin/manifest.json is tab-indented; the package.jsons are 2-space. Re-serializing with a fixed
 * indent would turn a one-field version bump into a whole-file diff — noisy for review and exactly
 * the kind of accidental reformat that hides the real change. Sniff the indent from the file's own
 * first indented line and write back with the same unit.
 * ──────────────────────────────────────────────────────────────────────────── */

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function detectIndent(raw) {
  const m = /\n([ \t]+)\S/.exec(raw)
  return m ? m[1] : '  '
}

function writeJsonLike(file, obj, { indent } = {}) {
  const unit = indent ?? (existsSync(file) ? detectIndent(readFileSync(file, 'utf8')) : '  ')
  writeFileSync(file, `${JSON.stringify(obj, null, unit)}\n`, 'utf8')
}

/**
 * The only two places in `package-lock.json` that carry the release version rather than a
 * workspace package's own independent version: the root `version` field and its mirror at
 * `packages[""].version`, plus the `plugin` workspace entry (its version tracks `plugin/package.json`
 * one-for-one). `packages/modkit-types` and `packages/*` daemon entries keep their own versions —
 * this release process never touches those, so this function doesn't either. Spreading onto the
 * existing objects (rather than building new ones) keeps every other key in its original position,
 * so the diff is just the changed digits, the same reasoning as {@link writeJsonLike}'s indent sniff.
 */
export function bumpPackageLockVersion(lock, version) {
  const packages = lock.packages ?? {}
  const next = { ...lock, version }
  const patches = {}
  if (packages['']) patches[''] = { ...packages[''], version }
  if (packages.plugin) patches.plugin = { ...packages.plugin, version }
  if (Object.keys(patches).length > 0) next.packages = { ...packages, ...patches }
  return next
}

/* ────────────────────────────────────────────────────────────────────────────
 * git — safety checks and the release commit
 * ──────────────────────────────────────────────────────────────────────────── */

// `stdio` is explicit rather than relying on execFileSync's default (which inherits stderr) —
// `remoteUrl`/`ghAvailable` below expect git to fail routinely (no "origin" yet is normal, per this
// script's own doc comment), and letting every one of those expected failures print a raw `fatal:`
// line to the terminal would bury the real ones. A genuine failure still reaches the caller: it's on
// `err.stderr`, and the top-level handler in `main()` prints `err.message`, which execFileSync
// already folds the command's stderr into.
function gitRaw(args, repo) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** For single-line output (a branch name, a remote URL). NOT for `status --porcelain`: a whole-
 * string `.trim()` eats the leading space off porcelain's first line only (` M foo` → `M foo`),
 * which silently mis-parses the very first dirty file every time — use {@link gitRaw} and trim only
 * the trailing newline for anything with more than one meaningful line. */
function git(args, repo) {
  return gitRaw(args, repo).trim()
}

export function currentBranch(repo) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
}

/** Uncommitted changes to tracked files. Deliberately NOT `git status --porcelain` unfiltered: a
 * `modkit-wt/*` worktree's `node_modules` is a symlink to the main checkout (see AGENTS/CLAUDE.md),
 * and a symlink does not match a `node_modules/`-with-trailing-slash gitignore pattern — so every
 * worktree shows it as a permanent untracked entry that no commit will ever clear. Untracked files
 * in general are not the thing this check is for; a real clone's real `node_modules/` directory
 * *is* correctly ignored, so this only ever matters in a worktree, and only for this one path. */
function dirtyLines(repo) {
  return gitRaw(['status', '--porcelain'], repo)
    .replace(/\n+$/, '')
    .split('\n')
    .filter((line) => line.length > 0 && line.slice(3).replace(/\/$/, '') !== 'node_modules')
}

/**
 * The two preconditions BRAT-quality releases need: a clean tree (so the tag means what it says)
 * and `main` (so a release is never cut from an unmerged branch). Returns the findings rather than
 * always throwing, so `--dry-run` can print "would refuse: …" and keep going instead of stopping at
 * the first check — the whole point of a dry run is seeing the rest of the plan too.
 */
export function checkPreconditions(repo) {
  const branch = currentBranch(repo)
  const dirty = dirtyLines(repo)
  const blockers = []
  if (branch !== 'main') blockers.push(`not on main (currently on ${branch})`)
  if (dirty.length > 0) blockers.push(`dirty tree: ${dirty.map((l) => l.slice(3)).join(', ')}`)
  return { branch, dirty, blockers }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The plan — pure, so a test can assert on it without touching a filesystem beyond one read
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read the current version and compute everything a release run needs to know, without writing
 * anything. `spec` is the CLI's positional argument (`patch` | `minor` | `major` | an explicit
 * version).
 */
export function planRelease({ repo = REPO, spec }) {
  const manifest = readJson(join(repo, FILES.pluginManifest))
  const currentVersion = manifest.version
  const releasedVersion = lastReleasedVersion(repo)
  const version = bumpVersion(currentVersion, spec, releasedVersion)
  const minAppVersion = manifest.minAppVersion
  const versionsFile = join(repo, FILES.versions)
  const existingVersions = existsSync(versionsFile) ? readJson(versionsFile) : {}
  const nextVersions = { ...existingVersions, [version]: minAppVersion }

  // package-lock.json is only in the file set when the repo has one — the throwaway repos this
  // ships its own tests against don't, and a real clone's first `npm install` hasn't run yet
  // either. When it's there, `npm install` (the README's own step 3) rewriting it to the *previous*
  // version is exactly the dirty-tree class of bug that blocks the *next* release (measured:
  // review finding, 2026-09-02), so it has to move in lockstep with the two package.jsons.
  const hasLockfile = existsSync(join(repo, FILES.packageLock))

  return {
    repo,
    spec,
    currentVersion,
    releasedVersion,
    version,
    minAppVersion,
    filesToWrite: [
      FILES.pluginManifest,
      FILES.pluginPackage,
      FILES.rootPackage,
      FILES.versions,
      FILES.rootManifest,
      ...(hasLockfile ? [FILES.packageLock] : []),
    ],
    nextVersions,
    versionsChanged: JSON.stringify(nextVersions) !== JSON.stringify(existingVersions),
    tag: version,
    commitSubject: `release: v${version}`,
    commitMessage: `release: v${version}\n\n${TRAILER}`,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Execute — each step does exactly one thing in the plan and nothing a dry run would need to fake
 * ──────────────────────────────────────────────────────────────────────────── */

/** Steps (b) and (c): bump the four version-bearing files and refresh the root manifest copy. */
export function writeVersionBump(plan) {
  const { repo, version, nextVersions } = plan

  const pluginManifestFile = join(repo, FILES.pluginManifest)
  const pluginManifest = readJson(pluginManifestFile)
  pluginManifest.version = version
  writeJsonLike(pluginManifestFile, pluginManifest)

  const pluginPackageFile = join(repo, FILES.pluginPackage)
  const pluginPackage = readJson(pluginPackageFile)
  pluginPackage.version = version
  writeJsonLike(pluginPackageFile, pluginPackage)

  const rootPackageFile = join(repo, FILES.rootPackage)
  const rootPackage = readJson(rootPackageFile)
  rootPackage.version = version
  writeJsonLike(rootPackageFile, rootPackage)

  writeJsonLike(join(repo, FILES.versions), nextVersions)

  // Root manifest.json is a copy, not a second source of truth — Obsidian's own convention wants
  // one at the repo root, but plugin/manifest.json (the one the built plugin ships) stays canonical.
  writeJsonLike(join(repo, FILES.rootManifest), pluginManifest)

  const lockFile = join(repo, FILES.packageLock)
  if (existsSync(lockFile)) {
    writeJsonLike(lockFile, bumpPackageLockVersion(readJson(lockFile), version))
  }
}

/**
 * Undo {@link writeVersionBump} after a later step (build, verify) fails, so a failed release
 * attempt leaves the tree exactly as clean as {@link checkPreconditions} found it — not half-bumped
 * and blocking the next run with the "commit or stash" hint, which would be the wrong instruction
 * for files nothing should ever commit (review finding, 2026-09-02). `git checkout --` restores a
 * file that was already tracked and clean (which `checkPreconditions` already proved); a file that
 * `writeVersionBump` created fresh (no prior commit to restore from) has no clean version to check
 * out, so it's removed instead — either way the working tree ends up matching the commit this run
 * started from.
 */
export function restoreVersionBumpFiles(plan) {
  for (const file of plan.filesToWrite) {
    try {
      git(['checkout', '--', file], plan.repo)
    } catch {
      try {
        unlinkSync(join(plan.repo, file))
      } catch {
        // Already gone, or never existed — nothing left to undo for this path.
      }
    }
  }
}

/** Step (d): the workspace build, under whatever `node`/`npm` this process is already running on
 * (the release author's own shell — unlike `setup.mjs`, there is no launchd/login-session split to
 * route around here). */
export function runBuild(repo) {
  const result = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit', timeout: 15 * 60_000 })
  if (result.status !== 0) {
    throw new ReleaseError(`npm run build exited ${result.status}`, 'Fix the build and re-run.')
  }
}

/**
 * Step (e). Checks the exact BRAT contract (PLAN.md L6): the three files BRAT installs from exist,
 * the version it will match against a tag is the one just bumped to, and the bundle is neither
 * empty nor carrying a path that only resolves on the machine that built it.
 */
export function verifyBuildArtifacts({ repo, version }) {
  const dist = join(repo, 'plugin', 'dist')
  const problems = []

  const mainJs = join(dist, 'main.js')
  if (!existsSync(mainJs)) {
    problems.push(`missing ${mainJs}`)
  } else {
    const { size } = statSync(mainJs)
    if (size <= 10 * 1024) problems.push(`${mainJs} is only ${size} bytes — too small to be the real bundle`)
    const source = readFileSync(mainJs, 'utf8')
    if (source.includes('/Users/')) problems.push(`${mainJs} contains an absolute path from this machine (/Users/)`)
  }

  const distManifest = join(dist, 'manifest.json')
  const manifestCandidate = existsSync(distManifest) ? distManifest : join(repo, FILES.pluginManifest)
  if (!existsSync(manifestCandidate)) {
    problems.push(`missing a built manifest.json (checked ${distManifest} and ${join(repo, FILES.pluginManifest)})`)
  } else {
    const builtVersion = readJson(manifestCandidate).version
    if (builtVersion !== version) problems.push(`${manifestCandidate} version is ${builtVersion}, expected ${version}`)
    // Falling back to plugin/manifest.json makes the version check above vacuous on its own — it
    // would compare the version writeVersionBump just wrote against itself, passing even if the
    // build's own emitAssets() step silently failed to copy a manifest into dist/. This mtime check
    // is the cheap proxy for "the build actually ran after the bump": it can't prove dist/main.js's
    // *contents* came from this manifest, but a stale main.js older than the bump is still wrong.
    if (manifestCandidate === join(repo, FILES.pluginManifest) && existsSync(mainJs)) {
      if (statSync(mainJs).mtimeMs < statSync(manifestCandidate).mtimeMs) {
        problems.push(`${mainJs} is older than ${manifestCandidate} — the build may not have run after the version bump`)
      }
    }
  }

  if (!existsSync(join(dist, 'styles.css'))) problems.push(`missing ${join(dist, 'styles.css')}`)

  if (problems.length > 0) {
    throw new ReleaseError(`built artifacts do not meet the release contract: ${problems.join('; ')}`, 'Fix the build, or the source it produced, and re-run.')
  }
  return { mainJs, manifest: manifestCandidate, styles: join(dist, 'styles.css') }
}

/** Step (f): one commit carrying every version-bearing file, tagged with the bare version — BRAT
 * matches a release's tag against `manifest.json`'s `version` literally, so no `v` prefix here. */
/**
 * Commit the version bump and tag it.
 *
 * The bump is not always a diff. A first release at the version the manifest already carries writes
 * the same bytes back, so there is nothing staged and `git commit` exits non-zero with "nothing to
 * commit" — which is how the real 0.1.0 run failed on 2026-09-03, after a successful build, leaving
 * a clean tree and no tag. The honest response is to tag HEAD: the commit exists to carry the bump,
 * and with no bump to carry an `--allow-empty` commit would be a release marker pretending to be a
 * change. Returns what happened so the caller can say which it was.
 */
export function commitAndTag(plan) {
  const { repo, filesToWrite, tag, commitMessage } = plan
  git(['add', ...filesToWrite], repo)
  const staged = gitRaw(['diff', '--cached', '--name-only'], repo).trim()
  const committed = staged.length > 0
  if (committed) git(['commit', '-m', commitMessage], repo)
  git(['tag', tag], repo)
  return { committed, taggedRef: committed ? 'the release commit' : 'HEAD' }
}

function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function remoteUrl(repo) {
  try {
    return git(['remote', 'get-url', 'origin'], repo)
  } catch {
    return null
  }
}

/**
 * Step (g) — opt-in via `--publish`, never a side effect of a plain release run.
 *
 * This was written when the repo had no GitHub remote yet, on the premise that a release run "must
 * survive" `gh`/`origin` being absent — so publishing ran unconditionally and just no-op'd when
 * they weren't there. That premise is gone: `origin` is `git@github.com:andrewschreiber/modkit-plugin.git`
 * and resolves (review finding, 2026-09-02), so the unconditional version pushes `HEAD` and a real
 * tag and cuts a real GitHub release on the *first* non-dry-run invocation, silently, on a repo
 * whoever runs it may not know is live. Gating it behind `--publish` makes that a decision instead
 * of a default. The commit and tag from step (f) remain the real, local release either way — this
 * step only adds the remote copy BRAT actually installs from.
 */
export function publishRelease({ repo, plan, artifacts, notesFile }) {
  if (!ghAvailable()) return { published: false, reason: 'gh CLI not found on PATH' }
  const remote = remoteUrl(repo)
  if (!remote) return { published: false, reason: 'no "origin" remote configured' }

  // `gh release create <tag>` only reuses an existing tag if that tag is already on the remote;
  // otherwise it fabricates one from the remote's current default-branch HEAD, which is not the
  // commit this run just made. So the branch and tag have to land on `origin` first — scoped to
  // this step alone, since a dry run and a `gh`-less/remote-less box must never touch the network.
  try {
    git(['push', 'origin', 'HEAD'], repo)
    git(['push', 'origin', plan.tag], repo)
  } catch (err) {
    return { published: false, reason: `could not push to origin: ${err?.message ?? err}`, remote }
  }

  const args = [
    'release',
    'create',
    plan.tag,
    artifacts.mainJs,
    join(repo, FILES.pluginManifest),
    artifacts.styles,
    '--title',
    `v${plan.version}`,
    ...(notesFile ? ['--notes-file', notesFile] : ['--notes', `Release v${plan.version}.`]),
  ]
  try {
    execFileSync('gh', args, { cwd: repo, stdio: 'inherit' })
    return { published: true, remote }
  } catch (err) {
    return { published: false, reason: `gh release create failed: ${err?.message ?? err}`, remote }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

/** Quote one shell argument for a line the user is meant to copy-paste, not execute directly —
 * good enough for the values this script prints (version tags, file paths, `--notes` text), not a
 * general shell-escaping utility. Without this, an unquoted `--notes Release v0.1.1.` prints as if
 * "Release" and "v0.1.1." were separate arguments, which is exactly the shape gh reads them in if
 * pasted verbatim (review finding, 2026-09-02). */
function shQuote(value) {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

async function main() {
  const spec = process.argv[2]
  if (!spec || spec.startsWith('--')) {
    throw new ReleaseError('usage: node scripts/release.mjs <version|patch|minor|major> [--dry-run] [--publish] [--notes <file>]')
  }
  const dryRun = process.argv.includes('--dry-run')
  const publish = process.argv.includes('--publish')
  const notesFile = arg('notes')
  if (notesFile && !existsSync(notesFile)) {
    throw new ReleaseError(`--notes file not found: ${notesFile}`)
  }

  const plan = planRelease({ repo: REPO, spec })
  const pre = checkPreconditions(REPO)

  console.log('')
  console.log(`modkit release — ${REPO}`)
  console.log(`  ${plan.currentVersion} → ${plan.version}  (tag: ${plan.tag})`)
  console.log('')

  console.log(`1. preconditions: branch ${pre.branch}, ${pre.dirty.length === 0 ? 'clean' : `dirty (${pre.dirty.length} file(s))`}`)
  if (pre.blockers.length > 0) {
    for (const b of pre.blockers) console.log(`   ${dryRun ? '⚠ would refuse:' : '✗'} ${b}`)
    if (!dryRun) throw new ReleaseError(`refusing to release: ${pre.blockers.join('; ')}`, 'Commit or stash your changes, and switch to main.')
  } else {
    console.log('   ✓ clean, on main')
  }

  console.log(`2. bump version in: ${plan.filesToWrite.join(', ')}`)
  console.log(`   versions.json[${plan.version}] = ${JSON.stringify(plan.minAppVersion)}${plan.versionsChanged ? '' : ' (unchanged)'}`)
  if (!dryRun) {
    writeVersionBump(plan)
    console.log('   ✓ written')
  } else {
    console.log('   (dry run — not written)')
  }

  // Steps 3 and 4 run with the version bump already on disk (step 2), so a failure here — a broken
  // build, or a built bundle that fails the BRAT contract — has to undo that write before it
  // propagates. Otherwise the tree is left half-released: version-bumped, uncommitted, and blocking
  // the *next* attempt's `checkPreconditions` with a "commit or stash" hint that is wrong advice for
  // files nothing should ever hand-commit (review finding, 2026-09-02).
  console.log('3. build: npm run build')
  if (!dryRun) {
    try {
      runBuild(REPO)
    } catch (err) {
      restoreVersionBumpFiles(plan)
      throw err
    }
    console.log('   ✓ built')
  } else {
    console.log('   (dry run — not run)')
  }

  console.log('4. verify plugin/dist/{main.js,manifest.json,styles.css}')
  let artifacts = null
  if (!dryRun) {
    try {
      artifacts = verifyBuildArtifacts({ repo: REPO, version: plan.version })
    } catch (err) {
      restoreVersionBumpFiles(plan)
      throw err
    }
    console.log(`   ✓ ${artifacts.mainJs}`)
    console.log(`   ✓ ${artifacts.manifest} (version ${plan.version})`)
    console.log(`   ✓ ${artifacts.styles}`)
  } else {
    console.log(`   (dry run — would check main.js >10KB with no /Users/ paths, manifest.json version === ${plan.version}, styles.css present)`)
  }

  console.log(`5. commit "${plan.commitSubject}" and tag ${plan.tag}`)
  if (!dryRun) {
    const { committed } = commitAndTag(plan)
    console.log(committed ? '   ✓ committed and tagged' : `   ✓ tagged HEAD (the bump was a no-op — ${plan.version} was already in the manifest)`)
  } else {
    console.log('   (dry run — not committed)')
  }

  const remote = remoteUrl(REPO)
  const ghArgs = [plan.tag, 'plugin/dist/main.js', FILES.pluginManifest, 'plugin/dist/styles.css', '--title', `v${plan.version}`, ...(notesFile ? ['--notes-file', notesFile] : ['--notes', `Release v${plan.version}.`])]
  const ghArgsQuoted = ghArgs.map(shQuote).join(' ')
  console.log(`6. push + gh release create ${ghArgsQuoted}${publish ? '' : '  (needs --publish)'}`)
  let publishFailed = false
  if (dryRun) {
    console.log(
      `   (dry run — ${publish ? 'would push and publish' : 'not requested; pass --publish to push this release and create a GitHub release'}; gh ${ghAvailable() ? 'is' : 'is NOT'} on PATH; origin ${remote ? `is ${remote}` : 'is not configured'})`,
    )
  } else if (!publish) {
    console.log('   — not requested (pass --publish to push this release and create a GitHub release)')
  } else {
    const published = publishRelease({ repo: REPO, plan, artifacts, notesFile })
    if (published.published) {
      console.log(`   ✓ pushed and published to ${published.remote}`)
    } else {
      // --publish means the caller asked for this to happen — unlike the unrequested case above,
      // reporting a dim "skipped" line and exiting 0 here would be exactly the silent-no-op class
      // this launch exists to eliminate, in the tool that ships it (review finding, 2026-09-02): a
      // release that failed to publish would read as a success to anyone checking `$?`.
      console.error(`   ✗ ${published.reason}`)
      console.error(`     The commit and tag above are already the real local release. To retry publishing:`)
      console.error(`       git push origin HEAD && git push origin ${shQuote(plan.tag)}`)
      console.error(`       gh release create ${ghArgsQuoted}`)
      publishFailed = true
    }
  }

  console.log('')
  if (dryRun) {
    console.log(`Dry run only — nothing was written. Re-run without --dry-run to actually release ${plan.version}.`)
  } else if (publishFailed) {
    console.log(`Released ${plan.version} locally (commit + tag ${plan.tag}) — publishing failed, see above.`)
    process.exitCode = 1
  } else {
    console.log(`Released ${plan.version} locally (commit + tag ${plan.tag}).`)
  }
  console.log('')
}

if (IS_MAIN) {
  try {
    await main()
  } catch (err) {
    console.error('')
    if (err instanceof ReleaseError) {
      console.error(`✗ ${err.message}`)
      if (err.hint) console.error(`  ${err.hint}`)
    } else {
      console.error(`✗ ${err?.message ?? err}`)
    }
    console.error('')
    process.exit(1)
  }
}
