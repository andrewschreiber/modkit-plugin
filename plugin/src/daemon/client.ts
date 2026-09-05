/**
 * The plugin's side of the modkit HTTP contract.
 *
 * Everything goes through Obsidian's `requestUrl()`, never `fetch`/`XMLHttpRequest`. That is not a
 * style preference: `requestUrl` is documented as making HTTP/HTTPS requests *"without any CORS
 * restrictions"*, which is what lets the same code reach a daemon on the tailnet from the desktop
 * app **and** from the Capacitor WebView on iOS, where a `fetch` to a plain-HTTP tailnet address is
 * blocked before it leaves the page.
 *
 * Three shapes run through the whole file:
 *
 * 1. **Errors are typed, never stringly.** The UI renders "the daemon isn't running" (offer to start
 *    it), "your token is wrong" (open settings), "the daemon is from an older build" (rebuild it)
 *    and "generation failed" (show the daemon's own detail) completely differently, and it cannot
 *    if they arrive collapsed into one message. See {@link DaemonErrorCode}.
 * 2. **A refusal is a success.** `{status:"refused"}` means the daemon did its job and the honest
 *    answer was "I cannot reach that, here is why" — it is a {@link JobOutcome} variant, not an
 *    error. Treating it as a failure is how a correct refusal ends up looking like a bug in modkit.
 * 3. **Every wait is cancellable and bounded.** Generation takes minutes; the user closes the modal.
 *    Cancellation is an `AbortSignal` the caller owns, which is also this client's reclaim story:
 *    it holds no state a `Component` needs to reclaim, so `this.register(() => controller.abort())`
 *    at the call site is the whole teardown.
 */

import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { MODKIT_PROTOCOL_VERSION, isTerminalJob } from "@modkit/types";
import type {
	ApiErrorCode,
	GenerateBuilt,
	GenerateRefusal,
	GenerateRequest,
	ModelBackend,
	ModelCheckResponse,
	HealthResponse,
	Job,
	JobAccepted,
	JobDone,
	JobError,
	JobFailed,
	JobRefused,
	JobStatus,
	RegenerateRequest,
} from "@modkit/types";

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/** Measured free on mac-mini, and absent from every other service registry on the box. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8501";

/** Per-request wall clock. Generous, because `requestUrl` itself offers no timeout at all. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** How long `pollUntilDone` will wait before giving up on a job that is still running. */
const DEFAULT_JOB_TIMEOUT_MS = 12 * 60 * 1000;

const DEFAULT_POLL_INITIAL_MS = 700;
const DEFAULT_POLL_MAX_MS = 5_000;
const DEFAULT_POLL_FACTOR = 1.6;

export interface DaemonClientOptions {
	/** Base URL, e.g. `http://100.64.1.2:8501`. Trailing slashes are ignored. */
	baseUrl: string;
	/** The shared bearer token. Never appears in an error message or a log line. */
	token: string;
	/** Per-request timeout. Defaults to 20s; `pollUntilDone` has its own, longer budget. */
	requestTimeoutMs?: number;
}

