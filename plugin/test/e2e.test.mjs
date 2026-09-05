/**
 * The whole flow, end to end, against the **shipped bundle**.
 *
 * Four adversarial rounds hardened the daemon's validator and added a human review gate. Every one
 * of those rounds asked "can this be bypassed?" and none of them asked the other question: **does
 * modkit still work?** A gate that refuses everything passes every adversarial test ever written.
 * This file is the other question, and it is deliberately the only test in the suite that spans all
 * of it at once:
 *
 *   command → target picked → request typed → POST /v1/generate over a real socket → the daemon's
 *   real job queue → the real validator → the real esbuild bundle → a real Ed25519 artifact signed
 *   by a real keyring → the plugin's real verification against a pinned root key → the review modal
 *   → `ModInstaller` writing the vault → Obsidian enabling the plugin → the ledger record in
 *   `data.json`.
 *
 * The three paths that must NOT install are asserted with the same instrument, because "nothing was
 * written" is only meaningful next to a run where something was:
 *
 *   - **refusal** — the daemon says no, and that is the product working, not an error;
 *   - **fail-closed** — the artifact is signed by a key the plugin has not pinned;
 *   - **review cancelled** — the person says no at the last gate.
 *
 * ## What is real here
 *
 * The daemon is real (`createApp`, `JobQueue`, `loadKeyring`, `signArtifact`) and is reached over
 * loopback TCP through Obsidian's `requestUrl` shape — see `helpers/daemon-server.mjs`. Its two
 * generation-time gates are real too: `validateSource` and `buildPatchPlugin` run on every request,
 * over `fixtures/quieter-tasks.mjs`, so the bytes that get signed are a genuine esbuild output of a
 * source the hardened validator accepted. The plugin is the built `dist/main.js`, loaded the way
 * Obsidian loads it. The host is `stub/app.mjs`, whose `enablePlugin` refuses a plugin with no
 * `main.js` on disk, so a green enable is downstream of a real write.
 *
 * ## What is not
 *
 * The **model** — the pipeline is injected, and `fixtures/quieter-tasks.mjs` stands in for what it
 * would have written. And a "loaded plugin" in the host stub is a placeholder object: the generated
 * `main.js` is written and enabled but never evaluated, so nothing here asserts that the patch *did*
 * anything inside the target. That is the stub's documented ceiling (see `stub/app.mjs`), and it is
 * stated rather than papered over.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, afterEach, beforeEach, describe } from "node:test";
import vm from "node:vm";

import { loadBundle } from "./helpers/bundle.mjs";
import {
	buildPatchPlugin,
	mintKeyring,
	startDaemon,
	stopBuilder,
	validateSource,
} from "./helpers/daemon-server.mjs";
import * as obsidianStub from "./stub/obsidian.mjs";
import { Modal, Notice, setRequestUrlHandler } from "./stub/obsidian.mjs";
import { createApp, manifestFor, tick } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

const MODKIT_MANIFEST = manifestFor("modkit", { name: "modkit", version: "0.1.0" });

const TARGET_ID = "obsidian-tasks-plugin";
const TARGET_MANIFEST = manifestFor(TARGET_ID, { name: "Tasks", version: "7.4.0" });
const MOD_ID = "modkit-mod-quieter-tasks";
const REQUEST = "stop the tasks plugin shouting a notice every time I complete something";

/**
 * The mod the stubbed model "wrote", as ESM source — the artefact a real generation produces before
 * anything downstream touches it. It is validated and bundled by the daemon's own code below, so
 * `mainJs` is a genuine esbuild output rather than a hand-written approximation of one.
 */
const MOD_SOURCE = readFileSync(new URL("./fixtures/quieter-tasks.mjs", import.meta.url), "utf8");

/** The bundle the daemon will produce from it. Built once here so assertions can compare bytes. */
const MOD_BUNDLE = await (async () => {
	const report = validateSource(MOD_SOURCE);
	assert.ok(
		report.ok,
		`the e2e fixture no longer passes modkit's own validator: ${JSON.stringify(report.findings, null, 1)}`,
	);
	const built = await buildPatchPlugin(MOD_SOURCE);
	assert.ok(built.ok, `the e2e fixture no longer builds: ${JSON.stringify(built, null, 1)}`);
	return built.code;
})();

/**
 * The daemon's real generation, with only the model replaced.
 *
 * The validator and esbuild both run for real on every call — so a hardening change that started
 * rejecting a legitimate mod would fail this test rather than pass it, which is the failure mode
 * four adversarial rounds have been steering towards.
 */
