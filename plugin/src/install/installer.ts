/**
 * Writing a plugin into the vault from inside a running plugin, and turning it on.
 *
 * This is the rung-1 thesis in code (PLAN E1): `mkdir` + `write` under `vault.configDir`, then
 * `app.plugins.enablePlugin(newId)`, then the same again for an update — with nothing restarted. If
 * this does not work the whole interaction model degrades to "write the file and ask the user to
 * reload", which is a different and much worse product.
 *
 * **`install(..., { enable: false })` is the one exception, and it exists because a promise was
 * being broken.** "Enable a mod once it is installed → off" was honoured by enabling the mod and
 * then disabling it a moment later, so the mod's `onload` ran: its patches installed, and anything
 * it does on load — rewriting a note, trashing a file, sending a request — had already happened by
 * the time it was switched off. The review modal meanwhile promised "written to disk and left off".
 * Effects are the one thing a reclaim contract cannot take back, so the only honest way to keep
 * that promise is never to enable it at all. That path skips the settle, the index wait, the
 * enable and the liveness check, and returns `enabled: false` — the mod's code has not run.
 *
 * Four things this file is careful about, each because of a specific failure it is shaped around:
 *
 * 1. **Never hardcode `.obsidian`.** `Vault.configDir` is public and its own doc comment says the
 *    value "could be different" (`obsidian.d.ts:7344`). A hardcoded path writes a plausible-looking
 *    plugin tree into a directory nobody reads.
 * 2. **Read every write back.** `adapter.write` resolving is a claim about the call, not about the
 *    file. This box has lost real data to writes that reported success and produced nothing, and
 *    the only reliable check is to read the bytes afterwards.
 * 3. **Never clobber someone else's plugin.** The mod id names a directory in the user's vault and
 *    arrives from the daemon, so it is validated as a path segment *and* required to be a modkit id
 *    before a single byte is written. An existing directory that modkit does not own is a refusal.
 * 4. **Let the loader settle.** Obsidian learns about a new plugin folder by watching the config
 *    directory, and hot-reload debounces its own reindex by 250 ms for exactly that reason
 *    (`hot-reload.js:71`). Installs are serialised per mod and separated from the enable by a settle
 *    delay, so a rapid rewrite does not race the loader into loading half a directory.
 *
 * Nothing here throws into Obsidian: every path returns a typed result. A `Component` subclass so
 * every timer it creates is reclaimed on unload, per the house rule that acquisitions go through the
 * reclaim contract.
 */

