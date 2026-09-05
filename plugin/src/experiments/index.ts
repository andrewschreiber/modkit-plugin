/**
 * Phase 0's remaining experiment (E2), as a palette command.
 *
 * E1 (can a plugin write and enable a sibling plugin at runtime) was answered by production use on
 * 2026-09-01 and has been removed; this file used to host both.
 *
 * It ships *inside* modkit rather than as a scratch file pasted into the developer console, because
 * it measures a running Obsidian against a real vault — the target plugin, the config
 * directory, the plugin manager, the user's own data. There is no rig that can stand in for that, so
 * the experiment has to be invocable from the app, repeatable, and safe to run twice.
 *
 * Each run writes a markdown report into `modkit/experiments/`, which is the point: PLAN.md's
 * kill condition is answered by an artifact somebody can read next month, not by console
 * scrollback that is gone at the next restart.
 *
 * Obsidian prefixes command names with the plugin name, so the palette entry reads
 * "modkit: Run experiment E2 (…)" from the name below.
 *
 * ## Consent is the gate, and it is in front of the run
 *
 * A palette command is **one keystroke** from anywhere in the app, and a fuzzy match on "experiment"
 * is not a decision. E2 disables and re-enables a plugin the user actually relies on. That is not
 * destructive, but it is *disturbing*, and until 2026-08-31 it ran the instant the command was
 * chosen, with no statement of what was about to happen. That was the whole finding.
 *
 * So every run now goes through {@link ExperimentConsentModal}, which states — before anything is
 * touched — exactly which plugin will be switched off and back on by name and id, which paths get
 * written and which of those are removed again, roughly how long it takes, and what the user will
 * see. **Cancel is the default**: it is the focused button, and Escape, the close button and a
 * click outside all resolve to it. A cancelled run does nothing at all — no files, no plugin state,
 * and no report, so there is no artifact anybody can mistake for a result.
 *
 * The facts in that modal come from the experiment itself (`e2Consent`) rather than being written
 * out here, so a change to what the experiment does travels with the sentence describing it.
 */

import { Modal, Notice, Setting } from "obsidian";
import type { App, ButtonComponent, Plugin } from "obsidian";
import { e2Consent, runE2 } from "./e2";
import type { ExperimentConsent, ExperimentReport } from "./harness";

export type ExperimentId = "e2";

export interface ExperimentDefinition {
	id: ExperimentId;
	/** Command id, auto-prefixed with the plugin id by `addCommand`. */
	commandId: string;
	/** Command name, auto-prefixed with the plugin name by `addCommand`. */
	commandName: string;
	/**
	 * What the user is shown before anything runs. Takes the plugin because the honest answer
	 * depends on the live vault — E2 names the target by whatever the installed manifest calls it,
	 * not by a string hard-coded next to the modal.
	 */
	consent(plugin: Plugin): ExperimentConsent;
	run(plugin: Plugin): Promise<ExperimentReport>;
}

export const EXPERIMENTS: ExperimentDefinition[] = [
	{
		id: "e2",
		commandId: "run-experiment-e2",
		commandName: "Run experiment E2 (patch a third-party plugin, then cleanly remove it)",
		consent: e2Consent,
		run: runE2,
	},
];

/**
 * The consent modal.
 *
 * Deliberately plain: a heading, what it is for, three lists of consequences, and two buttons. No
 * scrolling, no disclosure triangles — a consequence a user has to expand is a consequence they did
 * not read.
 *
 * Styling is Obsidian's own CSS variables via inline properties rather than a stylesheet, so the
 * modal inherits the user's theme (light, dark, or a community theme) with nothing to keep in sync
 * and nothing injected into the document that would need reclaiming.
 */
class ExperimentConsentModal extends Modal {
	/** Set the instant either button is pressed, so `onClose` knows this was not a dismissal. */
	private decided = false;

	constructor(
		app: App,
		private readonly consent: ExperimentConsent,
		private readonly decide: (proceed: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.consent.title);
		contentEl.addClass("modkit-experiment-consent");

		const summary = contentEl.createEl("p", { text: this.consent.summary });
		summary.style.setProperty("color", "var(--text-normal)");
		summary.style.setProperty("margin-top", "0");

		this.section(contentEl, "Plugins it switches off and back on", this.toggleLines(), {
			empty: "None. It does not touch any of your plugins.",
			emphasis: this.consent.toggles.length > 0,
		});
		this.section(contentEl, "Files it writes, then removes", this.consent.writesThenRemoves, {
			empty: "None.",
		});
		this.section(contentEl, "Files it leaves behind", this.consent.leavesBehind, { empty: "None." });

		// The cost line is one block rather than two bullets: duration and disturbance are the same
		// question ("how much of my next minute does this take?") and answering it twice splits it.
		const cost = contentEl.createDiv();
		cost.style.setProperty("border-left", "3px solid var(--text-accent)");
		cost.style.setProperty("background", "var(--background-secondary)");
		cost.style.setProperty("border-radius", "var(--radius-s)");
		cost.style.setProperty("padding", "var(--size-4-2) var(--size-4-3)");
		cost.style.setProperty("margin", "var(--size-4-3) 0");
		cost.style.setProperty("color", "var(--text-muted)");
		cost.style.setProperty("font-size", "var(--font-ui-small)");
		cost.createDiv({ text: `Takes ${this.consent.duration}.` });
		cost.createDiv({ text: this.consent.disturbance });

		const buttons = new Setting(contentEl);
		let cancelButton: ButtonComponent | null = null;

		// Proceed on the left, Cancel on the right where the default lives: this is the one modal in
		// modkit whose safe answer is the emphasised one.
		buttons.addButton((button) =>
			button
				.setButtonText(this.consent.proceedLabel)
				.setWarning()
				.onClick(() => {
					this.finish(true);
				}),
		);
		buttons.addButton((button) => {
			cancelButton = button
				.setButtonText("Cancel")
				.setCta()
				.onClick(() => {
					this.finish(false);
				});
		});

		// Focused, so Return and Space both cancel and the button that runs the experiment needs a
		// deliberate move to reach. Escape and the close button go through `onClose` to the same place.
		(cancelButton as ButtonComponent | null)?.buttonEl.focus();
	}