async function generateForReal() {
	const report = validateSource(MOD_SOURCE);
	if (!report.ok) throw new Error(`validator rejected the mod: ${JSON.stringify(report.findings)}`);
	const built = await buildPatchPlugin(MOD_SOURCE);
	if (!built.ok) throw new Error("the mod did not build");
	return { kind: "built", draft: draftFor({ mainJs: built.code }) };
}

const MOD_MANIFEST = {
	id: MOD_ID,
	name: "Quieter tasks",
	version: "0.1.0",
	minAppVersion: "1.7.2",
	description: "Routes the Tasks plugin's completion notices to the console.",
	author: "modkit",
	isDesktopOnly: false,
};

function draftFor(overrides = {}) {
	return {
		modId: MOD_ID,
		manifest: MOD_MANIFEST,
		mainJs: MOD_BUNDLE,
		request: REQUEST,
		target: {
			kind: "plugin",
			pluginId: TARGET_ID,
			pluginName: "Tasks",
			pluginVersion: "7.4.0",
		},
		reach: { plane: "C", pluginId: TARGET_ID, holder: "prototype", member: "onload" },
		targetVersionRange: { from: "7.0.0", to: null },
		noEffect: { mode: "on-demand" },
		explanation: "Wraps the plugin's notice helper so completions log instead of shouting.",
		model: "e2e-stub-model",
		...overrides,
	};
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/* ────────────────────────────────────────────────────────────────────────────
 * Driving the UI
 *
 * The bundle and this file share one `Modal` class object (the bundle's `require("obsidian")` is
 * answered with this module), so patching its prototype is how a headless test gets hold of a modal
 * the plugin opened. Nothing else in the suite needs this, which is why it lives here.
 * ──────────────────────────────────────────────────────────────────────────── */

let openModals = [];
let restoreModalOpen = null;

function watchModals() {
	const original = Modal.prototype.open;
	restoreModalOpen = () => {
		Modal.prototype.open = original;
	};
	Modal.prototype.open = function patchedOpen(...args) {
		openModals.push(this);
		return original.apply(this, args);
	};
}

/** The most recently opened modal whose `contentEl` carries `cls`, or null. */
function modalWith(cls) {
	for (let i = openModals.length - 1; i >= 0; i--) {
		const modal = openModals[i];
		if (modal.isOpen && modal.contentEl?.hasClass?.(cls)) return modal;
	}
	return null;
}

function buttons(root) {
	return root.querySelectorAll("button");
}

/** Every descendant satisfying `predicate`. The stub's `querySelectorAll` has no class selectors. */
function findAll(root, predicate) {
	const out = [];
	const walk = (node) => {
		for (const child of node.children) {
			if (predicate(child)) out.push(child);
			walk(child);
		}
	};
	walk(root);
	return out;
}

/** Click the button whose label is exactly `label`. Throws with the real labels if there is none. */
function click(root, label) {
	const all = buttons(root);
	const found = all.find((b) => b.textContent === label);
	if (found === undefined) {
		throw new Error(`no button labelled "${label}" — found: ${JSON.stringify(all.map((b) => b.textContent))}`);
	}
	found.dispatch("click", { preventDefault() {}, stopPropagation() {} });
	return found;
}

/** Poll until `predicate()` is truthy, or fail with `what`. Real timers; the daemon is real too. */
async function until(what, predicate, { timeoutMs = 15_000, everyMs = 20 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await tick(everyMs);
	}
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture
 * ──────────────────────────────────────────────────────────────────────────── */

let dom;
let app;
let plugin;
let daemon;

// esbuild keeps a service process alive; without this the test file does not exit.
after(async () => {
	await stopBuilder();
});

beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
	openModals = [];
	watchModals();
	plugin = null;
	daemon = null;
});

afterEach(async () => {
	try {
		plugin?.unload();
	} catch {
		/* an assertion has already reported whatever went wrong */
	}
	restoreModalOpen?.();
	restoreModalOpen = null;
	setRequestUrlHandler(null);
	await daemon?.stop();
	dom.restore();
});

/**
 * Boot a host with the target plugin installed and running, then load modkit over it with settings
 * already paired to `daemon`.
 */
