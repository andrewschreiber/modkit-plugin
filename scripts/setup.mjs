#!/usr/bin/env node
/**
 * `npm run setup` — build, install, mint, hand over the credentials, supervise, and *prove it works*.
 *
 *   cd ~/git/modkit && npm run setup
 *
 * Setup used to be five steps and three of them were ceremony: start the daemon, copy the printed
 * bearer token, paste it into the plugin's settings, click Test connection, pin the key. That
 * ceremony was designed for the **tailnet** case — daemon on one box, plugin on a phone, a real
 * network hop across which pasting a secret is exactly right — and then applied unchanged to the
 * desktop case, where the daemon and the plugin share a filesystem, a uid and a machine, and the
 * human was acting as a courier between two file paths.
 *
 * So this script carries the token the ten centimetres itself. It loses nothing: every artifact is
 * still Ed25519-signed and still verified against a pinned key by the plugin. The key just arrives
 * over a same-uid 0600 file instead of a clipboard, and anything able to write that file could
 * already write `main.js` into the vault directly.
 *
 * What is left for the human is one click that is genuinely theirs: enabling the plugin in
 * Obsidian, which Obsidian owns and no script may do behind its back.
 *
 * Flags:
 *   --vault <path>   the vault to set up (default: $OBSIDIAN_VAULT, else ~/Documents/Obsidian Vault)
 *   --base-url <url> what the plugin should talk to; only needed for a remote/tailnet daemon
 *   --host <addr>    bind the daemon to this address (sets MODKIT_HOST) instead of 127.0.0.1, and
 *                    seed the sidecar's baseUrl from it — for a phone reaching this box over Tailscale
 *   --tailnet        like --host, but resolve the address with `tailscale ip -4` instead of naming it
 *   --rotate         mint a NEW token and a NEW root signing key (breaks every installed patch's pin)
 *   --no-build       set up whatever is already built
 *   --no-agent       do not start the daemon at all
 *   --agent          use the com.brain.modkit-daemon LaunchAgent instead of this login session
 *                    (launchd cannot authenticate the `claude` CLI here — see launchagent.mjs)
 *   --status         report and change nothing
 *   --reset          remove the LaunchAgent and the sidecar; leave the plugin and the daemon state
 *   --help           print this and do nothing else
 *
 * Every step prints one line saying what it did, and the last section prints what is left to do.
 * This is the first thing a new user runs, so its output is the documentation.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hostname } from 'node:os'

import { defaultVault, installToVault, InstallError } from './install-to-vault.mjs'
import {
  LABEL,
  agentStatus,
  installAgent,
  logPaths,
  plistPath,
  resolveClaude,
  resolveNode,
  sessionStatus,
  startInSession,
  stopSession,
  uninstallAgent,
  whoHasPort,
} from './launchagent.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DAEMON_DIST = join(REPO, 'packages', 'modkit-daemon', 'dist')
const PLUGIN_ID = 'modkit'
const SIDECAR_NAME = 'daemon-token.json'
const SIDECAR_VERSION = 1
/** What `resolveConfig` produces with no environment set — i.e. "the user chose nothing". */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8501'

/**
 * The `_note` a human finds when they open the file. It says what it is, that it is live, and the
 * one setting that would replicate it off this machine — because the person most likely to open
 * this file is the person about to tidy it into `data.json` or turn on hidden-file sync.
 */
const SIDECAR_NOTE =
  "modkit's credentials for this vault — this is a LIVE CREDENTIAL (a bearer token for the modkit " +
  'daemon) and the Ed25519 public key the plugin pins. Keep it out of data.json and out of sync: if ' +
  'you ever turn on Obsidian LiveSync hidden-file sync (syncInternalFiles), add ' +
  '.obsidian/plugins/modkit/daemon-token.json to syncInternalFilesIgnorePatterns, or this token ' +
  'is replicated to every device on the vault. Write it again any time with: npm run setup'

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const val = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

/**
 * The flags this script recognizes, and which of them take a value. Checked against `argv` before
 * anything else runs — an unrecognized `--flag` used to fall through silently into a full real
 * setup (build, vault install, credential mint) with no indication the flag was never read.
 * `--help`/`-h` short-circuit before this check even matters.
 */
const VALUE_FLAGS = new Set(['vault', 'base-url', 'host'])
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, 'tailnet', 'rotate', 'no-build', 'no-agent', 'agent', 'status', 'reset', 'help'])

const USAGE = `Usage: node scripts/setup.mjs [flags]

  --vault <path>   the vault to set up (default: $OBSIDIAN_VAULT, else ~/Documents/Obsidian Vault)
  --base-url <url> what the plugin should talk to; only needed for a remote/tailnet daemon
  --host <addr>    bind the daemon to this address (sets MODKIT_HOST) instead of 127.0.0.1, and
                   seed the sidecar's baseUrl from it — for a phone reaching this box over Tailscale
  --tailnet        like --host, but resolve the address with \`tailscale ip -4\` instead of naming it
  --rotate         mint a NEW token and a NEW root signing key (breaks every installed patch's pin)
  --no-build       set up whatever is already built
  --no-agent       do not start the daemon at all
  --agent          use the com.brain.modkit-daemon LaunchAgent instead of this login session
  --status         report and change nothing
  --reset          remove the LaunchAgent and the sidecar; leave the plugin and the daemon state
  --help           print this and do nothing else
`

/** Every `--flag` in argv that is not in {@link KNOWN_FLAGS}, skipping over each value flag's own value. */
function unknownFlags() {
  const bad = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    if (!KNOWN_FLAGS.has(name)) bad.push(arg)
    else if (VALUE_FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1
  }
  return bad
}

let stepNo = 0
const step = (msg) => console.log(`${String(++stepNo).padStart(2, ' ')}. ${msg}`)
const ok = (msg) => console.log(`    ✓ ${msg}`)
const info = (msg) => console.log(`    ${msg}`)
const warn = (msg) => console.log(`    ⚠ ${msg}`)

