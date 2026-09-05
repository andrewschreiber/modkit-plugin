/**
 * The job queue.
 *
 * Generation shells out to a model and takes seconds to minutes, so `POST /v1/generate` accepts
 * and returns a job id; the plugin polls. Everything expensive is in here, which makes this the
 * file where the boring properties matter:
 *
 * - **Bounded concurrency**, because each running job is a model call with a real budget.
 * - **Idempotency**, because the plugin retries on a dropped response and a second expensive
 *   generation for one user intent is money spent to produce a duplicate.
 * - **Progress the plugin can render**, because a `Notice` that says nothing for four minutes is
 *   indistinguishable from a daemon that died.
 * - **Cancellation**, because the answer to "I asked for the wrong thing" should not be "wait".
 * - **Retention with a cap**, because job files accumulate silently and nothing else prunes them.
 *
 * A job that was running when the daemon stopped does **not** resume: the model call is gone with
 * the process. Restore marks it failed and says so, rather than leaving a `generating` job that
 * will never move — a stuck job is the failure mode that makes people distrust the whole list.
 */

import { randomUUID } from 'node:crypto';

import {
  MODKIT_PROTOCOL_VERSION,
  isTerminalJob,
  targetKey,
  type GenerateBuilt,
  type GenerateRefusal,
  type GenerateRequest,
  type Job,
  type JobBase,
  type JobError,
  type JobErrorCode,
  type JobProgress,
  type RegenerateRequest,
  type ValidationFinding,
} from '@modkit/types';

import type { Logger } from './log.js';
import { decodePayload, type ArtifactDraft } from './sign.js';
import type { SignedArtifact } from '@modkit/types';
import {
  jobFile,
  listJobFiles,
  readJsonSync,
  removeQuietly,
  saveModArchive,
  writeJsonSync,
  appendTokenUsage,
  type StateLayout,
  type TokenLedgerRow,
} from './state.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The pipeline contract — implemented by ./generate.ts
 * ──────────────────────────────────────────────────────────────────────────── */

/** What one running job can do to report on itself. Handed to the pipeline; nothing else needs it. */
export interface JobContext {
  readonly jobId: string;
  /** Aborted on cancellation and on shutdown. Long steps must honour it. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /** Move the job through `generating` → `validating` → `building`. */
  stage(status: 'generating' | 'validating' | 'building'): void;
  /** A one-line, user-facing note. Shown verbatim in a `Notice`; `fraction` omitted rather than faked. */
  progress(message: string, fraction?: number): void;
  /** Append a row to the model-spend ledger. Never throws. */
  recordUsage(row: Omit<TokenLedgerRow, 'ts' | 'jobId'>): void;
}

export type PipelineInput =
  | { kind: 'generate'; request: GenerateRequest }
  | { kind: 'regenerate'; request: RegenerateRequest };

/**
 * What the pipeline returns.
 *
 * A refusal is a **first-class, correct outcome** — the daemon did its job and the answer was
 * "no". It is returned, not thrown. Only modkit *breaking* is a thrown error.
 *
 * On success the pipeline returns an unsigned {@link ArtifactDraft}: signing is deliberately not
 * the generator's business, so the private key stays in exactly one module.
 */
export type PipelineResult =
  | { kind: 'built'; draft: ArtifactDraft; warnings?: ValidationFinding[] }
  | GenerateRefusal;

export type Pipeline = (input: PipelineInput, ctx: JobContext) => Promise<PipelineResult>;

/**
 * The pipeline throws this when it breaks in a way worth classifying. Anything else it throws is
 * recorded as `internal`, which is honest but tells the user less.
 */
export class PipelineError extends Error {
  readonly code: JobErrorCode;
  readonly detail: string | undefined;
  readonly retryable: boolean;
  readonly findings: ValidationFinding[] | undefined;

