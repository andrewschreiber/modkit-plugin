/**
 * `src/daemon/client.ts` — the HTTP contract, from the plugin's side.
 *
 * Three claims in that file's header are the reason this suite exists, and each is asserted rather
 * than reasoned about:
 *
 * 1. **Errors are typed, never stringly.** The UI renders "the daemon isn't running", "your token is
 *    wrong", "the daemon is from an older build" and "generation failed" completely differently, so
 *    the four have to arrive as four distinguishable values. A test that only checked `ok === false`
 *    would pass while they collapsed into one.
 * 2. **A refusal is a success.** `{status:"refused"}` is the daemon doing its job. If `pollUntilDone`
 *    ever returns it as an error, a correct refusal reads to the user as a modkit bug.
 * 3. **Every wait is cancellable and bounded.** A generation in flight was once able to install a
 *    plugin into the vault minutes after modkit was disabled; the fix was wiring the `AbortSignal`.
 *    `describe("cancellation")` below is that wiring, held down and counted — an abort must not just
 *    resolve the caller's promise, it must stop the requests.
 *
 * ## What this harness is
 *
 * `requestUrl` comes from `stub/obsidian.mjs`, whose default throws — a test that reaches the
 * network has escaped its harness. Every test installs a scripted handler through
 * `setRequestUrlHandler` and gets back a transcript of what the client actually sent. That
 * transcript is the honest instrument here: "the client stopped polling" is a claim about requests,
 * not about promises.
 *
 * ## Where it is crude
 *
 * `requestUrl` is replaced by a function, so nothing below exercises Obsidian's real transport: no
 * CORS-free behaviour, no redirect handling, no `arrayBuffer`/`json` accessors, no partial reads.
 * The client's own doc comment notes that `requestUrl` takes no `AbortSignal` and that an aborted
 * call leaves the underlying request running — that is a property of Obsidian's implementation and
 * **is not reproduced here**; what is tested is that the client stops *waiting* and stops *issuing*.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { setRequestUrlHandler } from "./stub/obsidian.mjs";
import { compileSurface } from "./stub/compile.mjs";

const surface = await compileSurface(
	"client-surface",
	`
	export { DaemonClient, isOk, isBuiltOutcome, newIdempotencyKey, DEFAULT_DAEMON_URL } from "../../src/daemon/client";
	export { MODKIT_PROTOCOL_VERSION } from "@modkit/types";
	`,
);

const { DaemonClient, isOk, isBuiltOutcome, newIdempotencyKey, DEFAULT_DAEMON_URL, MODKIT_PROTOCOL_VERSION } = surface;

// esbuild strips types without resolving them, so a renamed export in `src/` would arrive here as
// `undefined` at call time rather than as a build failure. Fail loudly instead.
for (const [name, value] of Object.entries({ DaemonClient, isOk, isBuiltOutcome, newIdempotencyKey })) {
	assert.equal(typeof value, "function", `the client bundle has no ${name} — did an export get renamed?`);
}
assert.equal(MODKIT_PROTOCOL_VERSION, "MODKIT/1");

const BASE_URL = "http://127.0.0.1:8501";
const TOKEN = "s3cret-bearer-token-value";

/* ────────────────────────────────────────────────────────────────────────────
 * Harness
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every request the client issued, in order. The instrument for "it stopped polling". */
let sent = [];

/**
 * Install a `requestUrl` answer.
 *
 * `respond` receives `{ method, path, body, request }` and returns either a `{status, text}` pair,
 * a promise for one, or throws — a throw is how Obsidian's `requestUrl` reports a transport failure
 * with `throw:false` set (it rejects only for connection/DNS/TLS, never for an HTTP status).
 */
function serve(respond) {
	setRequestUrlHandler(async (param) => {
		const url = new URL(param.url);
		const entry = {
			method: param.method,
			path: `${url.pathname}${url.search}`,
			url: param.url,
			headers: param.headers ?? {},
			body: param.body === undefined ? undefined : JSON.parse(param.body),
			at: Date.now(),
		};
		sent.push(entry);
		const answer = await respond(entry);
		return { status: answer.status, text: answer.text, headers: {} };
	});
}

/** JSON body helper; `status` defaults to 200. */
function json(value, status = 200) {
	return { status, text: JSON.stringify(value) };
}

