/**
 * The host layer: one startup shape probe over the undocumented internals, then typed guarded
 * accessors on top of it.
 *
 * The probe is the whole defence against an Obsidian update moving something under us. It runs
 * once, names exactly what is missing, and drops modkit into a degraded mode — because the failure
 * we cannot tolerate is a plugin that half-works silently while writing files into a vault.
 */

import { Notice } from "obsidian";
import type { App, Command, Plugin, PluginManifest } from "obsidian";
import type { PluginManagerInternal } from "./internals";

/** How much of modkit a defect costs. `fatal` disables mods entirely; `degraded` costs one plane. */
export type HostDefectSeverity = "fatal" | "degraded";

export interface HostDefect {
	/** Dotted path of the thing that is wrong, e.g. `app.plugins.enablePlugin`. */
	path: string;
	expected: string;
	actual: string;
	severity: HostDefectSeverity;
	/** What modkit loses because of it — shown to the user, so write it in their terms. */
	consequence: string;
}

export interface HostProbe {
	/** No fatal defects: modkit may install and enable mods. */
	ok: boolean;
	/** At least one degraded defect: modkit works, but some reach planes are unavailable. */
	degraded: boolean;
	defects: HostDefect[];
	checkedAt: number;
}

export interface InstalledPluginInfo {
	id: string;
	name: string;
	author: string;
	version: string;
	description: string;
	minAppVersion: string;
	/** Vault-relative plugin folder. Public API (`PluginManifest.dir`), but still optional. */
	dir?: string;
	isDesktopOnly: boolean;
	/** In `app.plugins.enabledPlugins` — i.e. the *setting*. */
	enabled: boolean;
	/** Has a live instance in `app.plugins.plugins` — i.e. actually running and patchable. */
	loaded: boolean;
}

const NOTICE_STICKY = 0;
const NOTICE_TRANSIENT_MS = 12_000;
const MAX_NOTICE_DEFECTS = 4;

/**
 * Cross-realm-safe `Set` check. Obsidian popout windows are separate realms, so a bare
 * `instanceof Set` can report false on a perfectly good Set that was built in another window.
 */
