/**
 * The compose modal — where a person says what they want changed.
 *
 * Three properties carry most of the weight, and each of them is a lesson from an earlier app's customize
 * flow this is a port of:
 *
 * 1. **What was resolved is shown above the field, before a word is typed.** A wrong target caught
 *    before typing costs nothing; caught after, it costs a whole generation. So the modal opens
 *    with the plugin and its version, named as a small chip. *How* modkit would reach it — the
 *    plane in plain words, and the exact member expression a patch would hold on to — is real
 *    information a person can act on (a bad reach is a wasted generation too), so it stays, folded
 *    behind "How modkit reaches this" rather than sitting above the field on every single mod.
 * 2. **A refusal replaces the field entirely.** If pre-flight already established that this target
 *    cannot be reached — a getter, a method bound at construction, a command with two callbacks —
 *    then a text field is an invitation to waste a minute. The modal says what it saw, in the words
 *    a person would use, and offers the next move instead.
 * 3. **The typed text is never lost.** Escape with text in the field asks first; whatever the user
 *    does next, `onCancel` receives the draft so the caller can hand it back. Losing a sentence
 *    because a key was hit is the one failure this surface must not have.
 *
 * One predicate — {@link ComposeModal.canSubmit} — gates both the button's `disabled` state and the
 * submit handler's own guard. That app had two and shipped an enabled button that did nothing at all,
 * silently, with no log line.
 */

import { Component, Modal, Setting } from "obsidian";
import type { App, ButtonComponent } from "obsidian";
import { REACH_PLANE_LABELS } from "@modkit/types";
import type { ElementEvidence, PickEvidence, ReachPlaneId, ReachTarget, TargetRef } from "@modkit/types";
import type { Refusal, RefusalCode } from "./refusal";

/**
 * A pre-flight refusal, in the shape the modal needs.
 *
 * Structurally a superset of {@link Refusal} (duplicated from `experiments/planes.ts` in
 * `./refusal` so the UI does not need to depend on experiment-only code), so a `Refusal` can be
 * passed straight in. `code` widens to `string` because the daemon may refuse for a reason the
 * plugin's own plane table has no name for, and an unrecognised code must still render.
 */
export interface ComposeRefusal {
	code: RefusalCode | (string & {});
	/** The technical sentence, from whichever layer refused. Shown under "what modkit saw". */
	message: string;
	detail?: Record<string, string>;
	/** An honest next move, when the refusing layer had one. Overrides the built-in suggestion. */
	suggestion?: string;
}

/**
 * A target the picker considered but did not choose.
 *
 * The picker populates its candidate list even when it is confident, and this is why: attribution
 * from a DOM node is a guess with evidence, and the evidence is worth showing to the one person who
 * can settle it in a click.
 */
export interface ComposeCandidate {
	label: string;
	/** The evidence that put it on the list — becomes the tooltip. */
	why?: string;
	/** Usually: close this modal and reopen it aimed at that target instead. */
	onChoose(): void;
}

/** Everything the modal shows about the thing the request is aimed at. */
export interface ComposeTarget {
	/** The target itself, in the wire contract's terms — this is what travels with the request. */
	target: TargetRef;
	/** Display name. Derived from `target` when omitted. */
	name?: string;
	/** Secondary line: id and version, or whatever identifies it best. Derived when omitted. */
	detail?: string;
	/** One sentence on *why* modkit resolved this target, in the user's terms. */
	why?: string;
	/** What else it could have been. Rendered only when there is at least one. */
	candidates?: ComposeCandidate[];
	/**
	 * The reach the client proposes, when the picker could determine one. Travels with the request
	 * as `GenerateRequest.proposedReach` — the daemon may choose otherwise, and the plane/handle
	 * shown above the field are derived from this, not stored separately.
	 */
	reach?: ReachTarget;
	/** What the user pointed at, if they pointed at anything. */
	evidence?: PickEvidence;
	/** Set when pre-flight already refused. The modal then shows the reason instead of a field. */
	refusal?: ComposeRefusal;
}

