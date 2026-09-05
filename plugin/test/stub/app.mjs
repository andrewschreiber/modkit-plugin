/**
 * The host side of the stub: a vault adapter, a plugin manager, a command registry.
 *
 * This is the part that has to be honest, because it is the part the installer's correctness
 * depends on. Each behaviour below is modelled on something specific:
 *
 * - **`mkdir` throws on an existing directory.** `ModInstaller.ensureDir` is written around exactly
 *   that (`"mkdir on an existing directory throws"`), and an adapter that silently succeeded would
 *   never exercise the branch.
 * - **`read` throws for a missing path**, so "wrote it and could not read it back" is a state a test
 *   can actually produce rather than one it has to fake.
 * - **`list` returns vault-relative paths with folders as full paths**, matching Obsidian's
 *   `ListedFiles`, because `listModDirectories` takes the last path segment of each folder.
 * - **A plugin folder is indexed by a watcher, not by the write.** `app.plugins.manifests[id]`
 *   appears one macrotask after `manifest.json` lands, which is what makes the installer's
 *   settle-then-poll loop a real thing instead of a formality. `reindexDelayMs: Infinity` models a
 *   watcher that never notices.
 * - **`enablePlugin` refuses a plugin with no `main.js` on disk**, so a passing enable is causally
 *   downstream of a successful write rather than a bookkeeping flip.
 * - **`enablePluginAndSave` persists the enable even when the manifest is not indexed** — it writes
 *   the list and only *then* tries to load. This one is not a guess: on 2026-08-31 a real generated
 *   mod landed in the real `community-plugins.json` while never appearing in `app.plugins.plugins`,
 *   and only came up on the next restart. The stub modelled a stricter host than Obsidian, so the
 *   installer's worst real failure was unreachable from the harness.
 * - **`loadManifests()` exists only with `withLoadManifests: true`**, and it indexes whatever is on
 *   disk. Two hosts to test against: one where the rescan rescues a folder the watcher missed, and
 *   one with no rescan at all, which is the pending-restart path.
 *
 * Where it is crude: **a "loaded plugin" is a placeholder object, not evaluated code.** The stub
 * never runs a generated `main.js`. `app.plugins.plugins[id]` gets `{ _loaded: true, manifest }`,
 * which is precisely the shape `Host.getPluginInstance` reads and nothing more. Anything that
 * depends on a mod's code actually running is out of this harness's reach and must not be asserted
 * from it.
 *
 * **Second crudeness, and it is specifically dangerous — `freshClassPerLoad`.** By default every
 * loaded plugin is an object *literal*, so `instance.constructor` is `Object` for every plugin in
 * the vault and stays `Object` across a disable/enable cycle. `Host.getPluginConstructor` therefore
 * reports the same identity forever, which quietly models a host where the thing
 * `src/host/supervisor.ts` exists to detect **cannot happen**. Pass `freshClassPerLoad: true` to
 * `createApp` and each load instead produces an instance of a newly-minted class, the way
 * re-evaluating a `main.js` does in Obsidian. It is opt-in only because the default shape is what
 * the existing installer/lifecycle/host tests were written against; anything asserting about class
 * identity must set it, and `supervisor.test.mjs` says plainly which of its claims rest on this
 * simulation rather than on a measurement of the real host.
 */

import { StubElement } from "./dom.mjs";
import { Events } from "./obsidian.mjs";

/* ────────────────────────────────────────────────────────────────────────────
 * Vault adapter
 * ──────────────────────────────────────────────────────────────────────────── */

class NotFoundError extends Error {
	constructor(path) {
		super(`ENOENT: no such file or directory, '${path}'`);
		this.name = "NotFoundError";
		this.code = "ENOENT";
	}
}

export class MemoryAdapter {
	/**
	 * `journal` is the app-wide ordered log shared with the plugin manager. Sequencing assertions
	 * ("the disable precedes the delete") must read one interleaved list — comparing indices across
	 * two separate arrays compares nothing.
	 */
	constructor(journal = []) {
		this.files = new Map();
		this.folders = new Set([""]);
		/** Test hooks. Each is `(path, contents) => void`, and may throw to inject a fault. */
		this.beforeWrite = null;
		this.afterWrite = null;
		/** Paths whose `read` should report contents other than what was written. */
		this.corrupt = new Map();
		/** Every mutating call on this adapter, in order. */
		this.calls = [];
		this.journal = journal;
	}