/** Fail with the step that failed and the sentence that fixes it — never a bare stack. */
export class SetupError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'SetupError'
    this.hint = hint
  }
}

/**
 * Did the daemon we just spawned actually stay up?
 *
 * `startInSession` returns as soon as the child is *spawned*, which is strictly earlier than the
 * child binding its port — so the pid it hands back is not evidence of anything. Printing it as
 * though it were was measured on 2026-09-05: with another process already on the port, setup said
 * `✓ daemon running as pid 95166` while that pid was already dead of EADDRINUSE, and the only real
 * symptom surfaced two steps later as an unexplained 404 from the other process's service.
 *
 * `sessionStatus` is the honest probe — it checks the pid is alive *and* that it is the daemon
 * rather than a recycled pid — so this just polls it to a deadline. Injectable clock and sleep so
 * the wait is testable without one.
 */
export async function confirmDaemonUp({ status, portHolders, port, deadlineMs = 5_000, now = () => Date.now(), sleep }) {
  const until = now() + deadlineMs
  let last = status()
  for (;;) {
    // Liveness is NOT the evidence, and believing it was is how the first version of this function
    // reproduced the very bug it was written for: a process that cannot bind is still alive for the
    // few milliseconds between spawn and EADDRINUSE, so polling "is the pid up" returned true and
    // setup printed ✓ again. The daemon is up when it is *serving*, so the question to ask is
    // whether our pid holds the port.
    if (last.running && portHolders(port).some((h) => h.pid === last.pid)) return { ...last, running: true }
    if (now() >= until) {
      return last.running
        ? { running: false, pid: last.pid, reason: `it never bound port ${port} (something else is holding it)` }
        : last
    }
    await sleep(100)
    last = status()
  }
}

/**
 * The one line of a dead daemon's log that explains itself, turned into something to do about it.
 * Returns `null` when the log says nothing useful — the caller still reports the failure, just
 * without a cause.
 */
export function daemonLogFailure(text) {
  if (typeof text !== 'string') return null
  const lines = text.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!entry || entry.level !== 'error') continue
    const message = String(entry.err?.message ?? entry.msg ?? '')
    if (entry.code === 'EADDRINUSE' || message.includes('EADDRINUSE')) {
      // The LAST error line is "modkit daemon failed to start", which carries the message but not
      // the structured `port` the "could not bind" line above it has — so read the port out of the
      // message when the field is absent, rather than printing "port that port".
      const port = entry.port ?? message.match(/:(\d+)\b/g)?.at(-1)?.slice(1) ?? null
      return port === null
        ? 'the port it wants is already held by another process. Stop that process, or set MODKIT_PORT to a free port and run setup again.'
        : `port ${port} is already held by another process. Stop it, or set MODKIT_PORT to a free port and run setup again.`
    }
    return message || null
  }
  return null
}

function readTextMaybe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readJsonMaybe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function redact(token) {
  if (typeof token !== 'string' || token.length < 12) return '(none)'
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`
}

/* ────────────────────────────────────────────────────────────────────────────
 * --host / --tailnet — L5 mobile reachability
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The real `tailscale ip -4`. A separate, injectable function — `resolveHostFlag` below takes it as
 * a parameter — purely so a test can supply a fake and exercise `--tailnet`'s wiring without a real
 * tailscale binary, without the wiring itself branching on "are we under test".
 */
export function resolveTailnetIp() {
  const run = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 })
  if (run.error?.code === 'ENOENT') {
    throw new SetupError(
      '--tailnet was passed but the `tailscale` command was not found.',
      'Install/start Tailscale, or pass --host <addr> with the address directly.',
    )
  }
  if (run.error) {
    // Any OTHER failure to even run the command (EACCES, the 5s timeout above firing) — as
    // opposed to `tailscale` running and exiting non-zero, handled below. Without this, `run.status`
    // is `null` here and the branch below throws the unhelpful "exited null: ".
    throw new SetupError(
      `--tailnet: could not run \`tailscale\`: ${run.error.message}`,
      'Check that `tailscale` is installed and runnable, or pass --host <addr> directly.',
    )
  }
  if (run.status !== 0) {
    throw new SetupError(
      `--tailnet: \`tailscale ip -4\` exited ${run.status}: ${(run.stderr || run.stdout || '').trim()}`,
      'Is `tailscale up` running on this box? Check `tailscale status`, or pass --host <addr> directly.',
    )
  }
  const ip = run.stdout.trim().split('\n')[0]?.trim()
  if (!ip) {
    throw new SetupError('--tailnet: `tailscale ip -4` printed nothing.', 'Check `tailscale status`, or pass --host <addr> directly.')
  }
  return ip
}

/**
 * `--host <addr>` and `--tailnet` are two ways to say the same thing — "bind MODKIT_HOST to this
 * address, and seed the sidecar from it" — so they resolve to one value here rather than each
 * threading its own branch through the rest of `main()`. Returns `null` when neither was passed,
 * which callers read as "behave exactly as before this flag existed."
 *
 * Pure enough to unit-test: the only side effect is `resolveIp()`, passed in rather than called
 * directly, so `scripts/setup.test.mjs` can hand it a fake and never shell out to a real
 * `tailscale`.
 */
export function resolveHostFlag({ host, tailnet }, resolveIp = resolveTailnetIp) {
  if (host !== undefined && tailnet) {
    throw new SetupError(
      '--host and --tailnet are mutually exclusive.',
      'Pass --host <addr> to name the address yourself, or --tailnet to resolve it from `tailscale ip -4` — not both.',
    )
  }
  if (tailnet) return resolveIp()
  return host ?? null
}

/**
 * What the sidecar's `baseUrl` should be, given what the user asked for.
 *
 * `--base-url` is the most explicit thing a user can say and always wins. Otherwise, `--host`/
 * `--tailnet` count as an equally explicit choice — the whole point of L5 is that this run's daemon
 * is now bound to `stateBaseUrl`, so the sidecar must adopt it rather than falling under the
 * existing "don't drag a deliberately-remote baseUrl back to loopback" rule (`writeSidecarFallback`/
 * `writeSidecar`'s `overwriteBaseUrl`), which exists to protect a choice made on a *previous* run
 * from an *unrelated* one — not to override the choice this run just made. Returns `undefined`
 * (never called explicit) exactly when neither flag was given, so `overwriteBaseUrl` downstream
 * stays `false` and that existing rule is untouched for the plain, no-flags case.
 */
