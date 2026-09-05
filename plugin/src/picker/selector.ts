/**
 * Turning a picked DOM node into two different strings, for two different readers.
 *
 * 1. **A runtime selector** ({@link generateSelector}) — what a generated plane-E mod hands to
 *    `querySelectorAll` to find the thing again on a later launch. It has to *resolve*, and it has
 *    to keep resolving after the app re-renders.
 * 2. **A description** ({@link describeElement}) — short strings the model reasons from. This one
 *    does not have to resolve; it has to be *greppable* and honest.
 *
 * ## Why this is hand-written rather than `@medv/finder`
 *
 * the design notes §6.4 recommends vendoring antonmedv/finder *retuned*, and every one of its
 * retunings is a change to the search itself, not a wrapper around it: keep `className` on (Obsidian's
 * classes are hand-written and semantic, unlike x.com's compiled ones), drop `aria-label` from the
 * accepted attributes (in Obsidian it routinely carries a note title — the user's private data baked
 * into a persisted selector), scope the root to the resolved leaf, and *detect and refuse* finder's
 * timeout fallback, which emits a pure `nth-child` chain with `penalty: NaN`. What is left of finder
 * after those four is its penalty table, which is reproduced below. So this file implements the same
 * idea directly: it is bounded, it never returns a selector it did not query back, and the
 * positional last resort is reported as low confidence rather than shipped as if it were a finding.
 *
 * The penalty scale is finder's (`ANALYSIS.md:43-50`): `#id` 0, `.class` 1, `[attr=value]` 2, `tag` 5,
 * `:nth-of-type` 10, `:nth-child` 50. Lower is better, and the ordering is the point: a selector that
 * says *what a thing is* survives a re-render, and one that says *where it sat* does not.
 */

import type { ElementEvidence } from "@modkit/types";

/* ────────────────────────────────────────────────────────────────────────────
 * Tunables
 * ──────────────────────────────────────────────────────────────────────────── */

/** Class tokens carried into one compound token. Beyond three, specificity stops buying robustness. */
const MAX_CLASSES = 3;
/** How many *distinctive* ancestors may be prepended before we give up and go positional. */
const MAX_ANCESTOR_LEVELS = 4;
/** Depth cap on the positional last resort, so a deeply nested node cannot produce a 40-part chain. */
const MAX_POSITIONAL_DEPTH = 12;
/** Hard ceiling on `querySelectorAll` calls per generation. A picker must never make the app hitch. */
const MAX_QUERIES = 80;
/** Cap for the element's own text in the evidence. */
const MAX_TEXT = 80;
/** Cap for a label (`aria-label` / `placeholder` / `alt` / `title`) in the evidence. */
const MAX_LABEL = 60;
/** Children listed in the skeleton outline. */
const MAX_SKEL_CHILDREN = 4;

/**
 * Attributes allowed into a selector. **`aria-label` is deliberately absent**: it is a *content*
 * value in Obsidian (a note title, a tag name, a file path), so putting it in a persisted selector
 * bakes the user's private data into a file that is synced and shown to a model.
 */
const DEFAULT_ATTRIBUTES: readonly string[] = ["data-type", "data-mode", "data-path", "role", "type", "name"];

/**
 * Class tokens that describe *state*, not identity. A selector containing one of these stops
 * matching the moment focus moves or a folder collapses — the failure mode that looks like the mod
 * broke when nothing broke at all.
 */
const STATE_CLASS_PREFIXES: readonly string[] = ["is-", "has-", "mod-"];
const STATE_CLASSES: ReadonlySet<string> = new Set([
	"active",
	"selected",
	"focused",
	"hover",
	"hovered",
	"collapsed",
	"expanded",
	"hidden",
	"dragging",
	"mod-active",
	"mod-selected",
	"show",
	"open",
	// Obsidian's own state/platform class, present on every "touch-capable" element (mobile) rather
	// than the ones a mod actually cares about. MEASURED 2026-09-02: the search-tab-icon mod's
	// selector — `.workspace-tab-header.tappable[data-type='search'] …` — matched nothing on a build
	// where this class had moved, because it was never identity in the first place. The working
	// Bookmarks mod anchors on `.workspace-tab-header[data-type="bookmarks"]` alone.
	"tappable",
]);

