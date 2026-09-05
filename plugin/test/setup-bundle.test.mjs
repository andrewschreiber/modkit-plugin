/**
 * The daemon's sidecar file, consumed by **the artifact that is actually installed into the vault**.
 *
 * `sidecar.test.mjs` covers the same contract against `plugin/test/build/plugin-api.mjs` —
 * an esbuild bundle of the *source*, built by the test harness for the test harness. This file
 * covers `plugin/dist/main.js`: the 400 KB CommonJS file `scripts/install-to-vault.mjs` copies into
 * `.obsidian/plugins/modkit/`, loaded the way Obsidian loads it, driven through the real
 * `onload()`.
 *
 * ## Why both, when they assert nearly the same things
 *
 * Everything between `src/settings/settings.ts` and the file in the vault is esbuild configuration —
 * `treeShaking`, `external`, `format: "cjs"`, the sidecar path is reached only
 * through `Plugin.onload → new SettingsStore(this) → vaultOf(host) → tokenFileAt(vault)`, and
 * `vaultOf` finds the adapter by **duck-typing**, not by an import. Nothing in that chain is a
 * static reference a bundler can see, so nothing in that chain is protected by the source-level
 * suite: a tree-shake that dropped `tokenFileAt`, or an entry point that never constructed the
 * store, would leave every test in `sidecar.test.mjs` green and ship a plugin that silently
 * falls back to reading the token out of `data.json` — which is the one place the design says it
 * must never be.
 *
 * That failure is invisible in exactly the way this repo keeps rediscovering: no error, a settings
 * tab that looks right, and a credential quietly living in the file LiveSync's Customization sync
 * replicates to every device.
 *
 * ## The bytes are the daemon's, not this file's
 *
 * The sidecar is written by the daemon's own `writeSidecar()` into a real temp directory, and
 * those exact bytes are handed to the stub vault. A test that composed its own JSON here would
 * agree with itself forever while the two halves of the contract drifted apart — the same reason
 * `sign-verify.test.mjs` signs with the daemon's real `signArtifact`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { writeSidecar } from "../../packages/modkit-daemon/dist/sidecar.js";

import { loadBundle } from "./helpers/bundle.mjs";
import { Notice } from "./stub/obsidian.mjs";
import { createApp, manifestFor, tick } from "./stub/app.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

const MODKIT_MANIFEST = manifestFor("modkit", { name: "modkit", version: "0.1.0" });
/** `vaultOf` derives this from `configDir` + the manifest id when the manifest carries no `dir`. */
const PLUGIN_DIR = ".obsidian/plugins/modkit";
const SIDECAR = `${PLUGIN_DIR}/daemon-token.json`;

const TOKEN = `mk_${"z".repeat(43)}`;
const KEY = "3b07cac970871ecd99cbd3447b0e845b60fa723106b8a102d9624a1c5b443efe";

let dom;
let plugin;
let scratch;

beforeEach(() => {
	dom = installDomGlobals();
	Notice.reset();
	plugin = null;
	scratch = mkdtempSync(join(tmpdir(), "modkit-setup-bundle-"));
});