/** Options accepted by every single-request method. */
export interface CallOptions {
	/** Abort the wait. The HTTP request may still be in flight — see {@link DaemonClient}. */
	signal?: AbortSignal;
	/** Overrides {@link DaemonClientOptions.requestTimeoutMs} for this call. */
	timeoutMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every distinct thing that can go wrong, as a value the UI can switch on.
 *
 * The five the brief names explicitly — unreachable, auth, protocol mismatch, job failed, timeout —
 * are each their own code. `cancelled` is separate from `timeout` because one is the user's doing
 * and must produce no error UI at all, while the other is a fault worth showing.
 */
export type DaemonErrorCode =
	/** Nothing answered on that address: the daemon is not running, or the tailnet is down. */
	| "unreachable"
	/** We stopped waiting. The request may still complete on the daemon. */
	| "timeout"
	/** The caller's `AbortSignal` fired — the user closed the modal. Render nothing. */
	| "cancelled"
	/** 401/403: the bearer token in settings does not match the daemon's. */
	| "unauthorized"
	/** The daemon speaks a different wire contract. Loud on purpose; see {@link protocolMismatch}. */
	| "protocol-mismatch"
	/** Something answered, and it is not a modkit daemon. */
	| "wrong-service"
	/** 400: the daemon rejected the request body. A bug on our side, not the user's. */
	| "bad-request"
	/** 404: no such job. Usually a daemon that restarted and lost its job directory. */
	| "not-found"
	/** 429. */
	| "rate-limited"
	/** 5xx, or any other status the daemon should not have produced. */
	| "server-error"
	/** A 2xx whose body is not the document the route promises. */
	| "malformed-response"
	/** The job ran and broke. `jobError` carries the daemon's own classification and detail. */
	| "job-failed";

export interface DaemonError {
	code: DaemonErrorCode;
	/** One sentence, in the user's terms. Never contains the bearer token. */
	message: string;
	/** The specifics — status line, body excerpt, exception text. May be long. Also token-free. */
	detail?: string;
	/** HTTP status, when there was one. */
	status?: number;
	/** True when the identical call could plausibly succeed on a retry. */
	retryable: boolean;
	/** Present on `protocol-mismatch`, so the mismatch is legible without reading two changelogs. */
	expectedProtocol?: string;
	receivedProtocol?: string;
	/** Present iff `code === "job-failed"` — the daemon's structured account of the failure. */
	jobError?: JobError;
}

export type DaemonResult<T> = { ok: true; value: T } | { ok: false; error: DaemonError };

/** Narrowing helper, so call sites read as `if (isOk(r))`. */
export function isOk<T>(result: DaemonResult<T>): result is { ok: true; value: T } {
	return result.ok;
}

/**
 * Build a {@link DaemonError} without ever assigning `undefined` to an optional field —
 * `exactOptionalPropertyTypes` is on, and a present-but-undefined `detail` serialises into a log as
 * a real key with no value.
 */
function daemonError(
	code: DaemonErrorCode,
	message: string,
	extra: {
		detail?: string;
		status?: number;
		retryable?: boolean;
		expectedProtocol?: string;
		receivedProtocol?: string;
		jobError?: JobError;
	} = {},
): DaemonError {
	const error: DaemonError = { code, message, retryable: extra.retryable ?? false };
	if (extra.detail !== undefined) error.detail = extra.detail;
	if (extra.status !== undefined) error.status = extra.status;
	if (extra.expectedProtocol !== undefined) error.expectedProtocol = extra.expectedProtocol;
	if (extra.receivedProtocol !== undefined) error.receivedProtocol = extra.receivedProtocol;
	if (extra.jobError !== undefined) error.jobError = extra.jobError;
	return error;
}

function err<T>(error: DaemonError): DaemonResult<T> {
	return { ok: false, error };
}

/**
 * The protocol-mismatch error, written once so it is identical wherever it is raised.
 *
 * Deliberately specific: a generic "request failed" here sends the user to the network, when the
 * actual cause is a daemon left running from a build older than the plugin — which is the single
 * most likely failure during development and produces no other symptom.
 */
function protocolMismatch(received: unknown, where: string, baseUrl: string): DaemonError {
	const got = typeof received === "string" && received.length > 0 ? received : "(none)";
	return daemonError(
		"protocol-mismatch",
		`The modkit daemon at ${baseUrl} speaks wire contract ${got}, but this plugin speaks ${MODKIT_PROTOCOL_VERSION}. Rebuild and restart the daemon.`,
		{
			detail: `protocol mismatch on ${where}: expected ${MODKIT_PROTOCOL_VERSION}, received ${got}`,
			expectedProtocol: MODKIT_PROTOCOL_VERSION,
			receivedProtocol: got,
			retryable: false,
		},
	);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Job outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How a job that ran to completion ended, from the caller's point of view.
 *
 * `refused` lives here rather than in {@link DaemonError} because it is a **correct outcome**: the
 * daemon read the target, found the request unreachable, and said so with a reason. The UI shows it
 * as an answer, not as a fault.
 */
export type JobOutcome =
	| { kind: "built"; job: JobDone; result: GenerateBuilt }
	| { kind: "refused"; job: JobRefused; refusal: GenerateRefusal };

/** Narrowing helper. */
export function isBuiltOutcome(o: JobOutcome): o is Extract<JobOutcome, { kind: "built" }> {
	return o.kind === "built";
}

export interface PollOptions extends CallOptions {
	/**
	 * Called on every status or progress change, never on an unchanged poll. Wire it to a `Notice`
	 * or a status-bar item; generation takes minutes and silence reads as a hang.
	 */
	onProgress?: (job: Job) => void;
	/** Total budget for the whole wait. Defaults to 12 minutes. */
	jobTimeoutMs?: number;
	/** First inter-poll delay, in ms. Defaults to 700. */
	initialDelayMs?: number;
	/** Ceiling for the backoff, in ms. Defaults to 5000. */
	maxDelayMs?: number;
	/** Multiplier applied to the delay after each poll. Defaults to 1.6. */
	backoffFactor?: number;
	/**
	 * How many consecutive transport failures to absorb before giving up. Defaults to 3: a daemon
	 * restarting mid-generation is an ordinary event, and abandoning a five-minute job over one
	 * dropped socket is worse than waiting.
	 */
	maxTransientFailures?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The client
 * ──────────────────────────────────────────────────────────────────────────── */

const JOB_STATUSES: ReadonlySet<string> = new Set<JobStatus>([
	"queued",
	"generating",
	"validating",
	"building",
	"done",
	"refused",
	"failed",
]);

/**
 * A stateless HTTP client for the modkit daemon.
 *
 * Stateless is the point: it owns no sockets, no timers that outlive a call, and no cache. Nothing
 * here needs reclaiming on plugin unload — the caller's `AbortSignal` is the only lifetime, and
 * aborting it is the whole teardown.
 *
 * **Cancellation caveat, stated because it is not obvious:** `requestUrl` takes no `AbortSignal`, so
 * an aborted call stops *us* waiting; the underlying request runs to completion and its result is
 * discarded. For polling that is exactly right (the daemon keeps generating, and the job can be
 * picked up again by id). Every timer this client creates is cleared on both the resolve and the
 * abort path.
 */
export class DaemonClient {
	private options: DaemonClientOptions;

	constructor(options: DaemonClientOptions) {
		this.options = { ...options };
	}

	/** Settings change while the plugin is loaded; the client is re-pointed rather than rebuilt. */
	update(patch: Partial<DaemonClientOptions>): void {
		if (patch.baseUrl !== undefined) this.options.baseUrl = patch.baseUrl;
		if (patch.token !== undefined) this.options.token = patch.token;
		if (patch.requestTimeoutMs !== undefined) this.options.requestTimeoutMs = patch.requestTimeoutMs;
	}

	/** The configured base URL, normalised. Safe to show in UI — it carries no credential. */
	get baseUrl(): string {
		return normaliseBaseUrl(this.options.baseUrl);
	}

	/** True once a token has been configured. The UI uses this to gate "test connection". */
	get hasToken(): boolean {
		return this.options.token.trim().length > 0;
	}

	/* ── routes ──────────────────────────────────────────────────────────── */

	/**
	 * `GET /v1/health` — the one unauthenticated route, and the only place a protocol mismatch can
	 * be caught *before* an expensive generation is started. Call it when settings change and before
	 * the first generate of a session.
	 */
	/**
	 * Ask the daemon whether it can actually reach a model — the question a failed generation
	 * answers far too late and far too expensively.
	 *
	 * `deep` spends one minimal model turn, which is the only way to tell "signed in" from "the
	 * binary exists": a CLI whose OAuth session expired still answers `--version` cheerfully. The
	 * settings tab uses `deep: true` behind an explicit button press for exactly that reason —
	 * it is a few tokens, and it is the difference between "modkit is broken" and "run
	 * `claude login`".
	 */
	async modelCheck(
		options: CallOptions & { deep?: boolean; backend?: ModelBackend } = {},
	): Promise<DaemonResult<ModelCheckResponse>> {
		const query = new URLSearchParams();
		if (options.deep) query.set("deep", "1");
		if (options.backend) query.set("backend", options.backend);
		const suffix = query.toString();
		const res = await this.call("GET", `/v1/model-check${suffix ? `?${suffix}` : ""}`, undefined, options);
		if (!res.ok) return res;
		const body = res.value.body;
		if (!isRecord(body)) {
			return err(this.malformed("/v1/model-check", "response body is not an object", res.value));
		}
		if (body["protocol"] !== MODKIT_PROTOCOL_VERSION) {
			return err(protocolMismatch(body["protocol"], "/v1/model-check", this.baseUrl));
		}
		return { ok: true, value: body as unknown as ModelCheckResponse };
	}

	async health(options: CallOptions = {}): Promise<DaemonResult<HealthResponse>> {
		const res = await this.call("GET", "/v1/health", undefined, options);
		if (!res.ok) return res;
		const body = res.value.body;
		if (!isRecord(body)) {
			return err(this.malformed("/v1/health", "response body is not an object", res.value));
		}
		if (body["service"] !== "modkit") {
			return err(
				daemonError(
					"wrong-service",
					`Something is listening on ${this.baseUrl}, but it is not the modkit daemon.`,
					{
						detail: `expected service "modkit", received ${JSON.stringify(body["service"])}`,
						status: res.value.status,
					},
				),
			);
		}
		if (body["protocol"] !== MODKIT_PROTOCOL_VERSION) {
			return err(protocolMismatch(body["protocol"], "/v1/health", this.baseUrl));
		}
		if (typeof body["pubkey"] !== "string" || typeof body["version"] !== "string") {
			return err(this.malformed("/v1/health", "response is missing `pubkey` or `version`", res.value));
		}
		return { ok: true, value: body as unknown as HealthResponse };
	}

	/**
	 * `POST /v1/generate`. Returns the accepted job, not the artifact — generation takes seconds to
	 * minutes, so the caller then {@link pollUntilDone}s, or uses {@link generateAndWait}.
	 *
	 * The `protocol` field is stamped here and only here, so the plugin can never send a request
	 * labelled with a version other than the one it was compiled against.
	 */
	async generate(
		request: Omit<GenerateRequest, "protocol">,
		options: CallOptions = {},
	): Promise<DaemonResult<JobAccepted>> {
		const body: GenerateRequest = { ...request, protocol: MODKIT_PROTOCOL_VERSION };
		return this.postJob("/v1/generate", body, options);
	}

	/** `POST /v1/regenerate` — the maintenance path; same job semantics as {@link generate}. */
	async regenerate(
		request: Omit<RegenerateRequest, "protocol">,
		options: CallOptions = {},
	): Promise<DaemonResult<JobAccepted>> {
		const body: RegenerateRequest = { ...request, protocol: MODKIT_PROTOCOL_VERSION };
		return this.postJob("/v1/regenerate", body, options);
	}

	/** `GET /v1/jobs/:id` — one poll. Most callers want {@link pollUntilDone} instead. */
	async job(jobId: string, options: CallOptions = {}): Promise<DaemonResult<Job>> {
		const res = await this.call("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, options);
		if (!res.ok) return res;
		const body = res.value.body;
		if (!isRecord(body)) {
			return err(this.malformed(`/v1/jobs/${jobId}`, "response body is not an object", res.value));
		}
		if (body["protocol"] !== MODKIT_PROTOCOL_VERSION) {
			return err(protocolMismatch(body["protocol"], `/v1/jobs/${jobId}`, this.baseUrl));
		}
		const status = body["status"];
		if (typeof status !== "string" || !JOB_STATUSES.has(status)) {
			return err(
				this.malformed(`/v1/jobs/${jobId}`, `unknown job status ${JSON.stringify(status)}`, res.value),
			);
		}
		// The discriminant and the protocol are checked; the variant-specific fields are the
		// daemon's contract and are the caller's to read. Casting after checking the discriminant is
		// honest — casting blind is not.
		return { ok: true, value: body as unknown as Job };
	}

	/* ── waiting ─────────────────────────────────────────────────────────── */

	/**
	 * Poll a job to a terminal state, with backoff, a hard budget and cancellation.
	 *
	 * Returns `ok` for both terminal *answers* — built and refused. `failed` becomes a `job-failed`
	 * error carrying the daemon's own {@link JobError}, so the UI can show the validator findings or
	 * the model's error text rather than "something went wrong".
	 */
	async pollUntilDone(jobId: string, options: PollOptions = {}): Promise<DaemonResult<JobOutcome>> {
		const budget = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
		const maxDelay = options.maxDelayMs ?? DEFAULT_POLL_MAX_MS;
		const factor = options.backoffFactor ?? DEFAULT_POLL_FACTOR;
		const maxTransient = options.maxTransientFailures ?? 3;
		const deadline = Date.now() + budget;
		let delayMs = options.initialDelayMs ?? DEFAULT_POLL_INITIAL_MS;
		let transientFailures = 0;
		let lastSeen = "";
		let lastError: DaemonError | null = null;

		for (;;) {
			if (options.signal?.aborted) return err(cancelledError(jobId));

			const pollOptions: CallOptions = {};
			if (options.signal !== undefined) pollOptions.signal = options.signal;
			if (options.timeoutMs !== undefined) pollOptions.timeoutMs = options.timeoutMs;
			const res = await this.job(jobId, pollOptions);

			if (res.ok) {
				// Cleared, not just counted down: a transport blip the poll recovered from must not
				// still be quoted in a timeout message minutes later as though it were the cause.
				transientFailures = 0;
				lastError = null;
				const job = res.value;

				// Fire progress only on an actual change, so a two-minute generation does not
				// repaint the same Notice sixty times.
				const seen = `${job.status}:${job.progress?.updatedAt ?? ""}:${job.progress?.message ?? ""}`;
				if (seen !== lastSeen) {
					lastSeen = seen;
					try {
						options.onProgress?.(job);
					} catch {
						// A progress renderer must never be able to abandon a job in flight.
					}
				}

				if (isTerminalJob(job)) return terminalOutcome(job);
			} else if (isTransient(res.error)) {
				// A daemon restarting mid-generation is ordinary. Keep the job, absorb the blip, and
				// only surface the *last* error if the failures do not stop.
				lastError = res.error;
				transientFailures += 1;
				if (transientFailures > maxTransient) return err(res.error);
			} else {
				return err(res.error);
			}

			const remaining = deadline - Date.now();
			if (remaining <= 0) return err(timeoutError(jobId, budget, lastSeen, lastError));

			const wait = Math.min(delayMs, maxDelay, remaining);
			const interrupted = await delay(wait, options.signal);
			if (interrupted) return err(cancelledError(jobId));
			delayMs = Math.min(Math.round(delayMs * factor), maxDelay);
		}
	}

	/** {@link generate} then {@link pollUntilDone}, which is what every UI path actually wants. */
	async generateAndWait(
		request: Omit<GenerateRequest, "protocol">,
		options: PollOptions = {},
	): Promise<DaemonResult<JobOutcome>> {
		const accepted = await this.generate(request, options);
		if (!accepted.ok) return accepted;
		return this.pollUntilDone(accepted.value.jobId, options);
	}

	/* ── transport ───────────────────────────────────────────────────────── */

	private async postJob(
		path: string,
		body: GenerateRequest | RegenerateRequest,
		options: CallOptions,
	): Promise<DaemonResult<JobAccepted>> {
		const res = await this.call("POST", path, body, options);
		if (!res.ok) return res;
		const parsed = res.value.body;
		if (!isRecord(parsed)) {
			return err(this.malformed(path, "response body is not an object", res.value));
		}
		if (parsed["protocol"] !== MODKIT_PROTOCOL_VERSION) {
			return err(protocolMismatch(parsed["protocol"], path, this.baseUrl));
		}
		const jobId = parsed["jobId"];
		if (typeof jobId !== "string" || jobId.length === 0) {
			return err(this.malformed(path, "response carries no `jobId`", res.value));
		}
		return { ok: true, value: parsed as unknown as JobAccepted };
	}

	/**
	 * One HTTP round trip, with `throw: false` so a 4xx arrives as a status and a body rather than
	 * as an exception with no body — which is the default and is wrong for every route here.
	 */
	private async call(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		options: CallOptions,
	): Promise<DaemonResult<{ status: number; text: string; body: unknown }>> {
		if (options.signal?.aborted) {
			return err(daemonError("cancelled", "The request was cancelled.", { detail: `aborted before ${method} ${path}` }));
		}
		if (!this.hasToken) {
			return err(
				daemonError("unauthorized", "No modkit daemon token is set. Add it in modkit's settings.", {
					detail: "the bearer token in settings is empty",
				}),
			);
		}

		const url = `${this.baseUrl}${path}`;
		const params: RequestUrlParam = {
			url,
			method,
			throw: false,
			headers: {
				Authorization: `Bearer ${this.options.token}`,
				Accept: "application/json",
			},
		};
		if (body !== undefined) {
			params.contentType = "application/json";
			params.body = JSON.stringify(body);
		}

		const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const outcome = await race(requestUrl(params), timeoutMs, options.signal);

		if (outcome.kind === "cancelled") {
			return err(daemonError("cancelled", "The request was cancelled.", { detail: `aborted during ${method} ${path}` }));
		}
		if (outcome.kind === "timeout") {
			return err(
				daemonError("timeout", `The modkit daemon at ${this.baseUrl} did not answer in time.`, {
					detail: `${method} ${path} exceeded ${timeoutMs}ms`,
					retryable: true,
				}),
			);
		}
		if (outcome.kind === "rejected") {
			// `requestUrl` rejects for transport failures — connection refused, DNS, TLS. With
			// `throw:false` set, a rejection is never an HTTP status.
			return err(
				daemonError("unreachable", `Could not reach the modkit daemon at ${this.baseUrl}. Is it running?`, {
					detail: `${method} ${path}: ${redact(errText(outcome.error), this.options.token)}`,
					retryable: true,
				}),
			);
		}

		const response = outcome.value;
		const text = safeText(response);
		const parsed = parseJson(text);

		if (response.status >= 200 && response.status < 300) {
			if (!parsed.ok) {
				return err(
					daemonError("malformed-response", `The modkit daemon returned something that is not JSON.`, {
						detail: `${method} ${path} → ${response.status}: ${parsed.detail}; body starts: ${excerpt(text)}`,
						status: response.status,
					}),
				);
			}
			return { ok: true, value: { status: response.status, text, body: parsed.value } };
		}

		return err(this.httpError(method, path, response.status, text, parsed.ok ? parsed.value : undefined));
	}

	/** Map a non-2xx into a typed error, preferring the daemon's own `ApiErrorResponse` when present. */
	private httpError(
		method: string,
		path: string,
		status: number,
		text: string,
		parsed: unknown,
	): DaemonError {
		const api = readApiError(parsed);
		const detail = `${method} ${path} → ${status}${api?.detail ? `: ${api.detail}` : `: ${excerpt(text)}`}`;

		if (api?.code === "protocol-mismatch" || status === 426) {
			return protocolMismatch(api?.receivedProtocol ?? api?.expectedProtocol, `${method} ${path}`, this.baseUrl);
		}
		if (status === 401 || status === 403) {
			return daemonError(
				"unauthorized",
				`The modkit daemon at ${this.baseUrl} rejected this plugin's token. Check the shared secret in settings.`,
				{ detail, status },
			);
		}
		if (status === 404) {
			return daemonError("not-found", api?.message ?? "The modkit daemon has no record of that job.", {
				detail,
				status,
			});
		}
		if (status === 429) {
			return daemonError("rate-limited", "The modkit daemon is refusing new work right now.", {
				detail,
				status,
				retryable: true,
			});
		}
		if (status >= 400 && status < 500) {
			return daemonError(
				"bad-request",
				api?.message ?? "The modkit daemon rejected the request. This is a modkit bug, not a setting.",
				{ detail, status },
			);
		}
		return daemonError("server-error", api?.message ?? "The modkit daemon failed while handling the request.", {
			detail,
			status,
			retryable: status >= 500,
		});
	}

	private malformed(path: string, why: string, res: { status: number; text: string }): DaemonError {
		return daemonError("malformed-response", `The modkit daemon's reply for ${path} was not the expected shape.`, {
			detail: `${path} → ${res.status}: ${why}; body starts: ${excerpt(res.text)}`,
			status: res.status,
		});
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function terminalOutcome(job: JobDone | JobRefused | JobFailed): DaemonResult<JobOutcome> {
	if (job.status === "done") {
		return { ok: true, value: { kind: "built", job, result: job.result } };
	}
	if (job.status === "refused") {
		// Not an error. The daemon read the target and answered honestly.
		return { ok: true, value: { kind: "refused", job, refusal: job.result } };
	}
	const jobError: JobError = job.error;
	return err(
		daemonError("job-failed", jobError.message, {
			detail: jobError.detail ?? `${jobError.code} while generating`,
			retryable: jobError.retryable,
			jobError,
		}),
	);
}

function cancelledError(jobId: string): DaemonError {
	return daemonError("cancelled", "Stopped waiting for the mod.", {
		detail: `polling of job ${jobId} was cancelled; the daemon may still be generating it`,
	});
}

function timeoutError(
	jobId: string,
	budgetMs: number,
	lastSeen: string,
	lastError: DaemonError | null,
): DaemonError {
	const tail = lastError ? `; last transport error: ${lastError.code} ${lastError.message}` : "";
	const waited = budgetMs < 1000 ? `${budgetMs}ms` : `${Math.round(budgetMs / 1000)}s`;
	return daemonError("timeout", `The mod was still being generated after ${waited}.`, {
		detail: `job ${jobId} did not reach a terminal status within ${budgetMs}ms; last observed ${lastSeen || "(nothing)"}${tail}`,
		retryable: true,
	});
}

/** Which failures a poll should absorb rather than abandon a running job over. */
function isTransient(error: DaemonError): boolean {
	return error.code === "unreachable" || error.code === "timeout" || error.code === "server-error";
}

function normaliseBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Strip the bearer token out of anything on its way into an error.
 *
 * Redaction is a property of what a message may contain, not of where it is written — so it happens
 * unconditionally, at the one place exception text enters a `DaemonError`.
 */
function redact(text: string, token: string): string {
	if (token.length < 4) return text;
	return text.split(token).join("«token»");
}

function excerpt(text: string, max = 240): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * `RequestUrlResponse.text` is a lazily-decoded property; reading it on a binary or empty body can
 * throw. A response we cannot read is an empty body, never an exception at the call site.
 */
function safeText(response: RequestUrlResponse): string {
	try {
		return response.text ?? "";
	} catch {
		return "";
	}
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
	if (text.trim().length === 0) return { ok: false, detail: "empty body" };
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (e) {
		return { ok: false, detail: errText(e) };
	}
}

/** Pull the daemon's structured error out of a body, when it sent one. */
function readApiError(parsed: unknown): {
	code?: ApiErrorCode;
	message?: string;
	detail?: string;
	expectedProtocol?: string;
	receivedProtocol?: string;
} | null {
	if (!isRecord(parsed)) return null;
	const e = parsed["error"];
	if (!isRecord(e)) return null;
	const out: {
		code?: ApiErrorCode;
		message?: string;
		detail?: string;
		expectedProtocol?: string;
		receivedProtocol?: string;
	} = {};
	if (typeof e["code"] === "string") out.code = e["code"] as ApiErrorCode;
	if (typeof e["message"] === "string") out.message = e["message"];
	if (typeof e["detail"] === "string") out.detail = e["detail"];
	if (typeof e["expectedProtocol"] === "string") out.expectedProtocol = e["expectedProtocol"];
	if (typeof e["receivedProtocol"] === "string") out.receivedProtocol = e["receivedProtocol"];
	return out;
}

type RaceOutcome<T> =
	| { kind: "resolved"; value: T }
	| { kind: "rejected"; error: unknown }
	| { kind: "timeout" }
	| { kind: "cancelled" };

/**
 * Wait for `promise`, but no longer than `timeoutMs`, and stop early if `signal` aborts.
 *
 * The underlying `requestUrl` keeps running in both early-exit cases — it accepts no signal — so
 * this bounds *our* wait, not the request. Every timer and listener is removed on every path,
 * including the one where the promise wins the race.
 */
async function race<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<RaceOutcome<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<RaceOutcome<T>>((resolve) => {
			let settled = false;
			const finish = (outcome: RaceOutcome<T>): void => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
			timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
			if (signal) {
				onAbort = () => finish({ kind: "cancelled" });
				signal.addEventListener("abort", onAbort, { once: true });
			}
			promise.then(
				(value) => finish({ kind: "resolved", value }),
				(error: unknown) => finish({ kind: "rejected", error }),
			);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Sleep, unless the signal fires first. Resolves `true` when it was interrupted.
 *
 * The bare `setTimeout` here and in {@link race} is not a hole in the reclaim contract: neither
 * timer outlives the `await` that created it — both are cleared in a `finally`, on the resolve path
 * and on the abort path alike — so there is nothing left for a `Component` to reclaim. The rule is
 * about acquisitions that survive the call; these do not.
 */
async function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
			if (signal) {
				onAbort = () => resolve(true);
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * A key that is stable for one user intent, so a retry after a dropped response returns the
 * existing job instead of paying for a second generation.
 *
 * `crypto.randomUUID` is present in Electron and in the Capacitor WebView (both secure contexts),
 * but it is guarded anyway: a helper that throws on one platform would take the compose modal with
 * it, and any 128 bits of `getRandomValues` serve equally well.
 */
export function newIdempotencyKey(): string {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (typeof c?.randomUUID === "function") return c.randomUUID();
	const bytes = new Uint8Array(16);
	c?.getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return `modkit-${Date.now().toString(36)}-${hex}`;
}