async function boot(settings = {}) {
	app = createApp({ reindexDelayMs: 1 });
	app.plugins.install(TARGET_MANIFEST, { enabled: true, loaded: true });
	// modkit's own folder. It always exists in a real vault — Obsidian loaded `main.js` out of it —
	// and `SettingsStore` writes the bearer-token sidecar into it on first load, so a harness that
	// omitted it would be modelling a vault that cannot exist.
	app.vault.adapter.mkdirp(`${app.vault.configDir}/plugins/modkit`);
	// Pre-seed `data.json`, the way a paired vault has it. This is the same file the ledger is
	// written back into, so a mod record landing here is a real round trip.
	app.pluginData.set("modkit", {
		protocol: "MODKIT/1",
		settings: {
			daemonBaseUrl: daemon.baseUrl,
			daemonToken: daemon.token,
			daemonPubkey: daemon.rootPubkeyHex,
			requireSignature: true,
			autoEnableGeneratedMods: true,
			reviewBeforeEnable: true,
			// The launch build hides “Mod plugin…” behind Debug logging (PLAN.md "Launch": plugin
			// modding stays experimental until a patch has been carried across a real target update).
			// This suite exercises exactly that path on purpose, so it turns the switch on.
			debugLogging: true,
			...settings,
		},
		mods: [],
	});

	const { exports } = loadBundle();
	plugin = new exports.default(app, MODKIT_MANIFEST);
	await plugin.load();
	await tick(2);
	app.workspace.fireLayoutReady();
	await tick(5);
	return plugin;
}

/** Command → pick the target → type the request → press Generate. Returns once the job is away. */
async function askFor(request = REQUEST) {
	const command = app.commands.commands["modkit:mod-plugin"];
	assert.ok(command, "the “Mod plugin…” command is not registered");
	// Ungated 2026-09-04, once E3 carried a patch across a real target update and the premature
	// `applied` it exposed was fixed. It was a `checkCallback` gated on Debug logging until then;
	// this assertion is what pinned the gate, so it now pins its absence.
	assert.equal(
		typeof command.checkCallback,
		"undefined",
		"“Mod plugin…” is no longer gated — a checkCallback here means the Debug-logging gate came back",
	);
	assert.equal(typeof command.callback, "function", "“Mod plugin…” must be a plain, always-available command");
	command.callback();

	const picker = await until("the target picker to open", () =>
		openModals.find((m) => m.isOpen && typeof m.getItems === "function"),
	);
	const target = picker.getItems().find((p) => p.id === TARGET_ID);
	assert.ok(target, `the picker does not offer ${TARGET_ID}: ${JSON.stringify(picker.getItems().map((p) => p.id))}`);
	picker.onChooseItem(target, {});
	picker.close();

	const compose = await until("the compose modal to open", () => modalWith("modkit-compose"));
	const textarea = compose.contentEl.querySelector("textarea");
	assert.ok(textarea, "the compose modal has no request field");
	textarea.value = request;
	textarea.dispatch("input", {});
	click(compose.contentEl, "Write the change");
	return compose;
}

/** The mod's folder in the stub vault. */
const modPath = (file, modId = MOD_ID) => `${app.vault.configDir}/plugins/${modId}/${file}`;

function installedFiles(modId = MOD_ID) {
	return [...app.vault.adapter.files.keys()].filter((p) => p.includes(`/plugins/${modId}/`)).sort();
}

function ledger() {
	return app.pluginData.get("modkit")?.mods ?? [];
}

/* ────────────────────────────────────────────────────────────────────────────
 * The happy path
 * ──────────────────────────────────────────────────────────────────────────── */

