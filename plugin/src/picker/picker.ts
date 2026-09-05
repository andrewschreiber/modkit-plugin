/**
 * The element picker — the "point at it" half of shake-and-bake.
 *
 * A command puts the app into pick mode; the user moves the mouse and every element under the
 * cursor is outlined and *named*; one click resolves that element to the plugin that owns it and
 * produces a {@link PickedTarget}, which is the evidence the daemon reasons from.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **The underlying UI never receives the click.** Interception is capture-phase on the document,
 *    not a pointer-events shield on the overlay — a shield would also swallow the wheel, and
 *    scrolling to reach the thing you want to pick is half of what the mode is for.
 * 2. **The mode is impossible to get stuck in.** Escape (through a `Scope` *and* a capture-phase
 *    keydown), a visible Cancel button, right-click, an idle timeout, an exception in any handler,
 *    and the plugin unloading all end it. Every acquisition is registered on a per-session
 *    `Component`, so ending it is `removeChild` and the reclaim contract does the rest.
 *
 *    **A pick can happen in a popout window, and a handle issued by one window may only be released
 *    by that same window.** `Component.registerInterval` is *not* window-aware — Obsidian 1.12.7
 *    clears with the bare global `clearInterval` — so it is used nowhere in this file. Anything
 *    obtained from `this.win` (timers, animation frames) is released through
 *    `this.register(() => this.win.<clear>(handle))`; anything obtained from `this.doc` is released
 *    against that same document. `registerDomEvent` remains correct for any window, because it
 *    removes the listener from the very object it added it to.
 * 3. **Attribution is honest.** Obsidian records which plugin registered a view type *nowhere* —
 *    `viewRegistry.viewByType[type]` yields a creator closure, not an id. So this file scores
 *    evidence, reports its confidence, always carries the runners-up, and when it cannot attribute
 *    an element it says so instead of guessing. An element that is not inside a plugin's view is
 *    not a failure either: most Obsidian customization is core patching, and core is offered as the
 *    target with the reason stated.
 *
 * DOM→leaf resolution goes through the **public** `View.containerEl`, not `leaf.containerEl` (not
 * public) and not `el.closest('.workspace-leaf')` (an undocumented CSS class). Deferred leaves are
 * filtered out: a background tab's `view` is a `DeferredView`, so including one resolves a pick to
 * the wrong view type — confidently, which is the worst way to be wrong.
 */

import { Component, Notice, Scope, apiVersion } from "obsidian";
import type { App, PluginManifest, View, WorkspaceLeaf } from "obsidian";
import type { ElementEvidence, PickEvidence, ReachDom, TargetRef } from "@modkit/types";
import { MODKIT_UI_ATTR, PICKER_CLASSES, injectPickerStyles } from "./picker.css";
import type { GeneratedSelector } from "./selector";
import { allStableClasses, clean, describeElement, generateSelector, viewportLabel } from "./selector";

/* ────────────────────────────────────────────────────────────────────────────
 * Tunables
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Minimum size for a pickable element. An earlier app's floor is 28×16 because a thumb cannot do better; a
 * mouse can, so this is much smaller — but not zero, because a 1px spacer div is never the answer
 * to "change this".
 */
const MIN_WIDTH = 10;
const MIN_HEIGHT = 8;

/** Tags worth picking even with no class of their own. */
const SEMANTIC_TAGS: ReadonlySet<string> = new Set([
	"BUTTON",
	"A",
	"INPUT",
	"SELECT",
	"TEXTAREA",
	"IMG",
	"NAV",
	"H1",
	"H2",
	"H3",
	"H4",
	"LI",
	"TD",
	"TH",
	"SUMMARY",
	"LABEL",
]);

/** How far up from the literal hit we may climb looking for something worth picking. */
const MAX_LIFT_HOPS = 5;
/** Two boxes within this many CSS px are "the same box" for wrapper collapsing. */
const COINCIDENT_TOLERANCE_PX = 4;
/** How many coincident wrappers may be collapsed before we stop trusting the outward walk. */
const MAX_COLLAPSE_HOPS = 4;
/** Ancestors recorded in the evidence chain. */
const MAX_ANCESTORS = 8;
/** Attributes recorded per element. */
const MAX_ATTRIBUTES = 14;
/** Command ids carried in the evidence — enough for a plane-D bridge, not a dump of the registry. */
const MAX_COMMAND_IDS = 60;
/** No mouse movement for this long means the mode was abandoned; it closes itself. */
const IDLE_TIMEOUT_MS = 90_000;
const IDLE_CHECK_MS = 5_000;

/**
 * Obsidian's own view types, and the core plugin behind each one where there is one.
 *
 * **The internal-plugin ids are best-effort and UNVERIFIED** — they are Obsidian's core plugin ids
 * as commonly used by community plugins, not something read out of a typed API. They are a *hint*
 * on a core target, never a gate: a wrong hint costs the compose modal one wrong word, which the
 * user can see and correct, and `TargetRef` stays valid as core either way.
 */
const CORE_VIEW_TYPES: ReadonlyMap<string, string | null> = new Map<string, string | null>([
	["markdown", null],
	["empty", null],
	["release-notes", null],
	["pdf", null],
	["image", null],
	["audio", null],
	["video", null],
	["file-explorer", "file-explorer"],
	["search", "global-search"],
	["bookmarks", "bookmarks"],
	["starred", "starred"],
	["tag", "tag-pane"],
	["backlink", "backlink"],
	["outgoing-link", "outgoing-link"],
	["outline", "outline"],
	["graph", "graph"],
	["localgraph", "graph"],
	["canvas", "canvas"],
	["audio-recorder", "audio-recorder"],
	["file-properties", "properties"],
	["all-properties", "properties"],
	["sync", "sync"],
	["webviewer", "webviewer"],
	["bases", "bases"],
]);

/**
 * Which piece of Obsidian's own chrome an element sits in, when it is not inside a leaf.
 *
 * Ordered: the first rule that matches wins, so the settings pane is recognised before the modal it
 * lives inside. These are Obsidian's hand-written, semantic class names — the ones
 * the design notes §6.4 notes are stable in a way a compiled framework's are not — but they are
 * still unversioned, so a miss degrades to `workspace`, never to a crash.
 */
const REGION_RULES: readonly (readonly [string, PickRegion])[] = [
	[".vertical-tab-content-container, .vertical-tab-header, .setting-item", "settings"],
	[".menu, .suggestion-container, .prompt", "menu"],
	[".modal, .modal-container", "modal"],
	[".status-bar", "status-bar"],
	[".workspace-ribbon, .side-dock-ribbon", "ribbon"],
	[".workspace-tab-header-container, .workspace-tab-header", "tab-header"],
	[".titlebar", "titlebar"],
	[".workspace-leaf", "leaf"],
	[".workspace, .app-container", "workspace"],
];

