/**
 * The review gate — the last thing between a model's output and code running in the user's vault.
 *
 * ## Why this exists at all
 *
 * modkit's generation pipeline ends with a validator: the daemon rejects a patch that breaks the
 * reclaim contract, feeds the findings back for one correction turn, and refuses if the second
 * attempt still fails. That validator is real, it is the best part of the system, and **it is not a
 * security boundary.** Four consecutive adversarial rounds found it fail-open — each round on a
 * different mechanism, each fix correct, each followed by another shape nobody had enumerated. The
 * honest conclusion is not "the validator is bad"; it is that a static analyser over adversarially
 * generated source is the wrong thing to be the *only* gate.
 *
 * So there is a second gate, and it is a person. Everything below is shaped by one rule: the user
 * must be able to answer "should this run?" from what is on screen, without opening a file. That
 * means the whole source, verbatim, not a summary of it — a summary is written by the same class of
 * process that wrote the code, and a summary is exactly what a hostile patch would get right.
 *
 * ## What it must never do
 *
 * - **Write anything.** The modal is opened *before* `ModInstaller.install`, so Cancel is not an
 *   undo — nothing has happened yet. That ordering is the whole guarantee, and it is why this is a
 *   gate in `main.ts`'s install path rather than a confirmation inside the installer.
 * - **Default to yes.** Cancel is the focused, emphasised button; Escape, the close button and a
 *   click outside all resolve to cancel; the promise settles exactly once whatever closes it. That
 *   is deliberately the same shape as `ExperimentConsentModal`: two dialogs in one plugin that
 *   disagree about which side the safe answer is on is how a habit becomes a mistake.
 * - **Be alarmist.** Most mods are a person asking for a smaller font. The consequence block states
 *   what enabling means in flat, specific terms — unsandboxed, the vault's filesystem, the network —
 *   and then stops. A modal that shouts is a modal that gets clicked through.
 *
 * ## Styling
 *
 * Its own stylesheet, injected by {@link injectReviewStyles} under the shared `data-modkit-style`
 * marker so every sheet modkit injects is findable with one selector, and removed through the
 * owning component. Every value is an Obsidian CSS variable with a literal fallback, per the house
 * rule in `ui.css.ts`: a renamed variable should degrade to slightly-off spacing, never to `0`.
 */

import { Component, Modal, Notice, Setting } from "obsidian";
import type { App, ButtonComponent } from "obsidian";

import type { EffectsDeclaration, ModEffect, ReachTarget, TargetRef, ValidationFinding } from "@modkit/types";

import { MODKIT_STYLE_ATTR } from "../picker/picker.css";

/* ────────────────────────────────────────────────────────────────────────────
 * The honest sentence about the validator
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What modkit is allowed to claim about its own validator, in one sentence.
 *
 * Exported so every surface that mentions checking says the same true thing. The claim it must not
 * make is the one a reader will otherwise infer from the word "validated": that something adversarial
 * was ruled out. What the validator actually establishes is structural — the patch is shaped so
 * Obsidian can take it back — and it has been defeated in four consecutive review rounds.
 */
export const VALIDATOR_CAVEAT =
	"modkit checked the shape of this code — that every change, listener and timer is registered so Obsidian can undo it. That is not a security review: it has been got past in testing, and it cannot tell a useful patch from a harmful one. Read the code.";

/**
 * The consequence of pressing the button, stated plainly and without adjectives — and stated
 * **per outcome**, because the two buttons do genuinely different things.
 *
 * This list used to be shared, with one extra line appended for the install-only case. Every line
 * in it was written for the enable case, so the install-only reader was told that a mod which had
 * not been enabled "runs inside Obsidian" and "stays on after a restart". A consequence block that
 * describes the wrong button is worse than none: it is the sentence the user is being asked to
 * rely on.
 */
const ENABLE_CONSEQUENCES: readonly string[] = [
	"It runs inside Obsidian with no sandbox, exactly like any other plugin you install.",
	"It can read, write and delete anything in this vault.",
	"It can reach the network, and modkit cannot see what it sends or where.",
	// The finding this whole surface was reshaped around: the reclaim contract governs the patch,
	// and nothing governs what the patch did on its way past.
	"Anything it changes stays changed. Switching it off removes the patch, not the notes it rewrote, the files it deleted or the requests it sent.",
	"It stays on after a restart, until you switch it off or uninstall it in Settings → modkit.",
];

const INSTALL_ONLY_CONSEQUENCES: readonly string[] = [
	"Its files go into your plugins folder and nothing runs. modkit does not switch it on, so none of its code loads.",
	"It stays off across restarts, until you turn it on in Settings → modkit.",
	"If you do turn it on, it runs with no sandbox — this vault's files and the network — and anything it changes stays changed after you switch it off again.",
	"Uninstalling it in Settings → modkit deletes the folder again.",
];

/* ────────────────────────────────────────────────────────────────────────────
 * The effects axis
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The vocabulary this build has words for, and what each one means for reclaim.
 *
 * A kind that is not in this table is **not dropped** — {@link effectLine} renders it verbatim and
 * says modkit has no description for it. That is the same rule as `reachHandle`'s default branch,
 * and for the same reason: a newer daemon must not be able to make an effect invisible here by
 * naming it something this build has never heard of.
 */