  constructor(
    code: JobErrorCode,
    message: string,
    options: { detail?: string; retryable?: boolean; findings?: ValidationFinding[] } = {},
  ) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.detail = options.detail;
    this.retryable = options.retryable ?? false;
    this.findings = options.findings;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The queue
 * ──────────────────────────────────────────────────────────────────────────── */

export interface JobQueueOptions {
  layout: StateLayout;
  log: Logger;
  pipeline: Pipeline;
  /** Turns a draft into a signed artifact. Injected so `sign.ts` owns the key and this file never sees it. */
  sign: (draft: ArtifactDraft) => SignedArtifact;
  concurrency: number;
  /** Terminal jobs kept on disk and in memory. Older ones are evicted, file and all. */
  retention: number;
}

interface Entry {
  job: Job;
  /** `null` for a job restored from disk: it is already terminal and will never run again. */
  input: PipelineInput | null;
  controller: AbortController | null;
  /** True once a terminal state has been recorded — a late pipeline result is then ignored. */
  settled: boolean;
  lastPersistMs: number;
}

/** Progress updates are frequent and each one is an fsync; a terminal write is never throttled. */
const PERSIST_THROTTLE_MS = 500;

export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly pending: string[] = [];
  private active = 0;
  private closing = false;

  constructor(private readonly options: JobQueueOptions) {}

  /* ── submission ─────────────────────────────────────────────────────────── */

