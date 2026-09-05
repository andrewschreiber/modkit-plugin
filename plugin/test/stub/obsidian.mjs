/**
 * A stand-in for the `obsidian` module.
 *
 * The npm `obsidian` package ships types only — there is no runtime to import — so anything that
 * exercises the plugin has to supply one. This file is written to be **faithful where a wrong model
 * would make a test lie**, and to say plainly where it is not.
 *
 * ## Faithful, on purpose
 *
 * - **`Component`'s reclaim contract.** `load()` sets `_loaded` and loads children; `unload()`
 *   unloads children first, then calls `onunload()`, then runs every registered callback in
 *   reverse order and drops them. `addChild` on an already-loaded component loads the child
 *   immediately, as Obsidian's does. This is the exact contract modkit says its generated code must
 *   honour, so a stub that got it wrong would let a leak through the one test that exists to catch
 *   leaks.
 * - **`Plugin`'s registrations are reclaimed by `unload()`, not by `onunload()`.** In Obsidian,
 *   `addCommand`, `addSettingTab`, `addStatusBarItem` and `addRibbonIcon` each register their own
 *   undo through `Component.register`. A plugin author's `onunload()` therefore does *not* have to
 *   remove commands — and a stub that made `onunload()` responsible would credit modkit for
 *   cleanup Obsidian actually does, or blame it for cleanup it never owed. Modelled as Obsidian
 *   does it.
 * - **`registerInterval` clears through `window.clearInterval`**, so it cancels the numeric ids the
 *   DOM stub hands out.
 *
 * ## Crude, and where that matters
 *
 * - **`Modal`, `Setting`, `FuzzySuggestModal`, `PluginSettingTab` and `ButtonComponent` are shells.**
 *   They exist because the bundle evaluates `class X extends Modal` at load time and because
 *   `onload` constructs a settings tab. They render into the crude DOM of `./dom.mjs`; none of
 *   modkit's own rendering is asserted anywhere, and it should not be, from this.
 * - **`Notice` does not display or expire.** Every construction is appended to `Notice.log`, which
 *   is what tests read. `hide()`/`setMessage()` record and do nothing else.
 * - **`requestUrl` throws by default.** A test that reaches the network is a test that has escaped
 *   its harness, so the default is a loud failure rather than a canned response; install
 *   `setRequestUrlHandler` to answer deliberately.
 * - **`Platform` is a plain mutable object.** Real Obsidian derives it from the host once.
 */

import { StubElement } from "./dom.mjs";

/* ────────────────────────────────────────────────────────────────────────────
 * Notice
 * ──────────────────────────────────────────────────────────────────────────── */

export class Notice {
	/** Every Notice ever constructed, in order. Tests read and reset this. */
	static log = [];

	static reset() {
		Notice.log = [];
	}

	/** The message text of each notice, for readable assertions. */
	static messages() {
		return Notice.log.map((n) => n.message);
	}

	constructor(message, timeout) {
		this.message = typeof message === "string" ? message : String(message);
		this.timeout = timeout;
		this.hidden = false;
		this.noticeEl = new StubElement("div", null);
		Notice.log.push(this);
	}

	setMessage(message) {
		this.message = typeof message === "string" ? message : String(message);
		return this;
	}

