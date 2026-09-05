/**
 * The plugin picker — the "Mod plugin…" entry point, which skips the element picker entirely.
 *
 * There are two ways into a mod. Pointing at something on screen is the better one when the user
 * can see the thing they want changed; this is the other one, for when they can't (a command with
 * no visible surface, a behaviour that only happens on save, a plugin whose panel is closed).
 *
 * A `FuzzySuggestModal` rather than a hand-rolled list: it is Obsidian's own picker, so the
 * keyboard behaviour, the scroll-into-view, the highlighting and the escape handling are the ones
 * the user already has in their fingers from the command palette.
 *
 * Each row answers the three questions that decide whether this is the right target — what it is
 * called, what its id is (which is what the user sees in a refusal message and in the mod list),
 * and whether modkit already has mods pointed at it. That last one is why this is not just
 * `app.plugins.manifests` in a list: a plugin that already carries three mods is both the most
 * likely next target and the one where a fourth mod is most likely to collide.
 */

import { FuzzySuggestModal } from "obsidian";
import type { App, FuzzyMatch } from "obsidian";
import { MODKIT_MOD_ID_PREFIX } from "@modkit/types";
import type { InstalledPluginInfo } from "../host/host";

/**
 * One row. Deliberately not `InstalledPluginInfo` itself: the picker needs `modCount`, which is
 * modkit's own bookkeeping and not something the host layer knows about.
 */
export interface PluginTarget {
	id: string;
	name: string;
	version: string;
	author: string;
	description: string;
	/** In Obsidian's enabled-plugins set. */
	enabled: boolean;
	/** Has a live instance — i.e. actually running, and therefore actually patchable right now. */
	loaded: boolean;
	/** How many modkit mods currently point at this plugin. */
	modCount: number;
}

export interface TargetSuggestOptions {
	plugins: PluginTarget[];
	onChoose(plugin: PluginTarget): void;
	/** Called when the modal closed without a choice. The caller usually does nothing. */
	onCancel?(): void;
	placeholder?: string;
	/** Shown when the query matches nothing. */
	emptyText?: string;
}

/**
 * Build picker rows from the host's plugin inventory.
 *
 * modkit itself and every generated mod are excluded by default. Modding a mod is coherent in
 * principle and unsupported in v1 — offering it in the picker would promise something the
 * generator cannot yet do.
 */
export function toPluginTargets(
	installed: InstalledPluginInfo[],
	modCount: (pluginId: string) => number,
	options: { exclude?: (id: string) => boolean } = {},
): PluginTarget[] {
	const exclude =
		options.exclude ?? ((id: string): boolean => id === "modkit" || id.startsWith(MODKIT_MOD_ID_PREFIX));

	return installed
		.filter((info) => !exclude(info.id))
		.map((info) => ({
			id: info.id,
			name: info.name,
			version: info.version,
			author: info.author,
			description: info.description,
			enabled: info.enabled,
			loaded: info.loaded,
			modCount: modCount(info.id),
		}));
}

/** Modded first, then running, then alphabetical — the order for an empty query. */
function byLikelihood(a: PluginTarget, b: PluginTarget): number {
	if (a.modCount !== b.modCount) return b.modCount - a.modCount;
	if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
	return a.name.localeCompare(b.name);
}

export class TargetSuggestModal extends FuzzySuggestModal<PluginTarget> {
	private readonly options: TargetSuggestOptions;
	/** Distinguishes "dismissed" from "chose something" in `onClose`, which fires for both. */
	private chose = false;

	constructor(app: App, options: TargetSuggestOptions) {
		super(app);
		this.options = options;

		this.setPlaceholder(options.placeholder ?? "Which plugin do you want to mod?");
		this.emptyStateText =
			options.emptyText ?? "No installed plugin matches that. modkit can also mod Obsidian's own interface.";
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "mod this plugin" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	override getItems(): PluginTarget[] {
		return [...this.options.plugins].sort(byLikelihood);
	}

	/**
	 * The id is part of the searchable text on purpose: it is the string that appears in refusals,
	 * in the mod list and in the target's own folder name, so it is often what the user has in mind.
	 */
	override getItemText(plugin: PluginTarget): string {
		return `${plugin.name} ${plugin.id}`;
	}

	override renderSuggestion(match: FuzzyMatch<PluginTarget>, el: HTMLElement): void {
		const plugin = match.item;
		const row = el.createDiv({ cls: "modkit-suggest" });

		const top = row.createDiv({ cls: "modkit-suggest__top" });
		top.createSpan({ cls: "modkit-suggest__name", text: plugin.name });
		top.createSpan({ cls: "modkit-suggest__id", text: plugin.id });

		if (plugin.modCount > 0) {
			top.createSpan({
				cls: "modkit-badge modkit-badge--mods",
				text: plugin.modCount === 1 ? "1 mod" : `${plugin.modCount} mods`,
			});
		}
		// Installed-but-off has no live class to patch, so preflight will refuse it. Say so here,
		// where the choice is being made, rather than after the user has typed a request.
		if (!plugin.enabled) {
			top.createSpan({ cls: "modkit-badge modkit-badge--off", text: "not enabled" });
		} else if (!plugin.loaded) {
			top.createSpan({ cls: "modkit-badge modkit-badge--off", text: "not loaded yet" });
		}

		const meta = [plugin.version ? `v${plugin.version}` : "", plugin.author, plugin.description]
			.filter((part) => part.length > 0)
			.join(" · ");
		if (meta.length > 0) row.createDiv({ cls: "modkit-suggest__meta", text: meta });
	}

	override onChooseItem(plugin: PluginTarget, _evt: MouseEvent | KeyboardEvent): void {
		this.chose = true;
		this.options.onChoose(plugin);
	}

	override onClose(): void {
		super.onClose();
		if (!this.chose) this.options.onCancel?.();
	}
}
