/**
 * The daemon's sidecar file, from the plugin's side.
 *
 * Two layers, and the split is deliberate:
 *
 * 1. **The pure half** — `parseSidecar` and `applyPairing`. The precedence rule (sidecar
 *    authoritative for the token and the pinned key; a *seed only* for the base URL) is a function,
 *    so it is tested as one. A rule that exists only inside a store method is a rule that has to be
 *    reproduced to be checked, and a reproduction agrees with itself.
 *
 * 2. **The real `SettingsStore` over the stub vault adapter.** `host-settings.test.mjs` says the
 *    store belongs to the end-to-end suite, and that is right for its `data.json` transactions — but
 *    the sidecar contract *is* a store-plus-adapter behaviour (read a second file, decide what it
 *    may override, write back only what belongs in `data.json`), and the lifecycle suite's real
 *    plugin has no sidecar in it to read. So these use the genuine class over the genuine
 *    `MemoryAdapter`, and never reach into its internals.
 *
 * The failure worth naming, because it is the one that is invisible when it happens: a phone
 * pointed at mac-mini over the tailnet, silently repointed at `127.0.0.1` by a pairing run on the
 * desktop box. Nothing errors, the settings tab shows a plausible URL, and generation simply stops
 * reaching the daemon that holds the vault's mods. Hence "baseUrl seeds, never stomps".
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

// The daemon's real writer, from its built `dist/` — the same reason `sign-verify.test.mjs` signs
// with the daemon's own `signArtifact`. A test that minted its own sidecar would agree with itself
// forever while the two sides drifted apart, and this file *is* the place the two sides meet.
import { writeSidecar } from "../../packages/modkit-daemon/dist/sidecar.js";

import {
	applyPairing,
	DEFAULT_DAEMON_BASE_URL,
	DEFAULT_SETTINGS,
	isSeedableBaseUrl,
	parseSidecar,
	settingsBlockers,
	SettingsStore,
	SIDECAR_VERSION,
	TOKEN_FILE_NAME,
} from "./build/plugin-api.mjs";
import { createApp } from "./stub/app.mjs";

const TOKEN = `mk_${"a".repeat(43)}`;
const KEY = "b".repeat(64);
const PLUGIN_DIR = ".obsidian/plugins/modkit";
const SIDECAR = `${PLUGIN_DIR}/${TOKEN_FILE_NAME}`;

function sidecarJson(overrides = {}) {
	return JSON.stringify(
		{
			_note: "modkit's credentials for this vault: this is a LIVE credential…",
			version: SIDECAR_VERSION,
			baseUrl: DEFAULT_DAEMON_BASE_URL,
			token: TOKEN,
			pinnedPublicKey: KEY,
			pairedAt: "2026-08-31T12:00:00.000Z",
			pairedBy: "modkit setup 0.1.0 on mac-mini",
			...overrides,
		},
		null,
		2,
	);
}

/**
 * A host shaped like the slice `SettingsStore` duck-types: `loadData`/`saveData` plus a vault and a
 * manifest. Deliberately not a real `Plugin` — the store's whole port is those four things.
 */
function createHost(app, { data = null, dir = PLUGIN_DIR } = {}) {
	app.vault.adapter.mkdirp(dir);
	let stored = data;
	return {
		app,
		manifest: { id: "modkit", dir },
		loadData: async () => (stored === null ? null : JSON.parse(JSON.stringify(stored))),
		saveData: async (next) => {
			stored = JSON.parse(JSON.stringify(next));
		},
		read: () => stored,
	};
}

/* ────────────────────────────────────────────────────────────────────────────
 * parseSidecar
 * ──────────────────────────────────────────────────────────────────────────── */

