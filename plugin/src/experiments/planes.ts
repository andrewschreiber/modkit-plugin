/**
 * The five reach planes, as data.
 *
 * A plane answers two questions and nothing else: *what object and property would a patch touch*
 * (`resolve`), and *would `around()` on that pair actually do something* (`preflight`). Keeping
 * them as a table rather than as branches in the generator is what lets the daemon reason about
 * reach, and lets the UI say which plane a mod is using.
 *
 *   A  exported class prototype from the `obsidian` module          (most robust)
 *   C  a foreign plugin's class, via `instance.constructor.prototype`
 *   B  a live object on the app graph (`app.workspace`, `app.vault.adapter`, …)
 *   D  the command registry — `app.commands.commands["<pluginId>:<commandId>"]`
 *   E  DOM / CSS                                                     (least robust)
 *
 * Plane D is not a convenience. Many plugin behaviours are module-local free functions installed as
 * command callbacks and have **no prototype handle at all** — Tasks' `toggle-done` is exactly this
 * — so for those the command registry is the only handle that exists.
 *
 * ## Refusal is a first-class outcome
 *
 * `around()` has three silent no-op modes, and every one of them installs cleanly, throws nothing,
 * and changes nothing:
 *
 *   1. **The property does not exist.** `around1` does not error — it treats the missing method as
 *      inherited, and `obj[method] = wrapper` *creates* the property. The patch fails only if
 *      something ever calls it.
 *   2. **The property is an accessor.** `around()` reads through the getter and writes through the
 *      setter; the semantics are simply wrong.
 *   3. **The method was bound at construction** (`this._x.bind(this)` in a constructor or class
 *      field). The bound copy is off the prototype call path, so patching the prototype afterwards
 *      does nothing. Both Tasks renderers are built this way.
 *
 * All three are caught here, before anything is installed. An honest "I cannot reach that, and here
 * is why" beats a patch that silently does nothing — that third number is the one PLAN.md says must
 * be zero.
 *
 * Detection uses `Object.getOwnPropertyDescriptor` walked up the prototype chain. It deliberately
 * does **not** use the `in` operator or a bare property read: both report a healthy-looking `true`
 * for an accessor, and a bare read *invokes* the getter.
 */

import * as obsidian from "obsidian";
import type { App, Command } from "obsidian";

export type PlaneId = "A" | "B" | "C" | "D" | "E";

/** A — a class exported from the `obsidian` module. `Workspace`, `WorkspaceLeaf`, `ItemView`, … */
export interface ExportedClassPayload {
	plane: "A";
	className: string;
	member: string;
	/** Patch the static side (`MarkdownPreviewRenderer.registerPostProcessor`) instead of the prototype. */
	onStatic?: boolean;
}

/** B — a live singleton on the app graph, addressed by dotted path from `app`. */
export interface AppGraphPayload {
	plane: "B";
	/** e.g. `"workspace"`, `"vault.adapter"`, `"metadataCache"`. Empty string means `app` itself. */
	path: string;
	member: string;
}

/** C — a foreign plugin's own class, or one live instance of it. */
export interface PluginClassPayload {
	plane: "C";
	pluginId: string;
	member: string;
	/** Patch the instance object rather than its prototype: narrower blast radius, one object only. */
	onInstance?: boolean;
}

/** D — a registered command. `commandId` is fully qualified: `"<pluginId>:<commandId>"`. */
export interface CommandPayload {
	plane: "D";
	commandId: string;
}

/** E — DOM decoration / CSS. No method to wrap; there is no reclaim contract here either. */
export interface DomPayload {
	plane: "E";
	selector: string;
}

export type PlanePayload =
	| ExportedClassPayload
	| AppGraphPayload
	| PluginClassPayload
	| CommandPayload
	| DomPayload;

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

