/**
 * A ~200-line assertion runner for experiments that can only be run inside the real app.
 *
 * No test framework, and not because one would be inconvenient to add: an experiment like E2
 * measures a *running Obsidian* against a *live vault*, so the thing under test cannot be imported
 * into a node process. Experiments ship as palette commands, and this is what turns their result
 * into something durable.
 *
 * Three deliberate shapes:
 *
 * 1. **Assertions and measurements are different kinds of result, and mixing them is dishonest.**
 *    An assertion has a right answer ("teardown restored the prototype"). A measurement answers an
 *    open question whose answer we do not yet know ("does `enablePlugin` persist to
 *    `community-plugins.json`?") — both outcomes are valid, and forcing one into pass/fail would
 *    either invent a requirement or hide the finding in a passing run. Findings are the prose layer
 *    on top: the sentence a reader should take away.
 *
 * 2. **A failure records actual-vs-expected, not just `false`.** A red line that does not say what it
 *    saw sends you back to the app to run it again.
 *
 * 3. **The report is written into the vault**, because console scrollback is gone by the time anyone
 *    asks what the answer was. `modkit/experiments/<date>-<id>.md` is a normal note: syncs, greppable,
 *    survives a restart. Repeated runs on one day *append* — an experiment whose earlier runs are
 *    silently overwritten cannot show you a flake.
 *
 * A fourth shape was added after review: **a run that did nothing must not read like a run.** The
 * report file is append-only and grows a section per invocation, so a `SKIP` section that renders
 * with the same heading as a real run turns the artifact into a count of attempts rather than a
 * record of answers. `renderMarkdown` therefore heads a skipped run "NOTHING RAN" and states the
 * reason above the table. (A *cancelled* run is simpler still: it never reaches the harness, so no
 * report exists to be misread — see `runExperiment` in `index.ts`.)
 */

import { Notice, Platform, apiVersion, normalizePath } from "obsidian";
import type { App } from "obsidian";

export type AssertionStatus = "pass" | "fail" | "skip";

export interface AssertionResult {
	/** Short stable key — `"A1"`, `"E1.4"`. Stable across runs so two reports can be diffed. */
	id: string;
	name: string;
	status: AssertionStatus;
	expected?: string;
	actual?: string;
	detail?: string;
	ms: number;
}

/** An open question's answer. No pass/fail: both outcomes are information. */
export interface Measurement {
	name: string;
	value: string;
	note?: string;
}

/**
 * What a check returns. A bare boolean is fine for the obvious ones; the object form carries the
 * actual-vs-expected that makes a failure readable without re-running the experiment.
 */
export type CheckOutcome = boolean | { ok: boolean; expected?: string; actual?: string; detail?: string };

export interface ExperimentReport {
	id: string;
	title: string;
	startedAt: number;
	ms: number;
	/** `fail` if anything failed or the body threw; `skip` if nothing ran but something was skipped. */
	status: AssertionStatus;
	passed: number;
	failed: number;
	skipped: number;
	assertions: AssertionResult[];
	measurements: Measurement[];
	findings: string[];
	/** Set when the experiment body threw before it could finish. */
	error?: string;
	/** Vault path of the markdown artifact, once published. */
	reportPath?: string;
	env: { app: string; vault: string; platform: string };
}

const MAX_CELL = 400;

// ------------------------------------------------------------------ consent

/**
 * Everything the user is told **before** an experiment touches anything.
 *
 * It lives here rather than next to the modal because the facts belong to the experiment, not to the
 * surface that renders them: `e2.ts` describes its own blast radius, and `index.ts` renders whatever
 * it declares. Keeping the two apart is what stops the modal drifting from what the code actually
 * does — the failure mode this whole type exists to prevent.
 *
 * Written as *what will happen to your vault*, not as *what the experiment is about*. A person
 * deciding whether to press the button needs the second list, not the first.
 */
export interface ExperimentConsent {
	/** Modal heading. Phrase it as the question being asked. */
	title: string;
	/** One or two sentences on what the experiment answers. */
	summary: string;
	/**
	 * Plugins that get switched off and back on during the run — **by name and by id**, because a
	 * user recognises the name and only the id is unambiguous.
	 */
	toggles: { name: string; id: string; note?: string }[];
	/** Paths written during the run and removed again before it ends. */
	writesThenRemoves: string[];
	/** Paths the run leaves behind on purpose. */
	leavesBehind: string[];
	/** Rough wall-clock, in the words a person would use ("about 10–20 seconds"). */
	duration: string;
	/** What the user will see happen to the app while it runs. */
	disturbance: string;
	/** The proceed button's label. Never "OK" — it says what it will do. */
	proceedLabel: string;
}

