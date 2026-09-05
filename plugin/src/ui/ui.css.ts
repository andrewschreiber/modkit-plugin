/**
 * modkit's stylesheet, as one exported string.
 *
 * It is a `.ts` file rather than a `.css` file so the modal code and the rules it depends on move
 * together: a class renamed in one is a compile error away from being renamed in the other, and the
 * esbuild step needs no CSS plugin.
 *
 * ## How it reaches the app
 *
 * {@link injectUiStyles} puts it in `document.head` and registers its removal — the same shape as
 * `injectPickerStyles`, sharing the same `data-modkit-style` marker attribute so every sheet modkit
 * injects is findable with one selector. A popout window is a second document and needs its own
 * call.
 *
 * The build may also emit these rules as `plugin/dist/styles.css`, which Obsidian loads for the
 * whole session. Doing both is wasteful rather than harmful — the same rules, defined twice — so
 * pick one. The runtime injection is the one to prefer while the plugin is still moving, because a
 * changed string takes effect on a plugin reload and a changed `styles.css` does not.
 *
 * ## House style
 *
 * Every value is an Obsidian variable with a literal fallback — `var(--size-4-2, 8px)`. Obsidian's
 * variable set is not part of its typed, versioned API, so a renamed variable should degrade to a
 * slightly-off spacing rather than to `0`. Colour is never hard-coded: the palette is the user's,
 * including whatever theme they run, and a hard-coded hex is the one thing that makes a plugin look
 * bolted on.
 *
 * Motion is limited to the two moments that tell the user something true: a 1.6s opacity pulse on
 * the status-bar dot while a job is running, and a one-shot settle on that same dot the instant it
 * becomes applied. Both are switched off under `prefers-reduced-motion`. Modals do not animate:
 * they are read, typed into, and dismissed in a few seconds, and a transition on that is a delay
 * wearing a costume.
 */

import type { Component } from "obsidian";
import { MODKIT_STYLE_ATTR } from "../picker/picker.css";

/** The value of `data-modkit-style` for this sheet — the picker's is `"picker"`. */
export const UI_STYLE_ID = "ui";