	hide() {
		this.hidden = true;
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Component — the reclaim contract
 * ──────────────────────────────────────────────────────────────────────────── */

export class Component {
	constructor() {
		this._loaded = false;
		this._children = [];
		this._registered = [];
	}

	/**
	 * Returns whatever `onload()` returned. Obsidian's own `load()` returns void, but its plugin
	 * loader awaits an async `onload` before treating the plugin as loaded — and a test that could
	 * not await it would assert against a half-loaded plugin. `_loaded` is set first, so a child
	 * added from inside an async `onload` is loaded on `addChild`, exactly as in Obsidian.
	 */
	load() {
		if (this._loaded) return undefined;
		this._loaded = true;
		const result = this.onload();
		for (const child of [...this._children]) child.load();
		return result;
	}

	onload() {}

	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		// Children first: a parent's teardown may depend on a child having already released.
		for (const child of [...this._children]) child.unload();
		this._children = [];
		this.onunload();
		// Reverse order, so a later registration that depends on an earlier one comes off first.
		while (this._registered.length > 0) {
			const cb = this._registered.pop();
			try {
				cb();
			} catch (err) {
				// Obsidian does not let one bad teardown abort the rest, and neither does this.
				console.error("stub obsidian: a registered teardown threw", err);
			}
		}
	}

	onunload() {}

	addChild(component) {
		this._children.push(component);
		if (this._loaded) component.load();
		return component;
	}

	removeChild(component) {
		const at = this._children.indexOf(component);
		if (at >= 0) this._children.splice(at, 1);
		component.unload();
		return component;
	}

	register(cb) {
		this._registered.push(cb);
	}

	registerEvent(eventRef) {
		this.register(() => {
			eventRef?.offref?.();
		});
	}

	registerDomEvent(el, type, callback, options) {
		el.addEventListener(type, callback, options);
		this.register(() => el.removeEventListener(type, callback, options));
	}

	registerInterval(id) {
		this.register(() => {
			(globalThis.window ?? globalThis).clearInterval(id);
		});
		return id;
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Events
 * ──────────────────────────────────────────────────────────────────────────── */

export class Events {
	constructor() {
		this._handlers = new Map();
	}

	on(name, callback, ctx) {
		const list = this._handlers.get(name) ?? [];
		const ref = { name, callback, ctx, offref: () => this.offref(ref) };
		list.push(ref);
		this._handlers.set(name, list);
		return ref;
	}

	off(name, callback) {
		const list = this._handlers.get(name) ?? [];
		this._handlers.set(
			name,
			list.filter((r) => r.callback !== callback),
		);
	}

	offref(ref) {
		this.off(ref.name, ref.callback);
	}

	trigger(name, ...args) {
		for (const ref of [...(this._handlers.get(name) ?? [])]) ref.callback.apply(ref.ctx, args);
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Plugin
 * ──────────────────────────────────────────────────────────────────────────── */

export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
	}

	/**
	 * As in Obsidian: the command is added to `app.commands.commands` under `<pluginId>:<id>` and its
	 * removal is registered on this component, so `unload()` takes it away without the plugin author
	 * writing anything.
	 */
	addCommand(command) {
		const id = `${this.manifest.id}:${command.id}`;
		const registered = { ...command, id };
		this.app.commands.addCommand(registered);
		this.register(() => this.app.commands.removeCommand(id));
		return registered;
	}

	removeCommand(id) {
		this.app.commands.removeCommand(`${this.manifest.id}:${id}`);
	}

	addSettingTab(tab) {
		this.app.setting.addSettingTab(tab);
		this.register(() => this.app.setting.removeSettingTab(tab));
		return tab;
	}

	addStatusBarItem() {
		const el = this.app.statusBar.createDiv({ cls: "status-bar-item" });
		this.register(() => el.detach());
		return el;
	}

	addRibbonIcon(icon, title, callback) {
		const el = this.app.ribbon.createDiv({ cls: "side-dock-ribbon-action" });
		el.setAttribute("aria-label", title);
		el.addEventListener("click", callback);
		this.register(() => el.detach());
		return el;
	}

	registerObsidianProtocolHandler(action, handler) {
		this.app.protocolHandlers.set(action, handler);
		this.register(() => this.app.protocolHandlers.delete(action));
	}

	registerView(type, creator) {
		this.app.viewRegistry.viewByType[type] = creator;
		this.register(() => delete this.app.viewRegistry.viewByType[type]);
	}

	async loadData() {
		return this.app.pluginData.get(this.manifest.id) ?? null;
	}

	async saveData(data) {
		// Structured-cloned on the way in and out, as a real round trip through JSON on disk would
		// be — so a test cannot pass by holding the same object reference the plugin still mutates.
		this.app.pluginData.set(this.manifest.id, JSON.parse(JSON.stringify(data)));
	}

	onExternalSettingsChange() {}
}

/* ────────────────────────────────────────────────────────────────────────────
 * UI shells — see the header for how crude these are
 * ──────────────────────────────────────────────────────────────────────────── */

export class Modal {
	constructor(app) {
		this.app = app;
		this.containerEl = new StubElement("div", globalThis.document ?? null);
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
		this.scope = new Scope();
		this.isOpen = false;
	}

	open() {
		this.isOpen = true;
		this.onOpen();
	}

	close() {
		this.isOpen = false;
		this.onClose();
	}

	onOpen() {}

	onClose() {}

	setTitle(title) {
		this.titleEl.setText(title);
		return this;
	}
}

export class SuggestModal extends Modal {
	constructor(app) {
		super(app);
		this.inputEl = this.contentEl.createEl("input");
		this.resultContainerEl = this.contentEl.createDiv();
		this.limit = 50;
	}

	setPlaceholder(text) {
		this.inputEl.setAttribute("placeholder", text);
	}

	setInstructions() {}

	getSuggestions() {
		return [];
	}
}

export class FuzzySuggestModal extends SuggestModal {
	getItems() {
		return [];
	}

	getItemText() {
		return "";
	}

	onChooseItem() {}
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = new StubElement("div", globalThis.document ?? null);
	}

	display() {}

	hide() {}
}

/** A fluent no-op. Every method returns `this`; callback-taking methods hand back a shell control. */
export class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.settingEl = containerEl?.createDiv?.({ cls: "setting-item" }) ?? new StubElement("div", null);
		this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
		this.components = [];
	}

