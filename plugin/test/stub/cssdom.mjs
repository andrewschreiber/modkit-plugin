/**
 * A second DOM stub, with a real selector engine.
 *
 * `./dom.mjs` exists for the plugin's three narrow DOM uses and says so in its own header: its
 * `querySelectorAll` understands `tag` and `tag[attr="value"]` and **returns an empty list for
 * everything else**. `src/picker/selector.ts` cannot be tested against that at all. Its entire
 * contract is *"the selector I emit, I queried back"* — every candidate is run through
 * `querySelectorAll` and believed only if the picked node is in the result. Against a matcher that
 * answers "no match" to `.nav-file-title > span:nth-child(2)`, every candidate scores zero, the
 * search falls through to its last resort every time, and the suite would report a green run about
 * a code path the product never takes. So this file implements the selector grammar for real.
 *
 * Extending `dom.mjs` in place was the other option and was rejected: `installer`, `lifecycle`,
 * `host-settings` and `bundle` all assert against its exact behaviour (including that a
 * `style[data-modkit-style]` sweep finds what a browser would), and swapping its matcher for a
 * different one under those tests is not an extension, it is a rewrite of their harness. This is
 * additive; nothing already passing changes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FAITHFUL, and load-bearing for what the tests claim
 * ────────────────────────────────────────────────────────────────────────────
 *
 * - **`querySelectorAll` on an element returns descendants only**, never the element itself, and a
 *   descendant combinator may match an ancestor *outside* the scope — `leaf.querySelectorAll(".a .b")`
 *   matches a `.b` inside the leaf whose `.a` ancestor is above the leaf. Both are real DOM
 *   behaviour and both matter: `selector.ts` composes `rootSelector` and the scoped selector and
 *   then re-queries the composite against the whole document.
 * - **`:nth-child` / `:nth-of-type` are 1-based over *element* siblings**, ignoring text nodes.
 * - **`tagName` is upper-case**; `selector.ts` lower-cases it and `picker.ts` compares against an
 *   upper-case set, so a stub that stored lower-case would silently break the second.
 * - **`textContent` concatenates the subtree**, as the DOM's does, rather than being a field the
 *   test set — `describeElement` reads it and caps it, and a flat field would never exercise that.
 * - **Backslash escapes in identifiers are honoured**, because `escapeIdent` emits them whenever
 *   `CSS.escape` is absent, which it is here.
 * - **`classList` is ordered and de-duplicated**, with `length`/`item(i)`, which is what
 *   `stableClasses` iterates.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * CRUDE — read before trusting a result from this file
 * ────────────────────────────────────────────────────────────────────────────
 *
 * - **THERE IS NO LAYOUT.** `getBoundingClientRect()` returns whatever the test assigned to
 *   `el.rect`, and `{0,0,0,0}` when it assigned nothing. Everything in `picker.ts` that decides with
 *   geometry — `isPickable`'s size floor, `collapseCoincident`'s wrapper walk, the label placement —
 *   is therefore *stipulated* by the test, not observed. Those are not tested here; see
 *   `picker.test.mjs` for the list of what was left alone and why.
 * - **The selector grammar is a subset**, and an unsupported selector **throws** rather than
 *   returning nothing. That is the deliberate opposite of `dom.mjs`, because a silent empty list is
 *   indistinguishable from a real miss and `selector.ts` swallows query exceptions by design. The
 *   throw is also *recorded* on `document.selectorErrors`, so a test can assert the engine was never
 *   asked something it does not understand — an assertion `dom.mjs` makes impossible. Supported:
 *   selector lists (`a, b`), descendant and child combinators, and compounds of `tag`, `#id`,
 *   `.class`, `[attr]`, `[attr="v"]`, `:nth-child(<int>)`, `:nth-of-type(<int>)`. NOT supported:
 *   `an+b` micro-syntax, `~`/`+`, `:not()`, `::before`, attribute operators other than `=`,
 *   namespaces, case-insensitivity flags.
 * - **No CSS cascade, no `style` computation, no `checkVisibility`.** `el.style` is a plain object.
 * - **No events.** This DOM has no `addEventListener` at all — deliberately, so that nothing can
 *   mistake it for a harness in which `picker.ts`'s capture-phase interception could be exercised.
 * - **Elements are not `instanceof HTMLElement`.** Code doing such a check takes the false branch.
 * - **Attribute names are compared case-sensitively** (the HTML parser would lower-case them).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Selector parsing
 * ──────────────────────────────────────────────────────────────────────────── */

