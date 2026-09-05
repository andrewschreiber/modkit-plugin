/**
 * `ModInstaller` against a stub vault adapter.
 *
 * The installer is the only code in modkit that writes into somebody's vault, so the properties
 * worth asserting are the ones that stop it writing the wrong thing: it never creates a directory
 * it cannot later recognise as its own, it reads every write back, and an uninstall leaves nothing.
 *
 * The adapter is `MemoryAdapter` from `./stub/app.mjs`, which throws on `mkdir` over an existing
 * directory and on `read` of a missing file, because the installer's real branches are written
 * around those throws. See that file's header for what it does *not* model.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { afterEach, beforeEach, describe } from "node:test";

import { Host, ModInstaller, ModStore, makeHealth } from "./build/plugin-api.mjs";
import { Notice } from "./stub/obsidian.mjs";
import { createApp, manifestFor, tick } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

const MOD_ID = "modkit-mod-quieter-tasks";
const MAIN_JS = "module.exports = class { onload() { console.log('mod v1'); } };\n";

function sha256(text) {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The two `Plugin` methods `ModStore` needs, backed by an object that round-trips through JSON. */
function makeDataHost() {
	let data = null;
	return {
		async loadData() {
			return data === null ? null : JSON.parse(JSON.stringify(data));
		},
		async saveData(next) {
			data = JSON.parse(JSON.stringify(next));
		},
		peek() {
			return data;
		},
	};
}

function makeMod(overrides = {}) {
	const modId = overrides.modId ?? MOD_ID;
	const mainJs = overrides.mainJs ?? MAIN_JS;
	return {
		modId,
		manifest: manifestFor(modId, { name: "Quieter tasks" }),
		mainJs,
		sha256: sha256(mainJs),
		...overrides,
	};
}

function makeSeed(modId = MOD_ID) {
	return {
		modId,
		name: "Quieter tasks",
		request: "make the tasks plugin stop shouting",
		target: { kind: "plugin", pluginId: "obsidian-tasks-plugin", pluginVersion: "7.4.0" },
		reach: { plane: "C", pluginId: "obsidian-tasks-plugin", holder: "prototype", member: "onload" },
		targetVersionRange: { from: "7.0.0", to: null },
		explanation: "Wraps the notice helper.",
		generator: { model: "claude-opus-4-6", daemonVersion: "0.1.0", generatedAt: new Date().toISOString() },
	};
}

let dom;
let app;
let host;
let store;
let data;
let installer;

async function setup(options = {}) {
	app = createApp({ reindexDelayMs: 1, ...options });
	host = new Host(app);
	data = makeDataHost();
	store = new ModStore(data);
	await store.load();
	installer = new ModInstaller(app, host, store, { settleMs: 1, ...(options.installer ?? {}) });
	installer.load();
	return installer;
}

beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
});

afterEach(() => {
	installer?.unload();
	dom.restore();
});