export const MODKIT_CSS = `
/* ── Compose modal ─────────────────────────────────────────────────────────── */

.modkit-compose {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-3, 12px);
}

/* The resolved target, named at the top before a word is typed — a wrong target caught here costs
   nothing, caught after costs a whole generation. Deliberately light: a small chip carrying the
   name, not a bordered card, because this is an orientation line, not a report. */
.modkit-target {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-1, 4px);
}

.modkit-target__row {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: var(--size-4-2, 8px);
}

/* Same recipe as .modkit-chip below (display/gap/padding/radius/background) — this is that class
   plus a modifier, not a second recipe: the two used to be defined twice with identical values,
   which is exactly how the four-card drift this file was rewritten to remove got started. Written
   compound (.modkit-chip.modkit-chip--target) so it outranks .modkit-chip's own color/size
   regardless of which rule the build happens to emit second. */
.modkit-chip.modkit-chip--target {
	color: var(--text-normal);
	font-size: var(--font-ui-small, 13px);
}

.modkit-target-chip__name {
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}

.modkit-target-chip__meta {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}

.modkit-target__why {
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

/* How modkit reaches the target — folded by default. It is real information (a wrong reach is a
   wasted generation) but it is the technical half, so it waits behind a tap rather than sitting
   above the field every time. */
.modkit-target-details summary {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	cursor: var(--cursor, pointer);
}

.modkit-target-details[open] summary {
	margin-bottom: var(--size-4-1, 4px);
}

.modkit-target__plane {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
}

/* The machine-readable handle: what a patch would actually hold on to. Scrolls rather than wraps,
   because a wrapped selector reads as two selectors. */
.modkit-target__handle {
	color: var(--text-faint);
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
	overflow-x: auto;
	white-space: nowrap;
	padding-bottom: 2px;
}

.modkit-target__actions {
	display: flex;
	gap: var(--size-4-2, 8px);
}

/* What else the picked element could have belonged to. Shown whenever attribution was not certain,
   because the cheapest correction is the one made before a word is typed. */
.modkit-alternatives {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--size-4-2, 8px);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-alternatives__label {
	color: var(--text-faint);
}

.modkit-link {
	background: none;
	border: none;
	box-shadow: none;
	padding: 0;
	cursor: var(--cursor, pointer);
	color: var(--text-accent);
	font-size: var(--font-ui-small, 13px);
}

.modkit-link:hover {
	color: var(--text-accent-hover, var(--text-accent));
	text-decoration: underline;
	background: none;
	box-shadow: none;
}

/* A coarse pointer needs a real target, not a mouse-sized one — the 44px floor every tap target in
   modkit holds itself to (the picker's own cancel button sets the pattern). Gated on pointer:
   coarse so desktop's tighter, link-styled density is untouched. */
@media (pointer: coarse) {
	.modkit-target-details summary,
	.modkit-link {
		min-height: 44px;
		display: flex;
		align-items: center;
		padding: 0 var(--size-4-2, 8px);
	}
}

/* ── Picked-element chips ──────────────────────────────────────────────────── */

.modkit-chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--size-4-1, 4px);
}

.modkit-chip {
	display: inline-flex;
	align-items: baseline;
	gap: var(--size-4-1, 4px);
	max-width: 100%;
	padding: 2px var(--size-4-2, 8px);
	border-radius: var(--radius-s, 4px);
	background: var(--background-modifier-hover);
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-chip__ord {
	color: var(--text-faint);
	font-variant-numeric: tabular-nums;
}

.modkit-chip__sel {
	font-family: var(--font-monospace);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* A node that was re-rendered away before it could be described. Reported, never dropped —
   "the thing I pointed at no longer exists" is information the generator can use. */
.modkit-chip.is-gone .modkit-chip__sel {
	text-decoration: line-through;
}

/* ── The request field ─────────────────────────────────────────────────────── */

.modkit-field {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-1, 4px);
}

.modkit-field__label {
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
}

/* Scoped to the compose sheet: the settings tab's mod cards reuse the class name for the quoted
   sentence, and this textarea sizing leaked onto them as a six-line empty block (2026-09-03). */
.modkit-compose .modkit-request {
	width: 100%;
	min-height: 6.5em;
	resize: vertical;
	font-family: inherit;
	line-height: 1.45;
}

.modkit-field__foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--size-4-2, 8px);
	min-height: 1.2em;
}

.modkit-count {
	margin-left: auto;
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	font-variant-numeric: tabular-nums;
}

.modkit-count.is-over {
	color: var(--text-error);
}

.modkit-error {
	color: var(--text-error);
	font-size: var(--font-ui-small, 13px);
}

/* ── Examples ──────────────────────────────────────────────────────────────── */

.modkit-examples {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-1, 4px);
}

.modkit-examples__label {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-example {
	width: 100%;
	text-align: left;
	height: auto;
	padding: var(--size-4-1, 4px) var(--size-4-2, 8px);
	border: 1px dashed var(--background-modifier-border);
	border-radius: var(--radius-s, 4px);
	background: none;
	box-shadow: none;
	color: var(--text-muted);
	font-size: var(--font-ui-small, 13px);
	white-space: normal;
	cursor: var(--cursor, pointer);
}

.modkit-example:hover {
	border-style: solid;
	background: var(--background-modifier-hover);
	box-shadow: none;
	color: var(--text-normal);
}

/* ── Footer, confirmation, refusal ─────────────────────────────────────────── */

.modkit-actions.setting-item {
	border-top: 1px solid var(--background-modifier-border);
	padding: var(--size-4-3, 12px) 0 0;
	align-items: center;
}

.modkit-actions .setting-item-info {
	margin-right: var(--size-4-2, 8px);
}

.modkit-kbd {
	padding: 0 4px;
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-s, 4px);
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
}

.modkit-confirm {
	display: flex;
	align-items: center;
	gap: var(--size-4-2, 8px);
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border: 1px solid var(--background-modifier-border);
	border-radius: var(--radius-m, 8px);
	background: var(--background-primary-alt, var(--background-secondary));
}

.modkit-confirm__text {
	flex: 1 1 auto;
	color: var(--text-normal);
	font-size: var(--font-ui-small, 13px);
}

/* A refusal is a first-class outcome, so it gets the space the field would have had — not a red
   toast over a form the user can no longer usefully submit. Same note-card recipe as
   ReviewModal's mismatch/consequence blocks (padding all round, radius, a quiet background, one
   coloured accent edge) so a refusal in Compose and one in the job receipt read as the same kind
   of thing modkit says elsewhere — calm, not an alarm. */
.modkit-refusal {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-2, 8px);
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-left: 3px solid var(--text-error);
	border-radius: var(--radius-s, 4px);
	background: var(--background-secondary);
}

.modkit-refusal__headline {
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
}

.modkit-refusal__body {
	color: var(--text-muted);
}

.modkit-refusal__suggestion {
	color: var(--text-normal);
}

.modkit-refusal details > summary {
	color: var(--text-faint);
	font-size: var(--font-ui-smaller, 12px);
	cursor: var(--cursor, pointer);
}

.modkit-refusal pre,
.modkit-receipt pre {
	margin: var(--size-4-1, 4px) 0 0;
	padding: var(--size-4-2, 8px);
	border-radius: var(--radius-s, 4px);
	background: var(--background-secondary);
	font-size: var(--font-ui-smaller, 12px);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

/* ── Plugin picker rows ────────────────────────────────────────────────────── */

.modkit-suggest {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.modkit-suggest__top {
	display: flex;
	align-items: baseline;
	gap: var(--size-4-2, 8px);
	min-width: 0;
}

.modkit-suggest__name {
	color: var(--text-normal);
	font-weight: var(--font-semibold, 600);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.modkit-suggest__id {
	color: var(--text-faint);
	font-family: var(--font-monospace);
	font-size: var(--font-ui-smaller, 12px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.modkit-suggest__meta {
	color: var(--text-muted);
	font-size: var(--font-ui-smaller, 12px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Same recipe as the mod list's health pill in SettingsTab.ts — an outline, not a fill, so every
   small status label in modkit reads as one system: colour carries the meaning, not a block of
   background the eye has to first parse as "a button" or "a tag". */
.modkit-badge {
	flex: 0 0 auto;
	padding: 1px var(--size-4-2, 8px);
	border: 1px solid currentColor;
	border-radius: var(--radius-s, 4px);
	font-size: var(--font-ui-smaller, 12px);
	white-space: nowrap;
}

.modkit-badge--mods {
	color: var(--interactive-accent);
}

.modkit-badge--off {
	color: var(--text-muted);
}

/* ── Status bar ────────────────────────────────────────────────────────────── */

.modkit-status {
	display: inline-flex;
	align-items: center;
	gap: var(--size-4-1, 4px);
	cursor: var(--cursor, pointer);
}

.modkit-status__dot {
	flex: 0 0 auto;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--text-faint);
}

.modkit-status__elapsed {
	color: var(--text-faint);
	font-variant-numeric: tabular-nums;
}

.modkit-status.is-working .modkit-status__dot {
	background: var(--interactive-accent);
	animation: modkit-pulse 1.6s ease-in-out infinite;
}

/* Stale means the daemon could not be reached, NOT that the job stopped — so the dot changes
   colour and stops pulsing rather than turning into a failure. */
.modkit-status.is-stale .modkit-status__dot {
	background: var(--color-orange, var(--text-muted));
	animation: none;
}

/* The second of the two moments modkit ever animates: a quiet settle the instant a mod becomes
   applied, so the transition from "working" to "done" is felt rather than just read. It runs once,
   on the class change, and never repeats — a dot that kept moving after the job finished would be
   the "spinner with no state behind it" this design deliberately avoids. */
.modkit-status.is-applied .modkit-status__dot {
	background: var(--color-green, var(--interactive-accent));
	animation: modkit-settle var(--anim-duration-moderate, 250ms) var(--anim-motion-smooth, ease-out);
}

.modkit-status.is-refused .modkit-status__dot {
	background: var(--color-orange, var(--text-muted));
}

.modkit-status.is-failed .modkit-status__dot {
	background: var(--text-error);
}

@keyframes modkit-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.35; }
}

@keyframes modkit-settle {
	0% { transform: scale(0.4); opacity: 0.4; }
	60% { transform: scale(1.15); opacity: 1; }
	100% { transform: scale(1); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
	.modkit-status.is-working .modkit-status__dot,
	.modkit-status.is-applied .modkit-status__dot {
		animation: none;
	}
}

/* ── Job receipt ───────────────────────────────────────────────────────────── */

.modkit-receipt {
	display: flex;
	flex-direction: column;
	gap: var(--size-4-3, 12px);
}

.modkit-kv {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: var(--size-4-1, 4px) var(--size-4-3, 12px);
	font-size: var(--font-ui-small, 13px);
}

.modkit-kv__k {
	color: var(--text-muted);
}

.modkit-kv__v {
	color: var(--text-normal);
	overflow-wrap: anywhere;
}

/* The user's own sentence, kept verbatim and selectable: it is the seed a retry starts from. */
.modkit-quote {
	padding: var(--size-4-2, 8px) var(--size-4-3, 12px);
	border-radius: var(--radius-m, 8px);
	background: var(--background-secondary);
	color: var(--text-normal);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	user-select: text;
}
`;

/**
 * Inject {@link MODKIT_CSS} into a document, and register its removal on the owning component.
 *
 * A sheet left behind by an earlier load is removed rather than reused, for the reason
 * `injectPickerStyles` gives: reuse means two components each believing they own one element, and
 * the first teardown then pulls the stylesheet out from under whoever is still running. One owner,
 * always. The `component.register` call is the reclaim contract — modkit takes nothing from the DOM
 * it does not hand back.
 *
 * `activeDocument` rather than `document`: it is Obsidian's documented global and the
 * popout-window-correct one.
 */
export function injectUiStyles(component: Component, doc: Document = activeDocument): HTMLStyleElement {
	for (const stale of Array.from(doc.head.querySelectorAll(`style[${MODKIT_STYLE_ATTR}="${UI_STYLE_ID}"]`))) {
		stale.remove();
	}

	const style = doc.head.createEl("style", { attr: { [MODKIT_STYLE_ATTR]: UI_STYLE_ID } });
	style.textContent = MODKIT_CSS;
	component.register(() => {
		style.remove();
	});
	return style;
}
