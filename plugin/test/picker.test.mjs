/**
 * `src/picker/selector.ts` — hard — and `src/picker/picker.ts` only as far as an honest stub reaches.
 *
 * ## The harness
 *
 * These tests run against `stub/cssdom.mjs`, a second DOM stub with a real selector engine, added
 * for this file. `stub/dom.mjs` cannot serve here and says so in its own header: its
 * `querySelectorAll` understands `tag` and `tag[attr="value"]` and returns an empty list for
 * everything else. `selector.ts`'s entire contract is *"the selector I emit, I queried back"* — it
 * runs every candidate through `querySelectorAll` and believes it only if the picked node comes
 * back. Against a matcher that answers "no match" to `.nav-file-title:nth-of-type(2)`, every
 * candidate scores zero and the search falls to its last resort every time; the suite would be
 * green about a code path the product never takes. So the engine is real, and it is itself tested
 * first, in `describe("the harness's own selector engine")` — a test that trusts an untested
 * matcher is measuring the matcher.
 *
 * `cssdom` also *throws* on grammar it does not implement, rather than returning nothing, and
 * records the throw on `document.selectorErrors`. That matters because `selector.ts` deliberately
 * swallows query exceptions (`evaluate()` catches and returns "no answer"), so a selector it emits
 * that the engine cannot read would vanish into the miss branch. Every test below asserts
 * `selectorErrors` is empty.
 *
 * ## Where this stops — `picker.ts`
 *
 * Only `resolveOwnerFor` is covered, because it is the only exported pure function and the only one
 * whose inputs a stub can supply honestly. **Everything else in `picker.ts` is untested here, and
 * the reason is the same in every case: this harness has no layout and no event propagation.**
 * Specifically NOT covered, and not claimable from a green run of this file:
 *
 * - `isPickable`'s 10×8 size floor, viewport clipping and `checkVisibility` — `getBoundingClientRect`
 *   returns whatever a test assigned, so any result would be the test's own stipulation.
 * - `collapseCoincident`'s outward wrapper walk, for the same reason.
 * - `candidateAt` / `elementsFromPoint` hit-testing — there is no hit testing without layout.
 * - The capture-phase interception that guarantees the underlying UI never receives the click, the
 *   `Scope` + keydown Escape pair, right-click, and the 90-second idle timeout. `cssdom` has no
 *   `addEventListener` at all, deliberately, so that none of this can be faked.
 * - Popout-window handling (`activeDocument`, releasing a timer on the window that issued it).
 * - `regionOf`, which is not exported.
 *
 * Those need a real Obsidian, or a DOM with layout and an event loop. Neither is here.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createCssDom, CssElement } from "./stub/cssdom.mjs";
import { compileSurface } from "./stub/compile.mjs";

const surface = await compileSurface(
	"picker-surface",
	`
	export {
		allStableClasses,
		clean,
		describeElement,
		escapeIdent,
		generateSelector,
		isSelectorUnique,
		isStableClass,
		rectLabel,
		stableClasses,
		viewportLabel,
	} from "../../src/picker/selector";
	export { resolveOwnerFor } from "../../src/picker/picker";
	`,
);

const {
	allStableClasses,
	clean,
	describeElement,
	escapeIdent,
	generateSelector,
	isSelectorUnique,
	isStableClass,
	rectLabel,
	stableClasses,
	viewportLabel,
	resolveOwnerFor,
} = surface;

for (const [name, value] of Object.entries(surface)) {
	if (name === "default") continue;
	assert.equal(typeof value, "function", `the picker bundle's ${name} is not a function — did an export get renamed?`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures — realistic Obsidian DOM
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The shape a real vault has: an app container, a workspace split, and two leaves — a file explorer
 * in the left split and a markdown pane in the root split. Class names and `data-type`/`data-path`
 * attributes are Obsidian's own.
 */
function obsidianVault() {
	const { document, window } = createCssDom();
	const app = document.body.el("div.app-container");
	const main = app.el("div.horizontal-main-container");
	const workspace = main.el("div.workspace");

	const leftSplit = workspace.el("div.workspace-split.mod-horizontal.mod-left-split");
	const leftLeaf = leftSplit.el("div.workspace-leaf");
	const explorer = leftLeaf.el("div.workspace-leaf-content[data-type=file-explorer]");
	const explorerContent = explorer.el("div.view-content");
	const navFiles = explorerContent.el("div.nav-files-container");

	const files = [];
	for (const path of ["Daily/2026-08-29.md", "Daily/2026-08-30.md", "Daily/2026-08-31.md"]) {
		const item = navFiles.el("div.tree-item.nav-file");
		const title = item.el("div.tree-item-self.nav-file-title", { attr: { "data-path": path } });
		title.el("div.tree-item-inner.nav-file-title-content", { text: path.split("/")[1] });
		files.push({ item, title });
	}

	const rootSplit = workspace.el("div.workspace-split.mod-vertical.mod-root");
	const tabs = rootSplit.el("div.workspace-tabs");
	const rootLeaf = tabs.el("div.workspace-leaf");
	const markdown = rootLeaf.el("div.workspace-leaf-content[data-type=markdown][data-mode=source]");
	const view = markdown.el("div.view-content");
	const preview = view.el("div.markdown-preview-view");

	const statusBar = app.el("div.status-bar");
	const ribbon = main.el("div.workspace-ribbon.side-dock-ribbon");

	return { document, window, app, workspace, explorer, navFiles, files, markdown, preview, statusBar, ribbon };
}