export interface MethodResolution {
	ok: true;
	kind: "method";
	plane: PlaneId;
	/** The object `around()` is handed. */
	target: object;
	/** The property `around()` wraps. */
	key: string;
	/**
	 * The live instance behind a prototype target, when there is one. Preflight compares its own
	 * properties against the prototype's — that comparison is the only way to see the bind trap.
	 */
	instance?: object;
	describe: string;
}

export interface DomResolution {
	ok: true;
	kind: "dom";
	plane: "E";
	selector: string;
	describe: string;
}

export interface ResolutionRefusal {
	ok: false;
	refusal: Refusal;
}

export type Resolution = MethodResolution | DomResolution | ResolutionRefusal;

export interface MethodPreflight {
	ok: true;
	kind: "method";
	/** The object in the prototype chain that actually owns the property. */
	holder: object;
	/** `holder === target` — i.e. `around()`'s `hadOwn` path, which restores by assignment. */
	own: boolean;
	descriptor: PropertyDescriptor;
	ref: unknown;
	arity: number;
	/**
	 * `String(fn)` — the drift fingerprint. Record a hash of this at generation time and recompute
	 * at install: a mismatch means the target moved. We compare our own recorded string to today's,
	 * never a hand-written pattern, which is why minification does not defeat it.
	 */
	source: string;
}

export interface DomPreflight {
	ok: true;
	kind: "dom";
	selector: string;
	matches: number;
	/** Set when the selector matches nothing *right now* — which is not fatal, DOM arrives late. */
	warning?: string;
}

export type PreflightResult = MethodPreflight | DomPreflight | ResolutionRefusal;

export interface PreflightContext {
	/** The live instance to check for a construction-time shadow of `key`. */
	instance?: object;
}

function refuse(code: RefusalCode, message: string, detail?: Record<string, string>): ResolutionRefusal {
	const refusal: Refusal = { code, message };
	if (detail) refusal.detail = detail;
	return { ok: false, refusal };
}

function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Walk the prototype chain for the descriptor that actually defines `key`. */
function findDescriptor(target: object, key: string): { holder: object; descriptor: PropertyDescriptor } | null {
	let cursor: object | null = target;
	while (cursor !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
		if (descriptor !== undefined) return { holder: cursor, descriptor };
		cursor = Object.getPrototypeOf(cursor) as object | null;
	}
	return null;
}

/**
 * The workhorse: would `around(target, { [key]: … })` actually take effect, and could it be undone?
 *
 * Pass `ctx.instance` whenever `target` is a prototype and a live instance is in hand. Without it
 * the bind trap is invisible — and the bind trap is the failure mode that looks most like success.
 */
export function preflightMethod(target: object, key: string, ctx: PreflightContext = {}): PreflightResult {
	if (!isObjectLike(target)) {
		return refuse("target-not-object", "the resolved target is not an object, so it has no method to patch");
	}

	const found = findDescriptor(target, key);
	if (found === null) {
		return refuse(
			"property-missing",
			`"${key}" does not exist on the target. around() would create it and only fail when something called it.`,
			{ key },
		);
	}

	const { holder, descriptor } = found;

	if (descriptor.get !== undefined || descriptor.set !== undefined) {
		return refuse(
			"accessor",
			`"${key}" is a getter/setter, and around() cannot patch an accessor — it reads through the getter and writes through the setter.`,
			{ key, has: [descriptor.get ? "get" : "", descriptor.set ? "set" : ""].filter(Boolean).join("+") },
		);
	}

	if (typeof descriptor.value !== "function") {
		return refuse("not-a-function", `"${key}" is a ${typeof descriptor.value}, not a function.`, { key });
	}

	// Non-writable blocks the assignment at the heart of around1 — and esbuild's CJS output is not
	// automatically strict, so the assignment fails *silently*: a perfect no-op patch.
	if (descriptor.writable === false) {
		return refuse("not-writable", `"${key}" is not writable, so installing the patch would be silently ignored.`, { key });
	}

	// Writable-but-non-configurable is installable yet not cleanly restorable, and an uninstall that
	// cannot restore is worse than a mod that was never installed.
	if (descriptor.configurable === false) {
		return refuse("not-configurable", `"${key}" is not configurable, so the patch could not be cleanly removed again.`, { key });
	}

	const instance = ctx.instance;
	if (instance !== undefined && instance !== target) {
		const shadow = Object.getOwnPropertyDescriptor(instance, key);
		if (shadow !== undefined) {
			if (shadow.get !== undefined || shadow.set !== undefined) {
				return refuse(
					"bound-at-construction",
					`the live instance defines its own accessor for "${key}", which shadows the prototype — a prototype patch would never be seen.`,
					{ key },
				);
			}
			if (shadow.value !== descriptor.value) {
				return refuse(
					"bound-at-construction",
					`a same-named own property on the live instance differs from the prototype value — this is the .bind(this)-at-construction signature. The bound copy is off the prototype call path, so patching the prototype would compile, install, throw nothing, and do nothing.`,
					{ key },
				);
			}
			return refuse(
				"instance-shadows-prototype",
				`the live instance has its own "${key}" holding the same function as the prototype; calls resolve to the instance property, so a prototype patch would not be seen through it.`,
				{ key },
			);
		}
	}

	const ref: unknown = descriptor.value;
	return {
		ok: true,
		kind: "method",
		holder,
		own: holder === target,
		descriptor,
		ref,
		arity: typeof ref === "function" ? ref.length : 0,
		source: String(ref),
	};
}