/**
 * "mod-" classes that name a structural LAYOUT POSITION, not a state or variant — the exception to
 * `STATE_CLASS_PREFIXES`'s blanket "mod-" deny below. Obsidian's own "mod-*" classes are
 * overwhelmingly modifiers (`mod-active`, `mod-warning`, `mod-cta`, `mod-muted`, `mod-checked`,
 * `mod-pop`, `mod-tag` …), so the prefix is refused by default and a genuinely structural one is
 * named back in here, one at a time — never the other way around.
 */
const STRUCTURAL_MOD_CLASSES: ReadonlySet<string> = new Set([
	"mod-root",
	"mod-left-split",
	"mod-right-split",
	"mod-horizontal",
	"mod-vertical",
	"mod-sidedock",
	"mod-top",
	"mod-bottom",
	// Left/right sidebar dock tab strips and a stacked-tabs container — real Obsidian layout
	// classes, not modifiers. Missing these pushed a sidebar `.workspace-tabs` pick down to
	// `:nth-of-type`/positional once the blanket "mod-" deny landed (review finding, PLAN.md
	// 2026-09-02): with both docks' tab strips denied identity classes, `ancestorToken` could not
	// tell the left dock from the right, so the chain never went unique on a class alone.
	"mod-top-left-space",
	"mod-top-right-space",
	"mod-stacked",
]);

/**
 * `cm-*` classes CodeMirror 6 applies for cursor/selection STATE rather than line/gutter structure.
 * `cm-line` itself stays allowed (it is how a mod anchors "the current line", and it is structural,
 * not state) — these are the ones that come and go with focus and selection instead.
 */
