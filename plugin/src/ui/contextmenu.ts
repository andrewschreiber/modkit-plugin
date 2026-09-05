/**
 * "Customize…" — L4's second door onto the exact compose flow "Mod this…" already opens. Point at
 * something by right-clicking it instead of invoking a command and then pointing at it; the
 * callback resolves the same {@link PickedTarget} `ElementPicker.pick()` would have produced from
 * a click, via {@link ElementPicker.pickFromElement}, and hands it to the same `modThis()` compose
 * path. One room, a second door — not a second flow.
 *
 * ## Two kinds of right-click, because Obsidian owns some of them already
 *
 * An editor, the file explorer, and a link already open Obsidian's own context menu through
 * documented events (`editor-menu`, `file-menu`, `url-menu`, `files-menu`); this file adds one
 * item to each, the ordinary way any plugin extends those menus.
 *
 * Everything else — a ribbon icon, a settings row, a plugin's own pane chrome, the empty canvas of
 * a view — gets no menu from Obsidian at all, and the only way to reach it is a capture-phase
 * `contextmenu` listener on the window. That listener must never win a right-click Obsidian (or
 * another plugin) is about to show its own menu for, and there is no *synchronous* way to know
 * that: capture fires before any bubble-phase handler has run, so `evt.defaultPrevented` reads
 * `false` in our own handler even when a menu is about to open a moment later in the same dispatch.
 * `obsidianHandledContextMenu` is therefore checked from a callback deferred with `setTimeout(…,
 * 0)` — scheduled from inside the capture listener, but run only once the current dispatch,
 * including whatever handler Obsidian itself attached, has finished and had the chance to insert
 * its own `.menu` into the document or call `preventDefault()`.
 *
 * **This file never calls `evt.preventDefault()` itself.** An earlier version called it from the
 * deferred callback, on the theory that it suppressed some native default action — it does not.
 * The DOM only consults the canceled flag while the event is dispatching; by the time a
 * `setTimeout(…, 0)` callback runs, dispatch is long over and the default action (if the host was
 * even going to take one) has already happened. The call was dead code that looked load-bearing,
 * and worse, calling it *synchronously* in the capture listener (the only place it could do
 * anything) would set `evt.defaultPrevented` ourselves — tainting the very flag
 * `obsidianHandledContextMenu` reads to ask whether *someone else* handled the click. Not calling
 * it at all is what keeps that flag an honest signal about other handlers.
 *
 * **The `.menu`-in-the-document signal is a delta, not a snapshot.** Obsidian's own `Menu` (and
 * every other plugin's) leaves a `.menu` element mounted in the document for as long as it is
 * open, so counting `.menu` elements once — after the fact, in the deferred callback — would also
 * count a menu left over from some earlier, unrelated interaction and wrongly conclude "handled."
 * The count taken *before* dispatch (synchronously, in the capture listener, before anything this
 * click triggers has run) is the baseline; only an *increase* by the time the deferred callback
 * runs means something opened a menu in response to this click.
 *
 * ## The third door: menus Obsidian shows without telling anyone (2026-09-02)
 *
 * Measured in the live app: right-clicking a sidebar tab header opens Obsidian's own menu ("Close",
 * …) and fires **no** workspace event — there is no `tab-header-menu`. The capture listener correctly
 * stood down (a `.menu` appeared), so "Customize…" was simply absent from the one surface the whole
 * launch demo points at. The same is true of ribbon icons, the status bar, view headers and every
 * plugin's own chrome that builds a `Menu` itself. What all of those share is the one call that puts
 * a menu on screen from a right-click: `Menu.prototype.showAtMouseEvent(evt)`. So this file patches
 * that method (through `monkey-around`, the same reclaim contract the supervisor uses on
 * `enablePlugin`), and when the event is a `contextmenu` on an eligible element it appends a
 * separator and "Customize…" before letting the original show the menu. The four event hooks stay
 * (they resolve a better target when Obsidian tells us which leaf/view it is), and a per-menu
 * `WeakSet` guarantees the item lands once however many of the three doors fire for one click. The
 * patch is uninstalled on unload via `host.register`.
 *
 * ## Multi-window
 *
 * A popout is a real `Window`/`Document` pair; `window-open`/`window-close` are Obsidian's
 * documented pair for noticing one arrive and leave. Each window's listener is registered through
 * the plugin's own `registerDomEvent` (so a plugin unload reclaims every window's listener even if
 * it never sees `window-close`) *and* removed immediately on `window-close` — the popout's `Window`
 * object has no reason to keep a listener once the window it belonged to no longer exists. Already
 * -open popouts (a hot-reload restoring windows before this ran) are found once at registration by
 * walking every leaf's `getContainer().win`, the same technique {@link ElementPicker.pickFromElement}
 * uses for its own window-membership check. The one `setTimeout` each right-click schedules is
 * likewise tracked and cleared through `host.register`, on the same footing as every DOM listener
 * this file installs — a plugin disabled mid-decision must not construct a `Menu` a moment later.
 */