afterEach(() => {
	try {
		plugin?.unload();
	} catch {
		/* whatever went wrong has already been reported by an assertion */
	}
	dom.restore();
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * Produce a genuine sidecar with the daemon's writer and return its bytes.
 *
 * `writeSidecar` refuses any directory that is not an installed modkit plugin folder, so the
 * temp directory gets modkit's manifest first — which also means this exercises that refusal's
 * happy path against a real manifest rather than a mock.
 */
function daemonWrittenSidecar({ token = TOKEN, publicKeyHex = KEY, baseUrl = "http://127.0.0.1:8501" } = {}) {
	writeFileSync(join(scratch, "manifest.json"), JSON.stringify({ id: "modkit", version: "0.1.0" }));
	const result = writeSidecar(scratch, { token, publicKeyHex, baseUrl });
	return readFileSync(result.path, "utf8");
}

/** Load the shipped bundle and run its real `onload` over `app`. */
async function start(app) {
	const { exports } = loadBundle();
	const ModkitPlugin = exports.default;
	plugin = new ModkitPlugin(app, MODKIT_MANIFEST);
	await plugin.load();
	await tick(2);
	return plugin;
}

/** An app whose vault already holds `text` at the sidecar path. */
function appWithSidecar(text, { data = null } = {}) {
	const app = createApp();
	app.vault.adapter.mkdirp(PLUGIN_DIR);
	if (text !== null) app.vault.adapter.write(SIDECAR, text);
	if (data !== null) app.pluginData.set("modkit", data);
	return app;
}

describe("the shipped bundle consumes the daemon's sidecar", () => {
	test("reports paired, with the token and key from the FILE — never from data.json", async () => {
		// data.json carries a different, stale token and key. The record must win over both.
		const app = appWithSidecar(daemonWrittenSidecar(), {
			data: {
				protocol: "MODKIT/1",
				settings: { daemonToken: `mk_${"s".repeat(43)}`, daemonPubkey: "a".repeat(64) },
				mods: [],
			},
		});
		const p = await start(app);

		assert.equal(p.settingsStore.pairing.state, "paired");
		assert.equal(p.settingsStore.pairing.problem, null);
		assert.equal(p.settingsStore.settings.daemonToken, TOKEN, "the token must come from the sidecar");
		assert.equal(p.settingsStore.settings.daemonPubkey, KEY, "the pinned key must come from the sidecar");
		assert.equal(p.settingsStore.pairing.pinnedByPairing, true);
		assert.equal(p.settingsStore.tokenLocation.kind, "sidecar");
		assert.equal(p.settingsStore.tokenLocation.path, SIDECAR);
		assert.match(p.settingsStore.pairing.reason, /Written by modkit setup/);
	});

	test("the token never reaches data.json — the file LiveSync replicates", async () => {
		const app = appWithSidecar(daemonWrittenSidecar());
		await start(app);

		const persisted = JSON.stringify(app.pluginData.get("modkit") ?? {});
		assert.equal(persisted.includes(TOKEN), false, "the bearer token must not be persisted to data.json");
		// The pinned key is a public value and does belong in the settings blob.
		assert.equal(JSON.parse(persisted).settings.daemonPubkey, KEY);
	});

	test("a baseUrl the user chose is seeded but never stomped", async () => {
		const app = appWithSidecar(daemonWrittenSidecar({ baseUrl: "http://127.0.0.1:8501" }), {
			data: { protocol: "MODKIT/1", settings: { daemonBaseUrl: "http://mac-mini:8501" }, mods: [] },
		});
		const p = await start(app);
		assert.equal(p.settingsStore.settings.daemonBaseUrl, "http://mac-mini:8501");
		assert.equal(p.settingsStore.pairing.baseUrlSeeded, false);
	});
});

describe("a corrupt sidecar degrades to a named reason, and never throws", () => {
	/** Each case names the `problem` the plugin must report, and a phrase its sentence must carry. */
	const cases = [
		{
			what: "bad JSON",
			text: "{ this is not json",
			problem: "not-json",
			says: /not valid JSON/,
		},
		{
			what: "a version from a newer modkit",
			text: JSON.stringify({ version: 99, token: TOKEN, pinnedPublicKey: KEY }, null, 2),
			problem: "unsupported-version",
			says: /understands version 1/,
		},
		{
			what: "no token at all",
			text: JSON.stringify({ version: 1, pinnedPublicKey: KEY }, null, 2),
			problem: "no-token",
			says: /carries no token/,
		},
		{
			what: "an empty file",
			text: "   \n",
			problem: "not-json",
			says: /is empty/,
		},
		{
			what: "a JSON list rather than a record",
			text: "[1, 2, 3]",
			problem: "not-an-object",
			says: /holds a list/,
		},
		{
			what: "no file at all",
			text: null,
			problem: "absent",
			says: /No credentials at/,
		},
	];

	for (const c of cases) {
		test(`${c.what} → unpaired (${c.problem}), plugin still loads`, async () => {
			const app = appWithSidecar(c.text);
			// The bar is that `onload` survives: a plugin that throws here is uninstallable from
			// inside Obsidian, which is a far worse failure than "not paired".
			const p = await start(app);

			assert.equal(p.settingsStore.pairing.state, "unpaired");
			assert.equal(p.settingsStore.pairing.problem, c.problem);
			assert.equal(p.settingsStore.pairing.record, null);
			assert.match(p.settingsStore.pairing.reason, c.says);
			assert.equal(p.settingsStore.settings.daemonToken, "", "a corrupt record must not leave a token set");
			// And the settings tab has something concrete to show, rather than a silent no-op.
			assert.ok(
				p.settingsStore.pairing.reason.length > 20,
				"the reason must be a sentence a human can act on",
			);
		});
	}

	test("a missing pinned key costs the KEY, not the pairing — and is called out", async () => {
		// Deliberately not an "unpaired" state: the token still authenticates, so generation works
		// and only *verification* is impossible. Reporting this as "not paired" would send someone to
		// re-run pairing when what they actually need is a pinned key.
		const app = appWithSidecar(JSON.stringify({ version: 1, token: TOKEN }, null, 2));
		const p = await start(app);

		assert.equal(p.settingsStore.pairing.state, "paired");
		assert.equal(p.settingsStore.settings.daemonToken, TOKEN);
		assert.equal(p.settingsStore.pairing.pinnedByPairing, false);
		assert.equal(p.settingsStore.settings.daemonPubkey, "");
	});

	test("a pinned key that is not 64 hex is ignored, and says so", async () => {
		const app = appWithSidecar(
			JSON.stringify({ version: 1, token: TOKEN, pinnedPublicKey: "nope" }, null, 2),
		);
		const p = await start(app);

		assert.equal(p.settingsStore.pairing.state, "paired");
		assert.equal(p.settingsStore.settings.daemonPubkey, "");
		assert.match(p.settingsStore.pairing.reason, /not 64 hex characters/);
	});
});