const EFFECT_PROSE: Record<string, { title: string; note: string }> = {
	// The daemon's `EffectKind` vocabulary, as `validate.ts` emits it. Each title is a sentence about
	// what this patch will do to something that is not itself — never the kind slug, which stays the
	// machine value and never reaches the screen on its own.
	"vault-write": {
		title: "Rewrites the contents of notes in your vault",
		note: "Creating, rewriting, renaming, trashing. Switching this patch off does not put any of it back.",
	},
	"editor-write": {
		title: "Types into a note you have open",
		note: "Its edits are saved exactly like the ones you make yourself, and switching this off does not undo them.",
	},
	"target-plugin-settings": {
		title: "Changes the settings of the plugin it patches",
		note: "Those are written into that plugin's own data, which modkit does not manage and cannot put back.",
	},
	"plugin-enablement": {
		title: "Switches other plugins on and off",
		note: "A plugin it switches off stays off after this patch is gone.",
	},
	"network-egress": {
		title: "Sends things over the network",
		note: "modkit cannot see where it connects or what it sends, and a request that has gone cannot be recalled.",
	},
	"host-dom-destruction": {
		title: "Removes or replaces parts of the Obsidian window",
		note: "What it destroys does not come back when the patch is removed. Usually that needs a restart.",
	},
	"host-config-write": {
		title: "Changes Obsidian's own settings",
		note: "It edits settings that live outside this patch, and removing the patch leaves them as it set them.",
	},
	// Derived here rather than declared, and named so it reads like the rest.
	stylesheet: {
		title: "Restyles the whole Obsidian window, not just the target",
		note: "Obsidian applies styles.css to the entire application for as long as this patch is switched on.",
	},
	unknown: {
		title: "Does something modkit could not put a name to",
		note: "The validator saw an effect it has no description for. Read the code below.",
	},
};

/**
 * Which of the four quick-scan chips an effect kind lights up. Coarser than {@link EFFECT_PROSE} on
 * purpose — the chip row is a glance, the list underneath is the account.
 */
const EFFECT_CATEGORY: Record<string, "styling" | "window" | "files" | "network"> = {
	stylesheet: "styling",
	"host-dom-destruction": "window",
	"host-config-write": "window",
	"editor-write": "window",
	"target-plugin-settings": "window",
	"plugin-enablement": "window",
	"vault-write": "files",
	"network-egress": "network",
};

/** Fixed order, always rendered, so the row's shape never changes between mods. */
const EFFECT_CATEGORY_LABELS: readonly [key: "styling" | "window" | "files" | "network", label: string][] = [
	["styling", "Styling"],
	["window", "This window"],
	["files", "Other files"],
	["network", "Network"],
];

/**
 * Normalise a declaration off a verified artifact payload, defensively.
 *
 * The payload is verified — signature, cert chain, digest, binding — before this ever runs, so
 * this is not a trust boundary. It is a *shape* boundary: `effects` is typed in the wire contract
 * now, but nothing runtime-checks a daemon's actual bytes against that type, so one entry from a
 * daemon a version ahead can still carry a shape this build has never seen. Every branch here
 * fails towards showing more, never less: an unreadable declaration becomes one visible effect and
 * a partial flag rather than a silent `undefined`, which would render as "this mod only patches
 * its target".
 */
export function readEffectsDeclaration(value: EffectsDeclaration | undefined): EffectsDeclaration | undefined {
	if (value === undefined) return undefined;
	const list: unknown = value.effects;
	if (!Array.isArray(list)) {
		return {
			effects: [{ kind: "unknown", detail: "this mod declared its effects in a shape modkit could not read" }],
			partial: true,
		};
	}
	const effects: ModEffect[] = list.map((entry) => {
		const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
		const kind = typeof e["kind"] === "string" && e["kind"] !== "" ? e["kind"] : "unknown";
		const effect: ModEffect = { kind };
		if (typeof e["detail"] === "string" && e["detail"] !== "") effect.detail = e["detail"];
		if (typeof e["line"] === "number") effect.line = e["line"];
		if (typeof e["column"] === "number") effect.column = e["column"];
		if (typeof e["excerpt"] === "string" && e["excerpt"] !== "") effect.excerpt = e["excerpt"];
		return effect;
	});
	return value.partial === true ? { effects, partial: true } : { effects };
}

/* ────────────────────────────────────────────────────────────────────────────
 * What the modal is shown
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Everything the review needs, assembled by the caller from the **verified** artifact payload.
 *
 * Deliberately not the payload type itself: this modal must be constructible in a test without a
 * signed envelope, and narrowing the input is what keeps it from quietly growing a dependency on
 * the wire contract.
 */
