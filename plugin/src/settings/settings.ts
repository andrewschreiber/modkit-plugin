/**
 * modkit's settings, and the single owner of `data.json` that every writer goes through.
 *
 * Four things shape this file, and none of them are style preferences:
 *
 * 1. **`data.json` holds two different things.** modkit's own settings *and* the mod ledger
 *    (`ModRecord[]`, which the daemon also understands — `@modkit/types`'s {@link ModkitDataFile}).
 *    They share one file because Obsidian gives a plugin exactly one.
 *
 * 2. **So the file gets exactly one owner: {@link DataFile}.** Two stores write it —
 *    {@link SettingsStore} (the settings half) and `ModStore` (the ledger half) — and until
 *    2026-08-31 each had its *own* private promise queue, which serialises a store against itself
 *    and against nothing else. Measured with the real classes and a fake vault: ModStore reads,
 *    SettingsStore reads and writes, ModStore writes back what it computed from its stale read, and
 *    `debugLogging: true` is gone from disk while the settings tab still shows it on. A silently
 *    reverted setting is about the worst bug shape there is, so the queue now lives on the file
 *    rather than on either store: `sharedDataFile(host)` hands both stores the same {@link DataFile}
 *    (keyed on the host object, so `new SettingsStore(this)` and `new ModStore(this)` in `main.ts`
 *    resolve to one owner without either signature changing), and every read-modify-write runs
 *    inside one `transact()` that no other store can interleave with.
 *
 *    The second half of that fix is **each writer touches only its own key**. A settings save writes
 *    `settings` and copies `mods` through byte-for-byte; the ledger writes `mods` and copies
 *    `settings` through. The old code re-serialised the whole file from its own parse, which also
 *    destroyed the entries `ModStore` deliberately preserves for a human to look at (a record with
 *    no `modId` survived a settings save 0 times out of 1 before this change).
 *
 * 3. **Another device rewrites this file under us.** LiveSync syncs the vault this plugin lives in —
 *    the *notes*, see point 4 — so `data.json` can change on disk while Obsidian is running, and
 *    `Plugin.onExternalSettingsChange()` exists for exactly that (`obsidian.d.ts:5075-5085`, since
 *    1.5.7). Every write therefore **re-reads disk first** and merges rather than stamping an
 *    in-memory copy over whatever arrived, and **preserves top-level keys it does not recognise**,
 *    because a newer modkit on the other box may store something this build has never heard of.
 *
 * 4. **The bearer token does NOT live in `data.json`.** It lives in {@link TOKEN_FILE_NAME}, a
 *    sibling file in the plugin's own folder that this store reads and writes and that never enters
 *    the settings blob. That is not belt-and-braces; it is measured against the LiveSync build
 *    installed in this vault (`.obsidian/plugins/obsidian-livesync/main.js`, 2026-08-30), whose
 *    `getFileCategory()` classifies a file under `<configDir>/plugins/`:
 *      - `…/data.json` → `PLUGIN_DATA` — replicated whenever **Customization sync** (`usePluginSync`)
 *        is on;
 *      - anything else → `PLUGIN_ETC`, and only when `usePluginSyncV2 && usePluginEtc`; otherwise
 *        the category is `""` and `isTargetPath()` is false, i.e. the file is not replicated at all.
 *    So flipping on Customization sync — a single switch, no warning — would push a live credential
 *    to every device on the vault if the token sat in `data.json`, and does not if it sits beside it.
 *    Today's measured state in this vault is `usePluginSync=false`, `usePluginEtc=false`,
 *    `syncInternalFiles=false`; an *earlier* version of this header claimed the safety came from
 *    "LiveSync syncs this vault", which was true of the notes and false of `.obsidian/` — that
 *    accident is what point 4 replaces with a design. Hidden-file sync (`syncInternalFiles`) would
 *    still carry both files, so {@link SettingsStore.probeLiveSync} reads LiveSync's own settings and
 *    the settings tab names the credential at risk when it is on.
 *
 *    Since 2026-08-31 that same file also carries the daemon's credentials: the daemon writes it
 *    directly (`packages/modkit-daemon/src/sidecar.ts`) with the token, the public key to pin, and
 *    the origin it is serving, so on a desktop box — daemon and plugin, one uid, one filesystem —
 *    nobody has to act as the transport between two file paths. {@link parseSidecar} reads it,
 *    {@link applyPairing} decides what it is allowed to override, and the settings tab still takes a
 *    paste for the case the sidecar does not cover: a daemon across a network hop.
 *
 * The token is also never logged, never returned by {@link redactSettings}, and never rendered back
 * into the DOM by the settings tab.
 *
 * No `obsidian` import on purpose: the store needs `loadData`/`saveData`, plus — when the host
 * happens to be a real `Plugin` — a vault adapter it discovers by duck-typing. Both stay narrow
 * ports so this file is testable outside the app.
 */

import { MODKIT_PROTOCOL_VERSION, MOD_HEALTH_SEVERITY, isModelBackend } from "@modkit/types";
import type { ModHealth, ModRecord, ModelBackend, ModkitDataFile, ModkitProtocol } from "@modkit/types";

/* ────────────────────────────────────────────────────────────────────────────
 * The settings type
 * ──────────────────────────────────────────────────────────────────────────── */

/** The daemon's measured-free loopback port (the design notes §2.2). */
export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:8501";

export const MIN_REQUEST_TIMEOUT_MS = 2_000;
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

/** A raw Ed25519 public key as modkit pins it: 32 bytes, 64 lowercase hex characters. */
export const PUBKEY_HEX_LENGTH = 64;