export interface ComposeModalOptions {
	target: ComposeTarget;
	/**
	 * Prefilled request text. Set it on a retry after a failed generation — the point of keeping
	 * the sentence is that the user does not retype it.
	 */
	initialRequest?: string;
	/** Concrete example requests, replacing the built-in ones. Two or three; more is a menu. */
	examples?: string[];
	/**
	 * The request, verbatim and trimmed. Called **before** the modal closes, so the caller can put
	 * its progress surface on screen in the same frame — otherwise there is one painted frame with
	 * the modal gone and nothing to show for it, which reads as "nothing happened".
	 */
	onSubmit(request: string): void;
	/** Called when the modal closes without submitting. Receives the draft, so it can be restored. */
	onCancel?(draft: string): void;
	/** Offer "change target" — typically reopens the plugin picker. */
	onRetarget?(): void;
	/** Offer "pick again" — typically re-enters the element picker. */
	onRepick?(): void;
}

/**
 * A sanity bound, not a protocol limit: modkit's daemon is ours and imposes no size cap, unlike
 * the agent-deck TUI this flow was ported from. Past this a request has stopped being a sentence
 * and started being a specification, which generates worse.
 */
export const MAX_REQUEST_CHARS = 4000;

/** The counter stays hidden until the length is worth thinking about. */
const COUNT_VISIBLE_FROM = Math.floor(MAX_REQUEST_CHARS * 0.75);

/**
 * The reach planes in the words a person would use.
 *
 * The contract's own {@link REACH_PLANE_LABELS} are the technical labels, shared with the daemon so
 * the two describe a plane identically; they read as jargon in a modal, so they go in the tooltip
 * and these go on screen. What the sentence has to convey is not the mechanism but the *durability*
 * — a mod on plane A survives almost anything, a mod on plane E is one theme update from missing.
 */
const PLANE_PROSE: Record<ReachPlaneId, string> = {
	A: "a built-in Obsidian class — the sturdiest thing a patch can hold on to",
	B: "one live object inside Obsidian, so nothing else is affected",
	C: "the plugin's own class, which is the usual way to change a plugin",
	D: "the command itself — for some plugin actions this is the only handle that exists",
	E: "the element on screen and its styling, which can move when the plugin updates",
};

/** The concrete handle a patch would take, in the words `describe()` uses elsewhere in modkit. */
function reachHandle(reach: ReachTarget): string {
	switch (reach.plane) {
		case "A":
			return `${reach.exportName}${reach.holder === "static" ? "" : ".prototype"}.${reach.member}`;
		case "B":
			return `app.${reach.path}.${reach.member}`;
		case "C":
			return `app.plugins.plugins["${reach.pluginId}"]${reach.via !== undefined ? `.${reach.via}` : ""}${
				reach.holder === "prototype" ? ".constructor.prototype" : ""
			}.${reach.member}`;
		case "D":
			return `app.commands.commands["${reach.commandId}"].${reach.property}`;
		case "E":
			return reach.selector;
	}
}

interface RefusalProse {
	headline: string;
	body: string;
	suggestion?: string;
}

/**
 * Plain-language versions of every refusal the plane table can produce.
 *
 * These are deliberately not the `Refusal.message` strings: those are written for whoever is
 * debugging modkit and name descriptors, prototypes and call paths. Both are shown — this one as
 * the answer, the original under "what modkit saw" — because the person who asked for the mod is
 * owed an explanation they can act on, and the person fixing modkit is owed the specifics.
 */
