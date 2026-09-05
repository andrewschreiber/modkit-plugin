/**
 * `src/host/supervisor.ts` — the component that keeps a mod alive across its *target* being
 * reloaded, notifying its owner through a constructor-injected `onEvent` callback.
 *
 * ## What this suite proves, and what it does NOT
 *
 * Read this before quoting a green run from here.
 *
 * The supervisor's premise is stated in its own header: re-enabling a plugin makes Obsidian
 * re-evaluate its `main.js`, producing **a fresh class object with a fresh prototype**, so every mod
 * sitting on the old prototype is patching a corpse — silently inert while still reporting itself as
 * enabled. **That premise is unverified against the real host, and nothing here verifies it.** The
 * stub is *made* to behave that way (`createApp({ freshClassPerLoad: true })` mints a new class per
 * load; see `stub/app.mjs`). So every assertion below is of the form *"given a host that replaces
 * the class object on reload, the supervisor notices and re-applies"* — the implication, not the
 * antecedent. If Obsidian turned out to reuse the class object, these tests would keep passing and
 * the component would be unnecessary. Measuring the antecedent needs a real Obsidian, not a stub.
 *
 * Two further limits, in the same spirit:
 *
 * - **No mod code ever runs.** `stub/app.mjs` says a "loaded plugin" is a placeholder object; a
 *   reload here is bookkeeping plus a fresh constructor, not an evaluated `main.js`. "The patches
 *   were re-applied" is therefore `reloadPlugin` returning true, not an observation of a live patch.
 * - **The polling fallback is exercised through a contrivance.** See the `describe` block for why it
 *   is otherwise unreachable — that is itself a finding, and it is written down there rather than
 *   papered over.
 *
 * ## What it does test honestly
 *
 * Hook install and *complete* removal (by property descriptor, not by behaviour), identity-change
 * detection and the reload it triggers, the events it emits through `onEvent`, and the "never throw
 * into Obsidian" rule — every entry point is called with garbage and with a host that throws.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { Notice } from "./stub/obsidian.mjs";
import { createApp, manifestFor, tick } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";
import { compileSurface } from "./stub/compile.mjs";

const { Supervisor, Host, checkDomReach, checkDomReachWithRetry } = await compileSurface(
	"supervisor-surface",
	`
	export { Supervisor, checkDomReach, checkDomReachWithRetry } from "../../src/host/supervisor";
	export { Host } from "../../src/host/host";
	`,
);

assert.equal(typeof Supervisor, "function", "the supervisor bundle has no Supervisor — did an export get renamed?");
assert.equal(typeof Host, "function", "the supervisor bundle has no Host — did an export get renamed?");
assert.equal(typeof checkDomReach, "function", "the supervisor bundle has no checkDomReach — did an export get renamed?");
assert.equal(
	typeof checkDomReachWithRetry,
	"function",
	"the supervisor bundle has no checkDomReachWithRetry — did an export get renamed?",
);

const TARGET = "obsidian-tasks-plugin";
const MOD = "modkit-mod-quieter-tasks";

let dom;
let errors;
let restoreConsole;

/**
 * The supervisor reports failures through `console.error` by design ("never throw"). Capturing them
 * keeps the run readable *and* makes "it swallowed it" an assertable fact rather than an absence.
 */
function captureConsoleErrors() {
	const original = console.error;
	const captured = [];
	console.error = (...args) => captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
	return { captured, restore: () => (console.error = original) };
}

beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
	const capture = captureConsoleErrors();
	errors = capture.captured;
	restoreConsole = capture.restore;
});

afterEach(() => {
	restoreConsole();
	dom.restore();
});

/** An app whose plugin loads mint a fresh class object, plus helpers to place plugins on disk. */
async function makeApp(options = {}) {
	const app = createApp({ freshClassPerLoad: true, ...options });
	app.place = async (id, { enabled = true, loaded = true, code = true } = {}) => {
		app.plugins.install(manifestFor(id), { enabled, loaded });
		if (!code) return;
		const dir = `${app.vault.configDir}/plugins/${id}`;
		app.vault.adapter.mkdirp(dir);
		await app.vault.adapter.write(`${dir}/main.js`, "module.exports = class {};\n");
	};
	return app;
}

/**
 * Captures what the supervisor tells its `onEvent` callback, in a shape the tests can query like
 * the old in-memory health store: `forMod`/`last` filter by mod id, newest last.
 */
