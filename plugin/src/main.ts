/**
 * modkit — the plugin that mods plugins.
 *
 * This file is wiring and nothing else. Every capability lives in a module that can be reasoned
 * about on its own (host probing, reach planes, the picker, the daemon client, signature
 * verification, installation, the ledger, the UI); `main.ts` decides what talks to what, and owns
 * the one thing none of them can: the order things happen in at `onload`, and the fact that
 * `onunload` leaves nothing behind.
 *
 * The teardown rule is not aspirational. modkit's whole pitch is that generated code goes through
 * Obsidian's reclaim contract, and a tool that leaks while enforcing the opposite has no standing.
 * So: no bare listeners, no bare intervals, no assignment to a host object that is not undone
 * through `this.register`.
 *
 * ## The one piece of policy this file does own: the review gate
 *
 * `installVerified` is the only place in modkit where a generated mod becomes bytes in the vault,
 * and it is therefore where the last gate lives. Before the first write, {@link ReviewModal} shows
 * the user the request, the resolved target, the model's explanation, any non-blocking validator
 * findings, and the **whole source** — and nothing is written unless they say yes. It defaults on.
 *
 * The modal now **leads** with the mod's effects declaration — what it does to things that are not
 * itself, read out of the signed payload — because that is the part of a generated plugin a person
 * can actually adjudicate. And the promise it makes about the enable is now the promise the install
 * path keeps: with "Enable a mod once it is installed" off, the installer is called with
 * `{ enable: false }` and the mod is never enabled, rather than being enabled and switched off a
 * moment later with its `onload` already run. See {@link ModkitPlugin.honourLeaveDisabled}.
 *
 * That is not belt-and-braces. Upstream, the daemon's validator is a hard gate with exactly one
 * correction turn, so it is the only thing between a model's output and an installed, enabled
 * plugin — and it has been found fail-open in four consecutive adversarial rounds, each on a shape
 * nobody had enumerated. It is a good filter and it is not a security boundary, and a gate that only
 * a machine can pass is one enumeration gap away from no gate at all. Nothing in this path assumes
 * the validator was right.
 */

import { Notice, Platform, Plugin, apiVersion, normalizePath } from "obsidian";
import type { PluginManifest } from "obsidian";

import { targetKey, targetVersion } from "@modkit/types";
import type {
	ArtifactPayload,
	ClientEnvironment,
	ModelOverride,
	GenerateRefusal,
	GenerateRequest,
	ModHealthState,
	ModRecord,
	PickEvidence,
	ReachDom,
	RegenerateRequest,
	RegenerationOrigin,
	SignedArtifact,
	TargetRef,
	ValidationFinding,
} from "@modkit/types";

import { Host } from "./host/host";
import { Supervisor, checkDomReachWithRetry } from "./host/supervisor";

import { ModStore, makeHealth } from "./install/modstore";
import { ModInstaller } from "./install/installer";
import type { InstallableMod, ModRecordSeed } from "./install/installer";

import { SettingsStore, requiresReview } from "./settings/settings";
import { ModkitSettingsTab } from "./settings/SettingsTab";
import type { ModActions } from "./settings/SettingsTab";

import { DaemonClient, newIdempotencyKey } from "./daemon/client";
import type { DaemonError, JobOutcome } from "./daemon/client";
import { configureEd25519, verifyArtifact } from "./daemon/verify";

import { ElementPicker } from "./picker/picker";
import type { PickedTarget } from "./picker/picker";

import { ComposeModal, targetDisplayName } from "./ui/ComposeModal";
import type { ComposeCandidate, ComposeTarget } from "./ui/ComposeModal";
import { TargetSuggestModal, toPluginTargets } from "./ui/TargetSuggestModal";
import type { PluginTarget } from "./ui/TargetSuggestModal";
import { ProgressSurface } from "./ui/progress";
import { injectUiStyles } from "./ui/ui.css";
import { readEffectsDeclaration, reviewGeneratedMod } from "./ui/ReviewModal";
import type { ReviewSubject } from "./ui/ReviewModal";
import { CUSTOMIZE_ICON, registerCustomizeContextMenu } from "./ui/contextmenu";

import { EXPERIMENTS, runExperiment } from "./experiments";

/** What a generated mod pushes back through `app.plugins.plugins.modkit.modkitReportHealth`. */
interface ModStatusPush {
	modId: string;
	state: ModHealthState;
	detail: string;
	invocations: number;
	targetVersionSeen: string | null;
}

/**
 * A mod that fires on every keystroke would otherwise rewrite `data.json` on every keystroke — and
 * on a synced vault that is a sync storm, not a log. State and detail changes always persist; a
 * bare invocation count is worth at most one write per mod per this interval.
 */
const HEALTH_WRITE_THROTTLE_MS = 30_000;

export default class ModkitPlugin extends Plugin {
	host!: Host;
	supervisor!: Supervisor;
	settingsStore!: SettingsStore;
	modStore!: ModStore;
	installer!: ModInstaller;
	progress!: ProgressSurface;
	picker!: ElementPicker;
	client!: DaemonClient;

	/** The compose state a retry reopens. Not persisted — a retry only makes sense in this session. */
	private lastCompose: { target: ComposeTarget; request: string } | null = null;
	private readonly lastHealthWrite = new Map<string, { state: ModHealthState; detail: string; at: number }>();
	/** Debounce handle for the core-target plane-E recheck below; 0 means nothing pending. */
	private layoutChangeRecheck = 0;

	/**
	 * The lifetime of every daemon wait modkit is holding, aborted in `onunload`.
	 *
	 * A generation has a twelve-minute budget, and the client's polling loop is the one thing in
	 * modkit that can still be running long after the user disabled the plugin. Without this, an
	 * in-flight job carried on polling and then ran the whole continuation — writing a plugin folder
	 * into the vault and *enabling* it — minutes after modkit was unloaded. `DaemonClient` honours the
	 * signal on every path (see its `PollOptions.signal`); the guards after each `await` below are the
	 * second half, because an abort must not merely stop the wait, it must stop the continuation.
	 */
	private jobs = new AbortController();