/** Values get stringified for the report, so a lazy `String(x)` on an object loses the answer. */
export function describe(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "function") return `function ${value.name || "(anonymous)"}`;
	if (Array.isArray(value)) return `[${value.map((v) => describe(v)).join(", ")}]`;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "object") {
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}
	return String(value);
}

/**
 * One experiment run in progress. Create it, drive it with `check`/`measure`/`finding`, `finish` it.
 *
 * Nothing here throws: a harness that can fail the experiment it is measuring is worse than no
 * harness. A check whose body throws is recorded as a failure with the error as its detail, which is
 * almost always the honest reading anyway.
 */
export class ExperimentRun {
	readonly startedAt = Date.now();
	private readonly assertions: AssertionResult[] = [];
	private readonly measurements: Measurement[] = [];
	private readonly findings: string[] = [];

	constructor(
		readonly id: string,
		readonly title: string,
		private readonly app: App,
	) {}

	/**
	 * Run one assertion. Returns whether it passed, so a caller can branch — several later checks are
	 * only meaningful if an earlier one held, and running them anyway produces noise, not information.
	 */
	async check(id: string, name: string, fn: () => CheckOutcome | Promise<CheckOutcome>): Promise<boolean> {
		const started = Date.now();
		try {
			const outcome = await fn();
			const normalized = typeof outcome === "boolean" ? { ok: outcome } : outcome;
			const result: AssertionResult = {
				id,
				name,
				status: normalized.ok ? "pass" : "fail",
				ms: Date.now() - started,
			};
			if (normalized.expected !== undefined) result.expected = normalized.expected;
			if (normalized.actual !== undefined) result.actual = normalized.actual;
			if (normalized.detail !== undefined) result.detail = normalized.detail;
			this.assertions.push(result);
			return normalized.ok;
		} catch (err) {
			this.assertions.push({
				id,
				name,
				status: "fail",
				detail: `the check itself threw — ${describe(err)}`,
				ms: Date.now() - started,
			});
			return false;
		}
	}

	/** A precondition was not met. Skipping loudly is a result; quietly not running is not. */
	skip(id: string, name: string, why: string): void {
		this.assertions.push({ id, name, status: "skip", detail: why, ms: 0 });
	}

	/** An answer to an open question. Both outcomes are valid — that is what makes it not an assertion. */
	measure(name: string, value: unknown, note?: string): void {
		const entry: Measurement = { name, value: describe(value) };
		if (note !== undefined) entry.note = note;
		this.measurements.push(entry);
	}

	/** The sentence a reader should take away. Written for someone who will not read the table. */
	finding(text: string): void {
		this.findings.push(text);
	}

	get failures(): AssertionResult[] {
		return this.assertions.filter((a) => a.status === "fail");
	}

	finish(error?: unknown): ExperimentReport {
		const passed = this.assertions.filter((a) => a.status === "pass").length;
		const failed = this.assertions.filter((a) => a.status === "fail").length;
		const skipped = this.assertions.filter((a) => a.status === "skip").length;
		const status: AssertionStatus = failed > 0 || error !== undefined ? "fail" : passed > 0 ? "pass" : "skip";

		const report: ExperimentReport = {
			id: this.id,
			title: this.title,
			startedAt: this.startedAt,
			ms: Date.now() - this.startedAt,
			status,
			passed,
			failed,
			skipped,
			assertions: [...this.assertions],
			measurements: [...this.measurements],
			findings: [...this.findings],
			env: {
				app: `Obsidian API ${apiVersion}`,
				vault: this.app.vault.getName(),
				platform: Platform.isDesktopApp ? "desktop" : Platform.isMobileApp ? "mobile" : "unknown",
			},
		};
		if (error !== undefined) report.error = describe(error);
		return report;
	}
}

