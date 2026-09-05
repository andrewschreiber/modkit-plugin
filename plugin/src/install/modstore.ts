/**
 * The mod ledger: every mod modkit has installed, persisted in modkit's own `data.json`.
 *
 * ## Why this is not just an array on the settings object
 *
 * The load-bearing field of a {@link ModRecord} is `request` — the user's sentence. Regeneration
 * does not repair a broken patch, it regenerates from the original intent against the new source
 * (DESIGN §5), so a record that has lost its sentence is a mod that can never be repaired. That
 * makes this file's real job *not losing data*, and three specific ways to lose it are designed
 * against here:
 *
 * 1. **A sibling writer clobbering us.** modkit's `data.json` also holds the plugin's own settings,
 *    written by `SettingsStore` through the same `Plugin.saveData`. So every mutation re-reads the
 *    file, applies itself to *that* object, and writes the whole thing back with every foreign
 *    top-level key preserved verbatim. In-memory state is never the thing written.
 *
 *    Re-reading is necessary and was not sufficient. Until 2026-08-31 each store had its own private
 *    promise queue, which serialises a store against itself and against nothing else, so the
 *    interleave `ModStore reads → SettingsStore reads+writes → ModStore writes` silently reverted the
 *    setting (reproduced with both real classes and a fake vault: `debugLogging: true` vanished from
 *    disk while the tab still showed it on). Both stores now share **one** owner of the file —
 *    `sharedDataFile(host)` in `../settings/settings`, keyed on the host object so `new ModStore(this)`
 *    and `new SettingsStore(this)` land on the same {@link DataFile} — and every read-modify-write
 *    below runs inside one `transact()` that the other store cannot interleave with. This store
 *    writes the `mods` key; the settings store writes `settings`; each copies the other's through.
 * 2. **LiveSync rewriting the file underneath us.** This vault syncs, so `data.json` genuinely does
 *    change on disk while Obsidian is running — that is what `Plugin.onExternalSettingsChange()`
 *    exists for (`obsidian.d.ts:5075`, @since 1.5.7). {@link ModStore.handleExternalChange} re-reads
 *    and reports what moved rather than assuming our copy is current.
 * 3. **A write that reports success and produces nothing.** Every write is verified by reading it
 *    back. This box has lost real data to exactly that failure class, and the only reliable check
 *    is to read the bytes afterwards.
 *
 * ## What it will not do
 *
 * Reconciliation **reports**, it does not adopt or delete. A plugin directory under
 * `<configDir>/plugins/` with no record here is an orphan — possibly a half-finished install,
 * possibly a mod that arrived by sync before its record did — and silently adopting it would invent
 * a `request` that nobody typed. Equally, a record whose directory is gone is marked `target-gone`
 * and kept: on a synced vault the directory may simply not have arrived yet, and the sentence is the
 * irreplaceable half.
 *
 * Nothing here throws. Every operation returns a typed {@link ModStoreResult}, because the callers
 * are Obsidian lifecycle hooks and a settings tab, and an exception thrown into either is a broken
 * app rather than a broken feature.
 */

import { MODKIT_MOD_ID_PREFIX, MODKIT_PROTOCOL_VERSION } from "@modkit/types";
import type {
	ModHealth,
	ModHealthState,
	ModRecord,
	ModkitDataFile,
	ModkitProtocol,
} from "@modkit/types";

import { sharedDataFile } from "../settings/settings";
import type { DataFile, DataFileIo } from "../settings/settings";

/* ────────────────────────────────────────────────────────────────────────────
 * Collaborators
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The two `Plugin` methods the store needs. Declared structurally rather than taking a `Plugin`, so
 * the store is testable without an `App` and so it is obvious that this class touches nothing else
 * on the plugin object.
 *
 * `Plugin` satisfies it as-is: `loadData(): Promise<any>` / `saveData(data: any): Promise<void>`
 * (`obsidian.d.ts:5049-5064`).
 */
export interface ModStoreHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

/**
 * What reconciliation needs to know about the vault. Implemented by `ModInstaller` (`hasDirectory`,
 * `listModDirectories`, `isEnabled`), and declared here so the dependency points one way only:
 * the installer imports the store, never the reverse.
 */
