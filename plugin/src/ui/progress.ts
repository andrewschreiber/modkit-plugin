/**
 * The progress surface — what the user sees between "generate" and "applied", which is minutes.
 *
 * Generation is far too slow to hold a modal open for, so the compose modal closes on submit and
 * everything after that happens here: a status-bar item carrying the live state, a `Notice` at each
 * transition worth interrupting for, and a receipt modal that can be reopened long after every
 * notice has faded.
 *
 * Four invariants, each of them a failure this surface exists to prevent:
 *
 * 1. **Unreachable is not finished.** A poll that could not reach the daemon marks the job *stale*
 *    and leaves its phase alone. A job must never report itself done because nobody could be asked.
 * 2. **The request text outlives the job.** Every state carries the user's sentence, so a failure
 *    can be retried without retyping it. Losing the sentence is the failure this whole flow is
 *    shaped around avoiding.
 * 3. **One label function.** The status bar, the notice and the receipt all read {@link phaseLabel},
 *    so they cannot disagree about what is happening.
 * 4. **A terminal failure never disappears on its own.** Success collapses back to idle after a
 *    while; a refusal or an error stays on the status bar until the user has seen it and dismissed
 *    it.
 *
 * This surface does not poll. Whoever owns the daemon client polls and calls {@link
 * ProgressSurface.applyJob} / {@link ProgressSurface.unreachable} — one owner of the timer, one
 * owner of the display.
 */

