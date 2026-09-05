/**
 * `scripts/setup.mjs`'s `--host`/`--tailnet` derivation (L5) — pure, so it is unit-tested here
 * rather than proven by an actual `npm run setup` run, which the brief for this change explicitly
 * says not to do (it starts a real daemon and writes real vault files).
 *
 * `setup.mjs` is a script, not a library: importing it used to run the whole flow at module load,
 * via a bare `await main()` with no guard. It now checks `import.meta.url` against `process.argv[1]`
 * first, so importing it here — as this file does — loads the module (registering nothing, since
 * every export below is a plain function declaration) without touching a vault, a daemon, or the
 * network. If that guard is ever removed, this file starts a real setup on every `node --test` run
 * of it, which is the tell to watch for.
 *
 * Wired into the root `npm test` via the `test:scripts` script (`scripts/` is not an npm workspace,
 * so `npm run test --workspaces` alone never reaches this file — `test` chains `test:scripts`
 * after it). Also runnable directly:
 *   node --test scripts/setup.test.mjs
 *
 * The derivation tests below spawn nothing and stay hermetic, as before. The `--help`/unknown-flag
 * describe block at the bottom is the one exception: it spawns the real script as a subprocess,
 * because that is the only way to exercise `main()`'s own argv handling rather than the pure
 * helpers it calls — `--help` and an unrecognized flag both return before touching a vault, a
 * daemon, or the network, so each spawn is still fast (well under a second) and still hermetic.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { SetupError, chooseExplicitBaseUrl, confirmDaemonUp, daemonLogFailure, resolveHostFlag } from "./setup.mjs";

const SETUP_MJS = fileURLToPath(new URL("./setup.mjs", import.meta.url));

describe("resolveHostFlag", () => {
	test("neither flag → null, meaning “behave as before this flag existed”", () => {
		assert.equal(resolveHostFlag({ host: undefined, tailnet: false }), null);
	});

	test("--host <addr> → that address, verbatim", () => {
		assert.equal(resolveHostFlag({ host: "100.64.1.2", tailnet: false }), "100.64.1.2");
	});

	test("--tailnet → whatever the injected resolver returns", () => {
		const resolved = resolveHostFlag({ host: undefined, tailnet: true }, () => "100.64.1.2");
		assert.equal(resolved, "100.64.1.2");
	});

	test("--tailnet never calls the real resolver when a fake is supplied", () => {
		let calls = 0;
		resolveHostFlag({ host: undefined, tailnet: true }, () => {
			calls += 1;
			return "100.64.1.2";
		});
		assert.equal(calls, 1);
	});

	test("--tailnet propagates the resolver's own SetupError (tailscale absent) rather than swallowing it", () => {
		const fail = () => {
			throw new SetupError("--tailnet was passed but the `tailscale` command was not found.", "some hint");
		};
		assert.throws(() => resolveHostFlag({ host: undefined, tailnet: true }, fail), SetupError);
	});

	test("--host and --tailnet together is refused, before either takes effect", () => {
		let calls = 0;
		assert.throws(
			() => resolveHostFlag({ host: "1.2.3.4", tailnet: true }, () => {
				calls += 1;
				return "100.64.1.2";
			}),
			SetupError,
		);
		assert.equal(calls, 0, "the mutual-exclusion check must fire before the tailnet resolver runs");
	});
});

describe("chooseExplicitBaseUrl", () => {
	test("no flags at all → undefined, so the existing anti-stomp rule (overwriteBaseUrl: false) is untouched", () => {
		const url = chooseExplicitBaseUrl({ baseUrlFlag: undefined, resolvedHost: null, stateBaseUrl: "http://127.0.0.1:8501" });
		assert.equal(url, undefined);
	});

	test("--tailnet (no --base-url) → the daemon's own resolved baseUrl, explicitly", () => {
		// This is the acceptance bar verbatim: "the sidecar written with --tailnet has the tailnet
		// baseUrl." `stateBaseUrl` here is exactly what `ensureDaemonState` would report once
		// MODKIT_HOST carries the resolved tailnet address — see setup.mjs's own use of this function.
		const url = chooseExplicitBaseUrl({ baseUrlFlag: undefined, resolvedHost: "100.64.1.2", stateBaseUrl: "http://100.64.1.2:8501" });
		assert.equal(url, "http://100.64.1.2:8501");
	});

	test("--base-url always wins, even over --host/--tailnet", () => {
		const url = chooseExplicitBaseUrl({
			baseUrlFlag: "http://elsewhere.example:9000",
			resolvedHost: "100.64.1.2",
			stateBaseUrl: "http://100.64.1.2:8501",
		});
		assert.equal(url, "http://elsewhere.example:9000");
	});

	test("--host/--tailnet is explicit even when it happens to equal the default loopback URL", () => {
		// An edge case worth pinning: `--host 127.0.0.1` is a no-op in effect, but it is still a
		// flag the user typed, and chooseExplicitBaseUrl must not special-case its value.
		const url = chooseExplicitBaseUrl({ baseUrlFlag: undefined, resolvedHost: "127.0.0.1", stateBaseUrl: "http://127.0.0.1:8501" });
		assert.equal(url, "http://127.0.0.1:8501");
	});
});

describe("main()'s argv handling — spawned, since this is what a real invocation sees", () => {
	test("--help prints usage (documenting --host/--tailnet) and does nothing else", () => {
		const run = spawnSync(process.execPath, [SETUP_MJS, "--help"], { encoding: "utf8", timeout: 10_000 });
		assert.equal(run.status, 0);
		assert.match(run.stdout, /--host <addr>/);
		assert.match(run.stdout, /--tailnet/);
		// The tell that it did NOT fall through into a real setup: none of the step-numbered output
		// (`" 1. vault: …"` etc.) a real run always prints first.
		assert.doesNotMatch(run.stdout, /vault:/);
	});

	test("an unrecognized flag exits non-zero and points at --help, rather than running a real setup", () => {
		const run = spawnSync(process.execPath, [SETUP_MJS, "--not-a-real-flag"], { encoding: "utf8", timeout: 10_000 });
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /--not-a-real-flag/);
		assert.match(run.stderr, /--help/);
		assert.doesNotMatch(run.stdout, /vault:/);
	});

	test("--host with no value refuses rather than silently binding no host at all", () => {
		// `--status` short-circuits before the build/install steps, so this reaches the guard without
		// needing a real vault — the failure this pins is in argv parsing, before any of that.
		const run = spawnSync(process.execPath, [SETUP_MJS, "--status", "--host"], { encoding: "utf8", timeout: 10_000 });
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /--host requires an address/);
	});
});

/**
 * Measured 2026-09-05, running setup from a clean clone the way a new user would: another process
 * held the port, the daemon died of EADDRINUSE within milliseconds, and setup printed
 * `✓ daemon running as pid 95166`. The only real symptom appeared two steps later as an
 * unexplained 404 — from the *other* process's service, which is worse than no message.
 *
 * A spawned pid is not a running daemon.
 */