	#record(op, path, extra) {
		const entry = { source: "adapter", op, path, ...extra };
		this.calls.push(entry);
		this.journal.push(entry);
	}

	#parent(path) {
		const at = path.lastIndexOf("/");
		return at < 0 ? "" : path.slice(0, at);
	}

	async exists(path) {
		return this.files.has(path) || this.folders.has(path);
	}

	async stat(path) {
		if (this.files.has(path)) return { type: "file", size: this.files.get(path).length };
		if (this.folders.has(path)) return { type: "folder", size: 0 };
		return null;
	}

	async read(path) {
		if (this.corrupt.has(path)) return this.corrupt.get(path);
		if (!this.files.has(path)) throw new NotFoundError(path);
		return this.files.get(path);
	}

	async write(path, contents) {
		this.beforeWrite?.(path, contents);
		if (!this.folders.has(this.#parent(path))) {
			throw new NotFoundError(this.#parent(path));
		}
		this.files.set(path, String(contents));
		this.#record("write", path, { bytes: String(contents).length });
		this.afterWrite?.(path, contents);
	}

	async mkdir(path) {
		// Obsidian's adapter throws here, and the installer is written around that.
		if (this.folders.has(path)) throw new Error(`EEXIST: folder already exists, '${path}'`);
		if (this.files.has(path)) throw new Error(`EEXIST: a file exists at '${path}'`);
		const parent = this.#parent(path);
		if (!this.folders.has(parent)) throw new NotFoundError(parent);
		this.folders.add(path);
		this.#record("mkdir", path, {});
	}

	async remove(path) {
		if (!this.files.has(path)) throw new NotFoundError(path);
		this.files.delete(path);
		this.#record("remove", path, {});
	}

	async rmdir(path, recursive) {
		if (!this.folders.has(path)) throw new NotFoundError(path);
		const prefix = `${path}/`;
		const contents = [...this.files.keys(), ...this.folders].filter((p) => p.startsWith(prefix));
		if (contents.length > 0 && recursive !== true) {
			throw new Error(`ENOTEMPTY: folder not empty, '${path}'`);
		}
		for (const p of contents) {
			this.files.delete(p);
			this.folders.delete(p);
		}
		this.folders.delete(path);
		this.#record("rmdir", path, { recursive: recursive === true });
	}

	/** Obsidian's `ListedFiles`: both arrays hold full vault-relative paths. */
	async list(path) {
		if (!this.folders.has(path)) throw new NotFoundError(path);
		const prefix = path === "" ? "" : `${path}/`;
		const direct = (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/") && p !== path;
		return {
			files: [...this.files.keys()].filter(direct).sort(),
			folders: [...this.folders].filter(direct).sort(),
		};
	}

	/** Test helper: create a folder and every parent, the way a user's vault already would have. */
	mkdirp(path) {
		const parts = path.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current === "" ? part : `${current}/${part}`;
			this.folders.add(current);
		}
	}

	/** Test helper: everything under a prefix, for "uninstall left nothing" assertions. */
	entriesUnder(prefix) {
		const under = (p) => p === prefix || p.startsWith(`${prefix}/`);
		return [...[...this.files.keys()].filter(under), ...[...this.folders].filter(under)].sort();
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Plugin manager
 * ──────────────────────────────────────────────────────────────────────────── */

export class StubPluginManager {
	constructor(app, options = {}) {
		this.app = app;
		this.plugins = {};
		this.manifests = {};
		this.enabledPlugins = new Set();
		/** How long the config-directory watcher takes to notice a new manifest. */
		this.reindexDelayMs = options.reindexDelayMs ?? 1;
		/** Ids whose `enablePlugin` should reject, for the enable-failed path. */
		this.refuseEnable = new Set();
		/** See the file header: model `main.js` re-evaluation minting a fresh class object. */
		this.freshClassPerLoad = options.freshClassPerLoad === true;
		/** How many plugin instances this manager has minted. A witness that a reload really happened. */
		this.loadCount = 0;
		this.calls = [];
		this.journal = options.journal ?? [];
		if (options.withLoadManifests === true) {
			this.loadManifests = async () => {
				this.#record("loadManifests", "*");
				const root = `${this.app.vault.configDir}/plugins`;
				const listing = await this.app.vault.adapter.list(root);
				for (const folder of listing.folders) {
					const id = folder.split("/").filter(Boolean).pop();
					const path = `${root}/${id}/manifest.json`;
					if (!(await this.app.vault.adapter.exists(path))) continue;
					try {
						this.manifests[id] = { ...JSON.parse(await this.app.vault.adapter.read(path)), dir: `${root}/${id}` };
					} catch {
						// A half-written manifest is not indexed — same as the real scan.
					}
				}
			};
		}
		if (options.withAndSave === true) {
			this.enablePluginAndSave = async (id) => {
				// Persist first, load second: the id is in the saved list whether or not the loader can
				// find a manifest for it. See the file header — this is the shape that produced a real
				// "installed, enabled, and inert until restart" mod.
				this.enabledPlugins.add(id);
				this.savedEnabled = [...this.enabledPlugins];
				if (this.manifests[id] === undefined) return;
				await this.enablePlugin(id);
				this.savedEnabled = [...this.enabledPlugins];
			};
			this.disablePluginAndSave = async (id) => {
				await this.disablePlugin(id);
				this.savedEnabled = [...this.enabledPlugins];
			};
		}
	}

	/**
	 * Model the config-directory watcher. Called by the app whenever a `manifest.json` under
	 * `<configDir>/plugins/<id>/` is written.
	 */
	noticeManifest(id, manifest) {
		if (this.reindexDelayMs === Infinity) return;
		const dir = `${this.app.vault.configDir}/plugins/${id}`;
		setTimeout(() => {
			this.manifests[id] = { ...manifest, dir };
		}, this.reindexDelayMs).unref?.();
	}

	/**
	 * Build the object that stands in for a running plugin.
	 *
	 * With `freshClassPerLoad`, each call mints a **new class object** and returns an instance of it,
	 * which is what Obsidian produces when it re-evaluates a plugin's `main.js`: the old prototype is
	 * orphaned and everything patched onto it is inert. `_loaded` and `manifest` are own, writable
	 * properties either way, so the object reads identically to the literal for every accessor in
	 * `Host`.
	 */
	instantiate(manifest) {
		this.loadCount += 1;
		if (!this.freshClassPerLoad) return { _loaded: true, manifest };
		const StubLoadedPlugin = class StubLoadedPlugin {
			constructor(m) {
				this._loaded = true;
				this.manifest = m;
			}
		};
		// A method on the prototype, so a test can patch it the way a mod would and then watch the
		// patch be orphaned by the next load.
		StubLoadedPlugin.prototype.generation = () => this.loadCount;
		return new StubLoadedPlugin(manifest);
	}

	/** Test helper: an already-installed third-party plugin, indexed and optionally running. */
	install(manifest, { enabled = false, loaded = false } = {}) {
		this.manifests[manifest.id] = { ...manifest, dir: `${this.app.vault.configDir}/plugins/${manifest.id}` };
		if (enabled) this.enabledPlugins.add(manifest.id);
		if (loaded) this.plugins[manifest.id] = this.instantiate(this.manifests[manifest.id]);
	}

	#record(op, id) {
		const entry = { source: "plugins", op, id };
		this.calls.push(entry);
		this.journal.push(entry);
	}

	async enablePlugin(id) {
		this.#record("enablePlugin", id);
		if (this.refuseEnable.has(id)) throw new Error(`stub: refusing to enable "${id}"`);
		const manifest = this.manifests[id];
		if (manifest === undefined) throw new Error(`stub: no manifest indexed for "${id}"`);
		// A plugin with no code on disk is not enableable — so a green enable is downstream of a
		// real write rather than of bookkeeping.
		const main = `${this.app.vault.configDir}/plugins/${id}/main.js`;
		if (!(await this.app.vault.adapter.exists(main))) {
			throw new Error(`stub: "${id}" has no main.js at ${main}`);
		}
		this.enabledPlugins.add(id);
		this.plugins[id] = this.instantiate(manifest);
	}

	async disablePlugin(id) {
		this.#record("disablePlugin", id);
		this.enabledPlugins.delete(id);
		delete this.plugins[id];
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * App
 * ──────────────────────────────────────────────────────────────────────────── */

class StubCommands {
	constructor() {
		this.commands = {};
	}

	addCommand(command) {
		this.commands[command.id] = command;
	}

	removeCommand(id) {
		delete this.commands[id];
	}

	listCommands() {
		return Object.values(this.commands);
	}
}

class StubSetting {
	constructor() {
		this.settingTabs = [];
		this.opened = [];
	}

	addSettingTab(tab) {
		this.settingTabs.push(tab);
	}

	removeSettingTab(tab) {
		const at = this.settingTabs.indexOf(tab);
		if (at >= 0) this.settingTabs.splice(at, 1);
	}

	open() {
		this.opened.push("open");
	}

	openTabById(id) {
		this.opened.push(id);
	}
}

class StubWorkspace extends Events {
	constructor() {
		super();
		this.layoutReady = false;
		this._layoutCallbacks = [];
		this.containerEl = new StubElement("div", null);
	}

	onLayoutReady(cb) {
		if (this.layoutReady) cb();
		else this._layoutCallbacks.push(cb);
	}

	/** Test-only: fire the layout-ready callbacks, as Obsidian does once at startup. */
	fireLayoutReady() {
		this.layoutReady = true;
		const callbacks = this._layoutCallbacks;
		this._layoutCallbacks = [];
		for (const cb of callbacks) cb();
	}

	getActiveViewOfType() {
		return null;
	}

	getLeavesOfType() {
		return [];
	}

	get activeLeaf() {
		return null;
	}
}

/**
 * Build an `App`.
 *
 * `plugins: false` models the degraded host the lifecycle test needs — `app.plugins` genuinely
 * absent, which is what `probeHost` reports as fatal.
 */
export function createApp(options = {}) {
	/** One interleaved log of adapter and plugin-manager calls, for ordering assertions. */
	const journal = [];
	const adapter = new MemoryAdapter(journal);
	const configDir = options.configDir ?? ".obsidian";
	adapter.mkdirp(configDir);
	if (options.createPluginsDir !== false) adapter.mkdirp(`${configDir}/plugins`);

	const app = {
		vault: {
			configDir,
			adapter,
			getName: () => "stub-vault",
		},
		commands: new StubCommands(),
		setting: new StubSetting(),
		workspace: new StubWorkspace(),
		viewRegistry: { viewByType: {}, typeByExtension: {} },
		metadataCache: new Events(),
		keymap: { pushScope: () => {}, popScope: () => {} },
		statusBar: new StubElement("div", null),
		ribbon: new StubElement("div", null),
		protocolHandlers: new Map(),
		/** Backing store for `Plugin.loadData`/`saveData`, keyed by plugin id. */
		pluginData: new Map(),
		journal,
	};

	if (options.plugins !== false) {
		app.plugins = new StubPluginManager(app, { ...options, journal });
		// Wire the watcher: writing a plugin manifest is what makes Obsidian notice a folder.
		const manifestRe = new RegExp(`^${configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/plugins/([^/]+)/manifest\\.json$`);
		adapter.afterWrite = (path, contents) => {
			const match = manifestRe.exec(path);
			if (match === null) return;
			try {
				app.plugins.noticeManifest(match[1], JSON.parse(contents));
			} catch {
				/* a manifest that is not JSON is one Obsidian would also fail to index */
			}
		};
	}

	return app;
}

/** A minimal manifest, for both modkit itself and generated mods. */
export function manifestFor(id, overrides = {}) {
	return {
		id,
		name: id,
		version: "0.1.0",
		minAppVersion: "1.7.2",
		description: `stub manifest for ${id}`,
		author: "modkit tests",
		isDesktopOnly: false,
		...overrides,
	};
}

/** Let pending macrotasks (the watcher, a settle delay) run. */
export function tick(ms = 5) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