export class SelectorSyntaxError extends Error {
	constructor(selector, why) {
		super(`cssdom: cannot parse ${JSON.stringify(selector)} — ${why}`);
		this.name = "SelectorSyntaxError";
		this.selector = selector;
	}
}

/** Read one CSS identifier, honouring `\x` escapes. Returns `[value, rest]`. */
function readIdent(input, selector) {
	let out = "";
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "\\") {
			if (i + 1 >= input.length) throw new SelectorSyntaxError(selector, "a trailing backslash");
			out += input[i + 1];
			i += 2;
			continue;
		}
		if (/[\w-]/.test(ch)) {
			out += ch;
			i += 1;
			continue;
		}
		break;
	}
	if (out === "") throw new SelectorSyntaxError(selector, `expected an identifier at ${JSON.stringify(input)}`);
	return [out, input.slice(i)];
}

/**
 * Parse one compound selector (no combinators) into a predicate description.
 *
 * Ordering inside a compound is irrelevant to matching, so the parts are collected into a set of
 * conditions rather than kept as a sequence.
 */
function parseCompound(text, selector) {
	const compound = { tag: null, id: null, classes: [], attrs: [], nthChild: null, nthOfType: null };
	let rest = text;
	if (rest === "") throw new SelectorSyntaxError(selector, "an empty compound selector");

	if (/^[A-Za-z*]/.test(rest)) {
		if (rest[0] === "*") {
			rest = rest.slice(1);
		} else {
			const [tag, after] = readIdent(rest, selector);
			compound.tag = tag.toUpperCase();
			rest = after;
		}
	}

	while (rest.length > 0) {
		const ch = rest[0];
		if (ch === "#") {
			const [id, after] = readIdent(rest.slice(1), selector);
			compound.id = id;
			rest = after;
		} else if (ch === ".") {
			const [cls, after] = readIdent(rest.slice(1), selector);
			compound.classes.push(cls);
			rest = after;
		} else if (ch === "[") {
			const end = rest.indexOf("]");
			if (end < 0) throw new SelectorSyntaxError(selector, "an unclosed attribute selector");
			const body = rest.slice(1, end);
			const eq = body.indexOf("=");
			if (eq < 0) {
				compound.attrs.push({ name: body.trim(), value: null });
			} else {
				const op = body[eq - 1];
				if (op !== undefined && "~|^$*".includes(op)) {
					throw new SelectorSyntaxError(selector, `the attribute operator "${op}=" is not implemented`);
				}
				const name = body.slice(0, eq).trim();
				let value = body.slice(eq + 1).trim();
				if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				} else if (/\s/.test(value)) {
					throw new SelectorSyntaxError(selector, "an unquoted attribute value containing whitespace");
				}
				compound.attrs.push({ name, value });
			}
			rest = rest.slice(end + 1);
		} else if (ch === ":") {
			const match = /^:(nth-child|nth-of-type)\((\d+)\)/.exec(rest);
			if (match === null) {
				throw new SelectorSyntaxError(
					selector,
					`only :nth-child(<integer>) and :nth-of-type(<integer>) are implemented, not ${JSON.stringify(rest)}`,
				);
			}
			if (match[1] === "nth-child") compound.nthChild = Number(match[2]);
			else compound.nthOfType = Number(match[2]);
			rest = rest.slice(match[0].length);
		} else {
			throw new SelectorSyntaxError(selector, `unexpected ${JSON.stringify(ch)}`);
		}
	}
	return compound;
}

/**
 * Walk `text`, calling `onBreak` at every top-level occurrence of a separator character.
 *
 * Depth-tracking is not a nicety: `selector.ts` emits `[data-path="Daily Notes/2026.md"]`, whose
 * value legitimately contains a space, and a regex `split` on whitespace would tear that token in
 * half and then blame the selector.
 */