describe("confirmDaemonUp — a spawned pid is not evidence", () => {
	const holdsIt = (pid) => () => [{ pid, command: "node" }];
	const heldByOther = () => [{ pid: 15338, command: "node" }];

	test("up once OUR pid is the one holding the port", async () => {
		let calls = 0;
		const result = await confirmDaemonUp({
			status: () => ({ running: true, pid: 42 }),
			portHolders: () => (++calls < 3 ? [] : [{ pid: 42, command: "node" }]),
			port: 8501,
			sleep: () => Promise.resolve(),
		});
		assert.equal(result.running, true);
		assert.equal(result.pid, 42);
	});

	/**
	 * The regression. A process that cannot bind is still ALIVE for the few milliseconds between
	 * spawn and EADDRINUSE, so the first version of this function — which polled liveness alone —
	 * returned true and printed the same false ✓ it was written to remove.
	 */
	test("a live pid that never binds is NOT up, however alive it is", async () => {
		let clock = 0;
		const result = await confirmDaemonUp({
			status: () => ({ running: true, pid: 16727 }),
			portHolders: heldByOther,
			port: 8599,
			deadlineMs: 500,
			now: () => clock,
			sleep: () => {
				clock += 100;
				return Promise.resolve();
			},
		});
		assert.equal(result.running, false, "alive is not serving");
		assert.match(result.reason, /never bound port 8599/);
	});

	test("a pid that died outright reports the pidfile probe's own reason", async () => {
		let clock = 0;
		const result = await confirmDaemonUp({
			status: () => ({ running: false, pid: 95166, reason: "pid is gone" }),
			portHolders: () => [],
			port: 8599,
			deadlineMs: 300,
			now: () => clock,
			sleep: () => {
				clock += 100;
				return Promise.resolve();
			},
		});
		assert.equal(result.running, false);
		assert.equal(result.reason, "pid is gone");
	});

	test("a daemon already serving costs no waiting at all", async () => {
		let slept = 0;
		const result = await confirmDaemonUp({
			status: () => ({ running: true, pid: 7 }),
			portHolders: holdsIt(7),
			port: 8501,
			sleep: () => {
				slept += 1;
				return Promise.resolve();
			},
		});
		assert.equal(result.running, true);
		assert.equal(slept, 0);
	});
});

