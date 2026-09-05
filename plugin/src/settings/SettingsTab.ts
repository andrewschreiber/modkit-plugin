/**
 * modkit's settings tab: the daemon connection, and the mod list.
 *
 * The mod list is the reason this file is large. Obsidian's own community-plugin list already shows
 * every installed plugin and lets you toggle it, and a generated mod *is* an installed plugin — so
 * duplicating that would be pointless. What that list structurally cannot show is **intent**: the
 * sentence the user typed, what it was aimed at, which version of the target it was generated
 * against versus what is installed today, how it reaches in, and whether it is actually doing
 * anything. A mod whose target moved is indistinguishable, in Obsidian's list, from one that works.
 * That gap is what this tab exists to close.
 *
 * `display()` — deprecated in the 1.13 typings in favour of `getSettingDefinitions()` — is the live
 * path here: the user runs Obsidian 1.12.7, where the declarative API does not exist. It is also
 * the right path regardless, because the health badges and the grouped mod cards are custom
 * rendering that the declarative form would only reach through its `render` escape hatch.
 *
 * Everything visual is expressed in Obsidian's own CSS variables, injected as one `<style>` element
 * inside `containerEl`. `containerEl` is emptied on every `display()` and on `hide()`, so the styles
 * are scoped and reclaimed with the DOM that uses them, and this file never has to own `styles.css`.
 */

import { Modal, Notice, PluginSettingTab, Setting, apiVersion, normalizePath, requestUrl } from "obsidian";
import type { App, Plugin } from "obsidian";

import { MODKIT_PROTOCOL_VERSION, MOD_HEALTH_SEVERITY, REACH_PLANE_LABELS, targetKey, targetVersion } from "@modkit/types";
import type { HealthResponse, ModHealthState, ModRecord, ModelCheckResponse, ReachTarget, TargetRef } from "@modkit/types";

import {
	DEFAULT_DAEMON_BASE_URL,
	MAX_MODEL_NAME,
	MAX_REQUEST_TIMEOUT_MS,
	MIN_REQUEST_TIMEOUT_MS,
	describeUrlProblem,
	describeUrlWarning,
	enablePolicy,
	isValidPubkey,
	normalizeBaseUrl,
	normalizePubkey,
	settingsBlockers,
	shortPubkey,
} from "./settings";
import type { ModkitSettings, SettingsStore } from "./settings";

/* ────────────────────────────────────────────────────────────────────────────
 * Ports — what this tab needs from the rest of the plugin
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four things a user can do to an installed mod. Implemented by whatever owns installation,
 * because each one has to touch more than the ledger: enabling calls
 * `app.plugins.enablePlugin`, uninstalling removes the plugin folder, regenerating starts a job.
 *
 * Every method resolves when the action is *done* and rejects with a message worth showing. A
 * resolved promise that did nothing is the one outcome this tab cannot render honestly.
 */
export interface ModActions {
	/** Enable or disable the generated plugin, and persist modkit's intent in the ledger. */
	setEnabled(modId: string, enabled: boolean): Promise<void>;
	/** Regenerate from the stored request against the target's *current* version. */
	regenerate(modId: string): Promise<void>;
	/** Delete the plugin folder and drop the ledger entry. */
	uninstall(modId: string): Promise<void>;
	/**
	 * The generated `main.js`. Optional: when absent this tab reads it straight off the vault
	 * adapter, which is public API and needs nobody's cooperation.
	 */
	readSource?(modId: string): Promise<string>;
	/** Re-check every mod's health now. Optional; the refresh button falls back to a re-render. */
	refreshHealth?(): Promise<void>;
}

/** How the daemon connection is tested. Injectable so a real client can replace the built-in probe. */
export interface DaemonHealthProbe {
	probe(settings: ModkitSettings): Promise<DaemonProbeOutcome>;
}

export interface ModkitSettingsTabDeps {
	store: SettingsStore;
	mods: ModActions;
	/** Defaults to {@link probeDaemonHealth}. */
	daemon?: DaemonHealthProbe;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The daemon probe
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How the key the daemon presented relates to the key pinned here.
 *
 * `mismatch` is not a warning. Everything modkit installs is code that runs with the vault's file
 * access, and the pinned key is the only thing that distinguishes "the daemon I started" from
 * "whatever is answering on that port". So the tab reports it as a security event.
 */
export type DaemonKeyState = "match" | "mismatch" | "unpinned" | "daemon-unkeyed";

export type DaemonProbeOutcome =
	| { kind: "unreachable"; url: string; detail: string }
	| { kind: "http-error"; url: string; status: number; detail: string }
	| { kind: "malformed"; url: string; detail: string }
	| {
			kind: "ok";
			url: string;
			health: HealthResponse;
			protocolMatches: boolean;
			keyState: DaemonKeyState;
			/** The key the daemon presented, normalised. Empty when it presented none. */
			presentedKey: string;
	  };

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * `requestUrl` has no timeout of its own (`RequestUrlParam` — url, method, contentType, body,
 * headers, throw). A hung daemon would otherwise leave the Test-connection button spinning
 * forever, which reads as "modkit is broken" rather than "the daemon did not answer".
 *
 * The losing request is not cancelled — there is no handle to cancel it with — it is merely no
 * longer awaited. That is acceptable for a health GET and would not be for anything that writes.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, subject: string): Promise<T> {
	let timer = 0;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				// `subject` reads as the sentence's subject on its own ("Nothing answered within 8s"),
				// not as a pronoun standing in for whatever the caller had in mind — a message this
				// generic has no guaranteed antecedent for a bare "It" to point back to.
				timer = window.setTimeout(() => reject(new Error(`${subject} answered within ${Math.round(ms / 1000)}s`)), ms);
			}),
		]);
	} finally {
		// There is no `registerTimeout` in the Component contract and a settings tab is not a
		// Component; clearing in `finally` is the equivalent guarantee for a one-shot.
		if (timer !== 0) window.clearTimeout(timer);
	}
}

/**
 * `GET /v1/health` — the one unauthenticated route — and a concrete verdict about what answered.
 *
 * Never throws: every failure is a variant of {@link DaemonProbeOutcome}, because "the probe itself
 * blew up" is not something a user can act on.
 */
export async function probeDaemonHealth(settings: ModkitSettings): Promise<DaemonProbeOutcome> {
	const base = normalizeBaseUrl(settings.daemonBaseUrl);
	const problem = describeUrlProblem(base);
	if (problem) return { kind: "unreachable", url: base, detail: problem };

	const url = `${base}/v1/health`;
	const headers: Record<string, string> = { Accept: "application/json" };
	// `/v1/health` is unauthenticated, but the token is sent anyway: a daemon that *does* demand
	// auth here should answer 401, which is a diagnosis, rather than looking like a dead socket.
	if (settings.daemonToken !== "") headers["Authorization"] = `Bearer ${settings.daemonToken}`;

	let status: number;
	let text: string;
	try {
		// `throw: false` — the default is to throw on 4xx/5xx, which turns a daemon's own error
		// response into an exception with no body, exactly when the body is the diagnosis.
		const response = await withTimeout(
			Promise.resolve(requestUrl({ url, method: "GET", headers, throw: false })),
			settings.requestTimeoutMs,
			"Nothing",
		);
		status = response.status;
		text = response.text ?? "";
	} catch (err) {
		return { kind: "unreachable", url, detail: errorMessage(err) };
	}

	if (status !== 200) {
		return { kind: "http-error", url, status, detail: text.slice(0, 400) };
	}

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { kind: "malformed", url, detail: `answered 200 with something that is not JSON: ${text.slice(0, 120)}` };
	}
	if (typeof body !== "object" || body === null) {
		return { kind: "malformed", url, detail: "answered 200 with a JSON value that is not an object" };
	}

	const health = body as Partial<HealthResponse>;
	if (health.service !== "modkit") {
		return { kind: "malformed", url, detail: `something is listening there, but it identifies itself as “${String(health.service ?? "(nothing)")}” rather than modkit` };
	}

	const presentedKey = normalizePubkey(typeof health.pubkey === "string" ? health.pubkey : "");
	const pinned = normalizePubkey(settings.daemonPubkey);
	let keyState: DaemonKeyState;
	if (!isValidPubkey(presentedKey)) keyState = "daemon-unkeyed";
	else if (pinned === "") keyState = "unpinned";
	else keyState = pinned === presentedKey ? "match" : "mismatch";

	return {
		kind: "ok",
		url,
		health: health as HealthResponse,
		protocolMatches: health.protocol === MODKIT_PROTOCOL_VERSION,
		keyState,
		presentedKey,
	};
}

