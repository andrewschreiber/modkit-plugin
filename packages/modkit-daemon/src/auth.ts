/**
 * Bearer-token authentication for every route except `/v1/health`.
 *
 * One shared secret, minted on first run, printed **once**, and never logged again. That is the
 * whole scheme, and it is the right size: the daemon binds a named local address, and the client
 * is a plugin the same person installed. What the token buys is that a *different* process on the
 * same box — a browser page, another plugin, a stray script — cannot ask this daemon to run a
 * model and hand back signed code.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

import type { Logger } from './log.js';
import { writeAtomicSync, type StateLayout } from './state.js';

/**
 * `mk_` + 43 base64url characters (32 bytes of entropy).
 *
 * The prefix is not decoration. It gives the secret a recognisable *shape*, which is what lets
 * `log.ts` redact it exactly rather than guessing — a bare hex blob is indistinguishable from the
 * Ed25519 public key, which we want in the logs.
 */
export function mintToken(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}

export interface DaemonToken {
  token: string;
  file: string;
  /** True when this run minted it — the one moment it is allowed to reach a human's terminal. */
  created: boolean;
}

export function loadOrCreateToken(layout: StateLayout, log: Logger): DaemonToken {
  if (existsSync(layout.tokenFile)) {
    const token = readFileSync(layout.tokenFile, 'utf8').trim();
    if (token.length >= 16) return { token, file: layout.tokenFile, created: false };
    log.warn('daemon token file was empty or too short; minting a new one', { file: layout.tokenFile });
  }
  const token = mintToken();
  writeAtomicSync(layout.tokenFile, `${token}\n`, 0o600);
  return { token, file: layout.tokenFile, created: true };
}

/**
 * Print the token to stdout, once, at mint time.
 *
 * Written directly rather than through the logger for two reasons: the logger redacts it (as it
 * should), and this is a message for a person, not a record for a file.
 */
export function announceToken(token: DaemonToken): void {
  const banner = [
    '',
    '  ┌─ modkit daemon ────────────────────────────────────────────────',
    '  │  A new API token was minted. Paste it into the modkit plugin',
    '  │  settings — it is shown here once and never logged.',
    '  │',
    `  │    ${token.token}`,
    '  │',
    `  │  Stored 0600 at ${token.file}`,
    '  └────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
  try {
    process.stdout.write(`${banner}\n`);
  } catch {
    /* a detached stdout is survivable; the file on disk is the fallback */
  }
}

/**
 * Constant-time string comparison that is constant-time **on a length mismatch too**.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the obvious guard
 * (`if (a.length !== b.length) return false`) both leaks the length and turns a wrong-length
 * token into a different code path. Hashing first gives two fixed 32-byte inputs, so there is one
 * path and one timing profile regardless of what was sent.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** The bearer credential from an `Authorization` header, or `null` when there isn't one. */
export function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export type AuthResult = { ok: true } | { ok: false; detail: string };

/**
 * The `detail` here is for the daemon's own log and for the client's error body. It says which of
 * "no header" / "wrong token" happened, which is a real debugging aid and gives an attacker
 * nothing they did not already know from having tried.
 */
export function authorize(req: IncomingMessage, expected: string): AuthResult {
  const presented = bearerFrom(req);
  if (presented === null) {
    return { ok: false, detail: 'no Authorization: Bearer header' };
  }
  if (!constantTimeEquals(presented, expected)) {
    return { ok: false, detail: 'the presented token does not match this daemon\'s token' };
  }
  return { ok: true };
}
