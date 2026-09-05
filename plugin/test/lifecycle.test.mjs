/**
 * `onload` and `onunload`, on the shipped bundle.
 *
 * Two claims are under test, and modkit's whole pitch rests on both:
 *
 * 1. **A degraded host does not take the plugin down.** `app.plugins` is undocumented internals; an
 *    Obsidian update can move it. When it does, modkit must say so once, plainly, and keep working
 *    as far as it can — because the alternative is a plugin that throws out of `onload` and leaves
 *    the user with nothing, including no way to read the explanation.
 * 2. **`onunload` leaves nothing.** modkit tells generated code that every acquisition goes through
 *    the Component reclaim contract. A tool that leaks while enforcing that rule has no standing,
 *    so the teardown is asserted against the host: zero commands, zero setting tabs, no status bar
 *    element, no live intervals, no stylesheets.
 *
 * The `Plugin` these run against is the class exported by `plugin/dist/main.js`, loaded through
 * `helpers/bundle.mjs`. See that file for the realm caveat, and `stub/obsidian.mjs` for what the
 * host stub is and is not faithful about.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { loadBundle } from "./helpers/bundle.mjs";
import { Notice, Platform } from "./stub/obsidian.mjs";
import { createApp, manifestFor, tick } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

const MODKIT_MANIFEST = manifestFor("modkit", { name: "modkit", version: "0.1.0" });
const STYLE_SELECTOR = 'style[data-modkit-style]';

let dom;
let plugin;

beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
	plugin = null;
});

afterEach(() => {
	try {
		plugin?.unload();
	} catch {
		/* a teardown assertion has already reported whatever went wrong */
	}
	dom.restore();
});

async function start(app) {
	const { exports } = loadBundle();
	const ModkitPlugin = exports.default;
	plugin = new ModkitPlugin(app, MODKIT_MANIFEST);
	await plugin.load();
	// The picker's styles and the status bar are created synchronously; the workspace callback is
	// not, so let the microtask queue drain before asserting.
	await tick(2);
	return plugin;
}

describe("onload against a degraded host", () => {
	test("does not throw when app.plugins is missing", async () => {
		const app = createApp({ plugins: false });
		await assert.doesNotReject(() => start(app), "onload must survive a host that moved its internals");
		assert.equal(plugin._loaded, true);
	});

	test("says so exactly once, and names what is wrong", async () => {
		const app = createApp({ plugins: false });
		await start(app);

		const messages = Notice.messages();
		assert.equal(messages.length, 1, `expected one notice, got ${messages.length}: ${JSON.stringify(messages)}`);
		assert.match(messages[0], /app\.plugins/, "the notice must name the internal that is missing");
		assert.match(messages[0], /cannot write or run patches here/i, "the notice must say what the user loses");
		assert.equal(Notice.log[0].timeout, 0, "a fatal defect gets a sticky notice, not one that vanishes");
	});

	test("registers its commands anyway", async () => {
		// A user whose host went degraded still needs the palette to reach the settings tab and read
		// the explanation. Refusing to register commands would hide the only recovery path.
		const app = createApp({ plugins: false });
		await start(app);

		const ids = Object.keys(app.commands.commands).sort();
		assert.deepEqual(ids, [
			"modkit:mod-plugin",
			"modkit:mod-this",
			"modkit:run-experiment-e2",
			"modkit:show-mods",
		]);
		assert.equal(app.setting.settingTabs.length, 1, "the settings tab is where the defect is explained");
	});

	test("the layout-ready reconciliation does not throw on a degraded host either", async () => {
		const app = createApp({ plugins: false });
		await start(app);
		assert.doesNotThrow(() => app.workspace.fireLayoutReady());
		await tick(5);
	});
});

describe("onload against a healthy host", () => {
	test("is silent — no notice at all", async () => {
		const app = createApp();
		await start(app);
		assert.deepEqual(Notice.messages(), [], "a healthy host must produce no startup noise");
	});

	test("takes a status bar item and exposes modkitReportHealth", async () => {
		const app = createApp();
		await start(app);

		assert.equal(app.statusBar.children.length, 1, "the progress surface's status bar item is missing");
		assert.ok(app.statusBar.children[0].hasClass("modkit-status"));
		// How a generated mod finds modkit: `app.plugins.plugins.modkit.modkitReportHealth(...)`.
		assert.equal(typeof plugin.modkitReportHealth, "function");
	});

	test("injects the UI stylesheet, and only that one", async () => {
		// The picker's sheet is deliberately session-scoped: each `PickSession` injects it on its own
		// Component, and `injectPickerStyles` removes every sheet already carrying its id first. A
		// plugin-level picker sheet would be destroyed by the first pick, leaving the plugin holding a
		// teardown for a detached node — and a body-wide `cursor: crosshair` outside pick mode.
		const app = createApp();
		await start(app);

		const ids = dom.document.head.querySelectorAll(STYLE_SELECTOR).map((el) => el.getAttribute("data-modkit-style"));
		assert.deepEqual(ids, ["ui"]);
		assert.ok(
			dom.document.head.querySelector('style[data-modkit-style="ui"]').textContent.length > 0,
			"the injected sheet must actually carry CSS",
		);
	});

	test("a second load does not leave the first load's stylesheet behind", async () => {
		// Two components each believing they own one style element is how a teardown pulls the sheet
		// out from under whoever is still running. The injector sweeps its own id before injecting.
		const app = createApp();
		await start(app);
		const first = plugin;
		await start(app); // a second plugin instance over the same document

		const ids = dom.document.head.querySelectorAll(STYLE_SELECTOR).map((el) => el.getAttribute("data-modkit-style"));
		assert.deepEqual(ids, ["ui"], `found ${ids.length} stylesheets, expected 1`);
		first.unload();
	});

	test("the ribbon icon is unconditional; the “Customize…” context menu is desktop-only (L4/L5)", async () => {
		// There is no right-click to capture on mobile, and a capture-phase listener with nothing
		// pointing at it is dead weight — so it is gated on `Platform.isDesktop` (see contextmenu.ts's
		// own header) rather than added and left inert.
		const app = createApp();
		Platform.isDesktop = false;
		try {
			await start(app);
			assert.equal(app.ribbon.children.length, 1, "the ribbon icon is the primary mobile entrance and must not be gated");
			assert.equal(
				dom.window.listeners.filter((l) => l.type === "contextmenu").length,
				0,
				"a mobile host has no right-click to capture — the listener must not be registered",
			);
		} finally {
			Platform.isDesktop = true;
		}
	});
});