export interface ReviewSubject {
	/**
	 * The user's own sentence, verbatim, **as the plugin recorded it on this device** — not as the
	 * artifact echoes it back. The one thing on screen they wrote themselves, so it comes from the
	 * side of the wire they typed it on.
	 */
	request: string;
	/**
	 * The sentence the *artifact* claims to have been generated from. Compared against
	 * {@link request} and shown only when the two differ, which would mean the daemon generated for
	 * a request other than the one this device sent — a thing the review exists to catch and which
	 * nothing else in the pipeline looks at.
	 */
	echoedRequest?: string;
	/** The generated plugin's id — also the folder that would be created under `plugins/`. */
	modId: string;
	/** The mod's display name, from its manifest. */
	modName: string;
	/** What is being patched. */
	target: TargetRef;
	/** How it is reached: the plane, and the exact member. */
	reach: ReachTarget;
	/** The model's own plain-language account of what the patch does. */
	explanation: string;
	/**
	 * What the mod does to things that are not itself, as declared inside the signed payload.
	 *
	 * **Omitted means "this daemon did not analyse effects", which is not the same as "there are
	 * none", and the modal says which.** The distinction is the whole value of the section: a blank
	 * where an analysis should be must never read as a clean bill of health.
	 */
	effects?: EffectsDeclaration;
	/** The bytes that would be written to `main.js` and executed. Shown in full. */
	mainJs: string;
	/** The stylesheet a plane-E mod ships, when it ships one. Shown in full too. */
	stylesCss?: string;
	/** Hex SHA-256 of `mainJs`, as the daemon signed it. */
	sha256?: string;
	/** Validator findings at `warning` severity — real findings that did not block the build. */
	warnings?: readonly ValidationFinding[];
	/**
	 * What the button actually does. `enable` installs and switches the mod on; `install-only` is
	 * the "Enable a mod once it is installed" setting turned off, where the mod is written and
	 * **never enabled**, so its code does not run at all.
	 *
	 * The two are different promises and the modal must not make the wrong one — and until this
	 * pass, `install-only` made a promise the install path did not keep: it enabled the mod and
	 * disabled it a moment later, so `onload` ran. See {@link ReviewModal.renderConsequence}.
	 */
	outcome: "enable" | "install-only";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Describing the target
 * ──────────────────────────────────────────────────────────────────────────── */

/** The plane in the words a person would use. Mirrors `ComposeModal`'s prose, one step later. */
const PLANE_PROSE: Record<ReachTarget["plane"], string> = {
	A: "a built-in Obsidian class",
	B: "one live object inside Obsidian",
	C: "the plugin's own class",
	D: "the command itself",
	E: "the element on screen and its styling",
};

/**
 * The exact runtime handle the patch takes, as a single expression.
 *
 * This is the "specific member being patched" the review is required to show, and it is written out
 * per plane rather than summarised: `constructor.prototype.foo` and `.foo` on the live instance are
 * different blast radii, and a reader cannot tell them apart from a plane letter.
 */
export function reachHandle(reach: ReachTarget): string {
	switch (reach.plane) {
		case "A":
			return `${reach.exportName}.${reach.holder === "static" ? "" : "prototype."}${reach.member}`;
		case "B":
			return `app.${reach.path}.${reach.member}`;
		case "C": {
			const via = reach.via === undefined ? "" : `.${reach.via}`;
			const holder = reach.holder === "prototype" ? ".constructor.prototype" : "";
			return `app.plugins.plugins["${reach.pluginId}"]${via}${holder}.${reach.member}`;
		}
		case "D":
			return `app.commands.commands["${reach.commandId}"].${reach.property}`;
		case "E":
			return reach.mode === "css" ? `styles.css → ${reach.selector}` : reach.selector;
		default:
			// Unreachable by the type, and reached anyway if a newer daemon signs a plane this build
			// has no name for. A review that cannot describe the handle says so; it must never render
			// `undefined` where a member expression belongs, because a blank there reads as "nothing".
			return `modkit cannot describe this handle — it is reached in a way (“${String((reach as { plane: unknown }).plane)}”) this version has no name for`;
	}
}

/** `Tasks 7.21.0`, or `Obsidian 1.9.14 — page-preview`. Name first: it is what the user recognises. */
export function reviewTargetLine(target: TargetRef): string {
	if (target.kind === "plugin") {
		const name = target.pluginName ?? target.pluginId;
		return target.pluginVersion === "" ? name : `${name} ${target.pluginVersion}`;
	}
	const app = target.appVersion === "" ? "Obsidian" : `Obsidian ${target.appVersion}`;
	return target.internalPluginId === undefined ? app : `${app} — ${target.internalPluginId}`;
}

/** The machine-readable half of the target, kept beside the human half rather than instead of it. */
function targetIdLine(target: TargetRef): string {
	return target.kind === "plugin" ? target.pluginId : (target.internalPluginId ?? "obsidian (core)");
}

/** `1.2 KB`, `860 bytes`. Size is the one property of a source block readable at a glance. */
function byteSize(text: string): string {
	const bytes = new TextEncoder().encode(text).length;
	if (bytes < 1024) return `${bytes} bytes`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The modal
 * ──────────────────────────────────────────────────────────────────────────── */

export class ReviewModal extends Modal {
	/** Set the instant a decision is made, so `onClose` knows this was not a dismissal. */
	private decided = false;

	/**
	 * A `Modal` is not a `Component`, so it has no `registerDomEvent`. It owns one instead, loaded on
	 * open and unloaded on close — the same shape `ComposeModal` uses, and the same contract modkit's
	 * validator demands of the code it ships.
	 */
	private readonly lifecycle = new Component();

	/**
	 * Rendered first and filled in last, if at all.
	 *
	 * An alarm about the modal itself has to sit above everything, and the stub DOM this is tested
	 * against has no `insertBefore` — so the slot is created in document order and written into
	 * afterwards rather than prepended. Empty in the ordinary case, and an empty `div` renders as
	 * nothing.
	 */
	private alarms: HTMLElement | null = null;

	/** The `<pre>` holding `main.js`, kept so the modal can check it is actually visible. */
	private sourceBlock: HTMLElement | null = null;

	/**
	 * The `<details>` folding {@link sourceBlock}, so {@link warnIfSourceHidden} can hold it open for
	 * the duration of its measurement — see that method for why.
	 */
	private sourceDetails: HTMLDetailsElement | null = null;

	constructor(
		app: App,
		private readonly subject: ReviewSubject,
		private readonly decide: (approved: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.lifecycle.load();
		// Session-scoped, like the picker's sheet and unlike `ui.css.ts`'s: this surface is on screen
		// for a minute at a time, so its rules live exactly as long as it does and come off with the
		// component that owns them. The plugin therefore keeps exactly one permanent stylesheet.
		// The modal's OWN document, not `activeDocument`: with Settings (a separate window) focused,
		// the default would style Settings and leave this gate unstyled — the same window mix-up that
		// bit the plane-E mods and the plugin-level sheet (2026-09-03).
		injectReviewStyles(this.lifecycle, this.contentEl.ownerDocument);
		this.setTitle(`Read “${this.subject.modName}” before it runs`);

		const { contentEl } = this;
		contentEl.addClass("modkit-review");

		this.alarms = contentEl.createDiv();
		this.renderRequest(contentEl);
		this.renderTarget(contentEl);
		// Above the explanation and the source, deliberately. The explanation is the model's prose
		// about its own code and the source is 240 lines of generated JavaScript; the effects list is
		// the only thing here a person can actually adjudicate in ten seconds, so it goes where the
		// eye lands. The source still follows in full — this leads the review, it does not replace it.
		this.renderEffects(contentEl);
		this.renderExplanation(contentEl);
		this.renderWarnings(contentEl);
		this.renderSource(contentEl);
		this.renderConsequence(contentEl);
		this.renderActions(contentEl);
		this.warnIfSourceHidden();
	}

	override onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
		this.alarms = null;
		this.sourceBlock = null;
		this.sourceDetails = null;
		// Escape, the close button, or a click outside. Silence is not approval.
		if (!this.decided) {
			this.decided = true;
			this.decide(false);
		}
	}

	/* ── Sections ─────────────────────────────────────────────────────────── */

	/** The user's sentence, first and verbatim. Everything below is answerable only against it. */
	private renderRequest(parent: HTMLElement): void {
		this.heading(parent, "You asked for");
		parent.createDiv({ cls: "modkit-review__quote", text: this.subject.request });

		const echoed = this.subject.echoedRequest;
		if (echoed === undefined || echoed.trim() === this.subject.request.trim()) return;
		// Not a warning about the code — a warning about whether this artifact answers this request
		// at all. Both sentences are shown, because which of them is wrong is the user's call.
		const box = parent.createDiv({ cls: "modkit-review__mismatch" });
		box.createDiv({
			cls: "modkit-review__mismatch-head",
			text: "This patch was written from a different sentence than the one you sent.",
		});
		box.createDiv({ cls: "modkit-review__quote", text: echoed });
	}

	private renderTarget(parent: HTMLElement): void {
		this.heading(parent, "What it patches");
		const grid = parent.createDiv({ cls: "modkit-review__kv" });

		this.fact(grid, "Target", reviewTargetLine(this.subject.target), targetIdLine(this.subject.target));
		const plane = this.subject.reach.plane;
		const prose = PLANE_PROSE[plane] as string | undefined;
		// No sub-line here any more: it used to repeat the plane in `REACH_PLANE_LABELS`' technical
		// words (or, for an unrecognised plane, a bare capital letter with nothing to explain it) —
		// spending the reader's attention on a worse restatement of what "The member it wraps" below
		// already says precisely.
		this.fact(grid, "Reached through", prose ?? "something this version of modkit has no name for");
		this.factMono(grid, "The member it wraps", reachHandle(this.subject.reach));
		this.factMono(grid, "Installed as", `.obsidian/plugins/${this.subject.modId}/`);
	}

	/**
	 * What the mod does to things that are not itself — the section that leads the review.
	 *
	 * Three renderings for three genuinely different situations, and keeping them apart is the
	 * point of the section:
	 *
	 * - **no declaration at all** — an older or differently-configured daemon. Say exactly that.
	 *   The failure mode this avoids is a reassuring blank, which is what a missing analysis looks
	 *   like if you render it the same way as an empty one.
	 * - **an empty declaration** — one flat line, deliberately boring. Most mods are somebody
	 *   asking for a smaller font, and if the common case is loud then a real finding is invisible.
	 * - **anything else** — a list, worst-first is not attempted (the daemon does not rank them),
	 *   each with what it means for reclaim.
	 *
	 * The stylesheet entry is derived **here**, from the bytes this modal is showing, rather than
	 * taken from the declaration: a mod that ships CSS ships it whether or not any analyser
	 * mentioned it, and this is the one effect the modal can establish for itself.
	 */
	private renderEffects(parent: HTMLElement): void {
		this.heading(parent, "What it changes outside itself");

		const declared = this.subject.effects;
		const styles = this.subject.stylesCss;
		const derived: ModEffect[] =
			styles === undefined || styles === ""
				? []
				: [{ kind: "stylesheet", detail: `styles.css, ${byteSize(styles)}, shown in full below` }];

		if (declared === undefined) {
			// No chip row here. The row's whole contract is "lit = applies, muted = does not", and
			// with no declaration at all modkit has not checked any of the four — a muted row would
			// say "checked, and it's clean" about something never examined. That is exactly the
			// reassuring-blank failure this section exists to avoid, one element higher up the DOM
			// than the paragraph already written to avoid it.
			parent.createDiv({
				cls: "modkit-review__effects-unknown",
				text: "Whatever built this did not report what the patch touches outside its own change, so modkit cannot tell you. That is not the same as “nothing” — the code below is the only account you have.",
			});
			// What this build can still establish for itself, with no daemon involved.
			if (derived.length > 0) {
				const list = parent.createEl("ul", { cls: "modkit-review__effects" });
				for (const effect of derived) this.effectLine(list, effect);
			}
			return;
		}

		// A quick-scan row, always the same four categories in the same order, lit when they apply
		// and muted when they don't — so "nothing lit up" is itself an answer, not an absence, and a
		// reader never has to count list items to know roughly what kind of mod this is before
		// reading the detail below. Only reachable once a declaration exists — see `renderEffectChips`
		// for what happens to an effect kind this build has no category for.
		const effects = [...declared.effects, ...derived];
		this.renderEffectChips(parent, effects);

		if (effects.length === 0) {
			parent.createDiv({
				cls: "modkit-review__effects-none",
				text: "Nothing. It wraps the one thing named above, and touches no files, no other plugin and no network.",
			});
		} else {
			const list = parent.createEl("ul", { cls: "modkit-review__effects" });
			for (const effect of effects) this.effectLine(list, effect);
		}

		if (declared.partial === true) {
			parent.createDiv({
				cls: "modkit-review__aside",
				text: "modkit could not follow all of this code, so this list may be incomplete.",
			});
		}
		parent.createDiv({
			cls: "modkit-review__aside",
			text: "This is the half Obsidian cannot undo. Switching a patch off removes the change it makes, never what it already did.",
		});
	}

	/**
	 * Four fixed categories, always rendered in this order, coloured when an effect maps to them and
	 * muted when none does. Never called with no declaration at all — {@link renderEffects} renders
	 * that case as prose instead, because a muted row and "modkit didn't check" are different facts.
	 *
	 * `EFFECT_CATEGORY` is deliberately a superset-tolerant partial map, so an effect kind this build
	 * has never heard of maps to nothing — but "lights nothing" must not read the same as "checked,
	 * and it doesn't apply". When any effect's kind falls outside the map, every unlit chip is marked
	 * `is-unknown` (a dashed border and a trailing "?") instead of the plain muted style, because an
	 * effect this build can't categorise could just as well belong to one of the categories that
	 * still look empty. The full account is always in the detailed list below either way.
	 */
	private renderEffectChips(parent: HTMLElement, effects: readonly ModEffect[]): void {
		type Category = "styling" | "window" | "files" | "network";
		const present = new Set(effects.map((effect) => EFFECT_CATEGORY[effect.kind]).filter((c): c is Category => c !== undefined));
		const hasUnknownKind = effects.some((effect) => EFFECT_CATEGORY[effect.kind] === undefined);
		const chips = parent.createDiv({ cls: "modkit-review__chips" });
		for (const [key, label] of EFFECT_CATEGORY_LABELS) {
			const lit = present.has(key);
			chips.createSpan({
				cls: lit ? "modkit-review__echip is-lit" : hasUnknownKind ? "modkit-review__echip is-unknown" : "modkit-review__echip",
				text: lit || !hasUnknownKind ? label : `${label} ?`,
			});
		}
	}

	/** One effect: what it is, then what it means once the mod has done it. */
	private effectLine(list: HTMLElement, effect: ModEffect): void {
		const item = list.createEl("li");
		const prose = EFFECT_PROSE[effect.kind];
		// An unrecognised kind is shown, never dropped — but the slug is the detail, not the sentence:
		// a newer daemon must not be able to make an effect invisible here by naming it something
		// this build has never heard of.
		item.createSpan({
			cls: "modkit-review__effect-kind",
			text: prose === undefined ? "Does something this version of modkit has no words for" : prose.title,
		});
		if (prose === undefined) {
			item.createDiv({ cls: "modkit-review__effect-note", text: `Whatever built this called it “${effect.kind}”. Read the code below.` });
		}
		if (effect.detail !== undefined && effect.detail !== "") {
			item.createDiv({ cls: "modkit-review__effect-detail", text: effect.detail });
		}
		if (prose !== undefined) item.createDiv({ cls: "modkit-review__effect-note", text: prose.note });
		if (typeof effect.line === "number") {
			const where = `main.js:${effect.line}${typeof effect.column === "number" ? `:${effect.column}` : ""}`;
			item.createDiv({ cls: "modkit-review__where", text: where });
		}
		if (effect.excerpt !== undefined && effect.excerpt !== "") {
			item.createEl("code", { cls: "modkit-review__excerpt", text: effect.excerpt });
		}
	}

	/**
	 * The one check this modal makes on itself: is the code block actually visible?
	 *
	 * An enabled mod's `styles.css` applies to the whole application, this modal included, and it
	 * keeps applying to every *later* review. A single `.modkit-review__source { display: none }`
	 * would leave the gate reporting that it showed the user the source while showing them nothing.
	 * The daemon now refuses to build a stylesheet that names modkit (`css-targets-modkit`), and
	 * this is the second half of that: a theme, a CSS snippet or a mod installed before that rule
	 * existed can do the same thing, and none of them go through the daemon.
	 *
	 * The probe walks up from {@link sourceBlock} itself, with {@link sourceDetails} — the `<details>`
	 * folding it — held open for the measurement and restored before this returns. A closed
	 * `<details>` makes its non-summary children compute hidden by the browser's own rule, so probing
	 * the `<pre>` inside a closed fold would fire on every normal render; probing only the fold (a
	 * 2026-09-03 draft) would miss a hostile rule aimed at `.modkit-review__source` itself. Forcing
	 * it open synchronously asks the real question — "when the user opens this, will they see the
	 * code?" — without anything painting in between.
	 *
	 * It **reports, it never denies.** A false positive that cancelled the install would leave a
	 * user unable to install anything, whose only workaround is to switch the review off — which is
	 * the one outcome this whole surface exists to prevent. Everything is optional-chained and
	 * wrapped: no layout engine (the test stub), no check.
	 */
	private warnIfSourceHidden(): void {
		try {
			const el = this.sourceBlock;
			const slot = this.alarms;
			if (el === null || slot === null) return;
			if (typeof activeWindow === "undefined") return;
			const view: Window = activeWindow;
			if (typeof view.getComputedStyle !== "function") return;

			// Probe the `<pre>` itself, with the fold forced open for the duration of the measurement
			// and put back before this function returns — synchronously, so nothing paints in between.
			// Starting the walk at the `<details>` (an earlier version) left a hostile rule aimed at
			// `.modkit-review__source` itself undetected; starting inside a *closed* fold fires on every
			// normal render. Opening it for the measurement is the only way to ask the real question.
			const fold = this.sourceDetails as (HTMLElement & { open?: boolean }) | null;
			const wasOpen = fold === null || fold.open !== false;
			if (fold !== null && !wasOpen) fold.open = true;
			try {
				let node: HTMLElement | null = el;
				for (let hops = 0; node !== null && hops < 12; hops += 1) {
					const style = view.getComputedStyle(node);
					const invisible =
						style.display === "none" ||
						style.visibility === "hidden" ||
						(style.opacity !== "" && Number(style.opacity) === 0);
					if (invisible) {
						slot.createDiv({
							cls: "modkit-review__mismatch",
						}).createDiv({
							cls: "modkit-review__mismatch-head",
							text: "Something on this device is hiding the code below — a theme, a CSS snippet, or another patch's stylesheet. This cannot show you what it says it is showing you. Cancel, and read the file on disk instead.",
						});
						return;
					}
					if (node === this.contentEl) return;
					node = node.parentElement;
				}
			} finally {
				if (fold !== null && !wasOpen) fold.open = false;
			}
		} catch (err) {
			// A visibility probe must never be the thing that breaks the gate.
			console.error("modkit: could not check that the review's source block is visible", err);
		}
	}

	/**
	 * The model's own words, labelled as the model's own words.
	 *
	 * The label is load-bearing. This paragraph is the most readable thing on screen and the least
	 * verifiable: it was written by the same process that wrote the code, so it describes what the
	 * code was *meant* to do. The source block below is the only account that is checkable.
	 */
	private renderExplanation(parent: HTMLElement): void {
		if (this.subject.explanation.trim() === "") return;
		this.heading(parent, "What the model says it does");
		parent.createDiv({ cls: "modkit-review__prose", text: this.subject.explanation });
		parent.createDiv({
			cls: "modkit-review__aside",
			text: "Written by the same model that wrote the patch, so it describes what was meant rather than what is there.",
		});
	}

	/**
	 * Warnings the validator raised and shipped anyway — one amber line, not a wall of findings.
	 *
	 * They are surfaced here rather than swallowed because a warning is, by the validator's own
	 * definition, a finding somebody has to act on — there is no `info` severity precisely so that
	 * nothing lands in this list that does not matter. But most reviews have none, and the one line
	 * a reader actually needs is "something was flagged" — the full finding (message, rule, location,
	 * excerpt) is one tap away in a fold, not printed in full for every mod whether or not anyone is
	 * going to read it.
	 */
	private renderWarnings(parent: HTMLElement): void {
		const warnings = this.subject.warnings ?? [];
		if (warnings.length === 0) return;

		const box = parent.createDiv({ cls: "modkit-review__warn-line" });
		box.createSpan({
			text: warnings.length === 1 ? "modkit flagged one thing but let it through." : `modkit flagged ${warnings.length} things but let them through.`,
		});

		const details = box.createEl("details");
		details.createEl("summary", { text: "Show details" });
		const list = details.createEl("ul", { cls: "modkit-review__warnings" });
		for (const finding of warnings) {
			const item = list.createEl("li");
			// The message leads and the rule id trails it as detail. A rule id is a name for whoever is
			// working on the validator; on its own it tells the person deciding whether to run this
			// code nothing at all.
			item.createSpan({ text: finding.message });
			const where = `${finding.file ?? "main.js"}:${finding.line}:${finding.column}`;
			const trailer = item.createDiv({ cls: "modkit-review__where" });
			trailer.createSpan({ cls: "modkit-review__rule", text: finding.rule });
			trailer.createSpan({ text: ` · ${where}` });
			if (finding.excerpt !== undefined && finding.excerpt !== "") {
				item.createEl("code", { cls: "modkit-review__excerpt", text: finding.excerpt });
			}
		}
	}

	/**
	 * The code, in full, scrollable, monospace, selectable.
	 *
	 * `main.js` is the bundle as it would be written to disk and executed — not the model's answer
	 * re-rendered, and not a diff. It is longer than the model's source because `monkey-around` is
	 * bundled into it, and that is the honest thing to show: the file on disk is what runs.
	 */
	private renderSource(parent: HTMLElement): void {
		this.heading(parent, "The code that would run");
		parent.createDiv({
			cls: "modkit-review__aside",
			text: `main.js — ${byteSize(this.subject.mainJs)}${this.subject.sha256 === undefined || this.subject.sha256 === "" ? "" : ` · sha256 ${this.subject.sha256.slice(0, 12)}…`}. This is the whole file, exactly as it would be written; the bundled monkey-around helper is part of it.`,
		});
		const fold = parent.createEl("details", { cls: "modkit-review__source-fold" });
		fold.createEl("summary", { text: "Show the code" });
		this.sourceDetails = fold;
		this.sourceBlock = fold.createEl("pre", { cls: "modkit-review__source" });
		this.sourceBlock.createEl("code", { text: this.subject.mainJs });

		const styles = this.subject.stylesCss;
		if (styles === undefined || styles === "") return;
		// Shown with exactly the same weight as the JavaScript — same heading, same `<pre>`, same
		// full text — and that is deliberate, because it is the *only* review this file gets. Until
		// `screenStylesheet` landed in the daemon, `stylesCss` went from the model to disk with
		// nothing having read it: the source validator only ever ran on `patch.source`. The daemon
		// now blocks the two indefensible shapes (a rule naming modkit, a remote `url()`/`@import`)
		// and warns on the judgement calls, but CSS is not a decidable language and this block is
		// the mitigation that does not depend on an analyser being complete.
		this.heading(parent, "The stylesheet it ships");
		parent.createDiv({
			cls: "modkit-review__aside",
			text: `styles.css — ${byteSize(styles)}. Obsidian applies this to the whole application, not just the target, for as long as the patch is switched on — including to anything modkit shows you afterwards.`,
		});
		parent.createEl("pre", { cls: "modkit-review__source" }).createEl("code", { text: styles });
	}

	/**
	 * What the button on the left actually does, per outcome.
	 *
	 * The install-only branch used to promise that the mod was "written to disk and left off until
	 * you turn it on" while the install path enabled it, waited for it to be live, and disabled it
	 * again — so its `onload` ran, its patch installed, and anything it does on load had already
	 * happened. That is a false statement in the one surface whose entire value is that its
	 * statements are true, and on the effects axis it is the worst possible one to get wrong: the
	 * mod is switched off afterwards, and whatever it wrote, sent or deleted is not.
	 *
	 * Fixed on the code side — `ModInstaller.install(..., { enable: false })` now never enables it —
	 * so this block can say what it says. Both halves have to stay true together: if the installer
	 * ever goes back to enable-then-disable, this text becomes a lie again.
	 */
	private renderConsequence(parent: HTMLElement): void {
		const box = parent.createDiv({ cls: "modkit-review__consequence" });
		const enabling = this.subject.outcome === "enable";
		box.createDiv({
			cls: "modkit-review__consequence-head",
			text: enabling ? "If you turn this on" : "If you install this",
		});
		const list = box.createEl("ul");
		for (const line of enabling ? ENABLE_CONSEQUENCES : INSTALL_ONLY_CONSEQUENCES) {
			list.createEl("li", { text: line });
		}
		box.createDiv({ cls: "modkit-review__caveat", text: VALIDATOR_CAVEAT });
	}

	/**
	 * One primary action, styled like every other screen's `.mod-cta` — the same visual grammar as
	 * Compose's "Write the change", so the reader never has to relearn which button is the one that
	 * does the thing. "Not this" stays plain, deliberately unstyled next to it.
	 *
	 * The safety property this file has always had is independent of which button *looks* primary:
	 * "Not this" keeps the default keyboard focus, so Return or Space — pressed without reading
	 * anything — lands on the side that writes nothing, not on the side that runs generated code.
	 * That is a focus decision, not a style one, and it does not need the safe answer to be styled
	 * as an alarm to hold.
	 */
	private renderActions(parent: HTMLElement): void {
		const setting = new Setting(parent).setClass("modkit-review__actions");
		setting.setDesc("“Not this” writes nothing at all — no folder, no files, nothing switched on.");

		let safeButton: ButtonComponent | null = null;

		setting.addButton((button) => {
			safeButton = button.setButtonText("Not this").onClick(() => {
				this.finish(false);
			});
		});
		setting.addButton((button) =>
			button
				.setButtonText(this.subject.outcome === "enable" ? "Install and turn it on" : "Install, leave it off")
				.setCta()
				.onClick(() => {
					this.finish(true);
				}),
		);

		// Focused, so Return and Space both land on "Not this" and running the code needs a deliberate
		// click on the other button.
		//
		// Optional all the way down on purpose. Everything above it has already been rendered, and a
		// throw here would leave a *safety gate* on screen with no buttons — the one failure whose
		// only workaround is for the user to switch the review off. Losing the default focus is a
		// far smaller loss than losing the modal.
		(safeButton as ButtonComponent | null)?.buttonEl?.focus?.();
	}

	/* ── Small builders ───────────────────────────────────────────────────── */

	private finish(approved: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.decide(approved);
		this.close();
	}

	private heading(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "modkit-review__heading", text });
	}