/** Assert the engine was never asked something it does not implement. */
function noSelectorErrors(document) {
	assert.deepEqual(
		document.selectorErrors,
		[],
		"selector.ts emitted grammar the harness cannot parse — its own `evaluate` would have swallowed this as a miss",
	);
}

/** The two claims that matter for every generated selector, checked together. */
function assertResolvesToExactly(document, result, el) {
	assert.notEqual(result, null, "no selector was generated at all");
	const found = document.querySelectorAll(result.selector);
	assert.equal(found.length, 1, `"${result.selector}" matched ${found.length} nodes, expected exactly 1`);
	assert.equal(found.item(0), el, `"${result.selector}" resolved to the wrong node`);
	assert.equal(result.unique, true, "the result claims it is not unique, but it is");
	assert.equal(isSelectorUnique(el, result.selector), true, "isSelectorUnique disagrees with the generator");
}

/* ────────────────────────────────────────────────────────────────────────────
 * The harness's own engine
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the harness's own selector engine", () => {
	test("matches the grammar selector.ts emits", () => {
		const vault = obsidianVault();
		const { document } = vault;
		const at = (sel) => document.querySelectorAll(sel).length;

		assert.equal(at("div.nav-file"), 3);
		assert.equal(at(".nav-files-container .nav-file-title"), 3);
		assert.equal(at(".nav-files-container > .nav-file"), 3);
		assert.equal(at('[data-path="Daily/2026-08-30.md"]'), 1, "an attribute value with a slash and a dot");
		assert.equal(at('[data-type="markdown"][data-mode="source"]'), 1, "two attributes in one compound");
		assert.equal(at("div.tree-item.nav-file:nth-child(2)"), 1);
		assert.equal(at("div.nav-file:nth-of-type(3)"), 1);
		assert.equal(at(".status-bar, .workspace-ribbon"), 2, "a selector list");
		assert.equal(at("div > div"), document.querySelectorAll("div").length - 1, "every div but the outermost");
	});

	test("scoping is the DOM's: descendants only, and a left-hand side may sit above the scope", () => {
		const vault = obsidianVault();
		assert.equal(vault.explorer.querySelectorAll(".workspace-leaf-content").length, 0, "the scope is not its own descendant");
		assert.equal(vault.explorer.querySelectorAll(".nav-file").length, 3);
		assert.equal(
			vault.explorer.querySelectorAll(".app-container .nav-file").length,
			3,
			"the ancestor part may match outside the scope, as in a browser",
		);
	});

	test("an unimplemented selector throws AND is recorded, rather than reading as a miss", () => {
		const { document } = createCssDom();
		assert.throws(() => document.querySelectorAll("div:not(.x)"), /cannot parse/);
		assert.throws(() => document.querySelectorAll("a ~ b"), /cannot parse/);
		assert.throws(() => document.querySelectorAll("[data-x^=y]"), /cannot parse/);
		assert.equal(document.selectorErrors.length, 3);
	});

	test("`:nth-child` counts elements, not text nodes", () => {
		const { document } = createCssDom();
		const ul = document.body.el("ul.list");
		ul.textContent = "leading text";
		const a = ul.el("li");
		const b = ul.el("li");
		assert.equal(document.querySelector("li:nth-child(1)"), a);
		assert.equal(document.querySelector("li:nth-child(2)"), b);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Generation — does the selector actually re-select the element?
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the emitted selector re-selects the original element and nothing else", () => {
	test("across a realistic Obsidian tree", () => {
		const vault = obsidianVault();
		const targets = [vault.explorer, vault.navFiles, vault.files[1].title, vault.markdown, vault.preview, vault.statusBar];

		for (const el of targets) {
			const result = generateSelector(el);
			assertResolvesToExactly(vault.document, result, el);
		}
		noSelectorErrors(vault.document);
	});

	test("scoped to a leaf, the composed selector still resolves document-wide", () => {
		const vault = obsidianVault();
		const el = vault.files[2].title;
		const result = generateSelector(el, { root: vault.explorer });

		assert.notEqual(result.rootSelector, null, "a root was given and is addressable");
		assert.equal(result.selector, `${result.rootSelector} ${result.scoped}`, "the composite is root + scoped");
		assert.equal(vault.explorer.querySelectorAll(result.scoped).length, 1, "`scoped` must resolve inside the root");
		assertResolvesToExactly(vault.document, result, el);
		assert.equal(result.uniqueInRoot, true);
		noSelectorErrors(vault.document);
	});

	test("a root that does not contain the element is ignored rather than producing a selector that cannot match", () => {
		const vault = obsidianVault();
		const el = vault.files[0].title;
		const result = generateSelector(el, { root: vault.markdown });

		assert.equal(result.rootSelector, null, "an unrelated root must be dropped");
		assertResolvesToExactly(vault.document, result, el);
	});

	test("a stable id is preferred over everything else, at penalty zero", () => {
		const vault = obsidianVault();
		const el = vault.preview.el("div.callout.mod-warning");
		el.setAttribute("id", "release-notes");

		const result = generateSelector(el);
		assert.equal(result.selector, "#release-notes");
		assert.equal(result.penalty, 0);
		assert.equal(result.confidence, "high");
		assertResolvesToExactly(vault.document, result, el);
	});

	test("a uuid-shaped id is refused — it is regenerated on every mount", () => {
		const vault = obsidianVault();
		const el = vault.preview.el("div.callout");
		el.setAttribute("id", "a1b2c3d4-9f8e-4321-aaaa-bbbbccccdddd");

		const result = generateSelector(el);
		assert.equal(/a1b2c3d4/.test(result.selector), false, `anchored to a volatile id: ${result.selector}`);
		assertResolvesToExactly(vault.document, result, el);
	});

	test("a null ownerDocument is the one case that returns null, not a guess", () => {
		assert.equal(generateSelector(new CssElement("div", null)), null);
	});

	test("the query budget is honoured — a picker must not make the app hitch", () => {
		const vault = obsidianVault();
		// A wide, uniform subtree: nothing here is distinctive, so the search does as much work as it
		// is ever allowed to do.
		const grid = vault.preview.el("div.grid");
		for (let i = 0; i < 60; i++) {
			const row = grid.el("div.row");
			for (let j = 0; j < 4; j++) row.el("span");
		}
		const deep = grid.children[59].children[3];

		const before = vault.document.queryCount;
		generateSelector(deep, { root: vault.markdown });
		const spent = vault.document.queryCount - before;
		assert.ok(spent <= 80, `generation spent ${spent} queries; the documented ceiling is 80`);
		assert.ok(spent > 1, "a budget test that never spent anything proves nothing");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * Stability
 * ──────────────────────────────────────────────────────────────────────────── */