function isSetLike(value: unknown): value is Set<string> {
	if (value instanceof Set) return true;
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { has?: unknown; add?: unknown };
	return typeof candidate.has === "function" && typeof candidate.add === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Human-readable `typeof`, with the two distinctions `typeof` throws away. */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (isSetLike(value)) return "Set";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Shape-check the internals modkit depends on. Checks *functions and types*, never mere presence:
 * `typeof x === "function"` is the honest probe, and a truthiness test is the dishonest one.
 */
export function probeHost(app: App): HostProbe {
	const defects: HostDefect[] = [];
	const manager: unknown = app.plugins;

	const fatal = (path: string, expected: string, actual: unknown, consequence: string): void => {
		defects.push({ path, expected, actual: describeValue(actual), severity: "fatal", consequence });
	};
	const degraded = (path: string, expected: string, actual: unknown, consequence: string): void => {
		defects.push({ path, expected, actual: describeValue(actual), severity: "degraded", consequence });
	};

	if (!isPlainObject(manager)) {
		fatal("app.plugins", "object", manager, "modkit cannot see installed plugins, install a mod, or enable one");
	} else {
		const pm = manager as PluginManagerInternal;
		if (!isPlainObject(pm.plugins)) {
			fatal("app.plugins.plugins", "object", pm.plugins, "modkit cannot reach a target plugin's live instance, so no mod can be aimed");
		}
		if (!isPlainObject(pm.manifests)) {
			fatal("app.plugins.manifests", "object", pm.manifests, "modkit cannot list installed plugins or read a target's version");
		}
		if (!isSetLike(pm.enabledPlugins)) {
			fatal("app.plugins.enabledPlugins", "Set", pm.enabledPlugins, "modkit cannot tell whether a plugin is enabled, so a reload would be unsafe");
		}
		if (typeof pm.enablePlugin !== "function") {
			fatal("app.plugins.enablePlugin", "function", pm.enablePlugin, "modkit cannot enable a mod it has written — installs would need a manual restart");
		}
		if (typeof pm.disablePlugin !== "function") {
			fatal("app.plugins.disablePlugin", "function", pm.disablePlugin, "modkit cannot reload a mod, so a mod cannot be repaired without restarting Obsidian");
		}
	}

	const commands: unknown = app.commands;
	if (!isPlainObject(commands) || !isPlainObject((commands as { commands?: unknown }).commands)) {
		degraded("app.commands.commands", "object", isPlainObject(commands) ? (commands as { commands?: unknown }).commands : commands,
			"the command-registry reach plane is unavailable — mods that patch a plugin command cannot be installed");
	}

	const viewRegistry: unknown = app.viewRegistry;
	if (!isPlainObject(viewRegistry) || !isPlainObject((viewRegistry as { viewByType?: unknown }).viewByType)) {
		degraded("app.viewRegistry.viewByType", "object", isPlainObject(viewRegistry) ? (viewRegistry as { viewByType?: unknown }).viewByType : viewRegistry,
			"the element picker cannot name the view under the cursor — you will be asked to pick the target plugin yourself");
	}

	return {
		ok: !defects.some((d) => d.severity === "fatal"),
		degraded: defects.some((d) => d.severity === "degraded"),
		defects,
		checkedAt: Date.now(),
	};
}

function formatDefects(defects: HostDefect[]): string {
	const shown = defects.slice(0, MAX_NOTICE_DEFECTS)
		.map((d) => `• ${d.path} — expected ${d.expected}, found ${d.actual}\n  ${d.consequence}`)
		.join("\n");
	const rest = defects.length - Math.min(defects.length, MAX_NOTICE_DEFECTS);
	return rest > 0 ? `${shown}\n• …and ${rest} more (see the modkit settings tab)` : shown;
}

/**
 * Everything modkit does to the plugin manager, behind one guarded object.
 *
 * Nothing here throws on a missing internal: every accessor degrades to `null`/`false`/`[]` and the
 * probe is what tells the user why. A method that cannot do its job returns `false` rather than
 * pretending — a caller must be able to distinguish "reloaded" from "silently did nothing".
 */
export class Host {
	private probeResult: HostProbe | null = null;
	/** Ids currently inside `reloadPlugin`. The supervisor reads this so its own enable/disable
	 *  hooks do not treat a reload it started as a foreign event and recurse. */
	private readonly reloading = new Set<string>();

	constructor(private readonly app: App) {}

	/**
	 * Run the shape probe. Idempotent by design — call it once at `onload` with `notify: true`, and
	 * afterwards read `lastProbe`. Re-probing is allowed (the settings tab may offer it) but should
	 * not re-nag.
	 */
	probe(options: { notify?: boolean } = {}): HostProbe {
		const result = probeHost(this.app);
		this.probeResult = result;

		if (options.notify) {
			const fatalDefects = result.defects.filter((d) => d.severity === "fatal");
			if (fatalDefects.length > 0) {
				new Notice(
					`This build of Obsidian does not expose the internals modkit needs, so it cannot write or run patches here.\n${formatDefects(fatalDefects)}`,
					NOTICE_STICKY,
				);
			} else {
				const degradedDefects = result.defects.filter((d) => d.severity === "degraded");
				if (degradedDefects.length > 0) {
					new Notice(`modkit is running with some things unavailable.\n${formatDefects(degradedDefects)}`, NOTICE_TRANSIENT_MS);
				}
			}
		}
		return result;
	}

	get lastProbe(): HostProbe | null {
		return this.probeResult;
	}

	/** True when no *fatal* defect was found. Probes lazily (without notifying) if asked too early. */
	get available(): boolean {
		return (this.probeResult ?? this.probe()).ok;
	}

	get degraded(): boolean {
		return (this.probeResult ?? this.probe()).degraded;
	}

	/**
	 * The raw plugin manager, or `null` when the probe found a fatal defect. Exposed for the
	 * supervisor, which needs to `around()` `enablePlugin`/`disablePlugin` on this exact object.
	 * Prefer the accessors below everywhere else.
	 */
	pluginManager(): PluginManagerInternal | null {
		if (!this.available) return null;
		return this.app.plugins ?? null;
	}

	/** Every *installed* plugin, enabled or not — modkit's own entry excluded is the caller's job. */
	listInstalledPlugins(): InstalledPluginInfo[] {
		const pm = this.pluginManager();
		const manifests = pm?.manifests;
		if (!manifests) return [];

		const out: InstalledPluginInfo[] = [];
		for (const id of Object.keys(manifests)) {
			const manifest = manifests[id];
			if (!manifest) continue;
			const info: InstalledPluginInfo = {
				id: manifest.id ?? id,
				name: manifest.name ?? id,
				author: manifest.author ?? "",
				version: manifest.version ?? "",
				description: manifest.description ?? "",
				minAppVersion: manifest.minAppVersion ?? "",
				isDesktopOnly: manifest.isDesktopOnly === true,
				enabled: this.isPluginEnabled(id),
				loaded: this.isPluginLoaded(id),
			};
			if (manifest.dir !== undefined) info.dir = manifest.dir;
			out.push(info);
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * The live instance, or `null`. `null` means "not patchable right now" and covers both
	 * not-installed and installed-but-disabled — use `getPluginManifest` to tell them apart when
	 * writing the refusal message.
	 */
	getPluginInstance(id: string): Plugin | null {
		const instance = this.pluginManager()?.plugins?.[id];
		if (!instance) return null;
		// `_loaded === false` is a deferred/lazy plugin: the object exists, its onload has not run,
		// and anything it registers at load is not there yet. Absent means "assume loaded".
		if (instance._loaded === false) return null;
		return instance;
	}

	getPluginManifest(id: string): PluginManifest | null {
		return this.pluginManager()?.manifests?.[id] ?? null;
	}

	/** The plugin's class object — the identity the supervisor watches for replacement. */
	getPluginConstructor(id: string): object | null {
		const ctor: unknown = this.getPluginInstance(id)?.constructor;
		return typeof ctor === "function" ? (ctor as object) : null;
	}

	isPluginEnabled(id: string): boolean {
		return this.pluginManager()?.enabledPlugins?.has(id) === true;
	}

	isPluginLoaded(id: string): boolean {
		return this.getPluginInstance(id) !== null;
	}

	/** Resolves `false` when the internals are absent or the call threw — never rejects. */
	async enablePlugin(id: string): Promise<boolean> {
		const pm = this.pluginManager();
		if (typeof pm?.enablePlugin !== "function") return false;
		try {
			await pm.enablePlugin(id);
			return true;
		} catch (err) {
			console.error(`modkit: enablePlugin("${id}") failed`, err);
			return false;
		}
	}

	async disablePlugin(id: string): Promise<boolean> {
		const pm = this.pluginManager();
		if (typeof pm?.disablePlugin !== "function") return false;
		try {
			await pm.disablePlugin(id);
			return true;
		} catch (err) {
			console.error(`modkit: disablePlugin("${id}") failed`, err);
			return false;
		}
	}

	/**
	 * Re-evaluate a plugin's `main.js` without restarting Obsidian, following hot-reload's sequence
	 * exactly (the design notes §3.1): guard on `enabledPlugins`, await disable, await enable in
	 * a `try`/`finally`.
	 *
	 * The `finally` is load-bearing rather than decorative: it clears the in-flight marker even when
	 * `enablePlugin` throws, so a plugin that fails to come back up does not leave the supervisor
	 * permanently ignoring events for that id.
	 *
	 * hot-reload also flips `localStorage["debug-plugin"]` and patches the adapter to preserve
	 * sourcemaps across the cycle. That is dev tooling for a plugin author reading stack traces;
	 * modkit deliberately does not touch a user's localStorage.
	 */
	async reloadPlugin(id: string): Promise<boolean> {
		const pm = this.pluginManager();
		if (!pm) return false;
		if (pm.enabledPlugins?.has(id) !== true) return false; // don't reload a plugin the user turned off
		if (this.reloading.has(id)) return false;

		this.reloading.add(id);
		try {
			if (!(await this.disablePlugin(id))) return false;
			return await this.enablePlugin(id);
		} finally {
			this.reloading.delete(id);
		}
	}

	isReloading(id: string): boolean {
		return this.reloading.has(id);
	}

	/** A live registered command object — reach plane D's handle. */
	getCommand(id: string): Command | null {
		return this.app.commands?.commands?.[id] ?? null;
	}
}
