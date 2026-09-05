/**
 * Structured logging for the modkit daemon.
 *
 * One JSON object per line, to stdout and (optionally) to a file. Three properties are
 * deliberate rather than incidental:
 *
 * 1. **Logging never throws and never kills a run.** Every write path is wrapped. A daemon that
 *    dies because its log directory went read-only has turned an observability problem into an
 *    availability one.
 * 2. **Redaction happens on the way to the sink, unconditionally.** It is a property of what a log
 *    line may *contain*, not of where the line is going — so a token pasted into an error message
 *    from three layers down is still scrubbed.
 * 3. **The file rotates itself.** Nothing else rotates it: launchd does not rotate a path a process
 *    appends to, and there is no newsyslog entry. One generation is enough to bound the disk and
 *    keeps `tail -f` working, because `rename` leaves the reader's fd on bytes that still exist.
 */

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

/** Extra structured fields merged into a line. Values are JSON-serialised defensively. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that stamps `fields` onto every line — used for per-request and per-job context. */
  child(fields: LogFields): Logger;
  /** The level in force, so a caller can skip building an expensive field object. */
  readonly level: LogLevel;
}

export interface LoggerOptions {
  /** Absolute path of the log file. Omit for stdout only (tests). */
  file?: string;
  level?: LogLevel;
  /** Rotate at this size. One generation: `<file>` → `<file>.1`. */
  maxBytes?: number;
  /** Set false to silence stdout (tests). */
  stdout?: boolean;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Patterns scrubbed from every line.
 *
 * The daemon token is minted with an `mk_` prefix precisely so it is recognisable here: a bare
 * hex or base64 blob cannot be distinguished from the Ed25519 public key, which we *want* in the
 * logs. Giving the secret a shape makes redaction exact instead of heuristic.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/mk_[A-Za-z0-9_-]{8,}/g, 'mk_<redacted>'],
  [/\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/("(?:authorization|token|secret|password|privateKey)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>'],
];

export function redact(line: string): string {
  let out = line;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** JSON.stringify that survives an Error, a BigInt and a cycle — all three reach logs in practice. */
function serialise(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (val instanceof Error) {
        return { message: val.message, name: val.name, stack: val.stack };
      }
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    }) ?? 'null';
  } catch (err) {
    return JSON.stringify({ logSerialiseError: String(err) });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVEL_RANK[level];
  const file = options.file;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const toStdout = options.stdout !== false;

  // Re-asserted on the first successful write of each process: appendFileSync only applies its
  // `mode` when it *creates* the file, so a log left 0644 by an earlier build stays 0644 forever.
  let modeAsserted = false;

  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      /* the write below will report it; do not fail startup over a log directory */
    }
  }

  function rotateIfNeeded(): void {
    if (!file) return;
    try {
      if (statSync(file).size < maxBytes) return;
      renameSync(file, `${file}.1`);
      modeAsserted = false; // the next append creates a new file
    } catch {
      /* no file yet, or a racing rotation from a sibling process — either is fine */
    }
  }

  function emit(lineLevel: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_RANK[lineLevel] < threshold) return;
    const record = { ts: new Date().toISOString(), level: lineLevel, msg: message, ...fields };
    const line = `${redact(serialise(record))}\n`;

    if (toStdout) {
      try {
        process.stdout.write(line);
      } catch {
        /* a closed stdout (detached under launchd) must not take the daemon with it */
      }
    }
    if (!file) return;
    try {
      rotateIfNeeded();
      appendFileSync(file, line, { mode: 0o600 });
      if (!modeAsserted) {
        chmodSync(file, 0o600);
        modeAsserted = true; // set only on success, or one transient EPERM disables it forever
      }
    } catch {
      /* never kill a run over logging */
    }
  }

  function build(bound: LogFields): Logger {
    return {
      level,
      debug: (message, fields) => emit('debug', message, { ...bound, ...fields }),
      info: (message, fields) => emit('info', message, { ...bound, ...fields }),
      warn: (message, fields) => emit('warn', message, { ...bound, ...fields }),
      error: (message, fields) => emit('error', message, { ...bound, ...fields }),
      child: (fields) => build({ ...bound, ...fields }),
    };
  }

  return build({});
}

/** A logger that discards everything — for tests that assert on behaviour, not on output. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    level: 'error',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
