/**
 * The supervisor: keeps mods alive across their *target* being reloaded.
 *
 * ## The problem it exists for
 *
 * A mod patches `app.plugins.plugins[id].constructor.prototype`. The user then disables and
 * re-enables the target — or the target updates, or the target's own "reload" command runs, which
 * QuickAdd ships. `disablePlugin` + `enablePlugin` re-evaluates the target's `main.js` and produces
 * a **fresh class object with a fresh prototype**. Every mod sitting on the old prototype is now
 * patching a corpse: silently inert, while still reporting itself as enabled. That is the exact
 * failure class this whole project says must be zero, and nothing in `pjeby/hot-reload` mitigates
 * it.
 *
 * ## Why hooks and not polling
 *
 * There is **no documented plugin-enable event** — verified by enumerating every `on(name: '…')`
 * overload in `obsidian.d.ts`; Workspace, Vault and MetadataCache events exist and none of them
 * covers plugin lifecycle. So the honest options are to wrap the internal
 * `app.plugins.enablePlugin` / `disablePlugin`, or to poll. We prefer the wrap — it is exact,
 * immediate, costs nothing while idle, and goes in through `this.register()` so it is fully
 * reversible — and fall back to a `registerInterval` poll only when those internals are absent.
 *
 * ## Never throw
 *
 * Every entry point here is called either from generated (untrusted) code or from inside the host's
 * own `enablePlugin` call stack. A supervisor that can throw would take the host down with it, so
 * every public method swallows and reports instead.
 *
 * ## What happened to the health sink
 *
 * This used to also be the health sink generated mods reported into (`Supervisor.modHealth`,
 * `report()`, `getHealth()`, `history()`, `allHealth()`, `onHealthChange()`). Nothing in the product
 * read any of that: the mod list in `SettingsTab.ts` renders `record.health` from the ledger
 * (`ModStore`), never from the supervisor. Generated mods still find modkit the same way — through
 * `app.plugins.plugins["modkit"].modkitReportHealth(modId, status)` (see `PATCH_PLUGIN_TEMPLATE`'s
 * `modkitPublish` in the daemon's `prompt.ts`) — but that push now goes straight to the ledger; the
 * supervisor is told about its own events (a reload, a failure) through the `onEvent` callback below
 * instead of keeping its own copy.
 */

import { Component, Notice } from "obsidian";
import { around } from "monkey-around";
import type { Host } from "./host";
import type { ReachDom } from "@modkit/types";

/** What the supervisor tells its owner about, as it happens. Never about a mod's own health push. */
export type SupervisorEvent =
	/** The target's class object was replaced underneath a tracked mod. */
	| "target-reloaded"
	/** The mod was reloaded onto the new class object and is live again. */
	| "reapplied"
	/** The mod could not be reloaded; it is inert. */
	| "reload-failed"
	/** The mod is no longer installed. */
	| "removed"
	/** Something went wrong inside the supervisor itself, not in a mod. */
	| "supervisor-error";

export interface SupervisorOptions {
	/** Never allowed to throw back into the supervisor — a throwing callback is caught and logged. */
	onEvent?: (modId: string, event: SupervisorEvent, detail: string) => void;
}

export type SupervisorMode = "hooked" | "polling" | "unavailable";

/** Cheap: a handful of property reads per tracked mod. Only used when the hooks are unavailable. */
const POLL_INTERVAL_MS = 5_000;
const NOTICE_MS = 12_000;
/** Events reported about the supervisor itself rather than about one mod. */
const SUPERVISOR_ID = "modkit";

/**
 * A reference that does not keep a dead class object alive. The whole point of watching for
 * identity change is that the old prototype becomes garbage — pinning it with a strong reference
 * would leak one dead plugin class per reload.
 */
interface CtorRef {
	get(): object | null;
}

function makeRef(value: object): CtorRef {
	if (typeof WeakRef === "function") {
		const weak = new WeakRef(value);
		return { get: () => weak.deref() ?? null };
	}
	const strong = value;
	return { get: () => strong };
}

interface Snapshot {
	targetPluginId: string;
	/** `null` while the target is not loaded — a target that later appears counts as a change. */
	ref: CtorRef | null;
}

/** The two internals we wrap. A type alias (not an interface) so it satisfies `around`'s constraint. */
type PluginToggles = {
	enablePlugin(id: string): Promise<unknown>;
	disablePlugin(id: string): Promise<unknown>;
};

/** The shape `around()` takes for `PluginToggles` — named so a one-method call can be cast to it. */
type ToggleFactories = Partial<{ [K in keyof PluginToggles]: (next: PluginToggles[K]) => PluginToggles[K] }>;

/* ────────────────────────────────────────────────────────────────────────────
 * Plane-E health — "a no-effect is a ledger row, not a toast"
 * ──────────────────────────────────────────────────────────────────────────── */