describe("parseSidecar", () => {
	test("reads the full contract and normalises the key", () => {
		const read = parseSidecar(sidecarJson({ pinnedPublicKey: KEY.toUpperCase() }), SIDECAR);
		assert.equal(read.state, "paired");
		assert.equal(read.problem, null);
		assert.equal(read.record.token, TOKEN);
		assert.equal(read.record.pinnedPublicKey, KEY, "an upper-case key must not be pinned as a different key");
		assert.equal(read.record.baseUrl, DEFAULT_DAEMON_BASE_URL);
		assert.equal(read.record.version, SIDECAR_VERSION);
		assert.match(read.reason, /modkit setup 0\.1\.0 on mac-mini/, "the tab should be able to say who wrote it");
	});

	test("a legacy hand-pasted file (daemonToken, no version) still pairs, and seeds nothing", () => {
		// A working install must not be unpaired by upgrading the plugin.
		const read = parseSidecar(JSON.stringify({ _note: "old", daemonToken: TOKEN }), SIDECAR);
		assert.equal(read.state, "paired");
		assert.equal(read.record.token, TOKEN);
		assert.equal(read.record.version, null);
		assert.equal(read.record.pinnedPublicKey, null);
		assert.equal(read.record.baseUrl, null);
	});

	test("every corrupt shape degrades to unpaired with its own reason, and none of them throw", () => {
		const cases = [
			["", "not-json", /empty/i],
			["   \n", "not-json", /empty/i],
			["{ not json", "not-json", /valid JSON/i],
			["[]", "not-an-object", /list/i],
			['"a string"', "not-an-object", /string/i],
			["null", "not-an-object", /object/i],
			[sidecarJson({ version: 2 }), "unsupported-version", /version 2/],
			[sidecarJson({ version: "one" }), "unsupported-version", /"one"/],
			[JSON.stringify({ version: SIDECAR_VERSION, pinnedPublicKey: KEY }), "no-token", /401/],
			[sidecarJson({ token: "   " }), "no-token", /no token/i],
		];
		for (const [text, problem, reasonRe] of cases) {
			const read = parseSidecar(text, SIDECAR);
			assert.equal(read.state, "unpaired", `expected ${JSON.stringify(text.slice(0, 24))} to be unpaired`);
			assert.equal(read.problem, problem, `wrong problem for ${JSON.stringify(text.slice(0, 24))}`);
			assert.equal(read.record, null);
			assert.match(read.reason, reasonRe);
			assert.match(read.reason, /daemon-token\.json/, "the reason must name the file the user has to fix");
		}
	});

	test("a bad pinned key costs the key, not the pairing", () => {
		// The token is still good; refusing the whole record would turn a cosmetic problem into a 401.
		const read = parseSidecar(sidecarJson({ pinnedPublicKey: "nope" }), SIDECAR);
		assert.equal(read.state, "paired");
		assert.equal(read.record.token, TOKEN);
		assert.equal(read.record.pinnedPublicKey, null);
		assert.match(read.reason, /not 64 hex characters/);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The precedence rule
 * ──────────────────────────────────────────────────────────────────────────── */

describe("applyPairing — precedence", () => {
	const record = { version: 1, baseUrl: DEFAULT_DAEMON_BASE_URL, token: TOKEN, pinnedPublicKey: KEY, pairedAt: null, pairedBy: null };

	test("no record changes nothing", () => {
		const stored = { ...DEFAULT_SETTINGS, daemonToken: "mk_typed", daemonPubkey: "c".repeat(64) };
		const applied = applyPairing(stored, null);
		assert.equal(applied.settings, stored, "the same object, not a copy that could drift");
		assert.deepEqual(applied.overrode, []);
		assert.equal(applied.pinnedByPairing, false);
	});

	test("the record wins for the token and the pinned key", () => {
		const applied = applyPairing({ ...DEFAULT_SETTINGS, daemonToken: "mk_stale", daemonPubkey: "c".repeat(64) }, record);
		assert.equal(applied.settings.daemonToken, TOKEN);
		assert.equal(applied.settings.daemonPubkey, KEY);
		assert.deepEqual(applied.overrode, ["daemonToken", "daemonPubkey"]);
		assert.equal(applied.pinnedByPairing, true);
	});

	test("the base URL seeds an unset field", () => {
		const record2 = { ...record, baseUrl: "http://mac-mini:8501" };
		for (const stored of ["", DEFAULT_DAEMON_BASE_URL]) {
			const applied = applyPairing({ ...DEFAULT_SETTINGS, daemonBaseUrl: stored }, record2);
			assert.equal(applied.settings.daemonBaseUrl, "http://mac-mini:8501", `from ${JSON.stringify(stored)}`);
			assert.equal(applied.baseUrlSeeded, true);
		}
	});

	test("the base URL NEVER stomps a URL the user chose", () => {
		const applied = applyPairing({ ...DEFAULT_SETTINGS, daemonBaseUrl: "http://mac-mini:8501" }, record);
		assert.equal(applied.settings.daemonBaseUrl, "http://mac-mini:8501");
		assert.equal(applied.baseUrlSeeded, false);
		assert.deepEqual(applied.overrode, ["daemonToken", "daemonPubkey"], "daemonBaseUrl must not be in here");
	});

	test("a record with an unusable base URL seeds nothing", () => {
		const applied = applyPairing({ ...DEFAULT_SETTINGS, daemonBaseUrl: "" }, { ...record, baseUrl: "ftp://box/mods" });
		assert.equal(applied.settings.daemonBaseUrl, "");
		assert.equal(applied.baseUrlSeeded, false);
	});

	test("a record with no key leaves a hand-pinned one alone", () => {
		const hand = "c".repeat(64);
		const applied = applyPairing({ ...DEFAULT_SETTINGS, daemonPubkey: hand }, { ...record, pinnedPublicKey: null });
		assert.equal(applied.settings.daemonPubkey, hand);
		assert.equal(applied.pinnedByPairing, false);
	});

	test("isSeedableBaseUrl is exactly 'nobody chose this'", () => {
		assert.equal(isSeedableBaseUrl(""), true);
		assert.equal(isSeedableBaseUrl(DEFAULT_DAEMON_BASE_URL), true);
		assert.equal(isSeedableBaseUrl("127.0.0.1:8501"), true, "normalised before comparing");
		assert.equal(isSeedableBaseUrl("http://mac-mini:8501"), false);
		assert.equal(isSeedableBaseUrl("http://127.0.0.1:9999"), false);
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The store, over a real adapter
 * ──────────────────────────────────────────────────────────────────────────── */

describe("SettingsStore + sidecar", () => {
	test("a paired sidecar supplies the token, pins the key and seeds the URL on first load", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson({ baseUrl: "http://mac-mini:8501" }));

		const store = new SettingsStore(host);
		await store.load();

		assert.equal(store.settings.daemonToken, TOKEN);
		assert.equal(store.settings.daemonPubkey, KEY);
		assert.equal(store.settings.daemonBaseUrl, "http://mac-mini:8501");
		assert.equal(store.pairing.state, "paired");
		assert.equal(store.pairing.pinnedByPairing, true);
		assert.equal(store.pairing.baseUrlSeeded, true);
		assert.equal(store.pairing.path, SIDECAR);

		// The key and the URL belong in data.json; the credential must never land there.
		const saved = host.read();
		assert.equal(saved.settings.daemonPubkey, KEY);
		assert.equal(saved.settings.daemonBaseUrl, "http://mac-mini:8501");
		assert.equal("daemonToken" in saved.settings, false, "the token must not be written to data.json");
		store.dispose();
	});

	test("a URL the user chose survives pairing, on every reload", async () => {
		const app = createApp();
		const host = createHost(app, {
			data: { protocol: "MODKIT/1", settings: { daemonBaseUrl: "http://mac-mini:8501" }, mods: [] },
		});
		await app.vault.adapter.write(SIDECAR, sidecarJson());

		const store = new SettingsStore(host);
		await store.load();
		assert.equal(store.settings.daemonBaseUrl, "http://mac-mini:8501");
		await store.reload();
		assert.equal(store.settings.daemonBaseUrl, "http://mac-mini:8501", "a second load must not repoint it either");
		assert.equal(store.settings.daemonToken, TOKEN, "…while the token still comes from the record");
		assert.equal(host.read().settings.daemonBaseUrl, "http://mac-mini:8501");
		store.dispose();
	});

	test("a corrupt sidecar leaves the plugin loadable and says exactly what is wrong", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, "{ half a fi");

		const store = new SettingsStore(host);
		await assert.doesNotReject(() => store.load());
		assert.equal(store.settings.daemonToken, "");
		assert.equal(store.pairing.state, "unpaired");
		assert.equal(store.pairing.problem, "not-json");
		assert.match(store.pairing.reason, /not valid JSON/);
		// Everything else still loaded: one bad file is not a broken plugin.
		assert.equal(store.settings.requireSignature, true);
		assert.equal(store.isLoaded, true);
		store.dispose();
	});

	test("a missing sidecar is a state with a sentence, not a null", async () => {
		const store = new SettingsStore(createHost(createApp()));
		await store.load();
		assert.equal(store.pairing.state, "unpaired");
		assert.equal(store.pairing.problem, "absent");
		assert.match(store.pairing.reason, /No credentials at \.obsidian\/plugins\/modkit\/daemon-token\.json/);
		store.dispose();
	});

	test("a sidecar from a newer modkit is refused rather than half-read", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson({ version: 2 }));

		const store = new SettingsStore(host);
		await store.load();
		assert.equal(store.pairing.problem, "unsupported-version");
		assert.equal(store.settings.daemonToken, "", "a record this build cannot read must not be trusted for a token");
		assert.equal(store.settings.daemonPubkey, "", "…nor for a key");
		store.dispose();
	});

	test("pasting a token by hand still works, and keeps the paired key", async () => {
		// Pairing is the default path, not the only one — the remote/mobile case has no shared
		// filesystem to pair over.
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson());

		const store = new SettingsStore(host);
		await store.load();
		await store.update({ daemonToken: "mk_pasted_by_hand_0000000000" });

		assert.equal(store.settings.daemonToken, "mk_pasted_by_hand_0000000000");
		const onDisk = JSON.parse(await app.vault.adapter.read(SIDECAR));
		assert.equal(onDisk.token, "mk_pasted_by_hand_0000000000");
		assert.equal(onDisk.pinnedPublicKey, KEY, "a paste must not throw away the pinned key");
		assert.equal(onDisk.version, SIDECAR_VERSION);
		assert.match(onDisk.pairedBy, /pasted by hand/, "the record must not claim a pairing that did not happen");
		assert.equal(store.pairing.state, "paired");
		store.dispose();
	});

	test("clearing the token unpairs, file and all", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson());

		const store = new SettingsStore(host);
		await store.load();
		await store.update({ daemonToken: "" });

		assert.equal(await app.vault.adapter.exists(SIDECAR), false);
		assert.equal(store.pairing.state, "unpaired");
		assert.equal(store.settings.daemonToken, "");
		store.dispose();
	});

	test("a key typed over a paired one is reverted immediately, with a reason — never silently at the next launch", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson());

		const store = new SettingsStore(host);
		await store.load();
		const settings = await store.update({ daemonPubkey: "c".repeat(64) });

		assert.equal(settings.daemonPubkey, KEY, "the pairing record is authoritative for the pinned key");
		assert.notEqual(store.pairing.conflict, null);
		assert.match(store.pairing.conflict, /daemon-token\.json/);
		assert.equal(host.read().settings.daemonPubkey, KEY, "disk must agree, or the revert would come back later");
		store.dispose();
	});

	test("a legacy token inside data.json is migrated into a version-1 record", async () => {
		const app = createApp();
		const host = createHost(app, {
			data: { protocol: "MODKIT/1", settings: { daemonToken: "mk_legacy_in_data_json_00000" }, mods: [] },
		});

		const store = new SettingsStore(host);
		await store.load();

		assert.equal(store.settings.daemonToken, "mk_legacy_in_data_json_00000");
		assert.equal("daemonToken" in host.read().settings, false, "the credential must leave data.json");
		const onDisk = JSON.parse(await app.vault.adapter.read(SIDECAR));
		assert.equal(onDisk.token, "mk_legacy_in_data_json_00000");
		assert.equal(onDisk.version, SIDECAR_VERSION);
		assert.equal(store.pairing.state, "paired");
		store.dispose();
	});

	test("no vault adapter: the token falls back into data.json and pairing says why it is absent", async () => {
		const store = new SettingsStore({ loadData: async () => null, saveData: async () => {} });
		await store.load();
		assert.equal(store.tokenLocation.kind, "data-json");
		assert.equal(store.pairing.state, "unpaired");
		assert.match(store.pairing.reason, /no vault adapter/i);
		store.dispose();
	});

	test("the LiveSync exposure warning still points at the sidecar", async () => {
		const app = createApp();
		const host = createHost(app);
		await app.vault.adapter.write(SIDECAR, sidecarJson());
		app.vault.adapter.mkdirp(".obsidian/plugins/obsidian-livesync");
		await app.vault.adapter.write(
			".obsidian/plugins/obsidian-livesync/data.json",
			JSON.stringify({ syncInternalFiles: true }),
		);

		const store = new SettingsStore(host);
		await store.load();
		const exposure = await store.probeLiveSync();

		assert.equal(exposure.installed, true);
		assert.equal(exposure.replicated, true, "hidden-file sync carries the pairing record to every device");
		assert.match(exposure.setting, /syncInternalFiles/);
		assert.equal(store.tokenLocation.path, SIDECAR);
		store.dispose();
	});
});