function scanTopLevel(text, separators, selector) {
	const pieces = [];
	const breaks = [];
	let current = "";
	let bracket = 0;
	let paren = 0;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote !== null) {
			current += ch;
			if (ch === quote && text[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "\\") {
			current += ch + (text[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "[") bracket += 1;
		if (ch === "]") bracket -= 1;
		if (ch === "(") paren += 1;
		if (ch === ")") paren -= 1;
		if (bracket === 0 && paren === 0 && separators.includes(ch)) {
			pieces.push(current);
			breaks.push(ch);
			current = "";
			continue;
		}
		current += ch;
	}
	if (bracket !== 0 || paren !== 0 || quote !== null) {
		throw new SelectorSyntaxError(selector, "unbalanced brackets, parentheses or quotes");
	}
	pieces.push(current);
	return { pieces, breaks };
}

/** Split a selector list on top-level commas. */
function splitList(selector) {
	return scanTopLevel(selector, ",", selector).pieces;
}

/** `[{ compound, combinator }]`, left to right. `combinator` describes the link to the PREVIOUS part. */
function parseComplex(text, selector) {
	const trimmed = text.trim();
	if (trimmed === "") throw new SelectorSyntaxError(selector, "an empty selector in the list");

	const { pieces, breaks } = scanTopLevel(trimmed, " \t\n>~+", selector);
	const parts = [];
	let pending = null;
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i].trim();
		if (piece !== "") {
			parts.push({
				compound: parseCompound(piece, selector),
				combinator: parts.length === 0 ? null : (pending ?? " "),
			});
			pending = null;
		}
		const separator = breaks[i];
		if (separator === undefined) continue;
		if (separator === "~" || separator === "+") {
			throw new SelectorSyntaxError(selector, `the "${separator}" combinator is not implemented`);
		}
		if (separator === ">") {
			if (parts.length === 0) throw new SelectorSyntaxError(selector, "a leading combinator");
			pending = ">";
		} else if (pending === null && parts.length > 0) {
			pending = " ";
		}
	}
	if (parts.length === 0) throw new SelectorSyntaxError(selector, "an empty selector in the list");
	if (pending !== null) throw new SelectorSyntaxError(selector, "a trailing combinator");
	return parts;
}

const parseCache = new Map();