/** How many times to check before giving up and calling it `no-effect`, and how long to wait between. */
const DOM_REACH_ATTEMPTS = 3;
const DOM_REACH_RETRY_MS = 800;

export interface DomReachResult {
	/** Live matches for `reach.selector` in the document just checked. */
	matches: number;
	state: "applied" | "no-effect";
	detail: string;
}

/**
 * Count how many nodes a plane-E mod's selector matches right now, and turn that into a verdict.
 *
 * MEASURED 2026-09-02 (PLAN.md): the "hide the Search tab icon" mod installed cleanly, reported
 * itself enabled, and changed nothing — its selector matched zero nodes on this build. The mod's own
 * 30s no-effect probe found exactly that and reported it into a `Notice` nobody was still looking
 * at. This is the fix: the same finding, on the ledger row, which is where the mod list reads from.
 *
 * A plain function taking a `Document` rather than a `Supervisor` method, on purpose — every caller
 * is in `main.ts` (the post-enable hook, the supervisor's `reapplied` handling in its `onEvent`
 * callback, a manual "Check now", enabling from the mod list, and a startup recheck), and it lives
 * here because this is the in-fence home for host-facing checks, not because `Supervisor` itself
 * calls it. A pure function is what a test can drive with a fake `document`, no live Obsidian
 * required.
 *
 * **What this checks for `reach.mode === "css"`, and its limit.** A mod ships a `styles.css` that
 * Obsidian attaches to `document.head` itself as a `<style>` element, so once the selector itself
 * matches, {@link cssRuleAttached} additionally scans `document.head`'s `<style>` elements for one
 * whose text contains `reach.selector` — the generated CSS's own rule almost always repeats the
 * selector verbatim, since that is the whole content of a plane-E stylesheet. This closes the gap a
 * review found real: PLAN.md's bug #1 measured a stylesheet landing in the *Settings window's*
 * document while the main window went unpatched, and a selector-only check reads that as `applied`
 * because the targeted element still exists — it was never evidence *this window's* rule attached.
 * It is still a heuristic, not a parse: a coincidental `<style>` containing the same substring for
 * an unrelated reason would false-positive, and there is no cheaper way to ask "is our rule in the
 * cascade" without parsing every stylesheet's rules back to the mod's own source, which is a
 * validator-sized job this function is not going to guess its way through.
 */
export function checkDomReach(
	doc: Document,
	reach: Pick<ReachDom, "selector" | "mode">,
	stylesCss?: string | undefined,
): DomReachResult {
	let matches: number;
	try {
		matches = doc.querySelectorAll(reach.selector).length;
	} catch (err) {
		return { matches: 0, state: "no-effect", detail: `"${reach.selector}" is not a selector this Obsidian can read: ${String(err)}` };
	}
	if (matches === 0) {
		return { matches, state: "no-effect", detail: `Installed, but nothing on screen matches "${reach.selector}".` };
	}
	if (reach.mode === "css" && !cssRuleAttached(doc, reach.selector, stylesCss)) {
		return {
			matches,
			state: "no-effect",
			detail: `"${reach.selector}" exists, but this mod's stylesheet is not attached to this window — Obsidian may have loaded it into a different one.`,
		};
	}
	return {
		matches,
		state: "applied",
		detail: matches === 1 ? `1 match for "${reach.selector}"` : `${matches} matches for "${reach.selector}"`,
	};
}

/** Does any `<style>` Obsidian has attached to this document's `<head>` carry this selector? */
/**
 * When the caller can hand over the mod's own `styles.css` text (the installer wrote it; the plugin
 * can read it back from the vault), the check is exact: Obsidian loads a plugin's stylesheet as a
 * `<style>` whose text is the file's text, so a whitespace-trimmed equality is the honest test and
 * does not depend on the model having repeated the selector verbatim. The selector substring stays
 * as the fallback for a caller that has no stylesheet text to offer.
 */
function cssRuleAttached(doc: Document, selector: string, stylesCss?: string): boolean {
	const wanted = stylesCss === undefined ? null : stylesCss.trim();
	const styles = doc.head.querySelectorAll("style");
	for (let i = 0; i < styles.length; i++) {
		const text = styles.item(i)?.textContent ?? "";
		if (wanted !== null && wanted !== "" && text.trim() === wanted) return true;
		if (text.includes(selector)) return true;
	}
	return false;
}

/**
 * {@link checkDomReach}, retried briefly before it is believed.
 *
 * A mod enabled a moment ago may be racing its own target's render — the tab bar, a newly opened
 * pane — so a single zero-match check the instant `onload` returns would misreport a mod that is
 * about to be fine. Three tries over ~1.6s is enough for layout to settle without holding the
 * caller's install flow open; it stops as soon as a check finds a match.
 */