// ------------------------------------------------------------------ rendering

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local date, not UTC: the file is named for the day the person ran it. */
export function localDateStamp(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeStamp(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function cell(value: string | undefined): string {
	if (value === undefined || value === "") return "";
	const flat = value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
	return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL)}…` : flat;
}

const ICON: Record<AssertionStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

/** Rendering 1 of 3 — the developer console, where you are already looking when you run it. */
export function logReport(report: ExperimentReport): void {
	const label = `modkit ${report.id.toUpperCase()} — ${report.title} — ${report.status.toUpperCase()}`;
	const rows = report.assertions.map((a) => ({
		id: a.id,
		status: ICON[a.status],
		assertion: a.name,
		expected: a.expected ?? "",
		actual: a.actual ?? "",
		detail: a.detail ?? "",
		ms: a.ms,
	}));

	console.group?.(label);
	try {
		if (typeof console.table === "function") console.table(rows);
		else console.log(rows);
		if (report.measurements.length > 0) {
			console.log("measurements:");
			if (typeof console.table === "function") console.table(report.measurements);
			else console.log(report.measurements);
		}
		for (const finding of report.findings) console.log(`finding: ${finding}`);
		if (report.error !== undefined) console.error(`the experiment threw: ${report.error}`);
	} finally {
		console.groupEnd?.();
	}
}

/**
 * The reasons a run skipped, in the order they were recorded.
 *
 * A `skip` carries its `why` in `detail`; a run that skipped everything has nothing else to say, so
 * this is the whole content of its report.
 */
function skipReasons(report: ExperimentReport): string[] {
	return report.assertions.filter((a) => a.status === "skip" && a.detail !== undefined).map((a) => a.detail as string);
}

/** True when the run reached nothing: no assertion passed and none failed. */
function nothingRan(report: ExperimentReport): boolean {
	return report.status === "skip";
}

/** Rendering 2 of 3 — a Notice, for the person who ran the command and is looking at the app. */
export function noticeReport(report: ExperimentReport): void {
	if (nothingRan(report)) {
		// Not "0 passed, 0 failed" — that reads as a run that found nothing wrong. Nothing happened.
		const why = skipReasons(report)[0] ?? "a precondition was not met";
		const where = report.reportPath !== undefined ? `\n→ ${report.reportPath}` : "";
		new Notice(`modkit ${report.id.toUpperCase()}: nothing ran, and nothing was changed.\n${why}${where}`, 15_000);
		return;
	}

	const head = `modkit ${report.id.toUpperCase()}: ${report.status.toUpperCase()} — ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (${(report.ms / 1000).toFixed(1)}s)`;
	const failures = report.assertions
		.filter((a) => a.status === "fail")
		.slice(0, 3)
		.map((a) => `• ${a.id} ${a.name}`)
		.join("\n");
	const where = report.reportPath !== undefined ? `\n→ ${report.reportPath}` : "\n(report could not be written to the vault — see the console)";
	const body = failures === "" ? "" : `\n${failures}`;
	// A failure stays up long enough to be read, but not forever: a duration-0 Notice from a
	// 2026-09-02 E2 run was still on screen hours later, over every screenshot of the retest. The
	// report note in the vault is the durable record; the Notice only has to point at it.
	new Notice(`${head}${body}${where}`, report.status === "fail" ? 60_000 : 15_000);
}

/** Rendering 3 of 3 — the durable artifact. One `## Run` section per run, appended. */
export function renderMarkdown(report: ExperimentReport, at: Date): string {
	const lines: string[] = [];
	const skipped = nothingRan(report);

	// A run that did nothing gets a heading that says so. The alternative — "SKIP (0 passed, 0
	// failed, 1 skipped)" under the same `## Run` shape as a real result — turns an append-only
	// artifact into a log of attempts that a skim-reader counts as answers.
	lines.push(
		skipped
			? `## Run ${localDateStamp(at)} ${localTimeStamp(at)} — NOTHING RAN (${(report.ms / 1000).toFixed(1)}s)`
			: `## Run ${localDateStamp(at)} ${localTimeStamp(at)} — ${report.status.toUpperCase()} (${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ${(report.ms / 1000).toFixed(1)}s)`,
		"",
		`${report.env.app} · vault \`${report.env.vault}\` · ${report.env.platform}`,
		"",
	);

	if (skipped) {
		lines.push(
			"> **This run changed nothing and measured nothing.** A precondition was not met, so the experiment stopped before touching anything. Its questions are still open — this section is not a result.",
			"",
		);
		for (const why of skipReasons(report)) lines.push(`> - ${why}`);
		if (skipReasons(report).length > 0) lines.push("");
	}

	if (report.error !== undefined) {
		lines.push(`> **The experiment threw before it finished:** ${report.error}`, "");
	}

	if (report.findings.length > 0) {
		lines.push("### Findings", "");
		for (const finding of report.findings) lines.push(`- ${finding}`);
		lines.push("");
	}

	lines.push("### Assertions", "", "| id | status | assertion | expected | actual | detail | ms |", "|---|---|---|---|---|---|---|");
	for (const a of report.assertions) {
		lines.push(
			`| ${cell(a.id)} | ${ICON[a.status]} | ${cell(a.name)} | ${cell(a.expected)} | ${cell(a.actual)} | ${cell(a.detail)} | ${a.ms} |`,
		);
	}
	lines.push("");

	if (report.measurements.length > 0) {
		lines.push(
			"### Measurements",
			"",
			"Open questions. Both answers are valid — these are not assertions.",
			"",
			"| measurement | value | note |",
			"|---|---|---|",
		);
		for (const m of report.measurements) {
			lines.push(`| ${cell(m.name)} | ${cell(m.value)} | ${cell(m.note)} |`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ------------------------------------------------------------------ publishing

const REPORT_ROOT = "modkit";
const REPORT_DIR = "modkit/experiments";

/**
 * `mkdir` is not documented as recursive, so create each level, and treat "it already exists" as
 * success rather than probing first — a check-then-create race is the one way this can fail on a
 * synced vault.
 */
async function ensureDir(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (await app.vault.adapter.exists(normalized)) return;
	try {
		await app.vault.adapter.mkdir(normalized);
	} catch (err) {
		if (!(await app.vault.adapter.exists(normalized))) throw err;
	}
}

/**
 * Write the markdown artifact. Returns its vault path, or `null` — a failure to *record* a result
 * must never look like a failure of the experiment, so this reports and returns rather than throwing.
 */
export async function writeReport(app: App, report: ExperimentReport, at: Date): Promise<string | null> {
	const path = normalizePath(`${REPORT_DIR}/${localDateStamp(at)}-${report.id}.md`);
	const section = renderMarkdown(report, at);
	try {
		await ensureDir(app, REPORT_ROOT);
		await ensureDir(app, REPORT_DIR);
		if (await app.vault.adapter.exists(path)) {
			// Append: a run that silently overwrote the morning's run could not show you a flake.
			await app.vault.adapter.append(path, `\n---\n\n${section}`);
		} else {
			const header = `# modkit experiment ${report.id.toUpperCase()} — ${report.title}\n\nGenerated by the \`modkit: Run experiment ${report.id.toUpperCase()}\` command. One section per run.\n\n`;
			await app.vault.adapter.write(path, `${header}${section}`);
		}
		return path;
	} catch (err) {
		console.error("modkit: could not write the experiment report", err);
		return null;
	}
}

// -------------------------------------------------- the host's enable-state record

/**
 * `<configDir>/community-plugins.json` — the list Obsidian reads at launch to decide what to turn
 * on. Both experiments touch a plugin's enabled state, so both need to be able to see, and repair,
 * what the host persisted while they were running.
 */
export function enabledPluginsPath(app: App): string {
	return normalizePath(`${app.vault.configDir}/community-plugins.json`);
}

/** The enabled list as it is on disk, or `null` when absent or not the shape we expect. */
export async function readEnabledPlugins(app: App): Promise<string[] | null> {
	try {
		const path = enabledPluginsPath(app);
		if (!(await app.vault.adapter.exists(path))) return null;
		const parsed: unknown = JSON.parse(await app.vault.adapter.read(path));
		if (!Array.isArray(parsed)) return null;
		if (!parsed.every((entry) => typeof entry === "string")) return null;
		return parsed as string[];
	} catch (err) {
		console.error("modkit: could not read the enabled-plugin list", err);
		return null;
	}
}

/**
 * These two write the file that decides which plugins load at startup, so both are deliberately
 * narrow: each only ever adds or filters **the one id it is handed**, only when the file parses to
 * an array of strings, and only when a change is actually needed. Nothing here rewrites the list.
 */
async function writeEnabledPlugins(app: App, ids: string[]): Promise<boolean> {
	try {
		await app.vault.adapter.write(enabledPluginsPath(app), `${JSON.stringify(ids, null, 2)}\n`);
		return true;
	} catch (err) {
		console.error("modkit: could not write the enabled-plugin list", err);
		return false;
	}
}

/** Take `id` out of the list — for a plugin the experiment installed and has now removed. */
export async function removeEnabledPlugin(app: App, id: string): Promise<"absent" | "removed" | "unreadable" | "failed"> {
	const list = await readEnabledPlugins(app);
	if (list === null) return "unreadable";
	if (!list.includes(id)) return "absent";
	return (await writeEnabledPlugins(app, list.filter((entry) => entry !== id))) ? "removed" : "failed";
}

/**
 * Put `id` back — for a plugin the *user* had enabled and the experiment switched off.
 *
 * `disablePlugin` is not documented to persist (that is what `disablePluginAndSave` is for), but
 * "not documented to" is not "does not", and the failure it would cause is silent and permanent:
 * the user's plugin comes back today and is simply gone after the next restart. So the experiment
 * checks rather than assumes.
 */
export async function restoreEnabledPlugin(app: App, id: string): Promise<"already-listed" | "restored" | "unreadable" | "failed"> {
	const list = await readEnabledPlugins(app);
	if (list === null) return "unreadable";
	if (list.includes(id)) return "already-listed";
	return (await writeEnabledPlugins(app, [...list, id])) ? "restored" : "failed";
}

/** Finish a run: write the artifact, then render it to the console and to a Notice. */
export async function publish(app: App, report: ExperimentReport): Promise<ExperimentReport> {
	const at = new Date();
	const path = await writeReport(app, report, at);
	if (path !== null) report.reportPath = path;
	logReport(report);
	noticeReport(report);
	return report;
}
