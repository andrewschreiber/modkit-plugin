/**
 * The picker's stylesheet, as a string injected at runtime.
 *
 * Why a string rather than `styles.css`: the plugin's `styles.css` is loaded for the whole session,
 * and pick mode is a few seconds of it. Injecting a `<style>` on entry and removing it on exit means
 * the rules — including the one that changes the cursor over *every element in the app* — cannot
 * outlive the mode that needs them. The element carries a `data-modkit-style` attribute and is
 * removed through `Component.register`, so its teardown is the same public, provably-reversible
 * mechanism every other acquisition in modkit goes through.
 *
 * Every colour is an Obsidian CSS variable, with no literal hex/rgb fallback — Obsidian's base
 * theme always defines the core tokens this file uses, and a fallback color is itself a
 * hard-coded colour that would look wrong in every theme except the one it was copied from. A
 * picker that hardcodes its accent is a picker that looks wrong in the user's theme, and looking
 * wrong in the user's theme is how a tool reads as "not part of this app". Non-colour fallbacks
 * (radius, font stack) keep a literal, per the house style in `ui.css.ts`; `--shadow-s`/`--shadow-l`
 * are core tokens too, so they are used bare rather than with a hard-coded shadow colour standing in.
 */

import type { Component } from "obsidian";

/** Marks our own chrome. `isPickable()` refuses anything inside `[data-modkit-ui]`. */
export const MODKIT_UI_ATTR = "data-modkit-ui";

/** Marks a stylesheet modkit injected, so it is findable and de-duplicable. */
export const MODKIT_STYLE_ATTR = "data-modkit-style";

/** The value of {@link MODKIT_STYLE_ATTR} for this sheet. */
export const PICKER_STYLE_ID = "picker";

export const PICKER_CLASSES = {
	layer: "modkit-pick-layer",
	box: "modkit-pick-box",
	label: "modkit-pick-label",
	labelName: "modkit-pick-label-name",
	labelSel: "modkit-pick-label-sel",
	bar: "modkit-pick-bar",
	barText: "modkit-pick-bar-text",
	barHint: "modkit-pick-bar-hint",
	barKey: "modkit-pick-bar-key",
	barCancel: "modkit-pick-bar-cancel",
	bodyActive: "modkit-picking",
	unresolved: "modkit-pick-unresolved",
} as const;

/**
 * The layer sits above the workspace and above a `Notice`, because during pick mode it *is* the
 * interaction. `--layer-*` are Obsidian's own stacking variables; the literal fallbacks match their
 * shipped values so a build that renames them degrades to a sensible number rather than to `auto`.
 */