export async function checkDomReachWithRetry(
	win: Pick<Window, "document" | "setTimeout">,
	reach: Pick<ReachDom, "selector" | "mode">,
	options: { attempts?: number; delayMs?: number; stylesCss?: string | undefined } = {},
): Promise<DomReachResult> {
	const attempts = options.attempts ?? DOM_REACH_ATTEMPTS;
	const delayMs = options.delayMs ?? DOM_REACH_RETRY_MS;
	let result = checkDomReach(win.document, reach, options.stylesCss);
	// This `setTimeout` is not threaded through a `Component`'s teardown — deliberately, not by
	// omission. The whole retry window is ≤`DOM_REACH_ATTEMPTS * DOM_REACH_RETRY_MS` (~1.6s), every
	// caller already checks `abandoned()`/an unload guard on the far side of this `await` before
	// writing anything, and `win` here is frequently a bare `{ document, setTimeout }` test double
	// with no `Component` to register against. If the plugin unloads mid-wait, the timer still fires
	// once into a dead scope, but nothing is written because the guard on the other side of `await`
	// catches it — cosmetic, not a leak.
	for (let i = 1; i < attempts && result.state === "no-effect"; i++) {
		await new Promise<void>((resolve) => win.setTimeout(resolve, delayMs));
		result = checkDomReach(win.document, reach, options.stylesCss);
	}
	return result;
}

export class Supervisor extends Component {
	private readonly onEvent: SupervisorOptions["onEvent"];

	private readonly snapshots = new Map<string, Snapshot>();

	/** Serialises checks so two reloads never interleave, mirroring hot-reload's task queue. */
	private queue: Promise<void> = Promise.resolve();
	private hooked = false;
	private stopped = false;

	constructor(
		private readonly host: Host,
		options: SupervisorOptions = {},
	) {
		super();
		this.onEvent = options.onEvent;
	}

	override onload(): void {
		if (!this.host.available) {
			// The probe already told the user why, loudly. Tracking still works so the mod list can
			// show what modkit *would* be supervising.
			this.hooked = false;
			return;
		}
		this.hooked = this.installHooks();
		if (!this.hooked) {
			this.registerInterval(window.setInterval(() => this.schedule("poll"), POLL_INTERVAL_MS));
			this.emit(
				SUPERVISOR_ID,
				"supervisor-error",
				"app.plugins.enablePlugin/disablePlugin could not be wrapped; falling back to polling for target reloads",
			);
		}
	}

	override onunload(): void {
		this.stopped = true;
	}

	get mode(): SupervisorMode {
		if (!this.host.available) return "unavailable";
		return this.hooked ? "hooked" : "polling";
	}

	// ---------------------------------------------------------------- tracking

	/**
	 * Start watching `targetPluginId`'s class identity on behalf of `modId`. Call it as the mod is
	 * installed or loaded — the snapshot taken here is the identity the mod just patched.
	 */
	track(modId: string, targetPluginId: string): void {
		try {
			if (typeof modId !== "string" || modId === "" || typeof targetPluginId !== "string" || targetPluginId === "") return;
			const ctor = this.host.getPluginConstructor(targetPluginId);
			this.snapshots.set(modId, { targetPluginId, ref: ctor === null ? null : makeRef(ctor) });
		} catch (err) {
			this.emit(modId, "supervisor-error", `could not start supervising: ${String(err)}`);
		}
	}

	untrack(modId: string): void {
		this.snapshots.delete(modId);
	}

	tracked(): { modId: string; targetPluginId: string }[] {
		return [...this.snapshots.entries()].map(([modId, snapshot]) => ({ modId, targetPluginId: snapshot.targetPluginId }));
	}

	/** Queue an identity check. Safe to call from anywhere, including inside a host call stack. */
	checkNow(reason = "manual"): void {
		this.schedule(reason);
	}

	// ------------------------------------------------------------ notifying the owner

	/**
	 * Tell whoever constructed us what happened. Called from inside a host call stack (the hooked
	 * `enablePlugin`/`disablePlugin`) as well as from generated-code-adjacent paths, so a throwing
	 * callback must never escape.
	 */
	private emit(modId: string, event: SupervisorEvent, detail: string): void {
		try {
			this.onEvent?.(modId, event, detail);
		} catch (err) {
			console.error("modkit: a supervisor onEvent callback threw", err);
		}
	}

	// ------------------------------------------------------------------ hooks