describe("onunload leaves nothing", () => {
	test("every host-side acquisition comes back", async () => {
		const app = createApp();
		await start(app);

		// Establish that there was something to reclaim — a teardown test that passes because
		// nothing was ever acquired is worthless.
		assert.equal(Object.keys(app.commands.commands).length, 4);
		assert.equal(app.setting.settingTabs.length, 1);
		assert.equal(app.statusBar.children.length, 1);
		assert.equal(app.ribbon.children.length, 1, "the Customize… ribbon icon (L5) is missing");
		assert.equal(
			dom.window.listeners.filter((l) => l.type === "contextmenu").length,
			1,
			"the Customize… context-menu listener (L4) is missing — desktop is the stub's default Platform",
		);
		assert.ok(dom.window.pendingIntervals().length >= 1, "the progress surface should own a live interval");
		assert.equal(dom.document.head.querySelectorAll(STYLE_SELECTOR).length, 1);

		plugin.unload();

		assert.deepEqual(Object.keys(app.commands.commands), [], "commands survived unload");
		assert.deepEqual(app.setting.settingTabs, [], "a setting tab survived unload");
		assert.equal(app.statusBar.children.length, 0, "the status bar element survived unload");
		assert.equal(app.ribbon.children.length, 0, "the ribbon icon survived unload");
		assert.equal(
			dom.window.listeners.filter((l) => l.type === "contextmenu").length,
			0,
			"the context-menu listener survived unload",
		);
		assert.equal(dom.window.pendingIntervals().length, 0, "an interval survived unload");
		assert.equal(dom.document.head.querySelectorAll(STYLE_SELECTOR).length, 0, "a stylesheet survived unload");
		plugin = null;
	});

	test("the two data.json stores let go of the shared file", async () => {
		// `SettingsStore` and `ModStore` each register a callback on the one shared `DataFile`, and
		// each keeps a listener set. Both have a `dispose()` whose own doc comment prescribes
		// `this.register(() => store.dispose())` — and for a while nobody called it. Measured against
		// the bundle built before that wiring landed, a `reload()` after `unload()` still notified a
		// live subscriber; after it, zero. Nothing outlives the plugin either way (the `DataFile`
		// hangs off a `WeakMap` keyed on the plugin), but modkit's standing rests on releasing its
		// own acquisitions, so this is asserted rather than reasoned about.
		const app = createApp();
		await start(app);

		let notified = 0;
		plugin.settingsStore.subscribe(() => {
			notified += 1;
		});
		await plugin.settingsStore.reload();
		assert.ok(notified >= 1, "a reload before unload must notify — otherwise this test proves nothing");

		plugin.unload();

		const baseline = notified;
		await plugin.settingsStore.reload();
		assert.equal(notified - baseline, 0, "a settings subscriber survived unload");
		plugin = null;
	});

	test("unloading twice is harmless", async () => {
		const app = createApp();
		await start(app);
		plugin.unload();
		assert.doesNotThrow(() => plugin.unload());
		plugin = null;
	});

	test("nothing leaks on a degraded host either", async () => {
		const app = createApp({ plugins: false });
		await start(app);
		plugin.unload();

		assert.deepEqual(Object.keys(app.commands.commands), []);
		assert.deepEqual(app.setting.settingTabs, []);
		assert.equal(dom.window.pendingIntervals().length, 0);
		assert.equal(dom.document.head.querySelectorAll(STYLE_SELECTOR).length, 0);
		plugin = null;
	});

	test("no status bar item is taken on a mobile host, and none is left behind", async () => {
		// `addStatusBarItem` is documented as unavailable on mobile, so the progress surface must not
		// reach for one — and the teardown must not assume it did.
		const app = createApp();
		Platform.isDesktopApp = false;
		Platform.isMobile = true;
		try {
			await start(app);
			assert.equal(app.statusBar.children.length, 0, "a mobile host must not get a status bar item");
			plugin.unload();
			assert.equal(dom.window.pendingIntervals().length, 0);
		} finally {
			Platform.isDesktopApp = true;
			Platform.isMobile = false;
		}
		plugin = null;
	});
});
