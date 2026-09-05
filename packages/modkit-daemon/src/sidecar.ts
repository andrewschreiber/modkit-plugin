/**
 * The sidecar: hand the plugin the daemon's credentials over the filesystem instead of over a human.
 *
 * The daemon mints a bearer token and an Ed25519 keypair; the plugin needs the token and the public
 * key. Until now the transport between them was a person — copy the token out of a terminal banner,
 * paste it into a settings field, then paste the key too. That ceremony is right for the **tailnet**
 * case (daemon on one box, plugin on a phone, a real network hop) and is pure ritual for the
 * **desktop** case, where both halves run as the same uid on the same filesystem and the daemon can
 * simply write the file the plugin already reads.
 *
 * Dropping the paste costs no security. Every artifact is still signed and still verified against
 * the pinned key; the key just arrives over a same-uid channel rather than a clipboard. Anything
 * able to write this file can already write `main.js` into the vault directly, which is strictly
 * more power than handing modkit a token.
 *
 * ## The contract
 *
 * `<vault>/.obsidian/plugins/modkit/daemon-token.json`, mode `0600`:
 *
 * ```json
 * {
 *   "_note": "…what this is, that it is live, and the LiveSync ignore pattern…",
 *   "version": 1,
 *   "baseUrl": "http://127.0.0.1:8501",
 *   "token": "mk_…",
 *   "pinnedPublicKey": "<64 hex>",
 *   "pairedAt": "<ISO8601>",
 *   "pairedBy": "modkit setup <version> on <hostname>"
 * }
 * ```
 *
 * `pairedAt`/`pairedBy` are the on-disk key names and stay as they are: an installed vault already
 * has files carrying them, the plugin reads them by those names, and a stored field is a system
 * identifier rather than something a person reads.
 *
 * **`token` and `pinnedPublicKey` are authoritative** — this file is the record of a completed
 * setup, and re-running setup overwrites both. **`baseUrl` is a seed**: a user who deliberately
 * pointed the plugin at a remote daemon must not have it silently repointed at loopback by a later
 * `setup` run on the desktop box, so an existing non-default `baseUrl` is preserved unless the
 * caller passes {@link SidecarOptions.overwriteBaseUrl}. The plugin enforces the same rule from its
 * side (`plugin/src/settings/settings.ts`, `applyPairing`).
 *
 * ## Three rules that are not style
 *
 * - **Verify the mode after writing.** A credential written world-readable is worse than one not
 *   written: the first looks like success. If the file cannot be made `0600` it is removed again.
 * - **Read it back and parse it before reporting success.** This repo has a documented class of
 *   silent write failures (a shell alias that made every `cat >` write zero bytes and return 0), and
 *   the only honest check is reading the bytes back.
 * - **Refuse a directory that is not an installed modkit plugin folder.** One typo in a path must
 *   scatter no credentials.
 */

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_HOST, DEFAULT_PORT, daemonBaseUrl, daemonVersion, type DaemonIdentity } from './state.js';

/** The file the plugin already reads. Same constant as `TOKEN_FILE_NAME` on the plugin side. */
export const SIDECAR_FILE_NAME = 'daemon-token.json';

/** Bumped only when a field changes meaning. The plugin refuses a version it does not know. */
export const SIDECAR_VERSION = 1;

/** The origin `resolveConfig` produces with no environment set — i.e. "the user chose nothing". */
export const DEFAULT_BASE_URL = daemonBaseUrl({ host: DEFAULT_HOST, port: DEFAULT_PORT });

/**
 * JSON has no comments, so the explanation gets a key.
 *
 * It names the LiveSync setting deliberately: this is the file someone would otherwise "tidy up"
 * into `data.json`, which LiveSync's Customization sync replicates to every device.
 */
export const SIDECAR_NOTE =
  "modkit's credentials for this vault: this is a LIVE credential for the modkit daemon on this machine — treat it like a password, do not commit it, and do not copy it to another device. It is kept out of data.json because LiveSync's Customization sync replicates a plugin's data.json everywhere. If you ever turn on LiveSync's hidden-file sync (syncInternalFiles), add this path to syncInternalFilesIgnorePatterns.";

