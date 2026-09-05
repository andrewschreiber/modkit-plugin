/**
 * E2 — patch a third-party plugin's prototype, then take it off again and prove the target is
 * unharmed.
 *
 * PLAN.md's kill condition: *if teardown can't restore a foreign prototype, mods are not safely
 * removable and the product needs a very different safety story.*
 *
 * **Target:** Tasks (`obsidian-tasks-plugin`), method `getTasks`, on
 * `app.plugins.plugins[id].constructor.prototype` — chosen by the design notes §5 for four
 * reasons that all matter to the assertions here: it is an **own plain-function property** of the
 * prototype, so monkey-around's `hadOwn` branch does a *true* restore rather than a neuter and
 * reference identity is actually assertable; it is a **pure read**, so the patch cannot damage
 * Tasks; it is **trivially invocable** from here; and this vault has real task data behind it.
 *
 * The assertion set is the design notes §4.4 — A1–A7, B1–B5, C1–C2, D — written for exactly this.
 *
 * ## Three things this experiment is careful about
 *
 * **Which removal path was taken is recorded, not assumed.** monkey-around removes two different
 * ways: a *true restore* when we are the outermost patcher of an own property, and a *neuter* when
 * someone patched on top of us — and under a neuter `proto.getTasks !== baseline` is the **correct**
 * outcome, not a failure. Asserting reference identity without recording which path ran would make
 * the strong claim untested in exactly the case where it is interesting.
 *
 * **Leak accounting is attributed, not merely differenced.** Instrumenting `addEventListener` and
 * `setInterval` counts *the whole app*, and Obsidian is busy: a window-wide delta cannot be blamed
 * on us. So the pass/fail assertions difference the counters across the **synchronous** install and
 * teardown calls, where nothing else can interleave and every delta is therefore ours; the
 * window-wide numbers are reported as measurements with that caveat attached.
 *
 * **The mid-experiment target reload (A6) is a measurement with a finding, not a pass/fail.** A
 * reload re-evaluates the target's `main.js` and produces a fresh class object; a patch on the old
 * prototype is then silently inert. Whether that happens is the single most important unknown in
 * the design notes §3.4, and *either* answer is a legitimate property of the host. What E2
 * asserts is the thing modkit actually depends on: that the situation is **detectable** by comparing
 * class-object identity — which is what `Supervisor` is built on — and that the live target is left
 * unpatched afterwards either way.
 *
 * ## What this experiment is allowed to do to a stranger's plugin
 *
 * E2 takes down a plugin the user relies on and brings it back. That is not incidental — the reload
 * *is* assertion A6, and dropping it would remove the only measurement the supervisor's design rests
 * on. What was wrong until 2026-08-31 was not the reload; it was that it happened on one keystroke
 * from the command palette with no statement of intent. Three rules now hold:
 *
 * 1. **It asks first.** {@link e2Consent} names the target by name and id, and `index.ts` will not
 *    call this function until the user has said yes to it. Cancel is the default.
 * 2. **It never enables something the user did not have on.** The target must already be installed
 *    *and* enabled, or E2 skips with a reason and touches nothing. The re-enable at the end restores
 *    a state E2 itself broke; it never creates one.
 * 3. **Every mutation is undone from three places, because one is not enough.** The `finally` covers
 *    a throw. A child {@link Component} covers modkit being unloaded while the run is suspended —
 *    the case where the `finally` simply never resumes. And the persisted enable-state in
 *    `community-plugins.json` is checked and repaired, because a disable that turned out to persist
 *    would leave Tasks working today and silently gone after the next restart.
 */

import { Component, Notice } from "obsidian";
import type { App, Plugin } from "obsidian";
import { around } from "monkey-around";
import type { PluginManagerInternal } from "../host/internals";
import { reach } from "./planes";
import { ExperimentRun, describe, localDateStamp, publish, readEnabledPlugins, restoreEnabledPlugin } from "./harness";
import type { ExperimentConsent, ExperimentReport } from "./harness";

const TARGET_ID = "obsidian-tasks-plugin";
/** Fallback only: the real name comes from the installed manifest wherever one is available. */
const TARGET_FALLBACK_NAME = "Tasks";
const TARGET_METHOD = "getTasks";
/** Three cycles, per the design notes §4.4 C2 — catches an uninstaller that is correct once. */
const REPEAT_CYCLES = 3;

/** The shapes `around()` is handed. Narrow object types, never `any` casts scattered about. */
type MethodHost = Record<string, (...args: unknown[]) => unknown>;
type TasksLike = { getTasks?: () => unknown };

interface MeterCounts {
	addEventListener: number;
	removeEventListener: number;
	setInterval: number;
	clearInterval: number;
	targetRegister: number;
}

interface Meters {
	ok: boolean;
	snapshot(): MeterCounts;
	uninstall(): void;
}