/**
 * `GET /v1/model-check` — can the daemon actually reach a model right now?
 *
 * Authenticated, unlike the health probe, because the answer names absolute paths on the daemon's
 * machine. Never throws, for the same reason {@link probeDaemonHealth} does not: "the check itself
 * blew up" is not something a user can act on.
 */
export async function probeModelAccess(
	settings: ModkitSettings,
	options: { deep?: boolean } = {},
): Promise<{ ok: true; value: ModelCheckResponse } | { ok: false; detail: string }> {
	const base = normalizeBaseUrl(settings.daemonBaseUrl);
	const problem = describeUrlProblem(base);
	if (problem) return { ok: false, detail: problem };
	if (settings.daemonToken === "") return { ok: false, detail: "no auth token is stored for this daemon" };

	const url = `${base}/v1/model-check${options.deep ? "?deep=1" : ""}`;
	try {
		const response = await withTimeout(
			fetch(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${settings.daemonToken}` },
			}),
			settings.requestTimeoutMs,
			`The daemon at ${base}`,
		);
		const text = await response.text();
		if (!response.ok) return { ok: false, detail: `the daemon answered ${response.status}: ${text.slice(0, 200)}` };
		const body: unknown = JSON.parse(text);
		if (typeof body !== "object" || body === null) return { ok: false, detail: "the response was not an object" };
		return { ok: true, value: body as ModelCheckResponse };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

const DEFAULT_PROBE: DaemonHealthProbe = { probe: probeDaemonHealth };

/* ────────────────────────────────────────────────────────────────────────────
 * Presentation helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The badge on a card. The state slug is the machine value; this is what a person reads, so it says
 * what is happening rather than naming the state — "doing nothing" beats "no-effect".
 */
const HEALTH_LABEL: Record<ModHealthState, string> = {
	applied: "applied",
	"no-effect": "doing nothing",
	"target-moved": "target moved",
	"target-gone": "target gone",
	error: "errored",
};

/**
 * One sentence per state, so the colour is never the only carrier of meaning — colour-blind users
 * and a grey screenshot both have to work.
 */
const HEALTH_MEANING: Record<ModHealthState, string> = {
	applied: "In place, in range, and it has run.",
	"no-effect": "In place, but nothing has called it — the mod may be aimed at a path this vault never takes.",
	"target-moved": "The target is still here, but it has changed underneath this mod, so the mod no longer bites.",
	"target-gone": "The target plugin is not installed, not switched on, or no longer has the part this mod holds on to.",
	error: "This mod threw, either while loading or while running a call it wraps.",
};

function healthClass(state: ModHealthState): string {
	return `modkit-pill modkit-pill-${state}`;
}

function formatWhen(iso: string | undefined): string {
	if (!iso) return "unknown";
	const then = new Date(iso);
	const ms = then.getTime();
	if (!Number.isFinite(ms) || ms === 0) return "unknown";
	const delta = Date.now() - ms;
	const abs = Math.abs(delta);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	let relative: string;
	if (abs < minute) relative = "just now";
	else if (abs < hour) relative = `${Math.round(abs / minute)}m`;
	else if (abs < day) relative = `${Math.round(abs / hour)}h`;
	else relative = `${Math.round(abs / day)}d`;
	const suffix = abs < minute ? "" : delta >= 0 ? " ago" : " from now";
	return `${then.toLocaleString()} (${relative}${suffix})`;
}

/**
 * The reach planes in the words a person would use — the same table `ComposeModal` and
 * `ReviewModal` each carry, kept as a third copy here rather than a shared import so this file
 * does not gain a cross-module dependency for five lines of prose. If a fourth surface ever needs
 * it, promote it into `@modkit/types` instead of copying it a fourth time.
 */
const PLANE_PROSE: Record<ReachTarget["plane"], string> = {
	A: "a built-in Obsidian class",
	B: "one live object inside Obsidian",
	C: "the plugin's own class",
	D: "the command itself",
	E: "the element on screen and its styling",
};

function describeReach(reach: ReachTarget): string {
	const label = (PLANE_PROSE as Record<string, string | undefined>)[reach.plane] ?? REACH_PLANE_LABELS[reach.plane];
	switch (reach.plane) {
		case "A":
			return `${label} — ${reach.exportName}.${reach.holder === "static" ? "" : "prototype."}${reach.member}`;
		case "B":
			return `${label} — app.${reach.path}.${reach.member}`;
		case "C":
			return `${label} — ${reach.pluginId}${reach.via ? `.${reach.via}` : ""}.${reach.holder === "prototype" ? "constructor.prototype." : ""}${reach.member}`;
		case "D":
			return `${label} — ${reach.commandId} (${reach.property})`;
		case "E":
			return `${label} — ${reach.mode}: ${reach.selector}`;
	}
}

function describeTarget(target: TargetRef): string {
	if (target.kind === "plugin") return target.pluginName ?? target.pluginId;
	return target.internalPluginId ? `Obsidian core — ${target.internalPluginId}` : "Obsidian core";
}

/**
 * The line under a target's name: how many mods are on it, and what is wrong with any of them.
 *
 * "3 mods · 1 doing nothing" rather than a bare "3 mods" — the count on its own answers a question
 * nobody asked, and the thing a person is scanning this list for is which group has a problem in
 * it. Anything that is not `applied` gets named, in the same words as its badge, so the summary and
 * the card underneath cannot disagree. The healthy case stays short: just the count.
 */
export function groupSummary(records: readonly ModRecord[], installedVersion: string | null): string {
	const parts: string[] = [installedVersion === null ? "not installed" : `installed ${installedVersion}`];
	parts.push(`${records.length} mod${records.length === 1 ? "" : "s"}`);

	// Insertion-ordered, and the records arrive worst-first, so the most serious problem is named
	// first here too.
	const trouble = new Map<ModHealthState, number>();
	let off = 0;
	for (const record of records) {
		// A switched-off mod's last verdict is not trouble — it is a mod that is not running. Count it
		// as "off", in the same word its card uses, so the header and the cards cannot disagree.
		if (!record.enabled) {
			off += 1;
			continue;
		}
		if (record.health.state === "applied") continue;
		trouble.set(record.health.state, (trouble.get(record.health.state) ?? 0) + 1);
	}
	for (const [state, count] of trouble) parts.push(`${count} ${HEALTH_LABEL[state]}`);
	if (off > 0) parts.push(`${off} off`);

	return parts.join(" · ");
}

/** Worst health first, then most recently touched. The top of the list is what needs attention. */
function compareMods(a: ModRecord, b: ModRecord): number {
	const severity = (MOD_HEALTH_SEVERITY[a.health.state] ?? 9) - (MOD_HEALTH_SEVERITY[b.health.state] ?? 9);
	if (severity !== 0) return severity;
	return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Commit a text field on blur and on Enter rather than on every keystroke.
 *
 * `onChange` would fire per character, and each one is a read-modify-write of `data.json` — a file
 * LiveSync is watching. Committing on blur also means normalisation (`http://` prefixing, trailing
 * slashes, hex tidying) happens once, on a finished value, instead of fighting the user mid-word.
 *
 * These listeners are not routed through `registerDomEvent` because a `PluginSettingTab` is not a
 * `Component` and has none; they are attached to nodes inside `containerEl`, which Obsidian empties
 * on `hide()` and on every `display()`, so they are reclaimed with the elements themselves.
 */
function commitOn(input: HTMLInputElement, commit: (value: string) => void): void {
	input.addEventListener("blur", () => commit(input.value));
	input.addEventListener("keydown", (evt: KeyboardEvent) => {
		if (evt.key === "Enter") {
			evt.preventDefault();
			commit(input.value);
			input.blur();
		}
	});
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tab
 * ──────────────────────────────────────────────────────────────────────────── */

export class ModkitSettingsTab extends PluginSettingTab {
	private readonly deps: ModkitSettingsTabDeps;
	private readonly probe: DaemonHealthProbe;
	private unsubscribe: (() => void) | null = null;
	private lastProbe: DaemonProbeOutcome | null = null;
	private probing = false;
	private probeEl: HTMLElement | null = null;
	/**
	 * Is this tab on screen right now? `display()` subscribes to the store and `hide()` unsubscribes,
	 * so a late async callback that calls `refresh()` after `hide()` would re-subscribe with nothing
	 * left to undo it — and paint into a container Obsidian has already emptied. Every deferred
	 * re-render checks this first.
	 */
	private visible = false;
	/** Cheap fingerprint of the ledger, so an external sync re-renders but our own saves do not. */
	private renderedSignature = "";
	/**
	 * Whether the reader has touched the Connection fold since this tab last opened. `null` means
	 * they have not, so {@link connectionStatus}'s computed default still decides — a broken
	 * connection opens itself, a working one stays quiet. Once set, it overrides that default:
	 * pressing "Test connection" inside an open fold must not have the result it just asked for
	 * close underneath it the moment the answer comes back healthy.
	 */
	private connectionDetailsOpen: boolean | null = null;

	constructor(app: App, plugin: Plugin, deps: ModkitSettingsTabDeps) {
		super(app, plugin);
		this.deps = deps;
		this.probe = deps.daemon ?? DEFAULT_PROBE;
	}

	private get settings(): ModkitSettings {
		return this.deps.store.settings;
	}

	override display(): void {
		const { containerEl } = this;
		this.visible = true;
		containerEl.empty();
		containerEl.addClass("modkit-settings");
		containerEl.createEl("style", { text: MODKIT_SETTINGS_CSS });

		this.renderedSignature = this.modsSignature();
		this.watchStore();

		this.renderTokenExposure(containerEl);
		this.renderBlockers(containerEl);
		// The mods come first: someone opening this tab is almost always here for a mod they just
		// made, not for the connection fields — those are what setup wrote and what "Test connection"
		// checks, and they read as the boring end of the page, which is where they belong.
		this.renderModList(containerEl);
		this.renderInstallSection(containerEl);
		this.renderModelSection(containerEl);
		this.renderDaemonSection(containerEl);
		this.renderAdvancedSection(containerEl);

		// A status line that reads "Not tested yet" over a connection that just generated a mod is
		// a lie of omission (measured 2026-09-03, first look at the redesigned tab). Ask once, quietly,
		// the first time the tab is shown; the answer re-renders the line and folds the details away
		// when it is healthy. The reader's own open/close choice is untouched (`keepOpen: false`).
		if (this.lastProbe === null && !this.probing) void this.runProbe({ keepOpen: false });

		// Asking LiveSync what it replicates needs a file read, and `display()` is synchronous. One
		// probe per store: the answer is cached, so the re-render below cannot loop.
		if (this.deps.store.liveSyncExposure === null) {
			void this.deps.store.probeLiveSync().then(
				(exposure) => {
					// The user can close Settings while the read is in flight; see `visible`.
					if (exposure !== null && this.visible) this.refresh();
				},
				() => undefined,
			);
		}
	}

	override hide(): void {
		this.visible = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.probeEl = null;
		this.connectionDetailsOpen = null;
		super.hide();
	}

	/** Re-render in place. Used after any action that changes what is on screen. */
	private refresh(): void {
		this.display();
	}

	private modsSignature(): string {
		return this.deps.store.mods
			.map((mod) => `${mod.modId}|${mod.enabled ? 1 : 0}|${mod.health.state}|${mod.updatedAt}`)
			.join("\n");
	}

	/**
	 * Re-render when the ledger changes underneath the open tab — which happens for real, because
	 * LiveSync rewrites `data.json` and `onExternalSettingsChange` reloads the store.
	 *
	 * Gated on the mods signature rather than on any change: a settings save would otherwise rebuild
	 * the DOM under the field the user is still editing.
	 */
	private watchStore(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.deps.store.subscribe(() => {
			if (this.modsSignature() !== this.renderedSignature) this.refresh();
		});
	}

	private async patch(patch: Partial<ModkitSettings>): Promise<void> {
		try {
			await this.deps.store.update(patch);
		} catch (err) {
			new Notice(`modkit could not save your settings — ${errorMessage(err)}`, 0);
		}
	}

	/* ── The token's exposure ─────────────────────────────────────────────── */

	/**
	 * Whether the bearer token is about to leave this machine, at the top of the tab where a
	 * credential warning belongs.
	 *
	 * modkit keeps the token in a sidecar file precisely so LiveSync's Customization sync — which
	 * replicates every plugin's `data.json` — cannot carry it. Hidden-file sync is the case that
	 * defeats that, and it is a single switch in another plugin's settings with no notification here.
	 * So this reads LiveSync's own settings and says the specific thing: which credential, which
	 * file, which switch.
	 */
	private renderTokenExposure(root: HTMLElement): void {
		const store = this.deps.store;
		const exposure = store.liveSyncExposure;
		const location = store.tokenLocation;
		if (exposure === null || !exposure.replicated) return;
		if (store.settings.daemonToken === "") return; // nothing at risk yet

		const box = root.createDiv({ cls: "modkit-callout modkit-callout-danger" });
		box.createDiv({ cls: "modkit-callout-title", text: "Your auth token is leaving this machine" });
		box.createDiv({
			text: `LiveSync has ${exposure.setting ?? "replication"} switched on, which replicates ${location.path} — the file holding modkit's auth token — to every device on this vault, and to whatever server it syncs through.`,
		});
		box.createDiv({
			cls: "modkit-callout-body",
			text:
				location.kind === "sidecar"
					? "modkit keeps the token out of data.json for exactly this reason, but hidden-file sync copies the whole config folder and does not care. Either turn that setting off, add this file to LiveSync's syncInternalFilesIgnorePatterns, or rotate the token and treat it as shared."
					: "modkit could not find a vault adapter to write its own separate file with, so the token is sitting in data.json — the file LiveSync replicates first. Rotate it and treat it as shared.",
		});
	}

	/**
	 * One line under the token field naming the file it is in and what checked it. Quiet on purpose —
	 * the loud version is {@link renderTokenExposure} — but never silent: "where is my credential"
	 * should be answerable without reading the source.
	 */
	private renderTokenStorageNote(root: HTMLElement): void {
		const store = this.deps.store;
		const location = store.tokenLocation;
		const exposure = store.liveSyncExposure;

		if (location.kind === "data-json") {
			root.createDiv({
				cls: "modkit-inline-warn",
				text: `Stored in ${location.path}. modkit normally keeps the token in its own separate file so plugin-settings sync cannot carry it, but it could not reach the vault adapter to write one here.`,
			});
			return;
		}

		const checked =
			exposure === null
				? "Checking whether anything syncs that file…"
				: !exposure.installed
					? "LiveSync is not installed here, so nothing replicates it."
					: exposure.replicated
						? "LiveSync is replicating that file — see the warning at the top of this tab."
						: "Checked LiveSync: it is not replicating that file (Customization sync copies data.json, which is why the token is not in it).";
		root.createDiv({ cls: "modkit-section-note", text: `Stored in ${location.path}, not in data.json. ${checked}` });
	}

	/* ── Blockers ─────────────────────────────────────────────────────────── */

	private renderBlockers(root: HTMLElement): void {
		const blockers = settingsBlockers(this.settings);
		if (blockers.length === 0) return;
		const box = root.createDiv({ cls: "modkit-callout modkit-callout-warn" });
		box.createDiv({ cls: "modkit-callout-title", text: "modkit cannot write a mod yet" });
		const list = box.createEl("ul");
		for (const blocker of blockers) list.createEl("li", { text: blocker });
	}

	/* ── Half 1: the daemon connection ────────────────────────────────────── */

	/**
	 * What a first-time reader needs from this section in one glance: is it connected. Everything a
	 * daemon actually is — a URL, a token, a pinned key — is real, but it is the *how*, and it used
	 * to be the first thing on the tab. Folded into "Details" so a working connection is one quiet
	 * line, and a broken one still opens the fold itself rather than making the reader guess to
	 * expand it.
	 */
	private connectionStatus(): { text: string; cls: string; open: boolean } {
		const probe = this.lastProbe;
		if (probe === null) {
			return { text: "Not tested yet.", cls: "modkit-inline-warn", open: true };
		}
		if (probe.kind === "ok") {
			if (probe.protocolMatches && probe.keyState === "match") {
				return { text: "Connected.", cls: "modkit-inline-ok", open: false };
			}
			return { text: "Connected, but something below needs attention.", cls: "modkit-inline-warn", open: true };
		}
		return { text: "Not reachable.", cls: "modkit-inline-danger", open: true };
	}

	private renderDaemonSection(root: HTMLElement): void {
		new Setting(root).setName("Connection").setHeading();
		root.createDiv({
			cls: "modkit-section-note",
			text: "Generation runs in a background process on this computer, not inside Obsidian itself. It reads the target's public source and sends back a signed mod built from your sentence and the target's version.",
		});

		const settings = this.settings;
		const status = this.connectionStatus();
		root.createDiv({ cls: status.cls, text: status.text });

		const details = root.createEl("details", { cls: "modkit-connection-details" });
		if (this.connectionDetailsOpen ?? status.open) details.setAttribute("open", "");
		details.createEl("summary", { text: "Details" });
		// Once the reader has opened or closed this themselves, their choice outlives the computed
		// default above — otherwise pressing "Test connection" from inside an open fold would have
		// its own healthy answer close the fold on the way back in.
		details.addEventListener("toggle", () => {
			this.connectionDetailsOpen = (details as HTMLDetailsElement).open;
		});

		new Setting(details)
			.setName("Address")
			.setDesc(`Origin only — modkit appends /v1/… itself. Default ${DEFAULT_DAEMON_BASE_URL}.`)
			.addText((text) => {
				text.setPlaceholder(DEFAULT_DAEMON_BASE_URL).setValue(settings.daemonBaseUrl);
				commitOn(text.inputEl, (value) => {
					const next = normalizeBaseUrl(value);
					if (next === this.settings.daemonBaseUrl) return;
					void this.patch({ daemonBaseUrl: next }).then(() => this.refresh());
				});
			});

		const urlWarning = describeUrlWarning(settings.daemonBaseUrl);
		if (urlWarning) details.createDiv({ cls: "modkit-inline-warn", text: urlWarning });

		new Setting(details)
			.setName("Auth token")
			.setDesc(
				settings.daemonToken === ""
					? "No token stored. Every route except /v1/health will answer 401. modkit writes one to .state/modkit/daemon.token on first run."
					: "A token is stored. It is never displayed again — type a new one to replace it.",
			)
			.addText((text) => {
				text.setPlaceholder(settings.daemonToken === "" ? "Paste the token" : "Stored — type to replace");
				// Deliberately never `setValue`: the stored token does not go back into the DOM, where a
				// screenshot, a shared screen, or a theme that ignores `type=password` would expose it.
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				commitOn(text.inputEl, (value) => {
					const token = value.trim();
					if (token === "") return;
					text.inputEl.value = "";
					void this.patch({ daemonToken: token }).then(() => {
						new Notice("Token saved.");
						this.refresh();
					});
				});
			})
			.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Forget the stored token")
					.setDisabled(settings.daemonToken === "")
					.onClick(() => {
						void this.patch({ daemonToken: "" }).then(() => this.refresh());
					});
			});

		this.renderTokenStorageNote(details);

		new Setting(details)
			.setName("Signing key")
			.setDesc("The Ed25519 public key modkit pins, 64 hex characters. Nothing is installed unless the signature on it verifies against exactly this key.")
			.addText((text) => {
				text.setPlaceholder("64 hex characters").setValue(settings.daemonPubkey);
				text.inputEl.addClass("modkit-key-input");
				commitOn(text.inputEl, (value) => {
					const key = normalizePubkey(value);
					if (key !== "" && !isValidPubkey(key)) {
						new Notice(`That is ${key.length} hex characters, not 64 — nothing was pinned.`, 8_000);
						return;
					}
					if (key === this.settings.daemonPubkey) return;
					void this.patch({ daemonPubkey: key }).then(() => this.refresh());
				});
			});

		details.createDiv({
			cls: "modkit-section-note",
			text:
				settings.daemonPubkey === ""
					? "Nothing pinned. Run Test connection below and pin the key it presents."
					: `Pinned: ${shortPubkey(settings.daemonPubkey)}`,
		});

		new Setting(details)
			.setName("Require a valid signature")
			.setDesc("Refuse to write any mod whose signature does not verify against the pinned key.")
			.addToggle((toggle) => {
				toggle.setValue(settings.requireSignature).onChange((value) => {
					void this.patch({ requireSignature: value }).then(() => this.refresh());
				});
			});

		if (!settings.requireSignature) {
			details.createDiv({
				cls: "modkit-inline-danger",
				text: "Signature checking is off. Whatever answers at that address can write a plugin into this vault, and it will run with your vault's full file access. Turn this back on unless you are actively developing modkit itself.",
			});
		}

		new Setting(details)
			.setName("Request timeout")
			.setDesc(`Seconds to wait for one HTTP call. This bounds a request, not a generation — generation is a background job the plugin polls. ${Math.round(MIN_REQUEST_TIMEOUT_MS / 1000)}–${Math.round(MAX_REQUEST_TIMEOUT_MS / 1000)}s.`)
			.addText((text) => {
				text.setValue(String(Math.round(settings.requestTimeoutMs / 1000)));
				text.inputEl.type = "number";
				text.inputEl.addClass("modkit-number-input");
				commitOn(text.inputEl, (value) => {
					const seconds = Number.parseFloat(value);
					if (!Number.isFinite(seconds)) {
						text.setValue(String(Math.round(this.settings.requestTimeoutMs / 1000)));
						return;
					}
					void this.patch({ requestTimeoutMs: Math.round(seconds * 1000) }).then(() => this.refresh());
				});
			});

		new Setting(details)
			.setName("Test connection")
			.setDesc("Asks /v1/health what is there, which protocol it speaks, and which key it signs with.")
			.addButton((button) => {
				button
					.setCta()
					.setButtonText(this.probing ? "Testing…" : "Test connection")
					.setDisabled(this.probing)
					.onClick(() => {
						// Disabled here rather than by re-rendering: the probe can take the full request
						// timeout, and a button that stays clickable through it collects a second probe.
						button.setButtonText("Testing…").setDisabled(true);
						void this.runProbe();
					});
			});

		this.probeEl = details.createDiv({ cls: "modkit-probe" });
		this.renderProbe();
	}

	private async runProbe(options: { keepOpen: boolean } = { keepOpen: true }): Promise<void> {
		// The button that starts a probe lives inside this fold, so the fold was necessarily open to
		// be clicked. Keep it that way through the re-render that follows, whatever the result — the
		// reader asked a question and is owed the answer in the place they asked it. The automatic
		// first probe from `display()` passes `keepOpen: false`: nobody clicked, so nothing is owed.
		if (options.keepOpen) this.connectionDetailsOpen = true;
		this.probing = true;
		if (this.probeEl) {
			this.probeEl.empty();
			this.probeEl.createDiv({ cls: "modkit-section-note", text: "Checking…" });
		}
		try {
			this.lastProbe = await this.probe.probe(this.settings);
		} catch (err) {
			// The probe contract says it never throws; if one does, say so rather than showing nothing.
			this.lastProbe = { kind: "unreachable", url: this.settings.daemonBaseUrl, detail: `the connection test itself failed: ${errorMessage(err)}` };
		} finally {
			this.probing = false;
		}
		this.refresh();
	}

	private renderProbe(): void {
		const el = this.probeEl;
		const outcome = this.lastProbe;
		if (!el || !outcome) return;
		el.empty();

		if (outcome.kind === "unreachable") {
			const box = el.createDiv({ cls: "modkit-callout modkit-callout-error" });
			box.createDiv({ cls: "modkit-callout-title", text: "Not reachable" });
			box.createDiv({ text: `${outcome.url} — ${outcome.detail}` });
			const list = box.createEl("ul");
			list.createEl("li", { text: "Is it running? `npm run setup` in the modkit repo starts it and points this plugin at it." });
			list.createEl("li", { text: "Is this the machine it runs on? Nothing was installed and nothing is at risk — the request simply did not arrive." });
			return;
		}

		if (outcome.kind === "http-error") {
			const box = el.createDiv({ cls: "modkit-callout modkit-callout-error" });
			box.createDiv({ cls: "modkit-callout-title", text: `Answered ${outcome.status}` });
			box.createDiv({
				text:
					outcome.status === 401 || outcome.status === 403
						? "It rejected the auth token. Copy the current one out of .state/modkit/daemon.token on that computer."
						: `${outcome.url} answered ${outcome.status}.`,
			});
			if (outcome.detail) box.createEl("pre", { cls: "modkit-detail", text: outcome.detail });
			return;
		}

		if (outcome.kind === "malformed") {
			const box = el.createDiv({ cls: "modkit-callout modkit-callout-error" });
			box.createDiv({ cls: "modkit-callout-title", text: "That is not modkit" });
			box.createDiv({ text: `${outcome.url} ${outcome.detail}` });
			return;
		}

		const { health } = outcome;
		const box = el.createDiv({ cls: "modkit-callout modkit-callout-ok" });
		box.createDiv({ cls: "modkit-callout-title", text: "Reachable" });
		const facts = box.createDiv({ cls: "modkit-meta" });
		this.addFact(facts, "Version", `${health.version ?? "unknown version"} at ${outcome.url}`);
		this.addFact(facts, "Model", health.model ?? "unreported");
		if (typeof health.uptimeMs === "number") {
			this.addFact(facts, "Up", `${Math.max(1, Math.round(health.uptimeMs / 60_000))} min`);
		}

		if (outcome.protocolMatches) {
			this.addFact(facts, "Protocol", `${MODKIT_PROTOCOL_VERSION} — matches`);
		} else {
			const warn = el.createDiv({ cls: "modkit-callout modkit-callout-warn" });
			warn.createDiv({ cls: "modkit-callout-title", text: "Protocol mismatch" });
			warn.createDiv({
				text: `This plugin speaks ${MODKIT_PROTOCOL_VERSION}; it speaks ${String(health.protocol ?? "(nothing)")}. Both sides refuse to guess across a version gap, so generation will fail until one of them is rebuilt.`,
			});
		}

		this.renderKeyVerdict(el, outcome);
	}

	private addFact(grid: HTMLElement, label: string, value: string): void {
		grid.createDiv({ cls: "modkit-meta-key", text: label });
		grid.createDiv({ cls: "modkit-meta-value", text: value });
	}

	/**
	 * The key verdict, and the one place in this tab that is allowed to shout.
	 *
	 * A mismatch is reported as a security event because that is what it is: the pinned key is the
	 * only thing standing between "the daemon I started" and "something else answering on that
	 * address", and a mod is arbitrary code with the vault's file access.
	 */
	private renderKeyVerdict(root: HTMLElement, outcome: Extract<DaemonProbeOutcome, { kind: "ok" }>): void {
		if (outcome.keyState === "match") {
			root.createDiv({ cls: "modkit-inline-ok", text: `Signing key matches the pinned key (${shortPubkey(outcome.presentedKey)}).` });
			return;
		}

		if (outcome.keyState === "daemon-unkeyed") {
			const box = root.createDiv({ cls: "modkit-callout modkit-callout-warn" });
			box.createDiv({ cls: "modkit-callout-title", text: "It presented no signing key" });
			box.createDiv({ text: "It answered as modkit but reported no Ed25519 public key, so there is nothing to pin and nothing it signs can be checked against." });
			return;
		}

		if (outcome.keyState === "unpinned") {
			const box = root.createDiv({ cls: "modkit-callout modkit-callout-warn" });
			box.createDiv({ cls: "modkit-callout-title", text: "No key is pinned yet" });
			box.createDiv({ text: `It presented ${shortPubkey(outcome.presentedKey)}. Until it is pinned, modkit will refuse everything it signs.` });
			this.addPinButton(box, outcome.presentedKey, "Pin this key", false);
			return;
		}

		const box = root.createDiv({ cls: "modkit-callout modkit-callout-danger" });
		box.createDiv({ cls: "modkit-callout-title", text: "This is not the key modkit pinned" });
		box.createDiv({
			text: `${outcome.url} presented ${shortPubkey(outcome.presentedKey)}. modkit has ${shortPubkey(this.settings.daemonPubkey)} pinned. Nothing signed with the wrong key will be installed while that is true.`,
		});
		box.createDiv({
			cls: "modkit-callout-body",
			text: "Two very different things look exactly like this from here: its key was regenerated (a fresh checkout, a wiped .state), or something other than the process you started is answering on that address. modkit cannot tell them apart. You can, by reading the key off the machine you started it on.",
		});
		this.addPinButton(box, outcome.presentedKey, "Replace the pinned key", true);
	}

	private addPinButton(box: HTMLElement, key: string, label: string, replacing: boolean): void {
		box.createDiv({
			cls: "modkit-callout-body",
			text: "Pinning this key means every mod it signs is written into this vault and runs with your vault's full file access, without asking again. Pin it only if you started it yourself.",
		});
		new Setting(box).addButton((button) => {
			if (replacing) button.setWarning();
			button.setButtonText(label).onClick(() => {
				void this.patch({ daemonPubkey: key }).then(() => {
					new Notice(`Pinned ${shortPubkey(key)}.`);
					this.refresh();
				});
			});
		});
	}

	/* ── Installing mods ──────────────────────────────────────────────────── */

	private renderInstallSection(root: HTMLElement): void {
		new Setting(root).setName("Installing mods").setHeading();
		const settings = this.settings;

		new Setting(root)
			.setName("Show me the code before it runs")
			.setDesc("Every mod is shown to you in full, and waits for your approval, before any of it runs.")
			.addToggle((toggle) => {
				toggle.setValue(settings.reviewBeforeEnable).onChange((value) => {
					void this.patch({ reviewBeforeEnable: value }).then(() => this.refresh());
				});
			});

		new Setting(root)
			.setName("Turn a new mod on once it is installed")
			.setDesc("Off means a new mod is written to disk and left switched off until you turn it on in the list below.")
			.addToggle((toggle) => {
				toggle.setValue(settings.autoEnableGeneratedMods).onChange((value) => {
					void this.patch({ autoEnableGeneratedMods: value }).then(() => this.refresh());
				});
			});

		const policy = enablePolicy(settings);
		root.createDiv({
			cls: "modkit-section-note",
			text:
				policy === "review-then-enable"
					? "A new mod is shown to you in full, and turned on when you approve it."
					: policy === "enable"
						? "A new mod is installed and turned on straight away, without showing you the code."
						: "A new mod is written to disk and left off until you turn it on here.",
		});

	}

	/* ── Model ─────────────────────────────────────────────────────────────── */

	/**
	 * Which model writes the mods, and a button that answers "why did that fail?" without costing
	 * a generation.
	 *
	 * The check exists because of a real report: a friend's daemon returned "OAuth session expired
	 * and could not be refreshed" and modkit rendered it as "The model call failed." with the CLI's
	 * JSON transcript behind a disclosure triangle. Nothing on that screen said `claude login`, and
	 * nothing said which binary had been run — which matters, because a daemon started from a shell
	 * whose PATH lacks `~/.local/bin` cannot find `claude` at all.
	 */
	private renderModelSection(root: HTMLElement): void {
		new Setting(root).setName("Model").setHeading();
		const settings = this.settings;

		new Setting(root)
			.setName("Backend")
			.setDesc(
				"Which CLI the daemon shells out to. “Daemon's choice” uses whatever it was started with, " +
					"and is the right answer unless you want this vault to differ.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("", "Daemon's choice")
					.addOption("claude", "claude")
					.addOption("codex", "codex")
					.setValue(settings.modelBackend)
					.onChange((value) => {
						const backend = value === "claude" || value === "codex" ? value : "";
						void this.patch({ modelBackend: backend }).then(() => this.refresh());
					});
			});

		new Setting(root)
			.setName("Model")
			.setDesc("A model id the chosen CLI accepts — opus, sonnet, haiku, or a full id. Empty means the daemon's own.")
			.addText((text) => {
				text
					.setPlaceholder("daemon's choice")
					.setValue(settings.modelName)
					.onChange((value) => {
						void this.patch({ modelName: value.trim().slice(0, MAX_MODEL_NAME) });
					});
			});

		// Codex is offered above but granted by the daemon. Saying so here, before someone picks it
		// and watches every generation fail, is the whole point of `codexAvailable` on /v1/health.
		const lastHealth = this.lastProbe?.kind === "ok" ? this.lastProbe.health : null;
		if (settings.modelBackend === "codex" && lastHealth?.codexAvailable === false) {
			root.createDiv({
				cls: "modkit-section-note",
				text:
					"This daemon will refuse codex: its operator has not set MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1. " +
					"codex's shell tool can read any file on that machine during a generation, so turning it on is " +
					"a deliberate act taken on the daemon, not here.",
			});
		}

		const status = root.createDiv({ cls: "modkit-section-note" });
		status.setText("Not checked yet.");

		new Setting(root)
			.setName("Check model access")
			.setDesc(
				"Finds the CLI on this machine and makes one tiny model call to prove it is signed in. " +
					"Costs a few tokens; it is the only way to tell “signed in” from “the binary exists”.",
			)
			.addButton((button) => {
				button.setButtonText("Check").onClick(() => {
					button.setDisabled(true);
					status.setText("Checking…");
					void probeModelAccess(settings, { deep: true })
						.then((result) => {
							if (!result.ok) {
								status.setText(`Could not check: ${result.detail}`);
								return;
							}
							const c = result.value;
							if (!c.binPath) {
								status.setText(
									`${c.hint ?? "The CLI could not be found."} Looked in: ${c.searched.slice(0, 6).join(", ")}`,
								);
								return;
							}
							if (c.signedIn === false) {
								status.setText(`${c.hint ?? "Not signed in."}  (${c.binPath})`);
								return;
							}
							if (c.signedIn === true) {
								status.setText(`Ready — ${c.backend} at ${c.binPath}${c.version ? `, ${c.version}` : ""}.`);
								return;
							}
							status.setText(c.hint ?? `Found ${c.binPath}, but could not confirm sign-in.`);
						})
						.finally(() => button.setDisabled(false));
				});
			});
	}

	/* ── Advanced ──────────────────────────────────────────────────────────── */

	private renderAdvancedSection(root: HTMLElement): void {
		new Setting(root).setName("Advanced").setHeading();
		const settings = this.settings;

		new Setting(root)
			.setName("Debug logging")
			.setDesc(
				"Verbose modkit output in the developer console (the auth token is never logged), and it reveals two things everyone else keeps hidden: “Mod plugin… (experimental)” in the command palette — patching a plugin's own class, not yet proven to survive a real update — and the Phase-0 experiment commands. Turn it on to see either.",
			)
			.addToggle((toggle) => {
				toggle.setValue(settings.debugLogging).onChange((value) => {
					void this.patch({ debugLogging: value });
				});
			});
	}

	/* ── Half 2: the mod list ─────────────────────────────────────────────── */

	private renderModList(root: HTMLElement): void {
		const mods = [...this.deps.store.mods];

		new Setting(root)
			.setName(mods.length === 0 ? "Mods" : `Mods (${mods.length})`)
			.setHeading()
			.addExtraButton((button) => {
				button
					.setIcon("refresh-cw")
					.setTooltip("Check every mod again, now")
					.onClick(() => {
						const refreshHealth = this.deps.mods.refreshHealth;
						if (!refreshHealth) {
							this.refresh();
							return;
						}
						void refreshHealth
							.call(this.deps.mods)
							.catch((err: unknown) => new Notice(`Could not check the mods — ${errorMessage(err)}`, 0))
							.then(() => this.refresh());
					});
			});

		if (mods.length === 0) {
			this.renderEmptyState(root);
			return;
		}

		const foreign = this.deps.store.foreignProtocol;
		if (foreign) {
			const box = root.createDiv({ cls: "modkit-callout modkit-callout-warn" });
			box.createDiv({ cls: "modkit-callout-title", text: "This list was written by another version of modkit" });
			box.createDiv({ text: `data.json declares protocol ${foreign}; this plugin speaks ${MODKIT_PROTOCOL_VERSION}. Records may be missing fields this build expects.` });
		}

		// Grouped by target, because that is the axis along which mods break: when a plugin updates,
		// every mod aimed at it moves at once, and they should be read together.
		const groups = new Map<string, ModRecord[]>();
		for (const mod of mods) {
			const key = targetKey(mod.target);
			const bucket = groups.get(key);
			if (bucket) bucket.push(mod);
			else groups.set(key, [mod]);
		}

		const ordered = [...groups.entries()].sort((a, b) => {
			const worst = (records: ModRecord[]): number => Math.min(...records.map((m) => MOD_HEALTH_SEVERITY[m.health.state] ?? 9));
			const bySeverity = worst(a[1]) - worst(b[1]);
			if (bySeverity !== 0) return bySeverity;
			return describeTarget(a[1][0]!.target).localeCompare(describeTarget(b[1][0]!.target));
		});

		for (const [, records] of ordered) {
			records.sort(compareMods);
			this.renderGroup(root, records);
		}
	}

	/**
	 * The first thing anyone sees, so it has to answer "what is this and what do I type" — and, when
	 * modkit is not connected yet, say that *here* rather than leaving the user to work out that the
	 * warning three screens up is the reason "Mod this…" will not do anything.
	 */
	private renderEmptyState(root: HTMLElement): void {
		const box = root.createDiv({ cls: "modkit-empty" });
		box.createDiv({ cls: "modkit-empty-title", text: "No mods yet" });
		box.createEl("p", {
			text: "A mod is a small plugin modkit writes for you, whose only job is to change how another plugin — or Obsidian itself — behaves. modkit never edits anyone else's code, so switching a mod off leaves the target exactly as it was.",
		});

		const blockers = settingsBlockers(this.settings);
		if (blockers.length > 0) {
			// Not a duplicate of the callout at the top: that one says what is wrong, this one says
			// what it costs you and in what order to fix it.
			box.createDiv({ cls: "modkit-empty-title", text: "First, connect" });
			box.createEl("p", {
				text: "Nothing can be written until the Connection section above is filled in. In order:",
			});
			const setup = box.createEl("ol");
			setup.createEl("li", { text: "Run `npm run setup` in the modkit repo on this machine. It starts modkit's background process and fills in this whole section for you." });
			setup.createEl("li", { text: "If that process runs on another machine, paste its token here instead — it writes one to .state/modkit/daemon.token on first run." });
			setup.createEl("li", { text: "Press Test connection, then Pin this key on the key it presents." });
			const why = box.createEl("ul");
			for (const blocker of blockers) why.createEl("li", { text: blocker });
		}

		box.createDiv({ cls: "modkit-empty-title", text: blockers.length > 0 ? "Then, your first mod" : "Writing your first mod" });
		const steps = box.createEl("ol");
		steps.createEl("li", { text: "Right-click the part of Obsidian you want changed and choose “Customize…”." });
		steps.createEl("li", {
			text: "Not on screen, or nothing to right-click? Open the command palette and run “modkit: Mod this…”, then click it — or run “modkit: Mod plugin…” to pick a plugin by name instead.",
		});
		steps.createEl("li", { text: "Describe the change in one sentence, the way you would to a person." });
		box.createEl("p", {
			cls: "modkit-empty-example",
			text: "For example: “put the due date before the task text”, or “stop this pane stealing focus when I open a note”.",
		});
		box.createEl("p", {
			text: "It takes a minute or two, and the mod turns up in this list when it lands. If what you asked for cannot be reached, modkit says so and says why, rather than installing something that quietly does nothing.",
		});
	}

	private renderGroup(root: HTMLElement, records: ModRecord[]): void {
		const first = records[0];
		if (!first) return;
		const installed = this.installedVersion(first.target);

		const header = root.createDiv({ cls: "modkit-group-header" });
		header.createDiv({ cls: "modkit-group-name", text: describeTarget(first.target) });
		header.createDiv({ cls: "modkit-group-sub", text: groupSummary(records, installed) });

		for (const mod of records) this.renderModCard(root, mod, installed);
	}

	/**
	 * Today's version of the target, which is the number that matters — a mod records the version it
	 * was *generated against*, and the gap between the two is the whole maintenance story.
	 */
	private installedVersion(target: TargetRef): string | null {
		if (target.kind === "core") return apiVersion ?? null;
		return this.app.plugins?.manifests?.[target.pluginId]?.version ?? null;
	}

	private renderModCard(root: HTMLElement, mod: ModRecord, installedTargetVersion: string | null): void {
		const card = root.createDiv({ cls: "modkit-card" });

		const head = card.createDiv({ cls: "modkit-card-head" });
		head.createDiv({ cls: "modkit-card-title", text: mod.name || mod.modId });
		// A mod that is switched off has no health worth a colour: its last verdict describes a run
		// that is not happening. Say "off", muted, and keep the old verdict for when it comes back.
		// (Measured 2026-09-03: two off mods wore a yellow "doing nothing" and a stale explanation.)
		const pill = mod.enabled
			? head.createDiv({ cls: healthClass(mod.health.state), text: HEALTH_LABEL[mod.health.state] })
			: head.createDiv({ cls: "modkit-pill modkit-pill-off", text: "off" });
		// `HEALTH_MEANING["no-effect"]` ("nothing has called it") is written for planes A–D, where
		// health comes from an invocation count. A plane-E mod has no invocations to speak of — its
		// `health.detail` instead names the selector that matched nothing (see `checkDomReach` in
		// `host/supervisor.ts`), which is the truer sentence whenever it is there to use.
		pill.setAttribute(
			"aria-label",
			!mod.enabled
				? "Switched off. Its files stay in the vault; turn it back on below."
				: mod.health.state === "no-effect" && mod.health.detail
					? mod.health.detail
					: HEALTH_MEANING[mod.health.state],
		);

		// The user's own words, verbatim and prominent. This is the field Obsidian's plugin list
		// cannot have, it is what regeneration runs against, and it is the only part of a mod a user
		// can be expected to recognise months later.
		// Trimmed: the sentence is stored as typed, and a textarea's trailing newlines rendered under
		// `white-space: pre-wrap` made a one-line request a five-line empty block (2026-09-03).
		card.createDiv({ cls: "modkit-request", text: `“${mod.request.trim()}”` });

		if (mod.explanation) card.createDiv({ cls: "modkit-explanation", text: mod.explanation });

		const generatedAgainst = targetVersion(mod.target);
		const drifted = installedTargetVersion !== null && installedTargetVersion !== generatedAgainst;

		const meta = card.createDiv({ cls: "modkit-meta" });
		this.addFact(meta, "Target", describeTarget(mod.target));
		this.addFact(meta, "Generated against", generatedAgainst || "unrecorded");
		meta.createDiv({ cls: "modkit-meta-key", text: "Installed now" });
		meta.createDiv({
			cls: `modkit-meta-value${installedTargetVersion === null ? " modkit-bad" : drifted ? " modkit-drift" : ""}`,
			text: installedTargetVersion === null ? "not installed" : installedTargetVersion,
		});
		this.addFact(meta, "How it patches", describeReach(mod.reach));
		this.addFact(
			meta,
			"Version gate",
			`${mod.targetVersionRange.from} → ${mod.targetVersionRange.to ?? "open-ended"}`,
		);
		this.addFact(meta, "Written", formatWhen(mod.createdAt));
		this.addFact(meta, "Last checked", formatWhen(mod.health.lastCheckedAt));
		if (typeof mod.health.invocations === "number") {
			this.addFact(meta, "Times it has run", String(mod.health.invocations));
		}
		if (mod.userVerifiedAt) this.addFact(meta, "You confirmed it", formatWhen(mod.userVerifiedAt));

		if (!mod.enabled) {
			// Nothing to explain about a mod that is not running; the toggle below is the whole story.
		} else if (mod.health.state !== "applied" && mod.health.detail) {
			card.createDiv({ cls: "modkit-health-detail", text: mod.health.detail });
		} else if (mod.health.state !== "applied") {
			card.createDiv({ cls: "modkit-health-detail", text: HEALTH_MEANING[mod.health.state] });
		}

		if (drifted) {
			card.createDiv({
				cls: "modkit-inline-warn",
				text: `Target moved: ${describeTarget(mod.target)} ${generatedAgainst} → ${installedTargetVersion}. If this stopped working, Regenerate writes it again from your sentence, against the version you have now.`,
			});
		}

		this.renderEnableRow(card, mod);
		this.renderActionRow(card, mod);
	}

	private renderEnableRow(card: HTMLElement, mod: ModRecord): void {
		// Obsidian's enabled-plugins set is the authority on what is *running*; `mod.enabled` is only
		// modkit's intent. They disagree the moment the user toggles the generated plugin in
		// Obsidian's own list, and a mod list that hid that would be lying about the vault.
		const running = this.app.plugins?.enabledPlugins?.has(mod.modId) ?? null;
		const disagrees = running !== null && running !== mod.enabled;

		const setting = new Setting(card).setName("Enabled");
		if (disagrees) {
			setting.setDesc(
				running
					? "Obsidian has this switched on and modkit's own record says off. The switch below follows Obsidian, which is the one that decides."
					: "Obsidian has this switched off — most likely toggled in the community-plugins list rather than here.",
			);
		}
		setting.addToggle((toggle) => {
			toggle.setValue(running ?? mod.enabled).onChange((value) => {
				toggle.setDisabled(true);
				void this.deps.mods
					.setEnabled(mod.modId, value)
					.catch((err: unknown) => {
						new Notice(`Could not turn “${mod.name}” ${value ? "on" : "off"} — ${errorMessage(err)}`, 0);
					})
					.then(() => this.refresh());
			});
		});
	}

	private renderActionRow(card: HTMLElement, mod: ModRecord): void {
		new Setting(card)
			.setClass("modkit-actions")
			.addButton((button) => {
				button
					.setButtonText("Show the code")
					.setTooltip("The main.js that is running, read off disk")
					.onClick(() => {
						void this.openSource(mod);
					});
			})
			.addButton((button) => {
				button
					.setButtonText("Write it again")
					.setTooltip("Write it again from your original sentence, against the version of the target you have now")
					.onClick(() => {
						button.setDisabled(true);
						new Notice(`Writing “${mod.name}” again — this takes a minute or two.`);
						void this.deps.mods
							.regenerate(mod.modId)
							.catch((err: unknown) => new Notice(`Could not write “${mod.name}” again — ${errorMessage(err)}`, 0))
							.then(() => this.refresh());
					});
			})
			.addButton((button) => {
				button
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.confirmUninstall(mod);
					});
			});
	}

	private confirmUninstall(mod: ModRecord): void {
		new ConfirmModal(this.app, {
			title: `Remove “${mod.name}”?`,
			body: [
				`This deletes ${this.pluginFolder(mod.modId)} and drops the mod from modkit's list.`,
				`It also deletes the sentence behind it — “${mod.request}” — which is what Write it again works from. Afterwards the only way back is to ask for it again from scratch.`,
				"What it patches is untouched. modkit never modifies anyone else's code, so the target is already exactly as it was.",
			],
			confirmText: "Remove",
			onConfirm: () => {
				void this.deps.mods
					.uninstall(mod.modId)
					.then(() => new Notice(`Removed “${mod.name}”.`))
					.catch((err: unknown) => new Notice(`Could not remove “${mod.name}” — ${errorMessage(err)}`, 0))
					.then(() => this.refresh());
			},
		}).open();
	}

	private pluginFolder(modId: string): string {
		return normalizePath(`${this.app.vault.configDir}/plugins/${modId}`);
	}

	/**
	 * Read the mod's `main.js`. Prefers the injected port; falls back to the vault adapter, which is
	 * entirely public API — so "view the code that is running in my vault" never depends on another
	 * part of modkit being wired up correctly.
	 */
	private async openSource(mod: ModRecord): Promise<void> {
		const path = `${this.pluginFolder(mod.modId)}/main.js`;
		try {
			const read = this.deps.mods.readSource;
			const source = read ? await read.call(this.deps.mods, mod.modId) : await this.app.vault.adapter.read(normalizePath(path));
			new SourceModal(this.app, mod, path, source).open();
		} catch (err) {
			new Notice(`Could not read ${path} — ${errorMessage(err)}`, 0);
		}
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Modals
 * ──────────────────────────────────────────────────────────────────────────── */

interface ConfirmOptions {
	title: string;
	body: string[];
	confirmText: string;
	onConfirm: () => void;
}

class ConfirmModal extends Modal {
	constructor(app: App, private readonly options: ConfirmOptions) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.addClass("modkit-settings");
		this.contentEl.createEl("style", { text: MODKIT_SETTINGS_CSS });
		for (const paragraph of this.options.body) this.contentEl.createEl("p", { text: paragraph });
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText("Cancel").onClick(() => this.close());
			})
			.addButton((button) => {
				button
					.setButtonText(this.options.confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						this.options.onConfirm();
					});
			});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * The generated source, read off disk.
 *
 * Reading it from the vault rather than from the signed payload is deliberate: this is the answer to
 * "what is actually running in my vault", and the file is what runs. The recorded hash is shown
 * beside it so a hand-edited mod is visible rather than merely possible.
 */