import { Menu, Notice, MarkdownView } from "obsidian";
import type { App, Editor, EventRef, MarkdownFileInfo, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { around } from "monkey-around";

import type { PickedTarget } from "../picker/picker";

const ITEM_TITLE = "Customize…";
/** Also used for the ribbon icon in `main.ts` — one mark for the one action, everywhere it appears. */
export const CUSTOMIZE_ICON = "sparkles";

/**
 * modkit's own modal/overlay surfaces — right-clicking inside one of these must never offer
 * "Customize…" on itself (the brief: "do not show it inside modkit's own modals/picker"). Each
 * class is the one its own modal adds to `contentEl` (`ComposeModal`, `ReviewModal`,
 * `progress.ts`'s receipt, the settings tab's `ConfirmModal`/`SourceModal`, the experiments
 * consent modal); `[data-modkit-ui]` is the live pick overlay's own marker (`picker.css.ts`),
 * covered again here in case a future caller reaches this file with `picker.active` already false.
 * Deliberately narrower than "any modal" — Obsidian's own Settings window and every other plugin's
 * modal are real, useful "Customize…" targets this listener exists to reach (see the file header).
 */
const MODKIT_OWN_UI_SELECTOR =
	"[data-modkit-ui], .modkit-compose, .modkit-review, .modkit-receipt, .modkit-settings, .modkit-experiment-consent";

/**
 * The slice of `ElementPicker` this file needs — narrow on purpose, so a test can hand in a fake
 * without building a real picker (which needs a real workspace and DOM layout to resolve anything).
 */
export interface PickSource {
	readonly active: boolean;
	pickFromElement(el: Element): PickedTarget | null;
}

/** The slice of `Component`/`Plugin` this file registers through — see the file header. */
export interface ContextMenuHost {
	registerEvent(eventRef: EventRef): void;
	registerDomEvent(el: Window, type: "contextmenu", callback: (evt: MouseEvent) => void, capture: true): void;
	/** Reclaims the one pending decision timer this file may have in flight — see the file header. */
	register(cb: () => void): void;
}

export interface CustomizeMenuDeps {
	app: App;
	picker: PickSource;
	/** Called with a resolved pick — the compose path itself is not this file's concern. */
	onPicked: (picked: PickedTarget) => void;
}

/**
 * True when Obsidian's own context-menu handling has taken (or is taking) this event — checked
 * from a callback deferred until after the event has finished dispatching; see the file header for
 * why that timing matters. Exported and pure: both checks take exactly what a real
 * `MouseEvent`/`Document`/baseline-count would offer, so a test can hand in plain objects.
 *
 * Two independent signals, either is sufficient:
 * - `evt.defaultPrevented` — the documented way a handler says "I dealt with this event."
 * - the number of `.menu` elements in the document *increased* since `menuCountBefore` was taken —
 *   Obsidian's `Menu` inserts one synchronously when shown, so this catches a menu even from code
 *   that never calls `preventDefault()` itself. A count, not a presence check: a `.menu` left over
 *   from an unrelated, already-open menu must not read as "this click was handled" (see the file
 *   header).
 */
export function obsidianHandledContextMenu(
	evt: { readonly defaultPrevented: boolean },
	doc: { querySelectorAll(selectors: string): { length: number } },
	menuCountBefore: number,
): boolean {
	if (evt.defaultPrevented) return true;
	return doc.querySelectorAll(".menu").length > menuCountBefore;
}

/**
 * Cross-realm-safe "is this actually an element with the methods we need" check — a popout window
 * is a separate realm, so `instanceof Element` can report `false` for a perfectly good element from
 * one (the same reasoning `host.ts` documents for `instanceof Set`).
 */
function asElement(value: unknown): Element | null {
	if (value === null || typeof value !== "object") return null;
	const candidate = value as { closest?: unknown };
	return typeof candidate.closest === "function" ? (value as Element) : null;
}

function containerElOf(candidate: unknown): Element | null {
	if (candidate === null || typeof candidate !== "object") return null;
	return asElement((candidate as { containerEl?: unknown }).containerEl);
}

/**
 * Menus that already carry "Customize…". Three doors can fire for one right-click (a workspace
 * event, the `showAtMouseEvent` patch, our own capture-phase menu); the item must land exactly once.
 * A `WeakSet` so a closed menu is collectable — this file never has to know when a menu is done.
 */
const decorated = new WeakSet<Menu>();

/** True when a right-click on `el` may offer "Customize…" at all. */
function eligibleTarget(el: Element | null, picker: PickSource): el is Element {
	return el !== null && !picker.active && el.closest(MODKIT_OWN_UI_SELECTOR) === null;
}

/** Add the one item every entrance shows, resolving against `el` when it is actually clicked. */
function addCustomizeItem(menu: Menu, deps: CustomizeMenuDeps, el: Element): void {
	if (decorated.has(menu)) return;
	decorated.add(menu);
	menu.addItem((item) => {
		item.setTitle(ITEM_TITLE)
			.setIcon(CUSTOMIZE_ICON)
			.onClick(() => {
				const picked = deps.picker.pickFromElement(el);
				if (picked === null) {
					new Notice('modkit could not resolve that — try "Mod this…" and click it directly.');
					return;
				}
				deps.onPicked(picked);
			});
	});
}

/**
 * Wire every entrance described in the file header onto `host` (the plugin itself, so its own
 * `onunload` reclaims all of it). Call once, from `onload`, gated by the caller on
 * `Platform.isDesktop` — this file has no opinion on platform, it only registers what it is asked
 * to.
 */
export function registerCustomizeContextMenu(host: ContextMenuHost, deps: CustomizeMenuDeps): void {
	const { app } = deps;

	// The raw element under the cursor for the right-click currently (or most recently) dispatching,
	// so the four workspace-menu handlers below can resolve against what was actually clicked rather
	// than a whole view's `containerEl` — see the "which element" note where it is read. Set at the
	// very top of the capture handler (before any of *our* decisions about whether to show a menu),
	// because Obsidian's own bubble-phase handler — the one that fires `editor-menu`/`file-menu`/etc
	// — runs synchronously later in the very same dispatch. Cleared once that dispatch's decision
	// window has passed, so a later, click-less invocation of one of those events (a command, a
	// "more options" button) does not silently inherit a stale element from the last real click.
	let lastContextTarget: Element | null = null;

	/** Resolve a workspace-menu event's target: the actual right-clicked element when we have it. */
	function resolveMenuTarget(fallback: unknown): Element | null {
		return lastContextTarget ?? containerElOf(fallback);
	}

	/* ── The four menus Obsidian already owns ─────────────────────────────── */

	host.registerEvent(
		app.workspace.on("editor-menu", (menu: Menu, _editor: Editor, info: MarkdownFileInfo) => {
			const el = resolveMenuTarget(info);
			if (el !== null) addCustomizeItem(menu, deps, el);
		}),
	);
	host.registerEvent(
		app.workspace.on("file-menu", (menu: Menu, _file: TAbstractFile, _source: string, leaf?: WorkspaceLeaf) => {
			const el = resolveMenuTarget(leaf?.view);
			if (el !== null) addCustomizeItem(menu, deps, el);
		}),
	);
	host.registerEvent(
		app.workspace.on("files-menu", (menu: Menu, _files: TAbstractFile[], _source: string, leaf?: WorkspaceLeaf) => {
			const el = resolveMenuTarget(leaf?.view);
			if (el !== null) addCustomizeItem(menu, deps, el);
		}),
	);
	host.registerEvent(
		// A link carries no leaf of its own; the note it lives in is the closest honest fallback when
		// `lastContextTarget` is unavailable (e.g. this event fired from something other than a click).
		app.workspace.on("url-menu", (menu: Menu, _url: string) => {
			const el = resolveMenuTarget(app.workspace.getActiveViewOfType(MarkdownView) ?? undefined);
			if (el !== null) addCustomizeItem(menu, deps, el);
		}),
	);

	/* ── Menus Obsidian (or any plugin) shows from a right-click without an event ── */

	host.register(
		around(Menu.prototype, {
			showAtMouseEvent(next: Menu["showAtMouseEvent"]) {
				return function (this: Menu, evt: MouseEvent): Menu {
					try {
						// Only a real right-click carries an element worth customizing; a menu shown from a
						// left-click ("more options", a ribbon button) is Obsidian's own affordance and the
						// element under it is the button, not the thing the user means.
						if (evt?.type === "contextmenu" && !decorated.has(this)) {
							const el = asElement(evt.target);
							if (eligibleTarget(el, deps.picker)) {
								this.addSeparator();
								addCustomizeItem(this, deps, el);
							}
						}
					} catch (err) {
						// Never let a decoration failure take Obsidian's own menu down with it.
						console.error("modkit: could not add “Customize…” to a menu", err);
					}
					return next.call(this, evt);
				};
			},
		}),
	);

	/* ── Everything Obsidian does not put a menu on ───────────────────────── */

	// One handler per window, tracked so a window is never double-attached and so `window-close`
	// can detach it immediately rather than waiting for the whole plugin to unload.
	const attached = new Map<Window, (evt: MouseEvent) => void>();

	// Each right-click schedules exactly one `setTimeout(…, 0)` decision; tracked with the window
	// that issued it (never just the bare id — a popout's timer ids are a separate namespace from
	// the main window's, the same hazard `picker.ts`'s idle-timeout documents for `clearInterval`)
	// so `host.register` below can cancel a still-pending one on unload.
	const pendingTimers: { win: Window; id: number }[] = [];

	const attach = (win: Window): void => {
		if (attached.has(win)) return;
		const handler = (evt: MouseEvent): void => {
			const el = asElement(evt.target);

			const eligible = eligibleTarget(el, deps.picker);
			const doc = win.document;
			// Taken now, before anything this click triggers has run — see the file header.
			const menuCountBefore = eligible ? doc.querySelectorAll(".menu").length : 0;

			const timerId = win.setTimeout(() => {
				const at = pendingTimers.findIndex((t) => t.win === win && t.id === timerId);
				if (at !== -1) pendingTimers.splice(at, 1);
				if (lastContextTarget === el) lastContextTarget = null;

				if (!eligible || el === null) return;
				if (obsidianHandledContextMenu(evt, doc, menuCountBefore)) return;
				const menu = new Menu();
				addCustomizeItem(menu, deps, el);
				menu.showAtMouseEvent(evt);
			}, 0);
			pendingTimers.push({ win, id: timerId });

			if (el !== null) lastContextTarget = el;
		};
		attached.set(win, handler);
		host.registerDomEvent(win, "contextmenu", handler, true);
	};

	const detach = (win: Window): void => {
		const handler = attached.get(win);
		if (handler === undefined) return;
		attached.delete(win);
		win.removeEventListener("contextmenu", handler, true);
	};

	attach(window);
	try {
		// `iterateAllLeaves` is documented and stable, but so is `app.plugins` — and `host.ts` treats
		// this whole surface as something that can move under a future Obsidian release. A backfill
		// step that only widens coverage of already-open popouts must not be able to take the rest of
		// `onload` down with it if it does.
		app.workspace.iterateAllLeaves((leaf) => {
			try {
				attach(leaf.getContainer().win);
			} catch {
				// A leaf mid-teardown may throw resolving its container; nothing to attach to either way.
			}
		});
	} catch (err) {
		console.error("modkit: could not enumerate already-open windows for “Customize…”", err);
	}

	host.registerEvent(app.workspace.on("window-open", (_win, openedWindow: Window) => attach(openedWindow)));
	host.registerEvent(app.workspace.on("window-close", (_win, closedWindow: Window) => detach(closedWindow)));

	host.register(() => {
		for (const { win, id } of pendingTimers.splice(0)) {
			try {
				win.clearTimeout(id);
			} catch {
				// The window that issued this timer is already gone; nothing left to cancel.
			}
		}
	});
}
