/**
 * The HTTP surface. `node:http`, no framework, JSON in and JSON out.
 *
 * `createApp()` returns an **unbound** server, which is what makes the daemon testable on an
 * ephemeral port with no state directory of its own and no listening socket left behind.
 *
 * Three things here are load-bearing rather than boilerplate:
 *
 * - **The path is normalised before it is routed**, both before and after percent-decoding, so a
 *   request target cannot smuggle a traversal or a control byte into a log line or a filename.
 * - **The body is capped and the socket timeouts are finite.** An unbounded read on a route that
 *   spawns a model is a denial of service with a very high unit cost.
 * - **Every non-2xx has the same shape** ({@link ApiErrorResponse}), because the plugin renders
 *   these to a human and a route that improvises its error format is a route whose failures are
 *   invisible in the UI.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  MODKIT_PROTOCOL_VERSION,
  isModelBackend,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ClientEnvironment,
  type GenerateRequest,
  type HealthResponse,
  type JobAccepted,
  type ModelCheckResponse,
  type ModelOverride,
  type RegenerateRequest,
  type TargetRef,
  type ValidationReport,
} from '@modkit/types';

import { authorize } from './auth.js';
import { checkBackend, loginCommand } from './probe.js';
import type { JobQueue } from './jobs.js';
import type { Logger } from './log.js';
import type { Keyring } from './sign.js';
import { CODEX_SANDBOX_REFUSAL, type DaemonConfig, type StateLayout } from './state.js';

export interface ServerDeps {
  config: DaemonConfig;
  layout: StateLayout;
  log: Logger;
  token: string;
  keyring: Keyring;
  jobs: JobQueue;
  /** The generated-code validator, from `./validate.ts`. Backs `POST /v1/validate`, a dev-only introspection route. */
  validateSource: (source: string) => ValidationReport;
  startedAt: number;
}

const MAX_PATH_LENGTH = 1024;
const MAX_REQUEST_TEXT = 20_000;
const MAX_ID_LENGTH = 200;
/** A model id, e.g. `claude-opus-5` or `gpt-5-codex`. Generous; it only has to stop abuse. */
const MAX_MODEL_LENGTH = 200;

/* ────────────────────────────────────────────────────────────────────────────
 * Responses
 * ──────────────────────────────────────────────────────────────────────────── */

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
    'cache-control': 'no-store',
    'x-modkit-request-id': requestId,
  });
  res.end(buf);
}

