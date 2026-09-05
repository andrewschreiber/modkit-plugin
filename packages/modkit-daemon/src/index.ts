/**
 * The modkit daemon's entry point and composition root.
 *
 * Everything with a dependency is wired here and nowhere else: config, state, logging, the token,
 * the keyring, the job queue, the generation pipeline, the HTTP server. The modules below it take
 * their collaborators as arguments, which is what lets any of them be exercised on an ephemeral
 * port with a temp directory and no signing key of consequence.
 *
 * Importing this module does **not** start a server — see `IS_MAIN` at the bottom.
 */

import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';

import { announceToken, loadOrCreateToken } from './auth.js';
import { runGeneration } from './generate.js';
import { JobQueue, type Pipeline } from './jobs.js';
import { createLogger, type Logger } from './log.js';
import { signArtifact, loadKeyring, type ArtifactDraft, type Keyring } from './sign.js';
import { createApp, type ServerDeps } from './server.js';
import { ensureState, resolveConfig, type DaemonConfig, type StateLayout } from './state.js';
import { validateSource } from './validate.js';

export { createApp } from './server.js';
export { JobQueue, PipelineError } from './jobs.js';
export type { JobContext, Pipeline, PipelineInput, PipelineResult } from './jobs.js';
export type { ArtifactDraft, Keyring } from './sign.js';
export { signArtifact, verifySignedArtifact, loadKeyring, pubkeyHex } from './sign.js';
export { resolveConfig, ensureState, appendTokenUsage } from './state.js';
export type { DaemonConfig, StateLayout, TokenLedgerRow } from './state.js';
export { createLogger } from './log.js';
export type { Logger, LogLevel } from './log.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Assembly
 * ──────────────────────────────────────────────────────────────────────────── */

export interface Daemon {
  config: DaemonConfig;
  layout: StateLayout;
  log: Logger;
  keyring: Keyring;
  jobs: JobQueue;
  server: Server;
  token: string;
}

export interface CreateDaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** Set false in tests so the logger does not spray the reporter's output. */
  logToStdout?: boolean;
  /** Injected in tests; otherwise loaded from `./generate.js`. */
  pipeline?: Pipeline;
}

export async function createDaemon(options: CreateDaemonOptions = {}): Promise<Daemon> {
  const config = resolveConfig(options.env ?? process.env);
  const layout = ensureState(config.stateDir);
  const log = createLogger({
    file: layout.logFile,
    level: config.logLevel,
    stdout: options.logToStdout !== false,
  });

  const token = loadOrCreateToken(layout, log);
  if (token.created) announceToken(token);

  const keyring = loadKeyring(layout, log, {
    certTtlMs: config.certTtlMs,
    certRenewBeforeMs: config.certRenewBeforeMs,
  });

  const pipeline = options.pipeline ?? runGeneration;

  const jobs = new JobQueue({
    layout,
    log,
    pipeline,
    sign: (draft: ArtifactDraft) =>
      signArtifact(draft, {
        keyring,
        daemonVersion: config.version,
        artifactTtlMs: config.artifactTtlMs,
      }),
    concurrency: config.concurrency,
    retention: config.jobRetention,
  });
  const restored = jobs.restore();
  if (restored.restored > 0 || restored.abandoned > 0) {
    log.info('restored job history', restored);
  }

  const deps: ServerDeps = {
    config,
    layout,
    log,
    token: token.token,
    keyring,
    jobs,
    validateSource,
    startedAt: Date.now(),
  };

  return { config, layout, log, keyring, jobs, server: createApp(deps), token: token.token };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Listening
 * ──────────────────────────────────────────────────────────────────────────── */

const MAX_BIND_ATTEMPTS = 10;

/**
 * Bind, with a **capped** retry for one specific failure and none at all for the other.
 *
 * `EADDRNOTAVAIL` means the address does not exist *yet* — a tailnet interface that has not come
 * up. That is worth waiting for, briefly, with a ceiling: an uncapped retry turns a lost race
 * into an invisible failure, where the port answers (the winner), the process exists (the loser),
 * and nothing looks wrong until edits stop taking effect.
 *
 * `EADDRINUSE` is not retried at all. Something already owns this port, and the honest response
 * is to say so and exit so a supervisor makes it a visible crash loop.
 *
 * Both handlers are registered **once**, outside the retry, or each attempt leaks a listener.
 */
function listen(server: Server, host: string, port: number, log: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRNOTAVAIL' && attempt < MAX_BIND_ATTEMPTS) {
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        attempt += 1;
        log.warn('address not available yet; retrying', { host, port, attempt, waitMs: wait });
        setTimeout(() => server.listen(port, host), wait);
        return;
      }
      server.off('error', onError);
      reject(err);
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
    server.listen(port, host);
  });
}

const SHUTDOWN_GRACE_MS = 500;
const HARD_EXIT_MS = 3000;

/**
 * Stop accepting, let what is in flight finish, then tear down — in that order.
 *
 * The naive order (close the backend first) tears the queue down underneath a request that is
 * still inside a handler. The unref'd hard-exit timer is the backstop for the case where step
 * three wedges: a daemon that will not die is worse than one that exits abruptly.
 */
export async function shutdown(daemon: Daemon, reason: string): Promise<void> {
  daemon.log.info('shutting down', { reason, queue: daemon.jobs.stats() });
  const hard = setTimeout(() => process.exit(0), HARD_EXIT_MS);
  hard.unref();

  daemon.server.close(); // deliberately not awaited — it resolves only when the last socket closes
  daemon.server.closeIdleConnections();
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  daemon.server.closeAllConnections();
  daemon.jobs.close();

  clearTimeout(hard);
}

export async function startDaemon(options: CreateDaemonOptions = {}): Promise<Daemon> {
  const daemon = await createDaemon(options);
  try {
    await listen(daemon.server, daemon.config.host, daemon.config.port, daemon.log);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    daemon.log.error('could not bind', { host: daemon.config.host, port: daemon.config.port, code, err });
    throw err;
  }
  daemon.log.info('modkit daemon listening', {
    url: `http://${daemon.config.host}:${daemon.config.port}`,
    version: daemon.config.version,
    model: daemon.config.model,
    concurrency: daemon.config.concurrency,
    rootPubkey: daemon.keyring.rootPubkeyHex,
    kid: daemon.keyring.kid,
    stateDir: daemon.config.stateDir,
  });
  return daemon;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────────── */

/** True only when this file is the process entry — importing it from a test starts nothing. */
const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (IS_MAIN) {
  const boot = createLogger({ level: 'info' });
  let stopping = false;

  startDaemon()
    .then((daemon) => {
      // A rejected promise nobody handled is a bug worth seeing, not a reason to drop a daemon
      // that is otherwise serving requests.
      process.on('unhandledRejection', (err) => daemon.log.error('unhandled rejection', { err }));
      process.on('uncaughtException', (err) => {
        daemon.log.error('uncaught exception — exiting so a supervisor restarts us', { err });
        process.exit(1);
      });

      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
          if (stopping) return;
          stopping = true;
          void shutdown(daemon, signal).then(() => process.exit(0));
        });
      }
    })
    .catch((err: unknown) => {
      boot.error('modkit daemon failed to start', { err });
      process.exit(1);
    });
}
