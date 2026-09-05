/**
 * A **real** modkit daemon, on a real socket, for the end-to-end test.
 *
 * `helpers/daemon.mjs` gives the roundtrip tests a real keyring and a real `signArtifact`. This
 * goes one layer out: it stands up the daemon's own `createApp()` HTTP server — the same routing,
 * the same bearer-token check, the same `JobQueue` with its idempotency, staging and persistence —
 * on an ephemeral port, and bridges Obsidian's `requestUrl` to it over the loopback interface.
 *
 * ## What is real here and what is not
 *
 * Real: the HTTP server and its routes, the auth check, the job queue and its lifecycle, the
 * keyring (root key, subkey, delegation cert), `signArtifact`, the on-disk job and mod records.
 *
 * Not real: the **model**. `Pipeline` is injected, so the test supplies the draft the generator
 * would have produced. That is the honest boundary — everything downstream of the model's output
 * is exercised for real, and the model itself cannot be part of a deterministic test.
 *
 * The bridge is deliberately a real `fetch` over a real socket rather than an in-process call:
 * the plugin's client builds URLs, sets headers, encodes bodies and reads statuses, and a bridge
 * that short-circuited any of that would be testing the harness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setRequestUrlHandler } from "../stub/obsidian.mjs";

const DAEMON_DIST = new URL("../../../packages/modkit-daemon/dist/", import.meta.url);

const { createApp, JobQueue } = await import(new URL("index.js", DAEMON_DIST).href);
const { loadKeyring, signArtifact } = await import(new URL("sign.js", DAEMON_DIST).href);
const { ensureState } = await import(new URL("state.js", DAEMON_DIST).href);
const { silentLogger } = await import(new URL("log.js", DAEMON_DIST).href);

/**
 * The daemon's two real generation-time gates, re-exported so the end-to-end pipeline can run them
 * rather than pretending to. Only the *model* is stubbed in that test; everything it emits goes
 * through the validator and through esbuild exactly as it would in production.
 */
export const { validateSource } = await import(new URL("validate.js", DAEMON_DIST).href);
export const { buildPatchPlugin, stopBuilder } = await import(new URL("build.js", DAEMON_DIST).href);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Mint an independent keyring in its own throwaway state tree.
 *
 * Used to build the one artifact the pinned key exists to reject: correctly signed, by the wrong
 * key. Returns `{ keyring, cleanup }`; the caller owns the cleanup.
 */
export function mintKeyring() {
	const root = mkdtempSync(join(tmpdir(), "modkit-e2e-keys-"));
	const layout = ensureState(root);
	const keyring = loadKeyring(layout, silentLogger(), { certTtlMs: 7 * DAY, certRenewBeforeMs: HOUR });
	return {
		keyring,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Start a daemon.
 *
 * @param {(input: unknown, ctx: unknown) => Promise<unknown>} pipeline
 *   The generator stand-in. Returns `{kind:"built", draft}` or a `GenerateRefusal`.
 * @param {{ token?: string, model?: string, version?: string, signKeyring?: unknown }} [options]
 *   `signKeyring` signs artifacts with a keyring **other** than the one this daemon advertises on
 *   `/v1/health` and checks `pinnedRootPubkey` against. That is not a configuration anyone would
 *   run; it is the only way to hand the plugin an artifact its pinned key must reject, which is
 *   the thing the pinned key exists for.
 */
export async function startDaemon(pipeline, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "modkit-e2e-daemon-"));
	const layout = ensureState(root);
	const log = silentLogger();
	const keyring = loadKeyring(layout, log, { certTtlMs: 7 * DAY, certRenewBeforeMs: HOUR });
	const token = options.token ?? "e2e-bearer-token-not-a-real-secret";

	/** Every pipeline invocation, so a test can assert the daemon actually ran one. */
	const runs = [];

	const config = {
		host: "127.0.0.1",
		port: 0,
		stateDir: root,
		concurrency: 1,
		model: options.model ?? "e2e-stub-model",
		jobRetention: 50,
		maxBodyBytes: 2 * 1024 * 1024,
		artifactTtlMs: HOUR,
		certTtlMs: 7 * DAY,
		certRenewBeforeMs: HOUR,
		logLevel: "error",
		version: options.version ?? "0.1.0",
	};

	const jobs = new JobQueue({
		layout,
		log,
		pipeline: async (input, ctx) => {
			runs.push(input);
			return pipeline(input, ctx);
		},
		sign: (draft) =>
			signArtifact(draft, {
				keyring: options.signKeyring ?? keyring,
				daemonVersion: config.version,
				artifactTtlMs: config.artifactTtlMs,
			}),
		concurrency: config.concurrency,
		retention: config.jobRetention,
	});

	const server = createApp({ config, layout, log, token, keyring, jobs, startedAt: Date.now() });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	const baseUrl = `http://127.0.0.1:${port}`;

	/** Every request that crossed the socket, from the harness's side of it. */
	const wire = [];

	/**
	 * Point Obsidian's `requestUrl` at the live server.
	 *
	 * `throw: false` is what the client passes, and Obsidian's `requestUrl` rejects only for a
	 * transport failure — never for an HTTP status. This mirrors that: a connection refusal throws,
	 * a 401 comes back as `{status: 401, text}`.
	 */
	function bridge() {
		setRequestUrlHandler(async (param) => {
			const method = param.method ?? "GET";
			const started = Date.now();
			// `requestUrl` takes the body's media type in `contentType`, not in `headers` — the
			// client sets it that way, so a bridge that ignored it would send an untyped body.
			const headers = { ...(param.headers ?? {}) };
			if (param.contentType !== undefined) headers["Content-Type"] = param.contentType;
			const res = await fetch(param.url, {
				method,
				headers,
				...(param.body === undefined ? {} : { body: param.body }),
			});
			const text = await res.text();
			wire.push({
				method,
				path: new URL(param.url).pathname,
				status: res.status,
				ms: Date.now() - started,
				authorization: (param.headers ?? {})["Authorization"] ?? null,
			});
			return { status: res.status, text, headers: Object.fromEntries(res.headers.entries()) };
		});
	}

	bridge();

	return {
		baseUrl,
		token,
		rootPubkeyHex: keyring.rootPubkeyHex,
		keyring,
		layout,
		jobs,
		runs,
		wire,
		bridge,
		async stop() {
			jobs.close?.();
			await new Promise((resolve) => server.close(resolve));
			rmSync(root, { recursive: true, force: true });
		},
	};
}