interface ErrorExtras {
  detail?: string;
  expectedProtocol?: string;
  receivedProtocol?: string;
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extras: ErrorExtras = {},
): void {
  const body: ApiErrorResponse = {
    error: {
      code,
      message,
      ...(extras.detail === undefined ? {} : { detail: extras.detail }),
      ...(extras.expectedProtocol === undefined ? {} : { expectedProtocol: extras.expectedProtocol }),
      ...(extras.receivedProtocol === undefined ? {} : { receivedProtocol: extras.receivedProtocol }),
    },
  };
  sendJson(res, status, body, requestId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Path normalisation
 * ──────────────────────────────────────────────────────────────────────────── */

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const ENCODED_TRAPS = /%(?:2e|2f|5c|00)/i;

type PathResult = { ok: true; path: string } | { ok: false; detail: string };

export function normalisePath(rawUrl: string): PathResult {
  const target = rawUrl.split('?', 1)[0] ?? '';
  if (target.length === 0 || target.length > MAX_PATH_LENGTH) return { ok: false, detail: 'path length' };
  if (!target.startsWith('/')) return { ok: false, detail: 'path is not absolute' };
  if (CONTROL_OR_BACKSLASH.test(target)) return { ok: false, detail: 'path contains a control byte or backslash' };
  // Checked before decoding as well as after: a route that only inspects the decoded form has
  // already let the encoded form reach whatever did the decoding.
  if (ENCODED_TRAPS.test(target)) return { ok: false, detail: 'path contains an encoded traversal sequence' };

  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return { ok: false, detail: 'path is not valid percent-encoding' };
  }
  if (CONTROL_OR_BACKSLASH.test(decoded)) return { ok: false, detail: 'decoded path contains a control byte' };

  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return { ok: false, detail: 'path contains a relative segment' };
  }
  const normalised = segments.filter((s, i) => s !== '' || i === 0).join('/');
  return { ok: true, path: normalised === '' ? '/' : normalised };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Body reading
 * ──────────────────────────────────────────────────────────────────────────── */

type BodyResult =
  | { ok: true; text: string }
  | { ok: false; status: number; code: ApiErrorCode; message: string; detail?: string };

/**
 * Past the cap we stop *buffering* but keep *draining*, up to a hard ceiling.
 *
 * Destroying the request the moment the limit trips is the obvious move and it is wrong: it tears
 * down the socket the response has to go out on, so the client sees an EPIPE instead of the 413
 * that would have told it what happened. A caller that cannot read our error learns nothing.
 */
const OVERFLOW_DRAIN_FACTOR = 8;

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const tooLarge: BodyResult = {
      ok: false,
      status: 413,
      code: 'bad-request',
      message: `the request body exceeds ${limit} bytes`,
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    let settled = false;
    const done = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > limit) overflowed = true;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        if (size > limit * OVERFLOW_DRAIN_FACTOR) {
          done(tooLarge);
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(overflowed ? tooLarge : { ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (err) =>
      done({ ok: false, status: 400, code: 'bad-request', message: 'the request body could not be read', detail: String(err) }),
    );
    req.on('aborted', () => done({ ok: false, status: 400, code: 'bad-request', message: 'the request was aborted' }));
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Body shape checks
 * ──────────────────────────────────────────────────────────────────────────── */

type Check<T> = { ok: true; value: T } | { ok: false; message: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string, max: number): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function checkTarget(value: unknown): Check<TargetRef> {
  if (!isRecord(value)) return { ok: false, message: '`target` must be an object' };
  if (value['kind'] === 'plugin') {
    const pluginId = str(value, 'pluginId', MAX_ID_LENGTH);
    const pluginVersion = str(value, 'pluginVersion', 64);
    if (!pluginId || !pluginVersion) {
      return { ok: false, message: 'a plugin target needs `pluginId` and `pluginVersion`' };
    }
    return { ok: true, value: value as unknown as TargetRef };
  }
  if (value['kind'] === 'core') {
    if (!str(value, 'appVersion', 64)) return { ok: false, message: 'a core target needs `appVersion`' };
    return { ok: true, value: value as unknown as TargetRef };
  }
  return { ok: false, message: '`target.kind` must be "plugin" or "core"' };
}

function checkClient(value: unknown): Check<ClientEnvironment> {
  if (!isRecord(value)) return { ok: false, message: '`client` must be an object' };
  const platform = value['platform'];
  if (platform !== 'desktop' && platform !== 'mobile') {
    return { ok: false, message: '`client.platform` must be "desktop" or "mobile"' };
  }
  if (!str(value, 'modkitVersion', 64) || !str(value, 'obsidianApiVersion', 64)) {
    return { ok: false, message: '`client` needs `modkitVersion` and `obsidianApiVersion`' };
  }
  return { ok: true, value: value as unknown as ClientEnvironment };
}

/**
 * The optional per-request backend/model override.
 *
 * Absent is the normal case and always valid — it means "use the daemon's configured backend and
 * model". Present and malformed is a `bad-request` rather than something quietly ignored: a client
 * that asked for codex and silently got claude would be told it had switched backends when it had
 * not, which is the exact silent-no-op shape this codebase treats as the worst failure mode.
 *
 * Note what is NOT checked here: whether a `codex` override is *permitted*. That is the daemon
 * operator's acknowledgment, it is not a syntax question, and answering it here would put the
 * security gate in the parser. `generate.ts` enforces it where the backend is actually chosen.
 */
function checkModelOverride(value: unknown): Check<undefined | ModelOverride> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, message: '`modelOverride` must be an object' };
  const backend = value['backend'];
  if (backend !== undefined && !isModelBackend(backend)) {
    return { ok: false, message: '`modelOverride.backend` must be "claude" or "codex"' };
  }
  const model = value['model'];
  if (model !== undefined && (typeof model !== 'string' || model.length > MAX_MODEL_LENGTH)) {
    return { ok: false, message: `\`modelOverride.model\` must be a string of at most ${MAX_MODEL_LENGTH} characters` };
  }
  return { ok: true, value: value as unknown as ModelOverride };
}

function checkGenerate(body: Record<string, unknown>): Check<GenerateRequest> {
  const idempotencyKey = str(body, 'idempotencyKey', MAX_ID_LENGTH);
  if (!idempotencyKey) return { ok: false, message: '`idempotencyKey` must be a non-empty string' };
  const request = str(body, 'request', MAX_REQUEST_TEXT);
  if (!request) return { ok: false, message: '`request` must be a non-empty string' };
  const target = checkTarget(body['target']);
  if (!target.ok) return target;
  const client = checkClient(body['client']);
  if (!client.ok) return client;
  const override = checkModelOverride(body['modelOverride']);
  if (!override.ok) return override;
  return { ok: true, value: body as unknown as GenerateRequest };
}

function checkRegenerate(body: Record<string, unknown>): Check<RegenerateRequest> {
  const idempotencyKey = str(body, 'idempotencyKey', MAX_ID_LENGTH);
  if (!idempotencyKey) return { ok: false, message: '`idempotencyKey` must be a non-empty string' };
  const modId = str(body, 'modId', MAX_ID_LENGTH);
  if (!modId) return { ok: false, message: '`modId` must be a non-empty string' };
  const request = str(body, 'request', MAX_REQUEST_TEXT);
  if (!request) return { ok: false, message: '`request` must be a non-empty string' };
  const target = checkTarget(body['target']);
  if (!target.ok) return target;
  const client = checkClient(body['client']);
  if (!client.ok) return client;
  const origin = body['origin'];
  if (!isRecord(origin) || typeof origin['trigger'] !== 'string' || typeof origin['assertionsFrozen'] !== 'boolean') {
    return { ok: false, message: '`origin` must be a RegenerationOrigin' };
  }
  const override = checkModelOverride(body['modelOverride']);
  if (!override.ok) return override;
  return { ok: true, value: body as unknown as RegenerateRequest };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The app
 * ──────────────────────────────────────────────────────────────────────────── */

export function createApp(deps: ServerDeps): Server {
  const log = deps.log;

  const server = createServer((req, res) => {
    const requestId = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level]('request', {
        requestId,
        method: req.method,
        url: (req.url ?? '').split('?', 1)[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    handle(deps, req, res, requestId).catch((err: unknown) => {
      log.error('unhandled error in a request handler', { requestId, err });
      if (!res.headersSent) {
        sendError(res, 500, 'internal', 'the daemon failed to handle this request', requestId);
      } else {
        res.destroy();
      }
    });
  });

  // Finite, and deliberately short: nothing here is a long-lived stream. `/v1/generate` returns a
  // job id in milliseconds precisely so no request ever has to sit inside a model call.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => {
    try {
      socket.destroy();
    } catch {
      /* the socket is already gone, which is the outcome we wanted */
    }
  });

  return server;
}

async function handle(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const parsed = normalisePath(req.url ?? '/');
  if (!parsed.ok) {
    sendError(res, 400, 'bad-request', 'the request path is not acceptable', requestId, { detail: parsed.detail });
    return;
  }
  const path = parsed.path;
  const method = (req.method ?? 'GET').toUpperCase();

  // The one unauthenticated route. It reveals the daemon's version, protocol, model and *public*
  // key — all of which a client needs before it can talk to the daemon, and none of which is a secret.
  if (path === '/v1/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendError(res, 405, 'bad-request', 'GET /v1/health', requestId);
      return;
    }
    const body: HealthResponse = {
      ok: true,
      service: 'modkit',
      protocol: MODKIT_PROTOCOL_VERSION,
      version: deps.config.version,
      pubkey: deps.keyring.rootPubkeyHex,
      model: deps.config.model,
      backend: deps.config.backend,
      codexAvailable: deps.config.codexAcknowledged,
      uptimeMs: Date.now() - deps.startedAt,
    };
    sendJson(res, 200, body, requestId);
    return;
  }

  const auth = authorize(req, deps.token);
  if (!auth.ok) {
    sendError(res, 401, 'unauthorized', 'a valid bearer token is required', requestId, { detail: auth.detail });
    return;
  }

  // Authenticated, because it reports absolute paths on this machine and can spend a few tokens.
  if (path === '/v1/model-check') {
    if (method !== 'GET') {
      sendError(res, 405, 'bad-request', 'GET /v1/model-check', requestId);
      return;
    }
    // `normalisePath` deliberately drops the query string, so read it from the raw URL rather than
    // loosening a function whose whole job is refusing hostile paths.
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const deep = query.get('deep') === '1';
    const backendParam = query.get('backend');
    if (backendParam !== null && !isModelBackend(backendParam)) {
      sendError(res, 400, 'bad-request', '`backend` must be "claude" or "codex"', requestId);
      return;
    }
    const backend = backendParam ?? deps.config.backend;
    if (backend === 'codex' && !deps.config.codexAcknowledged) {
      sendError(res, 400, 'bad-request', 'this daemon is not configured to use codex', requestId, {
        detail: CODEX_SANDBOX_REFUSAL,
      });
      return;
    }
    void checkBackend(backend, { deep })
      .then((check) => {
        const body: ModelCheckResponse = {
          protocol: MODKIT_PROTOCOL_VERSION,
          backend: check.backend,
          binPath: check.binPath,
          searched: check.searched,
          version: check.version,
          signedIn: check.signedIn,
          hint: check.hint,
          loginCommand: loginCommand(check.backend),
        };
        sendJson(res, 200, body, requestId);
      })
      .catch((err: unknown) => {
        sendError(res, 500, 'internal', 'the model check failed', requestId, { detail: String(err) });
      });
    return;
  }

  if (path === '/v1/generate' || path === '/v1/regenerate') {
    if (method !== 'POST') {
      sendError(res, 405, 'bad-request', `POST ${path}`, requestId);
      return;
    }
    await handleSubmit(deps, req, res, requestId, path === '/v1/generate' ? 'generate' : 'regenerate');
    return;
  }

  if (path === '/v1/jobs') {
    if (method !== 'GET') {
      sendError(res, 405, 'bad-request', 'GET /v1/jobs', requestId);
      return;
    }
    sendJson(res, 200, { protocol: MODKIT_PROTOCOL_VERSION, jobs: deps.jobs.list() }, requestId);
    return;
  }

  const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9._-]{1,128})(\/cancel)?$/.exec(path);
  if (jobMatch) {
    const jobId = jobMatch[1] as string;
    const isCancel = jobMatch[2] !== undefined;
    if (isCancel) {
      if (method !== 'POST') {
        sendError(res, 405, 'bad-request', 'POST /v1/jobs/:id/cancel', requestId);
        return;
      }
      const cancelled = deps.jobs.cancel(jobId);
      const job = deps.jobs.get(jobId);
      if (!job) {
        sendError(res, 404, 'not-found', `no job ${jobId}`, requestId);
        return;
      }
      sendJson(res, 200, { protocol: MODKIT_PROTOCOL_VERSION, cancelled, job }, requestId);
      return;
    }
    if (method !== 'GET') {
      sendError(res, 405, 'bad-request', 'GET /v1/jobs/:id', requestId);
      return;
    }
    const job = deps.jobs.get(jobId);
    if (!job) {
      sendError(res, 404, 'not-found', `no job ${jobId}`, requestId);
      return;
    }
    sendJson(res, 200, job, requestId);
    return;
  }

  if (path === '/v1/validate') {
    if (method !== 'POST') {
      sendError(res, 405, 'bad-request', 'POST /v1/validate', requestId);
      return;
    }
    await handleValidate(deps, req, res, requestId);
    return;
  }

  sendError(res, 404, 'not-found', `no route ${method} ${path}`, requestId);
}