/** Human labels for a region, for the resolved-target line. */
const REGION_LABELS: Record<PickRegion, string> = {
	leaf: "a pane",
	ribbon: "the ribbon",
	"status-bar": "the status bar",
	"tab-header": "a tab header",
	titlebar: "the window frame",
	modal: "a dialog",
	menu: "a menu",
	settings: "the settings pane",
	workspace: "the workspace chrome",
	unknown: "an unidentified part of the UI",
};

/* ────────────────────────────────────────────────────────────────────────────
 * Public shapes
 * ──────────────────────────────────────────────────────────────────────────── */

export type PickRegion =
	| "leaf"
	| "ribbon"
	| "status-bar"
	| "tab-header"
	| "titlebar"
	| "modal"
	| "menu"
	| "settings"
	| "workspace"
	| "unknown";

/** Why pick mode ended. `picked` is the only one that carries a target. */
export type PickEndReason = "picked" | "escape" | "cancel" | "timeout" | "unloaded" | "error";

export type OwnerKind = "plugin" | "core" | "unknown";
export type OwnerConfidence = "high" | "medium" | "low";

/** A plugin that might own the picked element, with the evidence that put it here. */
export interface OwnerCandidate {
	pluginId: string;
	pluginName: string;
	version: string;
	/** 0–100. See {@link scoreOwners} for what each rung means. */
	score: number;
	/** The specific evidence, e.g. `the view type "tasks-view" names this plugin`. */
	why: string;
}

/**
 * Who owns the picked element.
 *
 * `candidates` is always populated, even when `kind` is `plugin` and confidence is `high` — the
 * compose modal shows what was resolved *and* what else it could have been, because a wrong target
 * caught before the user types costs nothing and a wrong target caught after costs a generation.
 */
export interface ResolvedOwner {
	kind: OwnerKind;
	confidence: OwnerConfidence;
	/** One sentence, in the user's terms, naming what was resolved and on what evidence. */
	why: string;
	/** Short label for the highlight chip and the modal's target row. */
	summary: string;
	candidates: OwnerCandidate[];
	pluginId?: string;
	pluginName?: string;
	pluginVersion?: string;
	/** Best-effort core internal plugin id — see {@link CORE_VIEW_TYPES}. */
	internalPluginId?: string;
}

/** The picked node itself, described for a reader who cannot see the screen. */
export interface PickedElementInfo {
	tag: string;
	id: string;
	classes: string[];
	/** Sanitised, capped `textContent`. */
	text: string;
	/** `aria-label` / `placeholder` / `alt` / `title`, sanitised. */
	label: string;
	/** Everything else worth knowing, sanitised and capped. `class`/`style` excluded (they are above). */
	attributes: Record<string, string>;
}

export interface PickedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One link in the ancestor chain, nearest first. */
export interface AncestorInfo {
	tag: string;
	id: string;
	classes: string[];
	/** True when this ancestor occupies the same box as the picked element — i.e. a bare wrapper. */
	sameBox: boolean;
	/** Set when the ancestor is one of Obsidian's structural landmarks. */
	region?: PickRegion;
}

/** The leaf the element resolved into. Never a deferred one. */
export interface PickedView {
	type: string;
	displayText: string;
	/** Whether this view type is one of Obsidian's own. */
	core: boolean;
}

/**
 * Everything one pick produced. This is what the compose modal shows and what the daemon reasons
 * from, so it captures generously: the model can ignore a field, but it cannot invent one.
 */
export interface PickedTarget {
	/** ISO-8601 UTC. */
	pickedAt: string;
	/** `"1440x900"` — a rect means nothing without the viewport it was measured in. */
	viewport: string;
	element: PickedElementInfo;
	rect: PickedRect;
	ancestors: AncestorInfo[];
	/** `null` when no selector could be generated at all (a detached node). */
	selector: GeneratedSelector | null;
	/** The same node in the shared wire shape, ready to go into a `GenerateRequest`. */
	evidence: ElementEvidence;
	view: PickedView | null;
	region: PickRegion;
	owner: ResolvedOwner;
	/** Ready for `GenerateRequest.target`. Core when no plugin could be attributed. */
	target: TargetRef;
	/** Advisory plane-E reach, present when a selector was generated. The daemon may choose otherwise. */
	reach?: ReachDom;
	/** One line for the modal's resolved-target row, e.g. `Tasks 7.21.0 · tasks-view`. */
	summary: string;
}