function parseSelectorList(selector) {
	const key = String(selector);
	const cached = parseCache.get(key);
	if (cached !== undefined) {
		if (cached instanceof SelectorSyntaxError) throw cached;
		return cached;
	}
	try {
		const parsed = splitList(key).map((part) => parseComplex(part, key));
		parseCache.set(key, parsed);
		return parsed;
	} catch (err) {
		if (err instanceof SelectorSyntaxError) parseCache.set(key, err);
		throw err;
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Matching
 * ──────────────────────────────────────────────────────────────────────────── */

function matchCompound(el, compound) {
	if (compound.tag !== null && el.tagName !== compound.tag) return false;
	if (compound.id !== null && el.getAttribute("id") !== compound.id) return false;
	for (const cls of compound.classes) if (!el.classList.contains(cls)) return false;
	for (const attr of compound.attrs) {
		const value = el.getAttribute(attr.name);
		if (value === null) return false;
		if (attr.value !== null && value !== attr.value) return false;
	}
	if (compound.nthChild !== null && elementIndex(el) !== compound.nthChild) return false;
	if (compound.nthOfType !== null && typeIndexOf(el) !== compound.nthOfType) return false;
	return true;
}

function matchComplex(el, parts, i) {
	if (!matchCompound(el, parts[i].compound)) return false;
	if (i === 0) return true;
	const combinator = parts[i].combinator;
	if (combinator === ">") {
		const parent = el.parentElement;
		return parent !== null && matchComplex(parent, parts, i - 1);
	}
	// Descendant: any ancestor may satisfy the left-hand side, including one above the query scope,
	// exactly as a browser does.
	let cursor = el.parentElement;
	while (cursor !== null) {
		if (matchComplex(cursor, parts, i - 1)) return true;
		cursor = cursor.parentElement;
	}
	return false;
}

function elementIndex(el) {
	const parent = el.parentElement;
	if (parent === null) return 1;
	return parent.children.indexOf(el) + 1;
}

function typeIndexOf(el) {
	const parent = el.parentElement;
	if (parent === null) return 1;
	let index = 0;
	for (const child of parent.children) {
		if (child.tagName !== el.tagName) continue;
		index += 1;
		if (child === el) return index;
	}
	return 1;
}

/** A live-enough `NodeList`: array-like with `length`, `item(i)`, iteration and indexing. */
function nodeList(items) {
	const list = items.slice();
	list.item = (i) => list[i] ?? null;
	return list;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Nodes
 * ──────────────────────────────────────────────────────────────────────────── */

class TextNode {
	constructor(data) {
		this.data = String(data);
		this.parentElement = null;
	}

	get textContent() {
		return this.data;
	}
}

/** A `DOMTokenList`: insertion-ordered, de-duplicated, with the `length`/`item` pair. */
class TokenList {
	constructor(owner) {
		this._owner = owner;
		this._tokens = [];
	}

	get length() {
		return this._tokens.length;
	}

	item(i) {
		return this._tokens[i] ?? null;
	}

	contains(token) {
		return this._tokens.includes(token);
	}

	add(...tokens) {
		for (const raw of tokens) {
			for (const token of String(raw).split(/\s+/).filter(Boolean)) {
				if (!this._tokens.includes(token)) this._tokens.push(token);
			}
		}
		this._owner._syncClassAttribute();
	}

	remove(...tokens) {
		for (const raw of tokens) {
			const at = this._tokens.indexOf(String(raw));
			if (at >= 0) this._tokens.splice(at, 1);
		}
		this._owner._syncClassAttribute();
	}

	toggle(token, force) {
		if (force === true || (force === undefined && !this.contains(token))) this.add(token);
		else this.remove(token);
	}

	get value() {
		return this._tokens.join(" ");
	}

	[Symbol.iterator]() {
		return this._tokens[Symbol.iterator]();
	}
}

export class CssElement {
	constructor(tagName, ownerDocument) {
		this.tagName = String(tagName).toUpperCase();
		this.ownerDocument = ownerDocument ?? null;
		this.parentElement = null;
		/** Elements and text nodes, in order. */
		this._nodes = [];
		/** Live `[{name, value}]`, in insertion order — `Array.from(el.attributes)` reads this. */
		this.attributes = [];
		this.classList = new TokenList(this);
		this.style = {};
		/** No layout: whatever a test puts here is what `getBoundingClientRect` reports. */
		this.rect = { left: 0, top: 0, width: 0, height: 0 };
	}

	/* ── tree ─────────────────────────────────────────────────────────────── */

	/** Element children only, as an array (also serves as the `HTMLCollection`). */
	get children() {
		const kids = this._nodes.filter((n) => n instanceof CssElement);
		kids.item = (i) => kids[i] ?? null;
		return kids;
	}

	get childNodes() {
		return this._nodes.slice();
	}

	get firstElementChild() {
		return this.children[0] ?? null;
	}

	appendChild(node) {
		node.parentElement?.removeChild(node);
		node.parentElement = this;
		if (node instanceof CssElement) node._setOwnerDocument(this.ownerDocument);
		this._nodes.push(node);
		return node;
	}

	insertBefore(node, reference) {
		if (reference === null || reference === undefined) return this.appendChild(node);
		const at = this._nodes.indexOf(reference);
		if (at < 0) throw new Error("cssdom: insertBefore reference is not a child of this node");
		node.parentElement?.removeChild(node);
		node.parentElement = this;
		if (node instanceof CssElement) node._setOwnerDocument(this.ownerDocument);
		this._nodes.splice(at, 0, node);
		return node;
	}

	removeChild(node) {
		const at = this._nodes.indexOf(node);
		if (at >= 0) this._nodes.splice(at, 1);
		node.parentElement = null;
		return node;
	}

	remove() {
		this.parentElement?.removeChild(this);
	}

	_setOwnerDocument(doc) {
		this.ownerDocument = doc ?? null;
		for (const node of this._nodes) {
			if (node instanceof CssElement) node._setOwnerDocument(doc);
		}
	}

	get previousElementSibling() {
		const siblings = this.parentElement?.children;
		if (siblings === undefined) return null;
		return siblings[siblings.indexOf(this) - 1] ?? null;
	}

	get nextElementSibling() {
		const siblings = this.parentElement?.children;
		if (siblings === undefined) return null;
		return siblings[siblings.indexOf(this) + 1] ?? null;
	}

	get isConnected() {
		let node = this;
		while (node.parentElement !== null) node = node.parentElement;
		return this.ownerDocument !== null && node === this.ownerDocument.documentElement;
	}

	contains(other) {
		let node = other;
		while (node !== null && node !== undefined) {
			if (node === this) return true;
			node = node.parentElement;
		}
		return false;
	}

	/* ── attributes ───────────────────────────────────────────────────────── */

	setAttribute(name, value) {
		if (name === "class") {
			this.classList._tokens = String(value).split(/\s+/).filter(Boolean);
		}
		const existing = this.attributes.find((a) => a.name === name);
		if (existing !== undefined) existing.value = String(value);
		else this.attributes.push({ name, value: String(value) });
		return this;
	}

	getAttribute(name) {
		return this.attributes.find((a) => a.name === name)?.value ?? null;
	}

	hasAttribute(name) {
		return this.attributes.some((a) => a.name === name);
	}

	removeAttribute(name) {
		const at = this.attributes.findIndex((a) => a.name === name);
		if (at >= 0) this.attributes.splice(at, 1);
		if (name === "class") this.classList._tokens = [];
	}

	_syncClassAttribute() {
		const value = this.classList.value;
		const existing = this.attributes.find((a) => a.name === "class");
		if (value === "") {
			if (existing !== undefined) this.attributes.splice(this.attributes.indexOf(existing), 1);
			return;
		}
		if (existing !== undefined) existing.value = value;
		else this.attributes.push({ name: "class", value });
	}

	get id() {
		return this.getAttribute("id") ?? "";
	}

	set id(value) {
		this.setAttribute("id", value);
	}

	get className() {
		return this.classList.value;
	}

	/* ── text ─────────────────────────────────────────────────────────────── */

	get textContent() {
		return this._nodes.map((n) => n.textContent).join("");
	}

	set textContent(value) {
		this._nodes = [];
		if (value !== "" && value !== null && value !== undefined) this.appendChild(new TextNode(value));
	}

	/* ── queries ──────────────────────────────────────────────────────────── */

	querySelectorAll(selector) {
		return runQuery(this, selector, this.ownerDocument, descendantsOf(this));
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	matches(selector) {
		const doc = this.ownerDocument;
		let list;
		try {
			list = parseSelectorList(selector);
		} catch (err) {
			doc?._recordSelectorError(selector, err);
			throw err;
		}
		return list.some((parts) => matchComplex(this, parts, parts.length - 1));
	}

	closest(selector) {
		let node = this;
		while (node !== null) {
			if (node.matches(selector)) return node;
			node = node.parentElement;
		}
		return null;
	}

	getBoundingClientRect() {
		const { left, top, width, height } = this.rect;
		return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
	}

	/* ── test conveniences ────────────────────────────────────────────────── */

	/**
	 * `el.el("div.nav-file[data-path=x]", { text })` — build and append a child from a compound
	 * selector. A shorthand, not a parser used by anything under test.
	 */
	el(spec, options = {}) {
		const compound = parseCompound(spec, spec);
		const child = new CssElement(compound.tag ?? "DIV", this.ownerDocument);
		if (compound.id !== null) child.setAttribute("id", compound.id);
		if (compound.classes.length > 0) child.classList.add(...compound.classes);
		for (const attr of compound.attrs) child.setAttribute(attr.name, attr.value ?? "");
		if (options.text !== undefined) child.textContent = options.text;
		if (options.attr !== undefined) for (const [k, v] of Object.entries(options.attr)) child.setAttribute(k, v);
		if (options.rect !== undefined) child.rect = { ...child.rect, ...options.rect };
		this.appendChild(child);
		return child;
	}
}

function descendantsOf(node) {
	const out = [];
	const walk = (parent) => {
		for (const child of parent.children) {
			out.push(child);
			walk(child);
		}
	};
	walk(node);
	return out;
}

function runQuery(scope, selector, doc, candidates) {
	doc?._countQuery();
	let list;
	try {
		list = parseSelectorList(selector);
	} catch (err) {
		doc?._recordSelectorError(selector, err);
		throw err;
	}
	const out = [];
	for (const el of candidates) {
		if (list.some((parts) => matchComplex(el, parts, parts.length - 1))) out.push(el);
	}
	return nodeList(out);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Document
 * ──────────────────────────────────────────────────────────────────────────── */

export class CssDocument {
	constructor() {
		this.documentElement = new CssElement("html", this);
		this.head = this.documentElement.el("head");
		this.body = this.documentElement.el("body");
		this.defaultView = null;
		/**
		 * Every selector this engine was asked for and could not parse. A test asserts this is empty:
		 * `selector.ts` swallows query exceptions on purpose, so a grammar it emits and this engine
		 * cannot read would otherwise vanish into the "no answer" branch and score as a miss.
		 */
		this.selectorErrors = [];
		/** How many `querySelectorAll` calls have run. `selector.ts` promises a bounded number. */
		this.queryCount = 0;
	}

	_recordSelectorError(selector, err) {
		this.selectorErrors.push({ selector: String(selector), message: err.message });
	}

	_countQuery() {
		this.queryCount += 1;
	}

	createElement(tag) {
		return new CssElement(tag, this);
	}

	querySelectorAll(selector) {
		return runQuery(this, selector, this, [this.documentElement, ...descendantsOf(this.documentElement)]);
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	contains(node) {
		return this.documentElement.contains(node);
	}
}

/** A window with only what `selector.ts`'s `viewportLabel` reads. */
export class CssWindow {
	constructor(doc, { innerWidth = 1440, innerHeight = 900 } = {}) {
		this.document = doc;
		this.innerWidth = innerWidth;
		this.innerHeight = innerHeight;
	}
}

/**
 * A fresh document + window pair. Nothing is installed as a global: `selector.ts` takes its element
 * as an argument and reaches globals only for the optional `CSS.escape`, so a test that needed a
 * global would be testing something other than this module.
 */
export function createCssDom(options = {}) {
	const document = new CssDocument();
	const window = new CssWindow(document, options);
	document.defaultView = window;
	return { document, window };
}