const REFUSAL_PROSE: Record<RefusalCode, RefusalProse> = {
	"unknown-plane": {
		headline: "modkit aimed at the wrong kind of thing",
		body: "The target and the way modkit tried to reach it do not match. That is a fault in modkit rather than anything about this plugin.",
		suggestion: "Try again from the picker. If it repeats, the detail below is what to report.",
	},
	"plane-unavailable": {
		headline: "This build of Obsidian does not expose the part this would need",
		body: "modkit reaches some things through parts of Obsidian that are not in its published API, and this build does not have the one this patch would use.",
		suggestion: "modkit's settings tab names exactly which piece is missing.",
	},
	"target-missing": {
		headline: "That target is not there",
		body: "modkit could not find the plugin, class or command a patch would attach to.",
		suggestion: "Pick the target again — if the plugin was updated or removed, the old handle went with it.",
	},
	"target-disabled": {
		headline: "That plugin is installed but turned off",
		body: "A plugin that is switched off has no running code, so there is nothing yet for a patch to change.",
		suggestion: "Turn it on under Community plugins, then ask again.",
	},
	"target-not-object": {
		headline: "There is nothing to attach to there",
		body: "What modkit resolved is not an object with methods, so it has no behaviour to wrap.",
	},
	"property-missing": {
		headline: "That method does not exist on the target",
		body: "modkit would have created it rather than wrapped it — the patch would install cleanly, report itself as working, and do nothing.",
		suggestion: "Point at the behaviour you want changed and let modkit find the method that implements it.",
	},
	accessor: {
		headline: "That part of the plugin runs code every time it is read",
		body: "It looks like a plain property but it is a getter. Wrapping it would read through the getter and write back through the setter, which changes something other than what you asked for.",
		suggestion: "If the plugin has a method that uses this value, aim the request at that instead.",
	},
	"not-writable": {
		headline: "The plugin made that read-only",
		body: "The patch would be silently ignored: it would look applied and change nothing.",
	},
	"not-configurable": {
		headline: "That change could be made but never taken back",
		body: "modkit only installs changes it can undo, so it refuses this one rather than making it permanent.",
	},
	"not-a-function": {
		headline: "That is a value, not a function",
		body: "modkit changes behaviour by wrapping a function so it can run something before or after it. There is nothing here to wrap.",
	},
	"bound-at-construction": {
		headline: "The plugin took its own copy of that method when it started",
		body: "It calls the copy, not the original, so a change made to the class afterwards would never be seen — it would install, raise nothing, and do nothing.",
		suggestion: "Ask for the same change at the command that triggers it, or at what you can see on screen; both are still reachable.",
	},
	"instance-shadows-prototype": {
		headline: "The running plugin holds its own copy of that method",
		body: "Calls go to the copy on the live object, so changing the class underneath it would have no effect.",
		suggestion: "Ask for the change at the command that triggers it, or at what you can see on screen.",
	},
	"no-live-callback": {
		headline: "That command has no code attached",
		body: "The command is registered but carries none of the callbacks Obsidian can run, so there is nothing for a patch to wrap.",
	},
	"ambiguous-callback": {
		headline: "That command carries more than one callback",
		body: "Which one Obsidian actually runs is undocumented, so wrapping one of them could quietly miss the path that is really used.",
		suggestion: "Aim at the plugin's own method instead, or at what you can see on screen.",
	},
	"dom-not-a-method": {
		headline: "That is a piece of the screen, not a method",
		body: "There is no function here to wrap — a change would have to be made to the element or its styling.",
	},
	"invalid-selector": {
		headline: "modkit could not build a usable handle for that element",
		body: "The selector it produced is not valid CSS, so nothing would ever match it.",
		suggestion: "Pick the element again, or point at the box around it.",
	},
};

/** The prose for a refusal, falling back to the refusing layer's own sentence for a code we don't know. */
export function refusalProse(refusal: ComposeRefusal): RefusalProse {
	const known = (REFUSAL_PROSE as Record<string, RefusalProse | undefined>)[refusal.code];
	const base: RefusalProse = known ?? {
		headline: "Can't reach that — here's why",
		body: refusal.message,
	};
	return refusal.suggestion === undefined ? base : { ...base, suggestion: refusal.suggestion };
}

