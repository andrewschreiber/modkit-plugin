/**
 * Where the daemon keeps everything that must survive a restart, and the configuration that
 * decides how it behaves.
 *
 * `.state/` mirrors brain's convention: it is per-**box** state, gitignored, `0700`, and it holds
 * exactly two kinds of thing — secrets that must never leave this machine, and a record of work
 * done. Nothing in here is a source of truth the vault depends on: the vault's copy of a mod is
 * authoritative, and everything below is an archive the daemon keeps so it can explain itself.
 *
 * Layout:
 *
 *     .state/modkit/
 *       daemon.token                 0600  bearer token, one line, minted on first run
 *       secrets/root.key             0600  PKCS8 PEM — long-lived, signs delegation certs only
 *       secrets/sign.key             0600  PKCS8 PEM — short-lived subkey, signs artifacts only
 *       secrets/cert.json            0600  the current SignedCert
 *       jobs/<jobId>.json            0600  Job, written atomically on every status change
 *       mods/<modId>/request.json    0600  audit copy of the request that produced this generation
 *       mods/<modId>/artifact.json   0600  the SignedArtifact as shipped
 *       mods/<modId>/payload.json    0600  the decoded ArtifactPayload, for reading by eye
 *       mods/<modId>/main.js         0600  archive copy; the vault's copy is the real one
 *       mods/<modId>/manifest.json   0600  archive copy
 *       registry/                    0700  community-registry cache (owned by the source module)
 *       logs/modkit.log              0600  rotated by log.ts
 *       tokens.jsonl                 0600  one line per model call — the spend ledger
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isModelBackend, type ModelBackend } from '@modkit/types';

import { isLogLevel, type LogLevel } from './log.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Paths
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every path the daemon writes, resolved once at startup so nothing composes a path ad hoc. */
export interface StateLayout {
  root: string;
  secretsDir: string;
  jobsDir: string;
  modsDir: string;
  logsDir: string;
  registryDir: string;
  tokenFile: string;
  rootKeyFile: string;
  signKeyFile: string;
  certFile: string;
  logFile: string;
  tokensLedger: string;
}

/**
 * Walk up from this module looking for the workspace root — the directory whose `package.json`
 * is named `modkit`. Anchoring on the module rather than on `process.cwd()` is what makes
 * `node packages/modkit-daemon/dist/index.js` behave identically from any directory, which
 * matters because launchd starts a process in `/`.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 12; hops += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === 'modkit') {
          return dir;
        }
      } catch {
        /* an unreadable package.json is not the one we are looking for */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function stateLayout(root: string): StateLayout {
  return {
    root,
    secretsDir: join(root, 'secrets'),
    jobsDir: join(root, 'jobs'),
    modsDir: join(root, 'mods'),
    logsDir: join(root, 'logs'),
    registryDir: join(root, 'registry'),
    tokenFile: join(root, 'daemon.token'),
    rootKeyFile: join(root, 'secrets', 'root.key'),
    signKeyFile: join(root, 'secrets', 'sign.key'),
    certFile: join(root, 'secrets', 'cert.json'),
    logFile: join(root, 'logs', 'modkit.log'),
    tokensLedger: join(root, 'tokens.jsonl'),
  };
}

/**
 * Create the whole tree with restrictive permissions, and **re-assert the modes every start**.
 * `mkdirSync`'s `mode` only applies on creation, so a directory made `0755` by an earlier build
 * (or by a different umask) stays world-readable forever unless something like this runs.
 */
export function ensureState(root: string): StateLayout {
  const layout = stateLayout(root);
  // The parent `.state/` is ours too — it is created by whichever tool gets there first.
  ensureDir(dirname(root));
  for (const dir of [
    layout.root,
    layout.secretsDir,
    layout.jobsDir,
    layout.modsDir,
    layout.logsDir,
    layout.registryDir,
  ]) {
    ensureDir(dir);
  }
  return layout;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a directory we do not own (an unusual `.state` mount) is not worth failing startup over */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Atomic, private file IO
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Write-then-rename, with an fsync in between.
 *
 * The temp name carries the pid because several daemon processes can briefly overlap during a
 * restart, and two writers sharing one `.part` path produce a torn file that reads as valid JSON
 * often enough to be dangerous.
 */
export function writeAtomicSync(file: string, data: string | Buffer, mode = 0o600): void {
  ensureDir(dirname(file));
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const tmp = `${file}.${process.pid}.part`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, mode);
  } catch {
    /* the rename already landed; a failed chmod is reported by the caller's own audit, not here */
  }
}

