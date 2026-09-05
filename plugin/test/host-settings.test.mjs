/**
 * `host.ts` and the pure half of `settings.ts`.
 *
 * These are the two modules the rest of modkit asks "may I?" before doing anything, and until now
 * nothing exercised either. Both are tested through the compiled source (`build/plugin-api.mjs`),
 * not through the bundle, because the interesting behaviour is at function granularity.
 *
 * Only the **pure** exports of `settings.ts` are covered here. `SettingsStore` itself owns a shared
 * `data.json` handle, an optional separate token file and a LiveSync exposure check; it is exercised
 * end to end by `lifecycle.test.mjs`, through the real plugin, which is the honest place to assert
 * it. Reaching into its internals from here would test a snapshot of a refactor rather than a
 * contract.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	clampTimeout,
	DEFAULT_SETTINGS,
	Host,
	isValidPubkey,
	isValidPubkeyHex,
	normalizeBaseUrl,
	normalizePubkey,
	normalizeSettings,
	parseData,
	probeHost,
	settingsBlockers,
} from "./build/plugin-api.mjs";
import { Notice } from "./stub/obsidian.mjs";
import { createApp, manifestFor } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

let dom;
beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
});
afterEach(() => {
	dom.restore();
});

describe("probeHost", () => {
	test("a healthy host has no defects", () => {
		const probe = probeHost(createApp());
		assert.deepEqual(probe.defects, [], `unexpected defects: ${JSON.stringify(probe.defects)}`);
		assert.equal(probe.ok, true);
		assert.equal(probe.degraded, false);
	});

	test("a missing app.plugins is fatal, and says what the user loses", () => {
		const probe = probeHost(createApp({ plugins: false }));
		assert.equal(probe.ok, false);
		const fatal = probe.defects.filter((d) => d.severity === "fatal");
		assert.equal(fatal.length, 1);
		assert.equal(fatal[0].path, "app.plugins");
		assert.equal(fatal[0].expected, "object");
		assert.equal(fatal[0].actual, "undefined");
		assert.match(fatal[0].consequence, /install a mod|enable/, "a defect must be stated in the user's terms");
	});

	test("each internal is named individually, so one move is one defect", () => {
		const app = createApp();
		// Assigned rather than deleted: these are prototype methods on the stub manager, and `delete`
		// on an own property that does not exist is a silent no-op that would have made this pass
		// against a healthy host.
		app.plugins.enablePlugin = undefined;
		app.plugins.enabledPlugins = ["not", "a", "set"];

		const probe = probeHost(app);
		const paths = probe.defects.map((d) => d.path).sort();
		assert.deepEqual(paths, ["app.plugins.enablePlugin", "app.plugins.enabledPlugins"]);
		assert.equal(probe.ok, false);
	});

	test("a Set built in another realm still counts as a Set", () => {
		// Obsidian popout windows are separate realms; a bare `instanceof Set` reports false on a
		// perfectly good Set from another window, and modkit would declare a healthy host broken.
		const app = createApp();
		app.plugins.enabledPlugins = { has: () => false, add: () => {}, delete: () => {} };
		assert.deepEqual(probeHost(app).defects, []);
	});

	test("a missing command registry is degraded, not fatal", () => {
		const app = createApp();
		delete app.commands.commands;

		const probe = probeHost(app);
		assert.equal(probe.ok, true, "losing one reach plane must not disable modkit entirely");
		assert.equal(probe.degraded, true);
		assert.equal(probe.defects[0].severity, "degraded");
		assert.equal(probe.defects[0].path, "app.commands.commands");
	});
});

describe("Host", () => {
	test("notifies once, stickily, on a fatal defect", () => {
		const host = new Host(createApp({ plugins: false }));
		host.probe({ notify: true });

		assert.equal(Notice.log.length, 1);
		assert.equal(Notice.log[0].timeout, 0, "a fatal defect must not scroll away");
		assert.match(Notice.log[0].message, /app\.plugins/);
	});

	test("notifies transiently in degraded mode, and not at all when healthy", () => {
		const degradedApp = createApp();
		delete degradedApp.viewRegistry.viewByType;
		new Host(degradedApp).probe({ notify: true });
		assert.equal(Notice.log.length, 1);
		assert.ok(Notice.log[0].timeout > 0, "a degraded notice should expire");

		Notice.reset();
		new Host(createApp()).probe({ notify: true });
		assert.deepEqual(Notice.messages(), []);
	});

	test("every accessor degrades rather than throwing when the internals are gone", async () => {
		const host = new Host(createApp({ plugins: false }));

		assert.equal(host.available, false);
		assert.equal(host.pluginManager(), null);
		assert.deepEqual(host.listInstalledPlugins(), []);
		assert.equal(host.getPluginInstance("anything"), null);
		assert.equal(host.getPluginManifest("anything"), null);
		assert.equal(host.getPluginConstructor("anything"), null);
		assert.equal(host.isPluginEnabled("anything"), false);
		assert.equal(host.isPluginLoaded("anything"), false);
		assert.equal(host.getCommand("anything:thing"), null);
		// `false` rather than a throw: a caller must be able to tell "did nothing" from "reloaded".
		assert.equal(await host.enablePlugin("anything"), false);
		assert.equal(await host.disablePlugin("anything"), false);
		assert.equal(await host.reloadPlugin("anything"), false);
	});

	test("a deferred plugin is reported as not loaded", () => {
		// `_loaded === false` is a lazy plugin: the object exists, its onload has not run, and
		// anything it registers at load is not there to patch yet.
		const app = createApp();
		app.plugins.install(manifestFor("obsidian-tasks-plugin"), { enabled: true, loaded: true });
		app.plugins.plugins["obsidian-tasks-plugin"]._loaded = false;

		const host = new Host(app);
		assert.equal(host.isPluginEnabled("obsidian-tasks-plugin"), true, "it is enabled…");
		assert.equal(host.isPluginLoaded("obsidian-tasks-plugin"), false, "…and it is not patchable");
	});

	test("lists installed plugins by name, with enabled and loaded reported separately", () => {
		const app = createApp();
		app.plugins.install(manifestFor("zeta-plugin", { name: "Zeta" }), { enabled: true, loaded: true });
		app.plugins.install(manifestFor("alpha-plugin", { name: "Alpha" }), { enabled: true, loaded: false });
		app.plugins.install(manifestFor("mu-plugin", { name: "Mu" }));

		const listed = new Host(app).listInstalledPlugins();
		assert.deepEqual(
			listed.map((p) => p.name),
			["Alpha", "Mu", "Zeta"],
		);
		const alpha = listed.find((p) => p.id === "alpha-plugin");
		assert.equal(alpha.enabled, true, "in enabledPlugins — the setting");
		assert.equal(alpha.loaded, false, "no live instance — the reality");
	});

	test("reloadPlugin follows disable-then-enable, and refuses for a plugin the user turned off", async () => {
		const app = createApp();
		app.plugins.install(manifestFor("obsidian-tasks-plugin"), { enabled: true, loaded: true });
		// The stub refuses to enable a plugin with no code on disk, so give it some.
		const dir = `${app.vault.configDir}/plugins/obsidian-tasks-plugin`;
		app.vault.adapter.mkdirp(dir);
		await app.vault.adapter.write(`${dir}/main.js`, "module.exports = class {};\n");
		const host = new Host(app);
		app.plugins.calls.length = 0;

		assert.equal(await host.reloadPlugin("obsidian-tasks-plugin"), true);
		assert.deepEqual(
			app.plugins.calls.map((c) => c.op),
			["disablePlugin", "enablePlugin"],
		);
		assert.equal(host.isReloading("obsidian-tasks-plugin"), false, "the in-flight marker must be cleared");

		// A plugin the user turned off must not be brought back up by a reload.
		app.plugins.enabledPlugins.delete("obsidian-tasks-plugin");
		app.plugins.calls.length = 0;
		assert.equal(await host.reloadPlugin("obsidian-tasks-plugin"), false);
		assert.deepEqual(app.plugins.calls, []);
	});

	test("the in-flight marker is cleared even when the enable throws", async () => {
		// Otherwise a plugin that fails to come back up leaves the supervisor permanently ignoring it.
		const app = createApp();
		app.plugins.install(manifestFor("obsidian-tasks-plugin"), { enabled: true, loaded: true });
		app.plugins.refuseEnable.add("obsidian-tasks-plugin");
		const host = new Host(app);

		assert.equal(await host.reloadPlugin("obsidian-tasks-plugin"), false);
		assert.equal(host.isReloading("obsidian-tasks-plugin"), false);
	});
});

describe("settings — normalisation and validation", () => {
	test("a typed URL gets a scheme and loses its trailing slashes", () => {
		assert.equal(normalizeBaseUrl("127.0.0.1:8501"), "http://127.0.0.1:8501");
		assert.equal(normalizeBaseUrl("  https://box.ts.net:8501///  "), "https://box.ts.net:8501");
		// Cleared and never-set must stay distinguishable, so an empty field is not the default.
		assert.equal(normalizeBaseUrl(""), "");
		assert.equal(normalizeBaseUrl("   "), "");
	});

	test("a pinned key is accepted only as 64 hex characters, case- and space-insensitively", () => {
		const key = "a".repeat(64);
		assert.equal(isValidPubkey(`  ${key.toUpperCase()}  `), true);
		assert.equal(normalizePubkey(`  ${key.toUpperCase()}  `), key);
		assert.equal(isValidPubkey(key.slice(0, 63)), false);
		assert.equal(isValidPubkey(`${key}0`), false);
		assert.equal(isValidPubkey("z".repeat(64)), false);
		assert.equal(isValidPubkey(""), false);

		// The verifier's own gate must agree with the settings tab's, or a key the tab accepted
		// would be rejected at install time — the worst possible moment to find out.
		assert.equal(isValidPubkeyHex(key), true);
		assert.equal(isValidPubkeyHex(key.slice(0, 63)), false);
		assert.equal(isValidPubkeyHex(42), false);
	});

	test("a timeout is clamped, and nonsense falls back to the default", () => {
		assert.equal(clampTimeout(30_000), 30_000);
		assert.equal(clampTimeout(1), 2_000);
		assert.equal(clampTimeout(10_000_000), 300_000);
		assert.equal(clampTimeout(Number.NaN), DEFAULT_SETTINGS.requestTimeoutMs);
		assert.equal(clampTimeout(Number.POSITIVE_INFINITY), DEFAULT_SETTINGS.requestTimeoutMs);
	});

	test("normalizeSettings fills every field from garbage without throwing", () => {
		assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
		assert.deepEqual(normalizeSettings("not an object"), { ...DEFAULT_SETTINGS });

		const partial = normalizeSettings({ daemonBaseUrl: "box:8501", requireSignature: false, requestTimeoutMs: 5 });
		assert.equal(partial.daemonBaseUrl, "http://box:8501");
		assert.equal(partial.requireSignature, false);
		assert.equal(partial.requestTimeoutMs, 2_000, "an out-of-range timeout is clamped, not carried through");
		assert.equal(partial.debugLogging, DEFAULT_SETTINGS.debugLogging);
	});

	test("signature checking defaults ON", () => {
		// Off means arbitrary code from whatever answers on the base URL is written into the vault
		// and run with the vault's file access. The default is the security posture.
		assert.equal(DEFAULT_SETTINGS.requireSignature, true);
	});

	test("blockers name every reason a request cannot go out", () => {
		const blockers = settingsBlockers({ ...DEFAULT_SETTINGS });
		assert.equal(blockers.length, 2, `expected the missing key and the missing token; got ${JSON.stringify(blockers)}`);
		assert.ok(blockers.some((b) => /signing key is pinned/i.test(b)));
		assert.ok(blockers.some((b) => /auth token/i.test(b)));

		const ready = settingsBlockers({
			...DEFAULT_SETTINGS,
			daemonPubkey: "a".repeat(64),
			daemonToken: "t".repeat(24),
		});
		assert.deepEqual(ready, []);
	});

	test("a half-hex pinned key is reported as unusable, not silently ignored", () => {
		const blockers = settingsBlockers({
			...DEFAULT_SETTINGS,
			daemonPubkey: "abc",
			daemonToken: "t".repeat(24),
		});
		assert.equal(blockers.length, 1);
		assert.match(blockers[0], /not 64 hex characters/);
	});

	test("parseData keeps keys this build does not know about", () => {
		// Saving must never downgrade a file a newer modkit wrote on another device.
		const parsed = parseData({
			protocol: "MODKIT/1",
			settings: { daemonBaseUrl: "box:8501" },
			mods: [],
			somethingNewer: { keep: "me" },
		});
		assert.deepEqual(parsed.unknownKeys, { somethingNewer: { keep: "me" } });
		assert.equal(parsed.foreignProtocol, null);
		assert.equal(parsed.data.settings.daemonBaseUrl, "http://box:8501");
	});

	test("parseData reports a foreign protocol rather than rewriting it", () => {
		const parsed = parseData({ protocol: "MODKIT/9", settings: {}, mods: [] });
		assert.equal(parsed.foreignProtocol, "MODKIT/9");
	});

	test("parseData drops only records that cannot name anything, and counts them", () => {
		const parsed = parseData({
			mods: [{ modId: "modkit-mod-a", request: "keep me" }, { name: "no id" }, 42],
		});
		assert.equal(parsed.data.mods.length, 1);
		assert.equal(parsed.data.mods[0].modId, "modkit-mod-a");
		assert.equal(parsed.droppedMods, 2);
	});
});