export interface ModkitSettings {
	/** Origin of the modkit daemon, no trailing slash — e.g. `http://127.0.0.1:8501`. */
	daemonBaseUrl: string;
	/**
	 * Bearer token for every route except `/v1/health`.
	 *
	 * Present on this object because everything that needs it reads `store.settings.daemonToken`,
	 * but **not persisted into `data.json`**: {@link SettingsStore} keeps it in
	 * {@link TOKEN_FILE_NAME} beside `data.json` and strips it from the settings blob on every
	 * write (file header, point 4). Never rendered back into the DOM either — the settings tab
	 * shows only whether one is stored.
	 */
	daemonToken: string;
	/**
	 * The pinned **root** Ed25519 public key, 64 lowercase hex. Empty means nothing is pinned, and
	 * with {@link requireSignature} on that is a hard stop rather than a soft default — an unpinned
	 * key means every signature would verify against whatever the daemon claims to be.
	 */
	daemonPubkey: string;
	/**
	 * Refuse to install an artifact whose signature does not verify against {@link daemonPubkey}.
	 * Defaults ON, and turning it off means arbitrary code from whatever answers on
	 * {@link daemonBaseUrl} gets written into the vault and run with the vault's file access.
	 */
	requireSignature: boolean;
	/** Enable a mod as soon as it is installed. See {@link enablePolicy} for how this and
	 *  {@link reviewBeforeEnable} combine — they are not independent switches. */
	autoEnableGeneratedMods: boolean;
	/**
	 * Show the generated source and wait for an explicit approval before anything is written.
	 *
	 * **Defaults ON, and it is the only gate that does not depend on a machine being right.** The
	 * daemon's validator rejects a patch that breaks the reclaim contract, and it has been found
	 * fail-open in four consecutive adversarial rounds — each on a mechanism nobody had enumerated.
	 * A static analyser over adversarially generated source is a good filter and a bad boundary, so
	 * the last gate is a person reading the code (`ui/ReviewModal.ts`).
	 *
	 * Turning it off means a model's output is written into the vault and run with the vault's full
	 * file access without anybody having looked at it.
	 */
	reviewBeforeEnable: boolean;
	/**
	 * Per-HTTP-call timeout. This bounds one request, **not** a generation: generation is async and
	 * the plugin polls `/v1/jobs/:id`, so a slow model never trips this.
	 */
	/**
	 * Which backend the daemon should use for this vault's generations, or `""` for "whatever the
	 * daemon booted with".
	 *
	 * Empty is the default and is not the same as `"claude"`: it means this vault expresses no
	 * opinion, so a daemon configured for codex keeps generating with codex. Naming a backend here
	 * sends it on every request as a {@link ModelOverride}.
	 *
	 * **Choosing `codex` here is a request, not a grant.** The daemon refuses it unless its
	 * operator set `MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1` in the daemon's own environment, because
	 * codex's shell tool can read any file on that machine during a generation. A settings dropdown
	 * must not be able to turn that on for someone who never read why it is a decision — so the
	 * dropdown offers it, the daemon decides, and `/v1/health`'s `codexAvailable` is what the tab
	 * reads to explain the refusal before it happens.
	 */
	modelBackend: "" | ModelBackend;
	/**
	 * The model id to generate with, or `""` for the daemon's configured model.
	 *
	 * Free text rather than a fixed list: the set of ids a `claude` or `codex` CLI accepts changes
	 * faster than this plugin ships, and a dropdown that lags is a dropdown that blocks the model
	 * someone is paying for.
	 */
	modelName: string;
	requestTimeoutMs: number;
	/**
	 * Developer mode: verbose `console.debug` from modkit (never the token), **and** the switch that
	 * reveals the Phase-0 experiment command in the palette.
	 *
	 * The second job is not decoration. E2 disables and re-enables a plugin the user relies on. It
	 * is guarded by a consent modal, and until 2026-08-31 it was also **one fuzzy match on
	 * "experiment" away from anyone who opened the command palette** — which is not a decision, it
	 * is a typo with consequences. `main.ts` registers it with a `checkCallback` that reads this
	 * flag, so with it off it is not listed and cannot be invoked, and with it on it is found where
	 * a developer would look for it.
	 *
	 * NOTE for whoever next edits `SettingsTab.ts`: its description for this toggle still says only
	 * "Verbose modkit output in the developer console". It should also say that it lists the Phase-0
	 * experiment — a switch whose second effect is undocumented is a switch nobody finds.
	 */
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: Readonly<ModkitSettings> = Object.freeze({
	daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
	daemonToken: "",
	daemonPubkey: "",
	requireSignature: true,
	autoEnableGeneratedMods: true,
	// ON, and it stays ON by default. See {@link ModkitSettings.reviewBeforeEnable}: this is the one
	// gate in the install path whose correctness does not rest on a static analyser being complete.
	reviewBeforeEnable: true,
	// Empty means "the daemon's own choice" for both. A plugin that shipped a default of "claude"
	// would silently override a daemon its owner had deliberately configured for codex.
	modelBackend: "",
	modelName: "",
	requestTimeoutMs: 30_000,
	debugLogging: false,
});

/**
 * The whole `data.json`.
 *
 * `protocol` and `mods` sit at the top level because {@link ModkitDataFile} — the half the daemon
 * reads — puts them there. Settings are nested under one key so that adding a setting can never
 * collide with a field the shared contract adds later.
 */
export interface ModkitData extends ModkitDataFile {
	protocol: ModkitProtocol;
	settings: ModkitSettings;
	mods: ModRecord[];
}

/** The slice of `Plugin` the store needs. Narrow on purpose — see the file header. */
export interface DataStore {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalisation and validation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Tidy a user-typed daemon URL: trim, add `http://` when no scheme was typed, drop trailing
 * slashes. Returns `""` for empty input rather than substituting the default, so "I cleared this
 * field" and "I never set it" stay distinguishable.
 */
export function normalizeBaseUrl(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return "";
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	return withScheme.replace(/\/+$/, "");
}

/**
 * Why this URL is unusable, in one sentence, or `null` when it is fine. Returning the sentence
 * rather than a boolean keeps the settings tab from having to invent its own wording.
 */
export function describeUrlProblem(raw: string): string | null {
	const url = normalizeBaseUrl(raw);
	if (url === "") return "No daemon URL is set, so modkit cannot generate anything.";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `“${url}” is not a URL modkit can parse.`;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `modkit speaks HTTP and HTTPS; “${parsed.protocol.replace(":", "")}” is neither.`;
	}
	if (parsed.pathname !== "/" && parsed.pathname !== "") {
		return `Give the daemon's origin only — drop “${parsed.pathname}”, modkit appends /v1/… itself.`;
	}
	return null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/**
 * A warning about an otherwise-valid URL, or `null`. The one that matters: plain HTTP off the
 * loopback interface puts the bearer token on the wire in the clear.
 */
export function describeUrlWarning(raw: string): string | null {
	const url = normalizeBaseUrl(raw);
	if (url === "") return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
		return `This is plain HTTP to ${parsed.hostname}, so the auth token crosses the network unencrypted. Loopback or a tailnet with HTTPS is the safe shape.`;
	}
	return null;
}

/** Lowercase and strip whitespace, `0x`, and separators a pasted key often carries. */
export function normalizePubkey(raw: string): string {
	return (raw ?? "").trim().toLowerCase().replace(/^0x/, "").replace(/[\s:_-]/g, "");
}

export function isValidPubkey(raw: string): boolean {
	const hex = normalizePubkey(raw);
	return hex.length === PUBKEY_HEX_LENGTH && /^[0-9a-f]+$/.test(hex);
}

/**
 * `a1b2c3d4…9e8f7a6b` — enough to compare two keys by eye, short enough to sit in a row of text.
 * Never elide so far that two different keys look identical: 8 hex on each end is 64 bits.
 */
export function shortPubkey(raw: string): string {
	const hex = normalizePubkey(raw);
	if (hex === "") return "(none)";
	if (hex.length <= 20) return hex;
	return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

export function clampTimeout(ms: number): number {
	if (!Number.isFinite(ms)) return DEFAULT_SETTINGS.requestTimeoutMs;
	return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(ms)));
}

/**
 * What happens to a freshly installed mod. The two toggles are not independent, and deriving this
 * in one place is what stops the installer and the settings tab describing the same configuration
 * differently.
 *
 * - `review-then-enable` — show the source, enable on approval. The default.
 * - `enable` — enable immediately, no review.
 * - `leave-disabled` — install it and leave it off; the user flips it in the mod list.
 */
export type EnablePolicy = "review-then-enable" | "enable" | "leave-disabled";

export function enablePolicy(settings: ModkitSettings): EnablePolicy {
	if (!settings.autoEnableGeneratedMods) return "leave-disabled";
	return settings.reviewBeforeEnable ? "review-then-enable" : "enable";
}

