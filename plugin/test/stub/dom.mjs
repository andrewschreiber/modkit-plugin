/**
 * A crude DOM, and an honest label on how crude.
 *
 * modkit's plugin code reaches the DOM in three narrow ways, and this file models exactly those:
 * Obsidian's `createEl`/`createDiv`/`createSpan` element factories, the `addClass`/`setAttribute`
 * mutators, and `document.head.querySelectorAll('style[attr="value"]')` for the stale-stylesheet
 * sweep. Everything else is a stub that records a call.
 *
 * ## Where this is crude — read before trusting a result from it
 *
 * - **`querySelectorAll` is not a CSS engine.** It understands exactly two shapes: `tag` and
 *   `tag[attr="value"]`, matched against direct and transitive children. Anything else returns an
 *   empty list rather than throwing, which is the same answer a real browser would give for a
 *   selector that matches nothing — so a test that depended on a richer selector would pass here
 *   and be meaningless. Do not add such a test without extending this first.
 * - **There is no layout, no CSSOM, no event bubbling and no capture phase.** `dispatch()` calls the
 *   listeners registered on that exact element, in registration order, and stops. Code under test
 *   that depends on an event reaching an ancestor is not exercised by this.
 * - **`closest()` walks the parent chain but only for the two selector shapes above.**
 * - **Elements are not `instanceof HTMLElement`** — there is no such class here. Any code doing an
 *   `instanceof` check against a real DOM class will take the false branch.
 *
 * ## Where it is deliberately faithful
 *
 * - `window.setTimeout`/`setInterval` return **numbers**, as they do in a browser and unlike Node,
 *   because `ModInstaller` keys a `Map<number, …>` on the return value and `ProgressSurface` hands
 *   it to `registerInterval`. A `Timeout` object there would have passed while modelling the wrong
 *   host.
 * - Removing an element really detaches it from its parent, so `isConnected` and a `head` sweep
 *   report what a browser would.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Selector matching — the two shapes we support
 * ──────────────────────────────────────────────────────────────────────────── */

const SELECTOR_RE = /^([a-zA-Z][\w-]*)?(?:\[([^\]=]+)(?:=("?)([^\]"]*)\3)?\])?$/;

function parseSelector(selector) {
	const match = SELECTOR_RE.exec(String(selector).trim());
	if (match === null) return null;
	const [, tag, attr, , value] = match;
	if (tag === undefined && attr === undefined) return null;
	return { tag: tag?.toLowerCase(), attr, value };
}