/** Plane E's preflight. A selector matching nothing is a warning, not a refusal — DOM arrives late. */
export function preflightSelector(selector: string): PreflightResult {
	// `activeDocument`, not `document`: it is the documented global, and the popout-window-correct one.
	if (typeof activeDocument === "undefined") {
		return refuse("plane-unavailable", "there is no document to query — the DOM plane is unavailable here.");
	}
	let matches: number;
	try {
		matches = activeDocument.querySelectorAll(selector).length;
	} catch (err) {
		return refuse("invalid-selector", `"${selector}" is not a valid CSS selector.`, { error: String(err) });
	}
	const result: DomPreflight = { ok: true, kind: "dom", selector, matches };
	if (matches === 0) {
		result.warning = `"${selector}" matches nothing right now — the mod will only take effect if that element appears later.`;
	}
	return result;
}

export interface ReachPlane {
	id: PlaneId;
	label: string;
	/**
	 * Generator preference, lower is better, following brief-patching §2's R1 > R2 > R3 > R5.
	 * A and C bind to a *named method*, which is the same thing the source bridge reasoned about;
	 * D binds to a stable command id but an undocumented callback shape; E binds to class names
	 * that change without a release note.
	 */
	rank: number;
	resolve(app: App, payload: PlanePayload): Resolution;
	preflight(resolution: Resolution): PreflightResult;
}

/** Every plane's `preflight` is the same dispatch; only `resolve` differs. */
function preflightResolution(resolution: Resolution): PreflightResult {
	if (!resolution.ok) return resolution;
	if (resolution.kind === "dom") return preflightSelector(resolution.selector);
	const ctx: PreflightContext = {};
	if (resolution.instance !== undefined) ctx.instance = resolution.instance;
	return preflightMethod(resolution.target, resolution.key, ctx);
}

function wrongPlane(expected: PlaneId, got: string): ResolutionRefusal {
	return refuse("unknown-plane", `this payload is for plane ${got}, not plane ${expected}.`, { expected, got });
}