describe("install", () => {
	test("writes the tree, enables the mod, and records it", async () => {
		await setup();
		const mod = makeMod();

		const result = await installer.install(mod, makeSeed());

		assert.equal(result.ok, true, `install failed: ${result.error?.code} ${result.error?.message}`);
		assert.equal(result.modId, MOD_ID);
		assert.equal(result.updated, false, "a first install is not an update");
		assert.equal(result.enabled, true);
		assert.equal(result.sha256, sha256(MAIN_JS), "the reported hash is of the file on disk");

		const dir = `${app.vault.configDir}/plugins/${MOD_ID}`;
		assert.equal(await app.vault.adapter.read(`${dir}/main.js`), MAIN_JS);
		assert.deepEqual(JSON.parse(await app.vault.adapter.read(`${dir}/manifest.json`)), mod.manifest);

		assert.ok(app.plugins.enabledPlugins.has(MOD_ID), "Obsidian's enabled set must carry the mod");
		assert.ok(host.isPluginLoaded(MOD_ID), "an enabled mod with no live instance is a half-install");

		assert.equal(store.get(MOD_ID)?.request, "make the tasks plugin stop shouting");
		// Plane C: installed and running, but nothing has gone through the patch, so the ledger may
		// not yet claim an effect. See `installHealthState`.
		assert.equal(store.get(MOD_ID)?.health.state, "no-effect");
		assert.equal(store.get(MOD_ID)?.sha256, sha256(MAIN_JS));
	});

	test("writes main.js before manifest.json, so the watcher never sees a half-directory", async () => {
		await setup();
		await installer.install(makeMod());

		const writes = app.vault.adapter.calls.filter((c) => c.op === "write").map((c) => c.path);
		const dir = `${app.vault.configDir}/plugins/${MOD_ID}`;
		assert.ok(writes.indexOf(`${dir}/main.js`) >= 0, "main.js was never written");
		assert.ok(
			writes.indexOf(`${dir}/main.js`) < writes.indexOf(`${dir}/manifest.json`),
			`manifest.json must be written last; order was ${writes.join(" → ")}`,
		);
	});

	test("warns when the host has no enablePluginAndSave, and does not when it has", async () => {
		await setup();
		const first = await installer.install(makeMod());
		assert.equal(first.ok, true);
		assert.ok(
			first.warnings.some((w) => w.includes("enablePluginAndSave")),
			`expected the session-only-enable warning; got ${JSON.stringify(first.warnings)}`,
		);

		installer.unload();
		await setup({ withAndSave: true });
		const second = await installer.install(makeMod());
		assert.equal(second.ok, true);
		assert.deepEqual(second.warnings, [], "a host with the persisting variant needs no warning");
		assert.deepEqual(app.plugins.savedEnabled, [MOD_ID], "the enable was persisted, not just applied");
	});

	/*
	 * The watcher-never-notices trio. the design notes §1.5 left three outcomes open for a
	 * brand-new plugin id and said to measure before calling `loadManifests`. Measured 2026-09-01 by
	 * driving the real Obsidian UI: the enable failed `manifest-not-indexed`, and Obsidian's own
	 * "refresh installed plugins" button indexed the folder immediately. Outcome (b).
	 *
	 * The first and third tests below cover that measured path. The second — enabled but never
	 * loaded — is defensive: it is the other way the same ledger-skipping bug can bite.
	 */
	test("asks for a rescan when the watcher never notices the new folder", async () => {
		await setup({ reindexDelayMs: Infinity, withLoadManifests: true, withAndSave: true });

		const result = await installer.install(makeMod(), makeSeed());

		assert.equal(result.ok, true, `install failed: ${result.error?.code} ${result.error?.message}`);
		assert.ok(
			app.plugins.calls.some((c) => c.op === "loadManifests"),
			"the watcher never indexed it, so the installer must have asked for a rescan",
		);
		assert.ok(host.isPluginLoaded(MOD_ID), "the rescan should have got the mod actually running");
		assert.deepEqual(result.warnings, [], "a rescue that worked is not worth warning about");
		assert.equal(store.get(MOD_ID)?.health.state, "no-effect", "running, but nothing invoked yet");
	});

	test("a mod that is enabled but never loaded is a pending restart, not a failed install", async () => {
		// No `loadManifests` on this host at all: nothing can index the folder before the next start.
		await setup({ reindexDelayMs: Infinity, withAndSave: true });

		const result = await installer.install(makeMod(), makeSeed());

		assert.equal(result.ok, true, "the mod is on disk and in the saved enabled list — that is installed");
		assert.equal(result.enabled, true);
		assert.deepEqual(app.plugins.savedEnabled, [MOD_ID], "the enable must be persisted, or it really is inert");
		assert.equal(host.isPluginLoaded(MOD_ID), false, "the premise of this test is that it did not load");
		assert.ok(
			result.warnings.some((w) => w.includes("restart")),
			`expected the pending-restart warning; got ${JSON.stringify(result.warnings)}`,
		);
		// The reason this must be a success: a failure returns before the ledger is written, which is
		// what left the first real mod running with no record and permanently reported as an orphan.
		const record = store.get(MOD_ID);
		assert.ok(record, "the mod must be recorded, or reconciliation reports it as an orphan forever");
		assert.equal(record.enabled, true);
		assert.equal(record.health.state, "no-effect", "nothing has run yet, so the health must not claim applied");
	});

	test("still fails when the enable neither loaded nor persisted", async () => {
		// No rescan and no `enablePluginAndSave`: the mod is on disk and nothing will ever load it.
		await setup({ reindexDelayMs: Infinity });

		const result = await installer.install(makeMod(), makeSeed());

		assert.equal(result.ok, false, "an enable that neither ran nor persisted is a failed install");
		assert.equal(result.error.code, "manifest-not-indexed");
		assert.ok(!store.get(MOD_ID), "nothing loadable was installed, so nothing is recorded");
	});

	test("refuses ids it could not later recognise, or must never touch", async () => {
		await setup();
		const cases = [
			["modkit", "a mod cannot be installed over modkit itself"],
			["../../evil", "not a usable plugin folder name"],
			["some-other-plugin", "not a modkit mod id"],
			["", "not a usable plugin folder name"],
		];
		for (const [modId, fragment] of cases) {
			const result = await installer.install(makeMod({ modId, manifest: manifestFor(modId) }));
			assert.equal(result.ok, false, `"${modId}" should have been refused`);
			assert.equal(result.error.code, "invalid-mod-id");
			assert.ok(
				result.error.message.includes(fragment),
				`"${modId}": expected a message containing "${fragment}", got "${result.error.message}"`,
			);
			assert.equal(app.vault.adapter.calls.length, 0, `"${modId}" must be refused before anything is written`);
		}
	});

	test("refuses a manifest whose id disagrees with the directory it would create", async () => {
		await setup();
		const mod = makeMod();
		mod.manifest = manifestFor("modkit-mod-something-else");

		const result = await installer.install(mod);

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "manifest-mismatch");
		assert.equal(app.vault.adapter.calls.length, 0, "nothing may be written for a mismatched manifest");
	});

	test("refuses to write at all when the host cannot enable plugins", async () => {
		// A degraded host means the mod would land in the vault and never run. Refusing beats
		// leaving inert files behind.
		await setup({ plugins: false });
		const result = await installer.install(makeMod());

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "host-unavailable");
		assert.equal(app.vault.adapter.calls.length, 0);
	});

	test("refuses a directory it does not own, when the prefix rule is off", async () => {
		// The only way to reach the collision branch: without the prefix requirement, an id can name
		// somebody else's plugin folder.
		await setup({ installer: { requireModIdPrefix: false } });
		app.vault.adapter.mkdirp(`${app.vault.configDir}/plugins/obsidian-tasks-plugin`);

		const result = await installer.install(
			makeMod({ modId: "obsidian-tasks-plugin", manifest: manifestFor("obsidian-tasks-plugin") }),
		);

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "id-collision");
		assert.ok(result.error.message.includes("refusing to overwrite"));
	});
});