export function writeJsonSync(file: string, value: unknown, mode = 0o600): void {
  writeAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** `null` for "not there or not readable as JSON" — the caller decides whether that is an error. */
export function readJsonSync<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    /* nothing here is load-bearing enough to fail a request over */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Jobs on disk
 * ──────────────────────────────────────────────────────────────────────────── */

export function jobFile(layout: StateLayout, jobId: string): string {
  return join(layout.jobsDir, `${safeId(jobId)}.json`);
}

export function listJobFiles(layout: StateLayout): string[] {
  try {
    return readdirSync(layout.jobsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(layout.jobsDir, name));
  } catch {
    return [];
  }
}

/**
 * Ids reach the filesystem, so they get a hard whitelist rather than a blacklist. A job id is
 * ours (a UUID) but a mod id came out of a model, and `../` in a directory name is the difference
 * between an archive and an arbitrary write.
 */
export function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..')) {
    throw new Error(`unsafe id for a filesystem path: ${JSON.stringify(id.slice(0, 64))}`);
  }
  return id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mod archive
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ModArchive {
  modId: string;
  /** The user's sentence, at the time this generation ran — an audit copy, not the regeneration seed. */
  request: unknown;
  artifact: unknown;
  payload: unknown;
  mainJs: string;
  manifest: unknown;
}

export function modDir(layout: StateLayout, modId: string): string {
  return join(layout.modsDir, safeId(modId));
}