/**
 * Does an install have to be shown to the user first?
 *
 * Separate from {@link enablePolicy} on purpose, and it is not a refactor for tidiness. `enablePolicy`
 * collapses to `leave-disabled` the moment {@link ModkitSettings.autoEnableGeneratedMods} is off, and
 * that collapse **discards the review question entirely** — so a user who asked to see the code and
 * asked for new mods to arrive switched off got the install written silently, which is the opposite
 * of what both switches say. Review is its own decision: turning off auto-enable is a statement about
 * when code runs, never a statement that it need not be looked at.
 *
 * Read by `main.ts` immediately before the first byte is written; a `false` here is the only way a
 * generated mod reaches the vault without a person seeing it.
 */
export function requiresReview(settings: ModkitSettings): boolean {
	return settings.reviewBeforeEnable;
}

/**
 * Everything standing between these settings and a working generate → install cycle, worst first
 * and phrased for the user. Empty means ready.
 *
 * The settings tab renders this and so should anything that is about to start a generation — the
 * failure this prevents is a job that runs for two minutes and then cannot install what it made.
 */
export function settingsBlockers(settings: ModkitSettings): string[] {
	const blockers: string[] = [];
	const urlProblem = describeUrlProblem(settings.daemonBaseUrl);
	if (urlProblem) blockers.push(urlProblem);
	if (settings.requireSignature && settings.daemonPubkey === "") {
		blockers.push("No daemon signing key is pinned, and signature checking is on — modkit will refuse every artifact until you pin one.");
	}
	if (settings.daemonPubkey !== "" && !isValidPubkey(settings.daemonPubkey)) {
		blockers.push(`The pinned key is not 64 hex characters (it is ${normalizePubkey(settings.daemonPubkey).length}), so no signature can ever verify against it.`);
	}
	if (settings.daemonToken === "") {
		blockers.push(
			"No auth token is set. /v1/health will answer, but generating will return 401. Run `npm run setup` in the modkit repo on the daemon's box, or paste a token into the field below.",
		);
	}
	return blockers;
}

/** Safe to `console.debug`. The token is reported as a boolean and never as a value. */
export function redactSettings(settings: ModkitSettings): Record<string, unknown> {
	return {
		daemonBaseUrl: settings.daemonBaseUrl,
		daemonToken: settings.daemonToken === "" ? "(unset)" : "(set)",
		daemonPubkey: shortPubkey(settings.daemonPubkey),
		requireSignature: settings.requireSignature,
		enablePolicy: enablePolicy(settings),
		requestTimeoutMs: settings.requestTimeoutMs,
		debugLogging: settings.debugLogging,
	};
}

/* ────────────────────────────────────────────────────────────────────────────
 * Parsing what is on disk
 * ──────────────────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Matches the daemon's own cap so a value that saves here cannot be rejected there. */
export const MAX_MODEL_NAME = 200;

/** `"claude"` / `"codex"` survive; everything else, including junk, becomes "the daemon decides". */
function normalizeBackend(value: unknown): "" | ModelBackend {
	return isModelBackend(value) ? value : "";
}

/**
 * Coerce whatever is on disk into settings, field by field, falling back per field rather than
 * per file — one corrupted key must not reset the other seven.
 *
 * `flat` is the same object read a second time as a pre-nesting layout. modkit has never shipped
 * one, but a settings blob whose keys sit at the top level is the single most likely shape to find
 * in a file some other version of this plugin wrote, and recovering it costs one line per field.
 */
export function normalizeSettings(raw: unknown, flat?: unknown): ModkitSettings {
	const nested = isRecord(raw) ? raw : {};
	const outer = isRecord(flat) ? flat : {};
	const pick = (key: keyof ModkitSettings): unknown => (key in nested ? nested[key] : outer[key]);

	return {
		daemonBaseUrl: normalizeBaseUrl(str(pick("daemonBaseUrl"), DEFAULT_SETTINGS.daemonBaseUrl)),
		daemonToken: str(pick("daemonToken"), DEFAULT_SETTINGS.daemonToken).trim(),
		daemonPubkey: normalizePubkey(str(pick("daemonPubkey"), DEFAULT_SETTINGS.daemonPubkey)),
		requireSignature: bool(pick("requireSignature"), DEFAULT_SETTINGS.requireSignature),
		autoEnableGeneratedMods: bool(pick("autoEnableGeneratedMods"), DEFAULT_SETTINGS.autoEnableGeneratedMods),
		reviewBeforeEnable: bool(pick("reviewBeforeEnable"), DEFAULT_SETTINGS.reviewBeforeEnable),
		// Anything that is not a backend this build knows about degrades to "" — the daemon's own
		// choice — rather than being passed through. A stale id from a newer version of the plugin
		// must not become a request the daemon rejects on every generation.
		modelBackend: normalizeBackend(pick("modelBackend")),
		modelName: str(pick("modelName"), DEFAULT_SETTINGS.modelName).trim().slice(0, MAX_MODEL_NAME),
		requestTimeoutMs: clampTimeout(typeof pick("requestTimeoutMs") === "number" ? (pick("requestTimeoutMs") as number) : DEFAULT_SETTINGS.requestTimeoutMs),
		debugLogging: bool(pick("debugLogging"), DEFAULT_SETTINGS.debugLogging),
	};
}

/**
 * A ledger entry whose `health` could not be read still gets shown, marked as needing attention.
 *
 * `ModHealthState` has five members and {@link ModHealthState} says not to add a sixth, so an
 * unreadable record maps onto `error` — which is honest in the way that matters: the user has a mod
 * whose state modkit cannot vouch for, and the mod list must not present it as `applied`.
 */
function unreadableHealth(): ModHealth {
	return {
		state: "error",
		detail: "modkit could not read this mod's health from data.json — the record is from a different version, or the file was edited by hand.",
		lastCheckedAt: new Date(0).toISOString(),
	};
}

/**
 * Is this one of the five health states? Asked against `MOD_HEALTH_SEVERITY`'s own keys rather than
 * a list repeated here, because a second copy of the vocabulary is a second thing to keep in sync —
 * and the contract's whole point is that the plugin and the daemon name these identically.
 */
function isKnownHealthState(value: unknown): value is ModHealth["state"] {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(MOD_HEALTH_SEVERITY, value);
}

function normalizeMod(raw: unknown): ModRecord | null {
	if (!isRecord(raw)) return null;
	if (typeof raw["modId"] !== "string" || raw["modId"] === "") return null;
	const record = raw as unknown as ModRecord;
	// The state has to be one of the five, not merely a string: an unrecognised value would reach
	// the mod list as a badge with no label and no colour, which reads as "fine" — the one thing an
	// unreadable record must never look like.
	const health = raw["health"];
	if (!isRecord(health) || !isKnownHealthState(health["state"]) || typeof health["detail"] !== "string") {
		return { ...record, health: unreadableHealth() };
	}
	return record;
}

/** Top-level keys {@link ModkitData} owns. Everything else in the file is preserved untouched. */
const KNOWN_TOP_LEVEL_KEYS = new Set(["protocol", "settings", "mods"]);

export interface ParsedData {
	data: ModkitData;
	/**
	 * Top-level keys this build does not know about, kept verbatim so saving here never downgrades
	 * a file a newer modkit wrote on another device.
	 */
	unknownKeys: Record<string, unknown>;
	/** The `protocol` actually found on disk, when it was not ours. Reported, never rewritten silently. */
	foreignProtocol: string | null;
	/** Records dropped because they carried no `modId` and so cannot name anything. */
	droppedMods: number;
}