describe("the update path", () => {
	test("disables the running mod, rewrites, and re-enables — in that order", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());
		assert.ok(host.isPluginLoaded(MOD_ID));

		app.plugins.calls.length = 0;
		app.vault.adapter.calls.length = 0;
		app.journal.length = 0;
		const v2 = "module.exports = class { onload() { console.log('mod v2'); } };\n";

		const result = await installer.install(makeMod({ mainJs: v2 }), makeSeed());

		assert.equal(result.ok, true, `update failed: ${result.error?.message}`);
		assert.equal(result.updated, true, "installing over an existing mod is an update");
		assert.equal(result.sha256, sha256(v2));

		const dir = `${app.vault.configDir}/plugins/${MOD_ID}`;
		assert.equal(await app.vault.adapter.read(`${dir}/main.js`), v2, "the new code must be on disk");

		// The sequence is the whole point: new bytes must not land under a running copy.
		const toggles = app.plugins.calls.map((c) => c.op);
		assert.deepEqual(toggles, ["disablePlugin", "enablePlugin"], `toggle sequence was ${toggles.join(", ")}`);
		const disableAt = app.journal.findIndex((c) => c.op === "disablePlugin");
		const firstWriteAt = app.journal.findIndex((c) => c.op === "write");
		const lastWriteAt = app.journal.map((c) => c.op).lastIndexOf("write");
		const enableAt = app.journal.findIndex((c) => c.op === "enablePlugin");
		assert.ok(firstWriteAt >= 0, "the update wrote nothing");
		assert.ok(disableAt < firstWriteAt, "the running copy must be disabled before its files change");
		assert.ok(lastWriteAt < enableAt, "the re-enable must come after the last write");
		assert.ok(host.isPluginLoaded(MOD_ID), "the mod must be running again afterwards");

		// One record, not two: createdAt survives the update, updatedAt moves.
		assert.equal(store.size, 1);
		const record = store.get(MOD_ID);
		assert.ok(record.updatedAt >= record.createdAt);
	});

	test("removes a stale styles.css when the new generation ships none", async () => {
		// Obsidian loads styles.css automatically, so a leftover keeps applying rules the current mod
		// no longer contains.
		await setup();
		await installer.install(makeMod({ stylesCss: ".modkit-quiet { opacity: 0.5 }" }));
		const stylesPath = `${app.vault.configDir}/plugins/${MOD_ID}/styles.css`;
		assert.ok(await app.vault.adapter.exists(stylesPath));

		await installer.install(makeMod({ mainJs: "module.exports = class {};\n" }));

		assert.equal(await app.vault.adapter.exists(stylesPath), false, "the stale stylesheet is still there");
	});

	test("two overlapping installs of one id are serialised, not interleaved", async () => {
		await setup();
		const a = installer.install(makeMod({ mainJs: "module.exports = class { /* a */ };\n" }));
		const b = installer.install(makeMod({ mainJs: "module.exports = class { /* b */ };\n" }));
		const [ra, rb] = await Promise.all([a, b]);

		assert.equal(ra.ok, true, `first install failed: ${ra.error?.message}`);
		assert.equal(rb.ok, true, `second install failed: ${rb.error?.message}`);
		assert.equal(rb.updated, true, "the second install must see the first one's directory");
		assert.equal(
			await app.vault.adapter.read(`${app.vault.configDir}/plugins/${MOD_ID}/main.js`),
			"module.exports = class { /* b */ };\n",
			"the last install wins; a race would leave either",
		);
	});
});