import { Component, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { ObsidianPluginManifest, ModRecord, ModHealthState, ReachTarget } from "@modkit/types";
import type { Host } from "../host/host";
import { makeHealth, ModStore } from "./modstore";
import type { ModDirectoryProbe } from "./modstore";
import { isStableClass } from "../picker/selector";

/**
 * Does `selector` anchor on a class the picker itself would refuse to emit — a state/platform class
 * like `.tappable` or `.is-active` (see `selector.ts`'s `isStableClass`)?
 *
 * **Why this lives here, not just in the picker.** The measured search-icon bug (PLAN.md
 * 2026-09-02) came from a selector the *daemon's model* wrote, not one this plugin generated —
 * `selector.ts` physically cannot emit a class it never read off a live element, and it never saw
 * `.tappable` at all. Hardening `isStableClass` (fix 32971d9) closes the path where modkit's own
 * picker hands the daemon a bad anchor; it does nothing about the daemon writing one from scratch.
 * This is the cheap, in-fence half of that gap: a `reach.selector` the daemon returns is checked
 * against the same deny-list before it is written into the vault, so at least the failure is a
 * visible install warning instead of a silent no-op discovered only by the DOM-reach check minutes
 * later. It does not reach the real fix, which is upstream in the daemon's validator/prompt.
 */
export function findDeniedSelectorToken(selector: string): string | null {
	const classTokens = selector.match(/\.[A-Za-z_][\w-]*/g) ?? [];
	for (const token of classTokens) {
		const cls = token.slice(1);
		if (!isStableClass(cls)) return cls;
	}
	return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Inputs and results
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The bytes of a mod, and nothing else. Structurally satisfied by a verified `ArtifactPayload`, so
 * the installer never sees a signature, a job, or a daemon — it is handed an artifact only after
 * someone else has decided it is trustworthy.
 */
export interface InstallableMod {
	modId: string;
	manifest: ObsidianPluginManifest;
	/** The built CJS bundle, verbatim. */
	mainJs: string;
	/**
	 * A stylesheet, for plane-E mods that ship one. When absent, an existing `styles.css` from a
	 * previous generation is **removed** — Obsidian loads that file automatically, so leaving a stale
	 * one behind keeps applying CSS the current mod no longer contains.
	 */
	stylesCss?: string;
	/** Expected lowercase hex SHA-256 of `utf8(mainJs)`. Checked against the file on disk when given. */
	sha256?: string;
}

/**
 * Everything a {@link ModRecord} needs that the caller knows. The installer fills in the rest —
 * `sha256` from the file it actually wrote, timestamps, `enabled` and initial `health` — because
 * those are statements about the install, and a caller supplying them would be guessing.
 */
/** Per-install policy. Everything here defaults to the rung-1 behaviour, so omitting it changes nothing. */
export interface InstallOptions {
	/**
	 * Enable the mod once it is written. Default `true`.
	 *
	 * `false` means the mod's code **never runs**: Obsidian only loads what is listed in
	 * `community-plugins.json`, so an un-enabled folder is inert. This is the only honest way to
	 * keep the "installed and left switched off" promise — enabling and immediately disabling runs
	 * `onload`, and an effect that has happened cannot be un-happened by a reclaim contract.
	 */
	enable?: boolean;
}

export type ModRecordSeed = Omit<
	ModRecord,
	"protocol" | "sha256" | "createdAt" | "updatedAt" | "enabled" | "health"
>;

/**
 * What the ledger may honestly claim the moment a mod's files land.
 *
 * `applied` is a statement about an *effect*, and {@link ModHealthState} defines it for a mod that
 * works by being invoked as "invoked at least once". At install nothing has been invoked, so for
 * every plane that patches a member the honest answer is `no-effect`, and the promotion is earned
 * later by the mod's own runtime report — which is exactly where the type doc says promotion comes
 * from. E3 (2026-09-03) is what this is for: a plane-C mod on a cache-fill path read `applied` the
 * instant it installed, while the thing the user asked to change sat visibly unchanged, because the
 * target had already parsed it. That is the silent no-op wearing modkit's own verdict.
 *
 * **Plane E is the exception, and deliberately.** A stylesheet has no invocation to wait for —
 * Obsidian applies `styles.css` itself — so live-confirmation here *is* the evidence. It is also
 * the only promotion source available: `verifyDomReach` refines and never asserts, so if this
 * returned `no-effect` for a CSS mod, nothing downstream could ever move it to `applied`.
 */
export function installHealthState(reach: ReachTarget, enabled: boolean, live: boolean): ModHealthState {
	if (!enabled || !live) return "no-effect";
	return reach.plane === "E" ? "applied" : "no-effect";
}

export type InstallErrorCode =
	/** The probe found a fatal defect: `app.plugins` is not the shape modkit needs. */
	| "host-unavailable"
	/** The id is not a usable path segment, or not a modkit mod id. */
	| "invalid-mod-id"
	/** `manifest.id` disagrees with the directory name. Obsidian keys on the manifest, so this
	 *  installs a plugin under a name nothing will ever look up. */
	| "manifest-mismatch"
	/** A directory of that name exists and modkit does not own it. */
	| "id-collision"
	| "mkdir-failed"
	| "write-failed"
	/** The write reported success and the read-back disagreed. */
	| "write-not-verified"
	/** Obsidian never indexed the new manifest, so `enablePlugin` has nothing to enable. */
	| "manifest-not-indexed"
	| "enable-failed"
	| "disable-failed"
	| "remove-failed"
	/** Asked to uninstall something that is not there. */
	| "not-installed"
	/** The files landed but the ledger did not. */
	| "store-failed"
	| "unexpected";

export interface InstallError {
	code: InstallErrorCode;
	/** One sentence, written for the person who asked for the mod. */
	message: string;
	detail?: Record<string, string>;
}

export interface InstallSuccess {
	ok: true;
	modId: string;
	/** Hex SHA-256 of the `main.js` **on disk**; `""` when the platform exposes no SubtleCrypto. */
	sha256: string;
	/**
	 * The mod is enabled — in `enabledPlugins`, or written to `community-plugins.json`, or both.
	 *
	 * Usually its instance is live too. The exception is the rare case where the loader never
	 * indexed the new folder: then the mod is enabled and on disk but its `onload` has not run yet,
	 * `warnings` says so, and the next Obsidian start loads it.
	 *
	 * `false` is only ever returned for an `{ enable: false }` install, and it then means something
	 * stronger than "switched off": the mod was never enabled, so its `onload` never ran.
	 */
	enabled: boolean;
	/**
	 * The mod's instance is actually running right now — as opposed to `enabled`, which is true the
	 * moment Obsidian's loader has been *asked*. The one case they disagree is `enabled: true,
	 * live: false`: the manifest-not-indexed path above, where the mod is on disk and in
	 * `community-plugins.json` but no `onload` has run yet. A caller that treats `enabled` alone as
	 * "the mod's code has executed" is the exact promotion bug this field exists to prevent — see the
	 * review finding at PLAN.md 2026-09-02 that a plane-E DOM check fired off `enabled` alone and
	 * overwrote an honest `no-effect` row with `applied` for a mod whose `onload` had never run.
	 */
	live: boolean;
	/** This replaced an existing installation rather than creating one. */
	updated: boolean;
	/** The stored record, when a seed was given. */
	record?: ModRecord;
	/** Non-fatal notes worth showing — e.g. that the enable may not survive a restart. */
	warnings: string[];
}

export interface UninstallSuccess {
	ok: true;
	modId: string;
	removedDirectory: boolean;
	removedRecord: boolean;
	warnings: string[];
}

export type InstallResult = InstallSuccess | { ok: false; error: InstallError };
export type UninstallResult = UninstallSuccess | { ok: false; error: InstallError };

function fail(code: InstallErrorCode, message: string, detail?: Record<string, string>): { ok: false; error: InstallError } {
	const error: InstallError = { code, message };
	if (detail !== undefined) error.detail = detail;
	return { ok: false, error };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A path segment safe to create in someone's vault. Deliberately narrow: this string arrives from
 * the daemon and becomes a directory name, so anything clever in it is a bug at best.
 */
const MOD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** modkit's own plugin id. Writing here would have modkit overwrite itself mid-run. */
const MODKIT_SELF_ID = "modkit";

/** Matches `pjeby/hot-reload`'s 250 ms reindex debounce — the same watcher is doing the noticing. */
const DEFAULT_SETTLE_MS = 250;
/** How long to keep waiting for Obsidian to index a brand-new manifest before giving up. */
const INDEX_TRIES = 12;

/**
 * Hex SHA-256 through WebCrypto. `null` rather than a throw when SubtleCrypto is missing: a mod
 * whose integrity hash could not be computed is still an installable mod, and a hash is not worth
 * failing an install over. Obsidian's renderer has it on both desktop and mobile.
 */
export async function sha256Hex(text: string): Promise<string | null> {
	try {
		const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
		if (subtle === undefined) return null;
		const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	} catch (err) {
		console.error("modkit: could not hash main.js", err);
		return null;
	}
}

export interface InstallerOptions {
	/**
	 * Delay between finishing the write and asking Obsidian to enable, so the config-directory
	 * watcher has seen the new files. Default {@link DEFAULT_SETTLE_MS}.
	 */
	settleMs?: number;
	/**
	 * Require the `modkit-mod-` prefix on every installed id. Default `true`, and it is what makes
	 * "is this directory ours?" answerable without reading someone else's manifest. Turn it off only
	 * for a fixture in a test vault.
	 */
	requireModIdPrefix?: boolean;
}

/**
 * The undocumented persisting variants. They are **not** in modkit's internals augmentation because
 * nothing in the recon material verified them; this is the sanctioned narrow local cast (the
 * Commander idiom) for a member we use only if it is really there.
 *
 * Why bother: `enablePlugin` is verified to enable a plugin for this session, and hot-reload only
 * ever uses it on plugins already in `community-plugins.json`. A brand-new mod is not in that file,
 * so without the `AndSave` variant the enable may not survive a restart. We try it, fall back, and
 * say so in a warning rather than quietly shipping a mod that vanishes tomorrow.
 */
type PersistingPluginManager = {
	enablePluginAndSave?(id: string): Promise<void>;
	disablePluginAndSave?(id: string): Promise<void>;
};

/**
 * The rescan, under the same narrow-cast rule and for the same reason.
 *
 * the design notes §1.5 left three outcomes open for a brand-new plugin id — the watcher
 * indexes it, a rescan call is needed, or it takes a restart — and said outright: do not call
 * `loadManifests`, measure it first. **It was measured on 2026-09-01, in Obsidian 1.13.7, by
 * driving the real UI**: a mod generated through the picker was written to disk and the enable
 * failed with `manifest-not-indexed`; Obsidian's own "refresh installed plugins" button then took
 * the count from 6 to 7 and the mod appeared immediately. So the watcher does *not* index a new
 * folder here, an explicit rescan does, and outcome (b) is what this box does.
 *
 * That refresh button is the affordance this escalation automates — modkit's own failure message
 * already told the user to press it.
 *
 * The escalation stays last-resort — tried only once the watcher has already failed and the install
 * is otherwise about to fail — because that is the ordering that makes an unverified call safe to
 * make: the worst case is the state we were in anyway.
 */
type RescannablePluginManager = {
	loadManifests?(): Promise<void> | void;
};

/* ────────────────────────────────────────────────────────────────────────────
 * The installer
 * ──────────────────────────────────────────────────────────────────────────── */

export class ModInstaller extends Component implements ModDirectoryProbe {
	private readonly settleMs: number;
	private readonly requirePrefix: boolean;
	/** Per-mod serialisation. Two installs of one id must never interleave their write and enable. */
	private readonly chains = new Map<string, Promise<unknown>>();
	/** Live settle delays, each with its resolver so unloading can release them rather than strand them. */
	private readonly timers = new Map<number, () => void>();

	constructor(
		private readonly app: App,
		private readonly host: Host,
		private readonly store: ModStore,
		options: InstallerOptions = {},
	) {
		super();
		this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
		this.requirePrefix = options.requireModIdPrefix !== false;
		// Registered in the constructor rather than onload(): the timers exist from the first install,
		// which may precede this component being added as a child of the plugin.
		//
		// Clearing a settle delay must also *resolve* it. A cleared timeout whose promise never
		// settles would strand the install awaiting it — and with it that mod's serialisation chain,
		// forever. Unloading mid-install should let the install finish and fail honestly, not hang.
		this.register(() => {
			for (const [id, release] of this.timers) {
				window.clearTimeout(id);
				release();
			}
			this.timers.clear();
		});
	}

	// ------------------------------------------------------------------ paths

	/** `<configDir>/plugins` — never `.obsidian/plugins`. */
	get pluginsDir(): string {
		return normalizePath(`${this.app.vault.configDir}/plugins`);
	}

	modDir(modId: string): string {
		return normalizePath(`${this.pluginsDir}/${modId}`);
	}

	private get adapter() {
		return this.app.vault.adapter;
	}

	// --------------------------------------------------- ModDirectoryProbe

	async hasDirectory(modId: string): Promise<boolean> {
		try {
			return await this.adapter.exists(this.modDir(modId));
		} catch (err) {
			console.error(`modkit: could not stat the folder for "${modId}"`, err);
			return false;
		}
	}

	/**
	 * Every directory under `<configDir>/plugins/` whose name looks like a modkit mod.
	 *
	 * Prefix-filtered on purpose: the alternative is opening every installed plugin's `manifest.json`
	 * to ask whether it is ours, which is a lot of reads to answer a question the id already answers.
	 * The cost is that a mod installed with `requireModIdPrefix: false` will not be listed — which is
	 * why that option defaults to on.
	 */
	async listModDirectories(): Promise<string[]> {
		try {
			const listing = await this.adapter.list(this.pluginsDir);
			const out: string[] = [];
			for (const folder of listing.folders) {
				const name = folder.split("/").filter((p) => p !== "").pop();
				if (name === undefined || name === MODKIT_SELF_ID) continue;
				if (ModStore.isModkitModId(name)) out.push(name);
			}
			return out.sort();
		} catch (err) {
			console.error("modkit: could not list the plugins folder", err);
			return [];
		}
	}

	isEnabled(modId: string): boolean {
		return this.host.isPluginEnabled(modId);
	}

	// ---------------------------------------------------------------- install

	/**
	 * Write a mod into the vault and enable it. Idempotent per id: installing over an existing mod
	 * disables it first, rewrites, and re-enables — Obsidian's own live-reload sequence, which is the
	 * only way to get new code into a running plugin without a restart.
	 *
	 * `options.enable === false` writes the mod and stops there. Obsidian only loads plugins listed
	 * in `community-plugins.json`, so a folder that is never enabled is inert: no `onload`, no
	 * patches, no effects. See the file header for why that is a separate path rather than an
	 * enable followed by a disable.
	 */
	async install(artifact: InstallableMod, seed?: ModRecordSeed, options: InstallOptions = {}): Promise<InstallResult> {
		const modId = typeof artifact?.modId === "string" ? artifact.modId : "";
		return this.serialize(modId, async () => {
			try {
				return await this.doInstall(artifact, seed, options);
			} catch (err) {
				console.error(`modkit: install of "${modId}" threw`, err);
				return fail("unexpected", `modkit could not install "${modId}".`, { error: String(err) });
			}
		});
	}

	private async doInstall(
		artifact: InstallableMod,
		seed?: ModRecordSeed,
		options: InstallOptions = {},
	): Promise<InstallResult> {
		const warnings: string[] = [];
		const modId = artifact.modId;
		const shouldEnable = options.enable !== false;

		const idError = this.validateModId(modId);
		if (idError !== null) return idError;

		if (!this.host.available) {
			return fail(
				"host-unavailable",
				"modkit cannot enable plugins on this Obsidian build, so it will not write one into your vault.",
			);
		}
		if (artifact.manifest?.id !== modId) {
			return fail(
				"manifest-mismatch",
				`the mod's manifest calls itself "${String(artifact.manifest?.id)}" but it would be installed as "${modId}"; Obsidian keys on the manifest id, so this would never load.`,
				{ manifestId: String(artifact.manifest?.id), modId },
			);
		}

		if (seed !== undefined && seed.reach.plane === "E") {
			const denied = findDeniedSelectorToken(seed.reach.selector);
			if (denied !== null) {
				warnings.push(
					`this mod's selector anchors on ".${denied}", a state/platform class Obsidian can rename or remove without notice — it may already match nothing`,
				);
			}
		}

		const dir = this.modDir(modId);
		const existed = await this.hasDirectory(modId);
		if (existed && !this.ownedByModkit(modId)) {
			return fail(
				"id-collision",
				`"${modId}" already exists in your plugins folder and modkit did not install it — refusing to overwrite it.`,
				{ dir },
			);
		}

		// The update case: get the running copy out of the way before its files change underneath it.
		const wasEnabled = this.host.isPluginEnabled(modId);
		if (wasEnabled) {
			if (!(await this.host.disablePlugin(modId))) {
				return fail("disable-failed", `modkit could not disable the running "${modId}" to update it.`, { modId });
			}
		}

		const dirs = await this.ensureDir(this.pluginsDir);
		if (dirs !== null) return dirs;
		const modDirResult = await this.ensureDir(dir);
		if (modDirResult !== null) return modDirResult;

		// main.js first, manifest.json last: Obsidian notices a plugin by its manifest, so writing the
		// manifest last means the code is always already there when the watcher looks.
		const mainPath = `${dir}/main.js`;
		const manifestPath = `${dir}/manifest.json`;
		const stylesPath = `${dir}/styles.css`;
		const manifestJson = `${JSON.stringify(artifact.manifest, null, 2)}\n`;

		const wroteMain = await this.writeVerified(mainPath, artifact.mainJs);
		if (wroteMain !== null) return wroteMain;

		if (typeof artifact.stylesCss === "string") {
			const wroteStyles = await this.writeVerified(stylesPath, artifact.stylesCss);
			if (wroteStyles !== null) return wroteStyles;
		} else if (await this.exists(stylesPath)) {
			// Obsidian loads styles.css automatically, so a leftover from a previous generation would
			// keep applying rules this mod no longer contains.
			try {
				await this.adapter.remove(stylesPath);
			} catch (err) {
				warnings.push(`an old styles.css could not be removed (${String(err)}); its CSS may still apply`);
			}
		}

		const wroteManifest = await this.writeVerified(manifestPath, manifestJson);
		if (wroteManifest !== null) return wroteManifest;

		const onDisk = await this.readFile(mainPath);
		const digest = onDisk === null ? null : await sha256Hex(onDisk);
		const sha256 = digest ?? "";
		if (digest === null) {
			warnings.push("modkit could not hash the installed main.js, so on-disk tampering will not be detectable");
		} else if (typeof artifact.sha256 === "string" && artifact.sha256 !== "" && artifact.sha256 !== digest) {
			return fail(
				"write-not-verified",
				`the main.js on disk does not match the hash the daemon signed for "${modId}".`,
				{ expected: artifact.sha256, actual: digest },
			);
		}

		if (!shouldEnable) {
			// The files are written and nothing has been asked to load them, so the new code has not
			// run. Two cases still need the mod switched off *properly*:
			//
			// - `wasEnabled`: the update path above already disabled it, but through the
			//   non-persisting `host.disablePlugin`, which drops it from this session and leaves it
			//   listed in `community-plugins.json`. Obsidian would load it again on the next start,
			//   and "it stays off across restarts" would be false. `disableMod` prefers
			//   `disablePluginAndSave`, which writes that list.
			// - anything else that has it running — another session, or a hand-toggle landing
			//   between two awaits — is executing the bytes just written.
			if (wasEnabled || this.host.isPluginEnabled(modId) || this.host.isPluginLoaded(modId)) {
				const off = await this.disableMod(modId);
				if (!off.ok || this.host.isPluginLoaded(modId)) {
					return fail(
						"disable-failed",
						`"${modId}" was written but it is running, and modkit could not switch it off — its code is live even though you asked for it to be left off.`,
						{ dir },
					);
				}
				if (wasEnabled) {
					warnings.push(
						"this mod was running before it was rewritten, so the previous version's code ran this session; the new code has not",
					);
					if (!off.persisted) {
						warnings.push(
							"this Obsidian build has no disablePluginAndSave, so the mod may switch itself back on after a restart",
						);
					}
				}
			}

			const notEnabled: InstallSuccess = { ok: true, modId, sha256, enabled: false, live: false, updated: existed, warnings };
			if (seed !== undefined) {
				const stored = await this.recordInstall(seed, modId, sha256, existed, false);
				if (!stored.ok) return stored.failure;
				notEnabled.record = stored.record;
			}
			return notEnabled;
		}

		// Let the config-directory watcher see the files before asking the loader for them.
		await this.sleep(this.settleMs);

		let indexed = await this.waitFor(() => this.host.getPluginManifest(modId) !== null, INDEX_TRIES);
		if (!indexed) {
			// The watcher did not notice. Ask for a rescan before giving up — see
			// {@link RescannablePluginManager} for why this is reached for here and nowhere earlier.
			indexed = await this.rescanManifests(modId);
		}
		if (!indexed) {
			warnings.push("Obsidian had not indexed the new plugin folder yet; modkit tried to enable it anyway");
		}

		const enable = await this.enableMod(modId);
		if (!enable.ok) {
			if (!indexed) {
				return fail(
					"manifest-not-indexed",
					`Obsidian has not noticed "${modId}" in your plugins folder yet, so it could not be enabled. The refresh button next to "Installed plugins" forces a rescan.`,
					{ dir },
				);
			}
			return fail("enable-failed", `modkit wrote "${modId}" but Obsidian refused to enable it.`, { dir });
		}
		if (!enable.persisted) {
			warnings.push(
				"this Obsidian build has no enablePluginAndSave, so the mod is enabled for this session but may need enabling again after a restart",
			);
		}

		// The whole point of the exercise: a plugin that reports enabled but has no live instance is
		// a half-install, and we have to know the difference.
		let live = await this.waitFor(() => this.host.isPluginLoaded(modId), 4);
		if (!live) {
			await this.sleep(this.settleMs);
			live = this.host.isPluginLoaded(modId);
		}
		if (!live && !enable.persisted) {
			// Not enabled in this session and not written to `community-plugins.json` either: nothing
			// will ever load it, so this really is a failed install.
			return fail(
				"enable-failed",
				`"${modId}" was enabled but never appeared in Obsidian's running plugins — it is installed and inert.`,
				{ dir },
			);
		}
		if (!live) {
			// Enabled and persisted, but the loader never produced an instance — the rescan above did
			// not get the manifest indexed in time. This is not a failed install: the mod is on disk,
			// it is in `community-plugins.json`, and Obsidian will load it on its next start.
			//
			// It used to return `enable-failed` here, which was wrong twice over. It told the user the
			// install had failed when it had not, and — because the failure returns before
			// `recordInstall` — it left the mod running with no ledger row, i.e. permanently reported
			// as an orphan by reconciliation.
			//
			// Unlike the rescan above, this branch is defensive rather than observed: the 2026-09-01
			// measurement failed earlier, at `manifest-not-indexed`. It is kept because *every*
			// failure path here returns before the ledger write, and that asymmetry — an install that
			// half-succeeded and is recorded nowhere — is the bug worth closing generally.
			warnings.push(
				"Obsidian did not load this mod into the running session; it is installed and enabled, and will take effect when you next restart Obsidian",
			);
		}

		const result: InstallSuccess = { ok: true, modId, sha256, enabled: true, live, updated: existed, warnings };

		if (seed !== undefined) {
			const stored = await this.recordInstall(seed, modId, sha256, existed, true, live);
			if (!stored.ok) return stored.failure;
			result.record = stored.record;
		}

		return result;
	}

	/**
	 * Write the ledger row for an install that has already landed on disk.
	 *
	 * `enabled` is passed rather than assumed: it is the record's *intent* and it has to agree with
	 * what actually happened, because a row saying `enabled: true` for a mod that was never enabled
	 * is what reconciliation reports as divergence forever.
	 */
	private async recordInstall(
		seed: ModRecordSeed,
		modId: string,
		sha256: string,
		existed: boolean,
		enabled: boolean,
		/** Whether the mod's instance is actually running. Only ever `false` for the pending-restart
		 *  case, and it is recorded rather than assumed so the ledger cannot claim a patch is applied
		 *  when no `onload` has run. */
		live = true,
	): Promise<{ ok: true; record: ModRecord } | { ok: false; failure: { ok: false; error: InstallError } }> {
		const previous = this.store.get(modId);
		const now = new Date().toISOString();
		const record = {
			...seed,
			protocol: this.store.snapshot().protocol,
			modId,
			sha256,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			enabled,
			health: makeHealth(
				// See `installHealthState`: none of the five states means "not loaded yet", and of the
				// five, `no-effect` is the only one that is not a lie. The mod overwrites this itself
				// via `modkitReportHealth` the moment it loads and has something to report.
				installHealthState(seed.reach, enabled, live),
				enabled
					? !live
						? "enabled, but Obsidian has not loaded it yet — it takes effect on the next restart"
						: seed.reach.plane === "E"
							? existed
								? "updated and enabled"
								: "installed and enabled"
							: // A member patch only changes work the target does from here on, so anything
								// it has already done stays as it was. Saying so is the difference between
								// "this is broken" and "you have not made it happen yet".
								`${existed ? "updated" : "installed"} and enabled — it changes what ${seed.target.kind === "plugin" ? (seed.target.pluginName ?? "the target") : "Obsidian"} does from now on, so open or edit a note to see it`
					: existed
						? "updated and left switched off — the new code has not run"
						: "installed and left switched off — its code has not run",
			),
		} as ModRecord;
		const stored = await this.store.put(record);
		if (!stored.ok) {
			// The files landed; only the ledger failed. Say which half broke, because a mod with no
			// record is a mod that can never be regenerated.
			return {
				ok: false,
				failure: fail(
					"store-failed",
					`"${modId}" is installed${enabled ? " and running" : ""}, but modkit could not record it — it will show up as an orphan.`,
					{ error: stored.error.message },
				),
			};
		}
		return { ok: true, record: stored.value };
	}

	// -------------------------------------------------------------- uninstall

	/**
	 * Turn a mod off, delete its directory, then drop its record — in that order.
	 *
	 * The order is the point: deleting the files of a running plugin leaves its patches installed
	 * with nothing left to disable them, and dropping the record first would lose the id we need to
	 * find the directory.
	 */
	async uninstall(modId: string): Promise<UninstallResult> {
		return this.serialize(modId, async () => {
			try {
				return await this.doUninstall(modId);
			} catch (err) {
				console.error(`modkit: uninstall of "${modId}" threw`, err);
				return fail("unexpected", `modkit could not uninstall "${modId}".`, { error: String(err) });
			}
		});
	}

	private async doUninstall(modId: string): Promise<UninstallResult> {
		const warnings: string[] = [];
		const idError = this.validateModId(modId);
		if (idError !== null) return idError;

		const dir = this.modDir(modId);
		const hadDir = await this.hasDirectory(modId);
		const hadRecord = this.store.has(modId);
		if (!hadDir && !hadRecord) {
			return fail("not-installed", `modkit has nothing installed as "${modId}".`, { modId });
		}
		if (hadDir && !this.ownedByModkit(modId)) {
			return fail(
				"id-collision",
				`"${modId}" is in your plugins folder but modkit did not install it — refusing to delete it.`,
				{ dir },
			);
		}

		if (this.host.isPluginEnabled(modId) || this.host.isPluginLoaded(modId)) {
			const disabled = await this.disableMod(modId);
			if (!disabled.ok) {
				return fail("disable-failed", `modkit could not disable "${modId}", so its files were left in place.`, {
					modId,
				});
			}
			if (this.host.isPluginLoaded(modId)) {
				return fail(
					"disable-failed",
					`"${modId}" is still running after being disabled; modkit will not delete a running plugin's files.`,
					{ modId },
				);
			}
		}

		let removedDirectory = false;
		if (hadDir) {
			const removed = await this.removeDir(dir);
			if (removed !== null) return removed;
			// Read it back, the same rule as for a write: `rmdir` resolving is a claim about the call.
			removedDirectory = !(await this.exists(dir));
			if (!removedDirectory) {
				return fail("remove-failed", `modkit deleted "${modId}" but the folder is still there.`, { dir });
			}
		}

		let removedRecord = false;
		if (hadRecord) {
			const dropped = await this.store.remove(modId);
			if (!dropped.ok) {
				warnings.push(`the files are gone but the record could not be dropped: ${dropped.error.message}`);
			} else {
				removedRecord = true;
			}
		}

		return { ok: true, modId, removedDirectory, removedRecord, warnings };
	}

	// ------------------------------------------------------------ enable/disable

	/**
	 * Set modkit's *and* Obsidian's idea of whether a mod is on. Both, because the record is intent
	 * and `enabledPlugins` is reality, and a UI toggle that moves only one of them is how they drift.
	 */
	async setEnabled(modId: string, enabled: boolean): Promise<InstallResult> {
		return this.serialize(modId, async () => {
			try {
				const idError = this.validateModId(modId);
				if (idError !== null) return idError;
				if (!(await this.hasDirectory(modId))) {
					return fail("not-installed", `"${modId}" is not in your plugins folder.`, { modId });
				}

				const warnings: string[] = [];
				if (enabled) {
					const result = await this.enableMod(modId);
					if (!result.ok) return fail("enable-failed", `Obsidian refused to enable "${modId}".`, { modId });
					if (!result.persisted) warnings.push("the mod may need enabling again after a restart");
				} else {
					const result = await this.disableMod(modId);
					if (!result.ok) return fail("disable-failed", `Obsidian refused to disable "${modId}".`, { modId });
				}

				const nowLoaded = this.host.isPluginLoaded(modId);
				const success: InstallSuccess = {
					ok: true,
					modId,
					sha256: this.store.get(modId)?.sha256 ?? "",
					enabled: nowLoaded,
					live: nowLoaded,
					updated: true,
					warnings,
				};
				if (this.store.has(modId)) {
					const stored = await this.store.setEnabled(modId, enabled);
					if (stored.ok) success.record = stored.value;
					else warnings.push(`modkit could not record the change: ${stored.error.message}`);
				}
				return success;
			} catch (err) {
				console.error(`modkit: setEnabled("${modId}") threw`, err);
				return fail("unexpected", `modkit could not change "${modId}".`, { error: String(err) });
			}
		});
	}

	private async enableMod(modId: string): Promise<{ ok: boolean; persisted: boolean }> {
		const pm = this.host.pluginManager() as unknown as PersistingPluginManager | null;
		if (pm !== null && typeof pm.enablePluginAndSave === "function") {
			try {
				await pm.enablePluginAndSave(modId);
				return { ok: this.host.isPluginEnabled(modId) || this.host.isPluginLoaded(modId), persisted: true };
			} catch (err) {
				console.error(`modkit: enablePluginAndSave("${modId}") failed; falling back`, err);
			}
		}
		return { ok: await this.host.enablePlugin(modId), persisted: false };
	}

	/**
	 * Ask Obsidian to re-read the plugins folder, and report whether `modId` is indexed afterwards.
	 *
	 * Feature-detected and swallowed: a build without `loadManifests`, or one where it throws, simply
	 * leaves us where we already were — not indexed — which the caller already handles. Never returns
	 * `true` on the strength of the call succeeding; only on the manifest actually being there.
	 */
	private async rescanManifests(modId: string): Promise<boolean> {
		const pm = this.host.pluginManager() as unknown as RescannablePluginManager | null;
		if (pm === null || typeof pm.loadManifests !== "function") return false;
		try {
			await pm.loadManifests();
		} catch (err) {
			console.error(`modkit: app.plugins.loadManifests() threw while looking for "${modId}"`, err);
			return false;
		}
		return this.waitFor(() => this.host.getPluginManifest(modId) !== null, INDEX_TRIES);
	}

	private async disableMod(modId: string): Promise<{ ok: boolean; persisted: boolean }> {
		const pm = this.host.pluginManager() as unknown as PersistingPluginManager | null;
		if (pm !== null && typeof pm.disablePluginAndSave === "function") {
			try {
				await pm.disablePluginAndSave(modId);
				return { ok: !this.host.isPluginLoaded(modId), persisted: true };
			} catch (err) {
				console.error(`modkit: disablePluginAndSave("${modId}") failed; falling back`, err);
			}
		}
		return { ok: await this.host.disablePlugin(modId), persisted: false };
	}

	// --------------------------------------------------------------- internals

	private ownedByModkit(modId: string): boolean {
		return this.store.has(modId) || ModStore.isModkitModId(modId);
	}

	private validateModId(modId: string): { ok: false; error: InstallError } | null {
		if (typeof modId !== "string" || !MOD_ID_RE.test(modId) || modId.includes("..")) {
			return fail(
				"invalid-mod-id",
				`"${String(modId)}" is not a usable plugin folder name, so modkit will not create it.`,
				{ modId: String(modId) },
			);
		}
		if (modId === MODKIT_SELF_ID) {
			return fail("invalid-mod-id", "a mod cannot be installed over modkit itself.", { modId });
		}
		if (this.requirePrefix && !ModStore.isModkitModId(modId)) {
			return fail(
				"invalid-mod-id",
				`"${modId}" is not a modkit mod id, and modkit only writes folders it can later recognise as its own.`,
				{ modId },
			);
		}
		return null;
	}

	/** `null` on success, an error result otherwise — `mkdir` on an existing directory throws. */
	private async ensureDir(path: string): Promise<{ ok: false; error: InstallError } | null> {
		if (await this.exists(path)) return null;
		try {
			// Not documented as recursive, so each level is created explicitly by the caller.
			await this.adapter.mkdir(path);
		} catch (err) {
			if (await this.exists(path)) return null; // a race with another writer is not a failure
			return fail("mkdir-failed", `modkit could not create ${path}.`, { error: String(err) });
		}
		return null;
	}

	private async removeDir(dir: string): Promise<{ ok: false; error: InstallError } | null> {
		try {
			await this.adapter.rmdir(dir, true);
			return null;
		} catch (err) {
			// Some adapters refuse a non-empty rmdir even with `recursive`. Clear the known files and
			// try once more before reporting.
			for (const name of ["main.js", "manifest.json", "styles.css", "data.json"]) {
				try {
					const path = `${dir}/${name}`;
					if (await this.exists(path)) await this.adapter.remove(path);
				} catch {
					/* reported by the retry below if it matters */
				}
			}
			try {
				await this.adapter.rmdir(dir, true);
				return null;
			} catch (err2) {
				return fail("remove-failed", `modkit could not delete ${dir}.`, {
					error: String(err),
					retry: String(err2),
				});
			}
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			return await this.adapter.exists(path);
		} catch {
			return false;
		}
	}

	private async readFile(path: string): Promise<string | null> {
		try {
			return await this.adapter.read(path);
		} catch (err) {
			console.error(`modkit: could not read back ${path}`, err);
			return null;
		}
	}

	/** Write, then read back and compare. `null` on success. */
	private async writeVerified(path: string, contents: string): Promise<{ ok: false; error: InstallError } | null> {
		try {
			await this.adapter.write(path, contents);
		} catch (err) {
			return fail("write-failed", `modkit could not write ${path}.`, { error: String(err) });
		}
		const readBack = await this.readFile(path);
		if (readBack === null) {
			return fail("write-not-verified", `modkit wrote ${path} but could not read it back.`, { path });
		}
		if (readBack !== contents) {
			return fail("write-not-verified", `${path} does not contain what modkit just wrote.`, {
				path,
				wroteBytes: String(contents.length),
				readBytes: String(readBack.length),
			});
		}
		return null;
	}

	/** Serialise per mod id, so a rapid second install waits rather than racing the first's enable. */
	private serialize<T>(modId: string, job: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(modId) ?? Promise.resolve();
		const run = previous.then(job, job);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(modId, tail);
		void tail.then(() => {
			// Don't grow a map entry per mod for the life of the session.
			if (this.chains.get(modId) === tail) this.chains.delete(modId);
		});
		return run;
	}

	private sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			const id = window.setTimeout(() => {
				this.timers.delete(id);
				resolve();
			}, ms);
			this.timers.set(id, resolve);
		});
	}

	/** Poll a cheap predicate a few times, `settleMs` apart. True as soon as it holds. */
	private async waitFor(predicate: () => boolean, tries: number): Promise<boolean> {
		for (let i = 0; i < tries; i++) {
			if (predicate()) return true;
			await this.sleep(this.settleMs);
		}
		return predicate();
	}
}