export function parseData(raw: unknown): ParsedData {
	const root = isRecord(raw) ? raw : {};
	const rawMods = Array.isArray(root["mods"]) ? root["mods"] : [];
	const mods: ModRecord[] = [];
	for (const entry of rawMods) {
		const mod = normalizeMod(entry);
		if (mod) mods.push(mod);
	}

	const unknownKeys: Record<string, unknown> = {};
	for (const key of Object.keys(root)) {
		if (!KNOWN_TOP_LEVEL_KEYS.has(key)) unknownKeys[key] = root[key];
	}

	const onDiskProtocol = typeof root["protocol"] === "string" ? root["protocol"] : null;

	return {
		data: {
			protocol: MODKIT_PROTOCOL_VERSION,
			settings: normalizeSettings(root["settings"], root),
			mods,
		},
		unknownKeys,
		foreignProtocol: onDiskProtocol !== null && onDiskProtocol !== MODKIT_PROTOCOL_VERSION ? onDiskProtocol : null,
		droppedMods: rawMods.length - mods.length,
	};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The one owner of data.json
 * ──────────────────────────────────────────────────────────────────────────── */

/** Exclusive access to `data.json` for the length of one transaction. Invalid outside it. */
export interface DataFileIo {
	/** Read the file. Throws what `loadData()` throws; each store has its own idea of what to do. */
	read(): Promise<unknown>;
	/** Write the whole file. */
	write(next: Record<string, unknown>): Promise<void>;
}

/**
 * Adopt a file that some *other* store just wrote, without going back to disk. Called after the
 * writing transaction has ended, so an adopter is free to read its own state — but must not write.
 */
export type DataFileAdopter = (raw: Record<string, unknown>) => void;

/**
 * The single owner of one plugin `data.json`.
 *
 * Its whole job is the queue. Anything that read-modify-writes the file does so inside
 * {@link transact}, and transactions run one at a time, so the interleave that loses an update —
 * A reads, B reads, B writes, A writes — cannot form. Two stores share one instance via
 * {@link sharedDataFile}; see the file header, point 2, for the measurement that made this
 * necessary.
 *
 * It deliberately does **not** parse. Each store knows the shape of its own half, and a parser here
 * would be a third opinion about the file's contents.
 */
export class DataFile {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly adopters = new Map<object, DataFileAdopter>();

	constructor(private readonly store: DataStore) {}

	/**
	 * Register a store's "the file now looks like this" callback. `owner` identifies the store so its
	 * own writes are not handed back to it, and is the same token it passes to {@link transact}.
	 */
	register(owner: object, adopt: DataFileAdopter): () => void {
		this.adopters.set(owner, adopt);
		return () => {
			this.adopters.delete(owner);
		};
	}

	/**
	 * Run one read-modify-write with exclusive access. Everything the callback does to the file goes
	 * through `io`; touching `loadData`/`saveData` directly would step outside the queue.
	 */
	transact<T>(owner: object, fn: (io: DataFileIo) => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			let live = true;
			let written: Record<string, unknown> | null = null;
			const io: DataFileIo = {
				read: async () => {
					if (!live) throw new Error("modkit: data.json was read outside its transaction");
					return this.store.loadData();
				},
				write: async (next) => {
					if (!live) throw new Error("modkit: data.json was written outside its transaction");
					await this.store.saveData(next);
					written = next;
				},
			};
			try {
				return await fn(io);
			} finally {
				live = false;
				// After the write, not during: an adopter that re-entered `transact` would deadlock on a
				// queue whose head is still this job.
				if (written !== null) this.broadcast(written, owner);
			}
		};
		// Chain on the tail regardless of how the previous transaction ended, or one rejection stalls
		// the queue forever.
		const next = this.queue.then(run, run);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private broadcast(raw: Record<string, unknown>, source: object): void {
		for (const [owner, adopt] of this.adopters) {
			if (owner === source) continue;
			try {
				adopt(raw);
			} catch (err) {
				console.error("modkit: a data.json adopter threw", err);
			}
		}
	}
}

/**
 * One {@link DataFile} per host object.
 *
 * Keyed on the host rather than passed in, so `new SettingsStore(this)` and `new ModStore(this)` —
 * both handed the same `Plugin` in `main.ts` — end up sharing one owner without either constructor
 * signature changing. Two stores built over two *different* fakes stay independent, which is what a
 * test wants.
 */
const DATA_FILES = new WeakMap<DataStore, DataFile>();

export function sharedDataFile(host: DataStore): DataFile {
	const existing = DATA_FILES.get(host);
	if (existing) return existing;
	const created = new DataFile(host);
	DATA_FILES.set(host, created);
	return created;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The daemon's sidecar file
 * ──────────────────────────────────────────────────────────────────────────── */

/** The sidecar file, beside `data.json` in modkit's own plugin folder. */
export const TOKEN_FILE_NAME = "daemon-token.json";

/** The sidecar shape this build understands. Written by the daemon's `sidecar.ts`. */
export const SIDECAR_VERSION = 1;

/**
 * The daemon's credentials, as read off disk.
 *
 * The daemon writes this file (`packages/modkit-daemon/src/sidecar.ts`) when both halves live on
 * one box, which is the whole point: the token and the key travel over a same-uid filesystem
 * channel instead of through a human's clipboard. The settings tab still accepts a paste, because
 * the remote case — daemon on mac-mini, plugin on a phone — has a real network hop and no shared
 * filesystem to hand the credentials over.
 */
export interface PairingRecord {
	/** `null` for a file written before the sidecar carried a version — a hand-pasted token. */
	version: number | null;
	/** A **seed** for {@link ModkitSettings.daemonBaseUrl}. See {@link applyPairing} for why. */
	baseUrl: string | null;
	token: string;
	/** Normalised 64-hex, or `null` when the file carried none or carried an unusable one. */
	pinnedPublicKey: string | null;
	pairedAt: string | null;
	pairedBy: string | null;
}

/** Why a sidecar yielded no credentials. Each maps to its own sentence — never a generic failure. */
export type SidecarProblem =
	| "absent"
	| "unreadable"
	| "not-json"
	| "not-an-object"
	| "unsupported-version"
	| "no-token";

export interface SidecarRead {
	state: "paired" | "unpaired";
	problem: SidecarProblem | null;
	record: PairingRecord | null;
	/** One sentence the settings tab can show verbatim. Always specific about *which* thing is wrong. */
	reason: string;
}

function unpaired(problem: SidecarProblem, reason: string): SidecarRead {
	return { state: "unpaired", problem, record: null, reason };
}

/**
 * Parse a sidecar's text. Total: every malformed shape becomes an "unpaired" with a reason.
 *
 * Throwing here would take the plugin's whole `onload` down over a file a user could have edited by
 * hand, and "modkit failed to start" is a far worse report than "modkit has no token, because …".
 */
export function parseSidecar(text: string, path: string = TOKEN_FILE_NAME): SidecarRead {
	if (text.trim() === "") {
		return unpaired("not-json", `${path} is empty, so modkit has no token. Run \`npm run setup\` again, or paste a token below.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return unpaired(
			"not-json",
			`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}), so modkit has no token. Run \`npm run setup\` again to rewrite it.`,
		);
	}
	if (!isRecord(parsed)) {
		return unpaired("not-an-object", `${path} holds ${Array.isArray(parsed) ? "a list" : typeof parsed}, not the daemon's credentials. Run \`npm run setup\` again to rewrite it.`);
	}

	// A file with no `version` is the older shape this plugin used to write itself: `_note` plus
	// `daemonToken`. It is still honoured — a working install must not lose its token to an
	// upgrade — but it carries no key and no origin, so it seeds nothing.
	const rawVersion = parsed["version"];
	const version = typeof rawVersion === "number" ? rawVersion : null;
	if (rawVersion !== undefined && version !== SIDECAR_VERSION) {
		return unpaired(
			"unsupported-version",
			`${path} declares version ${JSON.stringify(rawVersion)}; this modkit understands version ${SIDECAR_VERSION}. It was written by a different modkit — run \`npm run setup\` on the daemon you are actually using.`,
		);
	}

	const token = readString(parsed, "token") ?? readString(parsed, "daemonToken");
	if (token === null) {
		return unpaired("no-token", `${path} carries no token, so every request but /v1/health would return 401. Run \`npm run setup\` again, or paste a token below.`);
	}

	const rawKey = readString(parsed, "pinnedPublicKey");
	const key = rawKey !== null && isValidPubkey(rawKey) ? normalizePubkey(rawKey) : null;
	const pairedBy = readString(parsed, "pairedBy");
	const pairedAt = readString(parsed, "pairedAt");

	const provenance = `Written by ${pairedBy ?? "hand"}${pairedAt === null ? "" : ` at ${pairedAt}`}.`;
	const keyNote =
		rawKey !== null && key === null
			? ` Its pinned key is not 64 hex characters and was ignored — pin one below, or run \`npm run setup\` again.`
			: "";

	return {
		state: "paired",
		problem: null,
		record: {
			version,
			baseUrl: readString(parsed, "baseUrl"),
			token,
			pinnedPublicKey: key,
			pairedAt,
			pairedBy,
		},
		reason: `${provenance}${keyNote}`,
	};
}