export interface PickerOptions {
	/** Instruction shown in the pick bar. */
	prompt?: string;
	/** Extra selectors to treat as un-pickable chrome (a modal the caller left open, say). */
	ignore?: readonly string[];
	/** Called when the mode ends, with the reason, whether or not anything was picked. */
	onEnd?: (reason: PickEndReason, target: PickedTarget | null) => void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The picker
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Owns at most one live pick session.
 *
 * Construct once (in the plugin's `onload`) and keep it: `pick()` is the whole API, and the session
 * it creates is a child `Component`, so the plugin unloading tears the overlay down for free.
 */
export class ElementPicker {
	private session: PickSession | null = null;

	constructor(
		private readonly app: App,
		/** The plugin (or any loaded `Component`) whose lifetime bounds a pick session. */
		private readonly owner: Component,
	) {}

	get active(): boolean {
		return this.session !== null;
	}

	/**
	 * Enter pick mode. Resolves with the picked target, or `null` if the user cancelled — which is a
	 * normal outcome, not an error, and callers should treat it as "they changed their mind".
	 *
	 * Starting a pick while one is running cancels the first: two overlays would fight over the same
	 * capture-phase listeners, and the second would be the one the user is looking at.
	 */
	pick(options: PickerOptions = {}): Promise<PickedTarget | null> {
		this.cancel();
		return new Promise<PickedTarget | null>((resolve) => {
			const session = new PickSession(this.app, options, (target, reason) => {
				this.session = null;
				try {
					options.onEnd?.(reason, target);
				} catch (err) {
					console.error("modkit: a picker onEnd handler threw", err);
				}
				resolve(target);
			});
			this.session = session;
			// Release is armed BEFORE the session loads, because `addChild` runs `onload` synchronously
			// and a session that ended during its own load would otherwise have no way to unmount.
			session.setRelease(() => {
				this.owner.removeChild(session);
			});
			// addChild loads it immediately (the owner is loaded), and removeChild unloads it — which
			// is how every listener, the scope, the stylesheet and the overlay get reclaimed.
			this.owner.addChild(session);
		});
	}

	/** End any live session. Safe to call when nothing is running. */
	cancel(reason: PickEndReason = "cancel"): void {
		this.session?.finish(null, reason);
		this.session = null;
	}

	/**
	 * Fold picks into the shared `PickEvidence` shape for a `GenerateRequest`.
	 *
	 * `commandIds` is filled from the registry for whichever plugins were resolved: many plugin
	 * behaviours are module-local free functions installed as command callbacks with no prototype
	 * handle at all, so the command ids are frequently the *only* route to the thing the user is
	 * pointing at.
	 */
	buildEvidence(picks: readonly PickedTarget[]): PickEvidence {
		const evidence: PickEvidence = { elements: picks.map((p) => p.evidence) };

		const first = picks[0];
		if (first !== undefined) {
			evidence.viewport = first.viewport;
			if (first.view !== null) evidence.viewType = first.view.type;
		}

		const pluginIds = new Set<string>();
		for (const pick of picks) {
			if (pick.target.kind === "plugin") pluginIds.add(pick.target.pluginId);
		}
		if (pluginIds.size > 0) {
			const registry = this.app.commands?.commands;
			if (registry !== undefined) {
				const ids: string[] = [];
				for (const id of Object.keys(registry)) {
					const separator = id.indexOf(":");
					if (separator <= 0) continue;
					if (pluginIds.has(id.slice(0, separator)) && ids.length < MAX_COMMAND_IDS) ids.push(id);
				}
				if (ids.length > 0) evidence.commandIds = ids;
			}
		}
		return evidence;
	}

	/**
	 * Resolve one element to a {@link PickedTarget} without running a pick session at all — the
	 * entry point for "Customize…" (L4's context menu, L5's ribbon icon on mobile), which already
	 * knows what was right-clicked or tapped and only needs the same resolution a live pick applies
	 * to its click.
	 *
	 * **Guarded, not trusted.** The caller hands us whatever `evt.target` (or a touch target) was at
	 * the time, and by the time this runs — after a menu opens, after a tap's event loop turn — that
	 * node may have left the DOM, or belong to a window Obsidian never opened (another plugin's own
	 * floating UI, a detached fragment). Feeding either into `buildPickedTarget` would produce a
	 * `PickedRect` and a leaf lookup that describe nothing real, silently. So: `isConnected` first,
	 * then membership in an actual Obsidian window — checked by walking every leaf's own
	 * `getContainer().win` (`WorkspaceRoot` for the main window, `WorkspaceWindow` per popout; those
	 * are the only two containers a leaf can have) rather than trusting `el`'s document at face
	 * value.
	 *
	 * **Delegates to `PickSession.normalizeCandidate` then `buildPickedTarget`** — the exact two
	 * steps a live pick already runs after its click (`candidateAt` does the same
	 * `isOurChrome`-then-`normalizeCandidate` in that order). Skipping `normalizeCandidate` was an
	 * earlier bug in this method: a raw `evt.target` from a real right-click is very often the
	 * eleventh `<path>` inside an icon's `<svg>`, or a bare unclassed text node `isPickable` would
	 * have walked up past — feeding either straight into `buildPickedTarget` silently picks the
	 * wrong element instead of the button or paragraph the user meant. `normalizeCandidate` is what
	 * lifts out of the svg, walks up to something `isPickable`, collapses coincident wrappers, and
	 * refuses modkit's own chrome — the same journey `candidateAt` takes a mouse coordinate on.
	 * `pickFromElement` skips only `candidateAt`'s hit-test itself, since the caller already has a
	 * concrete element, not a point.
	 *
	 * The session built here is never `load()`ed: `buildOverlay`/`installInterception`/every
	 * listener live in `onload()`, which is never called, so this shows no UI and registers nothing
	 * that would need tearing down — it exists only to reach `refreshLeaves`/`normalizeCandidate`/
	 * `buildPickedTarget` on the one instance that owns them. Reached through a typed cast rather
	 * than a visibility change on `PickSession` itself, because another lane is mid-edit on this
	 * file's selector/session internals and a signature change is exactly the kind of touch that
	 * would conflict with it.
	 */
	pickFromElement(el: Element): PickedTarget | null {
		try {
			if (!el.isConnected) return null;
			const win = el.ownerDocument.defaultView;
			if (win === null) return null;

			let known = false;
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (known) return;
				try {
					if (leaf.getContainer().win === win) known = true;
				} catch {
					// A leaf mid-teardown may throw resolving its container; it is not evidence either way.
				}
			});
			if (!known) return null;

			const session = new PickSession(this.app, {}, () => {});
			const internals = session as unknown as {
				refreshLeaves(): void;
				normalizeCandidate(el: Element): Element | null;
				buildPickedTarget(el: Element): PickedTarget;
			};
			internals.refreshLeaves();
			const normalized = internals.normalizeCandidate(el);
			if (normalized === null) return null;
			return internals.buildPickedTarget(normalized);
		} catch (err) {
			// Called synchronously from a menu item's onClick (contextmenu.ts) — a refusal here must
			// read the same as "nothing under the cursor" to that caller, never as an uncaught throw
			// out of a click handler.
			console.error("modkit: pickFromElement could not resolve the given element", err);
			return null;
		}
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * One pick session
 * ──────────────────────────────────────────────────────────────────────────── */

/** A non-deferred leaf and the public handles the picker resolves through. */
export interface LeafSnapshot {
	leaf: WorkspaceLeaf;
	view: View;
	containerEl: HTMLElement;
	viewType: string;
}

/** One installed plugin, reduced to what attribution needs. */
export interface PluginEntry {
	id: string;
	name: string;
	version: string;
	/** `obsidian-tasks-plugin` → `tasks`. The token a plugin actually names its classes after. */
	slug: string;
}

class PickSession extends Component {
	private readonly doc: Document;
	private readonly win: Window;

	private layer: HTMLDivElement | null = null;
	private boxEl: HTMLDivElement | null = null;
	private labelEl: HTMLDivElement | null = null;
	private labelNameEl: HTMLSpanElement | null = null;
	private labelSelEl: HTMLSpanElement | null = null;

	private leaves: LeafSnapshot[] = [];
	private pluginsIndex: PluginEntry[] | null = null;

	private pointer: { x: number; y: number } | null = null;
	/**
	 * The touch currently driving the pick, by `pointerId` — `null` when no finger is down. Obsidian
	 * mobile has no hover, so a touch has to stand in for both the highlight (moved on
	 * `pointermove`) and the commit (on `pointerup`, since a synthetic "click" never arrives — see
	 * `installInterception`). Tracked by id rather than "is any touch down" so a second finger
	 * landing mid-drag cannot hijack the pick.
	 */
	private touchId: number | null = null;
	private hovered: Element | null = null;
	private hoveredOwner: ResolvedOwner | null = null;
	private frame = 0;
	private lastActivity = Date.now();
	private settled = false;
	private release: (() => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly options: PickerOptions,
		private readonly onDone: (target: PickedTarget | null, reason: PickEndReason) => void,
	) {
		super();
		// `activeDocument` is the documented global and the popout-window-correct one; a picker that
		// assumed `document` would draw its overlay in the main window while the user points at a
		// popout.
		this.doc = typeof activeDocument !== "undefined" ? activeDocument : document;
		this.win = this.doc.defaultView ?? window;
	}

	setRelease(release: () => void): void {
		this.release = release;
	}

	override onload(): void {
		injectPickerStyles(this, this.doc);
		this.buildOverlay();
		this.refreshLeaves();

		// The layout can change under a pick (a sync finishes, a plugin opens a pane), and a stale
		// snapshot resolves to a leaf that is no longer there.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshLeaves()));

		this.installInterception();
		this.installEscape();
		this.installIdleTimeout();

		this.doc.body.addClass(PICKER_CLASSES.bodyActive);
		this.register(() => this.doc.body.removeClass(PICKER_CLASSES.bodyActive));

		this.schedulePaint();
	}

	override onunload(): void {
		if (this.frame !== 0) {
			const frame = this.frame;
			this.frame = 0;
			this.onWin("cancelAnimationFrame", (win) => win.cancelAnimationFrame(frame));
		}
		this.layer?.remove();
		this.layer = null;
		// Unloaded without a decision — the plugin is going away, or someone called removeChild
		// directly. Settle the promise rather than leaving the caller awaiting forever, and drop the
		// release first: we are already inside the unload it would trigger.
		this.release = null;
		this.finish(null, "unloaded");
	}

	/**
	 * End the session exactly once.
	 *
	 * Ordering matters: `settled` is set before anything else, so the `onunload` that `release()`
	 * triggers re-enters here and returns immediately; and the overlay is torn down *before* the
	 * callback runs, so a caller that opens a modal does not open it underneath a live picker.
	 */
	finish(target: PickedTarget | null, reason: PickEndReason): void {
		if (this.settled) return;
		this.settled = true;
		const release = this.release;
		this.release = null;
		try {
			release?.();
		} catch (err) {
			console.error("modkit: releasing the pick session failed", err);
		}
		this.onDone(target, reason);
	}

	/* ── overlay ─────────────────────────────────────────────────────────── */

	private buildOverlay(): void {
		const layer = this.doc.body.createDiv({
			cls: PICKER_CLASSES.layer,
			attr: { [MODKIT_UI_ATTR]: "picker" },
		});
		this.layer = layer;
		this.register(() => layer.remove());

		this.boxEl = layer.createDiv({ cls: PICKER_CLASSES.box });
		this.boxEl.hidden = true;

		this.labelEl = layer.createDiv({ cls: PICKER_CLASSES.label });
		this.labelNameEl = this.labelEl.createSpan({ cls: PICKER_CLASSES.labelName });
		this.labelSelEl = this.labelEl.createSpan({ cls: PICKER_CLASSES.labelSel });
		this.labelEl.hidden = true;

		const bar = layer.createDiv({ cls: PICKER_CLASSES.bar, attr: { [MODKIT_UI_ATTR]: "picker-bar" } });
		bar.createSpan({ cls: PICKER_CLASSES.barText, text: this.options.prompt ?? "Click the thing you want to mod" });
		const hint = bar.createSpan({ cls: PICKER_CLASSES.barHint });
		hint.createSpan({ cls: PICKER_CLASSES.barKey, text: "Esc" });
		hint.appendText(" or right-click to cancel");
		const cancel = bar.createEl("button", { cls: PICKER_CLASSES.barCancel, text: "Cancel" });
		this.registerDomEvent(cancel, "click", (evt: MouseEvent) => {
			evt.preventDefault();
			this.finish(null, "cancel");
		});
	}

	/* ── interception ────────────────────────────────────────────────────── */

	/**
	 * Everything that could reach the app is caught on the WINDOW in the CAPTURE phase — the first
	 * node in the propagation path, so it is earlier than the document, earlier than the workspace,
	 * and earlier than every listener the app or another plugin has on an inner element.
	 * `stopImmediatePropagation` is included because we are not the only capture-phase listener in a
	 * vault full of plugins, and "the click was mostly intercepted" is not a state worth having.
	 *
	 * Wheel and scroll are deliberately NOT swallowed: reaching something below the fold is part of
	 * pointing at it. That is a mouse-only claim now — `picker.css.ts` sets `touch-action: none` on
	 * the picking body class, which is what stops a scan-drag from being mistaken for a pane-scroll
	 * (review finding, PLAN.md 2026-09-02), and the trade is that a touch pick genuinely cannot reach
	 * an off-screen element mid-pick; scroll first, then start pointing.
	 *
	 * `pointerdown`/`pointerup` get their own listeners rather than joining the generic swallow list
	 * below, because touch needs them to do more than swallow. Obsidian mobile has no hover, so
	 * there is no `mousemove` to paint a highlight from, and calling `preventDefault()` on a touch's
	 * `pointerdown` — which every browser's spec requires for "the underlying UI never receives the
	 * tap" — also cancels the synthetic `mousedown`/`mouseup`/`click` sequence a browser would
	 * otherwise synthesise from that touch. So for `pointerType === "touch"`, `pointermove` stands in
	 * for hover and `pointerup` stands in for the click that will never arrive; for mouse and pen
	 * (whose real `click` does still fire) the three do exactly what the old blanket swallow did.
	 */
	private installInterception(): void {
		const swallowed = ["mousedown", "mouseup", "dblclick", "auxclick"] as const;
		for (const type of swallowed) {
			this.registerDomEvent(this.win, type, this.guard((evt: Event) => this.swallowUnlessOurs(evt)), true);
		}

		this.registerDomEvent(
			this.win,
			"pointerdown",
			this.guard((evt: PointerEvent) => {
				if (this.isOurChrome(evt.target)) return;
				this.swallow(evt);
				if (evt.pointerType !== "touch") return;
				this.touchId = evt.pointerId;
				this.pointer = { x: evt.clientX, y: evt.clientY };
				this.lastActivity = Date.now();
				this.schedulePaint();
			}),
			true,
		);

		this.registerDomEvent(
			this.win,
			"pointermove",
			this.guard((evt: PointerEvent) => {
				if (evt.pointerType !== "touch" || evt.pointerId !== this.touchId) return;
				// Implicit pointer capture (Pointer Events §10) pins `evt.target` to the pointerdown
				// element for every later event on this touch, no matter where the finger actually is —
				// so a real hit test at the current coordinates is the only honest way to ask "is the
				// finger over our own chrome right now" (review finding, PLAN.md 2026-09-02). Without
				// it, dragging onto the bar after starting elsewhere would still update `this.pointer`
				// and paint the highlight through the bar.
				if (this.isOurChrome(this.doc.elementFromPoint(evt.clientX, evt.clientY))) return;
				this.swallow(evt);
				this.pointer = { x: evt.clientX, y: evt.clientY };
				this.lastActivity = Date.now();
				this.schedulePaint();
			}),
			true,
		);

		this.registerDomEvent(
			this.win,
			"pointerup",
			this.guard((evt: PointerEvent) => {
				if (evt.pointerType === "touch" && evt.pointerId === this.touchId) {
					// Same implicit-capture problem as `pointermove` above, and it is not cosmetic here:
					// `evt.target` still names wherever the finger went *down*, so a lift over Cancel
					// read as "not our chrome" and fell through to `commitPick`, which hit-tests the
					// coordinates anyway and returns whatever sits *underneath* the bar — a pick of
					// something the user never pointed at (review finding, PLAN.md 2026-09-02). The real
					// hit test at the lift point is what a mouse's accurate `evt.target` gives the branch
					// below for free.
					this.swallow(evt);
					this.touchId = null;
					if (this.isOurChrome(this.doc.elementFromPoint(evt.clientX, evt.clientY))) return;
					// The tap itself: on touch there is no synthetic `click` to hang this off (see the
					// class docblock), so `pointerup` is the commit. `commitPick` re-derives the
					// candidate at these coordinates rather than trusting `this.hovered`.
					this.commitPick(evt.clientX, evt.clientY);
					return;
				}
				if (this.isOurChrome(evt.target)) return;
				this.swallow(evt);
			}),
			true,
		);

		// A tap that turns into a scroll, or an interrupted gesture — Obsidian or the OS can cancel a
		// pointer at any time. Drop the tracked id without committing: an uncommitted gesture is
		// "they changed their mind", never a pick.
		this.registerDomEvent(
			this.win,
			"pointercancel",
			this.guard((evt: PointerEvent) => {
				if (evt.pointerType === "touch" && evt.pointerId === this.touchId) this.touchId = null;
			}),
			true,
		);

		this.registerDomEvent(
			this.win,
			"click",
			this.guard((evt: MouseEvent) => {
				if (this.isOurChrome(evt.target)) return; // let the Cancel button's own handler run
				this.swallow(evt);
				this.commitPick(evt.clientX, evt.clientY);
			}),
			true,
		);

		this.registerDomEvent(
			this.win,
			"contextmenu",
			this.guard((evt: MouseEvent) => {
				this.swallow(evt);
				this.finish(null, "cancel");
			}),
			true,
		);

		this.registerDomEvent(
			this.win,
			"mousemove",
			this.guard((evt: MouseEvent) => {
				this.pointer = { x: evt.clientX, y: evt.clientY };
				this.lastActivity = Date.now();
				this.schedulePaint();
			}),
			true,
		);

		// Geometry changes without the pointer moving. Capture-phase and passive: a scroll event does
		// not bubble, so capture is the only way to hear an inner pane scroll from up here.
		this.registerDomEvent(this.win, "scroll", this.guard(() => this.schedulePaint()), { capture: true, passive: true });
		this.registerDomEvent(this.win, "resize", this.guard(() => this.schedulePaint()), { passive: true });
	}

	private installEscape(): void {
		// Obsidian's own primitive first: a Scope is how the app itself models "this UI owns Escape".
		const scope = new Scope();
		scope.register([], "Escape", () => {
			this.finish(null, "escape");
			return false;
		});
		this.app.keymap.pushScope(scope);
		this.register(() => this.app.keymap.popScope(scope));

		// …and a capture-phase backstop, because a Scope only wins if the app's keymap is the thing
		// receiving the key, and an editor or a foreign plugin may have taken it first.
		this.registerDomEvent(
			this.win,
			"keydown",
			this.guard((evt: KeyboardEvent) => {
				if (evt.key !== "Escape") return;
				this.swallow(evt);
				this.finish(null, "escape");
			}),
			true,
		);
	}

	/**
	 * A last resort against a mode nobody is in any more: no mouse movement for 90 seconds and the
	 * overlay closes itself, saying why. Nothing should ever reach this — it exists because "the
	 * picker is stuck" must not be a state the user can be left in by a bug we have not found yet.
	 */
	private installIdleTimeout(): void {
		// NOT `registerInterval`. Obsidian's implementation (verified against 1.12.7's own bundle)
		// clears the id with the BARE GLOBAL `clearInterval` — the main window's. A timer created on a
		// popout `window` therefore (a) never gets cleared, so the mode's watchdog outlives the mode,
		// and (b) hands a foreign numeric id to the main window's `clearInterval`, where the id spaces
		// are independent and it cancels whatever unrelated timer happens to hold that number. The
		// second half is the dangerous one, and it is silent.
		//
		// So a foreign-window handle is cleared on the window that issued it, which is the same shape
		// `onunload` already uses for `cancelAnimationFrame`.
		const id = this.win.setInterval(() => {
			if (Date.now() - this.lastActivity < IDLE_TIMEOUT_MS) return;
			new Notice("Stopped picking after 90 seconds of no activity.");
			this.finish(null, "timeout");
		}, IDLE_CHECK_MS);
		this.register(() => this.onWin("clearInterval", (win) => win.clearInterval(id)));
	}

	/**
	 * Release a handle on the window that issued it, tolerating that window having gone.
	 *
	 * The user can close the popout the pick started in, and reaching into a torn-down realm can
	 * throw. Obsidian runs teardown callbacks in a bare loop, so one throwing would abandon every
	 * teardown queued behind it — the overlay, the body class, the Scope. Nothing is swallowed
	 * silently: it is reported, and the rest of the reclaim still runs.
	 */
	private onWin(what: string, release: (win: Window) => void): void {
		try {
			release(this.win);
		} catch (err) {
			console.error(`modkit: ${what} on the pick session's window failed (was it a closed popout?)`, err);
		}
	}

	private swallow(evt: Event): void {
		evt.preventDefault();
		evt.stopPropagation();
		evt.stopImmediatePropagation();
	}

	private swallowUnlessOurs(evt: Event): void {
		if (this.isOurChrome(evt.target)) return;
		this.swallow(evt);
	}

	/**
	 * Never throw out of a DOM handler. An exception escaping into the event loop would leave the
	 * overlay mounted with no way out, which is precisely the failure this file promises cannot
	 * happen — so an error ends the mode and says so.
	 */
	private guard<E extends Event = Event>(fn: (evt: E) => void): (evt: E) => void {
		return (evt: E) => {
			try {
				fn(evt);
			} catch (err) {
				console.error("modkit: the element picker failed and closed", err);
				new Notice("The picker hit an error and closed. There is more in the console.");
				this.finish(null, "error");
			}
		};
	}

	/**
	 * Duck-typed rather than `instanceof Element`: an Obsidian popout window is a separate realm with
	 * its own `Element` constructor, so `instanceof` reports false for a perfectly good element and
	 * the picker would start swallowing its own Cancel button.
	 */
	private isOurChrome(target: EventTarget | Element | null): boolean {
		const el = target as Element | null;
		if (el === null || typeof el.closest !== "function") return false;
		if (el.closest(`[${MODKIT_UI_ATTR}]`) !== null) return true;
		for (const selector of this.options.ignore ?? []) {
			try {
				if (el.closest(selector) !== null) return true;
			} catch {
				// A caller's bad selector must not make the whole picker unusable.
			}
		}
		return false;
	}

	/* ── painting ────────────────────────────────────────────────────────── */

	/** Events request frames; frames never request frames. With no events, nothing runs. */
	private schedulePaint(): void {
		if (this.frame !== 0 || this.settled) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = 0;
			try {
				this.paint();
			} catch (err) {
				console.error("modkit: painting the pick overlay failed", err);
			}
		});
	}