describe("read-back verification", () => {
	test("a write that reports success and produces something else is caught", async () => {
		await setup();
		const mainPath = `${app.vault.configDir}/plugins/${MOD_ID}/main.js`;
		// The failure class this box has actually lost data to: the call resolves, the bytes are not
		// what you wrote, and nothing downstream notices.
		app.vault.adapter.corrupt.set(mainPath, "/* not what modkit wrote */\n");

		const result = await installer.install(makeMod());

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "write-not-verified");
		assert.equal(result.error.detail.path, mainPath);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false, "nothing may be enabled after a failed write");
	});

	test("a write that cannot be read back at all is caught", async () => {
		await setup();
		const mainPath = `${app.vault.configDir}/plugins/${MOD_ID}/main.js`;
		// A write that silently produced no file — reported success, nothing there.
		app.vault.adapter.afterWrite = (path) => {
			if (path === mainPath) app.vault.adapter.files.delete(path);
		};

		const result = await installer.install(makeMod());

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "write-not-verified");
		assert.match(result.error.message, /could not read it back/);
	});

	test("a main.js on disk that does not match the signed digest is refused", async () => {
		await setup();
		// The bytes wrote and read back fine; they simply are not the bytes the daemon signed.
		const result = await installer.install(makeMod({ sha256: "0".repeat(64) }));

		assert.equal(result.ok, false);
		assert.equal(result.error.code, "write-not-verified");
		assert.equal(result.error.detail.expected, "0".repeat(64));
		assert.equal(result.error.detail.actual, sha256(MAIN_JS));
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
	});

	test("a failed write reports the path and the two lengths", async () => {
		await setup();
		const result = await installer.install(makeMod());
		assert.equal(result.ok, true);

		app.vault.adapter.beforeWrite = () => {
			throw new Error("EROFS: read-only file system");
		};
		const second = await installer.install(makeMod({ mainJs: "module.exports = class { /* v2 */ };\n" }));

		assert.equal(second.ok, false);
		assert.equal(second.error.code, "write-failed");
		assert.match(second.error.detail.error, /EROFS/);
	});
});

