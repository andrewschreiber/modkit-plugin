/**
 * `src/ui/contextmenu.ts` — L4's "Customize…" entrance, tested exactly as far as this harness can
 * honestly reach.
 *
 * Covered:
 * - `obsidianHandledContextMenu` — the exported pure "should we show ours" decision, both signals,
 *   including that the `.menu` signal is a *delta* (a pre-existing `.menu` alone must not read as
 *   "handled").
 * - `registerCustomizeContextMenu`'s capture-phase path end to end: attaches on the main window,
 *   skips a click a same-dispatch handler already marked `defaultPrevented`, skips a live pick
 *   session, and — when nobody else handled it — resolves the element through the picker, shows a
 *   real `Menu` (the stub's, not Obsidian's), and clicking its item calls `onPicked`. Also: the
 *   capture handler itself never calls `evt.preventDefault()` (the self-tainting bug this file's
 *   header warns against).
 * - The "picker could not resolve it" branch: a `Notice`, and `onPicked` never called.
 * - The four workspace menu events resolve against the element the capture-phase listener actually
 *   saw for *this* dispatch (`lastContextTarget`), not a whole view's `containerEl`, when a
 *   right-click just happened in the same window; and fall back to `containerEl` when it did not
 *   (a command-invoked menu, no preceding right-click).
 * - Multi-window: an already-open popout is found at registration, `window-open` attaches a new one
 *   exactly once, `window-close` detaches it immediately, and a plugin unload reclaims whatever is
 *   left on every window — including a still-pending decision timer, so a plugin disabled mid-click
 *   never constructs a `Menu` a moment later.
 *
 * NOT covered, and why — same shape `picker.test.mjs` documents for its own file:
 * - **The `.menu`-in-the-document half of `obsidianHandledContextMenu`, through the real DOM
 *   stub.** `stub/dom.mjs`'s `querySelectorAll` understands exactly `tag` and `tag[attr="value"]`
 *   (its own header says so); a class selector like `.menu` never matches anything through it, by
 *   design. The pure-function tests below cover that signal directly, against a hand-rolled `doc`.
 * - **`MODKIT_OWN_UI_SELECTOR`'s skip**, for the identical reason — it is a comma-separated list of
 *   class selectors, and this stub's `closest()` understands exactly one `tag`/`tag[attr="value"]`
 *   shape, never a list (`picker.test.mjs`'s `cssdom` is the one file in this suite with a real
 *   selector engine, and it exists only for `selector.ts`). The narrowing from "any modal" to
 *   "modkit's own modals" is therefore reasoned about in code review, not asserted here.
 * - The four workspace menu events' *fallback* path (`containerElOf`) resolving to what a real
 *   `MarkdownView`/`WorkspaceLeaf` would hand back: exercised only through the stub's generic
 *   `Events.trigger`, which is an honest model of *dispatch* but not of a real `containerEl` —
 *   asserting a specific element there would be asserting the test's own fixture rather than the
 *   code. The *preferred* path (`lastContextTarget`) is asserted directly, since it needs nothing
 *   from the view at all.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { compileSurface } from "./stub/compile.mjs";
import { Component, Events, Menu, Notice } from "./stub/obsidian.mjs";
import { StubDocument, StubWindow, installDomGlobals } from "./stub/dom.mjs";

const surface = await compileSurface(
	"contextmenu-surface",
	`export { obsidianHandledContextMenu, registerCustomizeContextMenu, CUSTOMIZE_ICON } from "../../src/ui/contextmenu";`,
);
const { obsidianHandledContextMenu, registerCustomizeContextMenu, CUSTOMIZE_ICON } = surface;

/** `Workspace` is `Events` plus the two workspace methods this file actually calls. */
class FakeWorkspace extends Events {
	constructor() {
		super();
		this.leaves = [];
	}

	iterateAllLeaves(cb) {
		for (const leaf of this.leaves) cb(leaf);
	}

	getActiveViewOfType() {
		return null;
	}
}

function fakePicker(pickResult = { fake: "picked-target" }) {
	return {
		active: false,
		calls: [],
		pickFromElement(el) {
			this.calls.push(el);
			return pickResult;
		},
	};
}