async function parseJsonBody(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, deps.config.maxBodyBytes);
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message, requestId, {
      ...(body.detail === undefined ? {} : { detail: body.detail }),
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (err) {
    sendError(res, 400, 'bad-request', 'the request body is not JSON', requestId, { detail: String(err) });
    return null;
  }
  if (!isRecord(parsed)) {
    sendError(res, 400, 'bad-request', 'the request body must be a JSON object', requestId);
    return null;
  }
  // Checked on every authenticated route, and it fails loudly. The failure this prevents is a
  // daemon left running from an older build quietly producing artifacts a newer plugin
  // half-understands.
  if (parsed['protocol'] !== MODKIT_PROTOCOL_VERSION) {
    sendError(res, 400, 'protocol-mismatch', 'this daemon speaks a different modkit protocol', requestId, {
      expectedProtocol: MODKIT_PROTOCOL_VERSION,
      receivedProtocol: typeof parsed['protocol'] === 'string' ? parsed['protocol'] : '(absent)',
    });
    return null;
  }
  return parsed;
}

async function handleSubmit(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  kind: 'generate' | 'regenerate',
): Promise<void> {
  const body = await parseJsonBody(deps, req, res, requestId);
  if (!body) return;

  // A pinned-key mismatch is caught here, where it can be explained, rather than on the device as
  // an unexplained verification failure — which is exactly what this field exists for.
  const pinned = body['pinnedRootPubkey'];
  if (typeof pinned === 'string' && pinned.length > 0 && pinned !== deps.keyring.rootPubkeyHex) {
    sendError(res, 400, 'bad-request', 'this plugin has pinned a different modkit root key', requestId, {
      detail: `the plugin pinned ${pinned.slice(0, 16)}…, this daemon signs with ${deps.keyring.rootPubkeyHex.slice(0, 16)}…`,
    });
    return;
  }

  const checked = kind === 'generate' ? checkGenerate(body) : checkRegenerate(body);
  if (!checked.ok) {
    sendError(res, 400, 'bad-request', checked.message, requestId, {
      ...(checked.detail === undefined ? {} : { detail: checked.detail }),
    });
    return;
  }

  const submitted =
    kind === 'generate'
      ? deps.jobs.submit({ kind: 'generate', request: checked.value as GenerateRequest })
      : deps.jobs.submit({ kind: 'regenerate', request: checked.value as RegenerateRequest });

  const accepted: JobAccepted = {
    protocol: MODKIT_PROTOCOL_VERSION,
    jobId: submitted.job.id,
    status: submitted.job.status,
    ...(submitted.deduped ? { deduped: true } : {}),
  };
  deps.log.info('job accepted', {
    requestId,
    jobId: accepted.jobId,
    kind,
    deduped: submitted.deduped,
    queue: deps.jobs.stats(),
  });
  sendJson(res, 202, accepted, requestId);
}

async function handleValidate(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const body = await parseJsonBody(deps, req, res, requestId);
  if (!body) return;
  const source = body['source'];
  if (typeof source !== 'string' || source.length === 0) {
    sendError(res, 400, 'bad-request', '`source` must be a non-empty string', requestId);
    return;
  }
  if (source.length > deps.config.maxBodyBytes) {
    sendError(res, 413, 'bad-request', '`source` is too large', requestId);
    return;
  }
  try {
    const report: ValidationReport = deps.validateSource(source);
    sendJson(res, 200, report, requestId);
  } catch (err) {
    sendError(res, 500, 'internal', 'the validator threw', requestId, { detail: String(err) });
  }
}