describe("daemonLogFailure — turn the log's last error into something to do", () => {
	// The exact shape the daemon writes; `code` is top-level, beside a nested `err`.
	const EADDRINUSE = JSON.stringify({
		ts: "2026-09-05T20:07:01.114Z",
		level: "error",
		msg: "could not bind",
		host: "127.0.0.1",
		port: 8599,
		code: "EADDRINUSE",
		err: { message: "listen EADDRINUSE: address already in use 127.0.0.1:8599" },
	});

	test("names the port and what to do about it", () => {
		const hint = daemonLogFailure(`{"level":"info","msg":"starting"}\n${EADDRINUSE}`);
		assert.match(hint, /port 8599 is already held/);
		assert.match(hint, /MODKIT_PORT/, "the hint has to carry the way out, not just the diagnosis");
	});

	// The real log's last error line is "modkit daemon failed to start": it carries the message but
	// NOT the structured `port` that the "could not bind" line above it has. Measured 2026-09-05,
	// where this printed the literal "port that port is already held".
	test("reads the port out of the message when the entry has no port field", () => {
		const failedToStart = JSON.stringify({
			level: "error",
			msg: "modkit daemon failed to start",
			err: { message: "listen EADDRINUSE: address already in use 127.0.0.1:8599" },
		});
		const hint = daemonLogFailure(failedToStart);
		assert.match(hint, /port 8599 is already held/);
		assert.doesNotMatch(hint, /that port/);
	});

	test("reads the LAST error, not the first line that happens to parse", () => {
		const earlier = JSON.stringify({ level: "error", msg: "something older" });
		assert.match(daemonLogFailure(`${earlier}\n${EADDRINUSE}`), /port 8599/);
	});

	test("falls back to the error's own message when it is not a port clash", () => {
		const other = JSON.stringify({ level: "error", msg: "boom", err: { message: "keys are unreadable" } });
		assert.equal(daemonLogFailure(other), "keys are unreadable");
	});

	test("says nothing rather than guessing: no log, no errors, or junk", () => {
		assert.equal(daemonLogFailure(""), null);
		assert.equal(daemonLogFailure(null), null);
		assert.equal(daemonLogFailure('{"level":"info","msg":"all fine"}'), null);
		assert.equal(daemonLogFailure("not json at all\nstill not json"), null);
	});
});