const ZERO: MeterCounts = {
	addEventListener: 0,
	removeEventListener: 0,
	setInterval: 0,
	clearInterval: 0,
	targetRegister: 0,
};

function diff(before: MeterCounts, after: MeterCounts): MeterCounts {
	return {
		addEventListener: after.addEventListener - before.addEventListener,
		removeEventListener: after.removeEventListener - before.removeEventListener,
		setInterval: after.setInterval - before.setInterval,
		clearInterval: after.clearInterval - before.clearInterval,
		targetRegister: after.targetRegister - before.targetRegister,
	};
}

function sumCounts(a: MeterCounts, b: MeterCounts): MeterCounts {
	return {
		addEventListener: a.addEventListener + b.addEventListener,
		removeEventListener: a.removeEventListener + b.removeEventListener,
		setInterval: a.setInterval + b.setInterval,
		clearInterval: a.clearInterval + b.clearInterval,
		targetRegister: a.targetRegister + b.targetRegister,
	};
}

/**
 * Count listener, timer and `Component.register` acquisitions.
 *
 * Obsidian gives no way to *enumerate* listeners — `getEventListeners()` is a Chrome DevTools
 * console helper, not page JS — so counting has to be instrumented rather than queried. These
 * patches go on for the length of the experiment and come off in the `finally`.
 */
function installMeters(targetInstance: object): Meters {
	const counts: MeterCounts = { ...ZERO };
	const uninstallers: (() => void)[] = [];
	let ok = true;

	const add = (install: () => () => void): void => {
		try {
			uninstallers.push(install());
		} catch (err) {
			ok = false;
			console.error("modkit E2: could not instrument a counter", err);
		}
	};

	add(() =>
		around(EventTarget.prototype as unknown as MethodHost, {
			addEventListener(next) {
				return function (this: unknown, ...args: unknown[]): unknown {
					counts.addEventListener++;
					return next.apply(this, args);
				};
			},
			removeEventListener(next) {
				return function (this: unknown, ...args: unknown[]): unknown {
					counts.removeEventListener++;
					return next.apply(this, args);
				};
			},
		}),
	);

	add(() =>
		around(window as unknown as MethodHost, {
			setInterval(next) {
				return function (this: unknown, ...args: unknown[]): unknown {
					counts.setInterval++;
					return next.apply(this, args);
				};
			},
			clearInterval(next) {
				return function (this: unknown, ...args: unknown[]): unknown {
					counts.clearInterval++;
					return next.apply(this, args);
				};
			},
		}),
	);

	add(() =>
		around(Component.prototype as unknown as MethodHost, {
			register(next) {
				return function (this: unknown, ...args: unknown[]): unknown {
					// Only the target's own component matters: B3 asks whether *the target* grew
					// registrations because of us, not what the rest of the app did meanwhile.
					if (this === targetInstance) counts.targetRegister++;
					return next.apply(this, args);
				};
			},
		}),
	);

	return {
		ok,
		snapshot: () => ({ ...counts }),
		uninstall: () => {
			for (const u of uninstallers.reverse()) {
				try {
					u();
				} catch (err) {
					console.error("modkit E2: a counter would not uninstall", err);
				}
			}
			uninstallers.length = 0;
		},
	};
}

/** The pre-install snapshot from the design notes §4.3 — everything A1–A5 compare against. */
interface Baseline {
	own: boolean;
	ref: unknown;
	descriptor: PropertyDescriptor | undefined;
	source: string;
	arity: number;
	ownNames: string[];
	protoOfHolder: object | null;
}

function snapshot(proto: object, key: string): Baseline {
	const descriptor = Object.getOwnPropertyDescriptor(proto, key);
	const ref: unknown = (proto as Record<string, unknown>)[key];
	return {
		own: Object.prototype.hasOwnProperty.call(proto, key),
		ref,
		descriptor,
		source: typeof ref === "function" ? String(ref) : describe(ref),
		arity: typeof ref === "function" ? ref.length : -1,
		ownNames: Object.getOwnPropertyNames(proto).sort(),
		protoOfHolder: Object.getPrototypeOf(proto) as object | null,
	};
}

function descriptorMatches(a: PropertyDescriptor | undefined, b: PropertyDescriptor | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.value === b.value && a.writable === b.writable && a.enumerable === b.enumerable && a.configurable === b.configurable;
}

function describeDescriptor(d: PropertyDescriptor | undefined): string {
	if (d === undefined) return "undefined";
	return `{ value: ${typeof d.value}, writable: ${String(d.writable)}, enumerable: ${String(d.enumerable)}, configurable: ${String(d.configurable)} }`;
}

interface Counter {
	calls: number;
}

/**
 * The demo patch itself — the design notes §5, reduced to a strict observer.
 *
 * The brief's version raises a `Notice` on every call, which is right for a hand-run demo and wrong
 * inside an experiment that calls the method a dozen times. A call counter is the same observation
 * without the confetti, and it is what A7 and D need to assert against.
 */
