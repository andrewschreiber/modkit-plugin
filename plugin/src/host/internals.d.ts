/**
 * The complete inventory of the undocumented Obsidian internals modkit touches.
 *
 * One file, on purpose. An `as any` cast is invisible to the compiler forever; a declared shape
 * means the day Obsidian moves something there is exactly one file to correct and one grep to
 * audit. This file *is* modkit's machine-readable list of its own undocumented surface, which is
 * what `host.ts`'s startup probe and the M4 breakage story are written against.
 *
 * EVERY member here is optional. That is a deliberate departure from `pjeby/hot-reload`, which
 * declares `plugins:` as required: optionality is what makes TypeScript *force* the `?.` at each
 * call site, so the compiler writes the defensive access instead of us remembering to. modkit
 * writes files into someone's vault and enables them — a silent `undefined` here is a
 * half-installed plugin, not a missing feature.
 *
 * Provenance: every shape below is read out of a community plugin's own `declare module` block —
 * pjeby/hot-reload (`hot-reload.ts:214-240`), pjeby/obsidian-hover-editor
 * (`src/types/obsidian.d.ts:44-89`), phibr0/obsidian-commander (`src/types.ts:75-92`). Nothing was
 * taken from Obsidian's own bundle, `obsidian-typings`, or `obsidian-undocumented`.
 */

import type { Command, EventRef, Plugin, PluginManifest, View, WorkspaceLeaf } from "obsidian";

/**
 * `app.plugins` — the community-plugin manager. The single load-bearing internal: `enablePlugin`,
 * `disablePlugin`, `enabledPlugins` and `loadManifests` have *zero* occurrences in `obsidian.d.ts`.
 *
 * `plugins` holds only *enabled* plugins, so a disabled target reads `undefined` and must produce a
 * refusal rather than a throw.
 */
export interface PluginManagerInternal {
	/** id -> the live `Plugin` subclass instance. `instance.constructor.prototype` is the patch handle. */
	plugins?: Record<string, Plugin | undefined>;
	/** id -> manifest for every *installed* plugin, enabled or not. `PluginManifest.dir` is public. */
	manifests?: Record<string, PluginManifest | undefined>;
	enabledPlugins?: Set<string>;
	enablePlugin?(id: string): Promise<void>;
	disablePlugin?(id: string): Promise<void>;
	/** e.g. `.obsidian/plugins`. Prefer the public `vault.configDir`; this is the cross-check. */
	getPluginFolder?(): string;
	getPlugin?(id: string): Plugin | undefined;
}

/**
 * `app.viewRegistry` — used by the element picker to turn a view type into something nameable.
 * Note `viewByType` yields a creator closure, not a plugin id: view-type -> owning-plugin is NOT
 * a direct mapping, and the honest fallback is to ask the user.
 */
export interface ViewRegistryInternal {
	typeByExtension?: Record<string, string | undefined>;
	viewByType?: Record<string, ((leaf: WorkspaceLeaf) => View) | undefined>;
}

/**
 * `app.commands` — reach plane D. Load-bearing rather than a convenience: many plugin behaviours
 * are module-local free functions installed as command callbacks and have no prototype handle at
 * all (Tasks' `toggle-done` is exactly this), so the command registry is the only handle that
 * exists for them.
 */
export interface CommandRegistryInternal {
	commands?: Record<string, Command | undefined>;
	/** Return value is UNVERIFIED — Commander declares `void`, the real one is believed to be a
	 *  boolean. Never branch on it. */
	executeCommandById?(id: string): unknown;
	removeCommand?(id: string): void;
}

/**
 * `app.setting` — the settings window. modkit's mod list lives in its own settings tab, so the
 * "Show mods" command has to be able to open that tab; there is no public route to it. Both members
 * are optional and every call site is `?.`-guarded, with a Notice telling the user where to click
 * when they are absent. Shape from phibr0/obsidian-commander (`src/types.ts`).
 */
export interface SettingWindowInternal {
	open?(): void;
	openTabById?(id: string): void;
}

declare module "obsidian" {
	interface App {
		plugins?: PluginManagerInternal;
		viewRegistry?: ViewRegistryInternal;
		commands?: CommandRegistryInternal;
		setting?: SettingWindowInternal;
	}

	interface Component {
		/** Hover Editor guards deferred/lazy plugins with `?._loaded`; absent means "assume loaded". */
		_loaded?: boolean;
	}

	interface Vault {
		/** NOT public — `Vault` has no `exists`. `vault.adapter.exists()` is the public route and
		 *  should be preferred; this exists so a call site that has only a `Vault` still compiles
		 *  under `?.`. */
		exists?(normalizedPath: string): Promise<boolean>;
		/**
		 * The `"raw"` event is not among the public Vault events (create/modify/delete/rename).
		 * Declared non-optional because it is an *overload* of a public method, where optionality
		 * would be meaningless: the risk here is that the event never fires on some build, and no
		 * type can express that. Treat a `"raw"` subscription as best-effort.
		 */
		on(type: "raw", handler: (filename: string) => void): EventRef;
	}

	interface WorkspaceLeaf {
		/** NOT public (Hover Editor augments it). Prefer the public `View.containerEl` for
		 *  DOM -> leaf resolution; this is here so the fallback path is typed. */
		containerEl?: HTMLElement;
	}
}