let dom;

/** The stub's own method, captured before any test can patch it — see the prototype-patch block. */
const pristineShowAtMouseEvent = Menu.prototype.showAtMouseEvent;

beforeEach(() => {
	dom = installDomGlobals();
	Menu.reset();
	Notice.reset();
});

afterEach(() => {
	dom.restore();
});

/** Waits past the handler's `setTimeout(…, 0)` deferred check. */
function afterDeferredCheck() {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

function contextmenuHandlerOn(win) {
	const entry = win.listeners.find((l) => l.type === "contextmenu");
	assert.ok(entry, "no contextmenu listener was registered on this window");
	return entry;
}

/** The one `Menu` a right-click should have produced, with its one "Customize…" item. */
function theShownMenu() {
	assert.equal(Menu.log.length, 1, `expected exactly one Menu, got ${Menu.log.length}`);
	const menu = Menu.log[0];
	assert.equal(menu.shown, true, "the menu was constructed but never shown");
	assert.equal(menu.items.length, 1);
	assert.equal(menu.items[0].title, "Customize…");
	return menu;
}

describe("obsidianHandledContextMenu — the pure decision", () => {
	test("defaultPrevented alone is enough", () => {
		const evt = { defaultPrevented: true };
		const doc = { querySelectorAll: () => [] };
		assert.equal(obsidianHandledContextMenu(evt, doc, 0), true);
	});

	test("the `.menu` count increasing past the baseline is enough on its own", () => {
		const evt = { defaultPrevented: false };
		const doc = { querySelectorAll: () => [{ tagName: "div" }] };
		assert.equal(obsidianHandledContextMenu(evt, doc, 0), true);
	});

	test("neither signal → not handled", () => {
		const evt = { defaultPrevented: false };
		const doc = { querySelectorAll: () => [] };
		assert.equal(obsidianHandledContextMenu(evt, doc, 0), false);
	});

	test("a `.menu` that was ALREADY in the document before this click does not count", () => {
		// The regression this delta guards against: some other, unrelated menu is still mounted (a
		// slow-closing Obsidian Menu, another plugin's persistent popover). A snapshot check would
		// read this as "handled" and suppress modkit's own menu on every right-click until the stale
		// one is gone.
		const evt = { defaultPrevented: false };
		const doc = { querySelectorAll: () => [{ tagName: "div" }] }; // exactly the pre-existing one
		assert.equal(obsidianHandledContextMenu(evt, doc, 1), false);
	});

	test("the count can only ever be checked against ITS OWN baseline, not zero", () => {
		const evt = { defaultPrevented: false };
		const doc = { querySelectorAll: () => [{ tagName: "div" }, { tagName: "div" }] }; // two now
		assert.equal(obsidianHandledContextMenu(evt, doc, 2), false, "2 → 2 is no increase");
		assert.equal(obsidianHandledContextMenu(evt, doc, 1), true, "1 → 2 is an increase");
	});
});

describe("registerCustomizeContextMenu — capture-phase path", () => {
	test("attaches a capture-phase contextmenu listener on the main window", () => {
		const host = new Component();
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker: fakePicker(), onPicked: () => {} });

		const entry = contextmenuHandlerOn(dom.window);
		assert.equal(entry.options, true, "must be capture-phase, or Obsidian's own bubble handlers run first");
	});

	test("nobody else handled it → shows a menu, and clicking its item calls onPicked", async () => {
		const host = new Component();
		const picker = fakePicker({ fake: "resolved" });
		const picked = [];
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: (p) => picked.push(p) });

		const target = dom.document.body.createDiv();
		const evt = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
		contextmenuHandlerOn(dom.window).callback(evt);
		await afterDeferredCheck();

		assert.equal(evt.defaultPrevented, false, "modkit must never call preventDefault() itself — see the file header");
		assert.deepEqual(picker.calls, [], "clicking the menu item is what should trigger resolution, not showing the menu");
		theShownMenu().items[0].trigger();

		assert.deepEqual(picker.calls, [target], "the right-clicked element must reach pickFromElement, unmodified");
		assert.deepEqual(picked, [{ fake: "resolved" }]);
	});

	test("the picker could not resolve it → a Notice, and onPicked is never called", async () => {
		const host = new Component();
		const picker = fakePicker(null); // pickFromElement returning null is a normal outcome — see picker.ts
		const picked = [];
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: (p) => picked.push(p) });

		const target = dom.document.body.createDiv();
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(dom.window).callback(evt);
		await afterDeferredCheck();
		theShownMenu().items[0].trigger();

		assert.equal(Notice.messages().length, 1);
		assert.deepEqual(picked, []);
	});

	test("Obsidian already handled it (defaultPrevented set later in the same dispatch) → we show nothing", async () => {
		const host = new Component();
		const picker = fakePicker();
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: () => {} });

		const target = dom.document.body.createDiv();
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		// A handler later in the SAME dispatch (Obsidian's own bubble-phase handler) sets this before
		// our deferred check runs — the exact ordering `obsidianHandledContextMenu`'s doc comment
		// describes, and the reason the check has to be deferred at all rather than run inline.
		queueMicrotask(() => {
			evt.defaultPrevented = true;
		});
		contextmenuHandlerOn(dom.window).callback(evt);
		await afterDeferredCheck();

		assert.equal(Menu.log.length, 0, "defaultPrevented set by someone else must still be honoured");
	});

	test("a live pick session owns this window's right-click already", async () => {
		const host = new Component();
		const picker = fakePicker();
		picker.active = true;
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: () => {} });

		const target = dom.document.body.createDiv();
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(dom.window).callback(evt);
		await afterDeferredCheck();

		assert.equal(Menu.log.length, 0, "an active pick session must not also get a Customize… menu");
	});

	test("a target with no resolvable element (no `closest`) is ignored rather than thrown on", async () => {
		const host = new Component();
		const picker = fakePicker();
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: () => {} });

		const evt = { target: null, defaultPrevented: false, preventDefault() {} };
		assert.doesNotThrow(() => contextmenuHandlerOn(dom.window).callback(evt));
		await afterDeferredCheck();
		assert.equal(Menu.log.length, 0);
	});
});