/** A — an exported class from the running app's `obsidian` module. */
const planeA: ReachPlane = {
	id: "A",
	label: "exported obsidian class",
	rank: 1,
	resolve(_app: App, payload: PlanePayload): Resolution {
		if (payload.plane !== "A") return wrongPlane("A", payload.plane);
		// `obsidian` is external in the build, so this namespace IS the running app's module and
		// these prototypes are the live ones — minification-proof, and past instances are covered.
		const ns = obsidian as unknown as Record<string, unknown>;
		const cls = ns[payload.className];
		if (typeof cls !== "function") {
			return refuse("target-missing", `the obsidian module exports no class named "${payload.className}".`, {
				className: payload.className,
			});
		}
		const target: unknown = payload.onStatic === true ? cls : (cls as { prototype?: unknown }).prototype;
		if (!isObjectLike(target)) {
			return refuse("target-not-object", `"${payload.className}" has no ${payload.onStatic === true ? "static side" : "prototype"} to patch.`);
		}
		return {
			ok: true,
			kind: "method",
			plane: "A",
			target,
			key: payload.member,
			describe: `${payload.className}${payload.onStatic === true ? "" : ".prototype"}.${payload.member}`,
		};
	},
	preflight: preflightResolution,
};

/** C — a foreign plugin's class (or one live instance of it). */
const planeC: ReachPlane = {
	id: "C",
	label: "foreign plugin class",
	rank: 2,
	resolve(app: App, payload: PlanePayload): Resolution {
		if (payload.plane !== "C") return wrongPlane("C", payload.plane);
		const pm = app.plugins;
		if (pm === undefined) {
			return refuse("plane-unavailable", "this Obsidian build does not expose app.plugins, so no plugin instance can be reached.");
		}
		const instance = pm.plugins?.[payload.pluginId];
		if (instance === undefined) {
			// `plugins` holds only *enabled* plugins, so tell the two cases apart before refusing.
			const installed = pm.manifests?.[payload.pluginId] !== undefined;
			return installed
				? refuse("target-disabled", `"${payload.pluginId}" is installed but not enabled, so it has no live class to patch.`, {
						pluginId: payload.pluginId,
					})
				: refuse("target-missing", `"${payload.pluginId}" is not installed.`, { pluginId: payload.pluginId });
		}

		if (payload.onInstance === true) {
			return {
				ok: true,
				kind: "method",
				plane: "C",
				target: instance,
				key: payload.member,
				describe: `app.plugins.plugins["${payload.pluginId}"].${payload.member}`,
			};
		}

		const proto: unknown = (instance.constructor as { prototype?: unknown } | undefined)?.prototype;
		if (!isObjectLike(proto)) {
			return refuse("target-not-object", `"${payload.pluginId}"'s class has no prototype to patch.`, { pluginId: payload.pluginId });
		}
		return {
			ok: true,
			kind: "method",
			plane: "C",
			target: proto,
			key: payload.member,
			// Carried so preflight can see a construction-time shadow of this member.
			instance,
			describe: `app.plugins.plugins["${payload.pluginId}"].constructor.prototype.${payload.member}`,
		};
	},
	preflight: preflightResolution,
};

/** B — a live singleton on the app graph. */
const planeB: ReachPlane = {
	id: "B",
	label: "app graph object",
	rank: 3,
	resolve(app: App, payload: PlanePayload): Resolution {
		if (payload.plane !== "B") return wrongPlane("B", payload.plane);
		const segments = payload.path.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
		let cursor: unknown = app;
		const walked: string[] = ["app"];
		for (const segment of segments) {
			if (!isObjectLike(cursor)) {
				return refuse("target-missing", `${walked.join(".")} is not an object, so "${payload.path}" cannot be walked.`, {
					path: payload.path,
					failedAt: walked.join("."),
				});
			}
			cursor = (cursor as Record<string, unknown>)[segment];
			walked.push(segment);
			if (cursor === undefined || cursor === null) {
				return refuse("target-missing", `${walked.join(".")} is ${cursor === null ? "null" : "undefined"}.`, {
					path: payload.path,
					failedAt: walked.join("."),
				});
			}
		}
		if (!isObjectLike(cursor)) {
			return refuse("target-not-object", `${walked.join(".")} is a ${typeof cursor}, not an object.`, { path: payload.path });
		}
		return {
			ok: true,
			kind: "method",
			plane: "B",
			target: cursor,
			key: payload.member,
			describe: `${walked.join(".")}.${payload.member}`,
		};
	},
	preflight: preflightResolution,
};