	private fact(grid: HTMLElement, key: string, value: string, sub?: string): void {
		grid.createDiv({ cls: "modkit-review__k", text: key });
		const cell = grid.createDiv({ cls: "modkit-review__v" });
		cell.createDiv({ text: value });
		if (sub !== undefined && sub !== "") cell.createDiv({ cls: "modkit-review__sub", text: sub });
	}

	private factMono(grid: HTMLElement, key: string, value: string): void {
		grid.createDiv({ cls: "modkit-review__k", text: key });
		grid.createDiv({ cls: "modkit-review__v modkit-review__mono", text: value });
	}
}

/**
 * Open the review and resolve to the user's answer. Resolves exactly once, whatever closes it.
 *
 * The caller must not have written anything yet — see the file header. `false` means "do nothing at
 * all", never "undo what was done".
 */
export function reviewGeneratedMod(app: App, subject: ReviewSubject): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (approved: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(approved);
		};
		try {
			new ReviewModal(app, subject, settle).open();
		} catch (err) {
			// A gate that cannot render must **deny**, visibly. Rejecting instead would surface as an
			// unhandled rejection two frames up with the progress bar still spinning, and a review the
			// user never saw would look exactly like a review they had not answered yet.
			console.error("modkit: the review modal could not be rendered", err);
			new Notice(
				`modkit could not show you this code (${err instanceof Error ? err.message : String(err)}), so “${subject.modName}” was not installed. Nothing was written.`,
				0,
			);
			settle(false);
		}
	});
}