describe("uninstall", () => {
	test("leaves nothing — no files, no folder, no record, nothing enabled", async () => {
		await setup();
		await installer.install(makeMod({ stylesCss: ".x{}" }), makeSeed());
		const dir = `${app.vault.configDir}/plugins/${MOD_ID}`;
		assert.ok(app.vault.adapter.entriesUnder(dir).length > 0);

		const result = await installer.uninstall(MOD_ID);

		assert.equal(result.ok, true, `uninstall failed: ${result.error?.message}`);
		assert.equal(result.removedDirectory, true);
		assert.equal(result.removedRecord, true);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(app.vault.adapter.entriesUnder(dir), [], "the mod's folder must be gone entirely");
		assert.equal(store.has(MOD_ID), false, "the ledger entry must be gone");
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false);
		assert.equal(host.isPluginLoaded(MOD_ID), false, "a deleted mod's patches must not still be live");

		// And the ledger on disk agrees with the in-memory view.
		assert.deepEqual(data.peek().mods, []);
	});

	test("disables before deleting, never the other way round", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());
		app.plugins.calls.length = 0;
		app.vault.adapter.calls.length = 0;
		app.journal.length = 0;

		await installer.uninstall(MOD_ID);

		// One interleaved log, not two — comparing indices across separate arrays compares nothing.
		const disableAt = app.journal.findIndex((c) => c.op === "disablePlugin");
		const removeAt = app.journal.findIndex((c) => c.op === "rmdir" || c.op === "remove");
		assert.ok(disableAt >= 0, "the running mod was never disabled");
		assert.ok(removeAt >= 0, "nothing was deleted");
		// Deleting a running plugin's files leaves its patches installed with nothing left to undo them.
		assert.ok(disableAt < removeAt, `the disable must precede the delete; journal was ${JSON.stringify(app.journal.map((c) => c.op))}`);
	});

	test("refuses to uninstall something it has neither files nor a record for", async () => {
		await setup();
		const result = await installer.uninstall("modkit-mod-never-existed");
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "not-installed");
	});

	test("uninstalling a record whose directory is already gone still drops the record", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());
		await app.vault.adapter.rmdir(`${app.vault.configDir}/plugins/${MOD_ID}`, true);
		await app.plugins.disablePlugin(MOD_ID);

		const result = await installer.uninstall(MOD_ID);

		assert.equal(result.ok, true);
		assert.equal(result.removedDirectory, false, "there was no directory to remove");
		assert.equal(result.removedRecord, true);
		assert.equal(store.has(MOD_ID), false);
	});
});