	override async onload(): Promise<void> {
		// Before anything reads a signature. Idempotent, and cheap enough to do unconditionally.
		configureEd25519();

		// Armed first, so a wait started anywhere below is already covered. A fresh controller per
		// load: an `AbortController` cannot be un-aborted, and Obsidian may load this instance again.
		const jobs = new AbortController();
		this.jobs = jobs;
		this.register(() => jobs.abort());

		this.host = new Host(this.app);
		// Once, loudly. A fatal defect here means `app.plugins` is not the shape modkit installs
		// through, and the user needs to know that before a command fails halfway.
		this.host.probe({ notify: true });

		// Both stores register a callback on the one shared `DataFile` (kept in a `WeakMap` keyed on
		// this plugin, so nothing outlives us regardless). Registering on a long-lived object is an
		// acquisition all the same, and modkit's whole standing rests on releasing its own: each
		// store's `dispose()` detaches it and drops its listeners, and this is where it belongs.
		this.settingsStore = new SettingsStore(this);
		this.register(() => this.settingsStore.dispose());
		await this.settingsStore.load();

		this.modStore = new ModStore(this);
		this.register(() => this.modStore.dispose());
		const loaded = await this.modStore.load();
		if (!loaded.ok) {
			new Notice(`modkit: ${loaded.error.message}`, 0);
		}

		this.installer = new ModInstaller(this.app, this.host, this.modStore);
		this.addChild(this.installer);

		this.supervisor = new Supervisor(this.host, {
			onEvent: (modId, event, detail) => {
				switch (event) {
					case "reapplied": {
						// A plane-E mod's target just re-rendered — "reapplied" is honest about the JS
						// patch, but a CSS selector living on a target's own view can just as easily
						// have moved. Re-run the same DOM check the install path does, rather than
						// assuming "reapplied" means "still doing anything" (L2, PLAN.md 2026-09-02).
						const record = this.modStore.get(modId);
						if (record !== null && record.reach.plane === "E") {
							void this.verifyDomReach(modId, record.reach, record.name);
						} else {
							void this.modStore.setHealth(modId, makeHealth("applied", detail));
						}
						break;
					}
					case "reload-failed":
						void this.modStore.setHealth(modId, makeHealth("error", detail));
						break;
					default:
						this.settingsStore.debug("supervisor", { modId, event, detail });
				}
			},
		});
		this.addChild(this.supervisor);

		this.client = new DaemonClient({
			baseUrl: this.settingsStore.settings.daemonBaseUrl,
			token: this.settingsStore.settings.daemonToken,
			requestTimeoutMs: this.settingsStore.settings.requestTimeoutMs,
		});
		this.register(
			this.settingsStore.subscribe((data) => {
				this.client.update({
					baseUrl: data.settings.daemonBaseUrl,
					token: data.settings.daemonToken,
					requestTimeoutMs: data.settings.requestTimeoutMs,
				});
			}),
		);

		this.progress = new ProgressSurface(this, {
			onRetry: (request) => {
				this.retry(request);
			},
			onIdle: () => {
				this.openModList();
			},
		});
		this.addChild(this.progress);

		// Into the MAIN window's document, never `activeDocument`: a plugin (re)loaded while Settings —
		// a separate window — is focused would otherwise style Settings and leave every modal in the
		// main window bare (measured 2026-09-03: unstyled chips, a 174-px textarea). Popouts get their
		// own copy as they open; `injectUiStyles` registers each sheet's removal on this plugin.
		injectUiStyles(this, document);
		this.registerEvent(
			this.app.workspace.on("window-open", (_workspaceWindow, win: Window) => {
				injectUiStyles(this, win.document);
			}),
		);
		// The review modal's sheet is deliberately NOT injected here — it is modal-scoped, injected on
		// open and removed on close by `ReviewModal` itself, the same shape as the picker's. A
		// plugin-level sheet would be a second permanent `data-modkit-style` element for a surface
		// that is on screen for a minute at a time.
		// The picker's stylesheet is deliberately NOT injected here. It is session-scoped by design:
		// `injectPickerStyles` removes every sheet already carrying its id before injecting, and each
		// `PickSession` injects on its own `Component` — so a plugin-level sheet is destroyed by the
		// first pick, leaving the plugin holding a teardown for a detached node and no picker CSS
		// mounted at all. It also put a body-wide `cursor: crosshair` rule outside pick mode, which is
		// the one thing picker.css.ts exists to prevent.
		this.picker = new ElementPicker(this.app, this);

		this.addSettingTab(
			new ModkitSettingsTab(this.app, this, { store: this.settingsStore, mods: this.modActions() }),
		);

		this.addCommand({
			id: "mod-this",
			name: "Mod this…",
			callback: () => {
				void this.modThis();
			},
		});
		// Ungated 2026-09-04. This waited behind "Debug logging" on one stated condition — that no
		// patch on a third-party plugin had been carried across a real update of that plugin — and
		// E3 met it: `modkit-mod-tasks-c7e839` carried, unregenerated, across Tasks 7.14.0 → 7.24.0
		// → 8.0.0 → 8.4.0, including the major, and came off cleanly on the far side. The supervisor
		// re-applied it onto each new class object.
		//
		// The reporting defect E3 also found is fixed rather than accepted, and that is the other
		// half of why this is open: a member patch no longer reports `applied` before anything has
		// gone through it (see `installHealthState`), so the first thing this command can now do to
		// a user is not to lie to them about a mod that has not done anything yet.
		this.addCommand({
			id: "mod-plugin",
			name: "Mod plugin…",
			callback: () => {
				this.modPlugin();
			},
		});
		this.addCommand({
			id: "show-mods",
			name: "Show mods",
			callback: () => {
				this.openModList();
			},
		});

		// The ribbon icon is the primary entrance on mobile — there is no right-click there — and a
		// secondary one on desktop, alongside the command and "Customize…". Unconditional: an icon
		// costs nothing to show on either platform, unlike the context-menu listeners below.
		this.addRibbonIcon(CUSTOMIZE_ICON, "Customize…", () => {
			void this.modThis();
		});

		// Desktop-only: there is no right-click to capture on mobile, and a capture-phase listener
		// with nothing pointing at it is just dead weight. See ui/contextmenu.ts for the whole design.
		if (Platform.isDesktop) {
			registerCustomizeContextMenu(this, {
				app: this.app,
				picker: this.picker,
				onPicked: (picked) => {
					void this.modThis(picked);
				},
			});
		}

		this.registerExperimentCommands();

		// Reconciliation and supervision both want the workspace settled: `listModDirectories` reads
		// the vault, and tracking a mod whose plugin has not loaded yet reports a spurious no-effect.
		this.app.workspace.onLayoutReady(() => {
			void this.reconcile();
		});

		// A plane-E mod targeting Obsidian's own UI has no plugin class for `Supervisor` to watch, so
		// its `reapplied` event can never fire — every mod installed so far targets core (README.md
		// 2026-09-02), which makes that self-heal path dead for the whole measured population (review
		// finding, PLAN.md 2026-09-02, medium). `layout-change` is the signal a core target's own
		// re-render actually produces. Debounced so a resize or a tab drag does not requery on every
		// frame, and `register`ed so an unload mid-debounce cannot fire into a torn-down plugin.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				window.clearTimeout(this.layoutChangeRecheck);
				this.layoutChangeRecheck = window.setTimeout(() => {
					for (const record of this.modStore.all()) {
						if (record.target.kind === "core") this.recheckPlaneEIfApplicable(record);
					}
				}, 1000);
			}),
		);
		this.register(() => window.clearTimeout(this.layoutChangeRecheck));
	}

	override onunload(): void {
		// Everything acquired above went through addChild/register/addCommand/addSettingTab, all of
		// which Obsidian reclaims. This override exists to say that deliberately rather than by
		// omission — and because the picker holds a session that must not outlive us. The in-flight
		// daemon waits are aborted by the `this.register` armed in `onload`, which runs after this.
		this.picker?.cancel("unloaded");
	}

	/** LiveSync rewrites `data.json` under us; both in-memory views are then stale. */
	override onExternalSettingsChange(): void {
		void this.settingsStore.reload();
		void this.modStore.handleExternalChange();
	}

	/* ── The Phase-0 experiments ────────────────────────────────────────────── */

	/**
	 * Register E2 (E1 shipped, ran, and was removed 2026-09-01), hidden unless developer mode is on.
	 *
	 * It is Phase 0's whole point and nobody has run it yet, so it must stay findable and
	 * runnable. What it must *not* be is one fuzzy match on "experiment" away from an ordinary
	 * user who opened the command palette: E2 disables and re-enables a plugin the user actually
	 * relies on. That is not destructive; it is disturbing, and a palette hit is not a decision.
	 *
	 * `checkCallback` rather than conditional registration, for three reasons that all bite:
	 *
	 * - it is the documented mechanism — a command whose check returns `false` is not listed and
	 *   cannot be invoked, so the gate is Obsidian's rather than ours;
	 * - it reads the setting **at palette time**, so toggling developer mode takes effect on the next
	 *   keystroke with no add/remove bookkeeping and no chance of the two drifting;
	 * - `Plugin.removeCommand` does not document whether it wants the prefixed or the bare id, and
	 *   guessing wrong there fails silently — a command that stays registered while we believe we
	 *   removed it is precisely the failure this whole change exists to prevent.
	 *
	 * The consent modal in `experiments/index.ts` is untouched and still runs on every invocation:
	 * this is a second gate in front of it, not a replacement for it.
	 */
	private registerExperimentCommands(): void {
		for (const definition of EXPERIMENTS) {
			this.addCommand({
				id: definition.commandId,
				name: definition.commandName,
				checkCallback: (checking: boolean): boolean => {
					if (!this.settingsStore.settings.debugLogging) return false;
					if (checking) return true;
					void runExperiment(this, definition.id);
					return true;
				},
			});
		}
	}

	/* ── Health ─────────────────────────────────────────────────────────────── */

	/**
	 * The push half of mod health. A generated mod calls this through two optional chains, so it is
	 * free to be absent; when it is present it must never throw back into the mod's own patch.
	 */
	modkitReportHealth(modId: string, status: ModStatusPush): void {
		try {
			if (typeof modId !== "string" || modId === "") return;
			const state: ModHealthState = status?.state ?? "error";
			const detail = typeof status?.detail === "string" ? status.detail : "";

			const previous = this.lastHealthWrite.get(modId);
			const changed = previous === undefined || previous.state !== state || previous.detail !== detail;
			if (!changed && Date.now() - previous.at < HEALTH_WRITE_THROTTLE_MS) return;
			this.lastHealthWrite.set(modId, { state, detail, at: Date.now() });

			const extras: { targetVersionSeen?: string | null; invocations?: number } = {};
			if (status?.targetVersionSeen !== undefined) extras.targetVersionSeen = status.targetVersionSeen;
			if (typeof status?.invocations === "number") extras.invocations = status.invocations;

			void this.modStore.setHealth(modId, makeHealth(state, detail, extras));
		} catch (err) {
			console.error("modkit: a mod's health report could not be recorded", err);
		}
	}

	/* ── Startup reconciliation ─────────────────────────────────────────────── */

	private async reconcile(): Promise<void> {
		const report = await this.modStore.reconcile(this.installer);
		if (report.ok) {
			const { missing, orphans, divergent } = report.value;
			if (missing.length > 0 || orphans.length > 0 || divergent.length > 0) {
				this.settingsStore.debug("reconcile", report.value);
			}
		} else {
			console.warn("modkit: could not reconcile the mod ledger —", report.error.message);
		}

		for (const record of this.modStore.all()) {
			if (record.target.kind === "plugin") this.supervisor.track(record.modId, record.target.pluginId);
			// A plane-E mod's own `onload` publishes `applied` unconditionally the moment it loads (see
			// the daemon's `modkitPublish` template) — there is no DOM check baked into a generated
			// mod, only into modkit itself. Left alone, that publish is the LAST word on every restart,
			// so a `no-effect` verdict from last session never survives one. This recheck runs after
			// that publish (layout is ready well after `onload`) and is free to demote it right back,
			// which is the review-found gap this closes (PLAN.md 2026-09-02, high finding #3).
			this.recheckPlaneEIfApplicable(record);
		}
		// The ledger may have changed under reconciliation; the settings tab reads the other store.
		void this.settingsStore.reload();
	}

	/* ── Entry points ───────────────────────────────────────────────────────── */

	/**
	 * "Mod this…" — point at something, then describe the change.
	 *
	 * `picked`, when given, is a target "Customize…" already resolved (a right-click via
	 * {@link registerCustomizeContextMenu}, or a future mobile tap) — this is the one compose path
	 * every entrance shares, so it skips straight to `compose()` rather than opening the picker
	 * overlay a second time over a target the caller already has.
	 */
	private async modThis(picked?: PickedTarget): Promise<void> {
		const target = picked ?? (await this.picker.pick({ prompt: "Click the thing you want to change" }));
		if (target === null) return; // cancelling is a normal outcome, not an error
		this.compose(this.composeFromPick(target));
	}

	/** "Mod plugin…" — skip the pointing and choose a plugin by name. */
	private modPlugin(): void {
		const installed = this.host.listInstalledPlugins();
		const plugins = toPluginTargets(installed, (id) => this.modCountFor(id));
		new TargetSuggestModal(this.app, {
			plugins,
			onChoose: (plugin) => {
				this.compose(this.composeFromPlugin(plugin));
			},
		}).open();
	}

	private openModList(): void {
		const setting = this.app.setting;
		if (setting?.open === undefined || setting.openTabById === undefined) {
			new Notice("Open Settings → modkit to see your patches.");
			return;
		}
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private retry(request: string): void {
		const last = this.lastCompose;
		if (last === null) {
			new Notice("modkit no longer has that request — start again with “Mod this…”.");
			return;
		}
		this.compose(last.target, request);
	}

	/* ── Compose → generate → verify → install ──────────────────────────────── */

	private compose(target: ComposeTarget, initialRequest?: string): void {
		this.lastCompose = { target, request: initialRequest ?? "" };
		new ComposeModal(this.app, {
			target,
			...(initialRequest !== undefined && initialRequest !== "" ? { initialRequest } : {}),
			onSubmit: (request) => {
				// Before the modal closes, so there is never a frame with nothing on screen.
				this.progress.start({ request, targetLabel: composeLabel(target) });
				this.lastCompose = { target, request };
				void this.generate(target, request);
			},
			onCancel: (draft) => {
				this.lastCompose = { target, request: draft };
			},
			onRetarget: () => {
				this.modPlugin();
			},
			onRepick: () => {
				void this.modThis();
			},
		}).open();
	}

	private async generate(target: ComposeTarget, request: string): Promise<void> {
		const blockers = this.blockers();
		if (blockers !== null) {
			this.progress.failed({ message: blockers, retryable: false, code: "settings" });
			return;
		}

		const pinned = this.pinnedKey();
		const payload: Omit<GenerateRequest, "protocol"> = {
			...this.modelOverride(),
			idempotencyKey: newIdempotencyKey(),
			request,
			target: target.target,
			client: this.environment(),
			...(target.evidence !== undefined ? { evidence: target.evidence } : {}),
			...(target.reach !== undefined ? { proposedReach: target.reach } : {}),
			...(pinned !== null ? { pinnedRootPubkey: pinned } : {}),
		};

		const outcome = await this.client.generateAndWait(payload, {
			signal: this.jobs.signal,
			onProgress: (job) => {
				this.progress.applyJob(job);
			},
		});
		// modkit was unloaded while the daemon was working. There is no surface left to report into,
		// and installing now would write and enable a plugin folder on behalf of a disabled plugin.
		if (this.abandoned("generate")) return;
		await this.settleOutcome(outcome, target, request);
	}

	/**
	 * Has modkit been unloaded since the wait started? Every `await` that a vault write sits behind
	 * asks this, because the abort stops the *waiting* and only this stops the *continuation*.
	 */
	private abandoned(where: string): boolean {
		if (!this.jobs.signal.aborted) return false;
		console.info(`modkit: dropping ${where} — the plugin was unloaded while the daemon was working`);
		return true;
	}

	private async settleOutcome(
		outcome: { ok: true; value: JobOutcome } | { ok: false; error: DaemonError },
		target: ComposeTarget,
		request: string,
	): Promise<void> {
		if (!outcome.ok) {
			this.progress.failed(outcome.error);
			return;
		}
		if (outcome.value.kind === "refused") {
			// A refusal is the product working. It gets the same care as a success: the daemon's own
			// explanation, verbatim, and no "error" framing.
			this.refused(outcome.value.refusal);
			return;
		}

		const built = outcome.value.result;
		const jobId = outcome.value.job.id;
		const verified = await this.verify(built.artifact, built.modId, target.target);
		if (verified === null) return;

		await this.installVerified(verified, {
			request,
			jobId,
			...(built.warnings !== undefined ? { warnings: built.warnings } : {}),
			...(target.evidence !== undefined ? { evidence: target.evidence } : {}),
		});
	}

	/**
	 * Fail closed: on any verification failure nothing is written, and the bytes that *are* written
	 * come from the verified payload rather than a second decode of the same envelope.
	 */
	private async verify(
		artifact: SignedArtifact,
		modId: string,
		target: TargetRef,
	): Promise<ArtifactPayload | null> {
		const settings = this.settingsStore.settings;
		const pinned = this.pinnedKey();

		if (!settings.requireSignature) {
			// Explicitly opted out. Decode without trusting, and say so — silence here would make an
			// unsigned install indistinguishable from a signed one.
			const decoded = decodeUnverified(artifact);
			if (decoded === null) {
				this.progress.failed({
					message: "modkit could not read the artifact the daemon returned.",
					retryable: true,
					code: "malformed",
				});
				return null;
			}
			new Notice("Signature checking is off, so this patch was installed without being verified.", 8000);
			return decoded;
		}

		if (pinned === null) {
			this.progress.failed({
				message: "modkit has no daemon public key pinned, and signature checking is on.",
				detail: "Settings → modkit → Daemon public key. The daemon prints its key on /v1/health.",
				retryable: false,
				code: "unpinned",
			});
			return null;
		}

		const result = await verifyArtifact(artifact, {
			rootPubkeyHex: pinned,
			modId,
			targetKey: targetKey(target),
		});
		if (!result.ok) {
			this.progress.failed({
				message: `modkit refused the artifact: ${result.message}`,
				detail: `${result.check} — ${result.detail}`,
				retryable: false,
				code: result.code,
			});
			return null;
		}
		return result.payload;
	}

	/**
	 * Show the user what is about to run, and get a yes.
	 *
	 * Called from exactly one place — immediately before the first byte is written — so a `false`
	 * here means *nothing happened*, not *something was undone*. That ordering is the whole
	 * guarantee the review makes, and it is why the gate lives here rather than inside the installer,
	 * which by then has already created a folder.
	 *
	 * This is defence in depth and it is deliberately not a machine. The daemon's validator is a
	 * hard gate with one correction turn, which means a model that fails once gets a second attempt
	 * with the findings in hand — and four consecutive adversarial rounds have found that validator
	 * fail-open, each time on a shape nobody had enumerated. Nothing here depends on it being right.
	 */
	private async review(
		payload: ArtifactPayload,
		context: { request: string; warnings?: readonly ValidationFinding[] },
	): Promise<boolean> {
		const warnings = context.warnings;
		// Reading it off the *verified* payload is the point: a declaration carried anywhere else
		// would be editable by anything that could edit the artifact, and the review would be
		// adjudicating a claim nobody signed.
		const effects = readEffectsDeclaration(payload.effects);
		const subject: ReviewSubject = {
			// The plugin's own copy of the sentence, not `payload.request`: the artifact's echo came
			// back over the wire, and the modal's job is to show the user what *they* typed. The echo
			// is passed alongside so the modal can say so when the two disagree.
			request: context.request,
			echoedRequest: payload.request,
			modId: payload.modId,
			modName: payload.manifest.name,
			target: payload.target,
			reach: payload.reach,
			explanation: payload.explanation,
			mainJs: payload.mainJs,
			sha256: payload.sha256,
			outcome: this.settingsStore.settings.autoEnableGeneratedMods ? "enable" : "install-only",
			...(effects !== undefined ? { effects } : {}),
			...(payload.stylesCss !== undefined ? { stylesCss: payload.stylesCss } : {}),
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
		};
		return reviewGeneratedMod(this.app, subject);
	}

	private async installVerified(
		payload: ArtifactPayload,
		context: { request: string; jobId?: string; evidence?: PickEvidence; warnings?: readonly ValidationFinding[] },
	): Promise<void> {
		// The last gate before the vault is touched: verification is itself asynchronous, so the
		// unload can land between the poll's guard and here.
		if (this.abandoned("an install")) return;

		if (requiresReview(this.settingsStore.settings)) {
			this.progress.note("Waiting for you to read the code");
			const approved = await this.review(payload, {
				request: context.request,
				...(context.warnings !== undefined ? { warnings: context.warnings } : {}),
			});
			// The review is an unbounded wait — the user may leave it open for an hour — so the
			// unload guard is asked again on the far side of it, before anything is written.
			if (this.abandoned("an install")) return;
			if (!approved) {
				// Nothing was written, so there is nothing to undo and nothing to retry against. Say
				// that plainly rather than leaving a status bar that looks like a job stalled.
				this.progress.note("Cancelled — nothing was written to your vault");
				this.progress.clear();
				new Notice(`“${payload.manifest.name}” was not installed. Nothing was written.`, 8000);
				return;
			}
		}

		this.progress.installing("Writing the patch into the vault");

		const artifact: InstallableMod = {
			modId: payload.modId,
			manifest: payload.manifest,
			mainJs: payload.mainJs,
			sha256: payload.sha256,
			...(payload.stylesCss !== undefined ? { stylesCss: payload.stylesCss } : {}),
		};

		const seed: ModRecordSeed = {
			modId: payload.modId,
			name: payload.manifest.name,
			request: context.request,
			target: payload.target,
			reach: payload.reach,
			targetVersionRange: payload.targetVersionRange,
			explanation: payload.explanation,
			generator: payload.generator,
			...(context.evidence !== undefined ? { evidence: context.evidence } : {}),
			...(context.jobId !== undefined ? { jobId: context.jobId } : {}),
		};

		// The setting the review just made a promise about. `enable: false` is not "enable then
		// switch off": the installer never asks Obsidian to load it, so the mod's `onload` does not
		// run and nothing it would have done on load happens. See `honourLeaveDisabled` below.
		const autoEnable = this.settingsStore.settings.autoEnableGeneratedMods;
		const result = await this.installer.install(artifact, seed, { enable: autoEnable });
		if (!result.ok) {
			const detail = detailText(result.error.detail);
			this.progress.failed({
				message: result.error.message,
				...(detail !== undefined ? { detail } : {}),
				retryable: result.error.code !== "host-unavailable",
				code: result.error.code,
			});
			return;
		}

		for (const warning of result.warnings) new Notice(`modkit: ${warning}`, 8000);

		if (payload.target.kind === "plugin") {
			this.supervisor.track(payload.modId, payload.target.pluginId);
		}
		void this.settingsStore.reload();
		this.progress.applied({ modId: payload.modId, name: payload.manifest.name });
		if (!autoEnable) this.honourLeaveDisabled(payload.modId, payload.manifest.name, result.enabled);
		// L2: "a no-effect is a ledger row, not a toast" (PLAN.md 2026-09-02) — `progress.applied`
		// above already told the user "patch applied"; this corrects that for a plane-E mod that is
		// live but pointed at nothing, on the ledger row `SettingsTab` actually reads from.
		//
		// `result.live`, not just `result.enabled`, gates this: `enabled` is true the moment the
		// loader is *asked*, but the manifest-not-indexed path returns `enabled: true, live: false`
		// with no `onload` having run at all. A review found that checking `enabled` alone let this
		// method's own DOM match overwrite `recordInstall`'s honest `no-effect` with a false `applied`
		// a moment later, once the target rendered on its own — proving nothing about the mod's code.
		if (result.enabled && result.live && payload.reach.plane === "E") {
			void this.verifyDomReach(payload.modId, payload.reach, payload.manifest.name);
		}
	}

	/**
	 * Wait for layout, then count live matches for a plane-E mod's selector and record the verdict.
	 * Called from every place that might make a plane-E mod's target appear or disappear: right after
	 * install/enable, a manual re-enable from the mod list, "Check now", a startup recheck, a core
	 * target's own re-render, and whenever the supervisor reapplies a mod across a target reload. See
	 * {@link checkDomReachWithRetry} for what is and is not checked.
	 *
	 * **Refines, never asserts.** A live selector match proves the target *exists*, not that this
	 * mod's own code ran — a css rule can land in the wrong window (see `checkDomReach`'s
	 * `cssRuleAttached`) and a target that already existed before the mod ever patched anything would
	 * match regardless. A review found the previous version wrote `applied` unconditionally, which let
	 * a later match overwrite an honest `no-effect` (a half-loaded install) or a mod's own `error` —
	 * the exact silent-no-op lie this feature exists to kill, just moved one layer up (PLAN.md
	 * 2026-09-02). So: zero matches may always demote to `no-effect` — that is this function's whole
	 * job. A match may only be written as `applied` when the row already reads `applied`; promotion is
	 * earned elsewhere, by `recordInstall`'s own live-confirmation or the mod's own runtime report.
	 * And nothing is written at all when neither the state nor the detail actually changed, so a
	 * repeated recheck (layout-change, a startup sweep) does not re-fire the no-effect `Notice` below
	 * on every call.
	 */
	private verifyDomReach(modId: string, reach: ReachDom, name: string): void {
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				const result = await checkDomReachWithRetry(window, reach, { stylesCss: await this.readModStyles(modId) });
				if (this.abandoned("a health check")) return;

				const current = this.modStore.get(modId)?.health;
				if (result.state === "applied" && current?.state !== "applied") return;
				if (current?.state === result.state && current?.detail === result.detail) return;

				void this.modStore.setHealth(modId, makeHealth(result.state, result.detail));
				if (result.state === "no-effect") new Notice(`“${name}”: ${result.detail}`, 8000);
			})();
		});
	}

	/**
	 * The mod's own `styles.css`, as the installer wrote it — so `checkDomReach` can test "is this
	 * mod's stylesheet in this window" by equality instead of by whether the model happened to repeat
	 * the selector verbatim. `undefined` when there is none (a `dom`-mode mod) or it cannot be read;
	 * the check then falls back to the substring heuristic rather than failing.
	 */
	private async readModStyles(modId: string): Promise<string | undefined> {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${modId}/styles.css`);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return undefined;
			return await this.app.vault.adapter.read(path);
		} catch {
			return undefined;
		}
	}

	/** The shared trigger for every recheck site below: only plane-E, and only while enabled. */
	private recheckPlaneEIfApplicable(record: ModRecord): void {
		if (record.enabled && record.reach.plane === "E") this.verifyDomReach(record.modId, record.reach, record.name);
	}

	/**
	 * Say — and check — that "Enable a mod once it is installed → off" meant what the review promised.
	 *
	 * **What this used to do, and why it was wrong.** `ModInstaller.install` always enabled, so this
	 * method enabled-then-disabled: it called `setEnabled(modId, false)` a moment after the mod had
	 * been switched on. The mod's `onload` therefore ran. Its patch installed, and anything it does
	 * on load — rewriting a note, trashing a file, sending a request — had already happened by the
	 * time it was switched off. Meanwhile the review modal was promising "written to disk and left
	 * off until you turn it on", and the mod list reported "installed and left disabled". Every
	 * surface agreed, and all of them were describing something that had not happened.
	 *
	 * That was survivable when the only question was reclaim — the patch really did come back off.
	 * It is not survivable on the effects axis, which is the whole point of this setting: a person
	 * who switches auto-enable off is saying *do not run generated code until I have looked at it*,
	 * and an effect cannot be un-run.
	 *
	 * So the fix is upstream, in the installer: `{ enable: false }` never asks Obsidian to load the
	 * folder, and Obsidian loads only what is in `community-plugins.json`. This method is now what
	 * is left over — a check that the install really did leave it off, and the sentence that says
	 * so. It asks the host rather than trusting the return value, because "is it running" is the
	 * one claim here worth reading off reality.
	 */
	private honourLeaveDisabled(modId: string, name: string, reportedEnabled: boolean): void {
		const running = reportedEnabled || this.host.isPluginEnabled(modId) || this.host.isPluginLoaded(modId);
		if (running) {
			// Not reachable through `install({ enable: false })`, which fails closed if it cannot get
			// the mod switched off. Kept because the alternative to a check that never fires is a
			// promise nobody checks: if this ever fires, the review told the user something false.
			new Notice(
				`“${name}” was written and it is running, even though “Turn a new patch on once it is installed” is off. Its code has loaded. Switch it off in Settings → modkit.`,
				0,
			);
			this.progress.note(`${name} is installed and running — it should not be`);
			return;
		}
		this.progress.note(`${name} is installed and switched off — none of its code has run`);
		new Notice(
			`“${name}” is installed and left switched off; none of its code has run. Turn it on in Settings → modkit.`,
			8000,
		);
	}

	private refused(refusal: GenerateRefusal): void {
		this.progress.refused(refusal);
	}

	/* ── The settings tab's actions ─────────────────────────────────────────── */

	private modActions(): ModActions {
		return {
			setEnabled: async (modId, enabled) => {
				const result = await this.installer.setEnabled(modId, enabled);
				if (!result.ok) throw new Error(result.error.message);
				void this.settingsStore.reload();
				// A mod installed with auto-enable off is switched on for the first time right here,
				// and `installVerified`'s own check never ran for it (it only fires when `install`
				// itself enabled the mod) — without this it would go unchecked forever (review finding,
				// PLAN.md 2026-09-02, medium). `result.enabled` is the outcome, not the request: an
				// enable Obsidian actually refused must not trigger a check for a mod that never loaded.
				if (result.enabled) {
					const record = this.modStore.get(modId);
					if (record !== null) this.recheckPlaneEIfApplicable(record);
				}
			},
			uninstall: async (modId) => {
				const result = await this.installer.uninstall(modId);
				if (!result.ok) throw new Error(result.error.message);
				this.supervisor.untrack(modId);
				this.lastHealthWrite.delete(modId);
				for (const warning of result.warnings) new Notice(`modkit: ${warning}`, 8000);
				void this.settingsStore.reload();
			},
			regenerate: async (modId) => {
				await this.regenerate(modId);
			},
			refreshHealth: async () => {
				this.supervisor.checkNow("user asked");
				const result = await this.modStore.reconcile(this.installer);
				if (!result.ok) throw new Error(result.error.message);
				await this.settingsStore.reload();
				// "Check now" only asked the supervisor about target-identity changes above; a plane-E
				// mod has no prototype for it to watch, so it needs its own recheck here too.
				for (const record of this.modStore.all()) this.recheckPlaneEIfApplicable(record);
			},
		};
	}

	/**
	 * Regenerate from the stored request against the target's *current* version — DESIGN §5. The
	 * patch is not repaired; the intent is re-run. Which is why the request, not the code, is the
	 * thing the ledger keeps.
	 */
	private async regenerate(modId: string): Promise<void> {
		const record = this.modStore.get(modId);
		if (record === null) throw new Error(`modkit has no record for "${modId}".`);

		const blockers = this.blockers();
		if (blockers !== null) throw new Error(blockers);

		const target = this.currentTargetFor(record);
		const origin: RegenerationOrigin = {
			modId,
			previousTargetVersion: targetVersion(record.target),
			trigger: "user-requested",
			assertionsFrozen: record.userVerifiedAt !== undefined,
		};

		this.progress.start({ request: record.request, targetLabel: targetDisplayName(target) });

		const payload: Omit<RegenerateRequest, "protocol"> = {
			...this.modelOverride(),
			idempotencyKey: newIdempotencyKey(),
			modId,
			request: record.request,
			...(record.evidence !== undefined ? { evidence: record.evidence } : {}),
			proposedReach: record.reach,
			target,
			client: this.environment(),
			origin,
		};

		const accepted = await this.client.regenerate(payload, { signal: this.jobs.signal });
		if (this.abandoned("regenerate")) return;
		if (!accepted.ok) {
			this.progress.failed(accepted.error);
			throw new Error(accepted.error.message);
		}
		this.progress.attach(accepted.value.jobId);

		const outcome = await this.client.pollUntilDone(accepted.value.jobId, {
			signal: this.jobs.signal,
			onProgress: (job) => {
				this.progress.applyJob(job);
			},
		});
		if (this.abandoned("regenerate")) return;
		if (!outcome.ok) {
			this.progress.failed(outcome.error);
			throw new Error(outcome.error.message);
		}
		if (outcome.value.kind === "refused") {
			this.refused(outcome.value.refusal);
			return;
		}

		const verified = await this.verify(outcome.value.result.artifact, outcome.value.result.modId, target);
		if (verified === null) return;

		await this.installVerified(verified, {
			request: record.request,
			jobId: outcome.value.job.id,
			...(outcome.value.result.warnings !== undefined ? { warnings: outcome.value.result.warnings } : {}),
			...(record.evidence !== undefined ? { evidence: record.evidence } : {}),
		});
	}

	/* ── Small helpers ──────────────────────────────────────────────────────── */

	/**
	 * The target as it is *now*, not as it was when the mod was made. Regenerating against the
	 * recorded version would regenerate against the version that already broke.
	 */
	private currentTargetFor(record: ModRecord): TargetRef {
		if (record.target.kind !== "plugin") return { kind: "core", appVersion: apiVersion };
		const manifest: PluginManifest | null = this.host.getPluginManifest(record.target.pluginId);
		if (manifest === null) return record.target;
		return {
			kind: "plugin",
			pluginId: manifest.id,
			pluginName: manifest.name,
			pluginVersion: manifest.version,
			...(record.target.repo !== undefined ? { repo: record.target.repo } : {}),
		};
	}

	/**
	 * This vault's backend/model choice, shaped for a request — or `{}` when it has none.
	 *
	 * Returns a spreadable object rather than a `ModelOverride | undefined` so both call sites stay
	 * one line and neither can accidentally send `modelOverride: undefined`, which serialises to a
	 * key the daemon then has to tolerate. Empty strings mean "the daemon decides" and are dropped
	 * here rather than sent as empty, because `model: ""` is a *meaningful* value to the transports
	 * ("omit --model") and must not be produced by a settings field nobody filled in.
	 */
	private modelOverride(): { modelOverride?: ModelOverride } {
		const { modelBackend, modelName } = this.settingsStore.settings;
		const override: ModelOverride = {
			...(modelBackend !== "" ? { backend: modelBackend } : {}),
			...(modelName !== "" ? { model: modelName } : {}),
		};
		return Object.keys(override).length > 0 ? { modelOverride: override } : {};
	}

	private environment(): ClientEnvironment {
		return {
			modkitVersion: this.manifest.version,
			obsidianApiVersion: apiVersion,
			platform: Platform.isMobile ? "mobile" : "desktop",
			os: describeOs(),
		};
	}

	private pinnedKey(): string | null {
		const key = this.settingsStore.settings.daemonPubkey;
		return key === "" ? null : key;
	}

	/** One sentence naming what stops a request going out, or null when nothing does. */
	private blockers(): string | null {
		if (this.settingsStore.settings.daemonToken === "") {
			return "modkit has no daemon token — paste the one the daemon printed into Settings → modkit.";
		}
		if (this.settingsStore.settings.requireSignature && this.pinnedKey() === null) {
			return "modkit has no daemon public key pinned, and signature checking is on.";
		}
		return null;
	}

	private modCountFor(pluginId: string): number {
		let count = 0;
		for (const record of this.modStore.all()) {
			if (record.target.kind === "plugin" && record.target.pluginId === pluginId) count += 1;
		}
		return count;
	}

	private composeFromPick(picked: PickedTarget): ComposeTarget {
		const candidates: ComposeCandidate[] = picked.owner.candidates
			.filter((candidate) => candidate.pluginId !== pluginIdOf(picked.target))
			.map((candidate) => ({
				label: `${candidate.pluginName} (${candidate.version})`,
				why: candidate.why,
				onChoose: () => {
					this.compose(
						this.composeFromTargetRef(
							{
								kind: "plugin",
								pluginId: candidate.pluginId,
								pluginName: candidate.pluginName,
								pluginVersion: candidate.version,
							},
							picked,
						),
					);
				},
			}));

		// Name the THING the user pointed at, in its own words, and say where it lives. "Change Blog
		// Drafts · in File explorer" is what a person recognises; "Change Obsidian 1.13.7 · in Obsidian
		// 1.13.7 · file-explorer" (the first live look at the redesigned sheet, 2026-09-03) is the
		// same fact three times and the picked element nowhere.
		const label = (picked.element.label || picked.element.text || "").trim().replace(/\s+/g, " ");
		const owner = picked.owner.summary === "" ? targetDisplayName(picked.target) : picked.owner.summary;
		const name = label === "" ? owner : label.length > 48 ? `${label.slice(0, 47)}…` : label;
		const where = picked.view?.displayText;
		return {
			target: picked.target,
			name,
			detail: where !== undefined && where !== "" && where !== name ? where : owner,
			why: picked.owner.why,
			evidence: this.picker.buildEvidence([picked]),
			...(candidates.length > 0 ? { candidates } : {}),
			...(picked.reach !== undefined ? { reach: picked.reach } : {}),
		};
	}

	/** A retarget from the candidate list: same evidence, different owner. */
	private composeFromTargetRef(target: TargetRef, picked: PickedTarget): ComposeTarget {
		return {
			target,
			name: targetDisplayName(target),
			detail: picked.summary,
			why: "You chose this target yourself, over modkit's guess.",
			evidence: this.picker.buildEvidence([picked]),
		};
	}

	private composeFromPlugin(plugin: PluginTarget): ComposeTarget {
		const target: TargetRef = {
			kind: "plugin",
			pluginId: plugin.id,
			pluginName: plugin.name,
			pluginVersion: plugin.version,
		};
		return {
			target,
			name: plugin.name,
			detail: `${plugin.id} ${plugin.version}`,
			why: plugin.loaded
				? "You chose this plugin by name, and it is running."
				: "You chose this plugin by name. It is installed but not running, so modkit cannot inspect it live.",
		};
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Free functions
 * ──────────────────────────────────────────────────────────────────────────── */

function pluginIdOf(target: TargetRef): string | null {
	return target.kind === "plugin" ? target.pluginId : null;
}

function composeLabel(target: ComposeTarget): string {
	return target.name ?? targetDisplayName(target.target);
}

function detailText(detail: Record<string, string> | undefined): string | undefined {
	if (detail === undefined) return undefined;
	const parts = Object.entries(detail).map(([key, value]) => `${key}: ${value}`);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Decode without verifying. Only reachable with signature checking explicitly turned off; it exists
 * so that path is one clearly-named function rather than an inline `atob` next to the trusted one.
 */
function decodeUnverified(artifact: SignedArtifact): ArtifactPayload | null {
	try {
		const json = new TextDecoder().decode(Uint8Array.from(atob(artifact.payload), (c) => c.charCodeAt(0)));
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null ? (parsed as ArtifactPayload) : null;
	} catch {
		return null;
	}
}

function describeOs(): string {
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	return "unknown";
}