	setName(name) {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc) {
		this.descEl.setText(typeof desc === "string" ? desc : "");
		return this;
	}

	setHeading() {
		return this;
	}

	setClass() {
		return this;
	}

	setDisabled() {
		return this;
	}

	setTooltip() {
		return this;
	}

	then(cb) {
		cb(this);
		return this;
	}

	#control(component) {
		this.components.push(component);
		return this;
	}

	addText(cb) {
		return this.#control(runControl(cb, new TextComponent(this.controlEl)));
	}

	addTextArea(cb) {
		return this.#control(runControl(cb, new TextComponent(this.controlEl)));
	}

	addToggle(cb) {
		return this.#control(runControl(cb, new ToggleComponent(this.controlEl)));
	}

	addButton(cb) {
		return this.#control(runControl(cb, new ButtonComponent(this.controlEl)));
	}

	addExtraButton(cb) {
		return this.#control(runControl(cb, new ButtonComponent(this.controlEl)));
	}

	addDropdown(cb) {
		return this.#control(runControl(cb, new DropdownComponent(this.controlEl)));
	}
}

function runControl(cb, component) {
	cb?.(component);
	return component;
}

class BaseComponent {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.disabled = false;
	}

	setDisabled(disabled) {
		this.disabled = disabled;
		return this;
	}

	then(cb) {
		cb(this);
		return this;
	}
}

export class TextComponent extends BaseComponent {
	constructor(containerEl) {
		super(containerEl);
		this.inputEl = containerEl?.createEl?.("input") ?? new StubElement("input", null);
		this.value = "";
	}

	setValue(value) {
		this.value = value;
		return this;
	}

	getValue() {
		return this.value;
	}

	setPlaceholder(text) {
		this.inputEl.setAttribute("placeholder", text);
		return this;
	}

	onChange(cb) {
		this.changeHandler = cb;
		return this;
	}
}

export class ToggleComponent extends BaseComponent {
	constructor(containerEl) {
		super(containerEl);
		this.toggleEl = containerEl?.createDiv?.({ cls: "checkbox-container" }) ?? new StubElement("div", null);
		this.value = false;
	}

	setValue(value) {
		this.value = value;
		return this;
	}

	getValue() {
		return this.value;
	}

	onChange(cb) {
		this.changeHandler = cb;
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	constructor(containerEl) {
		super(containerEl);
		this.buttonEl = containerEl?.createEl?.("button") ?? new StubElement("button", null);
	}

	setButtonText(text) {
		this.buttonEl.setText(text);
		return this;
	}

	setIcon(icon) {
		this.icon = icon;
		return this;
	}

	setCta() {
		return this;
	}

	setWarning() {
		return this;
	}

	setTooltip(text) {
		this.buttonEl.setAttribute("aria-label", text);
		return this;
	}

	onClick(cb) {
		this.clickHandler = cb;
		this.buttonEl.addEventListener("click", cb);
		return this;
	}
}

export class DropdownComponent extends BaseComponent {
	constructor(containerEl) {
		super(containerEl);
		this.selectEl = containerEl?.createEl?.("select") ?? new StubElement("select", null);
		this.options = new Map();
		this.value = "";
	}

	addOption(value, display) {
		this.options.set(value, display);
		return this;
	}

	setValue(value) {
		this.value = value;
		return this;
	}

	getValue() {
		return this.value;
	}

	onChange(cb) {
		this.changeHandler = cb;
		return this;
	}
}

export class Scope {
	constructor(parent) {
		this.parent = parent;
		this.keys = [];
	}

	register(modifiers, key, func) {
		const handler = { modifiers, key, func };
		this.keys.push(handler);
		return handler;
	}