describe("stability across sibling insertion", () => {
	test("an identity-anchored selector survives a sibling appearing before it", () => {
		const vault = obsidianVault();
		const el = vault.files[1].title;
		const result = generateSelector(el, { root: vault.explorer });
		assert.equal(result.positional, false, "this fixture is meant to be identity-anchored");

		// A file lands in the folder — the single most ordinary thing that happens to this tree.
		const fresh = vault.navFiles.el("div.tree-item.nav-file");
		fresh.el("div.tree-item-self.nav-file-title", { attr: { "data-path": "Daily/2026-08-01.md" } });
		vault.navFiles.insertBefore(fresh, vault.files[0].item);

		const found = vault.document.querySelectorAll(result.selector);
		assert.equal(found.length, 1, `"${result.selector}" now matches ${found.length} nodes`);
		assert.equal(found.item(0), el, "the selector re-pointed at a different node after an insertion");
		noSelectorErrors(vault.document);
	});

	test("high confidence survives the whole subtree being re-rendered with the same classes", () => {
		// Obsidian re-renders the file explorer wholesale; the nodes are new objects with the same
		// attributes. A selector that says *what a thing is* finds the replacement.
		const vault = obsidianVault();
		const el = vault.files[2].title;
		const result = generateSelector(el, { root: vault.explorer });
		assert.equal(result.confidence, "high");

		const paths = ["Daily/2026-08-29.md", "Daily/2026-08-30.md", "Daily/2026-08-31.md"];
		for (const child of vault.navFiles.children) child.remove();
		let replacement = null;
		for (const path of paths) {
			const item = vault.navFiles.el("div.tree-item.nav-file");
			const title = item.el("div.tree-item-self.nav-file-title", { attr: { "data-path": path } });
			if (path === "Daily/2026-08-31.md") replacement = title;
		}

		const found = vault.document.querySelectorAll(result.selector);
		assert.equal(found.length, 1);
		assert.equal(found.item(0), replacement, "the selector did not find the re-rendered node");
	});

	test("a POSITIONAL selector is honestly labelled — and it does break on insertion", () => {
		// The label is only worth having if it predicts something. So the same insertion is run
		// against a positional result and the breakage is asserted, not assumed.
		const { document } = createCssDom();
		const list = document.body.el("ul.today-boxes");
		const items = Array.from({ length: 5 }, () => list.el("li"));
		const el = items[2];

		const result = generateSelector(el);
		assert.equal(result.positional, true, "nothing but position distinguishes these siblings");
		assert.equal(result.confidence, "low");
		assert.match(result.note, /position among its siblings/);
		assertResolvesToExactly(document, result, el);

		const intruder = document.createElement("li");
		list.insertBefore(intruder, items[0]);

		const found = document.querySelectorAll(result.selector);
		assert.notEqual(found.item(0), el, "a positional selector that survived an insertion — the `low` label would be wrong");
		assert.equal(found.item(0), items[1], "it re-points at whatever moved into the slot, exactly as the note says");
		noSelectorErrors(document);
	});

	test("`:nth-of-type` is preferred over the `:nth-child` path — it still says what the thing is", () => {
		const { document } = createCssDom();
		const list = document.body.el("ul.today-boxes");
		for (let i = 0; i < 4; i++) list.el("li");
		const el = list.children[2];

		const result = generateSelector(el);
		assert.match(result.selector, /nth-of-type\(3\)/);
		assert.equal(/nth-child/.test(result.selector), false, "the cheaper positional rung was skipped");
		assert.equal(result.penalty >= 10, true, "finder's scale prices :nth-of-type at 10");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The fallback ladder
 * ──────────────────────────────────────────────────────────────────────────── */

describe("when no stable selector exists", () => {
	test("`allowPositional: false` returns a non-unique answer rather than pretending", () => {
		const { document } = createCssDom();
		const list = document.body.el("ul.today-boxes");
		for (let i = 0; i < 5; i++) list.el("li");

		const result = generateSelector(list.children[2], { allowPositional: false });
		assert.equal(result.unique, false);
		assert.equal(result.positional, false);
		assert.equal(result.confidence, "low");
		assert.match(result.note, /matches 5 node\(s\)/, "the note must say how ambiguous it is, not just that it is");
		assert.equal(document.querySelectorAll(result.selector).length, 5, "a non-unique selector is still returned and still resolves");
	});

	test("unique in its view but the view is not addressable → medium, and the note says why", () => {
		// Two panes of the same type is the ordinary case, not an exotic one: it is what happens the
		// first time the user splits the editor.
		const { document } = createCssDom();
		const workspace = document.body.el("div.workspace");
		const panes = [0, 1].map(() => {
			const leaf = workspace.el("div.workspace-leaf");
			const content = leaf.el("div.workspace-leaf-content[data-type=markdown]");
			const inner = content.el("div.view-content");
			inner.el("div.some-widget");
			return content;
		});
		const el = panes[0].querySelector(".some-widget");

		const result = generateSelector(el, { root: panes[0] });
		assert.equal(result.uniqueInRoot, true, "inside its own pane it is the only one");
		assert.equal(result.unique, false, "document-wide the sibling pane matches too");
		assert.equal(result.confidence, "medium");
		assert.match(result.note, /second pane of the same type would also match/);
		assert.equal(result.matches, 2);
		noSelectorErrors(document);
	});

	test("the root's own selector never goes positional", () => {
		// An `:nth-child` root would re-point the whole mod at a different pane the first time the
		// user opens a second tab.
		const { document } = createCssDom();
		const workspace = document.body.el("div.workspace");
		const roots = [0, 1].map(() => workspace.el("div.workspace-leaf-content[data-type=markdown]"));
		const el = roots[1].el("div.view-content").el("div.some-widget");

		const result = generateSelector(el, { root: roots[1] });
		assert.equal(/nth-/.test(result.rootSelector ?? ""), false, `the root went positional: ${result.rootSelector}`);
	});

	test("four levels of ancestry is reported as medium, not high", () => {
		const { document } = createCssDom();
		const outer = document.body.el("div.pane-a");
		let cursor = outer;
		for (const cls of ["level-one", "level-two", "level-three"]) cursor = cursor.el(`div.${cls}`);
		const el = cursor.el("div.leaf-node");
		// A decoy that only the full ancestry distinguishes from the target.
		const decoy = document.body.el("div.pane-b");
		let other = decoy;
		for (const cls of ["level-one", "level-two", "level-three"]) other = other.el(`div.${cls}`);
		other.el("div.leaf-node");

		const result = generateSelector(el);
		assertResolvesToExactly(document, result, el);
		assert.equal(["medium", "high"].includes(result.confidence), true, result.confidence);
		if (result.confidence === "medium") assert.match(result.note, /four levels of ancestry/);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * What may go into a selector
 * ──────────────────────────────────────────────────────────────────────────── */

describe("class filtering", () => {
	test("isStableClass draws the documented line", () => {
		for (const good of ["nav-file-title", "tree-item", "callout", "mod_warning", "_private", "cm-line"]) {
			assert.equal(isStableClass(good), true, `${good} should be usable`);
		}
		for (const bad of [
			"", // nothing
			"is-active", // state
			"has-focus", // state
			"active",
			"mod-active",
			"mod-cta", // a modifier, not a layout position — the "mod-" prefix is denied by default
			"collapsed",
			"modkit-picker-box", // ours
			"css-1a2b3c4", // css-modules
			"sc-abcdef12", // styled-components
			"tw-19dj2k", // tailwind-ish
			"a12345", // counter-shaped
			"x7f3a91bc", // hash-shaped: long, mixed, unseparated
			"9-leading-digit",
			"has space",
			// MEASURED 2026-09-02: the search-tab-icon mod anchored on `.tappable`, a touch-platform
			// state class present on every tab header, and matched nothing on a build where it had
			// moved. It was never identity to begin with.
			"tappable",
			// CodeMirror 6 cursor/selection state — comes and goes with focus, not structure.
			"cm-focused",
			"cm-activeLine",
			"cm-selectionBackground",
		]) {
			assert.equal(isStableClass(bad), false, `${bad} should be refused`);
		}
		assert.equal(isStableClass("a".repeat(41)), false, "an over-long class is machine-generated");
	});

	test("a `mod-` class that names a layout position, not a state, is the named exception to the prefix ban", () => {
		// `.workspace-split.mod-vertical.mod-root` (the obsidianVault fixture below) is real Obsidian
		// markup, and a blanket "mod-*" ban would have made the root split itself unpickable.
		for (const structural of [
			"mod-root",
			"mod-left-split",
			"mod-vertical",
			// Sidebar dock tab strips and a stacked-tabs container — added after a review found the
			// blanket "mod-" deny pushed a sidebar pick down to `:nth-of-type`/positional without them
			// (PLAN.md 2026-09-02): with both docks denied identity classes, nothing told the left dock's
			// `.workspace-tabs` from the right one's.
			"mod-top-left-space",
			"mod-top-right-space",
			"mod-stacked",
		]) {
			assert.equal(isStableClass(structural), true, `${structural} should be usable — it is a layout position, not a state`);
		}
	});

	test("two sidebar `.workspace-tabs` stay non-positional now that each dock's own class is stable", () => {
		const { document } = createCssDom();
		const left = document.body.el("div.workspace-tabs.mod-top-left-space");
		const leftHeader = left.el("div.workspace-tab-header", { attr: { "data-type": "search" } });
		const right = document.body.el("div.workspace-tabs.mod-top-right-space");
		right.el("div.workspace-tab-header", { attr: { "data-type": "search" } });

		const result = generateSelector(leftHeader);
		assertResolvesToExactly(document, result, leftHeader);
		assert.equal(result.positional, false, `two identically-classed docks forced a positional fallback: ${result.selector}`);
		assert.match(result.selector, /mod-top-left-space/, `did not anchor on the dock that tells the two apart: ${result.selector}`);
	});

	test("a state class never reaches the selector, even when it would have made it unique", () => {
		const { document } = createCssDom();
		const list = document.body.el("div.nav-files-container");
		for (let i = 0; i < 3; i++) list.el("div.nav-file-title");
		const el = list.children[1];
		el.classList.add("is-active"); // the user happens to have this file selected right now

		const result = generateSelector(el);
		assert.equal(/is-active/.test(result.selector), false, `anchored to a state class: ${result.selector}`);
		assert.equal(result.positional, true, "with state excluded, position is all that is left — which is the honest answer");
	});

	test("`aria-label` is never put in a selector, because in Obsidian it carries the user's content", () => {
		const { document } = createCssDom();
		const bar = document.body.el("div.status-bar");
		const a = bar.el("div.status-bar-item");
		const b = bar.el("div.status-bar-item");
		a.setAttribute("aria-label", "Open Personal/Therapy notes.md");
		b.setAttribute("aria-label", "Open Work/standup.md");

		const result = generateSelector(a);
		assert.equal(/aria-label/.test(result.selector), false, `aria-label leaked into a persisted selector: ${result.selector}`);
		assert.equal(/Therapy/.test(result.selector), false, "a private note title leaked into a persisted selector");
		assertResolvesToExactly(document, result, a);
	});

	test("PINNED, and in tension with the rule above: `data-path` DOES carry the user's file path in", () => {
		// Not a failing assertion — a pin, so the tension is visible in the suite rather than only in a
		// review. `DEFAULT_ATTRIBUTES` includes `data-path`, and the comment that excludes `aria-label`
		// justifies itself with "it is a *content* value in Obsidian (a note title, a tag name, **a
		// file path**)". A file path is exactly what `data-path` holds, and it wins outright here: it
		// is the cheapest unique token in the file explorer, so it is chosen at high confidence and
		// written into a selector that is persisted, synced, and shown to a cloud model.
		//
		// Whether that is acceptable is the author's call — it is by far the most stable anchor the
		// file explorer offers. What is not tenable is the two rules disagreeing silently.
		const { document } = createCssDom();
		const nav = document.body.el("div.nav-files-container");
		for (const path of ["Personal/Therapy session notes.md", "Work/standup.md"]) {
			nav.el("div.tree-item.nav-file").el("div.tree-item-self.nav-file-title", { attr: { "data-path": path } });
		}
		const el = nav.children[0].children[0];

		const result = generateSelector(el);
		assert.equal(result.selector, '[data-path="Personal/Therapy session notes.md"]');
		assert.equal(result.confidence, "high");
	});

	test("`stableClasses` caps at three and `allStableClasses` does not", () => {
		const { document } = createCssDom();
		const el = document.body.el("div.one.two.three.four.five");
		el.classList.add("is-active");
		assert.deepEqual(stableClasses(el), ["one", "two", "three"]);
		assert.deepEqual(allStableClasses(el), ["one", "two", "three", "four", "five"]);
	});

	test("escapeIdent produces something the engine can read back", () => {
		const { document } = createCssDom();
		const el = document.body.el("div");
		el.classList.add("weird:name");
		assert.equal(escapeIdent("weird:name"), "weird\\:name");
		assert.equal(document.querySelectorAll(`.${escapeIdent("weird:name")}`).item(0), el);
	});

	test("an attribute is preferred over a class that is ALSO unique — the design fact beats the accident", () => {
		// Both `.only-one-of-these` and `[data-mode="x"]` are individually unique here. Before
		// 2026-09-02 the class was tried first and would have won; an attribute naming the thing on
		// purpose is the stronger claim and should be chosen even when a class would also resolve.
		const { document } = createCssDom();
		const el = document.body.el("div.only-one-of-these", { attr: { "data-mode": "x" } });
		const result = generateSelector(el);
		assert.equal(result.selector, '[data-mode="x"]');
		assert.equal(result.confidence, "high");
	});

	test("unique by class alone — no id, no attribute — is MEDIUM, not high: a class can be unique by accident", () => {
		const { document } = createCssDom();
		const el = document.body.el("div.only-of-its-kind");
		const result = generateSelector(el);
		assert.equal(result.selector, ".only-of-its-kind");
		assert.equal(result.unique, true, "it really is unique — the point is that confidence still reflects HOW");
		assert.equal(result.confidence, "medium");
		assert.match(result.note, /only through class names/);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The 2026-09-02 regression: the search-tab-icon mod that does nothing
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The tab-header markup described in the review brief — four headers, one of them (Search)
 * currently active — RECONSTRUCTED from that description, not observed. `.workspace-tab-header`,
 * `tappable`, `is-active`, the `-inner` wrapper and the nested `-inner-icon` div are the brief's own
 * shape; PLAN.md itself carries only the broken selector string
 * (`.workspace-tab-header.tappable[data-type='search'] …`) and prose, not markup. The brief also
 * states the `-inner-icon` class is *not present* on the real build this bug was measured on, so
 * this fixture is a stand-in for "markup this shape could plausibly have had", useful for proving
 * the class-deny-list logic and nothing stronger than that. `aria-label` is included because the
 * real header carries one — see the `aria-label` assertions below for why it must never appear in
 * the emitted selector regardless.
 */
function tabHeaderFixture() {
	const { document, window } = createCssDom();
	const container = document.body.el("div.workspace-tab-header-container");
	const headers = {};
	for (const [type, label] of [
		["search", "Search"],
		["bookmarks", "Bookmarks"],
		["file-explorer", "Files"],
		["tag", "Tags"],
	]) {
		const classes = type === "search" ? "div.workspace-tab-header.tappable.is-active" : "div.workspace-tab-header.tappable";
		const header = container.el(classes, { attr: { "data-type": type, "aria-label": label, draggable: "true" } });
		const inner = header.el("div.workspace-tab-header-inner");
		const icon = inner.el("div.workspace-tab-header-inner-icon");
		inner.el("div.workspace-tab-header-inner-title", { text: label });
		headers[type] = { header, inner, icon };
	}
	return { document, window, container, headers };
}

describe("the search-tab-icon no-effect regression (PLAN.md, measured 2026-09-02)", () => {
	test("picking the header itself never carries `tappable` or `is-active`, and is attribute-anchored at high confidence", () => {
		const vault = tabHeaderFixture();
		const header = vault.headers.search.header;
		const result = generateSelector(header);

		assertResolvesToExactly(vault.document, result, header);
		assert.equal(/tappable/.test(result.selector), false, `carried the platform class: ${result.selector}`);
		assert.equal(/is-active/.test(result.selector), false, `carried a state class: ${result.selector}`);
		assert.equal(
			/aria-label/.test(result.selector),
			false,
			// The brief lists `[aria-label=…]` in its preference order, but `DEFAULT_ATTRIBUTES`
			// deliberately excludes it (see "class filtering" above) — in Obsidian it routinely carries
			// note titles, tags and file paths, and this header's own `aria-label` is real evidence
			// that the exclusion isn't merely theoretical here.
			`aria-label leaked into a persisted selector: ${result.selector}`,
		);
		assert.match(result.selector, /\[data-type="search"\]/, `not attribute-anchored: ${result.selector}`);
		assert.equal(result.confidence, "high");
		noSelectorErrors(vault.document);
	});

	test("picking the nested icon resolves to it alone, anchored on the header's `data-type` — never on `tappable`", () => {
		// This is the exact shape of the bug: the icon's own class is shared by all four headers, so
		// the search has to climb to an ancestor to become unique. Before the fix, the ancestor token
		// combined ALL of the header's stable classes with the attribute, including `.tappable`; the
		// class deny-list is what keeps that ancestor token down to identity plus attribute.
		const vault = tabHeaderFixture();
		const icon = vault.headers.search.icon;
		const result = generateSelector(icon);

		assertResolvesToExactly(vault.document, result, icon);
		assert.equal(/tappable/.test(result.selector), false, `carried the platform class: ${result.selector}`);
		assert.equal(/is-active/.test(result.selector), false, `carried a state class: ${result.selector}`);
		assert.match(result.selector, /\[data-type="search"\]/, `not anchored on the header's attribute: ${result.selector}`);
		assert.equal(result.confidence, "high", `expected attribute-anchored → high, got ${result.confidence}: ${result.note ?? ""}`);
		noSelectorErrors(vault.document);
	});

	test("all four tab headers resolve to their own attribute-anchored selector, picked directly", () => {
		const vault = tabHeaderFixture();
		for (const [type, { header }] of Object.entries(vault.headers)) {
			const result = generateSelector(header);
			assertResolvesToExactly(vault.document, result, header);
			assert.match(result.selector, new RegExp(`\\[data-type="${type}"\\]`), `${type}: not attribute-anchored — ${result.selector}`);
			assert.equal(/tappable/.test(result.selector), false, `${type}: carried the platform class`);
		}
		noSelectorErrors(vault.document);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * describeElement — the evidence the model reads
 * ──────────────────────────────────────────────────────────────────────────── */

describe("describeElement", () => {
	test("produces every field, in the documented shapes", () => {
		const vault = obsidianVault();
		const el = vault.files[1].title;
		el.rect = { left: 16, top: 318, width: 328, height: 86 };

		const evidence = describeElement(el, { selector: "[data-path]" });
		assert.equal(evidence.sel, "div.tree-item-self.nav-file-title");
		assert.equal(evidence.nth, "", "it is the only div among its siblings");
		assert.equal(evidence.up, "div.tree-item<div.nav-files-container<div.view-content");
		assert.equal(evidence.rect, "16,318 328x86");
		assert.equal(evidence.txt, "2026-08-30.md");
		assert.equal(evidence.skel, "<div.tree-item-self.nav-file-title><div.tree-item-inner.nav-file-title-content/></div>");
		assert.equal(evidence.selector, "[data-path]");
		assert.equal(evidence.gone, undefined);
	});

	test("`nth` reports position among same-tag siblings", () => {
		const vault = obsidianVault();
		assert.equal(describeElement(vault.files[1].item).nth, "[2/3]");
	});

	test("a detached node is reported `gone`, not dropped", () => {
		const vault = obsidianVault();
		const el = vault.files[0].title;
		el.remove();
		assert.equal(describeElement(el).gone, true);
	});

	test("secrets in the picked text are redacted before they leave for a cloud model", () => {
		const { document } = createCssDom();
		const el = document.body.el("div.markdown-preview-view");
		el.textContent = "curl -H 'Authorization: Bearer sk-abc123XYZ_tok' https://x/?token=hunter2 id=0123456789abcdef0123456789";

		const evidence = describeElement(el);
		assert.equal(/sk-abc123XYZ_tok/.test(evidence.txt), false, `a bearer token survived: ${evidence.txt}`);
		assert.match(evidence.txt, /Bearer «redacted»/);
		assert.equal(/hunter2/.test(evidence.txt), false, "a `token=` query parameter survived");
		assert.equal(/0123456789abcdef/.test(evidence.txt), false, "a long hex string survived");
	});

	test("the label falls back through aria-label → placeholder → alt → title", () => {
		const { document } = createCssDom();
		const withAria = document.body.el("div.a");
		withAria.setAttribute("aria-label", "Toggle sidebar");
		const withTitle = document.body.el("div.b");
		withTitle.setAttribute("title", "Only a title");

		assert.equal(describeElement(withAria).label, "Toggle sidebar");
		assert.equal(describeElement(withTitle).label, "Only a title");
		assert.equal(describeElement(document.body.el("div.c")).label, "");
	});

	test("`clean` caps with an ellipsis, flattens control characters and neutralises quoting", () => {
		assert.equal(clean("a\nb\tc   d", 40), "a b c d");
		assert.equal(clean('say "hi" [there] \\ok', 40), "say 'hi' 'there' 'ok");
		const capped = clean("x".repeat(100), 10);
		assert.equal(capped.length, 10);
		assert.equal(capped.endsWith("…"), true);
		assert.equal(clean(null, 10), "");
	});

	test("text and label are capped at their documented lengths", () => {
		const { document } = createCssDom();
		const el = document.body.el("div.long");
		el.textContent = "y".repeat(500);
		el.setAttribute("aria-label", "z".repeat(500));
		const evidence = describeElement(el);
		assert.equal(evidence.txt.length, 80);
		assert.equal(evidence.label.length, 60);
	});

	test("rectLabel and viewportLabel round to whole CSS pixels", () => {
		assert.equal(rectLabel({ left: 15.6, top: 317.4, width: 327.8, height: 85.5 }), "16,317 328x86");
		assert.equal(viewportLabel({ innerWidth: 1440.4, innerHeight: 899.6 }), "1440x900");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * picker.ts — attribution only. See the file header for what is left alone.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("resolveOwnerFor — the attribution ladder", () => {
	const TASKS = { id: "obsidian-tasks-plugin", name: "Tasks", version: "7.21.0", slug: "tasks" };
	const DATAVIEW = { id: "dataview", name: "Dataview", version: "0.5.64", slug: "dataview" };
	const INDEX = [TASKS, DATAVIEW];

	/** `LeafSnapshot` is read for `viewType` alone by this function; the rest is not consulted. */
	const leafOf = (viewType) => ({ leaf: {}, view: {}, containerEl: {}, viewType });

	function elementWith(classes) {
		const { document } = createCssDom();
		let cursor = document.body;
		for (const cls of classes) cursor = cursor.el(`div.${cls}`);
		return cursor;
	}

	test("a plugin's own view, named by its view type → high confidence", () => {
		const owner = resolveOwnerFor(elementWith(["thing"]), leafOf("dataview"), "leaf", INDEX);
		assert.equal(owner.kind, "plugin");
		assert.equal(owner.confidence, "high");
		assert.equal(owner.pluginId, "dataview");
		assert.equal(owner.summary, "Dataview 0.5.64");
		assert.match(owner.why, /Dataview's own UI/);
	});

	test("a view type prefixed with the plugin's name → medium, and it says so", () => {
		const owner = resolveOwnerFor(elementWith(["thing"]), leafOf("tasks-view"), "leaf", INDEX);
		assert.equal(owner.kind, "plugin");
		assert.equal(owner.confidence, "medium");
		assert.equal(owner.pluginId, "obsidian-tasks-plugin");
		assert.match(owner.why, /Change the target if that is wrong/);
	});

	test("a plugin decorating one of Obsidian's own views is attributed by class, at medium", () => {
		// The commonest real case: a Tasks block inside a plain markdown view. The view type says
		// nothing, so the class is the evidence.
		const owner = resolveOwnerFor(elementWith(["markdown-preview-view", "tasks-list-item"]), leafOf("markdown"), "leaf", INDEX);
		assert.equal(owner.kind, "plugin");
		assert.equal(owner.confidence, "medium");
		assert.equal(owner.pluginId, "obsidian-tasks-plugin");
		assert.match(owner.why, /sits inside Obsidian's own markdown/);
		assert.match(owner.why, /Switch to Obsidian core/);
	});

	test("Obsidian's own view with nothing else claiming it → core, with the internal plugin id", () => {
		const owner = resolveOwnerFor(elementWith(["nav-file-title"]), leafOf("file-explorer"), "leaf", INDEX);
		assert.equal(owner.kind, "core");
		assert.equal(owner.confidence, "high");
		assert.equal(owner.internalPluginId, "file-explorer");
		assert.match(owner.why, /most Obsidian customization is core patching/);
	});

	test("an unattributable plugin view says so instead of guessing", () => {
		const owner = resolveOwnerFor(elementWith(["thing"]), leafOf("some-unknown-view"), "leaf", []);
		assert.equal(owner.kind, "unknown");
		assert.equal(owner.confidence, "low");
		assert.equal(owner.summary, "Unattributed · some-unknown-view");
		assert.match(owner.why, /Obsidian does not record which one/);
	});

	test("an AMBIGUOUS answer becomes ask-the-user, not a confident wrong one", () => {
		// Two plugins whose slugs both hit the same rung: without the decisiveness margin, one of them
		// would be reported as the owner with high confidence on a coin toss.
		const twins = [
			{ id: "tasks", name: "Tasks", version: "1.0.0", slug: "tasks" },
			{ id: "tasks", name: "Tasks Two", version: "2.0.0", slug: "tasks" },
		];
		const owner = resolveOwnerFor(elementWith(["thing"]), leafOf("tasks"), "leaf", twins);
		assert.equal(owner.kind, "unknown");
		assert.equal(owner.confidence, "low");
		assert.equal(owner.candidates.length, 2, "the runners-up must survive into the modal");
	});

	test("outside a leaf, the region is the answer and it is a legitimate one", () => {
		const ribbon = resolveOwnerFor(elementWith(["side-dock-ribbon-action"]), null, "ribbon", INDEX);
		assert.equal(ribbon.kind, "core");
		assert.equal(ribbon.confidence, "high");
		assert.match(ribbon.why, /the ribbon/);

		const nowhere = resolveOwnerFor(elementWith(["mystery"]), null, "unknown", INDEX);
		assert.equal(nowhere.kind, "core");
		assert.equal(nowhere.confidence, "low", "an unidentified region is not something to be confident about");
	});

	test("candidates are carried even when confidence is high", () => {
		const owner = resolveOwnerFor(elementWith(["dataview-container"]), leafOf("dataview"), "leaf", INDEX);
		assert.equal(owner.confidence, "high");
		assert.ok(owner.candidates.length >= 1, "a wrong target caught before the user types costs nothing");
		assert.equal(owner.candidates[0].pluginId, "dataview");
		assert.ok(owner.candidates[0].why.length > 0, "every candidate must carry its own evidence");
	});

	test("a plugin whose slug is shorter than three characters is never scored", () => {
		const tiny = [{ id: "ab", name: "Ab", version: "1.0.0", slug: "ab" }];
		const owner = resolveOwnerFor(elementWith(["ab-thing"]), leafOf("ab"), "leaf", tiny);
		assert.deepEqual(owner.candidates, [], "a two-letter slug matches half the vault");
		assert.equal(owner.kind, "unknown");
	});
});