describe("end to end: a request becomes an installed, enabled, recorded mod", () => {
	test("the whole chain, over a real socket, with a real signature", async () => {
		daemon = await startDaemon(generateForReal);
		await boot();

		await askFor();

		// ── the review gate opens, and nothing has been written yet ──────────────
		const review = await until("the review modal to open", () => modalWith("modkit-review"));
		assert.deepEqual(
			installedFiles(),
			[],
			"the review must open BEFORE the first byte is written — otherwise Cancel would be an undo",
		);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);

		// What it shows must be answerable without opening a file: the user's own sentence, and the
		// whole source verbatim — not a summary, which is what a hostile patch would get right.
		const shown = review.contentEl.querySelectorAll("div").map((d) => d.textContent);
		assert.ok(shown.includes(REQUEST), "the review must show the request the user actually typed");

		const blocks = findAll(review.contentEl, (el) => el.tagName === "pre" && el.hasClass("modkit-review__source"));
		assert.equal(blocks.length, 1, "the review must show exactly one source block");
		assert.equal(
			blocks[0].querySelector("code").textContent,
			MOD_BUNDLE,
			"the review must show the bytes that would run, verbatim — not a summary of them",
		);
		assert.ok(
			shown.some((t) => t.includes(sha256(MOD_BUNDLE).slice(0, 12))),
			"the review must show the digest the daemon signed, so it is checkable against the file",
		);
		assert.equal(
			dom.document.activeElement?.textContent,
			"Not this",
			"the safe answer must hold focus — Return and Space must not run generated code",
		);

		// ── approve ─────────────────────────────────────────────────────────────
		click(review.contentEl, "Install and turn it on");

		await until("the mod to be enabled", () => app.plugins.enabledPlugins.has(MOD_ID));
		await tick(20);

		// ── it is on disk, byte for byte ────────────────────────────────────────
		assert.deepEqual(installedFiles(), [modPath("main.js"), modPath("manifest.json")]);
		const written = await app.vault.adapter.read(modPath("main.js"));
		assert.equal(written, MOD_BUNDLE, "the installed bytes must be the signed bytes");
		assert.equal(sha256(written), sha256(MOD_BUNDLE));
		const writtenManifest = JSON.parse(await app.vault.adapter.read(modPath("manifest.json")));
		assert.equal(writtenManifest.id, MOD_ID);

		// ── Obsidian loaded it ──────────────────────────────────────────────────
		assert.ok(app.plugins.plugins[MOD_ID], "the mod is enabled but the host has no instance of it");

		// ── the ledger records the intent, not the code ─────────────────────────
		const record = await until("the ledger record to be written", () => ledger().find((m) => m.modId === MOD_ID));
		assert.equal(record.request, REQUEST, "the ledger keeps the request — that is what a regenerate re-runs");
		assert.equal(record.target.pluginId, TARGET_ID);
		assert.equal(record.reach.plane, "C");
		assert.equal(record.generator.daemonVersion, "0.1.0");

		// ── and the daemon really was asked ─────────────────────────────────────
		assert.equal(daemon.runs.length, 1, "the daemon's pipeline should have run exactly once");
		assert.equal(daemon.runs[0].kind, "generate");
		assert.equal(daemon.runs[0].request.request, REQUEST);
		const posts = daemon.wire.filter((w) => w.method === "POST");
		assert.equal(posts.length, 1);
		assert.equal(posts[0].path, "/v1/generate");
		assert.match(posts[0].authorization, /^Bearer /, "the client must present the bearer token");
		assert.ok(
			daemon.wire.some((w) => w.path.startsWith("/v1/jobs/") && w.status === 200),
			"the client must have polled the job to completion",
		);
	});

	test("“Enable a mod once it is installed” off installs it and leaves it off", async () => {
		daemon = await startDaemon(generateForReal);
		await boot({ autoEnableGeneratedMods: false });

		await askFor();
		const review = await until("the review modal", () => modalWith("modkit-review"));
		// The button must promise what it will actually do.
		click(review.contentEl, "Install, leave it off");

		await until("the mod to be written", () => installedFiles().length === 2);
		await until("the mod to be switched off again", () => !app.plugins.enabledPlugins.has(MOD_ID));
		// The ledger write is a `data.json` transaction that settles after the enable/disable pair,
		// so it is waited for rather than read on the same turn.
		await until(
			"the ledger record for a mod that was left switched off",
			() => ledger().find((m) => m.modId === MOD_ID),
			{ timeoutMs: 3_000 },
		);
		assert.equal(
			app.plugins.enabledPlugins.has(MOD_ID),
			false,
			"the setting says leave it off, so it must end up off",
		);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The three paths that must not install
 * ──────────────────────────────────────────────────────────────────────────── */

describe("end to end: nothing is written when it should not be", () => {
	test("a refusal is the product working — no files, no ledger, no error framing", async () => {
		daemon = await startDaemon(async () => ({
			kind: "refused",
			reason: "unsafe-request",
			message: "That would need to send the contents of your vault to a third-party server.",
		}));
		await boot();

		await askFor("upload all my notes somewhere");

		await until("the daemon to refuse", () => daemon.runs.length === 1);
		await tick(1200); // let the poll settle the job and the surface render it

		assert.deepEqual(installedFiles(), [], "a refusal must not write anything");
		assert.deepEqual(ledger(), [], "a refusal must not leave a ledger record");
		assert.equal(modalWith("modkit-review"), null, "a refusal must never reach the review gate");
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
	});

	test("fail-closed, outer ring: a key mismatch is caught at submit, before a model is paid for", async () => {
		// Discovered by writing this test: the daemon checks `pinnedRootPubkey` on the request itself
		// and answers 400. So a vault pinned to the wrong key never reaches generation at all — the
		// cheapest possible place to fail, and one nothing else in the suite covers.
		daemon = await startDaemon(generateForReal);
		const flipped = (daemon.rootPubkeyHex[0] === "0" ? "1" : "0") + daemon.rootPubkeyHex.slice(1);
		assert.match(flipped, /^[0-9a-f]{64}$/, "the pinned key must stay well-formed — this is not a paste error");
		await boot({ daemonPubkey: flipped });

		await askFor();
		await until("the daemon to answer the submit", () => daemon.wire.some((w) => w.method === "POST"));
		await tick(300);

		assert.equal(daemon.runs.length, 0, "a key mismatch must not buy a model call");
		assert.equal(daemon.wire.find((w) => w.method === "POST").status, 400);
		assert.deepEqual(installedFiles(), []);
		assert.deepEqual(ledger(), []);
		assert.equal(modalWith("modkit-review"), null);
		assert.ok(
			Notice.messages().some((m) => /pinned a different modkit root key/i.test(m)),
			`the user must be told which side is wrong; notices were ${JSON.stringify(Notice.messages())}`,
		);
	});

	test("fail-closed, inner ring: an artifact signed by an unpinned key is refused by the plugin", async () => {
		// The outer ring above is the daemon being cooperative. This one models it not being: the
		// daemon advertises — and accepts a pin for — the key the vault trusts, and then returns an
		// artifact signed by an entirely different keyring. That is the shape a swapped artifact or a
		// compromised signer has, and the pinned key is the only thing standing in front of it.
		const impostor = mintKeyring();
		try {
			daemon = await startDaemon(generateForReal, {
				signKeyring: impostor.keyring,
			});
			assert.notEqual(
				impostor.keyring.rootPubkeyHex,
				daemon.rootPubkeyHex,
				"the two keyrings must genuinely differ or this test proves nothing",
			);
			// The vault pins the daemon's advertised key, exactly as pairing would have set it.
			await boot();

			await askFor();
			await until("the daemon to build and sign", () => daemon.runs.length === 1);
			await tick(1500);

			assert.equal(modalWith("modkit-review"), null, "verification must fail BEFORE the review gate");
			assert.deepEqual(installedFiles(), [], "a mod whose signature does not verify must not be written");
			assert.deepEqual(ledger(), []);
			assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
			assert.equal(
				Object.hasOwn(app.plugins.plugins, MOD_ID),
				false,
				"nothing may be enabled off an artifact that failed verification",
			);
			assert.ok(
				Notice.messages().some((m) => /refused|signature|certificate/i.test(m)),
				`the refusal must be visible; notices were ${JSON.stringify(Notice.messages())}`,
			);
		} finally {
			impostor.cleanup();
		}
	});

	test("cancelling the review writes nothing at all", async () => {
		daemon = await startDaemon(generateForReal);
		await boot();

		await askFor();
		const review = await until("the review modal", () => modalWith("modkit-review"));
		click(review.contentEl, "Not this");
		await tick(50);

		assert.deepEqual(installedFiles(), [], "Cancel must not be an undo — nothing may have been written");
		assert.deepEqual(ledger(), []);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
		assert.ok(
			Notice.messages().some((m) => /Nothing was written/i.test(m)),
			`the user must be told plainly; notices were ${JSON.stringify(Notice.messages())}`,
		);
	});

	test("dismissing the review (escape / click outside) is a NO, not a yes", async () => {
		// `onClose` without a decision must resolve to false. Silence is not approval.
		daemon = await startDaemon(generateForReal);
		await boot();

		await askFor();
		const review = await until("the review modal", () => modalWith("modkit-review"));
		review.close();
		await tick(50);

		assert.deepEqual(installedFiles(), []);
		assert.deepEqual(ledger(), []);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * And then it runs
 *
 * Everything above stops at "Obsidian enabled it", because the host stub never evaluates a plugin's
 * `main.js`. This is the last step: take the bytes modkit actually wrote into the vault, evaluate
 * them the way Obsidian would, and ask whether the mod patched its target, reported its health back
 * to modkit, and gave the target back on unload.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Evaluate an installed mod's `main.js` as CommonJS, with `require("obsidian")` answered. */
function evaluateMod(code, path) {
	const module = { exports: {} };
	const wrapper = vm.runInThisContext(
		`(function (exports, require, module, __filename, __dirname) {\n${code}\n})`,
		{ filename: path },
	);
	wrapper(module.exports, (id) => {
		if (id === "obsidian") return obsidianStub;
		throw new Error(`the generated mod asked its host for "${id}"`);
	}, module, path, path.replace(/\/[^/]+$/, ""));
	return module.exports.default ?? module.exports;
}

describe("end to end: the installed mod actually patches its target", () => {
	test("it applies, counts invocations, reports health to modkit, and gives the target back", async () => {
		daemon = await startDaemon(generateForReal);
		await boot();

		// A target with a real prototype method to patch. The default stub "loaded plugin" is an
		// object literal, whose constructor is `Object` — patching that prototype would be a bug in
		// the test, not a test of the mod.
		class TasksPlugin {
			constructor(manifest) {
				this._loaded = true;
				this.manifest = manifest;
				this.onloadCalls = 0;
			}
		}
		let originalRan = 0;
		TasksPlugin.prototype.onload = function onload() {
			originalRan += 1;
			return "tasks-onload";
		};
		const pristine = TasksPlugin.prototype.onload;
		app.plugins.plugins[TARGET_ID] = new TasksPlugin(app.plugins.manifests[TARGET_ID]);
		// Obsidian puts every live plugin here, modkit included — it is how a mod finds the health sink.
		app.plugins.plugins["modkit"] = plugin;

		await askFor();
		const review = await until("the review modal", () => modalWith("modkit-review"));
		click(review.contentEl, "Install and turn it on");
		await until("the mod to be enabled", () => app.plugins.enabledPlugins.has(MOD_ID));

		// ── evaluate what was actually written ──────────────────────────────────
		const code = await app.vault.adapter.read(modPath("main.js"));
		const ModClass = evaluateMod(code, modPath("main.js"));
		assert.equal(typeof ModClass, "function", "the generated main.js must default-export a class");

		const mod = new ModClass(app, MOD_MANIFEST);
		await mod.load();
		await tick(5);

		// ── it applied ──────────────────────────────────────────────────────────
		const status = mod.modkitStatus();
		assert.equal(status.state, "applied", `the mod did not apply: ${JSON.stringify(status)}`);
		assert.equal(status.targetVersionSeen, "7.4.0", "the mod must record the version it actually saw");
		assert.notEqual(TasksPlugin.prototype.onload, pristine, "the prototype method was never replaced");

		// ── and the patch is on the call path ───────────────────────────────────
		const result = app.plugins.plugins[TARGET_ID].onload();
		assert.equal(result, "tasks-onload", "the wrapper must return the target's own result");
		assert.equal(originalRan, 1, "the target's original method must still run");
		assert.equal(mod.modkitStatus().invocations, 1, "the mod must have counted the call it wrapped");

		// ── health reached modkit, through the same optional chain a synced mod uses ──
		const health = await until(
			"modkit to record the mod's health",
			() => ledger().find((m) => m.modId === MOD_ID)?.health,
			{ timeoutMs: 3_000 },
		);
		assert.equal(health.state, "applied");

		// ── and unload gives the target back, byte for byte ─────────────────────
		mod.unload();
		assert.equal(
			TasksPlugin.prototype.onload,
			pristine,
			"unload must restore the target's own method — this is the whole reclaim contract",
		);
		originalRan = 0;
		app.plugins.plugins[TARGET_ID].onload();
		assert.equal(originalRan, 1);
		assert.equal(mod.modkitStatus().invocations, 1, "the removed wrapper must not still be counting");
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The review gate itself
 * ──────────────────────────────────────────────────────────────────────────── */

describe("end to end: the review gate can be switched off, and then it is", () => {
	test("with reviewBeforeEnable off, the mod installs with no modal", async () => {
		// Not an endorsement of the setting — an assertion that the gate is *wired to the setting*
		// rather than to something else, which is exactly the defect the gate was added to fix.
		daemon = await startDaemon(generateForReal);
		await boot({ reviewBeforeEnable: false });

		await askFor();
		await until("the mod to be enabled", () => app.plugins.enabledPlugins.has(MOD_ID));

		assert.equal(modalWith("modkit-review"), null, "the review must not open when the setting is off");
		assert.deepEqual(installedFiles(), [modPath("main.js"), modPath("manifest.json")]);
	});
});