function installProbePatch(proto: object, counter: Counter): () => void {
	return around(proto as unknown as MethodHost, {
		[TARGET_METHOD](next) {
			return function (this: unknown, ...args: unknown[]): unknown {
				counter.calls++;
				return next.apply(this, args);
			};
		},
	});
}

/** Call the target's own method. Returns the array length, or -1 if it did not return an array. */
function callTarget(instance: TasksLike): { ok: boolean; length: number; error?: unknown } {
	try {
		const result = typeof instance.getTasks === "function" ? instance.getTasks() : undefined;
		return { ok: true, length: Array.isArray(result) ? result.length : -1 };
	} catch (err) {
		return { ok: false, length: -1, error: err };
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * What the user is told before E2 runs. See {@link ExperimentConsent}.
 *
 * The target's *name* is read from the live manifest rather than hard-coded, so a user who has the
 * plugin under a different display name — or does not have it at all — is told the truth. The
 * "not installed" wording matters: consenting to an experiment that will immediately skip is a
 * different decision, and the modal should not pretend otherwise.
 */
export function e2Consent(plugin: Plugin): ExperimentConsent {
	const pm: PluginManagerInternal | null = plugin.app.plugins ?? null;
	const manifest = pm?.manifests?.[TARGET_ID];
	const name = manifest?.name ?? TARGET_FALLBACK_NAME;
	const live = pm?.plugins?.[TARGET_ID] !== undefined;

	return {
		title: "Run experiment E2?",
		summary:
			`E2 answers whether a mod can be taken off a third-party plugin without a trace — it patches one read-only method on ${name}, proves the patch runs, removes it, and checks the plugin's prototype is byte-for-byte what it was. It is the experiment modkit's whole "mods are removable" claim rests on.`,
		toggles: live
			? [
					{
						name,
						id: TARGET_ID,
						note: "disabled and immediately re-enabled ONCE, to measure whether a patch survives its target reloading",
					},
				]
			: [],
		writesThenRemoves: [],
		leavesBehind: [`modkit/experiments/${localDateStamp(new Date())}-e2.md — the report`],
		duration: "about 5 to 15 seconds",
		disturbance: live
			? `${name} goes away and comes back mid-run: any of its views will re-render, and anything it was in the middle of is interrupted. Nothing it owns is edited — the method E2 patches only reads. If E2 fails partway, it puts ${name} back on before it stops.`
			: `${name} is not currently enabled, so E2 will stop immediately and change nothing. It will not enable it for you.`,
		proceedLabel: "Run E2",
	};
}

export async function runE2(plugin: Plugin): Promise<ExperimentReport> {
	const app: App = plugin.app;
	const run = new ExperimentRun("e2", "patch a third-party plugin, then cleanly remove it", app);
	const pm: PluginManagerInternal | null = app.plugins ?? null;

	// Every uninstaller taken during the run, so the `finally` can undo the world even mid-failure.
	const pending: (() => void)[] = [];
	// A child Component, so that if modkit itself unloads mid-experiment the reclaim contract takes
	// the patches off. `this.register` on the plugin would work too, but could not be undone at the
	// end of the run — and E2 must be repeatable.
	//
	// This is not the same net as the `finally`, and both are needed. The `finally` runs when the run
	// *ends*, including on a throw; it does not run when the run never resumes, which is what happens
	// if the user quits Obsidian or disables modkit while E2 is suspended on an `await`. Component
	// reclaim is synchronous and fires exactly then. Everything E2 mutates therefore goes through
	// `scope` as well: the probe patches, the global meters, and the target's enabled state.
	const scope = new Component();
	plugin.addChild(scope);

	let meters: Meters | null = null;
	let weDisabledTarget = false;
	/** Whether `community-plugins.json` listed the target before E2 touched it. Restore-only guard. */
	let targetWasListed = false;
	let thrown: unknown;

	const takeUninstaller = (uninstall: () => void): (() => void) => {
		pending.push(uninstall);
		scope.register(uninstall); // monkey-around's remover is idempotent, so a double-call is safe
		return uninstall;
	};

	/**
	 * Put the target back on. Best-effort and never throws: it is called from the `finally`, from the
	 * reclaim contract, and from the reload step itself, and any of the three may be the only one
	 * that gets to run.
	 */
	const reEnableTarget = (): void => {
		if (!weDisabledTarget) return;
		try {
			// Both halves are needed: `try` catches a synchronous throw, `.catch` catches the
			// rejection. Without the second, this becomes an unhandled rejection in the middle of
			// Obsidian's own unload — a red console entry blaming modkit for the host shutting down.
			pm?.enablePlugin?.(TARGET_ID)?.catch((err: unknown) => {
				console.error("modkit E2: could not re-enable the target", err);
			});
		} catch (err) {
			console.error("modkit E2: could not re-enable the target", err);
		}
	};
	scope.register(() => {
		if (weDisabledTarget) console.warn(`modkit E2: modkit unloaded mid-run — re-enabling ${TARGET_ID} from the reclaim contract`);
		reEnableTarget();
	});

	try {
		// ------------------------------------------------------------- preconditions
		const manifest = pm?.manifests?.[TARGET_ID];
		const instance = pm?.plugins?.[TARGET_ID];
		if (pm === null || instance === undefined) {
			const why =
				pm === null
					? "app.plugins is not available on this Obsidian build"
					: manifest === undefined
						? `the Tasks plugin ("${TARGET_ID}") is not installed in this vault`
						: `the Tasks plugin ("${TARGET_ID}") is installed but not enabled, so it has no live class to patch`;
			run.skip("E2.*", "all of E2", `${why} — E2 needs a real third-party target and will not substitute one`);
			run.finding(`E2 did not run: ${why}. Install and enable Tasks, or point E2 at another target with an own plain-function prototype method.`);
			return await publish(app, run.finish());
		}

		run.measure("target", `${TARGET_ID} ${manifest?.version ?? "(version unknown)"}`, `patching ${TARGET_METHOD} on its class prototype`);

		const proto = (instance.constructor as { prototype?: unknown } | undefined)?.prototype;
		if (typeof proto !== "object" || proto === null) {
			run.skip("E2.*", "all of E2", "the target's constructor has no prototype object to patch");
			return await publish(app, run.finish());
		}

		// ------------------------------ E2.1 — modkit's own reach machinery agrees this is patchable
		//
		// Running the real resolver here rather than hand-rolling the checks means E2 also tests the
		// code M1 will ship. Its refusal is authoritative: if `planes.ts` says the target is an
		// accessor, or bound at construction, or missing, then installing anyway would be measuring a
		// silent no-op and calling it a pass.
		const reached = reach(app, { plane: "C", pluginId: TARGET_ID, member: TARGET_METHOD });
		const reachable = await run.check("E2.1", "modkit's plane-C resolver reaches the target and preflight accepts it", () => {
			if (!reached.resolution.ok) {
				return { ok: false, expected: "a resolved method target", actual: `refused: ${reached.resolution.refusal.code} — ${reached.resolution.refusal.message}` };
			}
			if (!reached.preflight.ok) {
				return { ok: false, expected: "preflight to accept", actual: `refused: ${reached.preflight.refusal.code} — ${reached.preflight.refusal.message}` };
			}
			if (reached.preflight.kind !== "method") {
				return { ok: false, expected: "a method preflight", actual: reached.preflight.kind };
			}
			return {
				ok: reached.preflight.own,
				expected: "an own, plain-function, writable, configurable property of the prototype",
				actual: `own=${reached.preflight.own}, arity=${reached.preflight.arity}`,
				detail: reached.resolution.kind === "method" ? reached.resolution.describe : "",
			};
		});

		if (!reachable) {
			const refusal = !reached.resolution.ok ? reached.resolution.refusal : !reached.preflight.ok ? reached.preflight.refusal : null;
			run.skip("E2.*", "the rest of E2", refusal === null ? "the target is not an own prototype method" : `${refusal.code}: ${refusal.message}`);
			run.finding(
				"E2 stopped at preflight. That is a correct outcome, not a bug — but it means the restore claim is untested, so re-run against a target whose method is an own plain function on the prototype.",
			);
			return await publish(app, run.finish());
		}

		// ------------------------------------------------------------------ baseline
		const base = snapshot(proto, TARGET_METHOD);
		const baselineCall = callTarget(instance as unknown as TasksLike);
		run.measure(
			"baseline",
			`${TARGET_METHOD}() -> ${baselineCall.length} tasks; own=${base.own}; arity=${base.arity}; source ${base.source.length} chars`,
			"the vault's own data behind the patched method",
		);

		// The meters patch three objects modkit does not own — `EventTarget.prototype`, `window` and
		// `Component.prototype` — which makes them the widest-blast-radius thing E2 does. They go on
		// the reclaim contract in the same breath as the install: left behind, they would wrap every
		// listener and every timer in the app for the rest of the session, and modkit would be
		// leaking while asserting that mods do not.
		const installedMeters = installMeters(instance);
		meters = installedMeters;
		scope.register(() => {
			installedMeters.uninstall();
		});
		if (!installedMeters.ok) run.finding("Leak instrumentation could not be fully installed, so the B assertions below are weaker than they look.");
		const windowStart = installedMeters.snapshot();

		// -------------------------------------------- install, and verify it took (L2)
		const counter: Counter = { calls: 0 };
		// B4/B5 compare against THIS baseline, not against zero. Measured 2026-09-02: both failed with
		// "2" on a vault whose already-enabled CSS mods were legitimately injecting stamped styles
		// before E2 ever ran — an absolute count blamed the experiment for someone else's furniture.
		const countStamps = () => ({
			elements: activeDocument.querySelectorAll("[data-modkit-mod]").length,
			styles: activeDocument.head.querySelectorAll("style[data-modkit-mod]").length,
		});
		const stampsBefore = countStamps();
		const beforeInstall = meters.snapshot();
		const uninstall = takeUninstaller(installProbePatch(proto, counter));
		const afterInstall = meters.snapshot();
		const installedRef: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];

		await run.check("E2.2", "the patch actually installed (the assignment was not swallowed)", () => ({
			ok: installedRef !== base.ref && typeof installedRef === "function",
			expected: "the prototype property now holds a different function",
			actual: installedRef === base.ref ? "unchanged — a silent no-op install" : `replaced with ${describe(installedRef)}`,
			detail: "a non-writable property would fail this silently in sloppy mode, which is why it is checked rather than assumed",
		}));

		// Counted as a delta rather than an absolute, because the target is free to call its own
		// method while we are awaiting — an absolute count would turn that into a spurious failure.
		const callsBeforeEffect = counter.calls;
		const effect = callTarget(instance as unknown as TasksLike);
		const effectDelta = counter.calls - callsBeforeEffect;
		await run.check("E2.3", "the patch takes effect, and the target's own behaviour is unchanged", () => ({
			ok: effectDelta === 1 && effect.ok && effect.length === baselineCall.length,
			expected: `1 wrapped call, ${TARGET_METHOD}() -> ${baselineCall.length} tasks`,
			actual: `${effectDelta} wrapped call(s), ${TARGET_METHOD}() -> ${effect.length}${effect.error !== undefined ? ` (threw: ${describe(effect.error)})` : ""}`,
		}));

		// ------------------------------------------------------ teardown, and A1–A5, A7
		const beforeTeardown = meters.snapshot();
		uninstall();
		const afterTeardown = meters.snapshot();
		const restoredRef: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];
		const removalPath =
			restoredRef === base.ref ? "true restore (hadOwn — the original function was put back by assignment)" : "neutered (we were not the outermost patcher, so the wrapper stays and passes through)";
		run.measure("monkey-around removal path taken", removalPath, "the true-restore path is the only one where reference identity is assertable");

		await run.check("A1", "the prototype method is the original function again, by reference", () => ({
			ok: restoredRef === base.ref,
			expected: "the exact function object captured before the patch",
			actual: restoredRef === base.ref ? "identical" : `a different function — ${removalPath}`,
			detail: "valid only while modkit is the sole patcher; A7 is the behavioural fallback when it is not",
		}));

		await run.check("A2", "own-property status is unchanged", () => {
			const own = Object.prototype.hasOwnProperty.call(proto, TARGET_METHOD);
			return { ok: own === base.own, expected: `hasOwnProperty === ${base.own}`, actual: String(own) };
		});

		await run.check("A3", "the prototype gained and lost no properties", () => {
			const now = Object.getOwnPropertyNames(proto).sort();
			const added = now.filter((n) => !base.ownNames.includes(n));
			const removed = base.ownNames.filter((n) => !now.includes(n));
			return {
				ok: added.length === 0 && removed.length === 0,
				expected: `${base.ownNames.length} own properties, unchanged`,
				actual: `${now.length} own properties${added.length > 0 ? `, added: ${added.join(", ")}` : ""}${removed.length > 0 ? `, removed: ${removed.join(", ")}` : ""}`,
			};
		});

		await run.check("A4", "the property descriptor is byte-for-byte what it was", () => {
			const now = Object.getOwnPropertyDescriptor(proto, TARGET_METHOD);
			return {
				ok: descriptorMatches(now, base.descriptor),
				expected: describeDescriptor(base.descriptor),
				actual: describeDescriptor(now),
				detail: "an enumerability flip would be the tell that something used defineProperty instead of assignment",
			};
		});

		await run.check("A5", "the prototype's own prototype was not re-parented", () => {
			const now = Object.getPrototypeOf(proto) as object | null;
			return { ok: now === base.protoOfHolder, expected: "unchanged prototype chain", actual: now === base.protoOfHolder ? "unchanged" : "re-parented" };
		});

		const callsBeforeA7 = counter.calls;
		const afterRemoval = callTarget(instance as unknown as TasksLike);
		await run.check("A7", "our wrapper no longer runs, and the target still returns what it did", () => ({
			ok: counter.calls === callsBeforeA7 && afterRemoval.ok && afterRemoval.length === baselineCall.length,
			expected: `no further wrapped calls, ${TARGET_METHOD}() -> ${baselineCall.length}`,
			actual: `${counter.calls - callsBeforeA7} wrapped call(s), ${TARGET_METHOD}() -> ${afterRemoval.length}`,
			detail: "the behavioural claim — this is what has to hold when reference identity legitimately cannot (A1's neutered case)",
		}));

		// ------------------------------------------------------------ leak accounting
		const installDelta = diff(beforeInstall, afterInstall);
		const teardownDelta = diff(beforeTeardown, afterTeardown);
		const attributable = sumCounts(installDelta, teardownDelta);

		await run.check("B1", "installing and removing the patch registers no DOM listeners of its own", () => ({
			ok: attributable.addEventListener === 0 && attributable.removeEventListener === 0,
			expected: "0 added, 0 removed",
			actual: `${attributable.addEventListener} added, ${attributable.removeEventListener} removed`,
			detail: "differenced across the synchronous install and teardown calls, so any delta is genuinely ours",
		}));

		await run.check("B2", "installing and removing the patch arms no timers of its own", () => ({
			ok: attributable.setInterval === 0 && attributable.clearInterval === 0,
			expected: "0 intervals armed, 0 cleared",
			actual: `${attributable.setInterval} armed, ${attributable.clearInterval} cleared`,
		}));

		await run.check("B3", "the target component grew no registrations because of us", () => ({
			ok: attributable.targetRegister === 0,
			expected: "0 calls to Component.register on the target instance",
			actual: String(attributable.targetRegister),
		}));

		await run.check("B4", "E2 left no modkit-stamped elements of its own in the DOM", () => {
			const n = countStamps().elements - stampsBefore.elements;
			return {
				ok: n === 0,
				expected: "0 more than before E2 started",
				actual: `${n} (${stampsBefore.elements} were already there from enabled mods)`,
			};
		});

		await run.check("B5", "E2 left no modkit-stamped stylesheets of its own in the document head", () => {
			const n = countStamps().styles - stampsBefore.styles;
			return {
				ok: n === 0,
				expected: "0 more than before E2 started",
				actual: `${n} (${stampsBefore.styles} were already there from enabled mods)`,
			};
		});

		// ------------------------------------------------------- C1 — the target still works
		await run.check("C1", "the target plugin is still functioning after the round trip", () => {
			const smoke = callTarget(instance as unknown as TasksLike);
			const command = app.commands?.commands?.[`${TARGET_ID}:toggle-done`];
			return {
				ok: smoke.ok && smoke.length === baselineCall.length && instance === pm.plugins?.[TARGET_ID],
				expected: `same live instance, ${TARGET_METHOD}() -> ${baselineCall.length}`,
				actual: `instance ${instance === pm.plugins?.[TARGET_ID] ? "unchanged" : "REPLACED"}, ${TARGET_METHOD}() -> ${smoke.length}${smoke.error !== undefined ? ` (threw: ${describe(smoke.error)})` : ""}`,
				detail: command === undefined ? "its toggle-done command is not registered (plane D would be unavailable)" : "its toggle-done command is still registered",
			};
		});

		// --------------------------------------- C2 — repeat safety, three full cycles
		await run.check("C2", `${REPEAT_CYCLES} install/uninstall cycles each restore the baseline`, () => {
			const failures: string[] = [];
			for (let cycle = 1; cycle <= REPEAT_CYCLES; cycle++) {
				const cycleCounter: Counter = { calls: 0 };
				const off = installProbePatch(proto, cycleCounter);
				const patched: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];
				callTarget(instance as unknown as TasksLike);
				off();
				const now: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];
				const names = Object.getOwnPropertyNames(proto).sort();
				if (patched === base.ref) failures.push(`cycle ${cycle}: install did not take`);
				if (cycleCounter.calls !== 1) failures.push(`cycle ${cycle}: wrapper ran ${cycleCounter.calls} times, expected 1`);
				if (now !== base.ref) failures.push(`cycle ${cycle}: A1 failed`);
				if (Object.prototype.hasOwnProperty.call(proto, TARGET_METHOD) !== base.own) failures.push(`cycle ${cycle}: A2 failed`);
				if (names.join() !== base.ownNames.join()) failures.push(`cycle ${cycle}: A3 failed`);
				if (!descriptorMatches(Object.getOwnPropertyDescriptor(proto, TARGET_METHOD), base.descriptor)) failures.push(`cycle ${cycle}: A4 failed`);
				if (Object.getPrototypeOf(proto) !== base.protoOfHolder) failures.push(`cycle ${cycle}: A5 failed`);
			}
			return {
				ok: failures.length === 0,
				expected: `${REPEAT_CYCLES} clean cycles`,
				actual: failures.length === 0 ? `${REPEAT_CYCLES} clean cycles` : failures.join("; "),
				detail: "catches an uninstaller that is correct once and destructive twice",
			};
		});

		// ------------------------------------------- D — coexistence with a second patcher
		//
		// The case that decides whether modkit can share a prototype with the ecosystem: other
		// plugins patch these objects too, and we are never guaranteed to be the only one.
		const innerCounter: Counter = { calls: 0 };
		const outerCounter: Counter = { calls: 0 };
		const removeInner = takeUninstaller(installProbePatch(proto, innerCounter));
		const removeOuter = takeUninstaller(installProbePatch(proto, outerCounter));

		callTarget(instance as unknown as TasksLike);
		const bothRan = innerCounter.calls === 1 && outerCounter.calls === 1;

		removeInner();
		const innerAtRemoval = innerCounter.calls;
		const outerAtRemoval = outerCounter.calls;
		callTarget(instance as unknown as TasksLike);

		await run.check("D1", "removing our patch from mid-stack leaves the patch above us running", () => ({
			ok: bothRan && outerCounter.calls === outerAtRemoval + 1 && innerCounter.calls === innerAtRemoval,
			expected: "the outer patch still runs; ours does not",
			actual: `outer ${outerCounter.calls - outerAtRemoval} call(s) after our removal, ours ${innerCounter.calls - innerAtRemoval}`,
			detail: "monkey-around cannot splice a mid-stack wrapper out, so it neuters instead — this is that path working as designed",
		}));

		removeOuter();
		// The neutered wrapper collapses itself on its next invocation, so identity comes back one
		// call later — not immediately. Asserting before this call would be asserting the wrong thing.
		callTarget(instance as unknown as TasksLike);
		await run.check("D2", "after both patches are gone, one further call collapses the chain back to the original", () => {
			const now: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];
			return {
				ok: now === base.ref,
				expected: "the original function, by reference",
				actual: now === base.ref ? "identical" : "still wrapped",
				detail: "monkey-around's lazy self-collapse: a neutered wrapper that finds itself outermost removes itself on its next call",
			};
		});

		// --------------------------------- A6 — the target reloads while our patch is mounted
		//
		// KEEP THIS STEP. It is the single most important unknown in the design notes §3.4 and the
		// thing `Supervisor` is designed around; a failure here is a finding, not a bug. What it is
		// not allowed to be is a surprise — hence the consent modal in front of the command, and the
		// three restore paths below.
		const reloadCounter: Counter = { calls: 0 };
		const removeAcrossReload = takeUninstaller(installProbePatch(proto, reloadCounter));
		const patchedRefBeforeReload: unknown = (proto as Record<string, unknown>)[TARGET_METHOD];

		// Recorded *before* the disable, so the repair below restores what the user actually had
		// rather than a state E2 inferred afterwards.
		targetWasListed = (await readEnabledPlugins(app))?.includes(TARGET_ID) === true;

		let reloadError: unknown;
		try {
			weDisabledTarget = true;
			await pm.disablePlugin?.(TARGET_ID);
			await pm.enablePlugin?.(TARGET_ID);
			weDisabledTarget = pm.plugins?.[TARGET_ID] === undefined;
		} catch (err) {
			reloadError = err;
		}
		await delay(250); // give the target's own onload a beat to settle before reading it

		// `disablePlugin` is not documented to persist — that is what `disablePluginAndSave` is for —
		// but the cost of being wrong is that the user's plugin works today and is silently off after
		// the next restart, which is exactly the kind of damage nobody would connect back to an
		// experiment. So: check, repair, and record the answer either way. Only ever re-adds the one
		// id, and only when it was listed before.
		let persistedEnableState = "not checked";
		if (targetWasListed) {
			const repair = await restoreEnabledPlugin(app, TARGET_ID);
			persistedEnableState =
				repair === "already-listed"
					? "untouched — disablePlugin() does not write community-plugins.json"
					: repair === "restored"
						? "REPAIRED — disablePlugin() removed the target from community-plugins.json and E2 put it back"
						: `could not be verified (${repair})`;
			if (repair === "restored") {
				run.finding(
					`\`app.plugins.disablePlugin(id)\` DOES persist to community-plugins.json on this build. E2 put "${TARGET_ID}" back, but modkit must treat disable as a saved state change — a mod's target that is disabled for a moment would otherwise stay off after a restart.`,
				);
			}
		}
		run.measure(
			"the target's persisted enabled state across the reload",
			persistedEnableState,
			targetWasListed ? "community-plugins.json is what the host reads at launch" : "the target was not listed there before the reload, so there was nothing to preserve",
		);

		const newInstance = pm.plugins?.[TARGET_ID];
		const newProto = (newInstance?.constructor as { prototype?: unknown } | undefined)?.prototype;
		const sameClass = newProto === proto;
		const callsBeforeNewCall = reloadCounter.calls;
		if (newInstance !== undefined) callTarget(newInstance as unknown as TasksLike);
		const patchStillLive = reloadCounter.calls > callsBeforeNewCall;

		run.measure(
			"the target's class object survives a disable/enable cycle",
			reloadError !== undefined ? `unknown — the reload threw: ${describe(reloadError)}` : sameClass ? "yes — same prototype object" : "no — a fresh class object with a fresh prototype",
		);
		run.measure(
			"a patch mounted before the reload is still live after it",
			reloadError !== undefined ? "unknown — the reload threw" : patchStillLive ? "yes" : "no — the patch is silently inert",
		);
		run.finding(
			reloadError !== undefined
				? `A6 is unresolved: reloading ${TARGET_ID} threw (${describe(reloadError)}), so the reload hazard was not measured this run.`
				: sameClass
					? "A target reload does NOT replace the class object in this build: a mod's patches survive its target being disabled and re-enabled. The supervisor's re-apply path is then a belt-and-braces measure rather than the load-bearing one."
					: "A target reload REPLACES the class object, and a mod patched onto the old prototype goes silently inert while still reporting itself enabled. This is the failure `Supervisor` exists for; identity comparison detects it, and re-applying the mod is mandatory rather than optional.",
		);

		// What modkit actually depends on is not which answer this is — it is that the answer is
		// *observable*. Class-object identity is what `Supervisor` watches, so detectability is the
		// assertion, and the answer above is the measurement.
		await run.check("A6", "a target reload is detectable by comparing the target's class-object identity", () => ({
			ok: reloadError === undefined && newInstance !== undefined && typeof newProto === "object" && newProto !== null,
			expected: "a readable class prototype before and after the reload",
			actual:
				reloadError !== undefined
					? `the reload threw: ${describe(reloadError)}`
					: newInstance === undefined
						? "the target did not come back after enablePlugin"
						: `readable; identity ${sameClass ? "unchanged" : "changed"}`,
			detail: "the supervisor's whole re-apply story rests on this comparison being possible",
		}));

		// Our patch went onto the pre-reload prototype; removing it restores that object, whether or
		// not anything still points at it. The claim that matters to the user is the next one.
		removeAcrossReload();
		await run.check("E2.4", "the live target is left unpatched, whatever the reload did", () => {
			const live = pm.plugins?.[TARGET_ID];
			const liveProto = (live?.constructor as { prototype?: unknown } | undefined)?.prototype;
			const current: unknown = typeof liveProto === "object" && liveProto !== null ? (liveProto as Record<string, unknown>)[TARGET_METHOD] : undefined;
			const clean = typeof current === "function" && current !== patchedRefBeforeReload;
			return {
				ok: clean,
				expected: "the live prototype's method is not one of our wrappers",
				actual: current === patchedRefBeforeReload ? "our wrapper is still installed on the live target" : "clean",
				detail: "no experiment may leave a foreign plugin patched — this is the last line before the finally",
			};
		});

		const windowEnd = meters.snapshot();
		const wide = diff(windowStart, windowEnd);
		run.measure(
			"app-wide acquisitions during the whole experiment",
			`listeners +${wide.addEventListener}/-${wide.removeEventListener}, intervals +${wide.setInterval}/-${wide.clearInterval}, target registrations ${wide.targetRegister}`,
			"NOT attributable to the patch — this window includes the target's own reload and everything else Obsidian did meanwhile; B1–B3 are the attributable numbers",
		);
	} catch (err) {
		thrown = err;
	} finally {
		for (const uninstall of pending.reverse()) {
			try {
				uninstall();
			} catch (err) {
				console.error("modkit E2: a patch would not uninstall during cleanup", err);
			}
		}
		pending.length = 0;
		try {
			meters?.uninstall();
		} catch (err) {
			console.error("modkit E2: the counters would not uninstall", err);
		}

		// The target must never be left switched off because an experiment failed halfway through.
		// A failed experiment is an acceptable outcome; a user's plugin left disabled by one is not.
		if (weDisabledTarget) {
			try {
				await pm?.enablePlugin?.(TARGET_ID);
			} catch (err) {
				console.error("modkit E2: could not re-enable the target after a failed reload", err);
			}
			// Verified by reading it back, not by the absence of an error — and if it really is
			// still down, the user is told in words that name the plugin and the way back, because
			// this is the one failure of E2 that costs them something.
			if (pm?.plugins?.[TARGET_ID] === undefined) {
				const name = pm?.manifests?.[TARGET_ID]?.name ?? TARGET_FALLBACK_NAME;
				console.error(`modkit E2: ${TARGET_ID} is still disabled after the experiment`);
				new Notice(
					`modkit E2 could not switch ${name} back on. Re-enable it in Settings → Community plugins → ${name}.`,
					0,
				);
			}
			// Restore-only: never adds an id the user did not already have listed.
			if (targetWasListed) {
				try {
					await restoreEnabledPlugin(app, TARGET_ID);
				} catch (err) {
					console.error("modkit E2: could not restore the target's persisted enabled state", err);
				}
			}
			weDisabledTarget = false;
		}

		// Last, and only now: everything above has already been undone, so the reclaim registrations
		// on `scope` fire as no-ops. Unloading it earlier would race the awaited teardown.
		plugin.removeChild(scope);
	}

	return await publish(app, run.finish(thrown));
}