	unregister(handler) {
		const at = this.keys.indexOf(handler);
		if (at >= 0) this.keys.splice(at, 1);
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Free functions and constants
 * ──────────────────────────────────────────────────────────────────────────── */

/** Obsidian's own: collapse repeated separators, strip leading/trailing slashes, NFC-normalise. */
export function normalizePath(path) {
	const collapsed = String(path)
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.normalize("NFC");
	return collapsed === "" ? "/" : collapsed;
}

/** Mutable so a test can model a mobile host. Real Obsidian computes this once at startup. */
export const Platform = {
	isDesktop: true,
	isDesktopApp: true,
	isMobile: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isSafari: false,
};

export let apiVersion = "1.9.0";

/** Test-only: model a different Obsidian version. */
export function setApiVersion(version) {
	apiVersion = version;
}

export function requireApiVersion(version) {
	return compareApiVersions(apiVersion, version) >= 0;
}

function compareApiVersions(a, b) {
	const pa = String(a).split(".").map(Number);
	const pb = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

let requestUrlHandler = null;

/** Install a deliberate answer for `requestUrl`. Pass `null` to restore the throwing default. */
export function setRequestUrlHandler(handler) {
	requestUrlHandler = handler;
}

export async function requestUrl(param) {
	if (requestUrlHandler === null) {
		const url = typeof param === "string" ? param : param?.url;
		throw new Error(
			`stub obsidian: requestUrl("${url}") was called, but no handler is installed — a test must not reach the network`,
		);
	}
	return requestUrlHandler(param);
}

export function debounce(fn, timeout = 0) {
	let id = null;
	const debounced = (...args) => {
		if (id !== null) (globalThis.window ?? globalThis).clearTimeout(id);
		id = (globalThis.window ?? globalThis).setTimeout(() => fn(...args), timeout);
	};
	debounced.cancel = () => {
		if (id !== null) (globalThis.window ?? globalThis).clearTimeout(id);
	};
	return debounced;
}

export function setIcon(el, icon) {
	el?.setAttribute?.("data-icon", icon);
}

export function sanitizeHTMLToDom(html) {
	const el = new StubElement("div", null);
	el.setText(String(html));
	return el;
}

export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class Vault extends Events {}
export class MarkdownView {}
export class ItemView {}
export class View {}
export class WorkspaceLeaf {}
export class MetadataCache extends Events {}
export class AbstractInputSuggest {}
/**
 * Real enough to test against: `addItem` really builds a `MenuItem`, `onClick` really records the
 * callback so a test can invoke it as a click would, and `showAtMouseEvent`/`showAtPosition` record
 * that the menu was shown rather than throwing (the real API's whole point — a menu nobody could
 * ask "was this shown?" would make `contextmenu.ts`'s happy path untestable).
 */
export class MenuItem {
	setTitle(title) {
		this.title = title;
		return this;
	}

	setIcon(icon) {
		this.icon = icon;
		return this;
	}

	setChecked(checked) {
		this.checked = checked;
		return this;
	}

	setDisabled(disabled) {
		this.disabled = disabled;
		return this;
	}

	setWarning(isWarning) {
		this.isWarning = isWarning;
		return this;
	}

	setIsLabel(isLabel) {
		this.isLabel = isLabel;
		return this;
	}

	setSection(section) {
		this.section = section;
		return this;
	}

	onClick(callback) {
		this.clickCallback = callback;
		return this;
	}

	/** Test-only: fire the click a real menu would on a pointer event. */
	trigger(evt = {}) {
		this.clickCallback?.(evt);
	}
}

export class Menu {
	/** Every Menu ever constructed, in order. Tests read and reset this — same convention as `Notice`. */
	static log = [];

	static reset() {
		Menu.log = [];
	}

	constructor() {
		this.items = [];
		this.shown = false;
		this.hidden = false;
		Menu.log.push(this);
	}

	addItem(cb) {
		const item = new MenuItem();
		this.items.push(item);
		cb(item);
		return this;
	}

	addSeparator() {
		return this;
	}

	setNoIcon() {
		return this;
	}

	setUseNativeMenu() {
		return this;
	}

	setParentElement() {
		return this;
	}

	showAtMouseEvent(evt) {
		this.shown = true;
		this.shownAt = { x: evt?.clientX, y: evt?.clientY };
		return this;
	}

	showAtPosition(position) {
		this.shown = true;
		this.shownAt = position;
		return this;
	}

	hide() {
		this.hidden = true;
		return this;
	}

	close() {
		this.hidden = true;
	}

	onHide(callback) {
		this.hideCallback = callback;
	}
}