/** Display name for a target, when the caller did not supply one. */
export function targetDisplayName(target: TargetRef): string {
	if (target.kind === "plugin") return target.pluginName ?? target.pluginId;
	return target.internalPluginId === undefined ? "Obsidian" : `Obsidian · ${target.internalPluginId}`;
}

/** Secondary line for a target: what it is and which version this request is anchored to. */
export function targetDisplayDetail(target: TargetRef): string {
	if (target.kind === "plugin") {
		return target.pluginVersion === "" ? target.pluginId : `${target.pluginId} · v${target.pluginVersion}`;
	}
	return target.appVersion === "" ? "Obsidian's own interface" : `Obsidian ${target.appVersion} · core interface`;
}

/**
 * Two concrete requests, so the field is never a blank page.
 *
 * Concrete is the whole point: "change something about Tasks" teaches nothing, while a request with
 * a trigger and an observable result shows the shape that generates well — and, not incidentally,
 * the shape whose effect a mod can actually check for itself.
 */
export function defaultExamples(target: ComposeTarget): string[] {
	const name = target.name ?? targetDisplayName(target.target);
	const picked = (target.evidence?.elements.length ?? 0) > 0;

	if (picked) {
		return [
			"Make what I picked smaller and dim it until I hover over it",
			`Ask me to confirm before ${name} acts on it`,
		];
	}
	if (target.target.kind === "plugin") {
		return [
			`Show a notice with what ${name} changed, every time it runs`,
			`Ask me to confirm before ${name} deletes anything`,
		];
	}
	return [
		"Ask me to confirm before a tab with unsaved changes closes",
		"Show the full file path in the tab tooltip, not just the name",
	];
}

/** One picked element, as a chip: enough to recognise it, short enough to sit in a row. */
function chipText(element: ElementEvidence): string {
	const label = element.label.length > 0 ? element.label : element.txt;
	const trimmed = label.length > 28 ? `${label.slice(0, 27)}…` : label;
	return trimmed.length > 0 ? `${element.sel}${element.nth} · ${trimmed}` : `${element.sel}${element.nth}`;
}

export class ComposeModal extends Modal {
	private readonly options: ComposeModalOptions;

	/**
	 * A `Modal` is not a `Component`, so it has no `registerDomEvent`. Rather than reach for a bare
	 * `addEventListener` — the exact thing modkit's validator rejects in generated code — the modal
	 * owns a component, loads it on open and unloads it on close. Same contract, held by us too.
	 */
	private readonly lifecycle = new Component();

	private requestEl: HTMLTextAreaElement | null = null;
	private submitButton: ButtonComponent | null = null;
	private countEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private confirmEl: HTMLElement | null = null;

	private draft = "";
	private submitted = false;

	constructor(app: App, options: ComposeModalOptions) {
		super(app);
		this.options = options;
		this.draft = options.initialRequest ?? "";
	}

	override onOpen(): void {
		this.lifecycle.load();

		const target = this.options.target;
		const name = target.name ?? targetDisplayName(target.target);
		this.setTitle(target.refusal === undefined ? `Change ${name}` : `Can't change ${name}`);

		const { contentEl } = this;
		contentEl.addClass("modkit-compose");

		this.renderTarget(contentEl);
		this.renderAlternatives(contentEl);
		this.renderEvidence(contentEl);

		if (target.refusal !== undefined) {
			this.renderRefusal(contentEl, target.refusal);
			this.renderRefusalActions(contentEl);
			return;
		}

		this.renderField(contentEl);
		this.renderExamples(contentEl);
		this.renderActions(contentEl);
		this.registerKeys();
		this.syncSubmitState();

		this.requestEl?.focus();
		// Cursor at the end rather than a selection: a prefilled draft is being resumed, not replaced.
		this.requestEl?.setSelectionRange(this.draft.length, this.draft.length);
	}