	/**
	 * Wrap the internal enable/disable so a target reload is observed the moment it finishes.
	 * Installed through `this.register()`, so unloading modkit removes it completely.
	 */
	private installHooks(): boolean {
		const pm = this.host.pluginManager();
		if (pm === null || typeof pm.enablePlugin !== "function" || typeof pm.disablePlugin !== "function") return false;

		const self = this;
		const toggles = pm as unknown as PluginToggles;

		/**
		 * **One `around()` call per method, registered the instant it succeeds.**
		 *
		 * Passing both factories to a single `around()` inside one try/catch was a real leak, and it
		 * is the failure class this project says must be zero. `around` wraps its methods in order and
		 * assigns `obj[method] = wrapper`; if the *second* assignment throws — a foreign plugin having
		 * frozen or redefined the plugin manager first is the realistic route — the first wrapper is
		 * already on the host object while the remover for it dies with the exception. Nothing then
		 * ever takes it off: not `unload`, not uninstalling modkit. The wrapper outlives the process
		 * that owns it, holding a dead `Supervisor` and calling into it forever.
		 *
		 * Split per method, a failure on the second leaves the first **registered** — so it is removed
		 * on unload like any other hook — and we still report the set as incomplete, which puts the
		 * supervisor into polling mode.
		 */
		const hook = (kind: "enable" | "disable") =>
			function (next: (id: string) => Promise<unknown>) {
				return async function (this: unknown, id: string): Promise<unknown> {
					const result = await next.call(this, id);
					self.onPluginToggled(id, kind);
					return result;
				};
			};

		let complete = true;
		for (const [method, kind] of [
			["enablePlugin", "enable"],
			["disablePlugin", "disable"],
		] as const) {
			try {
				// The computed key widens to `{ [x: string]: … }`, so the cast is unavoidable; `method`
				// comes from the literal tuple above, so it is always a real key of `PluginToggles`.
				this.register(around(toggles, { [method]: hook(kind) } as ToggleFactories));
			} catch (err) {
				console.error(`modkit: could not wrap app.plugins.${method}`, err);
				complete = false;
			}
		}
		return complete;
	}

	private onPluginToggled(id: string, kind: "enable" | "disable"): void {
		try {
			// Our own reload of a mod is not a target event, and treating it as one would loop.
			if (this.snapshots.has(id)) return;
			if (this.host.isReloading(id)) return;
			this.schedule(`${kind}:${id}`);
		} catch (err) {
			console.error("modkit: supervisor hook failed", err);
		}
	}

	// ----------------------------------------------------------- the check

	private schedule(reason: string): void {
		if (this.stopped) return;
		this.queue = this.queue
			.then(() => this.runCheck(reason))
			.catch((err: unknown) => {
				this.emit(SUPERVISOR_ID, "supervisor-error", `check failed (${reason}): ${String(err)}`);
			});
	}

	private async runCheck(reason: string): Promise<void> {
		if (this.stopped || !this.host.available) return;

		// Group by target: several mods commonly share one target, and they all move together.
		const byTarget = new Map<string, string[]>();
		for (const [modId, snapshot] of [...this.snapshots.entries()]) {
			if (this.host.getPluginManifest(modId) === null) {
				this.snapshots.delete(modId);
				this.emit(modId, "removed", `no longer installed (noticed on ${reason})`);
				continue;
			}
			const list = byTarget.get(snapshot.targetPluginId) ?? [];
			list.push(modId);
			byTarget.set(snapshot.targetPluginId, list);
		}

		for (const [targetPluginId, modIds] of byTarget) {
			const current = this.host.getPluginConstructor(targetPluginId);
			// Target absent or disabled: there is nothing to re-patch yet. Keep the old snapshot so
			// that a later re-enable still reads as a change.
			if (current === null) continue;

			for (const modId of modIds) {
				const snapshot = this.snapshots.get(modId);
				if (snapshot === undefined) continue;
				const previous = snapshot.ref?.get() ?? null;
				if (previous === current) continue;

				// Re-snapshot BEFORE reloading. If the reload fails we must not detect the same
				// change again on the next tick and reload in a loop.
				snapshot.ref = makeRef(current);

				this.emit(
					modId,
					"target-reloaded",
					`${targetPluginId} was re-evaluated (${reason}); its class object was replaced, so this mod's patches were on a dead prototype`,
				);

				await this.reapply(modId, targetPluginId);
			}
		}
	}

	private async reapply(modId: string, targetPluginId: string): Promise<void> {
		if (!this.host.isPluginEnabled(modId)) {
			this.emit(modId, "reload-failed", "the patch is switched off, so it could not be put back");
			return;
		}
		const ok = await this.host.reloadPlugin(modId);
		if (ok) {
			this.emit(modId, "reapplied", `re-applied onto the new ${targetPluginId} class`);
			return;
		}
		this.emit(modId, "reload-failed", `could not reload after ${targetPluginId} was re-evaluated; the patch is inert`);
		// A patch that has quietly stopped biting is the failure this whole component exists to
		// prevent, so say it out loud.
		new Notice(`“${modId}” has stopped doing anything — ${targetPluginId} reloaded and the patch could not be put back.`, NOTICE_MS);
	}
}