export function saveModArchive(layout: StateLayout, archive: ModArchive): void {
  const dir = modDir(layout, archive.modId);
  ensureDir(dir);
  writeJsonSync(join(dir, 'request.json'), archive.request);
  writeJsonSync(join(dir, 'artifact.json'), archive.artifact);
  writeJsonSync(join(dir, 'payload.json'), archive.payload);
  writeAtomicSync(join(dir, 'main.js'), archive.mainJs);
  writeJsonSync(join(dir, 'manifest.json'), archive.manifest);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The model-spend ledger
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One row per `modelUsage` key of one model call.
 *
 * Two rules copied from brain's ledger, both learned the hard way: read `modelUsage`, never the
 * top-level `usage` (they disagree, and only `modelUsage` reconciles to `total_cost_usd`); and
 * **the recorder must never throw**, because a ledger that can break the thing it measures is
 * worse than no ledger.
 */
export interface TokenLedgerRow {
  ts: string;
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  jobId?: string;
  sessionId?: string;
  uuid?: string;
}

export function appendTokenUsage(layout: StateLayout, row: TokenLedgerRow): void {
  try {
    appendFileSync(layout.tokensLedger, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    /* measuring never breaks the measured */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Which CLI `model.ts#runModel` shells out to. `claude` is the original, measured transport
 * (`claude.ts`); `codex` is `codex exec` (`codex.ts`), added for L8. Kept as a plain string union
 * rather than an enum so `resolveConfig()` can validate it the same way it validates `LogLevel`.
 */
export type Backend = ModelBackend;

export function isBackend(value: string): value is Backend {
  return isModelBackend(value);
}

/**
 * Why a `codex` backend is refused without the acknowledgment, in one place.
 *
 * It is shared because the refusal now happens twice: at boot (`MODKIT_BACKEND=codex`) and at
 * request time (a plugin asking for codex through {@link ModelOverride}). Two hand-written copies
 * of a security rationale drift, and the one that drifts is always the one nobody reads.
 */
export const CODEX_SANDBOX_REFUSAL =
  "codex exec's shell tool has machine-wide filesystem READ access under every sandbox flag " +
  'codex-cli 0.152.0 offers (measured: --sandbox read-only blocks writes only; no flag disables ' +
  'the shell tool). A prompt injection in generated or target plugin source can read arbitrary ' +
  'files and return them as the generation\'s output. Set MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1 on ' +
  'the daemon once you accept that risk.';

export interface DaemonConfig {
  host: string;
  port: number;
  /** Absolute path of `.state/modkit`. */
  stateDir: string;
  /** How many generations may run at once. Each shells out to a model, so this is 1 or 2. */
  concurrency: number;
  /** Which model transport `runModel` dispatches to. From `MODKIT_BACKEND`, default `claude`. */
  backend: Backend;
  /**
   * The model the generator is configured to use. Reported on `/v1/health`.
   *
   * Backend-aware default (see {@link resolveConfig}): `'sonnet'` for `claude`, and `''` for
   * `codex` — both `runClaude` and `runCodex` already treat a falsy `model` as "omit `--model`",
   * so an empty string here means "let the CLI pick," not "pick nothing." Guessing a codex
   * default model name would be inventing a fact `codex exec --help` does not state.
   */
  model: string;
  /**
   * Whether the operator accepted codex's sandbox caveat (`MODKIT_CODEX_ACKNOWLEDGE_SANDBOX`).
   *
   * Resolved at boot **regardless of which backend is active**, because it is now also the answer
   * to a different question: may a *client* ask for codex on a daemon that booted on claude? It is
   * reported on `/v1/health` as `codexAvailable` so a backend picker can be honest about it.
   */
  codexAcknowledged: boolean;
  /** How many terminal jobs to keep. Older ones are evicted, file and all. */
  jobRetention: number;
  maxBodyBytes: number;
  /** How long a signed artifact stays installable. Short, so a stale reply cannot be replayed. */
  artifactTtlMs: number;
  /** Lifetime of a signing-subkey delegation certificate. */
  certTtlMs: number;
  /** Mint a fresh subkey when the current cert is within this of expiring. */
  certRenewBeforeMs: number;
  logLevel: LogLevel;
  version: string;
}

/** `resolveConfig`'s own defaults, spelled as an origin. See {@link DEFAULT_BASE_URL}'s use in `sidecar.ts`. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8501;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** `'1'`/`'true'`/`'yes'` (case-insensitive) count as an explicit opt-in; anything else, including unset, does not. */
function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The daemon's own version, read from its package.json — never a constant that drifts from it. */
export function daemonVersion(): string {
  const pkg = readJsonSync<{ version?: unknown }>(fileURLToPath(new URL('../package.json', import.meta.url)));
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
}

/**
 * Wildcard binds are refused outright.
 *
 * The daemon holds a signing key and executes a model that writes code into a vault; the one
 * thing it must never do is become reachable by accident. Binding a *named* address is still
 * allowed (a tailnet IP is a legitimate choice), but `0.0.0.0` is never a deliberate one — it is
 * what a config gets when nobody decided.
 */
const WILDCARD_HOSTS = new Set(['', '*', '0.0.0.0', '::', '[::]', '::0', 'any']);

/**
 * Every daemon setting, as a config-file key mapped to the environment variable it stands for.
 *
 * This table IS the documentation — `AGENTS.md` is generated against it and `--print-config` walks
 * it — so a setting that is not here is a setting nobody can discover. Adding one here is what
 * makes it configurable from a file; the reader below needs no change.
 */
export const CONFIG_KEYS: Readonly<Record<string, string>> = Object.freeze({
  host: 'MODKIT_HOST',
  port: 'MODKIT_PORT',
  stateDir: 'MODKIT_STATE_DIR',
  concurrency: 'MODKIT_CONCURRENCY',
  backend: 'MODKIT_BACKEND',
  model: 'MODKIT_MODEL',
  codexAcknowledgeSandbox: 'MODKIT_CODEX_ACKNOWLEDGE_SANDBOX',
  claudeBin: 'MODKIT_CLAUDE_BIN',
  codexBin: 'MODKIT_CODEX_BIN',
  jobRetention: 'MODKIT_JOB_RETENTION',
  maxBodyBytes: 'MODKIT_MAX_BODY_BYTES',
  artifactTtlHours: 'MODKIT_ARTIFACT_TTL_HOURS',
  certTtlDays: 'MODKIT_CERT_TTL_DAYS',
  certRenewBeforeDays: 'MODKIT_CERT_RENEW_BEFORE_DAYS',
  logLevel: 'MODKIT_LOG_LEVEL',
});

/** Where the config file lives: `$MODKIT_CONFIG`, else `modkit.config.json` at the repo root. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env['MODKIT_CONFIG'] ? resolve(env['MODKIT_CONFIG']) : join(findRepoRoot(), 'modkit.config.json');
}

/**
 * Read the config file and layer it *underneath* the environment.
 *
 * The whole design is this one sentence: the file is turned into the same `MODKIT_*` strings the
 * environment would have supplied, and the real environment is spread over the top. That means
 *
 *   - every existing `env['MODKIT_…']` read below works unchanged, so there is exactly one parser
 *     and one place where a value is validated — a second parser for files is how the two forms
 *     drift into disagreeing about what `port: "8501"` means;
 *   - **an explicit environment variable always wins**, so nothing about an existing setup changes
 *     when a config file appears next to it; and
 *   - a setting added to {@link CONFIG_KEYS} is file-configurable with no further code.
 *
 * A malformed file throws rather than being skipped. A config file that is silently ignored is a
 * setting silently ignored, which is the failure this codebase keeps naming as the worst one.
 */
export function withConfigFile(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = configFilePath(env);
  if (!existsSync(file)) return env;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }

  const fromFile: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('//') || key === '$schema') continue; // JSON has no comments; these are ours.
    const name = CONFIG_KEYS[key] ?? (key.startsWith('MODKIT_') ? key : undefined);
    if (!name) {
      throw new Error(
        `${file}: unknown setting ${JSON.stringify(key)}. Known settings: ${Object.keys(CONFIG_KEYS).sort().join(', ')}`,
      );
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean') fromFile[name] = value ? '1' : '0';
    else if (typeof value === 'number' || typeof value === 'string') fromFile[name] = String(value);
    else throw new Error(`${file}: ${JSON.stringify(key)} must be a string, number or boolean`);
  }

  // Environment last: an explicit env var beats the file, always.
  return { ...fromFile, ...env };
}

export function resolveConfig(rawEnv: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const env = withConfigFile(rawEnv);
  const host = (env['MODKIT_HOST'] ?? DEFAULT_HOST).trim();
  if (WILDCARD_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `MODKIT_HOST=${JSON.stringify(host)} is a wildcard bind. Name an address explicitly ` +
        '(127.0.0.1 for local use, or this box\'s tailnet IP).',
    );
  }

  const stateDir = env['MODKIT_STATE_DIR']
    ? resolve(env['MODKIT_STATE_DIR'])
    : join(findRepoRoot(), '.state', 'modkit');

  const rawLevel = (env['MODKIT_LOG_LEVEL'] ?? 'info').toLowerCase();
  if (!isLogLevel(rawLevel)) {
    throw new Error(`MODKIT_LOG_LEVEL must be debug|info|warn|error, got ${JSON.stringify(rawLevel)}`);
  }

  const rawBackend = (env['MODKIT_BACKEND'] ?? 'claude').toLowerCase();
  if (!isBackend(rawBackend)) {
    throw new Error(`MODKIT_BACKEND must be claude|codex, got ${JSON.stringify(rawBackend)}`);
  }
  // codex.ts's own header documents the measurement: under every sandbox flag codex-cli 0.152.0
  // exposes, its shell tool can still read any file this process can read (`--sandbox read-only`
  // blocks writes, not reads), and there is no flag on this version that removes the shell tool
  // itself. The generation prompt carries untrusted third-party plugin source, so a prompt
  // injection there can turn into an arbitrary file read whose contents come back as the
  // generation's `source` — which the pipeline then signs and offers to install. That is a real,
  // qualitatively different risk from the `claude` backend (`--tools ''`, no shell access at all),
  // so switching to it must be a deliberate act, not a one-word env var flip nobody reads twice.
  const codexAcknowledged = isTruthyFlag(env['MODKIT_CODEX_ACKNOWLEDGE_SANDBOX']);
  if (rawBackend === 'codex' && !codexAcknowledged) {
    throw new Error(`MODKIT_BACKEND=codex requires MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1. ${CODEX_SANDBOX_REFUSAL}`);
  }

  return {
    host,
    port: intFromEnv(env, 'MODKIT_PORT', DEFAULT_PORT, 1, 65_535),
    stateDir,
    concurrency: intFromEnv(env, 'MODKIT_CONCURRENCY', 1, 1, 8),
    backend: rawBackend,
    model: env['MODKIT_MODEL'] ?? (rawBackend === 'codex' ? '' : 'sonnet'),
    codexAcknowledged,
    jobRetention: intFromEnv(env, 'MODKIT_JOB_RETENTION', 200, 1, 10_000),
    // The evidence blob (a DOM outline) is the only thing here that can get large.
    maxBodyBytes: intFromEnv(env, 'MODKIT_MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    artifactTtlMs: intFromEnv(env, 'MODKIT_ARTIFACT_TTL_HOURS', 72, 1, 24 * 365) * HOUR,
    certTtlMs: intFromEnv(env, 'MODKIT_CERT_TTL_DAYS', 30, 1, 3650) * DAY,
    certRenewBeforeMs: intFromEnv(env, 'MODKIT_CERT_RENEW_BEFORE_DAYS', 7, 0, 3650) * DAY,
    logLevel: rawLevel,
    version: daemonVersion(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Identity — the three facts a client needs to talk to this daemon
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Everything a client needs to talk to this daemon, and nothing else.
 *
 * This exists so `sidecar.ts` never has to know that the token is one trimmed line in
 * `daemon.token` or that the origin is `host` and `port` glued together. Those are this module's
 * facts; a second reader of them is a second thing to keep in step with the layout above, and the
 * one that drifts is always the copy.
 */
export interface DaemonIdentity {
  /** The bearer token every route except `/v1/health` requires. */
  token: string;
  /** The **root** Ed25519 public key the plugin pins. 64 lowercase hex. */
  publicKeyHex: string;
  /** The origin a client should call, no trailing slash. */
  baseUrl: string;
}

/** What {@link daemonIdentity} needs. `keyring` is structural so this module does not import `sign.ts` — which imports *this* one. */
export interface DaemonIdentitySource {
  layout: StateLayout;
  config: Pick<DaemonConfig, 'host' | 'port'>;
  keyring: { rootPubkeyHex: string };
}

const ROOT_PUBKEY_HEX = /^[0-9a-f]{64}$/;

/**
 * `http://host:port`, with an IPv6 literal bracketed.
 *
 * Unbracketed, `http://::1:8501` parses as a host of `::1:8501` with no port — a URL that is
 * accepted by `new URL()` and connects to nothing, which is the worst way for this to be wrong.
 */
export function daemonBaseUrl(config: Pick<DaemonConfig, 'host' | 'port'>): string {
  const host = config.host.trim();
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${config.port}`;
}

/**
 * The minted bearer token, or `null` when the daemon has never run here.
 *
 * Read-only on purpose: minting belongs to `auth.ts`'s {@link loadOrCreateToken}, and a second
 * function that could mint one would let `setup` hand out a token no daemon is serving.
 */
export function readDaemonToken(layout: StateLayout): string | null {
  try {
    const token = readFileSync(layout.tokenFile, 'utf8').trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * Compose the identity, refusing rather than returning something half-true.
 *
 * Both failures are states a caller must not paper over: no token means no daemon has ever run
 * with this state directory, and a malformed root key means whatever gets pinned will fail every
 * signature check later, at install time, which is the worst moment to discover it.
 */
export function daemonIdentity(source: DaemonIdentitySource): DaemonIdentity {
  const token = readDaemonToken(source.layout);
  if (token === null) {
    throw new Error(
      `no daemon token at ${source.layout.tokenFile} — start the daemon once so it mints one, then run setup`,
    );
  }
  const publicKeyHex = source.keyring.rootPubkeyHex.trim().toLowerCase();
  if (!ROOT_PUBKEY_HEX.test(publicKeyHex)) {
    throw new Error(
      `the keyring's root public key is not 64 hex characters: ${JSON.stringify(source.keyring.rootPubkeyHex.slice(0, 80))}`,
    );
  }
  return { token, publicKeyHex, baseUrl: daemonBaseUrl(source.config) };
}
