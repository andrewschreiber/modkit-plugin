/**
 * `Refusal` / `RefusalCode`, duplicated from `experiments/planes.ts`.
 *
 * The UI layer needs the *shape* a preflight refusal comes in, not the reach-plane machinery that
 * produces one — `planes.ts` lives under `experiments/` because its `reach()`/`preflightMethod` are
 * only exercised by experiment E2; the live install path's preflight runs in the generated mod
 * template on the daemon side. Importing the whole module into `ComposeModal.ts` just to get two
 * small types would make the UI depend on experiment-only code. So this file re-declares them —
 * intentional duplication, not a shared source of truth: if the plane table ever grows a new refusal
 * code, `REFUSAL_PROSE` in `ComposeModal.ts` needs a matching entry either way, so nothing here would
 * hide behind an unchanged type.
 */

export type RefusalCode =
	/** The payload's plane tag does not match the plane it was handed to. */
	| "unknown-plane"
	/** The internal this plane needs is absent from this Obsidian build. */
	| "plane-unavailable"
	/** The named class / path / plugin / command does not exist. */
	| "target-missing"
	/** Installed but not enabled, so there is no live class to patch. */
	| "target-disabled"
	/** Resolved to something that is not an object, so it has no properties to wrap. */
	| "target-not-object"
	/** `around()` would CREATE this property and fail only when it is called. */
	| "property-missing"
	/** A getter/setter. `around()` cannot patch an accessor. */
	| "accessor"
	/** `obj[key] = wrapper` would be swallowed (silently, in sloppy mode). */
	| "not-writable"
	/** Patchable but not cleanly restorable — teardown could not put the original back. */
	| "not-configurable"
	| "not-a-function"
	/** The `.bind(this)`-at-construction signature: prototype patches never reach the call path. */
	| "bound-at-construction"
	/** An own property on the instance shadows the prototype with the same value — same consequence. */
	| "instance-shadows-prototype"
	/** A command object with no callback of any of the four kinds. */
	| "no-live-callback"
	/** More than one callback kind present; which one the host dispatches is undocumented. */
	| "ambiguous-callback"
	/** A DOM plane has no method to preflight. */
	| "dom-not-a-method"
	| "invalid-selector";

export interface Refusal {
	code: RefusalCode;
	/** One sentence, written for the person who asked for the mod. */
	message: string;
	detail?: Record<string, string>;
}