describe("registerCustomizeContextMenu — workspace-menu resolution", () => {
	/**
	 * Registers, then synchronously simulates the ordering a real right-click produces: our own
	 * capture-phase handler sees the raw target first, and Obsidian's bubble-phase handler fires the
	 * workspace event afterward, in the very same dispatch — before either's `setTimeout(…, 0)`
	 * decision has run. `contextmenuHandlerOn(...).callback(evt)` then `workspace.trigger(...)`,
	 * back to back with no `await` between them, models exactly that ordering.
	 */
	function rightClickThenTrigger(workspace, eventName, target, ...args) {
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(dom.window).callback(evt);
		workspace.trigger(eventName, ...args);
	}

	for (const [eventName, fallbackArgs] of [
		["editor-menu", [{}, { containerEl: "wrong — must never be read when a right-click just happened" }]],
		["file-menu", [{}, "source", { view: { containerEl: "wrong — must never be read when a right-click just happened" } }]],
		["files-menu", [[], "source", { view: { containerEl: "wrong — must never be read when a right-click just happened" } }]],
		["url-menu", ["https://example.com"]],
	]) {
		test(`${eventName} resolves against the right-clicked element, not the view's containerEl`, () => {
			const host = new Component();
			const workspace = new FakeWorkspace();
			const picker = fakePicker({ fake: "picked" });
			const picked = [];
			registerCustomizeContextMenu(host, { app: { workspace }, picker, onPicked: (p) => picked.push(p) });

			const clicked = dom.document.body.createDiv();
			const menu = new Menu();
			rightClickThenTrigger(workspace, eventName, clicked, menu, ...fallbackArgs);

			assert.equal(menu.items.length, 1, `${eventName} did not add Customize…`);
			menu.items[0].trigger();
			assert.deepEqual(picker.calls, [clicked], `${eventName} must resolve the actually-right-clicked element`);
			assert.deepEqual(picked, [{ fake: "picked" }]);
		});
	}

	test("with no preceding right-click, editor-menu falls back to the view's containerEl", () => {
		const host = new Component();
		const workspace = new FakeWorkspace();
		const picker = fakePicker({ fake: "picked" });
		const picked = [];
		registerCustomizeContextMenu(host, { app: { workspace }, picker, onPicked: (p) => picked.push(p) });

		const fallbackEl = dom.document.body.createDiv();
		const menu = new Menu();
		// No right-click happened in this test at all — a command or another plugin invoked the menu.
		workspace.trigger("editor-menu", menu, {}, { containerEl: fallbackEl });

		assert.equal(menu.items.length, 1);
		menu.items[0].trigger();
		assert.deepEqual(picker.calls, [fallbackEl], "with nothing captured, the view's own containerEl is the only honest target");
	});

	test("a stale right-clicked element does not leak into a later, unrelated menu event", async () => {
		const host = new Component();
		const workspace = new FakeWorkspace();
		const picker = fakePicker({ fake: "picked" });
		registerCustomizeContextMenu(host, { app: { workspace }, picker, onPicked: () => {} });

		const rightClicked = dom.document.body.createDiv();
		const evt = { target: rightClicked, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(dom.window).callback(evt);
		await afterDeferredCheck(); // the right-click's own decision window has now closed

		const fallbackEl = dom.document.body.createDiv();
		const menu = new Menu();
		workspace.trigger("editor-menu", menu, {}, { containerEl: fallbackEl });
		menu.items[0].trigger();

		assert.deepEqual(picker.calls, [fallbackEl], "a menu event with no right-click of its own must not inherit a stale target");
	});
});

/** A second `Window`/`Document` pair, standing in for a popout — same shape `installDomGlobals` builds. */
function fakePopout() {
	const doc = new StubDocument();
	const win = new StubWindow(doc);
	doc.defaultView = win;
	return win;
}

describe("registerCustomizeContextMenu — multi-window", () => {
	test("an already-open popout (found via iterateAllLeaves) gets attached at registration", async () => {
		const host = new Component();
		const workspace = new FakeWorkspace();
		const popout = fakePopout();
		workspace.leaves.push({ getContainer: () => ({ win: popout }) });
		const picker = fakePicker();
		registerCustomizeContextMenu(host, { app: { workspace }, picker, onPicked: () => {} });

		const target = popout.document.createElement("div");
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(popout).callback(evt);
		await afterDeferredCheck();
		theShownMenu().items[0].trigger();

		assert.deepEqual(picker.calls, [target], "a right-click in an already-open popout must reach the picker");
	});

	test("window-open attaches a new popout exactly once", () => {
		const host = new Component();
		const workspace = new FakeWorkspace();
		registerCustomizeContextMenu(host, { app: { workspace }, picker: fakePicker(), onPicked: () => {} });

		const popout = fakePopout();
		workspace.trigger("window-open", {}, popout);
		workspace.trigger("window-open", {}, popout); // a duplicate notice must not double-attach

		const entries = popout.listeners.filter((l) => l.type === "contextmenu");
		assert.equal(entries.length, 1, `expected exactly one contextmenu listener, found ${entries.length}`);
	});

	test("window-close detaches immediately, without waiting for a full plugin unload", () => {
		const host = new Component();
		const workspace = new FakeWorkspace();
		registerCustomizeContextMenu(host, { app: { workspace }, picker: fakePicker(), onPicked: () => {} });

		const popout = fakePopout();
		workspace.trigger("window-open", {}, popout);
		assert.equal(popout.listeners.filter((l) => l.type === "contextmenu").length, 1);

		workspace.trigger("window-close", {}, popout);
		assert.equal(
			popout.listeners.filter((l) => l.type === "contextmenu").length,
			0,
			"a closed popout's window object should not still hold our listener",
		);
	});

	test("a plugin unload reclaims the main window's listener and every still-open popout's", () => {
		const host = new Component();
		host.load();
		const workspace = new FakeWorkspace();
		registerCustomizeContextMenu(host, { app: { workspace }, picker: fakePicker(), onPicked: () => {} });

		const popout = fakePopout();
		workspace.trigger("window-open", {}, popout);
		assert.equal(dom.window.listeners.filter((l) => l.type === "contextmenu").length, 1);
		assert.equal(popout.listeners.filter((l) => l.type === "contextmenu").length, 1);

		host.unload();

		assert.equal(dom.window.listeners.filter((l) => l.type === "contextmenu").length, 0, "the main window's listener survived unload");
		assert.equal(popout.listeners.filter((l) => l.type === "contextmenu").length, 0, "a still-open popout's listener survived unload");
	});

	test("a plugin unload before the deferred decision fires cancels it — no Menu constructed a moment later", async () => {
		const host = new Component();
		host.load();
		const workspace = new FakeWorkspace();
		registerCustomizeContextMenu(host, { app: { workspace }, picker: fakePicker(), onPicked: () => {} });

		const target = dom.document.body.createDiv();
		const evt = { target, defaultPrevented: false, preventDefault() {} };
		contextmenuHandlerOn(dom.window).callback(evt);
		assert.equal(dom.window.pending().length, 1, "the right-click should have scheduled exactly one decision timer");

		host.unload(); // disables the plugin mid-decision, before the setTimeout(…, 0) has run

		assert.equal(dom.window.pending().length, 0, "unload must cancel the still-pending decision timer, not just future listeners");
		await afterDeferredCheck();
		assert.equal(Menu.log.length, 0, "a Menu must never be constructed for a click the plugin was unloaded during");
	});
});

describe("registerCustomizeContextMenu — the Menu.prototype.showAtMouseEvent patch", () => {
	// Most tests in this file register on a Component they never load or unload, so by the time this
	// block runs `Menu.prototype.showAtMouseEvent` carries a stack of live patches from them, each
	// still holding its own (inactive) fake picker. Those would decorate every menu here and make the
	// "left alone" assertions below lie about *this* code. Start each test from the stub's own method.
	beforeEach(() => {
		Menu.prototype.showAtMouseEvent = pristineShowAtMouseEvent;
	});

	test("a menu Obsidian shows from a right-click gains “Customize…” once, resolving the clicked element", () => {
		const host = new Component();
		host.load(); // the stub's unload() is a no-op on a never-loaded Component, so the reclaim below needs this
		const picker = fakePicker({ fake: "from-patch" });
		const picked = [];
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: (p) => picked.push(p) });

		const target = dom.document.body.createDiv();
		const evt = { type: "contextmenu", target, defaultPrevented: false, clientX: 1, clientY: 2 };
		const menu = new Menu().addItem((item) => item.setTitle("Close"));
		menu.showAtMouseEvent(evt);
		menu.showAtMouseEvent(evt); // Obsidian re-showing the same menu must not add a second item

		assert.equal(menu.shown, true, "the original showAtMouseEvent must still run");
		assert.deepEqual(menu.items.map((i) => i.title), ["Close", "Customize…"]);
		menu.items[1].trigger();
		assert.deepEqual(picker.calls, [target]);
		assert.deepEqual(picked, [{ fake: "from-patch" }]);
		host.unload();
	});

	test("a menu shown from a left-click, or inside modkit's own UI, or during a pick, is left alone", () => {
		const host = new Component();
		host.load();
		const picker = fakePicker();
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker, onPicked: () => {} });
		const target = dom.document.body.createDiv();

		const leftClick = new Menu().showAtMouseEvent({ type: "click", target });
		assert.deepEqual(leftClick.items, []);

		picker.active = true;
		const midPick = new Menu().showAtMouseEvent({ type: "contextmenu", target });
		assert.deepEqual(midPick.items, []);
		picker.active = false;
		host.unload();
	});

	test("the patch is reclaimed on unload — a later menu is untouched", () => {
		const host = new Component();
		host.load();
		registerCustomizeContextMenu(host, { app: { workspace: new FakeWorkspace() }, picker: fakePicker(), onPicked: () => {} });
		host.unload();

		const target = dom.document.body.createDiv();
		const menu = new Menu().showAtMouseEvent({ type: "contextmenu", target });
		assert.equal(menu.shown, true);
		assert.deepEqual(menu.items, []);
	});
});

test("CUSTOMIZE_ICON is exported for the ribbon icon to share", () => {
	assert.equal(typeof CUSTOMIZE_ICON, "string");
	assert.ok(CUSTOMIZE_ICON.length > 0);
});