export function chooseExplicitBaseUrl({ baseUrlFlag, resolvedHost, stateBaseUrl }) {
  if (baseUrlFlag !== undefined) return baseUrlFlag
  if (resolvedHost !== null) return stateBaseUrl
  return undefined
}

async function get(url, { token, timeoutMs = 4000 } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* an error body that is not JSON is still useful as text */
  }
  return { status: res.status, json, text }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 4 — daemon state, minted in a subprocess by a node that can actually run it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Run a snippet against the daemon's *own* modules, under a node that can actually load them.
 *
 * It is a subprocess for two reasons. First, this script runs under whatever node `npm run`
 * resolved — on this box `/usr/local/bin/node` v20.17.0, below the daemon's `engines` floor — so
 * importing daemon code in-process is not safe. Second, going through `state.ts`/`auth.ts`/
 * `sign.ts`/`sidecar.ts` means "mint if absent, reuse if present", the 0600 modes, the atomic
 * writes, the delegation-cert renewal and the whole sidecar contract stay the daemon's definitions
 * of those things and cannot drift from a second copy living here.
 */
function inDaemon({ nodePath, script, env, what, hint }) {
  const run = spawnSync(nodePath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  if (run.status !== 0) {
    throw new SetupError(
      `${what}: ${(run.stderr || run.stdout || `exit ${run.status}`).trim().split('\n').slice(-3).join(' ')}`,
      hint,
    )
  }
  try {
    return JSON.parse(run.stdout)
  } catch {
    throw new SetupError(`${what}: the helper printed something unparseable — ${run.stdout.slice(0, 200)}`)
  }
}

const distUrl = (f) => JSON.stringify(pathToFileURL(join(DAEMON_DIST, f)).href)

function ensureDaemonState({ nodePath, env }) {
  return inDaemon({
    nodePath,
    env,
    what: 'could not mint or read the daemon state',
    hint: 'Is the daemon built? Run: npm run build',
    script: `
    const [{ createLogger }, state, { loadOrCreateToken }, { loadKeyring }] = await Promise.all([
      import(${distUrl('log.js')}), import(${distUrl('state.js')}), import(${distUrl('auth.js')}), import(${distUrl('sign.js')})]);
    const config = state.resolveConfig(process.env);
    const layout = state.ensureState(config.stateDir);
    const log = createLogger({ file: layout.logFile, level: 'warn', stdout: false });
    const token = loadOrCreateToken(layout, log);
    const keyring = loadKeyring(layout, log, { certTtlMs: config.certTtlMs, certRenewBeforeMs: config.certRenewBeforeMs });
    process.stdout.write(JSON.stringify({
      stateDir: config.stateDir, host: config.host, port: config.port, version: config.version, model: config.model,
      baseUrl: state.daemonBaseUrl(config),
      token: token.token, tokenFile: token.file, tokenCreated: token.created,
      rootPubkey: keyring.rootPubkeyHex, signPubkey: keyring.signPubkeyHex, kid: keyring.kid, certNotAfter: keyring.certNotAfter,
    }));
  `,
  })
}

/**
 * `--rotate`: move the current secrets aside so the next load mints fresh ones.
 *
 * Renamed, never deleted — a rotation that turns out to be a mistake is recoverable, and a signing
 * key is the one file in this tree that cannot be re-derived. Every already-installed patch pins the
 * *old* root key, so this is deliberately not something that can happen by accident.
 */
function rotateSecrets(stateDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const moved = []
  for (const rel of ['daemon.token', 'secrets/root.key', 'secrets/sign.key', 'secrets/cert.json']) {
    const file = join(stateDir, rel)
    if (!existsSync(file)) continue
    const to = `${file}.rotated-${stamp}`
    renameSync(file, to)
    moved.push(rel)
  }
  return moved
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 5 — the sidecar
 * ──────────────────────────────────────────────────────────────────────────── */

function sidecarPath(vault) {
  return join(vault, '.obsidian', 'plugins', PLUGIN_ID, SIDECAR_NAME)
}

/**
 * The sidecar is written by `packages/modkit-daemon/src/sidecar.ts` — `writeSidecar()` — and
 * **the precedence rule lives there, not here**.
 *
 * That matters for the one field with a rule. `token` and `pinnedPublicKey` are authoritative: this
 * file is the record of a completed setup, so a later run overwrites them. `baseUrl` is only a
 * *seed* — someone who deliberately pointed this plugin at a daemon on another box must not have it
 * silently dragged back to loopback by a `setup` run here, so an existing non-default `baseUrl` is
 * kept unless `--base-url` says otherwise (`overwriteBaseUrl`). One implementation of that rule,
 * with the plugin's `applyPairing()` enforcing the same thing from its side; a second copy in this
 * script is exactly how the two would drift.
 */
function writeSidecarViaDaemon({ nodePath, pluginDir, identity, overwriteBaseUrl, env }) {
  return inDaemon({
    nodePath,
    env,
    what: "could not write the daemon's credentials",
    hint: 'Is the plugin installed in that vault? The folder must contain modkit\'s manifest.json.',
    script: `
    const { writeSidecar } = await import(${distUrl('sidecar.js')});
    const result = writeSidecar(${JSON.stringify(pluginDir)}, ${JSON.stringify(identity)}, ${JSON.stringify({ overwriteBaseUrl })});
    process.stdout.write(JSON.stringify(result));
  `,
  })
}

/**
 * The fallback, for a tree where `sidecar.js` has not been built yet: write the documented contract
 * directly. Same bytes, same mode, same key order.
 */
function writeSidecarFallback({ file, identity, existing }) {
  const previous = typeof existing?.baseUrl === 'string' ? existing.baseUrl : null
  const keep = previous !== null && previous !== DEFAULT_BASE_URL && previous !== identity.baseUrl
  const record = {
    _note: SIDECAR_NOTE,
    version: SIDECAR_VERSION,
    baseUrl: keep ? previous : identity.baseUrl,
    token: identity.token,
    pinnedPublicKey: identity.publicKeyHex,
    pairedAt: new Date().toISOString(),
    pairedBy: `modkit setup ${identity.version ?? '0.0.0'} on ${hostname()}`,
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return {
    path: file,
    created: existing === null,
    baseUrl: record.baseUrl,
    baseUrlPreserved: keep,
    previousBaseUrl: previous,
    pairedAt: record.pairedAt,
    pairedBy: record.pairedBy,
    mode: 0o600,
    tokenChanged: existing?.token !== identity.token,
    publicKeyChanged: existing?.pinnedPublicKey !== identity.publicKeyHex,
    changes: existing === null ? [`wrote the daemon's credentials to ${file}`] : [],
  }
}

/**
 * The contract, re-checked on the bytes that are actually on disk.
 *
 * `writeSidecar` already reads its own write back, and this checks it again anyway — for the
 * documented local reason that this repo has a class of writes that report success and put nothing
 * on disk, and because the thing about to be trusted is a credential.
 */
function checkSidecar(record, expect) {
  const problems = []
  if (!record) return ['the file is missing or is not JSON']
  if (record.version !== SIDECAR_VERSION) problems.push(`version is ${JSON.stringify(record.version)}, expected ${SIDECAR_VERSION}`)
  if (record.token !== expect.token) problems.push('token does not match the daemon state')
  if (record.pinnedPublicKey !== expect.publicKeyHex) problems.push('pinnedPublicKey does not match the daemon root key')
  if (typeof record.baseUrl !== 'string' || record.baseUrl === '') problems.push('baseUrl is missing')
  if (typeof record.pairedAt !== 'string') problems.push('pairedAt is missing')
  if (typeof record.pairedBy !== 'string') problems.push('pairedBy is missing')
  if (typeof record._note !== 'string' || record._note.length < 40) problems.push('_note is missing or too short to help anyone')
  return problems
}

function sidecarMode(file) {
  try {
    return statSync(file).mode & 0o777
  } catch {
    return null
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Step 7 — proof
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Prove the setup by *using* it.
 *
 * Writing files is not evidence — the whole class of bug this replaces (a stale daemon, a token
 * that never landed, a key the plugin would refuse) looks perfect on disk. So: wait for health,
 * read the pubkey the daemon actually serves, make an authenticated call with the token that is in
 * the sidecar, and confirm an unauthenticated call is still refused.
 */
async function proveEndToEnd({ baseUrl, sidecar, expectPubkey, timeoutMs = 20_000 }) {
  const deadline = Date.now() + timeoutMs
  let health = null
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await get(`${baseUrl}/v1/health`)
      if (res.status === 200 && res.json?.ok === true) {
        health = res.json
        break
      }
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = err?.message ?? String(err)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!health) {
    throw new SetupError(`nothing answered ${baseUrl}/v1/health within ${timeoutMs / 1000}s (${lastErr})`)
  }

  if (health.pubkey !== expectPubkey) {
    throw new SetupError(
      `the daemon at ${baseUrl} serves pubkey ${health.pubkey}, but the sidecar pins ${expectPubkey}`,
      'That is a different daemon than the state these credentials came from. Check --base-url, or re-run with --rotate only if you mean to invalidate every installed patch.',
    )
  }

  // `/v1/jobs` is the cheapest authenticated route: no model, no state written, and it answers with
  // the job history — which is also a useful thing for setup to report. (`/v1/mods` was used here
  // until 2026-09-02; that route was deleted because nothing ever wrote what it read.)
  const authed = await get(`${baseUrl}/v1/jobs`, { token: sidecar.token })
  if (authed.status !== 200) {
    throw new SetupError(
      `the token in the sidecar was refused: GET /v1/jobs → HTTP ${authed.status} ${authed.json?.detail ?? authed.text.slice(0, 120)}`,
      'The running daemon is using a different token than the one on disk — it is probably an older process. Re-run: npm run setup',
    )
  }

  const anon = await get(`${baseUrl}/v1/jobs`)
  const authIsOn = anon.status === 401

  return { health, jobs: Array.isArray(authed.json?.jobs) ? authed.json.jobs.length : 0, authIsOn }
}

/**
 * A single, short, advisory `/v1/health`. Never throws.
 *
 * This is for the origin the *plugin* will call when that is not this box's daemon. Whether a
 * tailnet host answers from here is not a fact about whether this setup run did its job, so it is
 * reported and never raised — see step 7.
 */
async function probeHealth(baseUrl, timeoutMs = 5000) {
  try {
    const res = await get(`${baseUrl}/v1/health`, { timeoutMs })
    if (res.status !== 200 || res.json?.ok !== true) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    return { ok: true, pubkey: res.json.pubkey, version: res.json.version, model: res.json.model }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * --status
 * ──────────────────────────────────────────────────────────────────────────── */

async function reportStatus({ vault }) {
  console.log(`modkit setup — status`)
  console.log(`  repo   ${REPO}`)
  console.log(`  vault  ${vault}`)

  const pluginDir = join(vault, '.obsidian', 'plugins', PLUGIN_ID)
  const manifest = readJsonMaybe(join(pluginDir, 'manifest.json'))
  const community = readJsonMaybe(join(vault, '.obsidian', 'community-plugins.json'))
  const enabled = Array.isArray(community) && community.includes(PLUGIN_ID)
  console.log(
    manifest
      ? `  plugin installed: ${manifest.name} ${manifest.version}, ${enabled ? 'ENABLED' : 'not enabled'}`
      : `  plugin NOT installed at ${pluginDir}`,
  )

  const file = sidecarPath(vault)
  const sidecar = readJsonMaybe(file)
  if (sidecar) {
    console.log(`  sidecar ${file}`)
    console.log(`    baseUrl ${sidecar.baseUrl}  token ${redact(sidecar.token)}`)
    console.log(`    pins    ${sidecar.pinnedPublicKey}`)
    console.log(`    written ${sidecar.pairedAt} by ${sidecar.pairedBy}`)
  } else {
    console.log(`  sidecar NOT present (${file}) — run: npm run setup`)
  }

  const stateDir = process.env.MODKIT_STATE_DIR ?? join(REPO, '.state', 'modkit')
  console.log(
    existsSync(join(stateDir, 'daemon.token'))
      ? `  daemon state present at ${stateDir}`
      : `  daemon state NOT minted at ${stateDir}`,
  )

  const agent = agentStatus()
  console.log(
    `  agent ${LABEL}: ${agent.installed ? 'plist present' : 'no plist'}, ` +
      `${agent.loaded ? `loaded (state=${agent.state ?? '?'}, pid=${agent.pid ?? '—'}, runs=${agent.runs ?? '—'}, last exit=${agent.lastExitCode ?? '—'})` : 'not loaded'}`,
  )
  if (agent.installed) {
    console.log(`    ${agent.plistPath}`)
    console.log(`    logs ${logPaths(stateDir).out}`)
  }

  const baseUrl = sidecar?.baseUrl ?? 'http://127.0.0.1:8501'
  const port = Number(new URL(baseUrl).port || 80)
  const holders = whoHasPort(port)
  if (holders.length > 0) console.log(`  port ${port} held by ${holders.map((h) => `${h.command}(${h.pid})`).join(', ')}`)

  try {
    const health = await get(`${baseUrl}/v1/health`, { timeoutMs: 3000 })
    if (health.status === 200) {
      console.log(`  daemon ${baseUrl} ok — v${health.json.version}, model ${health.json.model}, pubkey ${health.json.pubkey.slice(0, 16)}…`)
      if (sidecar) {
        const pinOk = health.json.pubkey === sidecar.pinnedPublicKey
        const authed = await get(`${baseUrl}/v1/jobs`, { token: sidecar.token, timeoutMs: 3000 })
        console.log(`  pin ${pinOk ? 'MATCHES' : 'DOES NOT MATCH'} the running daemon; token ${authed.status === 200 ? 'accepted' : `REFUSED (HTTP ${authed.status})`}`)
      }
    } else {
      console.log(`  daemon ${baseUrl} answered HTTP ${health.status}`)
    }
  } catch (err) {
    console.log(`  daemon ${baseUrl} unreachable (${err?.message ?? err})`)
  }

  try {
    const node = resolveNode({ verifyLoad: existsSync(join(DAEMON_DIST, 'index.js')) })
    console.log(`  node for launchd: ${node.path} (${node.version}, ${node.why})`)
  } catch (err) {
    console.log(`  node for launchd: NONE FOUND — ${String(err.message).split('\n')[0]}`)
  }
  const claude = resolveClaude()
  console.log(claude ? `  claude CLI: ${claude}` : '  claude CLI: not found — generation will fail until it is on PATH')
}

/* ────────────────────────────────────────────────────────────────────────────
 * --reset
 * ──────────────────────────────────────────────────────────────────────────── */

function reset({ vault }) {
  console.log('modkit reset — stopping the daemon and taking back its credentials')
  console.log('(the plugin stays installed, and the daemon\'s own state is left alone)')
  console.log('')
  const agent = uninstallAgent({ log: (m) => console.log(m) })
  console.log(agent.removed ? `  ✓ removed ${agent.plistPath}` : `  nothing to remove at ${agent.plistPath}`)
  // The daemon this script starts by default lives in the login session, not under launchd
  // (see step 6). Measured 2026-09-03 on a fresh box: a reset that only removed the plist left pid
  // 86683 listening on :8501 after printing "stopping the daemon". Stop that one too.
  const stateDir = process.env.MODKIT_STATE_DIR ?? join(REPO, '.state', 'modkit')
  const session = stopSession(stateDir)
  console.log(
    session.running
      ? `  ✓ stopped the login-session daemon (pid ${session.pid})`
      : `  no login-session daemon to stop (${session.reason ?? 'not running'})`,
  )
  const file = sidecarPath(vault)
  if (existsSync(file)) {
    unlinkSync(file)
    console.log(`  ✓ removed ${file}`)
  } else {
    console.log(`  no credentials at ${file}`)
  }
  console.log('')
  console.log('  The token and signing keys are untouched in .state/modkit, so `npm run setup`')
  console.log('  puts everything back and every already-installed patch still verifies.')
}

/* ────────────────────────────────────────────────────────────────────────────
 * The main flow
 * ──────────────────────────────────────────────────────────────────────────── */

async function main() {
  if (has('help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const bad = unknownFlags()
  if (bad.length > 0) {
    throw new SetupError(`unrecognized flag(s): ${bad.join(', ')}`, 'Run with --help to see the accepted flags.')
  }
  if (has('host') && val('host') === undefined) {
    // `val()` returns the fallback (here, `undefined`) both when `--host` is absent AND when it was
    // typed with no address after it — `has('host')` is what tells the two apart. Left unguarded,
    // a forgotten value silently resolved to "no host at all": the daemon bound loopback and the
    // sidecar kept loopback, with nothing on screen but the ABSENCE of one `info` line to notice.
    throw new SetupError('--host requires an address (e.g. --host 100.64.1.2).', 'Pass the address, or use --tailnet to resolve it automatically.')
  }
  // Resolved this early — before the build step below, which can run for minutes — because a bad
  // `--host`/`--tailnet` (mutually exclusive, or no `tailscale` binary) is a fact about the command
  // line, not about the build, and failing on it should not cost the user a build first.
  const resolvedHost = resolveHostFlag({ host: val('host'), tailnet: has('tailnet') })

  const vault = resolve(val('vault', defaultVault()))

  if (has('status')) {
    await reportStatus({ vault })
    return
  }
  if (has('reset')) {
    reset({ vault })
    return
  }

  console.log('')
  console.log(`modkit setup — ${REPO}`)
  console.log('')

  // ── 1. the vault ──────────────────────────────────────────────────────────
  step(`vault: ${vault}`)
  if (!existsSync(join(vault, '.obsidian'))) {
    throw new SetupError(`not an Obsidian vault (no .obsidian directory): ${vault}`, 'Pass --vault <path> or set $OBSIDIAN_VAULT.')
  }
  ok('found .obsidian')

  // ── 2. build ──────────────────────────────────────────────────────────────
  if (has('no-build')) {
    step('build: skipped (--no-build)')
  } else {
    step('build: types → plugin → daemon')
    // The most likely way a *new* user meets this script is on a fresh clone, and the failure that
    // produces — `tsc` missing — surfaces as a raw MODULE_NOT_FOUND stack from inside a workspace
    // build, under a hint that says "fix the build". Measured on 2026-08-31. Naming the actual
    // command costs one `existsSync` and is the difference between a 30-second fix and a hunt.
    if (!existsSync(join(REPO, 'node_modules', '.bin', 'tsc'))) {
      throw new SetupError(
        'dependencies are not installed (no node_modules/.bin/tsc)',
        `Run this first:  cd ${REPO} && npm install`,
      )
    }
    // Run npm with a PATH whose first entry is a node that satisfies the daemon's engines. The node
    // `npm run` resolves on this box is v20.17.0, and a build that half-works under it is a worse
    // outcome than one that never started. verifyLoad is off here: on a fresh clone there is no
    // dist to import yet, which is precisely what this step is about to fix.
    const buildNode = resolveNode({ verifyLoad: false })
    const env = { ...process.env, PATH: `${dirname(buildNode.path)}:${process.env.PATH ?? ''}` }
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO, env, stdio: 'inherit', timeout: 15 * 60_000 })
    if (build.status !== 0) {
      throw new SetupError(`npm run build exited ${build.status}`, 'Fix the build, or set up whatever is already built with --no-build.')
    }
    ok(`built with node ${buildNode.version} (${buildNode.path})`)
  }

  // ── 3. install the plugin ─────────────────────────────────────────────────
  step('install the plugin into the vault')
  let installed
  try {
    installed = await installToVault({ vault, id: PLUGIN_ID })
  } catch (err) {
    if (err instanceof InstallError) throw new SetupError(err.message, err.hint)
    throw err
  }
  ok(`${installed.manifest.name} ${installed.manifest.version} → ${installed.dest}`)
  info(installed.copied.map((c) => `${c.file} ${c.bytes.toLocaleString()}B`).join('  '))

  // ── 4. daemon state ───────────────────────────────────────────────────────
  const stateDir = process.env.MODKIT_STATE_DIR ?? join(REPO, '.state', 'modkit')
  // `resolvedHost` (above) changes what MODKIT_HOST this mint sees: `state.host`/`state.baseUrl`
  // below must already reflect it, or the sidecar and the daemon this run starts would disagree
  // about where "here" is.
  step('daemon state: token + Ed25519 keys')
  if (resolvedHost !== null) info(`--host/--tailnet: binding to ${resolvedHost}`)
  if (has('rotate')) {
    const moved = rotateSecrets(stateDir)
    warn(moved.length > 0 ? `--rotate: moved aside ${moved.join(', ')} (every installed patch now pins a key that is gone)` : '--rotate: nothing to rotate; minting fresh')
  }
  const daemonNode = resolveNode()
  const state = ensureDaemonState({
    nodePath: daemonNode.path,
    env: { MODKIT_STATE_DIR: stateDir, ...(resolvedHost !== null ? { MODKIT_HOST: resolvedHost } : {}) },
  })
  ok(
    `${state.tokenCreated ? 'minted' : 'reused'} token ${redact(state.token)}; ` +
      `root key ${state.rootPubkey.slice(0, 16)}…; subkey ${state.kid} until ${state.certNotAfter}`,
  )
  info(`state at ${state.stateDir}, node ${daemonNode.version} (${daemonNode.path})`)

  // ── 5. the sidecar ────────────────────────────────────────────────────────
  step(`hand the plugin the daemon's credentials → ${SIDECAR_NAME}`)
  const localUrl = state.baseUrl
  const explicitUrl = chooseExplicitBaseUrl({ baseUrlFlag: val('base-url'), resolvedHost, stateBaseUrl: state.baseUrl })
  const file = sidecarPath(vault)
  const pluginDir = dirname(file)
  const existing = readJsonMaybe(file)
  const identity = {
    token: state.token,
    publicKeyHex: state.rootPubkey,
    baseUrl: explicitUrl ?? localUrl,
    version: state.version,
  }

  let result
  let writer
  if (existsSync(join(DAEMON_DIST, 'sidecar.js'))) {
    result = writeSidecarViaDaemon({
      nodePath: daemonNode.path,
      pluginDir,
      identity: { token: identity.token, publicKeyHex: identity.publicKeyHex, baseUrl: identity.baseUrl },
      overwriteBaseUrl: explicitUrl !== undefined,
      env: { MODKIT_STATE_DIR: stateDir },
    })
    writer = 'writeSidecar() — packages/modkit-daemon/src/sidecar.ts'
  } else {
    result = writeSidecarFallback({ file, identity, existing })
    writer = 'scripts/setup.mjs — sidecar.ts is not built, so the contract was written directly'
  }

  // Whoever wrote it, the bytes on disk are what the plugin will read — so check those.
  const onDisk = readJsonMaybe(file)
  const problems = checkSidecar(onDisk, identity)
  if (problems.length > 0) throw new SetupError(`the credentials on disk do not match the contract: ${problems.join('; ')}`)
  const mode = sidecarMode(file)
  if (mode !== 0o600) throw new SetupError(`${file} is mode ${mode?.toString(8) ?? '?'}, not 600 — a credential must not be group- or world-readable`)

  ok(`${file} (0600) — baseUrl ${result.baseUrl}, pins ${identity.publicKeyHex.slice(0, 16)}…`)
  info(`written by ${writer}`)
  for (const change of result.changes ?? []) info(change)
  if ((result.changes ?? []).length === 0) info('nothing changed but the timestamp — this vault was already set up against this daemon')
  if (result.baseUrl !== localUrl) {
    warn(`the plugin will talk to ${result.baseUrl}, not this box's daemon (${localUrl}).`)
    warn(`Pass --base-url ${localUrl} to point it back here.`)
  }
  if (resolvedHost !== null) {
    // NOT "the token travels via vault sync" — it was, in an earlier draft of this message, and
    // that is false for a vault set up the way DESIGN.md §2 measured this one: Obsidian's own
    // `.obsidian/` sync is off by default (`syncInternalFiles`/`usePluginSync` both `false`), so
    // NOTHING in the plugin folder reaches the phone on its own, credential included. The sidecar's
    // own `_note` (above, on disk) says the same thing from the other direction.
    info(`a phone (or any device syncing this vault) will reach the daemon at ${result.baseUrl}`)
    info(`the plugin itself only reaches the phone once this vault's sync turns on syncInternalFiles`)
    warn(`even then, exclude ${SIDECAR_NAME} via syncInternalFilesIgnorePatterns — it is a live credential — and paste its token once into modkit's settings on the phone instead`)
  }

  // ── 6. start the daemon ───────────────────────────────────────────────────
  //
  // In the LOGIN SESSION by default, not under launchd. Measured 2026-08-31: a launchd-started
  // process cannot authenticate the `claude` CLI on this box — every generation dies in ~70ms with
  // "Failed to authenticate: OAuth session expired and could not be refreshed", while the same
  // binary and argv succeed from a shell with the same uid, HOME and a valid credentials file.
  // Reproduced with a bare `launchctl submit` probe running nothing but `claude -p`, so it is not
  // modkit's doing, and `LimitLoadToSessionType Aqua` does not fix it. See launchagent.mjs.
  //
  // It is also the honest lifetime: this daemon serves Obsidian, which only runs in a GUI session.
  // `--agent` keeps the launchd path for anyone whose model auth does not depend on the session
  // (an API key in the environment, say).
  if (has('no-agent')) {
    step('daemon: not started (--no-agent)')
  } else if (!has('agent')) {
    step('start the daemon in this login session')
    const holders = whoHasPort(state.port).filter((h) => h.pid !== process.pid)
    const mine = sessionStatus(stateDir)
    const foreign = holders.filter((h) => h.pid !== mine.pid)
    if (foreign.length > 0 && !mine.running) {
      warn(`port ${state.port} is already held by ${foreign.map((h) => `${h.command}(${h.pid})`).join(', ')}.`)
      warn('Stop it first, or this start will fail on EADDRINUSE.')
    }
    if (agentStatus().loaded) {
      uninstallAgent({ log: (m) => info(m.trim()) })
      info(`removed the ${LABEL} LaunchAgent — it cannot authenticate the model (see launchagent.mjs)`)
    }
    const started = await startInSession({ nodePath: daemonNode.path, stateDir, host: state.host, port: state.port, log: (m) => info(m) })
    // A spawned pid is not a running daemon. Ask the pidfile probe, not the spawn call.
    const live = await confirmDaemonUp({
      status: () => sessionStatus(stateDir),
      portHolders: (p) => whoHasPort(p),
      port: state.port,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    if (!live.running) {
      throw new SetupError(
        `the daemon was spawned as pid ${started.pid} but is not running (${live.reason}).`,
        daemonLogFailure(readTextMaybe(started.logs.out)) ?? `Its log is at ${started.logs.out}.`,
      )
    }
    ok(`daemon running as pid ${live.pid} (logs ${started.logs.out})`)
    info('It lives as long as this login session. Re-run `npm run setup` after a reboot.')
  } else {
    step(`LaunchAgent ${LABEL} (--agent)`)
    warn('launchd cannot authenticate the `claude` CLI on this box — generation will fail unless the')
    warn('daemon has model credentials that do not depend on the login session. Measured 2026-08-31.')
    stopSession(stateDir)
    const holders = whoHasPort(state.port).filter((h) => h.pid !== process.pid)
    const before = agentStatus()
    if (holders.length > 0 && !before.loaded) {
      warn(`port ${state.port} is already held by ${holders.map((h) => `${h.command}(${h.pid})`).join(', ')} — probably an \`npm run daemon\` in a terminal.`)
      warn('The agent will crash-loop on EADDRINUSE until that process stops.')
    }
    const agent = installAgent({ nodePath: daemonNode.path, stateDir, host: state.host, port: state.port, log: (m) => info(m.trim()) })
    ok(`${agent.plistPath} → ${agent.nodePath} ${join('packages', 'modkit-daemon', 'dist', 'index.js')}`)
    info(`PATH=${agent.env.PATH}`)
    info(agent.claudeBin ? `claude CLI at ${agent.claudeBin}` : 'claude CLI NOT FOUND — generation will fail until it is on PATH')
    info(`logs ${agent.logs.out}`)
    // launchd reports `state = xpcproxy` for the moment between fork and exec, so a status read
    // taken immediately says almost nothing. Give it a beat to settle into running (or to reveal a
    // non-zero last exit code, which is the interesting failure).
    let after = agentStatus()
    for (let i = 0; i < 15 && after.state !== 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 200))
      after = agentStatus()
    }
    if (!after.loaded) throw new SetupError(`launchd did not load ${LABEL}`, `Check: launchctl print gui/$(id -u)/${LABEL}`)
    ok(`loaded (state=${after.state ?? '?'}, pid ${after.pid ?? '—'}, runs ${after.runs ?? '?'}${after.lastExitCode ? `, last exit ${after.lastExitCode}` : ''})`)
    if (after.state !== 'running') {
      warn(`launchd has it ${after.state ?? 'in an unknown state'} rather than running — if step 7 fails, read ${logPaths(stateDir).err}`)
    }
  }

  // ── 7. prove it ───────────────────────────────────────────────────────────
  //
  // What may FAIL this run is only what this run is responsible for: the files it wrote and the
  // daemon it started. A sidecar deliberately pointed at another box is the one case where the
  // origin the plugin will call is not something this box can speak for — it may be a tailnet host
  // with no route from here, which is a correct configuration, not a broken one. Exiting non-zero on
  // it would be wrong twice over: the credential and the LaunchAgent are already on disk by this
  // point, so `setup` would be reporting total failure over a completed job, and the obvious way to
  // silence the red text is `--base-url`, which is exactly the stomp the precedence rule exists to
  // prevent. So the remote origin is *probed and reported*, never raised.
  step('prove it works by using it')
  const isRemote = result.baseUrl !== localUrl
  const localListening = whoHasPort(Number(new URL(localUrl).port || 80))
  let proven = true
  const notProven = []
  const unproven = (line) => {
    proven = false
    notProven.push(line)
  }

  if (isRemote) {
    // (a) the daemon this run started — ours, so a failure here is a real failure.
    if (!has('no-agent')) {
      try {
        const local = await proveEndToEnd({ baseUrl: localUrl, sidecar: onDisk, expectPubkey: identity.publicKeyHex })
        ok(
          `the daemon this run started is healthy at ${localUrl} — v${local.health.version}, ` +
            `${local.mods} patch(es), auth ${local.authIsOn ? 'on' : 'OFF'}`,
        )
      } catch (err) {
        unproven(`the local daemon did not come up: ${err.message}`)
        warn(`the local daemon did not come up: ${err.message}`)
      }
    }

    // (b) the origin the plugin will actually call — advisory.
    const remote = await probeHealth(result.baseUrl)
    if (!remote.ok) {
      unproven(`${result.baseUrl} did not answer from this box (${remote.error})`)
      warn(`${result.baseUrl} — the origin the plugin will call — did not answer from here (${remote.error}).`)
      warn('That can be perfectly correct: a tailnet daemon need not be reachable from this box.')
      warn('The credentials themselves are written, 0600 and complete.')
    } else if (remote.pubkey !== identity.publicKeyHex) {
      // Reachable and signing with a different root key. The plugin would reject every patch it signs.
      unproven(`${result.baseUrl} signs with ${String(remote.pubkey).slice(0, 16)}…, but this vault pins ${identity.publicKeyHex.slice(0, 16)}…`)
      warn(`${result.baseUrl} answers, but signs with ${String(remote.pubkey).slice(0, 16)}… while this vault now pins ${identity.publicKeyHex.slice(0, 16)}….`)
      warn('The plugin would refuse every patch that daemon signs. Run `npm run setup` ON THAT BOX,')
      warn(`or pass --base-url ${localUrl} to point this vault at the daemon here.`)
    } else {
      ok(`${result.baseUrl} answers and serves the pinned key (${identity.publicKeyHex.slice(0, 16)}…)`)
    }
  } else if (has('no-agent') && localListening.length === 0) {
    unproven('--no-agent was passed and nothing is listening')
    warn('nothing is listening and --no-agent was passed, so the credentials are written but NOT PROVEN.')
    warn(`Start the daemon (npm run daemon) and re-run: npm run setup:status`)
  } else {
    const proof = await proveEndToEnd({ baseUrl: result.baseUrl, sidecar: onDisk, expectPubkey: identity.publicKeyHex })
    ok(`GET /v1/health → daemon v${proof.health.version}, model ${proof.health.model}, uptime ${Math.round(proof.health.uptimeMs / 1000)}s`)
    ok(`the pubkey it serves equals the pinnedPublicKey just written (${proof.health.pubkey.slice(0, 16)}…)`)
    ok(`GET /v1/jobs with the token just written → 200, ${proof.jobs} job(s) in the daemon's history`)
    ok(proof.authIsOn ? 'the same call without the token → 401, so auth is on' : 'NOTE: an unauthenticated /v1/jobs was not refused')
  }

  // ── 8. what is left for the human ─────────────────────────────────────────
  console.log('')
  console.log('  ────────────────────────────────────────────────────────────────')
  if (installed.enabled) {
    console.log('  modkit is already switched on in this vault.')
    console.log('  To load THIS build: Obsidian → Settings → Community plugins → toggle')
    console.log('  modkit off and on again.')
  } else {
    console.log('  One thing left, and it is Obsidian\'s click rather than ours:')
    console.log('')
    console.log('    Obsidian → Settings → Community plugins → turn on "modkit"')
    console.log('')
    console.log('  (If Obsidian is already open, the refresh button next to "Installed')
    console.log('   plugins" makes it notice the new folder.)')
  }
  console.log('')
  console.log('  There is no token to copy. It is already in')
  console.log(`    ${file}`)
  console.log('  and the plugin reads it from there. Nothing to paste, nothing to pin.')
  console.log('')
  console.log('  Then: ⌘P → "modkit: Mod this…", click what you want changed, and say')
  console.log('  what should happen in one sentence.')
  if (!proven) {
    console.log('')
    console.log('  The credentials are written and correct. What could NOT be checked from here:')
    for (const why of notProven) console.log(`      • ${why}`)
    console.log('')
    console.log('    Check again any time, changing nothing:  npm run setup:status')
  }
  console.log('  ────────────────────────────────────────────────────────────────')
  console.log('')
}

// Guarded so `scripts/setup.test.mjs` can `import` the pure helpers above (resolveHostFlag,
// chooseExplicitBaseUrl, resolveTailnetIp) without every import running the entire live setup —
// the acceptance bar for this flag is "verified by unit-testing the derivation", never a real run.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    await main()
  } catch (err) {
    console.error('')
    if (err instanceof SetupError) {
      console.error(`✗ step ${stepNo} failed: ${err.message}`)
      if (err.hint) console.error(`  ${err.hint}`)
    } else {
      console.error(`✗ step ${stepNo} failed: ${err?.message ?? err}`)
      if (err?.stack) console.error(String(err.stack).split('\n').slice(1, 4).join('\n'))
    }
    console.error('')
    console.error(`  To see the whole picture:  npm run setup:status`)
    console.error('')
    process.exit(1)
  }
}