/* ────────────────────────────────────────────────────────────────────────────
 * Styles
 * ──────────────────────────────────────────────────────────────────────────── */

/** The value of `data-modkit-style` for this sheet — `ui.css.ts`'s is `"ui"`, the picker's `"picker"`. */
export const REVIEW_STYLE_ID = "review";

export const REVIEW_CSS = `
.modkit-review {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-2, 8px);
}

/* The modal is deliberately tall: the source block is the point of it, and a review that needs the
   user to scroll a 6-line window is a review nobody does. */
.modkit-review .modkit-review__source {
	max-height: 42vh;
	overflow: auto;
	margin: 0;
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-s, 4px);
	background: var(--background-primary-alt, var(--background-secondary));
	font-family: var(--font-monospace);
	font-size: var(--font-smallest, 11px);
	line-height: 1.5;
	tab-size: 2;
	white-space: pre;
	user-select: text;
}

.modkit-review__heading {
	margin-top: var(--size-4-2, 8px);
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
	font-size: var(--font-ui-small, 13px);
}

/* The user's own sentence. Selectable, wrapped, never truncated — it is the thing every other
   section is judged against. */
.modkit-review__quote {
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-radius: var(--radius-m, 8px);
	background: var(--background-secondary);
	color: var(--text-normal);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	user-select: text;
}

/* The one thing here that is a real alarm: the artifact answers a different question than the one
   this device asked. Nothing else in the pipeline compares those two strings. */
.modkit-review__mismatch {
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-left: 3px solid var(--text-error);
	border-radius: var(--radius-s, 4px);
	background: var(--background-secondary);
}

.modkit-review__mismatch-head {
	margin-bottom: var(--size-4-1, 4px);
	color: var(--text-error);
	font-weight: var(--font-semibold, 600);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__prose {
	color: var(--text-normal);
	overflow-wrap: anywhere;
}

.modkit-review__aside {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-review__kv {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: var(--size-4-1, 4px) var(--size-4-3, 12px);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__k {
	color: var(--text-muted);
}

.modkit-review__v {
	color: var(--text-normal);
	min-width: 0;
	overflow-wrap: anywhere;
}

.modkit-review__sub {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
}

/* The exact handle. Scrolls rather than wraps: a wrapped member expression reads as two. */
.modkit-review__mono {
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
	overflow-x: auto;
	white-space: nowrap;
	padding-bottom: 2px;
}

/* The quick-scan row: four fixed chips, lit when an effect maps to them and muted otherwise, so the
   row's shape never changes between mods and "nothing lit up" reads as an answer rather than an
   absence. Same outline-pill construction as the mod list's health pill and the plugin picker's
   badges, so a small status label looks like the same kind of thing everywhere in modkit. */
.modkit-review__chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--size-4-1, 4px);
	margin-bottom: var(--size-4-2, 8px);
}

.modkit-review__echip {
	padding: 1px var(--size-4-2, 8px);
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-s, 4px);
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	white-space: nowrap;
}

.modkit-review__echip.is-lit {
	border-color: currentColor;
	color: var(--text-accent);
}

/* An effect kind this build has no category for could belong to any of the categories that still
   look empty, so every unlit chip says so with a dashed edge and a trailing "?" rather than reading
   as "checked, and it's clean" — see renderEffectChips. */
.modkit-review__echip.is-unknown {
	border-style: dashed;
	color: var(--text-muted);
}

/* The effects list. Stated in the app's own text colours: a mod that writes a file is not an
   emergency, it is a fact the reader has to weigh, and the boring case has to look boring or the
   interesting one stops standing out. */
.modkit-review__effects {
	margin: 0;
	padding-left: 1.3em;
	color: var(--text-normal);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__effects > li {
	margin-bottom: var(--size-4-2, 8px);
}

.modkit-review__effect-kind {
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
}

.modkit-review__effect-detail {
	color: var(--text-normal);
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
	overflow-wrap: anywhere;
}

.modkit-review__effect-note {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
}

/* The common case: one flat line, no border, no icon, no colour. */
.modkit-review__effects-none {
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

/* Absent is not empty. A missing analysis gets the muted-but-bordered treatment, so it cannot be
   mistaken at a glance for the boring line above it. */
.modkit-review__effects-unknown {
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-left: 3px solid var(--text-muted);
	border-radius: var(--radius-s, 4px);
	background: var(--background-secondary);
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

/* One amber line, not a wall of findings — the detail is a tap away in the fold below it. */
.modkit-review__warn-line {
	margin: var(--size-4-2, 8px) 0;
	color: var(--text-warning, var(--color-yellow));
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__warn-line summary {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	cursor: var(--cursor, pointer);
}

/* Folded by default: 240 lines of generated JavaScript is not the first thing a reader needs, but
   opening it must read as an invitation, not an afterthought — hence the accent colour rather than
   the muted one every other disclosure in this file uses. */
.modkit-review__source-fold summary {
	margin-bottom: var(--size-4-2, 8px);
	color: var(--text-accent);
	font-weight: var(--font-semibold, 600);
	font-size: var(--font-ui-small, 13px);
	cursor: var(--cursor, pointer);
}

/* A coarse pointer needs a real target, not a mouse-sized one — the same 44px floor the picker's
   cancel button already holds itself to. Gated on pointer: coarse so desktop density is
   untouched. */
@media (pointer: coarse) {
	.modkit-review__source-fold summary,
	.modkit-review__warn-line summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		padding: 0 var(--size-4-2, 8px);
	}
}

.modkit-review__warnings {
	margin: var(--size-4-2, 8px) 0 0;
	padding-left: 1.3em;
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__warnings > li {
	margin-bottom: var(--size-4-1, 4px);
}

.modkit-review__rule {
	color: var(--text-warning, var(--text-accent));
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-review__where,
.modkit-review__excerpt {
	color: var(--text-faint);
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
}

/* Stated, not shouted: one accent rule and the app's own muted text. A modal that shouts is a modal
   that gets clicked through, and most mods are somebody asking for a smaller font. */
.modkit-review__consequence {
	margin-top: var(--size-4-3, 12px);
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-left: 3px solid var(--text-accent);
	border-radius: var(--radius-s, 4px);
	background: var(--background-secondary);
}

.modkit-review__consequence-head {
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__consequence ul {
	margin: var(--size-4-1, 4px) 0 0 0;
	padding-left: 1.3em;
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

.modkit-review__caveat {
	margin-top: var(--size-4-2, 8px);
	padding-top: var(--size-4-2, 8px);
	border-top: 1px solid var(--background-modifier-border);
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-review__actions.setting-item {
	border-top: 1px solid var(--background-modifier-border);
	padding: var(--size-4-3, 12px) 0 0;
	align-items: center;
}
`;

/**
 * Inject {@link REVIEW_CSS} and register its removal on the owning component.
 *
 * Same shape as `injectUiStyles`: a sheet left behind by an earlier load is removed rather than
 * reused, because reuse means two components each believing they own one element. `activeDocument`
 * is Obsidian's documented global and the popout-window-correct one.
 */
export function injectReviewStyles(component: Component, doc: Document = activeDocument): HTMLStyleElement {
	for (const stale of Array.from(doc.head.querySelectorAll(`style[${MODKIT_STYLE_ATTR}="${REVIEW_STYLE_ID}"]`))) {
		stale.remove();
	}

	const style = doc.head.createEl("style", { attr: { [MODKIT_STYLE_ATTR]: REVIEW_STYLE_ID } });
	style.textContent = REVIEW_CSS;
	component.register(() => {
		style.remove();
	});
	return style;
}