export interface ModDirectoryProbe {
	/** Is `<configDir>/plugins/<modId>/` present right now? */
	hasDirectory(modId: string): Promise<boolean>;
	/** Every directory under `<configDir>/plugins/` that looks like a modkit mod, by id. */
	listModDirectories(): Promise<string[]>;
	/**
	 * Whether Obsidian currently has the mod enabled. Optional: without it reconciliation simply
	 * does not report intent-vs-reality divergence, which is a smaller loss than a hard dependency
	 * on the host layer.
	 */
	isEnabled?(modId: string): boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Results
 * ──────────────────────────────────────────────────────────────────────────── */

export type ModStoreErrorCode =
	/** A mutation was attempted before {@link ModStore.load}. */
	| "not-loaded"
	/** `loadData()` threw or returned something that is not an object. */
	| "read-failed"
	/** `saveData()` threw. */
	| "write-failed"
	/** `saveData()` reported success and the read-back disagreed. The dangerous one. */
	| "write-not-verified"
	/** No record with that id. */
	| "not-found"
	/** The caller handed us something that is not a usable record. */
	| "invalid-record";

export interface ModStoreError {
	code: ModStoreErrorCode;
	/** One sentence, written for whoever is reading a `Notice` or the settings tab. */
	message: string;
	detail?: Record<string, string>;
}

export type ModStoreResult<T> = { ok: true; value: T } | { ok: false; error: ModStoreError };

function fail<T>(code: ModStoreErrorCode, message: string, detail?: Record<string, string>): ModStoreResult<T> {
	const error: ModStoreError = { code, message };
	if (detail !== undefined) error.detail = detail;
	return { ok: false, error };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Events and reports
 * ──────────────────────────────────────────────────────────────────────────── */

export type ModStoreChangeKind =
	/** The file was read for the first time. */
	| "loaded"
	/** A record was created or modified by us. */
	| "updated"
	/** A record was dropped by us. */
	| "removed"
	/** The file changed on disk underneath us (sync, another device, a text editor). */
	| "external"
	/** A reconciliation pass ran and something moved. */
	| "reconciled";

export interface ModStoreChange {
	kind: ModStoreChangeKind;
	/** The records this change concerns. Empty for `loaded`. */
	modIds: string[];
}

/** What a reconciliation pass found. Every field is a *report*; nothing here was adopted or deleted. */
export interface ReconcileReport {
	checkedAt: string;
	/** Records whose plugin directory is gone. Marked `target-gone`, kept. */
	missing: string[];
	/** Directories that look like modkit mods but have no record. Reported, never adopted. */
	orphans: string[];
	/** Records written by a modkit speaking a different protocol version. Kept, untouched. */
	foreignProtocol: string[];
	/** Records whose `enabled` intent disagrees with Obsidian's actual enabled set. */
	divergent: string[];
	/** Records whose health this pass changed. */
	updated: string[];
	/** Entries in `mods` that could not be read as records at all. Preserved verbatim on write. */
	unreadable: number;
}

/** What an external-change pass found, relative to what we had in memory. */
export interface ExternalChangeReport {
	added: string[];
	removed: string[];
	changed: string[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const HEALTH_STATES: ReadonlySet<string> = new Set<ModHealthState>([
	"applied",
	"no-effect",
	"target-moved",
	"target-gone",
	"error",
]);

/** Build a {@link ModHealth} without tripping over `exactOptionalPropertyTypes`. */
export function makeHealth(
	state: ModHealthState,
	detail: string,
	extras: { targetVersionSeen?: string | null; invocations?: number } = {},
): ModHealth {
	const health: ModHealth = { state, detail, lastCheckedAt: new Date().toISOString() };
	if (extras.targetVersionSeen !== undefined) health.targetVersionSeen = extras.targetVersionSeen;
	if (extras.invocations !== undefined) health.invocations = extras.invocations;
	return health;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asHealth(value: unknown): ModHealth | null {
	if (!isPlainObject(value)) return null;
	const state = value["state"];
	if (typeof state !== "string" || !HEALTH_STATES.has(state)) return null;
	const health: ModHealth = {
		state: state as ModHealthState,
		detail: typeof value["detail"] === "string" ? (value["detail"] as string) : "",
		lastCheckedAt:
			typeof value["lastCheckedAt"] === "string" ? (value["lastCheckedAt"] as string) : new Date().toISOString(),
	};
	const seen = value["targetVersionSeen"];
	if (typeof seen === "string" || seen === null) health.targetVersionSeen = seen;
	const invocations = value["invocations"];
	if (typeof invocations === "number" && Number.isFinite(invocations)) health.invocations = invocations;
	return health;
}

/**
 * Read one stored entry as a record.
 *
 * Deliberately lenient about everything except `modId` and `request`. Those two are the record's
 * identity and its irreplaceable content; every other field can be defaulted, and quarantining a
 * record over a missing `explanation` would be destroying the one field we cannot regenerate in
 * order to protect one we can. An entry with no usable id is the only thing we refuse — there is
 * nothing to key it by — and even that is preserved on write rather than dropped.
 */
function asModRecord(value: unknown): ModRecord | null {
	if (!isPlainObject(value)) return null;
	const modId = asNonEmptyString(value["modId"]);
	if (modId === null) return null;

	const now = new Date().toISOString();
	const record = {
		...value,
		protocol: (typeof value["protocol"] === "string" ? value["protocol"] : MODKIT_PROTOCOL_VERSION) as ModkitProtocol,
		modId,
		name: asNonEmptyString(value["name"]) ?? modId,
		request: typeof value["request"] === "string" ? value["request"] : "",
		sha256: typeof value["sha256"] === "string" ? value["sha256"] : "",
		explanation: typeof value["explanation"] === "string" ? value["explanation"] : "",
		createdAt: asNonEmptyString(value["createdAt"]) ?? now,
		updatedAt: asNonEmptyString(value["updatedAt"]) ?? now,
		enabled: value["enabled"] === true,
		health:
			asHealth(value["health"]) ??
			makeHealth("error", "the stored record carried no readable health, so modkit does not know if it is working"),
	} as unknown as ModRecord;
	return record;
}

/** Newest-first by `updatedAt`, for de-duplicating a file that somehow carries an id twice. */
function newerOf(a: ModRecord, b: ModRecord): ModRecord {
	return a.updatedAt >= b.updatedAt ? a : b;
}

/** Which ids appeared, vanished, or moved between two views of the ledger. */
function diffRecords(before: ReadonlyMap<string, ModRecord>, after: ReadonlyMap<string, ModRecord>): string[] {
	const touched: string[] = [];
	for (const [modId, record] of after) {
		const previous = before.get(modId);
		if (previous === undefined || previous.updatedAt !== record.updatedAt) touched.push(modId);
	}
	for (const modId of before.keys()) {
		if (!after.has(modId)) touched.push(modId);
	}
	return touched;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The store
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ModStoreOptions {
	/**
	 * Read every write back and compare before reporting success. Default `true`, and turning it
	 * off should need a reason: a write that reported success and produced nothing is the failure
	 * class this codebase has actually been bitten by.
	 */
	verifyWrites?: boolean;
}

export class ModStore {
	/** Every top-level key of `data.json` *except* `mods` — the plugin's own settings live here. */
	private data: Record<string, unknown> = {};
	private records = new Map<string, ModRecord>();
	/**
	 * Entries of `mods` that had no usable id. Kept so writing the file back does not destroy them;
	 * a human can look at `data.json` and see what modkit could not read.
	 */
	private unreadable: unknown[] = [];
	private loaded = false;
	/**
	 * The one owner of `data.json`, shared with `SettingsStore` when both were built over the same
	 * host. It serialises this store's mutations against *every* writer, not just against itself.
	 */
	private readonly file: DataFile;
	private readonly detach: () => void;
	private readonly listeners = new Set<(change: ModStoreChange) => void>();
	private readonly verifyWrites: boolean;

	constructor(host: ModStoreHost, options: ModStoreOptions = {}) {
		this.verifyWrites = options.verifyWrites !== false;
		this.file = sharedDataFile(host);
		// When the settings store writes, the file we are holding is one version behind. Adopt what it
		// wrote rather than waiting for the next mutation to re-read: `this.data` is the half of the
		// file we copy through untouched, and copying a stale `settings` through is the very bug the
		// shared owner exists to stop.
		this.detach = this.file.register(this, (raw) => {
			this.adoptExternal(raw);
		});
	}

	/**
	 * Let go of the shared file. Nothing outlives the plugin without it (the `DataFile` hangs off a
	 * `WeakMap` keyed on the plugin), but an acquisition on a long-lived object gets a release —
	 * `this.register(() => store.dispose())` in `onload`.
	 */
	dispose(): void {
		this.detach();
		this.listeners.clear();
	}

	/** Re-read from an object another store just wrote, and report any ledger movement it carried. */
	private adoptExternal(raw: Record<string, unknown>): void {
		const before = new Map(this.records);
		this.applyRaw(raw);
		if (!this.loaded) return;
		const touched = diffRecords(before, this.records);
		if (touched.length > 0) this.emit("external", touched);
	}

	// ------------------------------------------------------------------ reads

	get isLoaded(): boolean {
		return this.loaded;
	}

	/** Every record, sorted by id so a UI list and the on-disk file agree on order. */
	all(): ModRecord[] {
		return [...this.records.values()].sort((a, b) => a.modId.localeCompare(b.modId));
	}

	get(modId: string): ModRecord | null {
		return this.records.get(modId) ?? null;
	}

	has(modId: string): boolean {
		return this.records.has(modId);
	}

	get size(): number {
		return this.records.size;
	}

	/**
	 * Subscribe to changes. Returns an unsubscribe, which the caller is expected to hand to
	 * `Component.register()` — the reclaim contract applies to a listener on a long-lived object
	 * exactly as it does to a DOM listener.
	 */
	onChange(listener: (change: ModStoreChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(kind: ModStoreChangeKind, modIds: string[]): void {
		const change: ModStoreChange = { kind, modIds };
		for (const listener of this.listeners) {
			try {
				listener(change);
			} catch (err) {
				// A listener that throws is the settings tab's bug, not the ledger's.
				console.error("modkit: a mod-store listener threw", err);
			}
		}
	}

	// ----------------------------------------------------------------- file io

	/** Read `data.json` and populate the store. Safe to call again; that is a plain refresh. */
	async load(): Promise<ModStoreResult<ModRecord[]>> {
		return this.file.transact<ModStoreResult<ModRecord[]>>(this, async (io) => {
			const read = await this.readFile(io);
			if (!read.ok) return read;
			this.loaded = true;
			this.emit("loaded", []);
			return { ok: true, value: this.all() };
		});
	}

	private async readFile(io: DataFileIo): Promise<ModStoreResult<void>> {
		let raw: unknown;
		try {
			raw = await io.read();
		} catch (err) {
			return fail("read-failed", "modkit could not read its own data.json — no mods can be listed or updated.", {
				error: String(err),
			});
		}
		this.applyRaw(raw);
		return { ok: true, value: undefined };
	}

	/**
	 * Adopt a freshly-read file. `null` is the normal first-run answer from `loadData()`, and a file
	 * that is not an object at all is treated the same way: start empty rather than refuse to run,
	 * because refusing would make a corrupt settings file into an unusable plugin.
	 */
	private applyRaw(raw: unknown): void {
		const file: Record<string, unknown> = isPlainObject(raw) ? raw : {};
		const rest: Record<string, unknown> = {};
		for (const key of Object.keys(file)) {
			if (key !== "mods") rest[key] = file[key];
		}
		this.data = rest;

		const records = new Map<string, ModRecord>();
		const unreadable: unknown[] = [];
		const mods = file["mods"];
		if (Array.isArray(mods)) {
			for (const entry of mods) {
				const record = asModRecord(entry);
				if (record === null) {
					unreadable.push(entry);
					continue;
				}
				const existing = records.get(record.modId);
				records.set(record.modId, existing === undefined ? record : newerOf(existing, record));
			}
		} else if (mods !== undefined) {
			// A `mods` that is not an array is corruption we must not silently discard.
			unreadable.push(mods);
		}
		this.records = records;
		this.unreadable = unreadable;
	}

	/**
	 * The object actually written.
	 *
	 * `this.data` is every key but `mods`, taken verbatim from the read that opened this transaction —
	 * so the plugin's own `settings` go back exactly as they were found, whoever wrote them.
	 */
	private serialize(): Record<string, unknown> {
		const file: Record<string, unknown> = { ...this.data };
		file["protocol"] = MODKIT_PROTOCOL_VERSION;
		// Sorted, so a mutation produces a minimal diff. On a synced vault a stable byte order is the
		// difference between one changed line and a whole-file conflict.
		file["mods"] = [...this.all(), ...this.unreadable];
		return file;
	}

	private async writeFile(io: DataFileIo): Promise<ModStoreResult<void>> {
		const next = this.serialize();
		try {
			await io.write(next);
		} catch (err) {
			return fail("write-failed", "modkit could not save its mod list.", { error: String(err) });
		}
		if (!this.verifyWrites) return { ok: true, value: undefined };

		// Read it back. `saveData` resolving is a claim about the call, not about the file.
		let verify: unknown;
		try {
			verify = await io.read();
		} catch (err) {
			return fail("write-not-verified", "modkit saved its mod list but could not read it back to confirm.", {
				error: String(err),
			});
		}
		const seen = new Set<string>();
		const mods = isPlainObject(verify) ? verify["mods"] : undefined;
		if (Array.isArray(mods)) {
			for (const entry of mods) {
				const id = isPlainObject(entry) ? asNonEmptyString(entry["modId"]) : null;
				if (id !== null) seen.add(id);
			}
		}
		const expected = [...this.records.keys()];
		const lost = expected.filter((id) => !seen.has(id));
		if (lost.length > 0) {
			return fail(
				"write-not-verified",
				`modkit saved its mod list but ${lost.length} record(s) were not there on read-back — the save did not take.`,
				{ missing: lost.join(", ") },
			);
		}
		return { ok: true, value: undefined };
	}

	/**
	 * Every mutation is one of these: re-read the file, apply, write, verify.
	 *
	 * Re-reading first is what makes a sibling writer (the settings tab) and an external writer
	 * (LiveSync) safe — we never write back an in-memory copy that predates their change.
	 */
	private async mutate<T>(
		apply: () => ModStoreResult<T>,
		emit: (value: T) => ModStoreChange | null,
	): Promise<ModStoreResult<T>> {
		return this.file.transact<ModStoreResult<T>>(this, async (io) => {
			if (!this.loaded) {
				return fail<T>("not-loaded", "modkit's mod list has not been loaded yet.");
			}
			const read = await this.readFile(io);
			if (!read.ok) return read;

			const applied = apply();
			if (!applied.ok) return applied;

			const written = await this.writeFile(io);
			if (!written.ok) {
				// Put the disk's version back in memory rather than leaving the failed edit visible —
				// a UI showing a change that did not persist is worse than one showing the truth.
				await this.readFile(io);
				return written;
			}
			const change = emit(applied.value);
			if (change !== null) this.emit(change.kind, change.modIds);
			return applied;
		});
	}

	// --------------------------------------------------------------- mutations

	/** Create or replace a record. `createdAt` is preserved across a replace; `updatedAt` is set. */
	async put(record: ModRecord): Promise<ModStoreResult<ModRecord>> {
		return this.mutate<ModRecord>(
			() => {
				const modId = asNonEmptyString(record?.modId);
				if (modId === null) {
					return fail("invalid-record", "a mod record with no id cannot be stored.");
				}
				const previous = this.records.get(modId);
				const next: ModRecord = {
					...record,
					protocol: MODKIT_PROTOCOL_VERSION,
					createdAt: previous?.createdAt ?? record.createdAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				this.records.set(modId, next);
				return { ok: true, value: next };
			},
			(value) => ({ kind: "updated", modIds: [value.modId] }),
		);
	}

	/**
	 * Merge changes into an existing record. `modId`, `protocol` and `createdAt` are not patchable —
	 * they are the record's identity, and letting a caller rewrite them turns an update into a
	 * silent second record.
	 */
	async patch(
		modId: string,
		changes: Partial<Omit<ModRecord, "modId" | "protocol" | "createdAt">>,
	): Promise<ModStoreResult<ModRecord>> {
		return this.mutate<ModRecord>(
			() => {
				const current = this.records.get(modId);
				if (current === undefined) {
					return fail("not-found", `modkit has no record for "${modId}".`, { modId });
				}
				const next: ModRecord = {
					...current,
					...changes,
					modId: current.modId,
					protocol: current.protocol,
					createdAt: current.createdAt,
					updatedAt: new Date().toISOString(),
				};
				this.records.set(modId, next);
				return { ok: true, value: next };
			},
			(value) => ({ kind: "updated", modIds: [value.modId] }),
		);
	}

	/**
	 * Record what modkit currently believes about a mod's health.
	 *
	 * `targetVersionSeen` and `invocations` are **observations only the mod itself can make**, so
	 * omitting them means "unchanged", never "erase". Every writer that is not the mod calls
	 * {@link makeHealth} with no extras — the supervisor's reapply/reload-failed emits, the DOM
	 * reach verifier — and a whole-object replace therefore deleted both fields from the row on
	 * every target reload. Measured in E3 (2026-09-03): the row lost its version and its call count
	 * on all three rungs of a plugin update, which is exactly when a user is asking whether the mod
	 * still works, and the Settings card's "Times it has run" fact simply disappeared.
	 *
	 * A caller that genuinely means zero passes zero; `undefined` is not a value here.
	 */
	async setHealth(modId: string, health: ModHealth): Promise<ModStoreResult<ModRecord>> {
		const previous = this.records.get(modId)?.health;
		const merged: ModHealth = { ...health };
		if (merged.targetVersionSeen === undefined && previous?.targetVersionSeen !== undefined) {
			merged.targetVersionSeen = previous.targetVersionSeen;
		}
		if (merged.invocations === undefined && previous?.invocations !== undefined) {
			merged.invocations = previous.invocations;
		}
		return this.patch(modId, { health: merged });
	}

	/**
	 * Record modkit's *intent* for a mod. This is not the authority on what is running — Obsidian's
	 * enabled-plugins set is — and the two legitimately disagree when the user toggles a mod in
	 * Obsidian's own plugin list. {@link reconcile} reports that divergence; it does not resolve it.
	 */
	async setEnabled(modId: string, enabled: boolean): Promise<ModStoreResult<ModRecord>> {
		return this.patch(modId, { enabled });
	}

	/** Mark that the user has confirmed the mod does what they asked (DESIGN §5's frozen assertions). */
	async markUserVerified(modId: string, at = new Date().toISOString()): Promise<ModStoreResult<ModRecord>> {
		return this.patch(modId, { userVerifiedAt: at });
	}

	/**
	 * Drop a record. Removing a record does **not** remove the mod's files — that is
	 * `ModInstaller.uninstall`'s job, and this is the last step of it. Called on its own it produces
	 * an orphan, which is exactly what reconciliation will then report.
	 */
	async remove(modId: string): Promise<ModStoreResult<ModRecord>> {
		return this.mutate<ModRecord>(
			() => {
				const current = this.records.get(modId);
				if (current === undefined) {
					return fail("not-found", `modkit has no record for "${modId}".`, { modId });
				}
				this.records.delete(modId);
				return { ok: true, value: current };
			},
			(value) => ({ kind: "removed", modIds: [value.modId] }),
		);
	}

	// ---------------------------------------------------------- reconciliation

	/**
	 * `Plugin.onExternalSettingsChange()` — the file changed on disk without going through us.
	 *
	 * Disk wins, and that is the only defensible rule: the alternative is deciding which of two
	 * devices' edits to discard with no information about either. What we do owe the user is a
	 * report of what moved, so the mod list can refresh and a surprising change is visible rather
	 * than merely applied.
	 */
	async handleExternalChange(): Promise<ModStoreResult<ExternalChangeReport>> {
		return this.file.transact<ModStoreResult<ExternalChangeReport>>(this, async (io) => {
			const before = new Map(this.records);
			const read = await this.readFile(io);
			if (!read.ok) return read;
			this.loaded = true;

			const added: string[] = [];
			const removed: string[] = [];
			const changed: string[] = [];
			for (const [modId, record] of this.records) {
				const previous = before.get(modId);
				if (previous === undefined) added.push(modId);
				else if (previous.updatedAt !== record.updatedAt) changed.push(modId);
			}
			for (const modId of before.keys()) {
				if (!this.records.has(modId)) removed.push(modId);
			}

			const touched = [...added, ...removed, ...changed];
			if (touched.length > 0) this.emit("external", touched);
			return { ok: true, value: { added, removed, changed } };
		});
	}

	/**
	 * Compare the ledger against the vault.
	 *
	 * Three findings, and only one of them writes anything:
	 * - a record whose directory is gone becomes `target-gone` (written, because a mod list that
	 *   still claims `applied` for a mod that is not on disk is lying);
	 * - a directory with no record is an **orphan** — reported, never adopted, because adopting one
	 *   would mean inventing the `request` that produced it;
	 * - a record whose `enabled` intent disagrees with Obsidian is reported, not resolved.
	 */
	async reconcile(probe: ModDirectoryProbe): Promise<ModStoreResult<ReconcileReport>> {
		return this.file.transact<ModStoreResult<ReconcileReport>>(this, async (io) => {
			const read = await this.readFile(io);
			if (!read.ok) return read;
			this.loaded = true;

			const checkedAt = new Date().toISOString();
			const missing: string[] = [];
			const foreignProtocol: string[] = [];
			const divergent: string[] = [];
			const updated: string[] = [];

			let dirs: string[] = [];
			try {
				dirs = await probe.listModDirectories();
			} catch (err) {
				// A failed listing must not be read as "every mod is gone" — that would mark the whole
				// ledger `target-gone` on a transient adapter error.
				return fail<ReconcileReport>("read-failed", "modkit could not list the plugins folder.", {
					error: String(err),
				});
			}
			const present = new Set(dirs);

			for (const record of this.all()) {
				if (record.protocol !== MODKIT_PROTOCOL_VERSION) foreignProtocol.push(record.modId);

				let onDisk = present.has(record.modId);
				if (!onDisk) {
					// The listing is prefix-filtered; ask directly before concluding anything is gone.
					try {
						onDisk = await probe.hasDirectory(record.modId);
					} catch {
						onDisk = true; // unknown is not gone
					}
				}
				if (!onDisk) {
					missing.push(record.modId);
					if (record.health.state !== "target-gone") {
						this.records.set(record.modId, {
							...record,
							updatedAt: checkedAt,
							health: makeHealth(
								"target-gone",
								`the mod's plugin folder is not in the vault; it was not removed by modkit, so it may not have synced yet`,
							),
						});
						updated.push(record.modId);
					}
					continue;
				}
				if (probe.isEnabled !== undefined) {
					const actuallyEnabled = probe.isEnabled(record.modId);
					if (actuallyEnabled !== record.enabled) {
						divergent.push(record.modId);
						// Obsidian's answer wins: the toggle in Community plugins is a legitimate way to turn
						// a mod off, and a row that keeps saying `enabled: true` afterwards makes every
						// enabled-gated check (the plane-E recheck, the supervisor) report on a mod that is
						// not running — measured 2026-09-03 as "stylesheet is not attached to this window"
						// on two mods Obsidian had off. Report the divergence AND repair the row.
						this.records.set(record.modId, { ...record, enabled: actuallyEnabled, updatedAt: checkedAt });
						updated.push(record.modId);
					}
				}
			}

			const orphans = dirs.filter((id) => !this.records.has(id));

			if (updated.length > 0) {
				const written = await this.writeFile(io);
				if (!written.ok) {
					await this.readFile(io);
					return written;
				}
			}

			const report: ReconcileReport = {
				checkedAt,
				missing,
				orphans,
				foreignProtocol,
				divergent,
				updated,
				unreadable: this.unreadable.length,
			};
			if (updated.length > 0 || orphans.length > 0 || missing.length > 0) {
				this.emit("reconciled", [...new Set([...updated, ...missing, ...orphans])]);
			}
			return { ok: true, value: report };
		});
	}

	/**
	 * The ledger as one document — {@link ModkitDataFile} is the `mods` half of `data.json`, the
	 * shape the plugin owns and the installer reads the protocol from.
	 */
	snapshot(): ModkitDataFile {
		return { protocol: MODKIT_PROTOCOL_VERSION, mods: this.all() };
	}

	/** Ids of the mods this store knows about, for the installer's collision check. */
	knownIds(): string[] {
		return [...this.records.keys()];
	}

	/** Does this id look like something modkit generated? Used before writing into a directory. */
	static isModkitModId(modId: string): boolean {
		return modId.startsWith(MODKIT_MOD_ID_PREFIX);
	}
}