export const PICKER_CSS = `
.${PICKER_CLASSES.layer} {
	position: fixed;
	inset: 0;
	z-index: var(--layer-menu, 65);
	/* The layer never takes pointer events: the capture-phase listeners do the intercepting, and a
	   layer that swallowed the wheel would stop the user scrolling to reach what they want to pick. */
	pointer-events: none;
	user-select: none;
	-webkit-user-select: none;
	contain: layout style;
}

.${PICKER_CLASSES.layer} [hidden] { display: none !important; }

.${PICKER_CLASSES.box} {
	position: absolute;
	top: 0;
	left: 0;
	pointer-events: none;
	box-sizing: border-box;
	border-radius: var(--radius-s, 4px);
	outline: 2px solid var(--interactive-accent);
	outline-offset: 1px;
	background-color: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
	/* Positioned with transform rather than top/left so a scroll remeasure stays on the compositor. */
	transition: transform 90ms cubic-bezier(0.2, 0, 0, 1), width 90ms cubic-bezier(0.2, 0, 0, 1),
		height 90ms cubic-bezier(0.2, 0, 0, 1);
	will-change: transform, width, height;
}

.${PICKER_CLASSES.box}.${PICKER_CLASSES.unresolved} {
	outline-color: var(--text-faint);
	outline-style: dashed;
	background-color: transparent;
}

.${PICKER_CLASSES.label} {
	position: absolute;
	top: 0;
	left: 0;
	display: flex;
	align-items: baseline;
	gap: 6px;
	max-width: min(52ch, 70vw);
	padding: 3px 8px;
	border-radius: var(--radius-s, 4px);
	background-color: var(--interactive-accent);
	color: var(--text-on-accent);
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: var(--font-ui-smaller, 12px);
	line-height: 1.4;
	white-space: nowrap;
	box-shadow: var(--shadow-s);
	pointer-events: none;
	transition: transform 90ms cubic-bezier(0.2, 0, 0, 1);
	will-change: transform;
}

.${PICKER_CLASSES.label}.${PICKER_CLASSES.unresolved} {
	background-color: var(--background-secondary-alt);
	color: var(--text-muted);
	box-shadow: var(--shadow-s), inset 0 0 0 1px var(--background-modifier-border);
}

.${PICKER_CLASSES.labelName} { font-weight: var(--font-semibold, 600); }

.${PICKER_CLASSES.labelSel} {
	font-family: var(--font-monospace, ui-monospace, monospace);
	font-size: 0.9em;
	opacity: 0.72;
	overflow: hidden;
	text-overflow: ellipsis;
}

.${PICKER_CLASSES.bar} {
	position: absolute;
	top: 12px;
	left: 50%;
	transform: translateX(-50%);
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 8px 6px 12px;
	border-radius: var(--radius-m, 8px);
	background-color: var(--background-secondary);
	border: 1px solid var(--background-modifier-border);
	box-shadow: var(--shadow-l);
	color: var(--text-normal);
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: var(--font-ui-small, 13px);
	/* The one part of the layer that IS interactive — the cancel affordance must be clickable. */
	pointer-events: auto;
	animation: modkit-pick-drop 120ms cubic-bezier(0.2, 0, 0, 1);
}

.${PICKER_CLASSES.barText} { font-weight: var(--font-medium, 500); }

.${PICKER_CLASSES.barHint} { color: var(--text-muted); }

.${PICKER_CLASSES.barKey} {
	padding: 1px 5px;
	border-radius: var(--radius-s, 4px);
	background-color: var(--background-modifier-border);
	color: var(--text-muted);
	font-family: var(--font-monospace, ui-monospace, monospace);
	font-size: 0.9em;
}

.${PICKER_CLASSES.barCancel} {
	padding: 3px 10px;
	border: none;
	border-radius: var(--radius-s, 4px);
	background-color: var(--interactive-normal);
	color: var(--text-normal);
	font-family: inherit;
	font-size: inherit;
	cursor: pointer;
}

.${PICKER_CLASSES.barCancel}:hover { background-color: var(--interactive-hover); }

.${PICKER_CLASSES.barCancel}:focus-visible {
	outline: 2px solid var(--interactive-accent);
	outline-offset: 1px;
}

/* The crosshair is the mode's clearest signal, and it has to beat every cursor the app sets on its
   own elements — hence the descendant rule and the !important. Both go away with the stylesheet. */
body.${PICKER_CLASSES.bodyActive},
body.${PICKER_CLASSES.bodyActive} * {
	cursor: crosshair !important;
}

body.${PICKER_CLASSES.bodyActive} .${PICKER_CLASSES.bar},
body.${PICKER_CLASSES.bodyActive} .${PICKER_CLASSES.bar} * {
	cursor: default !important;
}

body.${PICKER_CLASSES.bodyActive} .${PICKER_CLASSES.barCancel} { cursor: pointer !important; }

/* Scrolling is a compositor-thread decision on touch (Blink/WebKit): \`preventDefault()\` on
   \`pointerdown\`/\`pointermove\` alone cannot veto it, only \`touch-action\` can. Without this, dragging
   a finger across the screen to scan for the target starts a pane-scroll after a few pixels, which
   fires \`pointercancel\` and silently ends the pick (review finding, PLAN.md 2026-09-02). Scoped to
   the picking body class so normal scrolling comes back the moment a pick session ends. */
body.${PICKER_CLASSES.bodyActive} {
	touch-action: none;
	-webkit-touch-callout: none;
}

/* A coarse pointer (touch) needs a real target, not a mouse-sized one: 44px is the iOS HIG / WCAG
   2.5.5 floor. Gated on \`pointer: coarse\` so desktop's compact bar is untouched — this is additive
   for mobile, not a redesign of the bar.

   The bar also moves to the bottom of the screen here: pinned at the top it sits at the far end of
   a one-handed reach on a phone, next to the OS status bar, while the rest of pick mode — a
   crosshair with \`touch-action: none\` — leaves this bar as the only way out. \`env(safe-area-inset-
   bottom)\` keeps it clear of a home indicator. The entrance animation switches to rising from below
   to match: dropping from above reads backwards once the bar's anchor has moved. */
@media (pointer: coarse) {
	.${PICKER_CLASSES.barCancel} {
		min-width: 44px;
		min-height: 44px;
		padding: 8px 16px;
	}

	.${PICKER_CLASSES.bar} {
		top: auto;
		bottom: calc(12px + env(safe-area-inset-bottom, 0px));
		animation-name: modkit-pick-rise;
	}
}

@keyframes modkit-pick-drop {
	from { transform: translateX(-50%) translateY(-6px); opacity: 0; }
	to { transform: translateX(-50%) translateY(0); opacity: 1; }
}

@keyframes modkit-pick-rise {
	from { transform: translateX(-50%) translateY(6px); opacity: 0; }
	to { transform: translateX(-50%) translateY(0); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
	.${PICKER_CLASSES.box},
	.${PICKER_CLASSES.label} { transition: none; }
	.${PICKER_CLASSES.bar} { animation: none; }
}
`;

/**
 * Inject {@link PICKER_CSS} into `doc`, and register its removal on `component`.
 *
 * Any sheet left over from an earlier session is removed first rather than reused. Reuse would mean
 * two components believing they own one element, and the first teardown would pull the stylesheet
 * out from under a session that is still running — a mode with no cursor and no highlight, which
 * reads as broken. One owner, always.
 */
export function injectPickerStyles(component: Component, doc: Document): HTMLStyleElement {
	for (const stale of Array.from(doc.head.querySelectorAll(`style[${MODKIT_STYLE_ATTR}="${PICKER_STYLE_ID}"]`))) {
		stale.remove();
	}

	const style = doc.head.createEl("style", { attr: { [MODKIT_STYLE_ATTR]: PICKER_STYLE_ID } });
	style.textContent = PICKER_CSS;
	component.register(() => style.remove());
	return style;
}