function makeEvents() {
	const log = [];
	return {
		log,
		onEvent: (modId, event, detail) => log.push({ modId, event, detail }),
		forMod: (modId) => log.filter((e) => e.modId === modId),
		last: (modId) => log.filter((e) => e.modId === modId).at(-1) ?? null,
	};
}

function start(app, options = {}) {
	const host = new Host(app);
	const supervisor = new Supervisor(host, options);
	supervisor.load();
	return { host, supervisor };
}

/** Let the supervisor's serialising queue drain. */
async function settle() {
	await tick(10);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Hooks
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the around() hooks install and come back off", () => {
	test("a healthy host is hooked, not polled", async () => {
		const app = await makeApp();
		const { supervisor } = start(app);
		assert.equal(supervisor.mode, "hooked");
		assert.deepEqual(dom.window.pendingIntervals(), [], "a hooked supervisor must not also poll");
		supervisor.unload();
	});

	test("unload removes both wrappers — asserted on the property, not on behaviour", async () => {
		// Behaviour is the weaker test: a wrapper that delegates correctly looks identical to no
		// wrapper. The own property is what an uninstalled modkit must not leave on the host object.
		const app = await makeApp();
		const pm = app.plugins;
		const prototypeEnable = Object.getPrototypeOf(pm).enablePlugin;
		const prototypeDisable = Object.getPrototypeOf(pm).disablePlugin;

		assert.equal(Object.hasOwn(pm, "enablePlugin"), false, "nothing should be wrapped yet");

		const { supervisor } = start(app);
		assert.equal(Object.hasOwn(pm, "enablePlugin"), true, "the hook did not install — the rest of this file proves nothing");
		assert.equal(Object.hasOwn(pm, "disablePlugin"), true);
		assert.notEqual(pm.enablePlugin, prototypeEnable);

		supervisor.unload();

		assert.equal(Object.hasOwn(pm, "enablePlugin"), false, "an enablePlugin wrapper survived unload");
		assert.equal(Object.hasOwn(pm, "disablePlugin"), false, "a disablePlugin wrapper survived unload");
		assert.equal(pm.enablePlugin, prototypeEnable, "the host must be left exactly as it was found");
		assert.equal(pm.disablePlugin, prototypeDisable);
	});

	test("the host's own return value passes through the wrapper untouched", async () => {
		const app = await makeApp();
		app.plugins.enablePlugin = async (id) => `enabled:${id}`;
		app.plugins.disablePlugin = async (id) => `disabled:${id}`;
		const { supervisor } = start(app);

		assert.equal(await app.plugins.enablePlugin("x"), "enabled:x");
		assert.equal(await app.plugins.disablePlugin("x"), "disabled:x");
		supervisor.unload();
	});

	test("a degraded host is `unavailable` — neither hooked nor polling", async () => {
		const { supervisor } = start(createApp({ plugins: false }));
		assert.equal(supervisor.mode, "unavailable");
		assert.deepEqual(dom.window.pendingIntervals(), []);
		// Tracking still works, so the mod list can show what modkit *would* be supervising.
		supervisor.track(MOD, TARGET);
		assert.deepEqual(supervisor.tracked(), [{ modId: MOD, targetPluginId: TARGET }]);
		supervisor.unload();
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Identity change — the whole reason the component exists
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a target constructor identity change is detected and the mod reloads", () => {
	test("disable+enable of the target re-applies the mod onto the new class", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const events = makeEvents();
		const { host, supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		const before = host.getPluginConstructor(TARGET);
		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		const after = host.getPluginConstructor(TARGET);
		// Establish the antecedent explicitly: without this the rest of the test is vacuous.
		assert.notEqual(before, after, "the stub did not replace the class object — see freshClassPerLoad");

		await settle();

		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["target-reloaded", "reapplied"]);
		assert.match(events.forMod(MOD)[0].detail, /dead prototype/);
		const ops = app.plugins.calls.map((c) => `${c.op}:${c.id}`);
		assert.deepEqual(
			ops.slice(-2),
			[`disablePlugin:${MOD}`, `enablePlugin:${MOD}`],
			"the mod itself must have been cycled — a health event alone is not a reload",
		);
		supervisor.unload();
	});

	test("several mods on one target all move together", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place("modkit-mod-a");
		await app.place("modkit-mod-b");
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track("modkit-mod-a", TARGET);
		supervisor.track("modkit-mod-b", TARGET);

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		await settle();

		for (const id of ["modkit-mod-a", "modkit-mod-b"]) {
			assert.deepEqual(events.forMod(id).map((e) => e.event), ["target-reloaded", "reapplied"], id);
		}
		supervisor.unload();
	});

	test("modkit's own reload of a mod is not mistaken for a target event", async () => {
		// Without the `snapshots.has(id)` guard in `onPluginToggled`, the enable that ends a reapply
		// would schedule another check, which would reapply again — a loop driven by its own output.
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		await settle();
		await settle();

		const reapplies = events.forMod(MOD).filter((e) => e.event === "reapplied").length;
		assert.equal(reapplies, 1, `the reapply looped: ${events.forMod(MOD).length} events`);
		supervisor.unload();
	});

	test("a target that is merely disabled is left alone, and a later re-enable still counts", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		await app.plugins.disablePlugin(TARGET);
		await settle();
		assert.deepEqual(events.forMod(MOD), [], "there is nothing to re-patch while the target is gone");

		await app.plugins.enablePlugin(TARGET);
		await settle();
		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["target-reloaded", "reapplied"]);
		supervisor.unload();
	});

	test("a target that was never loaded, then appears, reads as a change", async () => {
		const app = await makeApp();
		await app.place(TARGET, { enabled: false, loaded: false });
		await app.place(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET); // snapshot.ref is null — the target is not running

		await app.plugins.enablePlugin(TARGET);
		await settle();
		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["target-reloaded", "reapplied"]);
		supervisor.unload();
	});

	test("an unchanged target produces no events at all", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		supervisor.checkNow("manual");
		await settle();
		supervisor.checkNow("manual");
		await settle();

		assert.deepEqual(events.forMod(MOD), [], "a check that finds nothing must say nothing");
		supervisor.unload();
	});

	test("a mod that is no longer installed is untracked and reported `removed`", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET); // never installed — no manifest

		supervisor.checkNow("manual");
		await settle();

		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["removed"]);
		assert.deepEqual(supervisor.tracked(), []);
		supervisor.unload();
	});

	test("a mod the user disabled reports `reload-failed` and does NOT raise a notice", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD, { enabled: false, loaded: false });
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		await settle();

		const last = events.last(MOD);
		assert.equal(last.event, "reload-failed");
		assert.match(last.detail, /switched off/);
		assert.deepEqual(Notice.messages(), [], "the user turned this mod off; that is not a fault to shout about");
		supervisor.unload();
	});

	test("a mod that cannot be brought back says `inert` out loud", async () => {
		// The silent-inert-mod is the failure the whole component exists to prevent, so it is the one
		// case that interrupts the user.
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		app.plugins.refuseEnable.add(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		await settle();

		assert.equal(events.last(MOD).event, "reload-failed");
		assert.equal(Notice.messages().length, 1);
		assert.match(Notice.messages()[0], /has stopped doing anything/);
		assert.match(Notice.messages()[0], new RegExp(TARGET));
		supervisor.unload();
	});

	test("after unload, nothing is checked and nothing is reported", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);
		supervisor.unload();

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		supervisor.checkNow("after-unload");
		await settle();

		assert.deepEqual(events.forMod(MOD), []);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The polling fallback
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the polling fallback", () => {
	/**
	 * Reaching this path at all takes a contrivance, and that is worth stating.
	 *
	 * `onload` only considers polling when `host.available` is true, and `installHooks` only returns
	 * false when the plugin manager is missing or `enablePlugin`/`disablePlugin` are not functions —
	 * which are exactly the conditions `probeHost` classifies as **fatal**, making `host.available`
	 * false. So the two branches are mutually exclusive on every host shape except one: `around()`
	 * itself throwing. That is what is simulated here, by making `disablePlugin` a non-writable own
	 * property (monkey-around assigns `obj[method] = wrapper`, which throws in strict mode).
	 *
	 * Obsidian does not ship such a property. The realistic route to this branch is a *foreign*
	 * plugin having frozen or redefined the plugin manager first.
	 */
	function breakAround(app) {
		const pm = app.plugins;
		Object.defineProperty(pm, "disablePlugin", {
			value: Object.getPrototypeOf(pm).disablePlugin.bind(pm),
			writable: false,
			configurable: false,
		});
		return pm;
	}

	test("activates when the hooks cannot be installed, and says so via onEvent", async () => {
		const app = await makeApp();
		breakAround(app);
		const events = makeEvents();
		const { supervisor } = start(app, { onEvent: events.onEvent });

		assert.equal(supervisor.mode, "polling");
		const health = events.last("modkit");
		assert.equal(health.event, "supervisor-error");
		assert.match(health.detail, /falling back to polling/);
		assert.match(health.detail, /enablePlugin\/disablePlugin/, "the detail must name what could not be wrapped");
		assert.equal(dom.window.pendingIntervals().length, 1, "the fallback is a registered interval");

		supervisor.unload();
		assert.equal(dom.window.pendingIntervals().length, 0, "the poll interval survived unload");
	});

	test("detection still works in polling mode when a check is run", async () => {
		// The interval itself is 5s — too slow to wait for. `checkNow` runs the same `runCheck` the
		// interval schedules, so this tests the detection, not the timer.
		//
		// The class object is swapped directly rather than through `enablePlugin`, because in this
		// mode `enablePlugin` is *still wrapped* — see the partly-installed-hook-set test below — and going through it
		// would quietly measure the leaked hook instead of the poll.
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		breakAround(app);
		const events = makeEvents();
		const { host, supervisor } = start(app, { onEvent: events.onEvent });
		supervisor.track(MOD, TARGET);

		const before = host.getPluginConstructor(TARGET);
		app.plugins.plugins[TARGET] = app.plugins.instantiate(app.plugins.manifests[TARGET]);
		assert.notEqual(host.getPluginConstructor(TARGET), before, "the target's class object did not change");
		await settle();
		assert.equal(events.forMod(MOD).length, 0, "a bare object swap fires no hook — only a poll can see it");

		supervisor.checkNow("poll");
		await settle();
		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["target-reloaded", "reapplied"]);
		supervisor.unload();
	});

	test("a partly-installed hook set is still removed on unload", async () => {
		// WAS RED, FIXED 2026-08-31 in supervisor.ts (`installHooks`); kept as the regression test.
		//
		// The defect: `installHooks` passed both factories to one `around()` call inside one
		// try/catch and kept the remover only on success. `around` wraps `enablePlugin` first; when
		// the `disablePlugin` wrap then threw, the enablePlugin wrapper was already on the host object
		// and its remover had been discarded with the exception. Nothing ever took it off — not
		// `unload`, not uninstalling modkit — and the wrapper closed over the dead `Supervisor`. That
		// is precisely the failure class this project says must be zero: a permanent patch on a host
		// object left behind by a component that reported itself as cleanly unloaded.
		//
		// The fix is one `around()` + `this.register()` per method, so a failure on the second leaves
		// the first registered and reversible. The mode assertion below still expects `polling`: the
		// hook set is incomplete, and an incomplete set must not be reported as hooked.
		const app = await makeApp();
		const pm = breakAround(app);
		const prototypeEnable = Object.getPrototypeOf(pm).enablePlugin;

		const { supervisor } = start(app);
		assert.equal(supervisor.mode, "polling");
		assert.equal(Object.hasOwn(pm, "enablePlugin"), true, "around() did wrap the first method before it threw");

		supervisor.unload();

		assert.equal(
			Object.hasOwn(pm, "enablePlugin"),
			false,
			"an enablePlugin wrapper is left on app.plugins forever, holding the unloaded Supervisor",
		);
		assert.equal(pm.enablePlugin, prototypeEnable);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Never throw into Obsidian
 * ──────────────────────────────────────────────────────────────────────────── */

describe("nothing here can throw into the host", () => {
	test("an onEvent callback that throws is contained, and the supervisor keeps working", () => {
		// A throw here comes from whoever constructed the supervisor (main.ts's own callback), not
		// from generated code — but the "never throw into the host" rule is unconditional, so a
		// misbehaving callback must not escape either.
		const events = makeEvents();
		let host;
		const supervisor = new Supervisor((host = new Host(createApp())), {
			onEvent: (modId, event, detail) => {
				events.onEvent(modId, event, detail);
				throw new Error("the settings tab was already closed");
			},
		});
		supervisor.load();

		host.getPluginConstructor = () => {
			throw new Error("app.plugins moved");
		};
		// track()'s own catch is what emits an event here; the assertion is that emitting it through
		// a throwing callback does not propagate back into caller code.
		assert.doesNotThrow(() => supervisor.track(MOD, TARGET));
		assert.equal(events.last(MOD).event, "supervisor-error");
		assert.ok(errors.some((line) => /onEvent callback threw/.test(line)));
		supervisor.unload();
	});

	test("track() reports rather than throws when the host misbehaves", () => {
		const app = createApp();
		const host = new Host(app);
		host.getPluginConstructor = () => {
			throw new Error("app.plugins moved");
		};
		const events = makeEvents();
		const supervisor = new Supervisor(host, { onEvent: events.onEvent });
		supervisor.load();

		assert.doesNotThrow(() => supervisor.track(MOD, TARGET));
		assert.equal(events.last(MOD).event, "supervisor-error");
		assert.match(events.last(MOD).detail, /could not start supervising/);
		supervisor.unload();
	});

	test("track() ignores empty ids instead of tracking a nameless mod", () => {
		const supervisor = new Supervisor(new Host(createApp()));
		supervisor.load();
		for (const [modId, targetId] of [["", TARGET], [MOD, ""], [null, TARGET], [MOD, undefined]]) {
			supervisor.track(modId, targetId);
		}
		assert.deepEqual(supervisor.tracked(), []);
		supervisor.unload();
	});

	test("a hook whose handler throws still lets the host's enablePlugin resolve", async () => {
		// The wrapper runs inside Obsidian's own call stack. Anything escaping it takes the host's
		// enable with it — the user's plugin would fail to turn on because modkit's watcher threw.
		const app = await makeApp();
		await app.place(TARGET);
		const host = new Host(app);
		host.isReloading = () => {
			throw new Error("boom");
		};
		const supervisor = new Supervisor(host);
		supervisor.load();

		await assert.doesNotReject(() => app.plugins.enablePlugin(TARGET));
		assert.ok(errors.some((line) => /supervisor hook failed/.test(line)));
		supervisor.unload();
	});

	test("a check that throws is caught and reported against `modkit`, not rethrown", async () => {
		const app = await makeApp();
		const host = new Host(app);
		const events = makeEvents();
		const supervisor = new Supervisor(host, { onEvent: events.onEvent });
		supervisor.load();
		supervisor.track(MOD, TARGET);
		host.getPluginManifest = () => {
			throw new Error("manifests moved");
		};

		assert.doesNotThrow(() => supervisor.checkNow("manual"));
		await settle();
		const health = events.last("modkit");
		assert.equal(health.event, "supervisor-error");
		assert.match(health.detail, /check failed \(manual\)/);
		supervisor.unload();
	});

	test("an unhandled rejection cannot escape the queue — a second check still runs after a failure", async () => {
		const app = await makeApp();
		await app.place(TARGET);
		await app.place(MOD);
		const host = new Host(app);
		const events = makeEvents();
		const supervisor = new Supervisor(host, { onEvent: events.onEvent });
		supervisor.load();
		supervisor.track(MOD, TARGET);

		const good = host.getPluginManifest.bind(host);
		host.getPluginManifest = () => {
			throw new Error("transient");
		};
		supervisor.checkNow("first");
		await settle();
		host.getPluginManifest = good;

		await app.plugins.disablePlugin(TARGET);
		await app.plugins.enablePlugin(TARGET);
		await settle();
		assert.deepEqual(events.forMod(MOD).map((e) => e.event), ["target-reloaded", "reapplied"], "the queue stalled after one failure");
		supervisor.unload();
	});

	test("unloading twice is harmless", () => {
		const supervisor = new Supervisor(new Host(createApp()));
		supervisor.load();
		supervisor.unload();
		assert.doesNotThrow(() => supervisor.unload());
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * checkDomReach / checkDomReachWithRetry — the plane-E no-effect check (L2, PLAN.md 2026-09-02)
 * ──────────────────────────────────────────────────────────────────────────── */

/** A `document` fake that reports a scripted sequence of match counts, one per call. */
function scriptedDocument(counts) {
	const calls = [];
	return {
		calls,
		document: {
			querySelectorAll: (selector) => {
				calls.push(selector);
				const n = counts[Math.min(calls.length - 1, counts.length - 1)];
				return { length: n };
			},
		},
	};
}

/** A `window` fake whose `setTimeout` runs immediately — these tests assert call counts, not timing. */
function fastWindow(counts) {
	const { calls, document } = scriptedDocument(counts);
	return { calls, win: { document, setTimeout: (fn) => fn() } };
}

describe("checkDomReach", () => {
	test("zero matches is no-effect, and the selector is named in the detail", () => {
		const { document } = scriptedDocument([0]);
		const result = checkDomReach(document, { selector: '.workspace-tab-header[data-type="search"]' });
		assert.equal(result.state, "no-effect");
		assert.equal(result.matches, 0);
		assert.match(result.detail, /nothing on screen matches/);
		assert.match(result.detail, /data-type="search"/, "the selector itself belongs in the detail");
	});

	test("one or more matches is applied, with the count in the detail", () => {
		const { document } = scriptedDocument([1]);
		const one = checkDomReach(document, { selector: ".foo" });
		assert.equal(one.state, "applied");
		assert.equal(one.matches, 1);
		assert.match(one.detail, /1 match for/);

		const { document: doc3 } = scriptedDocument([3]);
		const three = checkDomReach(doc3, { selector: ".foo" });
		assert.equal(three.state, "applied");
		assert.match(three.detail, /3 matches for/);
	});

	test("a selector this engine cannot read is no-effect, not a throw", () => {
		const document = {
			querySelectorAll: () => {
				throw new Error("unsupported pseudo-class");
			},
		};
		const result = checkDomReach(document, { selector: ":has(.x)" });
		assert.equal(result.state, "no-effect");
		assert.match(result.detail, /unsupported pseudo-class/);
	});
});

/** A `document` fake whose `head` answers a scripted list of `<style>` texts. */
function docWithHead(matchCount, styleTexts) {
	return {
		querySelectorAll: () => ({ length: matchCount }),
		head: {
			querySelectorAll: (tag) => {
				assert.equal(tag, "style", "cssRuleAttached must scan <style> elements, not something else");
				return {
					length: styleTexts.length,
					item: (i) => (i < styleTexts.length ? { textContent: styleTexts[i] } : null),
				};
			},
		},
	};
}

describe("checkDomReach — css attachment (review finding, PLAN.md 2026-09-02 bug #1)", () => {
	const SELECTOR = '.workspace-tab-header[data-type="search"]';

	test("mode css, target exists, and a <style> repeats the selector — applied", () => {
		const result = checkDomReach(docWithHead(1, [`${SELECTOR} { display: none; }`]), { selector: SELECTOR, mode: "css" });
		assert.equal(result.state, "applied");
	});

	test("mode css, target exists, but no <style> mentions the selector — no-effect", () => {
		// This is bug #1 itself: the element is there (a stray tab header, say), yet the mod's own
		// rule never made it into THIS document's <head> — e.g. it landed in a popout or the Settings
		// window instead. A selector-only check would have called this `applied`.
		const result = checkDomReach(docWithHead(1, [".unrelated-rule { color: red; }"]), { selector: SELECTOR, mode: "css" });
		assert.equal(result.state, "no-effect");
		assert.match(result.detail, /stylesheet is not attached/);
	});

	test("mode css with no <style> elements at all — no-effect", () => {
		const result = checkDomReach(docWithHead(1, []), { selector: SELECTOR, mode: "css" });
		assert.equal(result.state, "no-effect");
	});

	test("mode dom never asks about a stylesheet, even with none present", () => {
		const result = checkDomReach(docWithHead(1, []), { selector: SELECTOR, mode: "dom" });
		assert.equal(result.state, "applied");
	});

	test("no mode at all (existing plain-selector callers) behaves exactly as before", () => {
		const result = checkDomReach({ querySelectorAll: () => ({ length: 1 }) }, { selector: SELECTOR });
		assert.equal(result.state, "applied");
	});
});

describe("checkDomReachWithRetry", () => {
	test("a match on the first try does not retry at all", async () => {
		const { calls, win } = fastWindow([2]);
		const result = await checkDomReachWithRetry(win, { selector: ".x" });
		assert.equal(result.state, "applied");
		assert.equal(calls.length, 1, "a first-try match must not spend extra queries");
	});

	test("retries up to the attempt limit, then reports no-effect", async () => {
		const { calls, win } = fastWindow([0, 0, 0, 0, 0]);
		const result = await checkDomReachWithRetry(win, { selector: ".x" }, { attempts: 3, delayMs: 0 });
		assert.equal(result.state, "no-effect");
		assert.equal(calls.length, 3, "must stop at the attempt cap rather than the counts array's length");
	});

	test("a match on a later attempt is believed, and the retry stops there", async () => {
		const { calls, win } = fastWindow([0, 0, 1, 0]);
		const result = await checkDomReachWithRetry(win, { selector: ".x" }, { attempts: 4, delayMs: 0 });
		assert.equal(result.state, "applied");
		assert.equal(calls.length, 3, "stopped as soon as it found a match, not after all 4 attempts");
	});
});
