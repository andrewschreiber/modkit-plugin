#!/usr/bin/env node
/**
 * The `com.brain.modkit-daemon` LaunchAgent: install, uninstall, status.
 *
 *   node scripts/launchagent.mjs install [--node <path>] [--port 8501] [--host 127.0.0.1]
 *   node scripts/launchagent.mjs uninstall
 *   node scripts/launchagent.mjs status
 *   node scripts/launchagent.mjs node          # just report the node it would use, and why
 *
 * It is a module first and a CLI second — `scripts/setup.mjs` imports {@link installAgent},
 * {@link uninstallAgent} and {@link agentStatus}.
 *
 * Three things here are load-bearing, and each is a failure that presents as "daemon unreachable"
 * rather than as itself:
 *
 * 1. **The node is resolved to an absolute path and VERIFIED BY EXECUTING IT.** `node` on this box
 *    is a shell function that lazy-loads nvm, and the first real `node` on `PATH`
 *    (`/usr/local/bin/node`) is **v20.17.0** while the interactive shell gives v24 and the daemon's
 *    `engines` demand `>=22.12`. launchd runs no shell and reads no `.zshrc`, so `/usr/bin/env node`
 *    in a plist would silently pick the v20 and fail at boot — with the whole failure visible only
 *    as a connection refused on :8501. So: enumerate candidates, run `<node> -v` on each, keep the
 *    first that satisfies the floor, and then *import the daemon's own entry module under it* as a
 *    second proof that it can actually load the code it is about to run.
 *
 * 2. **launchd gives almost no environment.** No `PATH` worth the name, no nvm, nothing from the
 *    login shell. The daemon shells out to the `claude` CLI (`claude.ts`'s `DEFAULT_BIN`), so the
 *    `PATH` in the plist is *constructed deliberately* from the directory the resolved `claude`
 *    actually lives in plus the node's own directory plus the system dirs — not copied from
 *    whatever environment happened to run the installer, and not assumed.
 *
 * 3. **Install boots the old instance OUT before booting the new one in.** Re-running `setup` after
 *    a rebuild must actually pick up the new code. The failure this prevents — a stale daemon
 *    serving old code while every file on disk looks correct — is invisible by construction: the
 *    port answers, `/v1/health` is `ok`, and the only symptom is that a change you can read in the
 *    source is not in the behaviour.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LABEL = 'com.brain.modkit-daemon'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DAEMON_ENTRY = join(REPO, 'packages', 'modkit-daemon', 'dist', 'index.js')
const DAEMON_PKG = join(REPO, 'packages', 'modkit-daemon', 'package.json')

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

export function logPaths(stateDir = join(REPO, '.state', 'modkit')) {
  return {
    dir: join(stateDir, 'logs'),
    out: join(stateDir, 'logs', 'daemon.out.log'),
    err: join(stateDir, 'logs', 'daemon.err.log'),
  }
}

function uid() {
  return userInfo().uid
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resolving a node that actually works
 * ──────────────────────────────────────────────────────────────────────────── */

/** `>=22.12` from the daemon's own package.json — never a constant here that drifts from it. */
export function requiredNodeMajorMinor() {
  try {
    const pkg = JSON.parse(readFileSync(DAEMON_PKG, 'utf8'))
    const m = /(\d+)\.(\d+)/.exec(String(pkg?.engines?.node ?? ''))
    if (m) return { major: Number(m[1]), minor: Number(m[2]) }
  } catch {
    /* fall through to the floor below */
  }
  return { major: 22, minor: 12 }
}

function versionOf(nodePath) {
  try {
    const out = execFileSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(out.trim())
    if (!m) return null
    return { raw: out.trim(), major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
  } catch {
    return null
  }
}

function meetsFloor(version, floor) {
  if (!version) return false
  if (version.major !== floor.major) return version.major > floor.major
  return version.minor >= floor.minor
}

function nvmCandidates() {
  const dir = join(homedir(), '.nvm', 'versions', 'node')
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  // Newest first, so a box with thirty nvm installs does not spend its time on node 8.
  return names
    .filter((n) => /^v\d+\./.test(n))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      for (let i = 0; i < 3; i += 1) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
      return 0
    })
    .map((n) => join(dir, n, 'bin', 'node'))
}

function pathCandidates(binary) {
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean)
  return parts.map((p) => join(p, binary))
}

function isExecutableFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Prove the chosen node can *load the daemon*, not merely print a version.
 *
 * Importing `dist/index.js` is side-effect-free — it starts a server only when it is the process
 * entry (`IS_MAIN`) — so this is a real check for a trivial cost, and it catches the class of
 * failure `-v` cannot: a runtime old enough to run but too old for syntax or an API the daemon uses.
 */
function canLoadDaemon(nodePath) {
  if (!existsSync(DAEMON_ENTRY)) return { ok: false, detail: `no build at ${DAEMON_ENTRY}` }
  try {
    execFileSync(
      nodePath,
      ['-e', `import(${JSON.stringify(pathToFileURL(DAEMON_ENTRY).href)}).then(()=>process.exit(0),(e)=>{console.error(String(e&&e.message||e));process.exit(1)})`],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    return { ok: true }
  } catch (err) {
    const detail = String(err?.stderr ?? err?.message ?? err).trim().split('\n').slice(-1)[0]
    return { ok: false, detail }
  }
}

/**
 * The absolute node the plist will name.
 *
 * `process.execPath` is deliberately NOT first: the node running this script is whatever `npm run`
 * resolved, which on this box is the v20 that cannot run the daemon. It is a candidate, not the
 * default.
 */
export function resolveNode({ preferred, verifyLoad = true } = {}) {
  const floor = requiredNodeMajorMinor()
  const seen = new Set()
  const candidates = []
  const push = (p, why) => {
    if (!p) return
    const abs = resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)
    candidates.push({ path: abs, why })
  }

  push(preferred, '--node')
  push(process.env.MODKIT_NODE, '$MODKIT_NODE')
  push('/opt/homebrew/bin/node', 'homebrew')
  for (const c of nvmCandidates()) push(c, 'nvm')
  push(process.execPath, 'the node running this script')
  for (const c of pathCandidates('node')) push(c, '$PATH')
  push('/usr/local/bin/node', 'intel homebrew')

  const rejected = []
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate.path)) continue
    const version = versionOf(candidate.path)
    if (!meetsFloor(version, floor)) {
      rejected.push({ ...candidate, version: version?.raw ?? 'did not run', reason: `needs >=${floor.major}.${floor.minor}` })
      continue
    }
    if (verifyLoad) {
      const load = canLoadDaemon(candidate.path)
      if (!load.ok) {
        rejected.push({ ...candidate, version: version.raw, reason: `cannot import the daemon: ${load.detail}` })
        continue
      }
    }
    return { path: candidate.path, version: version.raw, why: candidate.why, floor, rejected }
  }

  const err = new Error(
    `No node >=${floor.major}.${floor.minor} that can load the daemon was found.\n` +
      rejected.map((r) => `    ${r.path} (${r.version}) — ${r.reason}`).join('\n'),
  )
  err.rejected = rejected
  throw err
}

/** The `claude` CLI the daemon shells out to. Absent is a warning, not a failure — the daemon
 *  serves `/v1/health`, jobs and validation without ever spawning a model. */