	override onClose(): void {
		this.contentEl.empty();
		// Escape, the close button, or a click outside. Silence is not consent.
		if (!this.decided) {
			this.decided = true;
			this.decide(false);
		}
	}

	private finish(proceed: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.decide(proceed);
		this.close();
	}

	/** Name **and** id: the name is what a user recognises, the id is what is unambiguous. */
	private toggleLines(): string[] {
		return this.consent.toggles.map((t) => `${t.name} (\`${t.id}\`)${t.note === undefined ? "" : ` — ${t.note}`}`);
	}

	private section(parent: HTMLElement, heading: string, items: string[], options: { empty: string; emphasis?: boolean }): void {
		const title = parent.createDiv({ text: heading });
		title.style.setProperty("font-weight", "var(--font-semibold)");
		title.style.setProperty("color", "var(--text-normal)");
		title.style.setProperty("margin-top", "var(--size-4-3)");

		if (items.length === 0) {
			const none = parent.createDiv({ text: options.empty });
			none.style.setProperty("color", "var(--text-faint)");
			return;
		}

		const list = parent.createEl("ul");
		list.style.setProperty("margin", "var(--size-2-2) 0 0 0");
		list.style.setProperty("padding-left", "1.4em");
		for (const item of items) {
			const li = list.createEl("li", { text: item });
			li.style.setProperty("color", options.emphasis === true ? "var(--text-warning)" : "var(--text-muted)");
		}
	}
}

/** Open the modal and resolve to the user's answer. Resolves exactly once, whatever closes it. */
export function confirmExperiment(app: App, consent: ExperimentConsent): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		new ExperimentConsentModal(app, consent, (proceed) => {
			if (settled) return;
			settled = true;
			resolve(proceed);
		}).open();
	});
}

/**
 * One experiment at a time, globally.
 *
 * Not defensiveness for its own sake: E2 disables and re-enables a foreign plugin, so two
 * overlapping runs would tear down each other's fixtures and report the wreckage as a finding
 * about Obsidian.
 *
 * The guard is taken **before** the confirm modal opens, not after it resolves. The confirm step
 * introduced an `await` where there had been none, and a guard taken after it would let a second
 * invocation open a second modal — two dialogs, both live, either of which starts a run. So the
 * phase is tracked and reported, and a second invocation is refused while the first is still being
 * *asked about*, not only while it is running.
 */
let inFlight: { id: ExperimentId; phase: "confirming" | "running" } | null = null;

export async function runExperiment(plugin: Plugin, id: ExperimentId): Promise<ExperimentReport | null> {
	const definition = EXPERIMENTS.find((e) => e.id === id);
	if (definition === undefined) return null;

	if (inFlight !== null) {
		const busy = inFlight.id.toUpperCase();
		new Notice(
			inFlight.phase === "confirming"
				? `modkit: experiment ${busy} is waiting for you to confirm or cancel it.`
				: `modkit: experiment ${busy} is still running — wait for it to finish.`,
		);
		return null;
	}

	const state: { id: ExperimentId; phase: "confirming" | "running" } = { id, phase: "confirming" };
	inFlight = state;
	try {
		if (!(await confirmExperiment(plugin.app, definition.consent(plugin)))) {
			// Nothing ran, so there is nothing to report and nothing to undo. Say so plainly rather
			// than leaving the palette looking like it swallowed a command.
			new Notice(`modkit: experiment ${id.toUpperCase()} cancelled — nothing was changed.`);
			return null;
		}

		state.phase = "running";
		new Notice(`modkit: running experiment ${id.toUpperCase()}…`);
		return await definition.run(plugin);
	} catch (err) {
		// `runE2` already handles its own failures and publishes a report; reaching here means
		// the harness itself broke, which the user still needs to be told about rather than left
		// watching a command that did nothing.
		console.error(`modkit: experiment ${id.toUpperCase()} could not run`, err);
		new Notice(`modkit: experiment ${id.toUpperCase()} could not run — ${String(err)}`, 0);
		return null;
	} finally {
		inFlight = null;
	}
}

/** Call from the plugin's `onload`. Commands are reclaimed with the plugin, so nothing to undo. */
export function registerExperimentCommands(plugin: Plugin): void {
	for (const definition of EXPERIMENTS) {
		plugin.addCommand({
			id: definition.commandId,
			name: definition.commandName,
			callback: () => {
				void runExperiment(plugin, definition.id);
			},
		});
	}
}

export { runE2, e2Consent } from "./e2";
export {
	ExperimentRun,
	publish,
	writeReport,
	renderMarkdown,
	logReport,
	noticeReport,
	localDateStamp,
	describe,
	enabledPluginsPath,
	readEnabledPlugins,
	removeEnabledPlugin,
	restoreEnabledPlugin,
} from "./harness";
export type { AssertionResult, AssertionStatus, CheckOutcome, ExperimentConsent, ExperimentReport, Measurement } from "./harness";