/**
 * The four callback shapes a `Command` may carry. Exactly one is normally live.
 *
 * Order here is *reporting* order, not dispatch order: which one the host prefers when several are
 * present is undocumented, which is why the resolver refuses that case instead of guessing.
 */
export const COMMAND_CALLBACK_KEYS = ["checkCallback", "callback", "editorCheckCallback", "editorCallback"] as const;
export type CommandCallbackKey = (typeof COMMAND_CALLBACK_KEYS)[number];

/** D — the command registry. The only handle for a behaviour that lives in a module-local closure. */
const planeD: ReachPlane = {
	id: "D",
	label: "command registry",
	rank: 4,
	resolve(app: App, payload: PlanePayload): Resolution {
		if (payload.plane !== "D") return wrongPlane("D", payload.plane);
		const registry = app.commands;
		if (registry === undefined || registry.commands === undefined) {
			return refuse("plane-unavailable", "this Obsidian build does not expose app.commands, so registered commands cannot be reached.");
		}
		const command: Command | undefined = registry.commands[payload.commandId];
		if (command === undefined) {
			return refuse("target-missing", `no command is registered as "${payload.commandId}".`, { commandId: payload.commandId });
		}

		const present = COMMAND_CALLBACK_KEYS.filter(
			(key) => typeof (command as unknown as Record<string, unknown>)[key] === "function",
		);
		if (present.length === 0) {
			return refuse(
				"no-live-callback",
				`"${payload.commandId}" carries none of callback / checkCallback / editorCallback / editorCheckCallback, so there is nothing to wrap.`,
				{ commandId: payload.commandId },
			);
		}
		if (present.length > 1) {
			return refuse(
				"ambiguous-callback",
				`"${payload.commandId}" carries ${present.join(" and ")}; which one Obsidian dispatches is undocumented, so patching one could silently miss the live path.`,
				{ commandId: payload.commandId, present: present.join(",") },
			);
		}

		const key = present[0]!;
		return {
			ok: true,
			kind: "method",
			plane: "D",
			target: command,
			key,
			describe: `app.commands.commands["${payload.commandId}"].${key}`,
		};
	},
	preflight: preflightResolution,
};

/** E — DOM / CSS. No runtime handle needed, and no reclaim contract either: stamp every element. */
const planeE: ReachPlane = {
	id: "E",
	label: "DOM / CSS",
	rank: 5,
	resolve(_app: App, payload: PlanePayload): Resolution {
		if (payload.plane !== "E") return wrongPlane("E", payload.plane);
		const selector = payload.selector.trim();
		if (selector.length === 0) {
			return refuse("invalid-selector", "an empty selector matches nothing.");
		}
		return { ok: true, kind: "dom", plane: "E", selector, describe: `document.querySelectorAll("${selector}")` };
	},
	preflight: preflightResolution,
};

export const PLANES: Record<PlaneId, ReachPlane> = {
	A: planeA,
	B: planeB,
	C: planeC,
	D: planeD,
	E: planeE,
};

/** Planes in generator-preference order, most robust first. */
export const PLANES_BY_RANK: ReachPlane[] = Object.values(PLANES).sort((a, b) => a.rank - b.rank);

export function getPlane(id: string): ReachPlane | null {
	return (PLANES as Record<string, ReachPlane | undefined>)[id] ?? null;
}

/**
 * Resolve and preflight in one step — the shape a caller almost always wants, since a resolution
 * that has not been preflighted is not yet an answer.
 */
export function reach(app: App, payload: PlanePayload): { resolution: Resolution; preflight: PreflightResult } {
	const plane = getPlane(payload.plane);
	if (plane === null) {
		const refusal = refuse("unknown-plane", `"${String(payload.plane)}" is not a reach plane.`);
		return { resolution: refusal, preflight: refusal };
	}
	const resolution = plane.resolve(app, payload);
	return { resolution, preflight: plane.preflight(resolution) };
}