export function resolveClaude({ preferred } = {}) {
  const candidates = [
    preferred,
    process.env.MODKIT_CLAUDE_BIN,
    join(homedir(), '.local', 'bin', 'claude'),
    ...pathCandidates('claude'),
    '/opt/homebrew/bin/claude',
  ].filter(Boolean)
  for (const c of candidates) {
    const abs = resolve(c)
    if (isExecutableFile(abs)) return abs
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────────
 * The plist
 * ──────────────────────────────────────────────────────────────────────────── */

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderPlist({ nodePath, entry = DAEMON_ENTRY, cwd = REPO, env = {}, logs }) {
  const pairs = Object.entries(env).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <!-- An ABSOLUTE node, resolved and executed at install time. /usr/bin/env node here would pick
       the first node on launchd's PATH, which is not the one the interactive shell gives and is
       too old to run this daemon. See scripts/launchagent.mjs's header, point 1. -->
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(entry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${pairs.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')}
  </dict>
  <!-- Long-lived HTTP daemon: RunAtLoad so it is up after a reboot without anyone logging into a
       terminal, KeepAlive so a crash comes back. It exits non-zero on EADDRINUSE by design, which
       under KeepAlive becomes a visible crash loop rather than a silent absence. -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- LOAD-BEARING, and it cost a diagnosis on 2026-08-31. The daemon shells out to the \`claude\`
       CLI, whose OAuth credential is reachable only from the user's GUI (Aqua) login session. Under
       the previous \`ProcessType Background\` with no session type, every generation died in 797ms
       with "Failed to authenticate: OAuth session expired and could not be refreshed" — while the
       same binary, same argv, same env and same uid succeeded from a shell. Scrubbing the
       environment with \`env -i\` did NOT reproduce it, because an environment is not a session:
       that test still ran inside the login session. Same class as the Keychain/browser rule in
       brain's CLAUDE.md — a session with no authorization path simply has none.
       \`Interactive\` also keeps it off the background QoS tier, which throttles I/O for a process
       whose whole job is latency-visible HTTP. -->
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logs.err)}</string>
</dict>
</plist>
`
}

/* ────────────────────────────────────────────────────────────────────────────
 * launchctl
 * ──────────────────────────────────────────────────────────────────────────── */

/** A synchronous pause. `installAgent` is sync by design — it is a sequence of launchctl calls that
 *  must not interleave with anything — so it cannot await a timer. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function launchctl(args) {
  try {
    const stdout = execFileSync('launchctl', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, code: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      ok: false,
      code: typeof err?.status === 'number' ? err.status : -1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
    }
  }
}

/**
 * What launchd thinks of us right now.
 *
 * `launchctl print` is the honest source: `launchctl list` reports a pid for a job that is
 * crash-looping just as happily as for one that is healthy, and the field that distinguishes them
 * (`last exit code`) is only in `print`.
 */
export function agentStatus() {
  const plist = plistPath()
  const installed = existsSync(plist)
  const printed = launchctl(['print', `gui/${uid()}/${LABEL}`])
  if (!printed.ok) {
    return { installed, loaded: false, running: false, pid: null, runs: null, lastExitCode: null, plistPath: plist }
  }
  const text = printed.stdout
  const pid = /^\s*pid = (\d+)/m.exec(text)
  const state = /^\s*state = (\S+)/m.exec(text)
  const lastExit = /^\s*last exit code = (\S+)/m.exec(text)
  const program = /^\s*program = (.+)$/m.exec(text)
  // `runs` is the crash-loop tell: under KeepAlive a job that cannot start still reports `loaded`,
  // and the only thing that moves is this counter. `last exit code` appears only while the job is
  // NOT running, so it is absent exactly when you most want it.
  const runs = /^\s*runs = (\d+)/m.exec(text)
  return {
    installed,
    loaded: true,
    running: state?.[1] === 'running' || pid !== null,
    state: state?.[1] ?? null,
    pid: pid ? Number(pid[1]) : null,
    runs: runs ? Number(runs[1]) : null,
    // launchd prints `(never)` for a job that has not exited yet; strip its parens so a caller can
    // wrap the value in its own without producing `last exit ((never))`.
    lastExitCode: lastExit?.[1]?.replace(/^\(|\)$/g, '') ?? null,
    program: program?.[1]?.trim() ?? null,
    plistPath: plist,
  }
}

/** Who is holding a TCP port, so "the daemon is up" can be distinguished from "something is up". */
export function whoHasPort(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const lines = out.trim().split('\n').slice(1)
    return lines
      .map((l) => l.split(/\s+/))
      .filter((f) => f.length > 1)
      .map((f) => ({ command: f[0], pid: Number(f[1]) }))
  } catch {
    return [] // lsof exits 1 with no output when nothing is listening
  }
}

/**
 * Install (or reinstall) the agent. Idempotent, and deliberately destructive of the *old instance*:
 * bootout first, so the process serving :8501 afterwards is the one built from the files on disk.
 */
export function installAgent({
  nodePath,
  stateDir = join(REPO, '.state', 'modkit'),
  host = '127.0.0.1',
  port = 8501,
  extraEnv = {},
  claudeBin = resolveClaude(),
  log = () => {},
} = {}) {
  const resolvedNode = nodePath ?? resolveNode().path
  const logs = logPaths(stateDir)
  mkdirSync(logs.dir, { recursive: true, mode: 0o700 })
  // Create both log files 0600 *before* launchd does, because launchd creates them 0644 and appends
  // to whatever is already there. The daemon's logger redacts the token, but its first-run banner
  // (`auth.ts`'s announceToken) prints the raw secret to stdout — so a stdout log that anyone on the
  // box can read is one unlucky ordering away from being a credential file.
  for (const file of [logs.out, logs.err]) {
    try {
      closeSync(openSync(file, 'a', 0o600))
      chmodSync(file, 0o600)
    } catch {
      /* a log we cannot create is launchd's problem to report, not a reason to refuse to install */
    }
  }

  // Built, not inherited: the directories the daemon's own dependencies live in, then the system
  // ones. `claude` is the reason this is not just "/usr/bin:/bin".
  const pathEntries = [
    dirname(resolvedNode),
    claudeBin ? dirname(claudeBin) : null,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean)
  const env = {
    PATH: [...new Set(pathEntries)].join(':'),
    HOME: homedir(),
    MODKIT_HOST: host,
    MODKIT_PORT: String(port),
    MODKIT_STATE_DIR: stateDir,
    ...extraEnv,
  }

  const plist = plistPath()
  mkdirSync(dirname(plist), { recursive: true })
  const contents = renderPlist({ nodePath: resolvedNode, env, logs })
  writeFileSync(plist, contents, { mode: 0o644 })

  // Bootout is expected to fail the first time (nothing loaded) — that is not an error.
  const booted = launchctl(['bootout', `gui/${uid()}/${LABEL}`])
  if (booted.ok) log(`  stopped the previous ${LABEL}`)

  // `bootout` returns before launchd has finished retiring the job, and bootstrapping a label that
  // is still on its way out fails with the famously unhelpful `Bootstrap failed: 5: Input/output
  // error`. Measured here on 2026-08-31: the very first re-run of `setup` hit it. So wait for the
  // label to actually disappear, then still retry — the wait narrows the race, it does not close it.
  if (booted.ok) {
    for (let i = 0; i < 40; i += 1) {
      if (!launchctl(['print', `gui/${uid()}/${LABEL}`]).ok) break
      sleepSync(250)
    }
  }

  let bootstrap = launchctl(['bootstrap', `gui/${uid()}`, plist])
  for (let i = 0; i < 8 && !bootstrap.ok; i += 1) {
    sleepSync(500)
    bootstrap = launchctl(['bootstrap', `gui/${uid()}`, plist])
  }
  if (!bootstrap.ok) {
    const detail = (bootstrap.stderr || bootstrap.stdout || `exit ${bootstrap.code}`).trim().split('\n')[0]
    throw new Error(
      `launchctl bootstrap failed: ${detail}\n` +
        `    (launchd's "5: Input/output error" usually means the label is still loaded — ` +
        `check: launchctl print gui/$(id -u)/${LABEL})`,
    )
  }
  // RunAtLoad starts it, but kickstart makes "started" synchronous and reports a real error if the
  // job cannot be launched at all (a bad executable path, most usefully).
  launchctl(['kickstart', `gui/${uid()}/${LABEL}`])

  return { plistPath: plist, nodePath: resolvedNode, claudeBin, env, logs }
}

export function uninstallAgent({ log = () => {} } = {}) {
  const plist = plistPath()
  const booted = launchctl(['bootout', `gui/${uid()}/${LABEL}`])
  if (booted.ok) log(`  stopped ${LABEL}`)
  let removed = false
  if (existsSync(plist)) {
    unlinkSync(plist)
    removed = true
  }
  return { removed, plistPath: plist, wasLoaded: booted.ok }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

if (IS_MAIN) {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'status'
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined
  }

  if (cmd === 'node') {
    const node = resolveNode({ preferred: flag('node') })
    console.log(`✓ node ${node.version} at ${node.path} (${node.why}), floor >=${node.floor.major}.${node.floor.minor}`)
    for (const r of node.rejected) console.log(`  skipped ${r.path} (${r.version}) — ${r.reason}`)
    const claude = resolveClaude()
    console.log(claude ? `✓ claude at ${claude}` : '! claude not found — generation will fail until it is on PATH')
  } else if (cmd === 'install') {
    const node = resolveNode({ preferred: flag('node') })
    console.log(`✓ node ${node.version} at ${node.path} (${node.why})`)
    const result = installAgent({
      nodePath: node.path,
      host: flag('host') ?? '127.0.0.1',
      port: Number(flag('port') ?? 8501),
      log: (m) => console.log(m),
    })
    console.log(`✓ ${LABEL} → ${result.plistPath}`)
    console.log(`  logs: ${result.logs.out}`)
    const status = agentStatus()
    console.log(`  ${status.loaded ? `loaded, pid ${status.pid ?? '—'}` : 'NOT loaded'}`)
  } else if (cmd === 'uninstall') {
    const result = uninstallAgent({ log: (m) => console.log(m) })
    console.log(result.removed ? `✓ removed ${result.plistPath}` : `  nothing to remove at ${result.plistPath}`)
  } else if (cmd === 'status') {
    const s = agentStatus()
    console.log(JSON.stringify(s, null, 2))
  } else {
    console.error(`usage: node scripts/launchagent.mjs install|uninstall|status|node`)
    process.exit(2)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Running the daemon in the LOGIN SESSION, which is the default
 *
 * MEASURED 2026-08-31, and it is the reason the LaunchAgent above is not the
 * default path. The daemon shells out to the `claude` CLI. A process started by
 * launchd cannot authenticate it — every call dies in ~70ms with
 *
 *     Failed to authenticate: OAuth session expired and could not be refreshed
 *
 * while the same binary, same argv, same uid, same HOME and a readable
 * ~/.claude/.credentials.json (valid for another 6 hours) succeeds from a shell.
 * Isolated with a bare `launchctl submit` probe running nothing but `claude -p`,
 * so modkit is not involved. `LimitLoadToSessionType Aqua` does NOT fix it: that
 * key controls *when* a job loads, not which session it gets.
 *
 * Scrubbing the environment (`env -i` with launchd's exact variables) does NOT
 * reproduce it, because an environment is not a session — the same distinction
 * brain's CLAUDE.md draws about shell snapshots, one layer down.
 *
 * A detached `nohup` child of a login shell works, so the fix is to start the
 * daemon in the session rather than under launchd. That is also the honest
 * lifetime: this daemon exists to serve Obsidian, which only runs in a GUI
 * session, so it has no work to do when nobody is logged in.
 * ──────────────────────────────────────────────────────────────────────────── */

export function pidFilePath(stateDir = join(REPO, '.state', 'modkit')) {
  return join(stateDir, 'daemon.pid')
}

/** Is `pid` alive and actually our daemon (not a recycled pid)? */
export function sessionStatus(stateDir = join(REPO, '.state', 'modkit')) {
  const file = pidFilePath(stateDir)
  if (!existsSync(file)) return { running: false, pid: null, reason: 'no pidfile' }
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null, reason: 'unreadable pidfile' }
  try {
    process.kill(pid, 0)
  } catch {
    return { running: false, pid, reason: 'pid is gone' }
  }
  // Guard against a recycled pid pointing at something else entirely.
  let cmd = ''
  try {
    cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return { running: false, pid, reason: 'pid is gone' }
  }
  if (!cmd.includes('modkit-daemon')) return { running: false, pid, reason: `pid ${pid} is not the daemon (${cmd.slice(0, 60)})` }
  return { running: true, pid, command: cmd }
}

export function stopSession(stateDir = join(REPO, '.state', 'modkit')) {
  const st = sessionStatus(stateDir)
  if (st.running) {
    try {
      process.kill(st.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  try {
    unlinkSync(pidFilePath(stateDir))
  } catch {
    /* fine */
  }
  return st
}

/**
 * Start the daemon detached, inheriting this login session so `claude` can
 * authenticate. Returns once the pidfile is written; the caller proves liveness
 * with a real HTTP call rather than trusting the spawn.
 */
export async function startInSession({ nodePath, stateDir = join(REPO, '.state', 'modkit'), host, port, log = () => {} }) {
  const { spawn } = await import('node:child_process')
  stopSession(stateDir)
  const logs = logPaths(stateDir)
  mkdirSync(logs.dir, { recursive: true })
  const out = openSync(logs.out, 'a')
  const err = openSync(logs.err, 'a')
  const child = spawn(nodePath, [DAEMON_ENTRY], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, MODKIT_STATE_DIR: stateDir, ...(host ? { MODKIT_HOST: host } : {}), ...(port ? { MODKIT_PORT: String(port) } : {}) },
  })
  child.unref()
  closeSync(out)
  closeSync(err)
  writeFileSync(pidFilePath(stateDir), String(child.pid), { mode: 0o600 })
  log(`started pid ${child.pid} in this login session (logs ${logs.out})`)
  return { pid: child.pid, logs }
}