const CM_STATE_CLASSES: ReadonlySet<string> = new Set([
	"cm-focused",
	"cm-cursor",
	"cm-cursor-primary",
	"cm-cursor-secondary",
	"cm-selectionBackground",
	"cm-selectionLayer",
	"cm-activeLine",
	"cm-activeLineGutter",
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Public shapes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SelectorOptions {
	/**
	 * Uniqueness scope. Pass the resolved leaf's `view.containerEl` (public API) — it produces
	 * shorter and far more robust selectors than searching the whole document, and it is the natural
	 * scope for a mod that only makes sense inside one view.
	 */
	root?: Element | null;
	/** Attribute names allowed into a token. Defaults to {@link DEFAULT_ATTRIBUTES}. */
	attributes?: readonly string[];
	/** Set false to refuse `:nth-of-type` / `:nth-child` entirely and accept a non-unique answer. */
	allowPositional?: boolean;
}

/** How much this selector can be trusted to still resolve tomorrow. */
export type SelectorConfidence = "high" | "medium" | "low";

export interface GeneratedSelector {
	/**
	 * The document-level selector: `rootSelector` and `scoped` joined, or just `scoped` when there
	 * was no root. This is the string a generated mod actually runs.
	 */
	selector: string;
	/** The part relative to `root`. Identical to `selector` when no root was given. */
	scoped: string;
	/** A selector for the root itself, or `null`. Not guaranteed unique — see `note`. */
	rootSelector: string | null;
	/** `selector` matches exactly one node in the document, and that node is the picked one. */
	unique: boolean;
	/** `scoped` matches exactly one node inside `root`. True far more often than `unique`. */
	uniqueInRoot: boolean;
	/** Uses `:nth-child` or `:nth-of-type` — i.e. part of the anchor is *position*, not identity. */
	positional: boolean;
	/** Finder's penalty scale, summed over the tokens used. Lower is better. */
	penalty: number;
	confidence: SelectorConfidence;
	/** How many nodes `selector` matches in the document right now. */
	matches: number;
	/** Present whenever confidence is not `high`: the specific reason, in one sentence. */
	note?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Token construction
 * ──────────────────────────────────────────────────────────────────────────── */

interface Token {
	text: string;
	penalty: number;
	positional: boolean;
	/**
	 * True when this token pins the element to an `id` or an attribute rather than only a class or
	 * tag — the signal {@link SelectorConfidence} uses to tell "this survives a redesign" from "this
	 * happens to be unique in today's DOM". A class list is Obsidian's own and mostly stable, but it
	 * is still a weaker claim than "this is *the* search pane" (`[data-type="search"]`).
	 */
	anchored: boolean;
}

/** Query budget, shared across one generation so the whole call is bounded rather than each part. */
class Budget {
	private spent = 0;
	constructor(private readonly limit: number = MAX_QUERIES) {}
	take(): boolean {
		if (this.spent >= this.limit) return false;
		this.spent += 1;
		return true;
	}
	get exhausted(): boolean {
		return this.spent >= this.limit;
	}
}

/**
 * Escape a value for use as a CSS identifier. `CSS.escape` is present in every Chromium Obsidian
 * ships on; the manual path exists so this module stays usable in a test harness without a DOM.
 */
export function escapeIdent(value: string): string {
	const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
	if (typeof css?.escape === "function") return css.escape(value);
	return value.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

function tagOf(el: Element): string {
	return el.tagName.toLowerCase();
}

/**
 * Does this class name look machine-generated? Obsidian's own are hand-written and semantic, but a
 * modded plugin may ship Tailwind, CSS modules or styled-components output, and a hashed token is a
 * selector that expires at the target's next build.
 */
function looksGenerated(cls: string): boolean {
	if (cls.length > 40) return true;
	if (/^(css|sc|jsx|emotion|tw)-[a-z0-9]{5,}$/i.test(cls)) return true;
	if (/^[a-z]{1,3}[0-9]{4,}$/i.test(cls)) return true;
	// A long run of mixed letters and digits with no separator is a hash, not a word.
	const digits = cls.replace(/[^0-9]/g, "").length;
	return cls.length >= 8 && digits >= 3 && !cls.includes("-") && !cls.includes("_");
}

/** A class token worth putting in a selector: not state, not generated, not ours. */
export function isStableClass(cls: string): boolean {
	if (cls.length === 0) return false;
	if (!/^[A-Za-z_][\w-]*$/.test(cls)) return false;
	if (cls.startsWith("modkit-")) return false;
	if (STATE_CLASSES.has(cls)) return false;
	if (CM_STATE_CLASSES.has(cls)) return false;
	for (const prefix of STATE_CLASS_PREFIXES) {
		if (cls.startsWith(prefix) && !STRUCTURAL_MOD_CLASSES.has(cls)) return false;
	}
	return !looksGenerated(cls);
}

/** The element's own stable classes, in DOM order, capped. */
export function stableClasses(el: Element, limit: number = MAX_CLASSES): string[] {
	const out: string[] = [];
	for (let i = 0; i < el.classList.length && out.length < limit; i++) {
		const cls = el.classList.item(i);
		if (cls !== null && isStableClass(cls)) out.push(cls);
	}
	return out;
}

/** Every stable class, uncapped — used for plugin attribution, where more evidence is better. */
export function allStableClasses(el: Element): string[] {
	return stableClasses(el, Number.MAX_SAFE_INTEGER);
}

function isStableId(id: string): boolean {
	if (id.length === 0 || id.length > 60) return false;
	if (!/^[A-Za-z_][\w-]*$/.test(id)) return false;
	// A uuid- or counter-shaped id is regenerated on every mount; anchoring to it is worse than a tag.
	if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
	return !looksGenerated(id);
}

function attributeTokens(el: Element, accepted: readonly string[]): Token[] {
	const out: Token[] = [];
	for (const name of accepted) {
		const value = el.getAttribute(name);
		if (value === null || value.length === 0 || value.length > 40) continue;
		if (/["\\\n]/.test(value)) continue;
		out.push({ text: `[${name}="${value}"]`, penalty: 2, positional: false, anchored: true });
	}
	return out;
}

/**
 * Every token that could stand for this element, cheapest first. Positional tokens are excluded —
 * they are added deliberately by the fallback ladder, never picked up as if they were identity.
 *
 * Attributes are listed before bare classes: the search below takes the *first* token that turns
 * out to be unique, and an attribute being unique is a design fact (`data-type` names a view on
 * purpose), where a class being unique can be an accident of today's DOM. Preferring attributes
 * costs nothing when only one kind is unique and avoids anchoring on the weaker claim when both are.
 */
function levelTokens(el: Element, accepted: readonly string[]): Token[] {
	const tokens: Token[] = [];
	const tag = tagOf(el);

	const id = el.getAttribute("id");
	if (id !== null && isStableId(id)) tokens.push({ text: `#${escapeIdent(id)}`, penalty: 0, positional: false, anchored: true });

	tokens.push(...attributeTokens(el, accepted));

	const classes = stableClasses(el);
	for (const cls of classes) tokens.push({ text: `.${escapeIdent(cls)}`, penalty: 1, positional: false, anchored: false });
	if (classes.length > 1) {
		tokens.push({
			text: classes.map((c) => `.${escapeIdent(c)}`).join(""),
			penalty: classes.length,
			positional: false,
			anchored: false,
		});
	}

	// A tag-qualified class is worth having when the bare class is shared across element types.
	if (classes.length > 0) {
		tokens.push({ text: `${tag}.${escapeIdent(classes[0]!)}`, penalty: 6, positional: false, anchored: false });
	}
	tokens.push({ text: tag, penalty: 5, positional: false, anchored: false });
	return tokens;
}

/** The single best identity token for an ancestor, or `null` when it has none worth adding. */
function ancestorToken(el: Element, accepted: readonly string[]): Token | null {
	const id = el.getAttribute("id");
	if (id !== null && isStableId(id)) return { text: `#${escapeIdent(id)}`, penalty: 0, positional: false, anchored: true };

	const attrs = attributeTokens(el, accepted);
	const classes = stableClasses(el);
	if (classes.length > 0) {
		const classText = classes.map((c) => `.${escapeIdent(c)}`).join("");
		// `.workspace-leaf-content[data-type="markdown"]` beats either half alone, and both halves
		// are identity rather than position, so the combination costs nothing in robustness.
		const attr = attrs[0];
		return attr === undefined
			? { text: classText, penalty: classes.length, positional: false, anchored: false }
			: { text: `${classText}${attr.text}`, penalty: classes.length + attr.penalty, positional: false, anchored: true };
	}
	const attr = attrs[0];
	if (attr !== undefined) return { text: `${tagOf(el)}${attr.text}`, penalty: attr.penalty + 5, positional: false, anchored: true };
	// A tag-only ancestor lengthens the selector without narrowing it. Skip it.
	return null;
}

function childIndex(el: Element): number {
	let index = 1;
	let sibling = el.previousElementSibling;
	while (sibling !== null) {
		index += 1;
		sibling = sibling.previousElementSibling;
	}
	return index;
}

function typeIndex(el: Element): { index: number; total: number } {
	const tag = el.tagName;
	let index = 1;
	let total = 0;
	const parent = el.parentElement;
	if (parent === null) return { index: 1, total: 1 };
	for (let i = 0; i < parent.children.length; i++) {
		const child = parent.children.item(i);
		if (child === null || child.tagName !== tag) continue;
		total += 1;
		if (child === el) index = total;
	}
	return { index, total };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The search
 * ──────────────────────────────────────────────────────────────────────────── */

interface Attempt {
	selector: string;
	matches: number;
	hits: boolean;
	unique: boolean;
}

function evaluate(scope: ParentNode, selector: string, el: Element, budget: Budget): Attempt | null {
	if (!budget.take()) return null;
	let found: NodeListOf<Element>;
	try {
		found = scope.querySelectorAll(selector);
	} catch {
		// An unescapable class name, or a token this browser rejects. Treat it as no answer, not as
		// a crash: the caller has other candidates and one bad token must not lose the whole pick.
		return null;
	}
	// Membership, not `found[0] === el`. A class shared by ten nodes returns ours seventh, and a
	// first-element test would score that token as a miss and throw away the best anchor available.
	let hits = false;
	for (let i = 0; i < found.length; i++) {
		if (found.item(i) === el) {
			hits = true;
			break;
		}
	}
	return { selector, matches: found.length, hits, unique: found.length === 1 && hits };
}

interface Search {
	sel: string;
	penalty: number;
	positional: boolean;
	unique: boolean;
	matches: number;
	levels: number;
	/** True when an `id` or attribute contributed anywhere in the chain — see {@link Token.anchored}. */
	anchored: boolean;
}

/**
 * Walk up from `el` looking for the cheapest chain that resolves to it alone within `scope`.
 *
 * The order is the whole design: identity tokens on the element, then identity tokens from the
 * *nearest distinctive ancestors* (skipping structural filler, which is what keeps the chain short),
 * and only then position. Every step is queried back before it is believed.
 */
function search(el: Element, scope: ParentNode, budget: Budget, accepted: readonly string[], allowPositional: boolean): Search | null {
	const own = levelTokens(el, accepted);
	if (own.length === 0) return null;

	// Step 1 — the element alone. Also gives every token a measured match count, which is a better
	// anchor criterion than penalty: the most distinctive token is the one that narrows most.
	let best: { token: Token; matches: number } | null = null;
	for (const token of own) {
		const attempt = evaluate(scope, token.text, el, budget);
		if (attempt === null) continue;
		if (attempt.unique) {
			return { sel: token.text, penalty: token.penalty, positional: false, unique: true, matches: 1, levels: 0, anchored: token.anchored };
		}
		if (!attempt.hits) continue;
		if (best === null || attempt.matches < best.matches || (attempt.matches === best.matches && token.penalty < best.token.penalty)) {
			best = { token, matches: attempt.matches };
		}
	}
	const anchor: Token = best?.token ?? own[own.length - 1]!;
	let penalty = anchor.penalty;
	let matches = best?.matches ?? 0;
	let anchored = anchor.anchored;

	// Step 2 — prepend distinctive ancestors, nearest first.
	const chain: string[] = [anchor.text];
	let levels = 0;
	let cursor = el.parentElement;
	while (cursor !== null && levels < MAX_ANCESTOR_LEVELS && !budget.exhausted) {
		if (cursor === scope || cursor === el.ownerDocument?.documentElement) break;
		const token = ancestorToken(cursor, accepted);
		cursor = cursor.parentElement;
		if (token === null) continue;
		chain.unshift(token.text);
		penalty += token.penalty;
		levels += 1;
		anchored ||= token.anchored;
		const attempt = evaluate(scope, chain.join(" "), el, budget);
		if (attempt === null) continue;
		matches = attempt.matches;
		if (attempt.unique) {
			return { sel: chain.join(" "), penalty, positional: false, unique: true, matches: 1, levels, anchored };
		}
	}

	const identitySel = chain.join(" ");
	if (!allowPositional) {
		return { sel: identitySel, penalty, positional: false, unique: false, matches, levels, anchored };
	}

	// Step 3 — `:nth-of-type` on the anchor. Still says something about *what* the element is, so it
	// is a real rung above `:nth-child` rather than a synonym for it.
	const type = typeIndex(el);
	if (type.total > 1) {
		const withType = [...chain.slice(0, -1), `${anchor.text}:nth-of-type(${type.index})`].join(" ");
		const attempt = evaluate(scope, withType, el, budget);
		if (attempt?.unique === true) {
			return { sel: withType, penalty: penalty + 10, positional: true, unique: true, matches: 1, levels, anchored };
		}
	}

	// Step 4 — the positional last resort. It always resolves *today* and is the first thing to break
	// tomorrow, which is exactly why it is reported as low confidence instead of shipped quietly.
	const path = positionalPath(el, scope);
	if (path !== null) {
		const attempt = evaluate(scope, path, el, budget);
		if (attempt?.unique === true) {
			return { sel: path, penalty: penalty + 50, positional: true, unique: true, matches: 1, levels: MAX_POSITIONAL_DEPTH, anchored };
		}
	}

	return { sel: identitySel, penalty, positional: false, unique: false, matches, levels, anchored };
}

function positionalPath(el: Element, scope: ParentNode): string | null {
	const parts: string[] = [];
	let cursor: Element | null = el;
	while (cursor !== null && cursor !== scope && parts.length < MAX_POSITIONAL_DEPTH) {
		const parent: Element | null = cursor.parentElement;
		if (parent === null) break;
		parts.unshift(`${tagOf(cursor)}:nth-child(${childIndex(cursor)})`);
		if (parent === scope) return parts.join(" > ");
		cursor = parent;
	}
	return parts.length > 0 ? parts.join(" > ") : null;
}

/**
 * Build a runtime selector for `el`, verified by querying it back.
 *
 * Returns `null` only when there is nothing to work with (a detached node, no document). A result
 * whose `unique` is false is still returned — a selector that matches three nodes is information the
 * compose modal should show, and it beats pretending the pick failed.
 */
export function generateSelector(el: Element, options: SelectorOptions = {}): GeneratedSelector | null {
	try {
		return buildSelector(el, options);
	} catch (err) {
		console.error("modkit: selector generation failed", err);
		return null;
	}
}

function buildSelector(el: Element, options: SelectorOptions): GeneratedSelector | null {
	const doc = el.ownerDocument;
	if (doc === null) return null;
	const accepted = options.attributes ?? DEFAULT_ATTRIBUTES;
	const allowPositional = options.allowPositional !== false;
	const budget = new Budget();

	const root = options.root ?? null;
	const usableRoot = root !== null && root !== el && root.contains(el) ? root : null;

	// The root's own selector never goes positional: an `:nth-child` root would re-point the whole
	// mod at a different pane the first time the user opens a second tab.
	const rootSearch = usableRoot === null ? null : search(usableRoot, doc, budget, accepted, false);
	const rootSelector = rootSearch?.sel ?? null;

	const scope: ParentNode = usableRoot ?? doc;
	const scoped = search(el, scope, budget, accepted, allowPositional);
	if (scoped === null) return null;

	const composed = rootSelector === null ? scoped.sel : `${rootSelector} ${scoped.sel}`;
	const final = evaluate(doc, composed, el, budget);
	const matches = final?.matches ?? 0;
	const unique = final?.unique === true;
	const penalty = scoped.penalty + (rootSearch?.penalty ?? 0);

	let confidence: SelectorConfidence;
	let note: string | undefined;
	if (scoped.positional) {
		confidence = "low";
		note =
			"the only thing that made this unique was its position among its siblings, so the mod will re-point at whatever moves into that slot";
	} else if (!scoped.unique) {
		confidence = "low";
		note = `no selector resolved to this element alone — the best available matches ${scoped.matches} node(s)`;
	} else if (!unique) {
		confidence = "medium";
		note = "unique inside its view, but the view itself is not uniquely addressable — a second pane of the same type would also match";
	} else if (scoped.levels >= MAX_ANCESTOR_LEVELS) {
		confidence = "medium";
		note = "needed four levels of ancestry to become unique, so it is sensitive to structural changes in the target";
	} else if (!scoped.anchored && !(rootSearch?.anchored ?? false)) {
		// Unique today, but only by class or tag — no `id` and no attribute anywhere in the chain.
		// Obsidian's classes are hand-written and mostly stable, but "mostly" is a medium claim, not
		// a high one: an attribute like `data-type` names the thing on purpose, a class can be unique
		// by accident of today's markup.
		confidence = "medium";
		note = "unique today, but only through class names — no id or attribute anchors it, so it is a weaker claim than it looks";
	} else {
		confidence = "high";
	}

	const result: GeneratedSelector = {
		selector: composed,
		scoped: scoped.sel,
		rootSelector,
		unique,
		uniqueInRoot: scoped.unique,
		positional: scoped.positional,
		penalty,
		confidence,
		matches,
	};
	if (note !== undefined) result.note = note;
	return result;
}

/**
 * Does `selector` resolve to exactly `el`? Exported because a generated mod's *installer* should ask
 * the same question the picker asked, and get the same answer.
 */
export function isSelectorUnique(el: Element, selector: string, root?: ParentNode | null): boolean {
	const scope: ParentNode | null = root ?? el.ownerDocument;
	if (scope === null) return false;
	try {
		const found = scope.querySelectorAll(selector);
		return found.length === 1 && found.item(0) === el;
	} catch {
		return false;
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Description — the evidence the model reads
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Redactions, copied (not imported) from an earlier app's log redactor so this module stays
 * dependency-free. The picked text is a user's own note content on its way to a cloud model, and a
 * bearer token pasted into a note is exactly the kind of thing a person points at and says "hide
 * this". Sanitising at extraction time is cheap; regretting it later is not.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
	[/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer «redacted»"],
	[/([?&](?:t|token|key)=)[^&\s"']+/gi, "$1«redacted»"],
	[/\b[0-9a-f]{24,}\b/gi, "«hex»"],
];

/**
 * Sanitise and cap one field. Every field goes through this even when its source was already clean:
 * one unsanitised newline or quote in an evidence string reappears as a broken prompt, and finding
 * out which field it was is a bad way to spend an afternoon.
 */
export function clean(value: string, max: number): string {
	let text = String(value ?? "");
	for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
	text = text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/["\\[\]]/g, "'");
	// U+2026 is three bytes; anything measuring a budget must use TextEncoder, never `.length`.
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}\u2026` : text;
}

/** `"li.today-box"` — tag plus up to three of the node's own stable classes. */
function selOf(el: Element): string {
	const classes = stableClasses(el);
	return `${tagOf(el)}${classes.map((c) => `.${c}`).join("")}`;
}

/** `"[2/5]"` — position among same-tag siblings, or `""` when it is the only one. */
function nthOf(el: Element): string {
	const { index, total } = typeIndex(el);
	return total > 1 ? `[${index}/${total}]` : "";
}

/** `"ul.today-boxes<section.card"` — up to three classed ancestors, nearest first, first class only. */
function upOf(el: Element, limit = 3): string {
	const parts: string[] = [];
	let cursor = el.parentElement;
	while (cursor !== null && parts.length < limit) {
		const classes = stableClasses(cursor, 1);
		if (classes.length > 0) parts.push(`${tagOf(cursor)}.${classes[0]!}`);
		cursor = cursor.parentElement;
	}
	return parts.join("<");
}

/** `"<li.today-box><p.today-box-text/></li>"` — one level of child outline. */
function skelOf(el: Element): string {
	const children: string[] = [];
	for (let i = 0; i < el.children.length && children.length < MAX_SKEL_CHILDREN; i++) {
		const child = el.children.item(i);
		if (child !== null) children.push(`<${selOf(child)}/>`);
	}
	if (children.length === 0) return "";
	return `<${selOf(el)}>${children.join("")}</${tagOf(el)}>`;
}

function labelOf(el: Element): string {
	const raw = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("alt") ?? el.getAttribute("title") ?? "";
	return clean(raw, MAX_LABEL);
}

/** `"16,318 328x86"` — rounded CSS-px viewport coordinates. A rect means nothing without a viewport. */
export function rectLabel(rect: DOMRect): string {
	return `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

export interface DescribeOptions {
	/** A selector already generated for this element, so it is not computed twice. */
	selector?: string;
}

/**
 * The durable description of one picked node, in the shared `ElementEvidence` shape.
 *
 * The whole body is defended, because it walks live DOM that a re-render may have replaced
 * mid-walk and it runs outside anything that could catch for it. A node that has gone is reported
 * as `gone: true` rather than dropped: "the thing I pointed at no longer exists" is information the
 * generator can use, and silently shipping four elements when five were picked is not.
 */
export function describeElement(el: Element, options: DescribeOptions = {}): ElementEvidence {
	const evidence: ElementEvidence = { sel: "", nth: "", up: "", label: "", txt: "", rect: "", skel: "" };
	try {
		evidence.sel = selOf(el);
		evidence.nth = nthOf(el);
		evidence.up = upOf(el);
		evidence.label = labelOf(el);
		evidence.txt = clean(el.textContent ?? "", MAX_TEXT);
		evidence.rect = rectLabel(el.getBoundingClientRect());
		evidence.skel = skelOf(el);
		if (!el.isConnected) evidence.gone = true;
		if (options.selector !== undefined) evidence.selector = options.selector;
	} catch (err) {
		console.error("modkit: describing the picked element failed", err);
		evidence.gone = true;
	}
	return evidence;
}

/** `"1440x900"` — the CSS-px viewport the rects were measured in. */
export function viewportLabel(win: Window): string {
	return `${Math.round(win.innerWidth)}x${Math.round(win.innerHeight)}`;
}