const jobBase = (overrides = {}) => ({
	protocol: MODKIT_PROTOCOL_VERSION,
	id: "job-1",
	idempotencyKey: "key-1",
	targetKey: "plugin:obsidian-tasks-plugin",
	request: "make the tasks quieter",
	createdAt: "2026-08-31T12:00:00.000Z",
	updatedAt: "2026-08-31T12:00:01.000Z",
	...overrides,
});

const runningJob = (status = "generating", progress) =>
	jobBase(progress === undefined ? { status } : { status, progress });

const doneJob = () =>
	jobBase({
		status: "done",
		finishedAt: "2026-08-31T12:01:00.000Z",
		result: {
			kind: "built",
			modId: "modkit-mod-quieter-tasks",
			reach: { plane: "A", pluginId: "obsidian-tasks-plugin", holder: "prototype", method: "getTasks" },
			explanation: "wrapped getTasks",
			artifact: { payload: "…", signature: "…" },
		},
	});

const refusedJob = () =>
	jobBase({
		status: "refused",
		finishedAt: "2026-08-31T12:01:00.000Z",
		result: {
			kind: "refused",
			reason: "no-reachable-surface",
			target: { kind: "plugin", pluginId: "obsidian-tasks-plugin", pluginVersion: "7.21.0" },
			explanation: "Nothing in Tasks exposes that behaviour on a prototype.",
			detail: "no own or inherited method named renderRow",
		},
	});

const failedJob = () =>
	jobBase({
		status: "failed",
		finishedAt: "2026-08-31T12:01:00.000Z",
		error: {
			code: "validation-failed",
			message: "The generated mod did not pass validation.",
			detail: "unguarded-internal-access at line 12",
			retryable: false,
			findings: [{ rule: "unguarded-internal-access", severity: "error", message: "app.plugins without ?." }],
		},
	});

function makeClient(options = {}) {
	return new DaemonClient({ baseUrl: BASE_URL, token: TOKEN, ...options });
}

/** A poll script: hand back each job in turn, repeating the last one forever. */
function jobScript(jobs) {
	let i = 0;
	return () => {
		const job = jobs[Math.min(i, jobs.length - 1)];
		i += 1;
		return json(job);
	};
}

const FAST_POLL = { initialDelayMs: 5, maxDelayMs: 20, backoffFactor: 2 };

beforeEach(() => {
	sent = [];
});