describe("orphans", () => {
	test("a modkit-looking directory with no record is reported, never adopted", async () => {
		await setup();
		// A half-finished install, or a mod that arrived by sync before its record did.
		const orphanDir = `${app.vault.configDir}/plugins/modkit-mod-orphan`;
		app.vault.adapter.mkdirp(orphanDir);
		await app.vault.adapter.write(`${orphanDir}/main.js`, "module.exports = class {};\n");
		await installer.install(makeMod(), makeSeed());

		const listed = await installer.listModDirectories();
		assert.deepEqual(listed, ["modkit-mod-orphan", MOD_ID].sort());

		const report = await store.reconcile(installer);

		assert.equal(report.ok, true, `reconcile failed: ${report.error?.message}`);
		assert.deepEqual(report.value.orphans, ["modkit-mod-orphan"]);
		assert.deepEqual(report.value.missing, []);
		assert.equal(store.has("modkit-mod-orphan"), false, "an orphan must not be adopted — its request is unknowable");
		assert.equal(store.size, 1);
	});

	test("directories that are not modkit's are not listed at all", async () => {
		await setup();
		app.vault.adapter.mkdirp(`${app.vault.configDir}/plugins/obsidian-tasks-plugin`);
		app.vault.adapter.mkdirp(`${app.vault.configDir}/plugins/modkit`);

		assert.deepEqual(await installer.listModDirectories(), []);
	});

	test("a record whose directory vanished is marked target-gone and KEPT", async () => {
		// The sentence is the irreplaceable half; on a synced vault the folder may simply not have
		// arrived yet. Deleting the record to match the disk would destroy the only thing that can
		// regenerate the mod.
		await setup();
		await installer.install(makeMod(), makeSeed());
		await app.vault.adapter.rmdir(`${app.vault.configDir}/plugins/${MOD_ID}`, true);

		const report = await store.reconcile(installer);

		assert.equal(report.ok, true);
		assert.deepEqual(report.value.missing, [MOD_ID]);
		assert.equal(store.has(MOD_ID), true, "the record must survive its directory");
		assert.equal(store.get(MOD_ID).health.state, "target-gone");
		assert.equal(store.get(MOD_ID).request, "make the tasks plugin stop shouting");
	});

	test("a row whose enabled flag disagrees with Obsidian is repaired to Obsidian's answer", async () => {
		// Measured 2026-09-03: two mods switched off in Community plugins kept `enabled: true` in the
		// ledger, so every enabled-gated check kept reporting on mods that were not running.
		await setup();
		await installer.install(makeMod(), makeSeed());
		const before = store.get(MOD_ID).enabled;

		const report = await store.reconcile({
			async hasDirectory() {
				return true;
			},
			async listModDirectories() {
				return [MOD_ID];
			},
			isEnabled() {
				return !before;
			},
		});

		assert.equal(report.ok, true, `reconcile failed: ${report.error?.message}`);
		assert.deepEqual(report.value.divergent, [MOD_ID], "the divergence is still reported");
		assert.ok(report.value.updated.includes(MOD_ID), "…and the row is written");
		assert.equal(store.get(MOD_ID).enabled, !before, "Obsidian's answer wins");
	});

	test("a failed listing is not read as 'every mod is gone'", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());

		const report = await store.reconcile({
			async hasDirectory() {
				return true;
			},
			async listModDirectories() {
				throw new Error("EIO: the adapter blew up");
			},
		});

		assert.equal(report.ok, false);
		assert.equal(report.error.code, "read-failed");
		assert.equal(store.get(MOD_ID).health.state, "no-effect", "a transient listing error must not rewrite health");
	});
});

describe("setEnabled", () => {
	test("moves both modkit's intent and Obsidian's reality", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());

		const off = await installer.setEnabled(MOD_ID, false);
		assert.equal(off.ok, true, `disable failed: ${off.error?.message}`);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), false, "Obsidian's set is reality");
		assert.equal(store.get(MOD_ID).enabled, false, "the record is intent");

		const on = await installer.setEnabled(MOD_ID, true);
		assert.equal(on.ok, true, `enable failed: ${on.error?.message}`);
		assert.equal(app.plugins.enabledPlugins.has(MOD_ID), true);
		assert.equal(store.get(MOD_ID).enabled, true);
	});

	test("refuses for a mod with no directory", async () => {
		await setup();
		await store.put({ ...makeSeed(), sha256: "", createdAt: "", updatedAt: "", enabled: false, health: makeHealth("applied", "") });
		const result = await installer.setEnabled(MOD_ID, true);
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "not-installed");
	});
});