import { Component, Modal, Notice, Platform, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { GenerateRefusal, Job, JobError } from "@modkit/types";

/**
 * The phases modkit reports in.
 *
 * The first four mirror the daemon's `JobStatus` exactly. `installing` is ours — it covers
 * verifying the signature, writing the files and enabling the plugin, which is real work happening
 * after the daemon is finished and before anything has changed. `done` never appears here on its
 * own: a built artifact that has not been installed has not yet done what the user asked for.
 */
export type ProgressPhase =
	| "queued"
	| "generating"
	| "validating"
	| "building"
	| "installing"
	| "applied"
	| "refused"
	| "failed";

const PHASE_LABEL: Record<ProgressPhase, string> = {
	queued: "Queued",
	generating: "Writing",
	validating: "Checking",
	building: "Building",
	installing: "Installing",
	// Not "Applied": the mod list's health pill uses that word for a mod that has actually been
	// invoked, which this phase has not yet been — it only means the files are in place and the
	// plugin is switched on. Two different facts need two different words, or a mod that has never
	// run a single call reads as if it had already proven itself.
	applied: "Installed",
	// Not "Refused": the user did not do anything wrong, and modkit declining is a correct outcome
	// rather than a rejection of them.
	refused: "Can't be done",
	failed: "Failed",
};

const LIVE_PHASES: ReadonlySet<ProgressPhase> = new Set<ProgressPhase>([
	"queued",
	"generating",
	"validating",
	"building",
	"installing",
]);

/** The single source of the phase's name. Every surface reads this one. */
export function phaseLabel(phase: ProgressPhase): string {
	return PHASE_LABEL[phase];
}

/** True while the job may still change on its own. */
export function isLivePhase(phase: ProgressPhase): boolean {
	return LIVE_PHASES.has(phase);
}

/**
 * Elapsed time, at the resolution a person cares about. Rounded and coarse on purpose: a
 * millisecond-accurate counter on a multi-minute job is precision about the wrong thing.
 */
export function elapsedLabel(ms: number): string {
	if (ms < 5_000) return "just now";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface ProgressFailure {
	message: string;
	detail: string | null;
	retryable: boolean;
	code: string | null;
}

export interface ProgressRefusal {
	/** The plain-language sentence, from the daemon. */
	explanation: string;
	suggestion: string | null;
	/** The machine reason, e.g. `bound-at-construction`. */
	reason: string | null;
	detail: string | null;
}

/** Everything known about one generation, live or finished. */
export interface ProgressState {
	/** Null between submitting and the daemon returning a job id. */
	jobId: string | null;
	/** The user's sentence, verbatim. The seed for a retry. */
	request: string;
	/** What it was aimed at, for display — "Tasks", "Obsidian". */
	targetLabel: string;
	phase: ProgressPhase;
	/** The latest one-line note, from the daemon's progress or from the install steps. */
	message: string;
	startedAt: number;
	updatedAt: number;
	/** The last attempt to reach the daemon failed. The phase is deliberately unchanged. */
	stale: boolean;
	staleDetail: string | null;
	mod: { modId: string; name: string } | null;
	failure: ProgressFailure | null;
	refusal: ProgressRefusal | null;
}

export interface ProgressOptions {
	/** Offered on a failed or refused job. Receives the original request, verbatim. */
	onRetry?(request: string): void;
	/** What clicking the status bar does when there is no job to show — usually "open my mods". */
	onIdle?(): void;
}

/** A success is information, not a warning: it steps aside once it has been seen. */
const APPLIED_LINGER_MS = 30_000;
const NOTICE_STICKY = 0;
const NOTICE_SHORT_MS = 5_000;
const NOTICE_LONG_MS = 8_000;

export class ProgressSurface extends Component {
	private readonly plugin: Plugin;
	private readonly options: ProgressOptions;

	private statusEl: HTMLElement | null = null;
	private dotEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private elapsedEl: HTMLElement | null = null;

	private current: ProgressState | null = null;
	/** Kept after the current job is cleared, so the receipt is still reachable afterwards. */
	private last: ProgressState | null = null;

	/**
	 * Used only where there is no status bar (mobile). One notice narrating the whole job beats four
	 * stacked ones, and `setMessage` is what makes that possible.
	 */
	private liveNotice: Notice | null = null;

	constructor(plugin: Plugin, options: ProgressOptions = {}) {
		super();
		this.plugin = plugin;
		this.options = options;
	}

	override onload(): void {
		// `addStatusBarItem` is documented as unavailable on mobile; there the live notice carries
		// the state instead. The element belongs to the plugin, so unloading this component has to
		// take it away explicitly.
		if (Platform.isDesktopApp) {
			const el = this.plugin.addStatusBarItem();
			el.addClass("modkit-status");
			el.setAttribute("role", "button");
			this.dotEl = el.createSpan({ cls: "modkit-status__dot" });
			this.labelEl = el.createSpan({ cls: "modkit-status__label" });
			this.elapsedEl = el.createSpan({ cls: "modkit-status__elapsed" });
			this.statusEl = el;
			this.registerDomEvent(el, "click", () => {
				this.show();
			});
			this.register(() => {
				el.remove();
			});
		}

		this.registerInterval(
			window.setInterval(() => {
				this.tick();
			}, 1000),
		);
		this.render();
	}

	override onunload(): void {
		this.liveNotice?.hide();
		this.liveNotice = null;
	}

	/** The job being tracked, or the last one if nothing is running. Read-only for callers. */
	get state(): ProgressState | null {
		return this.current ?? this.last;
	}

	get isBusy(): boolean {
		return this.current !== null && isLivePhase(this.current.phase);
	}

	/* ── Transitions ──────────────────────────────────────────────────────── */

	/**
	 * Begin tracking a submission. Call this from the compose modal's `onSubmit`, **before** the
	 * modal closes, so the status bar is already showing something when it goes.
	 *
	 * The job id is usually not known yet — the POST has not returned — so it is optional and gets
	 * filled in by {@link attach} or by the first {@link applyJob}.
	 */
	start(seed: { request: string; targetLabel: string; jobId?: string }): void {
		const now = Date.now();
		this.current = {
			jobId: seed.jobId ?? null,
			request: seed.request,
			targetLabel: seed.targetLabel,
			phase: "queued",
			message: "Sending what you asked for",
			startedAt: now,
			updatedAt: now,
			stale: false,
			staleDetail: null,
			mod: null,
			failure: null,
			refusal: null,
		};
		this.notice(`Writing a patch for ${seed.targetLabel}. This takes a few minutes; you can keep working.`, NOTICE_SHORT_MS);
		// Where there is no status bar, the narrating notice has to exist from the first moment —
		// otherwise the phone shows nothing at all until the daemon's first progress line.
		this.narrate();
		this.render();
	}

	/** Record the job id once the daemon has accepted the request. */
	attach(jobId: string): void {
		if (this.current === null) return;
		this.current.jobId = jobId;
		this.current.updatedAt = Date.now();
		this.render();
	}

	/**
	 * Fold in a poll result.
	 *
	 * Ignores a job that is not the one being tracked: by the time a poll returns, the user may have
	 * dismissed it or started another, and resurrecting a superseded job is how a status bar starts
	 * lying about what it is doing.
	 */
	applyJob(job: Job): void {
		const state = this.current;
		if (state === null) return;
		if (state.jobId !== null && state.jobId !== job.id) return;

		state.jobId = job.id;
		// Reading a job at all means the daemon answered.
		this.clearStale();
		if (job.progress !== undefined) state.message = job.progress.message;

		switch (job.status) {
			case "queued":
			case "generating":
			case "validating":
			case "building":
				this.setPhase(job.status);
				return;
			case "done":
				// The artifact exists; nothing has changed in the vault yet. The caller verifies,
				// writes and enables, and reports through `note` / `applied`.
				this.setPhase("installing", state.message === "" ? "Checking the signature and putting the patch in place" : state.message);
				return;
			case "refused":
				this.refused(job.result);
				return;
			case "failed":
				this.failed(job.error);
				return;
		}
	}

	/** A one-line note about a client-side step: verifying, writing, enabling. */
	note(message: string): void {
		if (this.current === null) return;
		this.current.message = message;
		this.current.updatedAt = Date.now();
		this.narrate();
		this.render();
	}

	/** The artifact is in hand and modkit is putting it in place. */
	installing(message = "Putting the patch in place"): void {
		this.setPhase("installing", message);
	}

	/** The patch is installed and switched on — not yet the stronger claim that it has actually run. */
	applied(mod: { modId: string; name: string }): void {
		if (this.current === null) return;
		this.current.mod = mod;
		this.setPhase("applied", `${mod.name} is in place and switched on`);
		this.liveNotice?.hide();
		this.liveNotice = null;
		// Names the change, not the machinery — and quotes the patch's own name, because that is the
		// half the user will recognise a month from now. "Installed", not "applied": the mod list's
		// health pill earns that word once the mod has actually been called, which is a fact this
		// moment cannot yet claim.
		new Notice(`“${mod.name}” installed and turned on`, NOTICE_LONG_MS);
	}

	/** The daemon declined, correctly. A refusal is an answer, so it is reported, not buried. */
	refused(refusal: GenerateRefusal): void {
		if (this.current === null) return;
		// Idempotent, because two callers legitimately reach here for one job: the terminal poll
		// arrives through `applyJob`, and the caller then acts on the same outcome it was handed.
		// Without this the user gets the same sticky Notice twice.
		if (this.current.phase === "refused" && this.current.refusal?.explanation === refusal.explanation) return;
		this.current.refusal = {
			explanation: refusal.explanation,
			suggestion: refusal.suggestion ?? null,
			reason: refusal.reason,
			detail: refusal.detail,
		};
		this.setPhase("refused", refusal.explanation);
		this.liveNotice?.hide();
		this.liveNotice = null;
		new Notice(`Can't do that — ${refusal.explanation}`, NOTICE_STICKY);
	}

	/**
	 * The pipeline broke — distinct from a refusal, which is modkit working correctly.
	 *
	 * Accepts a `JobError` or any thrown value, because the transport failures the plugin sees
	 * (a socket reset, a bad signature) never arrive as one.
	 */
	failed(error: JobError | Error | { message: string; detail?: string; retryable?: boolean; code?: string }): void {
		if (this.current === null) return;
		const message = error.message === "" ? "Something went wrong writing the patch." : error.message;
		const detail = error instanceof Error ? (error.stack ?? null) : (error.detail ?? null);
		const code = error instanceof Error ? error.name : (error.code ?? null);
		const retryable = error instanceof Error ? true : error.retryable === true;

		// Same duplicate-caller reasoning as `refused()`: a failed job reaches here once through the
		// terminal poll and once through the caller acting on the error it was returned.
		if (this.current.phase === "failed" && this.current.failure?.message === message) return;

		this.current.failure = { message, detail, retryable, code };
		this.setPhase("failed", message);
		this.liveNotice?.hide();
		this.liveNotice = null;
		// Sticky: a failure the user did not see is a failure they will rediscover as a patch that
		// never arrived. The receipt behind the status bar has the detail and the retry.
		new Notice(`modkit stopped: ${message}`, NOTICE_STICKY);
	}

	/**
	 * A poll could not reach the daemon.
	 *
	 * The phase is deliberately untouched. The job is very probably still running; what failed is
	 * our ability to ask. Reporting it as finished — or as failed — would be a lie in whichever
	 * direction was convenient.
	 */
	unreachable(detail: string): void {
		const state = this.current;
		if (state === null || !isLivePhase(state.phase)) return;
		const first = !state.stale;
		state.stale = true;
		state.staleDetail = detail;
		state.updatedAt = Date.now();
		if (first) {
			this.notice(
				`Couldn't check in just now — ${detail}. As far as modkit knows the work is still going; only asking about it failed.`,
				NOTICE_SHORT_MS,
			);
		}
		this.render();
	}

	/** A poll succeeded again after one or more failures. */
	reachable(): void {
		this.clearStale();
		this.render();
	}

	/** Drop the current job from the status bar. Its receipt stays reachable as the last job. */
	clear(): void {
		if (this.current !== null) this.last = this.current;
		this.current = null;
		this.liveNotice?.hide();
		this.liveNotice = null;
		this.render();
	}

	/** Open the receipt for the current job, or the last one. */
	show(): void {
		const state = this.state;
		if (state === null) {
			if (this.options.onIdle !== undefined) this.options.onIdle();
			else new Notice("No patches yet. Run “modkit: Mod this…” and point at what you want changed.", NOTICE_SHORT_MS);
			return;
		}
		new JobReceiptModal(this.plugin.app, state, {
			onRetry: this.options.onRetry,
			onDismiss: () => {
				this.clear();
			},
		}).open();
	}

	/* ── Internals ────────────────────────────────────────────────────────── */

	private setPhase(phase: ProgressPhase, message?: string): void {
		const state = this.current;
		if (state === null) return;
		const changed = state.phase !== phase;
		state.phase = phase;
		if (message !== undefined) state.message = message;
		state.updatedAt = Date.now();
		if (!isLivePhase(phase)) {
			state.stale = false;
			state.staleDetail = null;
		}
		if (changed) this.narrate();
		this.render();
	}

	private clearStale(): void {
		const state = this.current;
		if (state === null || !state.stale) return;
		state.stale = false;
		state.staleDetail = null;
		state.updatedAt = Date.now();
	}

	/** Mobile only: keep one notice describing the live phase, rather than stacking one per step. */
	private narrate(): void {
		const state = this.current;
		if (state === null || this.statusEl !== null) return;
		if (!isLivePhase(state.phase)) return;
		const text = `modkit · ${phaseLabel(state.phase)} — ${state.message}`;
		if (this.liveNotice === null) this.liveNotice = new Notice(text, NOTICE_STICKY);
		else this.liveNotice.setMessage(text);
	}

	private notice(text: string, duration: number): void {
		new Notice(text, duration);
	}

	/** A success that has been on screen long enough steps aside; a failure never does. */
	private tick(): void {
		const state = this.current;
		if (state === null) return;
		if (state.phase === "applied" && Date.now() - state.updatedAt > APPLIED_LINGER_MS) {
			this.clear();
			return;
		}
		if (isLivePhase(state.phase)) this.render();
	}

	private render(): void {
		const el = this.statusEl;
		if (el === null || this.dotEl === null || this.labelEl === null || this.elapsedEl === null) return;

		const state = this.current;
		for (const cls of ["is-working", "is-stale", "is-applied", "is-refused", "is-failed"]) el.removeClass(cls);

		if (state === null) {
			this.labelEl.setText("modkit");
			this.elapsedEl.setText("");
			el.setAttribute(
				"aria-label",
				this.last === null ? "modkit — nothing written yet" : `modkit — last patch: ${phaseLabel(this.last.phase)}`,
			);
			return;
		}

		const live = isLivePhase(state.phase);
		if (state.stale) el.addClass("is-stale");
		else if (live) el.addClass("is-working");
		else el.addClass(`is-${state.phase}`);

		this.labelEl.setText(`modkit ${phaseLabel(state.phase)}`);
		this.elapsedEl.setText(live ? elapsedLabel(Date.now() - state.startedAt) : "");

		const lines = [`${state.targetLabel} — ${state.message}`];
		if (state.stale && state.staleDetail !== null) {
			lines.push(`This is the last thing modkit heard — it stopped getting an answer: ${state.staleDetail}`);
		}
		lines.push("Click for details");
		el.setAttribute("aria-label", lines.join("\n"));
	}
}

/**
 * The receipt — everything about one job, reachable after every notice has gone.
 *
 * It exists because notices are not a record. A generation that failed while the user was in
 * another window has to still be findable, with its reason and with the sentence that produced it,
 * or the only recovery is retyping from memory.
 */
class JobReceiptModal extends Modal {
	private readonly state: ProgressState;
	private readonly actions: { onRetry?: ((request: string) => void) | undefined; onDismiss: () => void };

	constructor(
		app: App,
		state: ProgressState,
		actions: { onRetry?: ((request: string) => void) | undefined; onDismiss: () => void },
	) {
		super(app);
		this.state = state;
		this.actions = actions;
	}

	override onOpen(): void {
		const state = this.state;
		this.setTitle(`modkit · ${phaseLabel(state.phase)}`);

		const { contentEl } = this;
		contentEl.addClass("modkit-receipt");

		const kv = contentEl.createDiv({ cls: "modkit-kv" });
		const row = (key: string, value: string): void => {
			if (value === "") return;
			kv.createDiv({ cls: "modkit-kv__k", text: key });
			kv.createDiv({ cls: "modkit-kv__v", text: value });
		};
		row("Target", state.targetLabel);
		row("Status", state.stale ? `${phaseLabel(state.phase)} (as of the last answer)` : phaseLabel(state.phase));
		row("Started", `${elapsedLabel(Date.now() - state.startedAt)} ago`);
		row("Detail", state.message);
		if (state.mod !== null) row("Patch", `${state.mod.name} (${state.mod.modId})`);
		if (state.jobId !== null) row("Job", state.jobId);

		contentEl.createDiv({ cls: "modkit-kv__k", text: "You asked for" });
		contentEl.createDiv({ cls: "modkit-quote", text: state.request });

		if (state.stale && state.staleDetail !== null) {
			contentEl.createDiv({
				cls: "modkit-error",
				text: `This is the last thing modkit heard — it stopped getting an answer: ${state.staleDetail}. The work may well still be going.`,
			});
		}

		if (state.refusal !== null) this.renderRefusal(contentEl, state.refusal);
		if (state.failure !== null) this.renderFailure(contentEl, state.failure);

		this.renderActions(contentEl);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private renderRefusal(parent: HTMLElement, refusal: ProgressRefusal): void {
		const box = parent.createDiv({ cls: "modkit-refusal" });
		box.createDiv({ cls: "modkit-refusal__headline", text: "Can't be done — here's why" });
		box.createDiv({ cls: "modkit-refusal__body", text: refusal.explanation });
		if (refusal.suggestion !== null) {
			box.createDiv({ cls: "modkit-refusal__suggestion", text: refusal.suggestion });
		}
		if (refusal.detail !== null || refusal.reason !== null) {
			const details = box.createEl("details");
			details.createEl("summary", { text: "What modkit saw" });
			const lines: string[] = [];
			if (refusal.reason !== null) lines.push(`reason: ${refusal.reason}`);
			if (refusal.detail !== null) lines.push(refusal.detail);
			details.createEl("pre", { text: lines.join("\n") });
		}
	}

	private renderFailure(parent: HTMLElement, failure: ProgressFailure): void {
		const box = parent.createDiv({ cls: "modkit-refusal" });
		box.createDiv({ cls: "modkit-refusal__headline", text: "Something went wrong" });
		box.createDiv({ cls: "modkit-refusal__body", text: failure.message });
		if (!failure.retryable) {
			box.createDiv({
				cls: "modkit-refusal__suggestion",
				text: "Asking again for the same thing is unlikely to help. Change what you asked for, or aim it somewhere else.",
			});
		}
		if (failure.detail !== null || failure.code !== null) {
			const details = box.createEl("details");
			details.createEl("summary", { text: "Technical detail" });
			const lines: string[] = [];
			if (failure.code !== null) lines.push(`code: ${failure.code}`);
			if (failure.detail !== null) lines.push(failure.detail);
			details.createEl("pre", { text: lines.join("\n") });
		}
	}

	private renderActions(parent: HTMLElement): void {
		const state = this.state;
		const setting = new Setting(parent).setClass("modkit-actions");

		if (this.actions.onRetry !== undefined && !isLivePhase(state.phase) && state.phase !== "applied") {
			setting.addButton((button) =>
				button.setButtonText("Try again").onClick(() => {
					this.close();
					// The sentence, verbatim: a retry must never mean retyping.
					this.actions.onRetry?.(state.request);
				}),
			);
		}

		setting.addButton((button) =>
			button.setButtonText("Copy details").onClick(() => {
				void this.copyDetails();
			}),
		);

		if (!isLivePhase(state.phase)) {
			setting.addButton((button) =>
				button.setButtonText("Dismiss").onClick(() => {
					this.actions.onDismiss();
					this.close();
				}),
			);
		}

		setting.addButton((button) =>
			button
				.setButtonText("Close")
				.setCta()
				.onClick(() => {
					this.close();
				}),
		);
	}

	private async copyDetails(): Promise<void> {
		const state = this.state;
		const lines = [
			`modkit job ${state.jobId ?? "(no id)"}`,
			`target: ${state.targetLabel}`,
			`status: ${phaseLabel(state.phase)}${state.stale ? " (stale)" : ""}`,
			`detail: ${state.message}`,
			`request: ${state.request}`,
		];
		if (state.refusal !== null) {
			lines.push(`refusal: ${state.refusal.reason ?? "?"} — ${state.refusal.explanation}`);
			if (state.refusal.detail !== null) lines.push(state.refusal.detail);
		}
		if (state.failure !== null) {
			lines.push(`failure: ${state.failure.code ?? "?"} — ${state.failure.message}`);
			if (state.failure.detail !== null) lines.push(state.failure.detail);
		}
		try {
			await navigator.clipboard.writeText(lines.join("\n"));
			new Notice("Details copied.", NOTICE_SHORT_MS);
		} catch (err) {
			new Notice(`Could not copy — ${err instanceof Error ? err.message : String(err)}`, NOTICE_SHORT_MS);
		}
	}
}