	override onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
		if (!this.submitted) this.options.onCancel?.(this.draft);
	}

	/** The single predicate. Both the button's `disabled` and {@link attemptSubmit} read this one. */
	canSubmit(): boolean {
		if (this.submitted) return false;
		if (this.options.target.refusal !== undefined) return false;
		const length = this.draft.trim().length;
		return length > 0 && length <= MAX_REQUEST_CHARS;
	}

	/* ── Rendering ────────────────────────────────────────────────────────── */

	/**
	 * The target, named at the top before a word is typed: a small chip carrying its name and, in
	 * muted text, what it lives in — the one thing a wrong-target catch needs, at a glance. `why`
	 * stays beside it (also a glance-read, and the trust signal a person needs before typing).
	 * *How* modkit reaches it — the reach-plane sentence and the exact member expression — is real
	 * information but the technical half, so it folds behind a tap rather than sitting above the
	 * field on every single mod.
	 */
	private renderTarget(parent: HTMLElement): void {
		const target = this.options.target;
		const card = parent.createDiv({ cls: "modkit-target" });

		const row = card.createDiv({ cls: "modkit-target__row" });
		const chip = row.createDiv({ cls: "modkit-chip modkit-chip--target" });
		chip.createSpan({ cls: "modkit-target-chip__name", text: target.name ?? targetDisplayName(target.target) });
		chip.createSpan({
			cls: "modkit-target-chip__meta",
			text: `in ${target.detail ?? targetDisplayDetail(target.target)}`,
		});

		const actions = row.createDiv({ cls: "modkit-target__actions" });
		if (this.options.onRetarget !== undefined) {
			this.addLink(actions, "Change target", () => {
				this.close();
				this.options.onRetarget?.();
			});
		}
		if (this.options.onRepick !== undefined) {
			this.addLink(actions, "Pick again", () => {
				this.close();
				this.options.onRepick?.();
			});
		}

		if (target.why !== undefined && target.why.length > 0) {
			card.createDiv({ cls: "modkit-target__why", text: target.why });
		}

		if (target.reach !== undefined) {
			const details = card.createEl("details", { cls: "modkit-target-details" });
			details.createEl("summary", { text: "How modkit reaches this" });

			const reachPlane = target.reach.plane;
			const plane = details.createDiv({
				cls: "modkit-target__plane",
				text: `Reached through ${PLANE_PROSE[reachPlane]}.`,
			});
			// The contract's own label, shared with the daemon, kept as the tooltip so the two
			// vocabularies stay tied together without the jargon being on screen. No plane letter
			// prefix: a screen reader would announce it with nothing to explain it, which is worse
			// than the visible-text problem this was written to avoid.
			plane.setAttribute("aria-label", REACH_PLANE_LABELS[reachPlane]);

			const handle = reachHandle(target.reach);
			if (handle.length > 0) {
				details.createDiv({ cls: "modkit-target__handle", text: handle });
			}
		}
	}

	private renderAlternatives(parent: HTMLElement): void {
		const candidates = this.options.target.candidates ?? [];
		if (candidates.length === 0) return;

		const row = parent.createDiv({ cls: "modkit-alternatives" });
		row.createSpan({ cls: "modkit-alternatives__label", text: "It could also be" });
		for (const candidate of candidates) {
			const button = row.createEl("button", { cls: "modkit-link", text: candidate.label });
			if (candidate.why !== undefined) button.setAttribute("aria-label", candidate.why);
			this.lifecycle.registerDomEvent(button, "click", () => {
				this.close();
				candidate.onChoose();
			});
		}
	}

	private renderEvidence(parent: HTMLElement): void {
		const elements = this.options.target.evidence?.elements ?? [];
		if (elements.length === 0) return;

		const chips = parent.createDiv({ cls: "modkit-chips" });
		elements.forEach((element, index) => {
			const chip = chips.createSpan({ cls: element.gone === true ? "modkit-chip is-gone" : "modkit-chip" });
			chip.createSpan({ cls: "modkit-chip__ord", text: `#${index + 1}` });
			chip.createSpan({ cls: "modkit-chip__sel", text: chipText(element) });
			if (element.gone === true) {
				chip.setAttribute("aria-label", "This element was replaced before modkit could describe it");
			}
		});
	}

	private renderField(parent: HTMLElement): void {
		const field = parent.createDiv({ cls: "modkit-field" });
		field.createDiv({ cls: "modkit-field__label", text: "What should change?" });

		const textarea = field.createEl("textarea", {
			cls: "modkit-request",
			attr: {
				rows: "5",
				placeholder: "Hide this. Make this smaller and grey. Move this to the right.",
				"aria-label": "Describe the change you want",
			},
		});
		textarea.value = this.draft;
		this.requestEl = textarea;

		this.lifecycle.registerDomEvent(textarea, "input", () => {
			this.draft = textarea.value;
			this.clearError();
			this.syncSubmitState();
		});

		const foot = field.createDiv({ cls: "modkit-field__foot" });
		this.errorEl = foot.createDiv({ cls: "modkit-error" });
		this.countEl = foot.createDiv({ cls: "modkit-count" });
	}

	private renderExamples(parent: HTMLElement): void {
		const examples = this.options.examples ?? defaultExamples(this.options.target);
		if (examples.length === 0) return;

		const box = parent.createDiv({ cls: "modkit-examples" });
		box.createDiv({ cls: "modkit-examples__label", text: "For example" });
		for (const example of examples) {
			const button = box.createEl("button", { cls: "modkit-example", text: example });
			this.lifecycle.registerDomEvent(button, "click", () => {
				this.setDraft(example);
			});
		}
	}

	private renderActions(parent: HTMLElement): void {
		const hint = document.createDocumentFragment();
		hint.appendText("Press ");
		hint.createEl("span", { cls: "modkit-kbd", text: "Mod" });
		hint.appendText(" + ");
		hint.createEl("span", { cls: "modkit-kbd", text: "Enter" });
		hint.appendText(" to send it. This takes a few minutes; you can keep working.");

		new Setting(parent)
			.setClass("modkit-actions")
			.setDesc(hint)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.attemptClose();
				}),
			)
			.addButton((button) => {
				this.submitButton = button;
				button
					.setButtonText("Write the change")
					.setCta()
					.onClick(() => {
						this.attemptSubmit();
					});
			});
	}

	private renderRefusal(parent: HTMLElement, refusal: ComposeRefusal): void {
		const prose = refusalProse(refusal);
		const box = parent.createDiv({ cls: "modkit-refusal" });
		box.createDiv({ cls: "modkit-refusal__headline", text: prose.headline });
		box.createDiv({ cls: "modkit-refusal__body", text: prose.body });
		if (prose.suggestion !== undefined) {
			box.createDiv({ cls: "modkit-refusal__suggestion", text: prose.suggestion });
		}

		const details = box.createEl("details");
		details.createEl("summary", { text: "What modkit saw" });
		const lines = [`code: ${refusal.code}`, refusal.message];
		for (const [key, value] of Object.entries(refusal.detail ?? {})) lines.push(`${key}: ${value}`);
		details.createEl("pre", { text: lines.join("\n") });
	}

	private renderRefusalActions(parent: HTMLElement): void {
		const setting = new Setting(parent).setClass("modkit-actions");
		if (this.options.onRepick !== undefined) {
			setting.addButton((button) =>
				button.setButtonText("Pick something else").onClick(() => {
					this.close();
					this.options.onRepick?.();
				}),
			);
		}
		if (this.options.onRetarget !== undefined) {
			setting.addButton((button) =>
				button.setButtonText("Choose another plugin").onClick(() => {
					this.close();
					this.options.onRetarget?.();
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

	private addLink(parent: HTMLElement, text: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "modkit-link", text });
		this.lifecycle.registerDomEvent(button, "click", onClick);
	}

	/* ── Keyboard ─────────────────────────────────────────────────────────── */

	/**
	 * `Mod` is Obsidian's own portable modifier — Cmd on macOS, Ctrl elsewhere — so one registration
	 * covers both and cannot drift from the platform.
	 *
	 * The Escape registration overrides `Modal`'s built-in close. That relies on a scope registered
	 * later taking precedence, which is how every modal-with-a-custom-Escape in the plugin corpus is
	 * written but is **not** stated in the typings. If it ever stops holding, the modal simply
	 * closes without asking — and `onCancel` still hands the draft back, which is why that callback
	 * exists rather than relying on the confirmation alone.
	 */
	private registerKeys(): void {
		this.scope.register(["Mod"], "Enter", (evt) => {
			evt.preventDefault();
			this.attemptSubmit();
			return false;
		});
		this.scope.register([], "Escape", (evt) => {
			evt.preventDefault();
			this.attemptClose();
			return false;
		});
	}

	/* ── Behaviour ────────────────────────────────────────────────────────── */

	private setDraft(text: string): void {
		this.draft = text;
		if (this.requestEl !== null) {
			this.requestEl.value = text;
			this.requestEl.focus();
			this.requestEl.setSelectionRange(text.length, text.length);
		}
		this.clearError();
		this.syncSubmitState();
	}

	private syncSubmitState(): void {
		this.submitButton?.setDisabled(!this.canSubmit());

		if (this.countEl === null) return;
		const length = this.draft.length;
		const over = length > MAX_REQUEST_CHARS;
		this.countEl.toggleClass("is-over", over);
		this.countEl.setText(length >= COUNT_VISIBLE_FROM ? `${length} / ${MAX_REQUEST_CHARS}` : "");
	}

	private showError(message: string): void {
		this.errorEl?.setText(message);
	}

	private clearError(): void {
		this.errorEl?.setText("");
	}

	private attemptSubmit(): void {
		if (!this.canSubmit()) {
			if (this.draft.trim().length === 0) this.showError("Say what should change first.");
			else if (this.draft.length > MAX_REQUEST_CHARS) {
				this.showError(`That is ${this.draft.length - MAX_REQUEST_CHARS} characters too long.`);
			}
			return;
		}

		const request = this.draft.trim();
		this.submitted = true;
		this.submitButton?.setDisabled(true);

		try {
			// Before `close()`, deliberately: the caller puts its progress surface up inside this
			// call, so the modal is replaced by something rather than by a blank frame.
			this.options.onSubmit(request);
		} catch (err) {
			// The request never left. Give the field back with the text intact rather than closing
			// on a failure the user cannot see.
			this.submitted = false;
			this.submitButton?.setDisabled(false);
			this.showError(`Could not send that — ${err instanceof Error ? err.message : String(err)}`);
			this.syncSubmitState();
			return;
		}
		this.close();
	}

	/** Escape or Cancel. Asks first if there is something to lose, and only once. */
	private attemptClose(): void {
		if (this.draft.trim().length === 0 || this.confirmEl !== null) {
			this.close();
			return;
		}
		this.showDiscardConfirm();
	}

	private showDiscardConfirm(): void {
		const box = this.contentEl.createDiv({ cls: "modkit-confirm" });
		this.confirmEl = box;
		box.createDiv({ cls: "modkit-confirm__text", text: "Discard what you have typed?" });

		const keep = box.createEl("button", { text: "Keep editing" });
		this.lifecycle.registerDomEvent(keep, "click", () => {
			box.remove();
			this.confirmEl = null;
			this.requestEl?.focus();
		});

		const discard = box.createEl("button", { cls: "mod-warning", text: "Discard" });
		this.lifecycle.registerDomEvent(discard, "click", () => {
			this.close();
		});
		discard.focus();
	}
}