	private paint(): void {
		const box = this.boxEl;
		const label = this.labelEl;
		if (box === null || label === null) return;

		const pointer = this.pointer;
		const candidate = pointer === null ? null : this.candidateAt(pointer.x, pointer.y);

		if (candidate !== this.hovered) {
			this.hovered = candidate;
			this.hoveredOwner = candidate === null ? null : this.resolveOwner(candidate);
		}

		const el = this.hovered;
		if (el === null || !el.isConnected) {
			box.hidden = true;
			label.hidden = true;
			return;
		}

		const rect = el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			box.hidden = true;
			label.hidden = true;
			return;
		}

		const unresolved = this.hoveredOwner === null || this.hoveredOwner.kind === "unknown";
		box.hidden = false;
		box.toggleClass(PICKER_CLASSES.unresolved, unresolved);
		box.style.transform = `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0)`;
		box.style.width = `${Math.round(rect.width)}px`;
		box.style.height = `${Math.round(rect.height)}px`;

		if (this.labelNameEl !== null && this.labelSelEl !== null) {
			this.labelNameEl.setText(this.hoveredOwner?.summary ?? "Unresolved");
			this.labelSelEl.setText(describeTag(el));
		}
		label.hidden = false;
		label.toggleClass(PICKER_CLASSES.unresolved, unresolved);