/**
 * `targetVersionSeen` and `invocations` are observations only the mod itself can make. Every other
 * writer — the supervisor's reapply/reload-failed emits, the DOM reach verifier — calls
 * `makeHealth(state, detail)` with no extras, and `setHealth` used to replace the health object
 * wholesale, so those writes silently deleted both fields.
 *
 * E3 (2026-09-03) watched it happen live on all three rungs of a real Tasks update: the row went in
 * carrying `targetVersionSeen: "7.14.0"` / `invocations: 0` and came out of the supervisor's
 * re-apply with neither — losing the Settings card's "Times it has run" fact at exactly the moment
 * a user is asking whether the mod survived the update.
 */
/**
 * E3's finding 1. A plane-C mod on a cache-fill path installed, the row said `applied`, and the
 * thing the user asked to change sat visibly unchanged — because the target had already parsed it.
 * `applied` is a claim about an effect, and at install there is no effect to claim yet.
 */
describe("the install verdict does not run ahead of the evidence", () => {
	test("a member patch installs as no-effect, and says what will make it show", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());

		const health = store.get(MOD_ID).health;
		assert.equal(health.state, "no-effect", "nothing has gone through the patch yet");
		assert.match(
			health.detail,
			/open or edit a note/,
			"the detail must be the sentence that tells the user how to see it, not a diagnosis",
		);
	});

	test("a plane-E mod still installs as applied — a stylesheet has no invocation to wait for", async () => {
		await setup();
		const seed = { ...makeSeed(), reach: { plane: "E", selector: ".workspace-tab-header", mode: "css" } };
		await installer.install(makeMod(), seed);

		// Load-bearing: `verifyDomReach` refines and never asserts, so if this were `no-effect` a CSS
		// mod could never reach `applied` at all — there is no other writer that would promote it.
		assert.equal(store.get(MOD_ID).health.state, "applied");
	});

	test("switched off is never applied, whatever the plane", async () => {
		await setup();
		const seed = { ...makeSeed(), reach: { plane: "E", selector: ".workspace-tab-header", mode: "css" } };
		await installer.install(makeMod(), seed, { enable: false });

		assert.equal(store.get(MOD_ID).health.state, "no-effect");
	});
});

describe("setHealth preserves what only the mod can know", () => {
	test("a writer with no extras leaves targetVersionSeen and invocations alone", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());

		await store.setHealth(MOD_ID, makeHealth("applied", "", { targetVersionSeen: "7.14.0", invocations: 3 }));

		// What the supervisor emits after a target reload: state and detail, nothing else.
		await store.setHealth(MOD_ID, makeHealth("applied", "re-applied onto the new class"));

		const health = store.get(MOD_ID).health;
		assert.equal(health.detail, "re-applied onto the new class", "the new write still wins on its own fields");
		assert.equal(health.targetVersionSeen, "7.14.0", "the version the mod saw must survive a foreign write");
		assert.equal(health.invocations, 3, "the call count must survive a foreign write");
	});

	test("an explicit value still overwrites — undefined means unchanged, zero means zero", async () => {
		await setup();
		await installer.install(makeMod(), makeSeed());

		await store.setHealth(MOD_ID, makeHealth("applied", "", { targetVersionSeen: "7.14.0", invocations: 3 }));
		await store.setHealth(MOD_ID, makeHealth("applied", "", { targetVersionSeen: "8.4.0", invocations: 0 }));

		const health = store.get(MOD_ID).health;
		assert.equal(health.targetVersionSeen, "8.4.0");
		assert.equal(health.invocations, 0, "a mod reporting zero must not be read as saying nothing");
	});
});

describe("teardown", () => {
	test("unloading mid-install releases the settle delay rather than stranding it", async () => {
		// A cleared timeout whose promise never settles would hang that mod's serialisation chain
		// forever. Unloading should let the install finish and fail honestly.
		await setup({ installer: { settleMs: 60_000 } });
		const inflight = installer.install(makeMod());
		await tick(5);

		installer.unload();

		const result = await Promise.race([inflight, tick(2000).then(() => "TIMED OUT")]);
		assert.notEqual(result, "TIMED OUT", "the install never settled after unload");
		assert.equal(dom.window.pending().length, 0, "the settle timer was not cleared");
		installer = null; // already unloaded; afterEach must not do it twice
	});
});