/* ────────────────────────────────────────────────────────────────────────────
 * Refusals
 * ──────────────────────────────────────────────────────────────────────────── */

export type SidecarRefusal =
  /** The path is not a directory, or does not exist. */
  | 'no-plugin-dir'
  /** No `manifest.json` — so this is not an Obsidian plugin folder at all. */
  | 'no-manifest'
  /** A `manifest.json` that is not readable JSON. */
  | 'unreadable-manifest'
  /** A plugin folder, but somebody else's. */
  | 'foreign-plugin'
  /** The file landed but could not be made `0600`; it has been removed again. */
  | 'mode-unsafe'
  /** The file was written and does not read back as what was written. */
  | 'readback-failed';

export class SidecarError extends Error {
  constructor(
    readonly code: SidecarRefusal,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading what is already there
 * ──────────────────────────────────────────────────────────────────────────── */

/** A sidecar as it was found on disk. Every field is optional because a hand-edited file is a fact. */
export interface SidecarRecord {
  version: number | null;
  baseUrl: string | null;
  token: string | null;
  pinnedPublicKey: string | null;
  pairedAt: string | null;
  pairedBy: string | null;
}

export interface SidecarOnDisk {
  path: string;
  /** A file is there, whatever it contains. */
  present: boolean;
  /** It is there and it parsed as a JSON object. */
  readable: boolean;
  record: SidecarRecord | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Where the sidecar lives for a given plugin folder. Exported so `setup` can name the path before writing. */
export function sidecarPath(pluginDir: string): string {
  return join(pluginDir, SIDECAR_FILE_NAME);
}

/**
 * Read the existing sidecar. Never throws: an unreadable file is a state to report, not a crash —
 * and it is one of the two states re-running setup exists to repair.
 */
export function readSidecar(pluginDir: string): SidecarOnDisk {
  const path = sidecarPath(pluginDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, present: false, readable: false, record: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path, present: true, readable: false, record: null };
  }
  if (!isRecord(parsed)) return { path, present: true, readable: false, record: null };
  return {
    path,
    present: true,
    readable: true,
    record: {
      version: typeof parsed['version'] === 'number' ? parsed['version'] : null,
      baseUrl: stringAt(parsed, 'baseUrl'),
      // `daemonToken` is the older key the plugin wrote when a human pasted the token by hand.
      token: stringAt(parsed, 'token') ?? stringAt(parsed, 'daemonToken'),
      pinnedPublicKey: stringAt(parsed, 'pinnedPublicKey'),
      pairedAt: stringAt(parsed, 'pairedAt'),
      pairedBy: stringAt(parsed, 'pairedBy'),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Is this actually modkit's plugin folder?
 * ──────────────────────────────────────────────────────────────────────────── */

/** The modkit install a sidecar would be written into. */
export interface PluginFolder {
  dir: string;
  manifestPath: string;
  pluginVersion: string | null;
}

/**
 * Refuse anything that is not an installed modkit plugin folder.
 *
 * The check is the manifest's **id**, not the directory's name: a folder can be renamed, and the id
 * is what Obsidian and the plugin itself agree on. A path that merely looks plausible — a vault
 * root, a sibling plugin, a typo'd directory — gets a refusal naming what was found instead.
 */
export function assertModkitPluginFolder(pluginDir: string): PluginFolder {
  let stats;
  try {
    stats = statSync(pluginDir);
  } catch {
    throw new SidecarError('no-plugin-dir', `${pluginDir} does not exist`, pluginDir);
  }
  if (!stats.isDirectory()) {
    throw new SidecarError('no-plugin-dir', `${pluginDir} is not a directory`, pluginDir);
  }

  const manifestPath = join(pluginDir, 'manifest.json');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new SidecarError(
      'no-manifest',
      `${pluginDir} has no manifest.json, so it is not an installed Obsidian plugin folder`,
      pluginDir,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SidecarError(
      'unreadable-manifest',
      `${manifestPath} is not readable JSON (${(err as Error).message})`,
      pluginDir,
    );
  }
  if (!isRecord(parsed)) {
    throw new SidecarError('unreadable-manifest', `${manifestPath} is not a JSON object`, pluginDir);
  }

  const id = parsed['id'];
  if (id !== 'modkit') {
    throw new SidecarError(
      'foreign-plugin',
      `${manifestPath} declares id ${JSON.stringify(id)}, not "modkit" — this writes a live credential and will not put one in another plugin's folder`,
      pluginDir,
    );
  }

  return {
    dir: pluginDir,
    manifestPath,
    pluginVersion: typeof parsed['version'] === 'string' ? parsed['version'] : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Writing the sidecar
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SidecarOptions {
  /**
   * Repoint `baseUrl` even when the existing one is non-default. Off by default: the whole reason
   * `baseUrl` is a seed and not authoritative is that a user pointing the plugin at a remote daemon
   * is a deliberate act, and silently undoing it is invisible until generation fails.
   */
  overwriteBaseUrl?: boolean;
  /** Overridden in tests so the result is deterministic. */
  now?: Date;
  /** Defaults to the daemon's own package version. */
  version?: string;
  /** Defaults to `os.hostname()`. */
  host?: string;
}

export interface SidecarResult {
  path: string;
  /** No sidecar existed before this run. */
  created: boolean;
  /** A sidecar existed and could not be parsed; it has been replaced. */
  replacedUnreadable: boolean;
  tokenChanged: boolean;
  publicKeyChanged: boolean;
  /** The `baseUrl` now in the file. */
  baseUrl: string;
  /** True when a deliberate, non-default `baseUrl` was kept instead of the daemon's own. */
  baseUrlPreserved: boolean;
  previousBaseUrl: string | null;
  pairedAt: string;
  pairedBy: string;
  /** The permission bits read back from disk. `0o600` or the call would have thrown. */
  mode: number;
  /**
   * One line per thing that actually changed, for `setup` to print. **Empty means nothing changed
   * but the timestamp** — which is the honest thing to say on a second run.
   */
  changes: string[];
}

/**
 * Write the credentials, then prove it.
 *
 * Order matters and each step is load-bearing:
 * 1. refuse a folder that is not modkit's;
 * 2. read what is there, so `baseUrl` can be preserved and the result can say what changed;
 * 3. write to a temp file **in the same directory** at `0600` and rename — a cross-directory temp
 *    would not be an atomic rename, and a crash mid-write must never leave the plugin reading half
 *    a JSON file;
 * 4. re-assert and then **verify** the mode, removing the file if it cannot be made private;
 * 5. read it back and parse it, and check the credential in it is the one we meant to write.
 */
export function writeSidecar(
  pluginDir: string,
  identity: DaemonIdentity,
  options: SidecarOptions = {},
): SidecarResult {
  const folder = assertModkitPluginFolder(pluginDir);
  const existing = readSidecar(folder.dir);
  const path = existing.path;

  const previousBaseUrl = existing.record?.baseUrl ?? null;
  const keepBaseUrl =
    options.overwriteBaseUrl !== true &&
    previousBaseUrl !== null &&
    previousBaseUrl !== DEFAULT_BASE_URL &&
    previousBaseUrl !== identity.baseUrl;
  const baseUrl = keepBaseUrl && previousBaseUrl !== null ? previousBaseUrl : identity.baseUrl;

  const pairedAt = (options.now ?? new Date()).toISOString();
  const pairedBy = `modkit setup ${options.version ?? daemonVersion()} on ${options.host ?? hostname()}`;

  // Key order is the documented contract's order: the note first, so anyone who opens the file
  // reads the warning before the secret.
  const record = {
    _note: SIDECAR_NOTE,
    version: SIDECAR_VERSION,
    baseUrl,
    token: identity.token,
    pinnedPublicKey: identity.publicKeyHex,
    pairedAt,
    pairedBy,
  };

  writePrivateJsonAtomically(path, record);
  const mode = verifyMode(path);
  verifyReadback(path, identity);

  const tokenChanged = existing.record?.token !== identity.token;
  const publicKeyChanged = existing.record?.pinnedPublicKey !== identity.publicKeyHex;
  const changes: string[] = [];
  if (!existing.present) changes.push(`wrote the daemon's credentials to ${path}`);
  else if (!existing.readable) changes.push(`replaced an unreadable ${SIDECAR_FILE_NAME}`);
  if (existing.present && tokenChanged) changes.push('the bearer token changed');
  if (existing.present && publicKeyChanged) changes.push('the pinned signing key changed');
  if (keepBaseUrl) {
    changes.push(`kept baseUrl ${baseUrl} (this daemon is ${identity.baseUrl}) — pass --base-url to repoint it`);
  } else if (existing.readable && previousBaseUrl !== null && previousBaseUrl !== baseUrl) {
    changes.push(`baseUrl ${previousBaseUrl} → ${baseUrl}`);
  }

  return {
    path,
    created: !existing.present,
    replacedUnreadable: existing.present && !existing.readable,
    tokenChanged,
    publicKeyChanged,
    baseUrl,
    baseUrlPreserved: keepBaseUrl,
    previousBaseUrl,
    pairedAt,
    pairedBy,
    mode,
    changes,
  };
}

/**
 * Temp file in the same directory, fsync, rename, chmod.
 *
 * The pid is in the temp name because two `setup` runs racing on one directory sharing a `.tmp`
 * path produce a torn file that reads as valid JSON often enough to be dangerous — the same reason
 * `state.ts`'s `writeAtomicSync` does it. This does not reuse that helper on purpose: it
 * `chmod 0700`s the containing directory, which is correct for `.state/` and wrong for a folder
 * inside the user's vault.
 */
function writePrivateJsonAtomically(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.part`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename failed; a leftover temp file is the lesser problem and is already 0600 */
    }
    throw err;
  }
  try {
    // `openSync`'s mode is masked by the umask, so the file can land at 0600 & ~umask — which is
    // still 0600 for any sane umask and is not something to assume. Assert it instead.
    chmodSync(path, 0o600);
  } catch {
    /* reported by verifyMode, which is the only place allowed to conclude anything about this */
  }
}

/** The mode actually on disk, or a refusal that removes the file it could not make private. */
function verifyMode(path: string): number {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    try {
      unlinkSync(path);
    } catch {
      /* the throw below is what matters; a file we could not remove is named in it */
    }
    throw new SidecarError(
      'mode-unsafe',
      `${path} landed with mode ${mode.toString(8)}, which is readable by other users — the file has been removed rather than left holding a credential`,
      path,
    );
  }
  return mode;
}

/**
 * Read the bytes back and check the credential in them.
 *
 * Not paranoia — this box has a documented class of writes that report success and land nothing.
 * A write is verified by reading it back, never by the absence of an error.
 */
function verifyReadback(path: string, identity: DaemonIdentity): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SidecarError(
      'readback-failed',
      `${path} was written but does not read back as JSON (${(err as Error).message})`,
      path,
    );
  }
  if (!isRecord(parsed)) {
    throw new SidecarError('readback-failed', `${path} was written but does not read back as an object`, path);
  }
  if (parsed['token'] !== identity.token || parsed['pinnedPublicKey'] !== identity.publicKeyHex) {
    throw new SidecarError(
      'readback-failed',
      `${path} was written but reads back with different credentials — something else is writing this file`,
      path,
    );
  }
  if (parsed['version'] !== SIDECAR_VERSION) {
    throw new SidecarError(
      'readback-failed',
      `${path} reads back with version ${JSON.stringify(parsed['version'])}, expected ${SIDECAR_VERSION}`,
      path,
    );
  }
}