  submit(input: PipelineInput): { job: Job; deduped: boolean } {
    const key = input.request.idempotencyKey;
    const existingId = this.byIdempotencyKey.get(key);
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId);
      // Returning the existing job is the whole point: a retry after a dropped response must not
      // buy a second model call for one user intent.
      if (existing) return { job: existing.job, deduped: true };
      this.byIdempotencyKey.delete(key);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      protocol: MODKIT_PROTOCOL_VERSION,
      id,
      idempotencyKey: key,
      targetKey: targetKey(input.request.target),
      request: input.request.request,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
    };

    const entry: Entry = { job, input, controller: null, settled: false, lastPersistMs: 0 };
    this.entries.set(id, entry);
    this.byIdempotencyKey.set(key, id);
    this.pending.push(id);
    this.persist(entry, true);
    this.options.log.info('job queued', { jobId: id, targetKey: job.targetKey, kind: input.kind });
    this.pump();
    return { job, deduped: false };
  }

  /* ── reads ──────────────────────────────────────────────────────────────── */

  get(id: string): Job | null {
    return this.entries.get(id)?.job ?? null;
  }

  list(): Job[] {
    return [...this.entries.values()]
      .map((entry) => entry.job)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stats(): { queued: number; active: number; total: number } {
    return { queued: this.pending.length, active: this.active, total: this.entries.size };
  }

  /* ── cancellation ───────────────────────────────────────────────────────── */

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.settled || isTerminalJob(entry.job)) return false;
    entry.controller?.abort();
    this.dropPending(id);
    // There is no `cancelled` JobStatus, and adding one to the shared contract for a rare case is
    // not worth a protocol bump — so it is a failure whose message says exactly what happened.
    this.finish(entry, {
      status: 'failed',
      error: { code: 'internal', message: 'the job was cancelled', retryable: true },
    });
    return true;
  }

  private dropPending(id: string): void {
    const index = this.pending.indexOf(id);
    if (index !== -1) this.pending.splice(index, 1);
  }

  /* ── running ────────────────────────────────────────────────────────────── */

  private pump(): void {
    while (!this.closing && this.active < this.options.concurrency) {
      const id = this.pending.shift();
      if (id === undefined) return;
      const entry = this.entries.get(id);
      if (!entry || entry.settled) continue;
      this.active += 1;
      void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    const input = entry.input;
    if (input === null) {
      this.active -= 1;
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    const log = this.options.log.child({ jobId: entry.job.id });
    this.setStatus(entry, 'generating');

    const ctx: JobContext = {
      jobId: entry.job.id,
      signal: controller.signal,
      log,
      stage: (status) => {
        if (!entry.settled) this.setStatus(entry, status);
      },
      progress: (message, fraction) => {
        if (!entry.settled) this.setProgress(entry, message, fraction);
      },
      recordUsage: (row) => {
        appendTokenUsage(this.options.layout, { ...row, ts: new Date().toISOString(), jobId: entry.job.id });
      },
    };

    try {
      const result = await this.options.pipeline(input, ctx);
      if (entry.settled) return; // cancelled or shut down while the pipeline was still running

      if (result.kind === 'refused') {
        log.info('job refused', { reason: result.reason });
        this.finish(entry, { status: 'refused', result });
        return;
      }

      this.setStatus(entry, 'building');
      this.setProgress(entry, 'signing the generated mod');

      let artifact: SignedArtifact;
      try {
        artifact = this.options.sign(result.draft);
      } catch (err) {
        throw new PipelineError('signing-failed', 'the generated mod could not be signed', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      this.archive(entry, result.draft, artifact, log);

      const built: GenerateBuilt = {
        kind: 'built',
        modId: result.draft.modId,
        reach: result.draft.reach,
        explanation: result.draft.explanation,
        artifact,
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      };
      log.info('job done', { modId: built.modId, plane: built.reach.plane });
      this.finish(entry, { status: 'done', result: built });
    } catch (err) {
      if (entry.settled) return;
      const error = toJobError(err, controller.signal.aborted);
      log.error('job failed', { code: error.code, message: error.message, detail: error.detail });
      this.finish(entry, { status: 'failed', error });
    } finally {
      entry.controller = null;
      this.active -= 1;
      this.pump();
    }
  }

  private archive(entry: Entry, draft: ArtifactDraft, artifact: SignedArtifact, log: Logger): void {
    try {
      saveModArchive(this.options.layout, {
        modId: draft.modId,
        request: {
          request: draft.request,
          target: draft.target,
          reach: draft.reach,
          jobId: entry.job.id,
          input: entry.input,
        },
        artifact,
        payload: decodePayload(artifact),
        mainJs: draft.mainJs,
        manifest: draft.manifest,
      });
    } catch (err) {
      // The archive is how a mod gets regenerated later, so losing it matters — but the artifact
      // is already signed and the user is waiting for it. Report loudly, ship anyway.
      log.error('could not archive the generated mod', { modId: draft.modId, err });
    }
  }

  /* ── state transitions ──────────────────────────────────────────────────── */

  private setStatus(entry: Entry, status: 'queued' | 'generating' | 'validating' | 'building'): void {
    entry.job = { ...(entry.job as JobBase), status, updatedAt: new Date().toISOString() } as Job;
    this.persist(entry, true);
  }

  private setProgress(entry: Entry, message: string, fraction?: number): void {
    const progress: JobProgress = {
      message,
      ...(typeof fraction === 'number' && Number.isFinite(fraction)
        ? { fraction: Math.min(1, Math.max(0, fraction)) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    entry.job = { ...(entry.job as JobBase), progress, updatedAt: progress.updatedAt } as Job;
    this.persist(entry, false);
  }

  private finish(
    entry: Entry,
    outcome:
      | { status: 'done'; result: GenerateBuilt }
      | { status: 'refused'; result: GenerateRefusal }
      | { status: 'failed'; error: JobError },
  ): void {
    const finishedAt = new Date().toISOString();
    const base: JobBase = { ...(entry.job as JobBase), updatedAt: finishedAt, finishedAt };
    entry.job =
      outcome.status === 'failed'
        ? { ...base, status: 'failed', error: outcome.error, finishedAt }
        : outcome.status === 'refused'
          ? { ...base, status: 'refused', result: outcome.result, finishedAt }
          : { ...base, status: 'done', result: outcome.result, finishedAt };
    entry.settled = true;
    this.persist(entry, true);
    this.evict();
  }

  /* ── persistence ────────────────────────────────────────────────────────── */

  private persist(entry: Entry, force: boolean): void {
    const now = Date.now();
    if (!force && now - entry.lastPersistMs < PERSIST_THROTTLE_MS) return;
    entry.lastPersistMs = now;
    try {
      writeJsonSync(jobFile(this.options.layout, entry.job.id), entry.job);
    } catch (err) {
      // A job that cannot be written to disk is still a job that can be polled in memory.
      this.options.log.warn('could not persist job', { jobId: entry.job.id, err });
    }
  }

  /**
   * Keep at most `retention` terminal jobs. Running and queued jobs are never evicted — the cap
   * is a disk bound, not a work limit.
   */
  private evict(): void {
    const terminal = [...this.entries.values()]
      .filter((entry) => isTerminalJob(entry.job))
      .sort((a, b) => (a.job.finishedAt ?? '').localeCompare(b.job.finishedAt ?? ''));
    let excess = terminal.length - this.options.retention;
    for (const entry of terminal) {
      if (excess <= 0) break;
      excess -= 1;
      this.entries.delete(entry.job.id);
      if (this.byIdempotencyKey.get(entry.job.idempotencyKey) === entry.job.id) {
        this.byIdempotencyKey.delete(entry.job.idempotencyKey);
      }
      removeQuietly(jobFile(this.options.layout, entry.job.id));
    }
  }

  /**
   * Read the job files back at startup.
   *
   * Anything non-terminal is rewritten as failed. It cannot be resumed — the model call died with
   * the previous process — and a job left `generating` forever is worse than an honest failure,
   * because it is the one state a polling client will wait on indefinitely.
   */
  restore(): { restored: number; abandoned: number } {
    let restored = 0;
    let abandoned = 0;
    const files = listJobFiles(this.options.layout);
    const loaded: Job[] = [];
    for (const file of files) {
      const job = readJsonSync<Job>(file);
      if (!job || typeof job.id !== 'string' || typeof job.status !== 'string') {
        removeQuietly(file);
        continue;
      }
      loaded.push(job);
    }
    loaded.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    for (const job of loaded.slice(0, this.options.retention)) {
      let final: Job = job;
      if (!isTerminalJob(job)) {
        const finishedAt = new Date().toISOString();
        final = {
          ...(job as JobBase),
          status: 'failed',
          finishedAt,
          updatedAt: finishedAt,
          error: {
            code: 'internal',
            message: 'the daemon restarted while this job was running',
            detail: `the job was ${job.status} when the previous process exited; generation cannot be resumed`,
            retryable: true,
          },
        };
        abandoned += 1;
      } else {
        restored += 1;
      }
      const entry: Entry = { job: final, input: null, controller: null, settled: true, lastPersistMs: 0 };
      this.entries.set(final.id, entry);
      if (typeof final.idempotencyKey === 'string') this.byIdempotencyKey.set(final.idempotencyKey, final.id);
      if (final !== job) this.persist(entry, true);
    }

    // Anything past the retention cap on disk is dropped now rather than accumulating forever.
    for (const job of loaded.slice(this.options.retention)) {
      removeQuietly(jobFile(this.options.layout, job.id));
    }
    return { restored, abandoned };
  }

  /** Stop taking work, abort what is running, and record the truth about it. */
  close(): void {
    this.closing = true;
    for (const entry of this.entries.values()) {
      if (entry.settled) continue;
      entry.controller?.abort();
      this.finish(entry, {
        status: 'failed',
        error: {
          code: 'internal',
          message: 'the daemon shut down while this job was running',
          retryable: true,
        },
      });
    }
    this.pending.length = 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Error classification
 * ──────────────────────────────────────────────────────────────────────────── */

export function toJobError(err: unknown, aborted: boolean): JobError {
  if (err instanceof PipelineError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.detail === undefined ? {} : { detail: err.detail }),
      retryable: err.retryable,
      ...(err.findings === undefined ? {} : { findings: err.findings }),
    };
  }
  if (aborted) {
    return { code: 'internal', message: 'the job was cancelled', retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'internal',
    message: 'the generation pipeline threw',
    detail: message.slice(0, 4000),
    retryable: false,
  };
}