function readString(raw: Record<string, unknown>, key: string): string | null {
	const value = raw[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Precedence: what the sidecar decides, and what it only suggests
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A `daemonBaseUrl` nobody has deliberately chosen.
 *
 * Empty (the field was cleared) and the built-in default both mean "no decision was made here", and
 * only those two may be overwritten by the sidecar.
 */
export function isSeedableBaseUrl(stored: string): boolean {
	const url = normalizeBaseUrl(stored);
	return url === "" || url === DEFAULT_DAEMON_BASE_URL;
}

export interface PairingApplication {
	settings: ModkitSettings;
	/** The key modkit will verify against came from the sidecar, not from a paste. */
	pinnedByPairing: boolean;
	/** The sidecar's `baseUrl` filled in a setting nobody had chosen. */
	baseUrlSeeded: boolean;
	/** Fields the record moved. `daemonToken` never reaches `data.json`; the others do. */
	overrode: Array<"daemonToken" | "daemonPubkey" | "daemonBaseUrl">;
}

/**
 * Fold the sidecar into stored settings. **This function is the precedence rule.**
 *
 * - **`token` and `pinnedPublicKey`: the sidecar wins.** The daemon wrote it, out of its own
 *   keyring, on this machine. Anything typed into the settings tab is a hand copy of the same two
 *   values, and when the two disagree the copy is the stale one.
 *
 * - **`baseUrl`: the sidecar only seeds.** It is written by whichever daemon ran setup last, which
 *   on a desktop box is `http://127.0.0.1:8501`. A user who deliberately pointed this plugin at a
 *   remote daemon — the phone talking to mac-mini over the tailnet — must not have that repointed at
 *   loopback by a setup run they were not even present for. The failure that prevents is
 *   **invisible when it happens**: nothing errors, the settings tab shows a plausible URL, and
 *   generation simply stops reaching the daemon that has the vault's mods on it. So a stored URL is
 *   overwritten only when {@link isSeedableBaseUrl} says nobody chose it.
 *
 * Pure, and exported, because a rule stated in prose and implemented in a method is a rule with two
 * versions.
 */
export function applyPairing(stored: ModkitSettings, record: PairingRecord | null): PairingApplication {
	if (record === null) {
		return { settings: stored, pinnedByPairing: false, baseUrlSeeded: false, overrode: [] };
	}

	const settings: ModkitSettings = { ...stored };
	const overrode: PairingApplication["overrode"] = [];

	if (settings.daemonToken !== record.token) {
		settings.daemonToken = record.token;
		overrode.push("daemonToken");
	}

	const pinnedByPairing = record.pinnedPublicKey !== null;
	if (record.pinnedPublicKey !== null && settings.daemonPubkey !== record.pinnedPublicKey) {
		settings.daemonPubkey = record.pinnedPublicKey;
		overrode.push("daemonPubkey");
	}

	let baseUrlSeeded = false;
	if (record.baseUrl !== null && isSeedableBaseUrl(settings.daemonBaseUrl)) {
		const seed = normalizeBaseUrl(record.baseUrl);
		// A record carrying a URL modkit cannot use is worse than no record: it would replace a
		// working default with something `describeUrlProblem` will then complain about forever.
		if (seed !== "" && describeUrlProblem(seed) === null && seed !== settings.daemonBaseUrl) {
			settings.daemonBaseUrl = seed;
			baseUrlSeeded = true;
			overrode.push("daemonBaseUrl");
		}
	}

	return { settings, pinnedByPairing, baseUrlSeeded, overrode };
}

/** Where the token actually is, so the settings tab can name the file rather than describe it. */
export interface TokenLocation {
	/** `sidecar` is the designed state; `data-json` is the fallback when there is no vault adapter. */
	kind: "sidecar" | "data-json";
	/** Vault-relative path of whichever file holds it. */
	path: string;
}

/** Read and write one secret file. Narrow on purpose — the store must not get general file access. */
export interface TokenFile {
	readonly path: string;
	/** What the sidecar says. Never throws; "there is no file" is the normal first-run answer. */
	read(): Promise<SidecarRead>;
	/** Store `token`, preserving every other field of an existing sidecar. */
	writeToken(token: string): Promise<void>;
	/** Delete the file. The pinned key goes with it. */
	clear(): Promise<void>;
}

/** The four `DataAdapter` methods the sidecar needs. A real Obsidian adapter satisfies it. */
interface AdapterLike {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
}

interface VaultAccess {
	adapter: AdapterLike;
	/** `.obsidian`, or whatever the vault's config directory is called. */
	configDir: string | null;
	/** modkit's own plugin folder, e.g. `.obsidian/plugins/modkit`. */
	pluginDir: string;
}

function isFn(value: unknown): value is (...args: never[]) => unknown {
	return typeof value === "function";
}

/**
 * Find the vault behind a host, by duck-typing rather than by importing `Plugin`.
 *
 * Duck-typing is the point: `SettingsStore`'s port stays `loadData`/`saveData`, so a test can hand
 * it a plain object and get the `data-json` fallback, while the real plugin — which *is* a `Plugin`,
 * with `app.vault.adapter` and `manifest.dir` — gets the sidecar. Returns `null` rather than
 * throwing when the host is not a plugin; a missing adapter is a degraded mode, not a failure.
 */
function vaultOf(host: unknown): VaultAccess | null {
	const plugin = host as {
		app?: { vault?: { adapter?: unknown; configDir?: unknown } };
		manifest?: { id?: unknown; dir?: unknown };
	} | null;
	const adapter = plugin?.app?.vault?.adapter as Partial<AdapterLike> | undefined;
	if (!adapter || !isFn(adapter.read) || !isFn(adapter.write) || !isFn(adapter.exists) || !isFn(adapter.remove)) {
		return null;
	}
	const configDir = typeof plugin?.app?.vault?.configDir === "string" ? plugin.app.vault.configDir : null;
	const dir = typeof plugin?.manifest?.dir === "string" ? plugin.manifest.dir : null;
	const id = typeof plugin?.manifest?.id === "string" ? plugin.manifest.id : null;
	const pluginDir = dir ?? (configDir !== null && id !== null ? `${configDir}/plugins/${id}` : null);
	if (pluginDir === null) return null;
	return { adapter: adapter as AdapterLike, configDir, pluginDir: pluginDir.replace(/\/+$/, "") };
}

/**
 * Why the file says what it says, for whoever opens it. JSON has no comments, so it gets a key.
 * Naming the LiveSync setting here is deliberate: this file is the thing someone would otherwise
 * "tidy up" into `data.json`.
 */
const TOKEN_FILE_NOTE =
	"modkit's credentials for this vault: this is a LIVE credential for the modkit daemon — treat it like a password. It is kept out of data.json on purpose: LiveSync's Customization sync replicates a plugin's data.json to every device, and does not replicate this file unless 'usePluginEtc' is on. If you turn on LiveSync's hidden-file sync, add this path to syncInternalFilesIgnorePatterns.";

/** How a token that arrived through the settings tab, rather than from the daemon, records itself. */
const PASTED_BY_HAND = "modkit plugin settings (pasted by hand)";

function tokenFileAt(vault: VaultAccess): TokenFile {
	const path = `${vault.pluginDir}/${TOKEN_FILE_NAME}`;

	const read = async (): Promise<SidecarRead> => {
		try {
			if (!(await vault.adapter.exists(path))) {
				return unpaired("absent", `No credentials at ${path}. Run \`npm run setup\` in the modkit repo on the daemon's box, or paste a token below.`);
			}
			return parseSidecar(await vault.adapter.read(path), path);
		} catch (err) {
			// A file that cannot be read counts as no credentials: the user gets a 401 and a blocker
			// telling them how to fix it, which is recoverable. Rewriting the file here would not be.
			console.error(`modkit: could not read ${path}`, err);
			return unpaired("unreadable", `${path} exists but could not be read (${err instanceof Error ? err.message : String(err)}).`);
		}
	};

	return {
		path,
		read,
		async writeToken(token: string): Promise<void> {
			// Read-modify-write, so pasting a token by hand does not throw away the key a setup run
			// pinned. The provenance is rewritten though — the token in the file now came from a paste,
			// and a `pairedBy` claiming otherwise would be a lie in the one place a human looks.
			const existing = (await read()).record;
			const record: Record<string, unknown> = { _note: TOKEN_FILE_NOTE, version: SIDECAR_VERSION };
			if (existing?.baseUrl !== null && existing?.baseUrl !== undefined) record["baseUrl"] = existing.baseUrl;
			record["token"] = token;
			if (existing?.pinnedPublicKey !== null && existing?.pinnedPublicKey !== undefined) {
				record["pinnedPublicKey"] = existing.pinnedPublicKey;
			}
			record["pairedAt"] = new Date().toISOString();
			record["pairedBy"] = PASTED_BY_HAND;
			await vault.adapter.write(path, `${JSON.stringify(record, null, 2)}\n`);
		},
		async clear(): Promise<void> {
			if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
		},
	};
}

/* ────────────────────────────────────────────────────────────────────────────
 * What LiveSync would do with that file
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * LiveSync's replication settings as they actually are on this box, and the one conclusion that
 * matters: would the file holding the bearer token be pushed to every other device?
 *
 * Read, never assumed. The version of this comment that said "LiveSync syncs this vault, so…" was
 * describing the notes and reasoning about `.obsidian/`, which is how a credential ends up
 * replicated by accident.
 */
export interface LiveSyncExposure {
	/** False when LiveSync is not installed, or its settings could not be read. */
	installed: boolean;
	/** Hidden-file sync: replicates everything under the config dir, this file included. */
	syncInternalFiles: boolean;
	/** Customization sync: replicates each plugin's `data.json`. */
	usePluginSync: boolean;
	usePluginSyncV2: boolean;
	/** Extends customization sync to non-`data.json` files in a plugin folder — i.e. the sidecar. */
	usePluginEtc: boolean;
	/** The verdict for {@link TokenLocation.path}. */
	replicated: boolean;
	/** LiveSync's own name for the switch to turn off, or `null` when nothing is replicating it. */
	setting: string | null;
}

function boolAt(record: Record<string, unknown>, key: string): boolean {
	return record[key] === true;
}

/**
 * Decide from LiveSync's settings whether the token's file replicates. The categories come from the
 * installed build's `getFileCategory()` (see the file header, point 4) rather than from its docs.
 */
export function judgeLiveSync(raw: unknown, location: TokenLocation): LiveSyncExposure {
	if (!isRecord(raw)) {
		return {
			installed: false,
			syncInternalFiles: false,
			usePluginSync: false,
			usePluginSyncV2: false,
			usePluginEtc: false,
			replicated: false,
			setting: null,
		};
	}
	const syncInternalFiles = boolAt(raw, "syncInternalFiles") || boolAt(raw, "syncInternalFilesBeforeReplication");
	const usePluginSync = boolAt(raw, "usePluginSync");
	const usePluginSyncV2 = boolAt(raw, "usePluginSyncV2");
	const usePluginEtc = boolAt(raw, "usePluginEtc");

	const byCustomization =
		usePluginSync && (location.kind === "data-json" ? true : usePluginSyncV2 && usePluginEtc);
	const setting = syncInternalFiles
		? "Sync hidden files (syncInternalFiles)"
		: byCustomization
			? location.kind === "data-json"
				? "Customization sync (usePluginSync), which replicates every plugin's data.json"
				: "Customization sync's “also sync other files in plugin folders” (usePluginEtc)"
			: null;

	return {
		installed: true,
		syncInternalFiles,
		usePluginSync,
		usePluginSyncV2,
		usePluginEtc,
		replicated: syncInternalFiles || byCustomization,
		setting,
	};
}

/* ────────────────────────────────────────────────────────────────────────────
 * The store
 * ──────────────────────────────────────────────────────────────────────────── */

export type ModkitDataListener = (data: ModkitData) => void;

/** Everything the settings tab needs to say about pairing, in one object. */
export interface PairingStatus extends SidecarRead {
	/** Vault-relative path of the record, whether or not one is there. */
	path: string;
	/** The key modkit verifies against came from the record rather than from a paste. */
	pinnedByPairing: boolean;
	/** The record's `baseUrl` filled in a setting nobody had chosen. */
	baseUrlSeeded: boolean;
	/**
	 * Set when something typed in the settings tab is being overridden by the record — currently
	 * only the pinned key. Shown rather than silently applied: a setting that reverts without saying
	 * so is the worst bug shape there is (see this file's header, point 2).
	 */
	conflict: string | null;
}

/**
 * modkit's settings, and a read-only view of the ledger.
 *
 * Every mutation is `read disk → apply → write`, run inside a {@link DataFile} transaction that the
 * ledger's store shares. That is deliberately more work than stamping an in-memory object over the
 * file: the copy in memory is a snapshot of what *this* device last saw, and the file may since
 * have grown a mod that another device made or that `ModStore` wrote a millisecond ago.
 *
 * **This store writes the `settings` key and nothing else** (plus `mods`, and only through
 * {@link updateMods}). Everything else in the file — the ledger, foreign keys from a newer modkit,
 * the entries `ModStore` keeps because it could not read them — is copied through verbatim from the
 * read that opened the transaction.
 */
export class SettingsStore {
	private current: ModkitData = { protocol: MODKIT_PROTOCOL_VERSION, settings: { ...DEFAULT_SETTINGS }, mods: [] };
	private foreign: string | null = null;
	private loaded = false;
	private readonly listeners = new Set<ModkitDataListener>();
	/** The one owner of `data.json`, shared with `ModStore` when both were built over one host. */
	private readonly file: DataFile;
	/** `null` when the host is not a real plugin: the token then falls back into `data.json`. */
	private readonly tokenFile: TokenFile | null;
	private readonly vault: VaultAccess | null;
	private liveSync: LiveSyncExposure | null = null;
	private pairingState: PairingStatus;
	private readonly detach: () => void;

	constructor(store: DataStore) {
		// The store is not kept: every read and write goes through `file`, which owns it. Holding a
		// second reference would be a second door onto the file, which is the bug this class just lost.
		this.file = sharedDataFile(store);
		this.vault = vaultOf(store);
		this.tokenFile = this.vault === null ? null : tokenFileAt(this.vault);
		this.pairingState = {
			...(this.tokenFile === null
				? unpaired("absent", "modkit has no vault adapter here, so there is no sidecar file to read.")
				: unpaired("absent", `Not read yet — ${this.tokenFile.path} is checked on load.`)),
			path: this.tokenLocation.path,
			pinnedByPairing: false,
			baseUrlSeeded: false,
			conflict: null,
		};
		// Another store's write is this store's news: re-adopt from the object it wrote rather than
		// waiting for someone to call `reload()`. This is what makes the settings tab notice a mod
		// that the installer just recorded.
		this.detach = this.file.register(this, (raw) => {
			this.adopt(parseData(raw), { keepToken: true });
			this.emit();
		});
	}

	/**
	 * Let go of the shared file.
	 *
	 * Nothing outlives the plugin without it — the `DataFile` is reached through a `WeakMap` keyed on
	 * the plugin itself — but registering a callback on a long-lived object is an acquisition, and
	 * modkit's own rule is that an acquisition has a matching release. `this.register(() =>
	 * store.dispose())` in `onload` is where this belongs.
	 */
	dispose(): void {
		this.detach();
		this.listeners.clear();
	}

	get data(): ModkitData {
		return this.current;
	}

	get settings(): ModkitSettings {
		return this.current.settings;
	}

	get mods(): readonly ModRecord[] {
		return this.current.mods;
	}

	/** Set when `data.json` declares a protocol this build does not speak. Surfaced, never fixed up. */
	get foreignProtocol(): string | null {
		return this.foreign;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	/** Read `data.json` once at `onload`. Safe to call again; it simply re-reads. */
	async load(): Promise<ModkitData> {
		return this.reload();
	}

	/**
	 * Re-read from disk and notify. This is what `Plugin.onExternalSettingsChange()` calls: LiveSync
	 * has just rewritten the file, and anything holding a cached ledger is now wrong.
	 *
	 * It runs inside a transaction rather than as a bare read because it can *write*: a `data.json`
	 * that still carries a `daemonToken` from before the sidecar existed is migrated here, once.
	 */
	async reload(): Promise<ModkitData> {
		return this.file.transact(this, async (io) => {
			const raw = asRecord(await this.readRaw(io));
			const parsed = parseData(raw);
			const legacyToken = parsed.data.settings.daemonToken;

			if (this.tokenFile === null) {
				// No vault adapter: the token stays in the settings blob, and `tokenLocation` says so
				// out loud so the settings tab can too.
				this.adopt(parsed, { keepToken: false });
			} else {
				const read = await this.tokenFile.read();
				// The precedence rule lives in `applyPairing`, not here. See its doc comment.
				const applied = applyPairing(parsed.data.settings, read.record);
				parsed.data.settings = applied.settings;
				this.pairingState = {
					...read,
					path: this.tokenFile.path,
					pinnedByPairing: applied.pinnedByPairing,
					baseUrlSeeded: applied.baseUrlSeeded,
					conflict: null,
				};
				this.adopt(parsed, { keepToken: false });

				// The token is never written to `data.json`, so it alone is not a reason to save. The
				// pinned key and the base URL are stored there, so adopting either one is.
				const storedFields = applied.overrode.filter((key) => key !== "daemonToken");
				if (legacyToken !== "" || storedFields.length > 0) {
					// A credential sitting in the file LiveSync's Customization sync replicates. Move it,
					// then take it out of the blob — in that order, so a failed write never loses it.
					if (legacyToken !== "" && read.record === null) {
						await this.tokenFile.writeToken(legacyToken);
						await this.rereadPairing();
					}
					const next: Record<string, unknown> = withoutStoredToken(raw);
					if (storedFields.length > 0) next["settings"] = withoutToken(parsed.data.settings);
					await io.write(next);
					if (legacyToken !== "") {
						console.warn(`modkit: moved the daemon token out of data.json and into ${this.tokenFile.path}`);
					}
					if (storedFields.length > 0) {
						this.debug("adopted from the sidecar", { fields: storedFields, path: this.tokenFile.path });
					}
				}
			}

			if (parsed.droppedMods > 0) {
				console.warn(`modkit: ignored ${parsed.droppedMods} record(s) in data.json with no modId`);
			}
			this.emit();
			return this.current;
		});
	}

	/** Patch settings. Returns the settings as they ended up after normalisation. */
	async update(patch: Partial<ModkitSettings>): Promise<ModkitSettings> {
		// An explicit `undefined` in the patch means "no opinion", not "reset to the default" —
		// spreading it through would silently revert a field the caller never mentioned.
		const defined: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(patch)) {
			if (value !== undefined) defined[key] = value;
		}
		await this.mutate("settings", (data) => {
			data.settings = normalizeSettings({ ...data.settings, ...defined });
		});

		// Re-assert the sidecar's authority over the pinned key **now**, in the same call the
		// user made, rather than at the next launch. The rule (`applyPairing`) is that the record
		// wins; applying it only on `reload()` would let a typed key sit in the tab looking accepted
		// until Obsidian restarts and quietly put it back. Reverting immediately, with a sentence
		// saying why, is the honest shape.
		const pinned = this.pairingState.record?.pinnedPublicKey ?? null;
		if (pinned !== null && this.current.settings.daemonPubkey !== pinned) {
			const note = `${this.pairingState.path} pins ${shortPubkey(pinned)}, so modkit kept that key. Delete that file, or run \`npm run setup\` against the daemon you mean, to change it.`;
			this.pairingState = { ...this.pairingState, conflict: note };
			console.warn(`modkit: ${note}`);
			await this.mutate("settings", (data) => {
				data.settings.daemonPubkey = pinned;
			});
		} else if (this.pairingState.conflict !== null) {
			this.pairingState = { ...this.pairingState, conflict: null };
		}
		return this.current.settings;
	}

	/**
	 * Replace the ledger through a function of its current, freshly-read contents.
	 *
	 * A function rather than an array because the array the caller is holding is a snapshot: by the
	 * time the write runs, disk may carry a mod that arrived by sync, and `mods.concat(newMod)`
	 * computed against the stale snapshot would delete it.
	 *
	 * `ModStore` is the ledger's real writer and nothing in modkit calls this; it stays because it is
	 * public API and because a `mods` write from here is now safe — it goes through the same
	 * transaction and leaves `settings` alone.
	 */
	async updateMods(fn: (mods: ModRecord[]) => ModRecord[]): Promise<readonly ModRecord[]> {
		await this.mutate("mods", (data) => {
			data.mods = fn(data.mods);
		});
		return this.current.mods;
	}

	/** Convenience over {@link updateMods} for the common single-record edit. */
	async updateMod(modId: string, fn: (mod: ModRecord) => ModRecord): Promise<readonly ModRecord[]> {
		return this.updateMods((mods) => mods.map((mod) => (mod.modId === modId ? fn(mod) : mod)));
	}

	getMod(modId: string): ModRecord | null {
		return this.current.mods.find((mod) => mod.modId === modId) ?? null;
	}

	/** Subscribe to every change, local or external. Returns the unsubscribe. */
	subscribe(listener: ModkitDataListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** `console.debug` gated on the setting. Arguments are the caller's problem; the token is never here. */
	debug(...args: unknown[]): void {
		if (this.current.settings.debugLogging) console.debug("modkit:", ...args);
	}

	/* ── The token's whereabouts ────────────────────────────────────────────── */

	/** Which file holds the bearer token right now, and what it is called. */
	get tokenLocation(): TokenLocation {
		if (this.tokenFile !== null) return { kind: "sidecar", path: this.tokenFile.path };
		return { kind: "data-json", path: `${this.vault?.pluginDir ?? "<plugin folder>"}/data.json` };
	}

	/**
	 * Pairing as of the last read: paired or not, why not, and what the record decided.
	 *
	 * Always answers — an absent record is a state with a sentence, not a `null` the settings tab
	 * has to invent wording for.
	 */
	get pairing(): PairingStatus {
		return this.pairingState;
	}

	/** Re-read the record without touching `data.json`. Keeps the flags the last fold worked out. */
	private async rereadPairing(): Promise<void> {
		if (this.tokenFile === null) return;
		const read = await this.tokenFile.read();
		this.pairingState = {
			...read,
			path: this.tokenFile.path,
			pinnedByPairing: read.record?.pinnedPublicKey != null,
			baseUrlSeeded: this.pairingState.baseUrlSeeded,
			conflict: this.pairingState.conflict,
		};
	}

	/** The last {@link probeLiveSync} answer, or `null` if nobody has asked yet. */
	get liveSyncExposure(): LiveSyncExposure | null {
		return this.liveSync;
	}

	/**
	 * Read LiveSync's own settings and work out whether they replicate the token's file.
	 *
	 * A read of another plugin's `data.json` through the public vault adapter, which is exactly what
	 * a user would do by hand. Cached on the store so the settings tab can render synchronously after
	 * one probe; `null` when there is no adapter to read with.
	 */
	async probeLiveSync(): Promise<LiveSyncExposure | null> {
		if (this.vault === null || this.vault.configDir === null) return null;
		const path = `${this.vault.configDir}/plugins/obsidian-livesync/data.json`;
		let raw: unknown = null;
		try {
			if (await this.vault.adapter.exists(path)) raw = JSON.parse(await this.vault.adapter.read(path));
		} catch (err) {
			// Not installed, or unreadable. Either way the honest answer is "modkit does not know",
			// which `installed: false` says — it must not read as "and therefore you are safe".
			console.debug("modkit: could not read LiveSync's settings", err);
			raw = null;
		}
		this.liveSync = judgeLiveSync(raw, this.tokenLocation);
		return this.liveSync;
	}

	/* ── Internals ──────────────────────────────────────────────────────────── */

	private async readRaw(io: DataFileIo): Promise<unknown> {
		try {
			return await io.read();
		} catch (err) {
			// A `data.json` that cannot be read is not a reason to start writing over it: report and
			// carry on with defaults, so the next save merges against whatever it eventually reads.
			console.error("modkit: could not read data.json", err);
			return null;
		}
	}

	/**
	 * One read-modify-write, touching exactly one key of the file.
	 *
	 * `touch` is the whole point. The file is shared with the ledger's store, so a settings save
	 * copies `mods` through byte-for-byte from the read that opened this transaction — including the
	 * entries `ModStore` preserves precisely because it could not parse them.
	 */
	private mutate(touch: "settings" | "mods", apply: (data: ModkitData) => void): Promise<void> {
		return this.file.transact(this, async (io) => {
			const raw = asRecord(await this.readRaw(io));
			const parsed = parseData(raw);
			// Disk is authoritative for every setting except the token, which is not on disk here.
			parsed.data.settings.daemonToken = this.current.settings.daemonToken;
			const before = parsed.data.settings.daemonToken;

			apply(parsed.data);

			const next: Record<string, unknown> = { ...raw, protocol: MODKIT_PROTOCOL_VERSION };
			if (touch === "settings") {
				next["settings"] = this.tokenFile === null ? parsed.data.settings : withoutToken(parsed.data.settings);
			} else {
				next["mods"] = parsed.data.mods;
			}
			await io.write(next);

			const after = parsed.data.settings.daemonToken;
			if (this.tokenFile !== null && after !== before) {
				// Clearing the token deletes the sidecar, pinned key and all — that is what `npm run
				// reset` means, and leaving a key behind that nothing can authenticate against would
				// be a half-state nobody asked for.
				if (after === "") await this.tokenFile.clear();
				else await this.tokenFile.writeToken(after);
				await this.rereadPairing();
			}

			this.adopt(parsed, { keepToken: false });
			this.emit();
		});
	}

	/**
	 * Take a parse as the current state. `keepToken` is for the adoption path: another store's write
	 * carries no token (it was never in the blob), so the one in memory is the live one.
	 */
	private adopt(parsed: ParsedData, options: { keepToken: boolean }): void {
		const token = options.keepToken ? this.current.settings.daemonToken : parsed.data.settings.daemonToken;
		parsed.data.settings.daemonToken = token;
		this.current = parsed.data;
		this.foreign = parsed.foreignProtocol;
		this.loaded = true;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener(this.current);
			} catch (err) {
				console.error("modkit: a settings listener threw", err);
			}
		}
	}
}

function asRecord(raw: unknown): Record<string, unknown> {
	return isRecord(raw) ? raw : {};
}

/** The settings as they go to disk: everything except the credential. */
function withoutToken(settings: ModkitSettings): Record<string, unknown> {
	const { daemonToken: _token, ...rest } = settings;
	return rest;
}

/** The file with any legacy `settings.daemonToken` removed, and everything else untouched. */
function withoutStoredToken(raw: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...raw };
	if (isRecord(next["settings"])) {
		const { daemonToken: _token, ...rest } = next["settings"];
		next["settings"] = rest;
	}
	// A pre-nesting layout put the settings at the top level; strip it there too, or the migration
	// would leave the credential exactly where `normalizeSettings`'s `flat` fallback finds it.
	if ("daemonToken" in next) delete next["daemonToken"];
	return next;
}