		// Above the box by preference, below when there is no room, and always inside the viewport:
		// a chip that names the target is useless if it is off-screen.
		const labelWidth = label.offsetWidth;
		const labelHeight = label.offsetHeight;
		const above = rect.top - labelHeight - 6;
		const top = above >= 4 ? above : Math.min(rect.bottom + 6, this.win.innerHeight - labelHeight - 4);
		const left = Math.max(4, Math.min(rect.left, this.win.innerWidth - labelWidth - 4));
		label.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.max(4, top))}px, 0)`;
	}

	/* ── hit testing ─────────────────────────────────────────────────────── */

	/**
	 * What would a click here pick?
	 *
	 * `elementsFromPoint` (plural) returns the whole stack, topmost first. Taking the first entry
	 * that survives the candidate filter is what makes a click land on `button.clickable-icon`
	 * rather than on the bare `<path>` inside its icon that the cursor is literally over.
	 */
	private candidateAt(x: number, y: number): Element | null {
		const stack: Element[] =
			typeof this.doc.elementsFromPoint === "function"
				? this.doc.elementsFromPoint(x, y)
				: ([this.doc.elementFromPoint(x, y)].filter((el): el is Element => el !== null) as Element[]);

		for (const el of stack) {
			if (this.isOurChrome(el)) continue;
			const normalized = this.normalizeCandidate(el);
			if (normalized !== null) return normalized;
		}
		return null;
	}

	/** Lift a raw hit to the nearest thing worth naming, then out of any coincident wrappers. */
	private normalizeCandidate(start: Element): Element | null {
		let el: Element | null = start;

		// You want the button, not its eleventh <path>.
		const svg = el.closest("svg");
		if (svg !== null) el = svg.parentElement;

		let hops = 0;
		while (el !== null && hops <= MAX_LIFT_HOPS) {
			if (this.isOurChrome(el)) return null;
			if (isPickable(el)) return collapseCoincident(el);
			el = el.parentElement;
			hops += 1;
		}
		return null;
	}

	/* ── resolution ──────────────────────────────────────────────────────── */

	private refreshLeaves(): void {
		const snapshots: LeafSnapshot[] = [];
		try {
			this.app.workspace.iterateAllLeaves((leaf) => {
				// A deferred leaf's `view` is a DeferredView, so its view type is not the one the user
				// is looking at. Including it is how a background tab resolves to the wrong plugin.
				if (leaf.isDeferred) return;
				const view: View | undefined = leaf.view;
				if (view === undefined) return;
				// Duck-typed for the same cross-realm reason as `isOurChrome`: a popout window's
				// elements are not `instanceof` this realm's `HTMLElement`.
				const containerEl: HTMLElement | undefined = view.containerEl;
				if (containerEl === undefined || typeof containerEl.contains !== "function") return;
				let viewType = "";
				try {
					viewType = view.getViewType();
				} catch {
					// A view whose getViewType throws is not one we can name; keep the leaf anyway, as
					// its container still tells us the element is inside *a* pane.
				}
				snapshots.push({ leaf, view, containerEl, viewType });
			});
		} catch (err) {
			console.error("modkit: enumerating workspace leaves failed", err);
		}
		this.leaves = snapshots;
	}

	private leafFor(el: Element): LeafSnapshot | null {
		for (const snapshot of this.leaves) {
			if (snapshot.containerEl.contains(el)) return snapshot;
		}
		return null;
	}

	/** Installed plugins, read once per session — manifests do not change mid-pick. */
	private pluginIndex(): PluginEntry[] {
		if (this.pluginsIndex !== null) return this.pluginsIndex;
		const entries: PluginEntry[] = [];
		const manifests = this.app.plugins?.manifests;
		if (manifests !== undefined) {
			for (const id of Object.keys(manifests)) {
				const manifest: PluginManifest | undefined = manifests[id];
				if (manifest === undefined) continue;
				entries.push({
					id: manifest.id ?? id,
					name: manifest.name ?? id,
					version: manifest.version ?? "",
					slug: pluginSlug(manifest.id ?? id),
				});
			}
		}
		this.pluginsIndex = entries;
		return entries;
	}

	private resolveOwner(el: Element): ResolvedOwner {
		try {
			return resolveOwnerFor(el, this.leafFor(el), regionOf(el), this.pluginIndex());
		} catch (err) {
			console.error("modkit: resolving the picked element's owner failed", err);
			return {
				kind: "unknown",
				confidence: "low",
				why: "modkit could not work out what owns this element — pick the target plugin yourself.",
				summary: "Unresolved",
				candidates: [],
			};
		}
	}

	/* ── committing a pick ───────────────────────────────────────────────── */

	private commitPick(x: number, y: number): void {
		const el = this.candidateAt(x, y);
		if (el === null) {
			// Nothing pickable under the cursor. The highlight already showed that (no outline), so
			// silently ignoring the click is consistent with what the user is looking at.
			return;
		}
		const target = this.buildPickedTarget(el);
		this.finish(target, "picked");
	}

	private buildPickedTarget(el: Element): PickedTarget {
		const leaf = this.leafFor(el);
		const region = regionOf(el);
		const owner = this.resolveOwner(el);

		// Scope the selector to the leaf's own container when there is one: shorter, more robust, and
		// it is the scope a mod for that view would naturally run in.
		const selector = generateSelector(el, leaf === null ? {} : { root: leaf.containerEl });
		const evidence: ElementEvidence = describeElement(
			el,
			selector === null ? {} : { selector: selector.selector },
		);

		const rect = el.getBoundingClientRect();
		const view: PickedView | null =
			leaf === null
				? null
				: {
						type: leaf.viewType,
						displayText: safeDisplayText(leaf.view),
						core: CORE_VIEW_TYPES.has(leaf.viewType),
					};

		let target: TargetRef;
		if (owner.kind === "plugin" && owner.pluginId !== undefined) {
			const plugin: Extract<TargetRef, { kind: "plugin" }> = {
				kind: "plugin",
				pluginId: owner.pluginId,
				pluginVersion: owner.pluginVersion ?? "",
			};
			if (owner.pluginName !== undefined) plugin.pluginName = owner.pluginName;
			target = plugin;
		} else {
			const core: Extract<TargetRef, { kind: "core" }> = { kind: "core", appVersion: apiVersion };
			if (owner.internalPluginId !== undefined) core.internalPluginId = owner.internalPluginId;
			target = core;
		}

		const picked: PickedTarget = {
			pickedAt: new Date().toISOString(),
			viewport: viewportLabel(this.win),
			element: describeElementInfo(el, evidence),
			rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
			ancestors: describeAncestors(el, rect),
			selector,
			evidence,
			view,
			region,
			owner,
			target,
			summary: `${owner.summary}${view === null ? "" : ` · ${view.type}`}`,
		};

		if (selector !== null) {
			const reach: ReachDom = { plane: "E", selector: selector.selector, mode: "css" };
			if (view !== null) reach.viewType = view.type;
			picked.reach = reach;
		}
		return picked;
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pure helpers — no session state, so they are testable on their own
 * ──────────────────────────────────────────────────────────────────────────── */

/** Is this element worth offering as a target at all? */
function isPickable(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return false;
	const win = el.ownerDocument.defaultView;
	if (win !== null) {
		if (rect.bottom <= 0 || rect.top >= win.innerHeight) return false;
		if (rect.right <= 0 || rect.left >= win.innerWidth) return false;
	}
	// `checkVisibility` is not in every lib.dom we may compile against, and it is the only cheap way
	// to catch `content-visibility` and `visibility: hidden`.
	const check = (el as { checkVisibility?: () => boolean }).checkVisibility;
	if (typeof check === "function" && check.call(el) === false) return false;
	return el.classList.length > 0 || SEMANTIC_TAGS.has(el.tagName);
}

function sameBox(a: DOMRect, b: DOMRect): boolean {
	return (
		Math.abs(a.left - b.left) <= COINCIDENT_TOLERANCE_PX &&
		Math.abs(a.top - b.top) <= COINCIDENT_TOLERANCE_PX &&
		Math.abs(a.width - b.width) <= COINCIDENT_TOLERANCE_PX &&
		Math.abs(a.height - b.height) <= COINCIDENT_TOLERANCE_PX
	);
}

/**
 * Walk outward through wrappers that occupy the same box, keeping the OUTERMOST one.
 *
 * The outer element's class is the one that names the thing — `div.nav-file` rather than the
 * unclassed `div` inside it that happens to be the same size.
 */
function collapseCoincident(el: Element): Element {
	let current = el;
	let rect = current.getBoundingClientRect();
	for (let hops = 0; hops < MAX_COLLAPSE_HOPS; hops++) {
		const parent = current.parentElement;
		if (parent === null) break;
		const parentRect = parent.getBoundingClientRect();
		if (!sameBox(rect, parentRect) || !isPickable(parent)) break;
		current = parent;
		rect = parentRect;
	}
	return current;
}

function regionOf(el: Element): PickRegion {
	for (const [selector, region] of REGION_RULES) {
		try {
			if (el.closest(selector) !== null) return region;
		} catch {
			// A rule this browser cannot parse is a rule we skip, not a pick we lose.
		}
	}
	return "unknown";
}

function describeTag(el: Element): string {
	const classes = allStableClasses(el).slice(0, 2);
	return `${el.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join("")}`;
}

function safeDisplayText(view: View): string {
	try {
		return clean(view.getDisplayText(), 60);
	} catch {
		return "";
	}
}

function describeElementInfo(el: Element, evidence: ElementEvidence): PickedElementInfo {
	const attributes: Record<string, string> = {};
	let count = 0;
	for (const attr of Array.from(el.attributes)) {
		if (count >= MAX_ATTRIBUTES) break;
		if (attr.name === "class" || attr.name === "style" || attr.name === "id") continue;
		attributes[attr.name] = clean(attr.value, 80);
		count += 1;
	}
	return {
		tag: el.tagName.toLowerCase(),
		id: el.id,
		classes: allStableClasses(el),
		text: evidence.txt,
		label: evidence.label,
		attributes,
	};
}

function describeAncestors(el: Element, rect: DOMRect): AncestorInfo[] {
	const out: AncestorInfo[] = [];
	let cursor = el.parentElement;
	while (cursor !== null && out.length < MAX_ANCESTORS) {
		const info: AncestorInfo = {
			tag: cursor.tagName.toLowerCase(),
			id: cursor.id,
			classes: allStableClasses(cursor).slice(0, 6),
			sameBox: sameBox(rect, cursor.getBoundingClientRect()),
		};
		const region = regionOf(cursor);
		if (region !== "unknown") info.region = region;
		out.push(info);
		cursor = cursor.parentElement;
	}
	return out;
}

/** `obsidian-tasks-plugin` → `tasks`: the token a plugin's own class names are usually built from. */
function pluginSlug(id: string): string {
	return id
		.toLowerCase()
		.replace(/^obsidian[-_]/, "")
		.replace(/[-_]?obsidian$/, "")
		.replace(/[-_]?plugin$/, "")
		.replace(/[^a-z0-9]+/g, "");
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Score every installed plugin against the evidence.
 *
 * There is no route from a view type to the plugin that registered it: `viewRegistry.viewByType`
 * yields a creator closure, not an id. So this is deliberately a *scored guess with its reasoning
 * attached*, and the thresholds in {@link resolveOwnerFor} are set so that an ambiguous answer
 * becomes "ask the user" rather than a confident wrong one.
 *
 * Rungs, highest first:
 *   100  the view type IS the plugin id
 *    90  view type and plugin id are the same word
 *    80  the view type is the plugin's slug (`tasks` for `obsidian-tasks-plugin`)
 *    70  the view type begins with the plugin's slug (`tasks-view`)
 *    65  a class on the element or its ancestors is exactly the plugin's slug
 *    55  a class's first segment is the plugin's slug (`tasks-list-item`)
 *    45  a class begins with the plugin's slug, unsegmented (needs a longer slug to count)
 */
function scoreOwners(index: readonly PluginEntry[], viewType: string | null, classTokens: readonly string[]): OwnerCandidate[] {
	const tokenSlugs = classTokens.map((t) => ({ raw: t, slug: slugify(t), head: slugify(t.split("-")[0] ?? "") }));
	const viewSlug = viewType === null ? "" : slugify(viewType);
	const out: OwnerCandidate[] = [];

	for (const entry of index) {
		if (entry.slug.length < 3) continue;
		let score = 0;
		let why = "";

		const consider = (value: number, reason: string): void => {
			if (value > score) {
				score = value;
				why = reason;
			}
		};

		if (viewType !== null && viewType.length > 0) {
			if (viewType === entry.id) consider(100, `the view type is the plugin id "${entry.id}"`);
			else if (viewSlug === slugify(entry.id)) consider(90, `the view type "${viewType}" is the plugin id`);
			else if (viewSlug === entry.slug) consider(80, `the view type "${viewType}" is this plugin's name`);
			else if (entry.slug.length >= 4 && viewSlug.startsWith(entry.slug)) {
				consider(70, `the view type "${viewType}" begins with this plugin's name`);
			}
		}

		for (const token of tokenSlugs) {
			if (token.slug.length < 3) continue;
			if (token.slug === entry.slug) consider(65, `the class "${token.raw}" is this plugin's name`);
			else if (entry.slug.length >= 4 && token.head === entry.slug) {
				consider(55, `the class "${token.raw}" is prefixed with this plugin's name`);
			} else if (entry.slug.length >= 6 && token.slug.startsWith(entry.slug)) {
				consider(45, `the class "${token.raw}" begins with this plugin's name`);
			}
		}

		if (score > 0) out.push({ pluginId: entry.id, pluginName: entry.name, version: entry.version, score, why });
	}

	return out.sort((a, b) => b.score - a.score || a.pluginId.localeCompare(b.pluginId));
}