class SourceModal extends Modal {
	constructor(
		app: App,
		private readonly mod: ModRecord,
		private readonly path: string,
		private readonly source: string,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.mod.name || this.mod.modId);
		const { contentEl } = this;
		contentEl.addClass("modkit-settings");
		contentEl.createEl("style", { text: MODKIT_SETTINGS_CSS });

		contentEl.createDiv({ cls: "modkit-request", text: `“${this.mod.request.trim()}”` });

		const meta = contentEl.createDiv({ cls: "modkit-meta" });
		const fact = (key: string, value: string): void => {
			meta.createDiv({ cls: "modkit-meta-key", text: key });
			meta.createDiv({ cls: "modkit-meta-value", text: value });
		};
		fact("File", this.path);
		fact("How it patches", describeReach(this.mod.reach));
		fact("Recorded hash", this.mod.sha256 ? `${this.mod.sha256.slice(0, 16)}…` : "unrecorded");
		fact("Generated by", `${this.mod.generator?.model ?? "unknown model"} · modkit ${this.mod.generator?.daemonVersion ?? "?"}`);
		fact("Size", `${this.source.length.toLocaleString()} characters`);

		const pre = contentEl.createEl("pre", { cls: "modkit-source" });
		pre.createEl("code", { text: this.source });

		new Setting(contentEl).addButton((button) => {
			button.setButtonText("Copy").onClick(() => {
				void navigator.clipboard
					?.writeText(this.source)
					.then(() => new Notice("Source copied."))
					.catch(() => new Notice("The clipboard refused the copy."));
			});
		});
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Styles
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Obsidian variables only, with a fallback in every `var()` whose primary is a semantic token — a
 * theme is free not to define `--text-warning`, and a health badge that renders as inherited body
 * text is a health badge that says nothing.
 */
const MODKIT_SETTINGS_CSS = `
.modkit-settings .modkit-section-note {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller);
	margin: 0 0 var(--size-4-3) 0;
}
/* Same note-card recipe as ReviewModal's mismatch/consequence blocks and Compose's/Progress's
   refusal card: padding all round, radius, a quiet background, one coloured accent edge — so a
   callout here reads as the same kind of thing modkit says everywhere else, not a different
   component that happens to live in Settings. */
.modkit-settings .modkit-callout {
	border-left: 3px solid var(--background-modifier-border);
	border-radius: var(--radius-s);
	padding: var(--size-4-3);
	margin: var(--size-4-2) 0 var(--size-4-4) 0;
	background: var(--background-secondary);
	font-size: var(--font-ui-small);
}
.modkit-settings .modkit-callout ul,
.modkit-settings .modkit-callout ol { margin: var(--size-4-2) 0 0 0; padding-left: var(--size-4-4); }
.modkit-settings .modkit-callout-title {
	font-weight: var(--font-semibold);
	margin-bottom: var(--size-4-1);
}
.modkit-settings .modkit-callout-body { margin-top: var(--size-4-2); color: var(--text-muted); }
.modkit-settings .modkit-callout-ok { border-left-color: var(--color-green); }
.modkit-settings .modkit-callout-warn { border-left-color: var(--color-yellow); }
.modkit-settings .modkit-callout-error { border-left-color: var(--color-orange); }
.modkit-settings .modkit-callout-danger {
	border-left-color: var(--text-error, var(--color-red));
	border-left-width: 4px;
	background: var(--background-modifier-error);
}
.modkit-settings .modkit-inline-warn,
.modkit-settings .modkit-inline-danger,
.modkit-settings .modkit-inline-ok {
	font-size: var(--font-ui-smaller);
	margin: var(--size-4-1) 0 var(--size-4-3) 0;
}
.modkit-settings .modkit-inline-warn { color: var(--text-warning, var(--color-yellow)); }
.modkit-settings .modkit-inline-danger { color: var(--text-error, var(--color-red)); }
.modkit-settings .modkit-inline-ok { color: var(--text-success, var(--color-green)); }
.modkit-settings .modkit-key-input { font-family: var(--font-monospace); width: 22em; }
.modkit-settings .modkit-number-input { width: 6em; }
.modkit-settings .modkit-connection-details summary {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller);
	cursor: var(--cursor, pointer);
	margin: var(--size-4-2) 0;
}
/* A coarse pointer needs a real target, not a mouse-sized one — the same 44px floor every other
   disclosure and tap target in modkit holds itself to. Gated on pointer: coarse so desktop's
   tighter density is untouched. */
@media (pointer: coarse) {
	.modkit-settings .modkit-connection-details summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		padding: 0 var(--size-4-2);
	}
}
.modkit-settings .modkit-detail {
	white-space: pre-wrap;
	font-size: var(--font-ui-smaller);
	background: var(--background-primary);
	padding: var(--size-4-2);
	border-radius: var(--radius-s);
	max-height: 10em;
	overflow: auto;
}

.modkit-settings .modkit-group-header {
	display: flex;
	align-items: baseline;
	gap: var(--size-4-2);
	margin: var(--size-4-4) 0 var(--size-4-2) 0;
	padding-bottom: var(--size-4-1);
	border-bottom: 1px solid var(--background-modifier-border);
}
.modkit-settings .modkit-group-name { font-weight: var(--font-semibold); }
.modkit-settings .modkit-group-sub { color: var(--text-muted); font-size: var(--font-ui-smaller); }

.modkit-settings .modkit-card {
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-m);
	padding: var(--size-4-3);
	margin-bottom: var(--size-4-3);
	background: var(--background-secondary);
}
.modkit-settings .modkit-card-head {
	display: flex;
	align-items: center;
	gap: var(--size-4-2);
	margin-bottom: var(--size-4-2);
}
.modkit-settings .modkit-card-title { font-weight: var(--font-semibold); flex: 1; }
.modkit-settings .modkit-pill {
	font-size: var(--font-ui-smaller);
	padding: 1px var(--size-4-2);
	border-radius: var(--radius-s);
	border: 1px solid currentColor;
	white-space: nowrap;
}
.modkit-settings .modkit-pill-applied { color: var(--text-success, var(--color-green)); }
.modkit-settings .modkit-pill-no-effect { color: var(--color-yellow); }
.modkit-settings .modkit-pill-target-moved { color: var(--color-orange); }
.modkit-settings .modkit-pill-target-gone { color: var(--text-muted); }
.modkit-settings .modkit-pill-off { color: var(--text-faint); }
.modkit-settings .modkit-pill-error { color: var(--text-error, var(--color-red)); }

.modkit-settings .modkit-request {
	border-left: 3px solid var(--interactive-accent);
	padding-left: var(--size-4-3);
	margin: var(--size-4-2) 0;
	white-space: pre-wrap;
	font-style: italic;
}
.modkit-settings .modkit-explanation {
	color: var(--text-muted);
	font-size: var(--font-ui-small);
	margin-bottom: var(--size-4-2);
}
.modkit-settings .modkit-meta {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: 2px var(--size-4-3);
	font-size: var(--font-ui-smaller);
	margin: var(--size-4-2) 0;
}
.modkit-settings .modkit-meta-key { color: var(--text-muted); }
.modkit-settings .modkit-meta-value { overflow-wrap: anywhere; }
.modkit-settings .modkit-meta-value.modkit-drift { color: var(--text-warning, var(--color-yellow)); }
.modkit-settings .modkit-meta-value.modkit-bad { color: var(--text-error, var(--color-red)); }
.modkit-settings .modkit-health-detail {
	font-size: var(--font-ui-smaller);
	color: var(--text-muted);
	margin-bottom: var(--size-4-2);
}
.modkit-settings .modkit-actions { border-top: none; padding-top: 0; }

.modkit-settings .modkit-empty {
	border: 1px dashed var(--background-modifier-border);
	border-radius: var(--radius-m);
	padding: var(--size-4-4);
	color: var(--text-muted);
}
.modkit-settings .modkit-empty-title {
	font-weight: var(--font-semibold);
	color: var(--text-normal);
	margin-bottom: var(--size-4-2);
}
.modkit-settings .modkit-empty-example { font-style: italic; }
.modkit-settings .modkit-source {
	max-height: 22em;
	overflow: auto;
	background: var(--background-primary);
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-s);
	padding: var(--size-4-2);
	font-size: var(--font-ui-smaller);
}
`;