function matches(el, parsed) {
	if (parsed === null) return false;
	if (parsed.tag !== undefined && el.tagName !== parsed.tag) return false;
	if (parsed.attr !== undefined) {
		if (!el.attributes.has(parsed.attr)) return false;
		if (parsed.value !== undefined && el.attributes.get(parsed.attr) !== parsed.value) return false;
	}
	return true;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Element
 * ──────────────────────────────────────────────────────────────────────────── */

export class StubElement {
	constructor(tagName, ownerDocument) {
		this.tagName = String(tagName).toLowerCase();
		this.ownerDocument = ownerDocument ?? null;
		this.children = [];
		this.parentElement = null;
		this.attributes = new Map();
		this.classList = new Set();
		/** Set by `textContent`/`setText`; not derived from children, which is the crude part. */
		this._text = "";
		this.listeners = [];
		this.style = {};
	}

	/* ── Obsidian's element factories ─────────────────────────────────────── */

	createEl(tag, options = {}) {
		const el = new StubElement(tag, this.ownerDocument);
		applyElementOptions(el, options);
		this.appendChild(el);
		return el;
	}

	createDiv(options = {}) {
		return this.createEl("div", options);
	}

	createSpan(options = {}) {
		return this.createEl("span", options);
	}

	/* ── Tree ─────────────────────────────────────────────────────────────── */

	appendChild(child) {
		if (child.parentElement !== null) child.parentElement.removeChild(child);
		child.parentElement = this;
		child.ownerDocument = this.ownerDocument;
		this.children.push(child);
		return child;
	}

	removeChild(child) {
		const at = this.children.indexOf(child);
		if (at >= 0) this.children.splice(at, 1);
		child.parentElement = null;
		return child;
	}

	/** Both spellings: `remove()` is the DOM's, `detach()` is Obsidian's addition. */
	remove() {
		this.parentElement?.removeChild(this);
	}

	detach() {
		this.remove();
	}

	empty() {
		for (const child of [...this.children]) this.removeChild(child);
		this._text = "";
	}

	get isConnected() {
		let node = this;
		while (node.parentElement !== null) node = node.parentElement;
		return node === this.ownerDocument?.documentElement || node.tagName === "#document";
	}

	/* ── Attributes and classes ───────────────────────────────────────────── */

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	addClass(...classes) {
		for (const c of classes) this.classList.add(c);
	}

	removeClass(...classes) {
		for (const c of classes) this.classList.delete(c);
	}

	hasClass(c) {
		return this.classList.has(c);
	}

	toggleClass(classes, on) {
		for (const c of [classes].flat()) {
			if (on) this.classList.add(c);
			else this.classList.delete(c);
		}
	}

	/* ── Text ─────────────────────────────────────────────────────────────── */

	get textContent() {
		return this._text;
	}

	set textContent(value) {
		this._text = String(value ?? "");
	}

	setText(value) {
		this._text = String(value ?? "");
	}

	/**
	 * Obsidian's DOM extension: append a text node beside whatever children are already there.
	 *
	 * `_text` is not derived from children (see the note above it), so appending has to fold into
	 * it. That is crude in the same direction as the rest of this file — interleaving with element
	 * children is lost — but it means `textContent` still carries the appended words, which is what
	 * a caller like `ComposeModal`'s keyboard hint is building.
	 */
	appendText(value) {
		this._text += String(value ?? "");
	}

	/* ── Focus ────────────────────────────────────────────────────────────── */

	/**
	 * Records itself as the owning document's `activeElement`, so which control has focus is
	 * assertable. It matters in exactly one place and that place is a safety gate: `ReviewModal`
	 * focuses **Cancel**, so Return and Space refuse rather than run generated code.
	 */
	focus() {
		if (this.ownerDocument !== null) this.ownerDocument.activeElement = this;
	}

	blur() {
		if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
	}

	/** Textareas and inputs get these called on them; neither has anything to model here. */
	select() {}

	setSelectionRange() {}

	/* ── Events (no bubbling — see the header) ────────────────────────────── */

	addEventListener(type, callback, options) {
		this.listeners.push({ type, callback, options });
	}

	removeEventListener(type, callback) {
		const at = this.listeners.findIndex((l) => l.type === type && l.callback === callback);
		if (at >= 0) this.listeners.splice(at, 1);
	}

	/** Test-only: fire the listeners registered on *this* element. */
	dispatch(type, event = {}) {
		for (const listener of [...this.listeners]) {
			if (listener.type === type) listener.callback.call(this, event);
		}
	}

	/* ── Queries (crude — see the header) ─────────────────────────────────── */

	querySelectorAll(selector) {
		const parsed = parseSelector(selector);
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (matches(child, parsed)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	closest(selector) {
		const parsed = parseSelector(selector);
		let node = this;
		while (node !== null) {
			if (matches(node, parsed)) return node;
			node = node.parentElement;
		}
		return null;
	}
}

/** Obsidian's `DomElementInfo`: `{ cls, text, attr, type, href, title, value, placeholder }`. */
function applyElementOptions(el, options) {
	if (typeof options === "string") {
		el.classList.add(options);
		return;
	}
	const { cls, text, attr, ...rest } = options ?? {};
	if (cls !== undefined) for (const c of [cls].flat().join(" ").split(/\s+/).filter(Boolean)) el.classList.add(c);
	if (text !== undefined) el.setText(text);
	if (attr !== undefined) for (const [k, v] of Object.entries(attr)) el.setAttribute(k, v);
	for (const [k, v] of Object.entries(rest)) el.setAttribute(k, v);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Document and window
 * ──────────────────────────────────────────────────────────────────────────── */

export class StubDocument {
	constructor() {
		this.documentElement = new StubElement("html", this);
		this.head = this.documentElement.createEl("head");
		this.body = this.documentElement.createEl("body");
		this.listeners = [];
		/** Set by `installDomGlobals`, so `doc.defaultView` is the same window the code sees. */
		this.defaultView = null;
		/** Whatever last had `focus()` called on it. See `StubElement.focus`. */
		this.activeElement = null;
	}

	createElement(tag) {
		return new StubElement(tag, this);
	}

	/**
	 * A `DocumentFragment`, which Obsidian extends with the same `createEl`/`createSpan`/`appendText`
	 * factories it puts on `HTMLElement` — so here it is simply a detached `StubElement`. It is what
	 * `ComposeModal` builds its keyboard hint into before handing it to `Setting.setDesc`.
	 */
	createDocumentFragment() {
		return new StubElement("#document-fragment", this);
	}

	querySelectorAll(selector) {
		return this.documentElement.querySelectorAll(selector);
	}

	querySelector(selector) {
		return this.documentElement.querySelector(selector);
	}

	addEventListener(type, callback, options) {
		this.listeners.push({ type, callback, options });
	}

	removeEventListener(type, callback) {
		const at = this.listeners.findIndex((l) => l.type === type && l.callback === callback);
		if (at >= 0) this.listeners.splice(at, 1);
	}
}

/**
 * A window whose timer functions return **numbers**, as a browser's do.
 *
 * The plugin holds these ids in maps and hands them to `Component.registerInterval`, so a Node
 * `Timeout` object would have been a silently different contract. `pending()` is what a teardown
 * test asserts against.
 */
export class StubWindow {
	constructor(doc) {
		this.document = doc;
		this.listeners = [];
		this._nextId = 1;
		this._timers = new Map();
	}

	setTimeout(fn, ms, ...args) {
		const id = this._nextId++;
		const handle = setTimeout(() => {
			this._timers.delete(id);
			fn(...args);
		}, ms);
		this._timers.set(id, { handle, kind: "timeout" });
		return id;
	}

	clearTimeout(id) {
		const entry = this._timers.get(id);
		if (entry === undefined) return;
		clearTimeout(entry.handle);
		this._timers.delete(id);
	}

	setInterval(fn, ms, ...args) {
		const id = this._nextId++;
		const handle = setInterval(() => fn(...args), ms);
		// Intervals must not keep Node alive while a test file finishes.
		handle.unref?.();
		this._timers.set(id, { handle, kind: "interval" });
		return id;
	}

	clearInterval(id) {
		const entry = this._timers.get(id);
		if (entry === undefined) return;
		clearInterval(entry.handle);
		this._timers.delete(id);
	}

	/** Every timer this window created and nobody cleared. The teardown assertion. */
	pending() {
		return [...this._timers.values()];
	}

	pendingIntervals() {
		return this.pending().filter((t) => t.kind === "interval");
	}

	addEventListener(type, callback, options) {
		this.listeners.push({ type, callback, options });
	}

	removeEventListener(type, callback) {
		const at = this.listeners.findIndex((l) => l.type === type && l.callback === callback);
		if (at >= 0) this.listeners.splice(at, 1);
	}

	/** Clear anything still outstanding, so one test's stray interval cannot leak into the next. */
	destroy() {
		for (const [id, entry] of [...this._timers]) {
			if (entry.kind === "interval") this.clearInterval(id);
			else this.clearTimeout(id);
		}
	}
}

/**
 * Install `document`, `window`, `activeDocument` and `activeWindow` as globals.
 *
 * The bundle under test is a CommonJS file evaluated in this realm (see `loadBundle`), so it reads
 * the same `globalThis` the test does. That is crude — a browser would give it a separate realm —
 * and it is called out here rather than hidden: it means a test can accidentally observe state the
 * plugin should not have been able to reach. Nothing below relies on that.
 *
 * Returns a `restore()` that puts the previous values back and cancels every timer created through
 * the stub window.
 */
export function installDomGlobals() {
	const doc = new StubDocument();
	const win = new StubWindow(doc);
	doc.defaultView = win;

	const keys = ["document", "window", "activeDocument", "activeWindow"];
	const previous = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	const values = { document: doc, window: win, activeDocument: doc, activeWindow: win };
	for (const key of keys) {
		Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true });
	}

	return {
		document: doc,
		window: win,
		restore() {
			win.destroy();
			for (const key of keys) {
				const descriptor = previous.get(key);
				if (descriptor === undefined) delete globalThis[key];
				else Object.defineProperty(globalThis, key, descriptor);
			}
		},
	};
}