/* ────────────────────────────────────────────────────────────────────────────
 * The two halves, against each other
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the daemon's writer and the plugin's reader agree", () => {
	test("a real paired file, written by the daemon, is read by the real store", async () => {
		// The one test that could catch the two sides drifting apart. Everything above this point
		// asserts the plugin against a fixture *this file* wrote, which cannot notice a daemon that
		// renames a field.
		const root = mkdtempSync(join(tmpdir(), "modkit-pair-plugin-"));
		try {
			const dir = join(root, ".obsidian", "plugins", "modkit");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "modkit", version: "0.1.0" }), "utf8");

			const identity = { token: TOKEN, publicKeyHex: KEY, baseUrl: "http://mac-mini:8501" };
			const written = writeSidecar(dir, identity);
			const bytes = readFileSync(written.path, "utf8");

			// 1. The pure reader understands the daemon's own bytes.
			const read = parseSidecar(bytes, SIDECAR);
			assert.equal(read.state, "paired", `the daemon wrote a file the plugin calls ${read.problem}: ${read.reason}`);
			assert.equal(read.record.token, TOKEN);
			assert.equal(read.record.pinnedPublicKey, KEY);
			assert.equal(read.record.baseUrl, "http://mac-mini:8501");
			assert.equal(read.record.version, SIDECAR_VERSION);

			// 2. And so does the store, end to end, from an unconfigured vault.
			const app = createApp();
			const host = createHost(app);
			await app.vault.adapter.write(SIDECAR, bytes);
			const store = new SettingsStore(host);
			await store.load();

			assert.equal(store.settings.daemonToken, TOKEN);
			assert.equal(store.settings.daemonPubkey, KEY);
			assert.equal(store.settings.daemonBaseUrl, "http://mac-mini:8501");
			assert.deepEqual(settingsBlockers(store.settings), [], "one pair command should leave nothing to configure");
			store.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