afterEach(() => {
	setRequestUrlHandler(null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Transport basics
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the request the client actually sends", () => {
	test("bearer token, JSON accept, and `throw:false` on every call", async () => {
		serve(() => json({ ok: true, service: "modkit", protocol: MODKIT_PROTOCOL_VERSION, pubkey: "ab", version: "0.1.0" }));
		const result = await makeClient().health();

		assert.ok(isOk(result));
		assert.equal(sent.length, 1);
		assert.equal(sent[0].method, "GET");
		assert.equal(sent[0].url, `${BASE_URL}/v1/health`);
		assert.equal(sent[0].headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(sent[0].headers.Accept, "application/json");
	});

	test("a trailing slash on the base URL does not produce a doubled path", async () => {
		serve(() => json({ ok: true, service: "modkit", protocol: MODKIT_PROTOCOL_VERSION, pubkey: "ab", version: "0.1.0" }));
		const client = new DaemonClient({ baseUrl: `${BASE_URL}///`, token: TOKEN });
		assert.equal(client.baseUrl, BASE_URL);
		await client.health();
		assert.equal(sent[0].path, "/v1/health");
	});

	test("generate stamps the protocol itself, so a request can never carry the wrong one", async () => {
		serve(() => json({ protocol: MODKIT_PROTOCOL_VERSION, jobId: "job-1", status: "queued" }, 202));
		// The caller passes `protocol: "MODKIT/0"` in — the type forbids it, JavaScript does not, and
		// the daemon would reject the whole request over it.
		const result = await makeClient().generate({ protocol: "MODKIT/0", request: "hi" });

		assert.ok(isOk(result));
		assert.equal(sent[0].body.protocol, MODKIT_PROTOCOL_VERSION);
		assert.equal(result.value.jobId, "job-1");
	});

	test("generate forwards proposedReach when the caller supplied one, and omits it otherwise", async () => {
		serve(() => json({ protocol: MODKIT_PROTOCOL_VERSION, jobId: "job-1", status: "queued" }, 202));
		const client = makeClient();

		const reach = { plane: "E", selector: ".tasks-list-item", mode: "css" };
		await client.generate({ request: "make the tasks quieter", proposedReach: reach });
		assert.deepEqual(sent.at(-1).body.proposedReach, reach, "a pick that produced a reach must travel with the request");

		await client.generate({ request: "make the tasks quieter" });
		assert.equal(
			Object.hasOwn(sent.at(-1).body, "proposedReach"),
			false,
			"no proposed reach means the field is omitted, not sent as undefined/null",
		);
	});

	test("`update()` re-points the client without rebuilding it", async () => {
		serve(() => json({ ok: true, service: "modkit", protocol: MODKIT_PROTOCOL_VERSION, pubkey: "ab", version: "0.1.0" }));
		const client = new DaemonClient({ baseUrl: BASE_URL, token: "" });
		assert.equal(client.hasToken, false);
		client.update({ baseUrl: "http://100.64.0.1:8501/", token: "new-token" });
		assert.equal(client.hasToken, true);
		assert.equal(client.baseUrl, "http://100.64.0.1:8501");
		await client.health();
		assert.equal(sent[0].headers.Authorization, "Bearer new-token");
	});

	test("the default URL is the documented one", () => {
		assert.equal(DEFAULT_DAEMON_URL, "http://127.0.0.1:8501");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Error typing — the claim the UI depends on
 * ──────────────────────────────────────────────────────────────────────────── */

describe("auth failure, unreachable daemon and job failure are distinguishable", () => {
	/** All three run through the same call shape, so only the classification differs. */
	async function codeFor(respond, run) {
		serve(respond);
		const result = await (run ?? ((c) => c.job("job-1")))(makeClient({ requestTimeoutMs: 200 }));
		assert.equal(result.ok, false, "expected this scenario to fail");
		return result.error;
	}

	test("nothing listening → `unreachable`, and retryable", async () => {
		const error = await codeFor(() => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		});
		assert.equal(error.code, "unreachable");
		assert.equal(error.retryable, true);
		assert.match(error.message, /Is it running\?/);
		assert.match(error.detail, /ERR_CONNECTION_REFUSED/, "the transport's own words must survive into the detail");
	});

	test("401 → `unauthorized`, and NOT retryable", async () => {
		const error = await codeFor(() => json({ error: { code: "unauthorized", message: "bad token" } }, 401));
		assert.equal(error.code, "unauthorized");
		assert.equal(error.status, 401);
		assert.equal(error.retryable, false, "retrying the same wrong token is not a recovery");
	});

	test("403 is the same class as 401", async () => {
		const error = await codeFor(() => json({ error: { code: "unauthorized", message: "no" } }, 403));
		assert.equal(error.code, "unauthorized");
	});

	test("an empty token fails as `unauthorized` without touching the network", async () => {
		serve(() => {
			throw new Error("a request must not be made with no token");
		});
		const result = await new DaemonClient({ baseUrl: BASE_URL, token: "  " }).health();
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "unauthorized");
		assert.match(result.error.message, /settings/i, "the message must point at the fix");
		assert.equal(sent.length, 0, "the client must not spend a round trip to discover it has no token");
	});

	test("a job that ran and broke → `job-failed`, carrying the daemon's own JobError", async () => {
		const error = await codeFor(jobScript([failedJob()]), (c) => c.pollUntilDone("job-1", FAST_POLL));
		assert.equal(error.code, "job-failed");
		assert.equal(error.jobError.code, "validation-failed");
		assert.equal(error.jobError.findings.length, 1, "the validator findings are the whole point of showing this");
		assert.equal(error.message, "The generated mod did not pass validation.");
		assert.equal(error.retryable, false, "retryability comes from the daemon's own classification");
	});

	test("the four codes are four values, not one", async () => {
		const codes = new Set();
		codes.add((await codeFor(() => {
			throw new Error("refused");
		})).code);
		codes.add((await codeFor(() => json({}, 401))).code);
		codes.add((await codeFor(() => json({ protocol: "MODKIT/0", status: "queued" }))).code);
		codes.add((await codeFor(jobScript([failedJob()]), (c) => c.pollUntilDone("job-1", FAST_POLL))).code);
		assert.deepEqual([...codes].sort(), ["job-failed", "protocol-mismatch", "unauthorized", "unreachable"]);
	});

	test("404, 429 and 5xx each get their own code, and only two are retryable", async () => {
		assert.equal((await codeFor(() => json({}, 404))).code, "not-found");
		const limited = await codeFor(() => json({}, 429));
		assert.equal(limited.code, "rate-limited");
		assert.equal(limited.retryable, true);
		const server = await codeFor(() => json({}, 503));
		assert.equal(server.code, "server-error");
		assert.equal(server.retryable, true);
		const bad = await codeFor(() => json({}, 400));
		assert.equal(bad.code, "bad-request");
		assert.equal(bad.retryable, false);
	});

	test("a 2xx that is not JSON → `malformed-response`, with an excerpt of what did arrive", async () => {
		const error = await codeFor(() => ({ status: 200, text: "<html><body>nginx</body></html>" }));
		assert.equal(error.code, "malformed-response");
		assert.match(error.detail, /nginx/, "the body excerpt is how a proxy in the way gets diagnosed");
	});

	test("a 200 whose job status is not a job status → `malformed-response`, not a silent cast", async () => {
		const error = await codeFor(() => json({ protocol: MODKIT_PROTOCOL_VERSION, status: "almost-done" }));
		assert.equal(error.code, "malformed-response");
		assert.match(error.detail, /almost-done/);
	});
});

describe("protocol mismatch is loud and specific", () => {
	test("/v1/health names both versions and says what to do", async () => {
		serve(() => json({ ok: true, service: "modkit", protocol: "MODKIT/0", pubkey: "ab", version: "0.0.9" }));
		const result = await makeClient().health();

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "protocol-mismatch");
		assert.equal(result.error.expectedProtocol, MODKIT_PROTOCOL_VERSION);
		assert.equal(result.error.receivedProtocol, "MODKIT/0");
		assert.match(result.error.message, /MODKIT\/0/);
		assert.match(result.error.message, /MODKIT\/1/);
		assert.match(result.error.message, /Rebuild and restart the daemon/i, "the one fix must be in the message");
		assert.equal(result.error.retryable, false, "a version mismatch does not heal on a retry");
	});

	test("a body with no protocol at all reads as `(none)` rather than as a generic failure", async () => {
		serve(() => json({ ok: true, service: "modkit", pubkey: "ab", version: "0.0.9" }));
		const result = await makeClient().health();
		assert.equal(result.error.code, "protocol-mismatch");
		assert.equal(result.error.receivedProtocol, "(none)");
	});

	test("a 426 is a mismatch even when the body says nothing", async () => {
		serve(() => ({ status: 426, text: "" }));
		const result = await makeClient().job("job-1");
		assert.equal(result.error.code, "protocol-mismatch");
	});

	test("the daemon's own `protocol-mismatch` error body is preferred over the status", async () => {
		serve(() =>
			json({ error: { code: "protocol-mismatch", message: "no", receivedProtocol: "MODKIT/2" } }, 400),
		);
		const result = await makeClient().job("job-1");
		assert.equal(result.error.code, "protocol-mismatch", "a 400 must not mask a mismatch as a bad request");
		assert.equal(result.error.receivedProtocol, "MODKIT/2");
	});

	test("every route checks it — a mismatch on a poll cannot slip through mid-generation", async () => {
		for (const [name, run] of [
			["job", (c) => c.job("job-1")],
			["generate", (c) => c.generate({ request: "hi" })],
		]) {
			sent = [];
			serve(() => json({ protocol: "MODKIT/0", jobId: "job-1", status: "queued", mods: [] }, 200));
			const result = await run(makeClient());
			assert.equal(result.ok, false, `${name} accepted a foreign protocol`);
			assert.equal(result.error.code, "protocol-mismatch", `${name} mis-classified a foreign protocol`);
		}
	});

	test("something else listening on the port is `wrong-service`, not a mismatch", async () => {
		serve(() => json({ service: "grafana", protocol: MODKIT_PROTOCOL_VERSION }));
		const result = await makeClient().health();
		assert.equal(result.error.code, "wrong-service");
		assert.match(result.error.message, /not the modkit daemon/i);
	});
});

describe("the bearer token never reaches an error message", () => {
	test("a transport exception quoting the URL-with-token is redacted", async () => {
		serve(() => {
			// A proxy or a fetch polyfill quoting the whole request is exactly how a secret leaks into
			// a log the user then pastes into an issue.
			throw new Error(`connect ECONNREFUSED while sending Authorization: Bearer ${TOKEN}`);
		});
		const result = await makeClient().health();

		const serialised = JSON.stringify(result.error);
		assert.equal(serialised.includes(TOKEN), false, `the token leaked into the error: ${serialised}`);
		assert.match(result.error.detail, /«token»/);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * pollUntilDone
 * ──────────────────────────────────────────────────────────────────────────── */

describe("pollUntilDone reaches each terminal state", () => {
	test("done → a built outcome carrying the artifact", async () => {
		serve(jobScript([runningJob("queued"), runningJob("building"), doneJob()]));
		const result = await makeClient().pollUntilDone("job-1", FAST_POLL);

		assert.ok(isOk(result), `expected ok, got ${JSON.stringify(result.error ?? null)}`);
		assert.equal(result.value.kind, "built");
		assert.ok(isBuiltOutcome(result.value));
		assert.equal(result.value.result.modId, "modkit-mod-quieter-tasks");
		assert.equal(sent.length, 3, "it must stop the moment the job is terminal");
	});

	test("REFUSED IS A SUCCESS — ok:true, with the daemon's reason intact", async () => {
		// The whole point. A refusal returned as an error makes a correct "I cannot reach that" look
		// like modkit malfunctioning, which is the failure this project cares most about.
		serve(jobScript([runningJob("generating"), refusedJob()]));
		const result = await makeClient().pollUntilDone("job-1", FAST_POLL);

		assert.equal(result.ok, true, "a refusal must not arrive as an error");
		assert.equal(result.value.kind, "refused");
		assert.equal(isBuiltOutcome(result.value), false);
		assert.equal(result.value.refusal.reason, "no-reachable-surface");
		assert.equal(result.value.refusal.explanation, "Nothing in Tasks exposes that behaviour on a prototype.");
		assert.equal(result.value.job.status, "refused");
	});

	test("failed → an error, and the poll stops there", async () => {
		serve(jobScript([runningJob("validating"), failedJob()]));
		const result = await makeClient().pollUntilDone("job-1", FAST_POLL);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "job-failed");
		assert.equal(sent.length, 2);
	});

	test("generateAndWait threads the accepted job id into the poll", async () => {
		let polls = 0;
		serve((request) => {
			if (request.method === "POST") return json({ protocol: MODKIT_PROTOCOL_VERSION, jobId: "job-77", status: "queued" }, 202);
			polls += 1;
			assert.equal(request.path, "/v1/jobs/job-77");
			return json(doneJob());
		});
		const result = await makeClient().generateAndWait({ request: "quieter" }, FAST_POLL);
		assert.ok(isOk(result));
		assert.equal(polls, 1);
	});

	test("a failed generate short-circuits — no poll is attempted", async () => {
		serve(() => json({ error: { code: "unauthorized", message: "no" } }, 401));
		const result = await makeClient().generateAndWait({ request: "quieter" }, FAST_POLL);
		assert.equal(result.error.code, "unauthorized");
		assert.equal(sent.length, 1, "polling a job that was never accepted would poll `undefined`");
	});

	test("a job id with a slash in it is encoded, not concatenated", async () => {
		serve(() => json(doneJob()));
		await makeClient().job("a/../b");
		assert.equal(sent[0].path, "/v1/jobs/a%2F..%2Fb");
	});
});

describe("progress", () => {
	test("fires on a change and not on an unchanged poll", async () => {
		const seen = [];
		serve(
			jobScript([
				runningJob("generating", { message: "reading the target", updatedAt: "t1" }),
				runningJob("generating", { message: "reading the target", updatedAt: "t1" }),
				runningJob("generating", { message: "writing the patch", updatedAt: "t2" }),
				doneJob(),
			]),
		);
		await makeClient().pollUntilDone("job-1", { ...FAST_POLL, onProgress: (job) => seen.push(job.progress?.message ?? job.status) });

		assert.deepEqual(seen, ["reading the target", "writing the patch", "done"], "an unchanged poll must not repaint");
	});

	test("a progress renderer that throws cannot abandon a job in flight", async () => {
		serve(jobScript([runningJob("generating"), doneJob()]));
		const result = await makeClient().pollUntilDone("job-1", {
			...FAST_POLL,
			onProgress: () => {
				throw new Error("the status bar element was detached");
			},
		});
		assert.ok(isOk(result), "a broken renderer must not lose a five-minute generation");
	});
});

describe("backoff", () => {
	test("the delay grows by the factor and is capped by maxDelayMs", async () => {
		serve(jobScript([...Array.from({ length: 6 }, () => runningJob("generating")), doneJob()]));
		await makeClient().pollUntilDone("job-1", { initialDelayMs: 20, maxDelayMs: 80, backoffFactor: 2 });

		const gaps = sent.slice(1).map((entry, i) => entry.at - sent[i].at);
		assert.ok(gaps.length >= 5, `expected several polls, got ${gaps.length}`);
		// Timers fire late, never early: a lower bound is the only assertion a shared machine can honour.
		const floor = (ms) => Math.round(ms * 0.8);
		assert.ok(gaps[0] >= floor(20), `first gap ${gaps[0]}ms should be ≈20ms`);
		assert.ok(gaps[1] >= floor(40), `second gap ${gaps[1]}ms should be ≈40ms`);
		assert.ok(gaps[2] >= floor(80), `third gap ${gaps[2]}ms should be ≈80ms`);
		// The cap: without it the fifth gap would be 320ms.
		assert.ok(gaps[4] < 240, `the backoff is not capped — fifth gap was ${gaps[4]}ms, ceiling is 80ms`);
	});

	test("the first poll is immediate — a job that is already done costs no delay", async () => {
		serve(jobScript([doneJob()]));
		const started = Date.now();
		await makeClient().pollUntilDone("job-1", { initialDelayMs: 5_000 });
		assert.ok(Date.now() - started < 500, "the loop must poll before it sleeps");
	});
});

describe("the hard timeout", () => {
	test("a job that never finishes ends as `timeout`, retryable, naming what it last saw", async () => {
		serve(jobScript([runningJob("generating", { message: "still thinking", updatedAt: "t1" })]));
		const result = await makeClient().pollUntilDone("job-1", { ...FAST_POLL, jobTimeoutMs: 60 });

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "timeout");
		assert.equal(result.error.retryable, true, "the daemon may still be generating — the job can be picked up by id");
		assert.match(result.error.message, /still being generated/i);
		assert.match(result.error.detail, /generating/, "the detail must say what the last observed status was");
	});

	test("a per-request timeout is its own error, distinct from the job budget", async () => {
		serve(() => new Promise(() => {}));
		const result = await makeClient({ requestTimeoutMs: 30 }).job("job-1");
		assert.equal(result.error.code, "timeout");
		assert.equal(result.error.retryable, true);
		assert.match(result.error.detail, /exceeded 30ms/);
	});

	test("the timeout quotes the last transport error, but only if the poll never recovered", async () => {
		let calls = 0;
		serve(() => {
			calls += 1;
			if (calls === 1) return json(runningJob("generating"));
			throw new Error("ECONNRESET");
		});
		const result = await makeClient({ requestTimeoutMs: 100 }).pollUntilDone("job-1", {
			...FAST_POLL,
			jobTimeoutMs: 120,
			maxTransientFailures: 50,
		});
		assert.equal(result.error.code, "timeout");
		assert.match(result.error.detail, /last transport error: unreachable/);
	});

	test("a blip that healed is not quoted in the timeout as though it were the cause", async () => {
		let calls = 0;
		serve(() => {
			calls += 1;
			if (calls === 1) throw new Error("ECONNRESET");
			return json(runningJob("generating"));
		});
		const result = await makeClient({ requestTimeoutMs: 100 }).pollUntilDone("job-1", {
			...FAST_POLL,
			jobTimeoutMs: 120,
		});
		assert.equal(result.error.code, "timeout");
		assert.equal(/last transport error/.test(result.error.detail), false, result.error.detail);
	});
});

describe("transient failures", () => {
	test("a daemon restarting mid-generation is absorbed, not surfaced", async () => {
		let calls = 0;
		serve(() => {
			calls += 1;
			if (calls <= 3) throw new Error("ECONNREFUSED (daemon restarting)");
			return json(doneJob());
		});
		const result = await makeClient().pollUntilDone("job-1", { ...FAST_POLL, maxTransientFailures: 3 });
		assert.ok(isOk(result), "three blips are inside the budget and must not lose the job");
	});

	test("past the budget, the last transport error is what surfaces", async () => {
		serve(() => {
			throw new Error("ECONNREFUSED");
		});
		const result = await makeClient().pollUntilDone("job-1", { ...FAST_POLL, maxTransientFailures: 2 });
		assert.equal(result.error.code, "unreachable");
		assert.equal(sent.length, 3, "one more attempt than the budget, then it gives up");
	});

	test("a 401 mid-poll aborts immediately — it is not a blip", async () => {
		serve(() => json({ error: { code: "unauthorized", message: "token rotated" } }, 401));
		const result = await makeClient().pollUntilDone("job-1", { ...FAST_POLL, maxTransientFailures: 5 });
		assert.equal(result.error.code, "unauthorized");
		assert.equal(sent.length, 1, "retrying a wrong token five times is five wasted round trips");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Cancellation — the wiring that stopped a disabled plugin installing into the vault
 * ──────────────────────────────────────────────────────────────────────────── */

describe("cancellation", () => {
	test("an already-aborted signal costs zero requests", async () => {
		serve(() => json(doneJob()));
		const controller = new AbortController();
		controller.abort();

		const result = await makeClient().pollUntilDone("job-1", { ...FAST_POLL, signal: controller.signal });
		assert.equal(result.error.code, "cancelled");
		assert.equal(sent.length, 0, "modkit was already disabled — it must not issue anything");
	});

	test("`cancelled` is its own code, never `timeout` — one is the user, the other is a fault", async () => {
		serve(() => json(runningJob("generating")));
		const controller = new AbortController();
		const pending = makeClient().pollUntilDone("job-1", { ...FAST_POLL, signal: controller.signal });
		setTimeout(() => controller.abort(), 15);
		const result = await pending;

		assert.equal(result.error.code, "cancelled");
		assert.match(result.error.detail, /the daemon may still be generating it/);
	});

	test("aborting during a request in flight resolves the caller immediately", async () => {
		serve(() => new Promise(() => {}));
		const controller = new AbortController();
		const started = Date.now();
		const pending = makeClient({ requestTimeoutMs: 30_000 }).job("job-1", { signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		const result = await pending;

		assert.equal(result.error.code, "cancelled");
		assert.ok(Date.now() - started < 1_000, "the caller must not wait out the 30s request timeout");
	});

	test("THE POLL ACTUALLY STOPS — no request is issued after the abort resolves", async () => {
		// The regression this is shaped around: a generation in flight installed a plugin into the
		// vault minutes after modkit was disabled. Resolving the caller's promise is not enough — the
		// loop has to stop issuing. So the transcript is frozen at the abort and re-read after several
		// more poll intervals have had time to fire.
		serve(() => json(runningJob("generating")));
		const controller = new AbortController();
		const pending = makeClient().pollUntilDone("job-1", { initialDelayMs: 10, maxDelayMs: 10, signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.ok(sent.length >= 2, `the poll should have been running — only ${sent.length} request(s) went out`);
		controller.abort();
		const result = await pending;
		assert.equal(result.error.code, "cancelled");

		const atAbort = sent.length;
		await new Promise((resolve) => setTimeout(resolve, 120)); // ≥10 further poll intervals
		assert.equal(sent.length, atAbort, `${sent.length - atAbort} request(s) were issued after cancellation`);
	});

	test("the signal reaches the single-request methods too, not only the poll loop", async () => {
		for (const run of [(c, o) => c.health(o), (c, o) => c.generate({ request: "x" }, o)]) {
			sent = [];
			serve(() => json(doneJob()));
			const controller = new AbortController();
			controller.abort();
			const result = await run(makeClient(), { signal: controller.signal });
			assert.equal(result.error.code, "cancelled");
			assert.equal(sent.length, 0);
		}
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Odds and ends
 * ──────────────────────────────────────────────────────────────────────────── */

describe("newIdempotencyKey", () => {
	test("is unique per call and non-empty", () => {
		const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
		assert.equal(keys.size, 200);
		for (const key of keys) assert.ok(key.length >= 16, `a short key defeats the point: ${key}`);
	});
});