/** Class tokens from the element and its nearer ancestors — the attribution evidence. */
function collectClassTokens(el: Element, depth: number): string[] {
	const tokens: string[] = [];
	const seen = new Set<string>();
	let cursor: Element | null = el;
	let level = 0;
	while (cursor !== null && level <= depth) {
		for (const cls of allStableClasses(cursor)) {
			if (seen.has(cls)) continue;
			seen.add(cls);
			tokens.push(cls);
		}
		cursor = cursor.parentElement;
		level += 1;
	}
	return tokens;
}

/**
 * The attribution ladder. Every branch produces a usable target — there is no dead end, because
 * "this is Obsidian's own UI" is a legitimate answer and so is "I don't know, you tell me".
 */
export function resolveOwnerFor(
	el: Element,
	leaf: LeafSnapshot | null,
	region: PickRegion,
	index: readonly PluginEntry[],
): ResolvedOwner {
	const viewType = leaf === null || leaf.viewType.length === 0 ? null : leaf.viewType;
	const candidates = scoreOwners(index, viewType, collectClassTokens(el, MAX_ANCESTORS));
	const best = candidates[0];
	const runnerUp = candidates[1];
	const decisive = best !== undefined && (runnerUp === undefined || best.score - runnerUp.score >= 10);
	const coreView = viewType !== null && CORE_VIEW_TYPES.has(viewType);

	const asPlugin = (candidate: OwnerCandidate, confidence: OwnerConfidence, why: string): ResolvedOwner => ({
		kind: "plugin",
		confidence,
		why,
		summary: candidate.version.length > 0 ? `${candidate.pluginName} ${candidate.version}` : candidate.pluginName,
		candidates,
		pluginId: candidate.pluginId,
		pluginName: candidate.pluginName,
		pluginVersion: candidate.version,
	});

	// 1 — a plugin's own view, named by its view type.
	if (!coreView && best !== undefined && best.score >= 80 && decisive) {
		return asPlugin(best, "high", `This is ${best.pluginName}'s own UI — ${best.why}.`);
	}
	if (!coreView && best !== undefined && best.score >= 55 && decisive) {
		return asPlugin(best, "medium", `This looks like ${best.pluginName} — ${best.why}. Change the target if that is wrong.`);
	}

	// 2 — inside one of Obsidian's own views, but decorated by a plugin. Extremely common: a Tasks
	// or Dataview block lives inside a plain markdown view, and the view type says nothing about it.
	if (coreView && best !== undefined && best.score >= 55 && decisive) {
		return asPlugin(
			best,
			"medium",
			`This sits inside Obsidian's own ${viewType ?? "view"}, but ${best.why} — so ${best.pluginName} is the likely owner. Switch to Obsidian core if the change is really about the view itself.`,
		);
	}

	// 3 — Obsidian's own view, nothing else claiming it.
	if (coreView && viewType !== null) {
		const internal = CORE_VIEW_TYPES.get(viewType) ?? null;
		const owner: ResolvedOwner = {
			kind: "core",
			confidence: "high",
			why: `This is Obsidian's own ${viewType} view, not a plugin. modkit can still patch it — most Obsidian customization is core patching.`,
			summary: `Obsidian ${apiVersion}`,
			candidates,
		};
		if (internal !== null) owner.internalPluginId = internal;
		return owner;
	}

	// 4 — a plugin's view we cannot name. Obsidian does not record which plugin registered a view
	// type, so the honest move is to say what we know and let one click settle it.
	if (viewType !== null) {
		return {
			kind: "unknown",
			confidence: "low",
			why: `The "${viewType}" view is registered by a plugin, but Obsidian does not record which one. Pick the target plugin yourself.`,
			summary: `Unattributed · ${viewType}`,
			candidates,
		};
	}

	// 5 — not inside a leaf at all: ribbon, status bar, tab header, a menu, the settings pane.
	return {
		kind: "core",
		confidence: region === "unknown" ? "low" : "high",
		why: `This is ${REGION_LABELS[region]} — Obsidian's own UI rather than a plugin's. modkit can patch core UI, which is what most Obsidian customization is.`,
		summary: `Obsidian ${apiVersion}`,
		candidates,
	};
}
