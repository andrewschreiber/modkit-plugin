/**
 * The sidecar, against a real filesystem.
 *
 * Everything here is asserted on the **bytes on disk**, never on the return value alone: the whole
 * reason this module exists is that a credential written world-readable, or not written at all,
 * looks exactly like success from the caller's side. The mode check and the readback are the two
 * claims worth testing, and neither can be made against a mock.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
	DEFAULT_BASE_URL,
	SidecarError,
	SIDECAR_FILE_NAME,
	SIDECAR_VERSION,
	assertModkitPluginFolder,
	readSidecar,
	sidecarPath,
	writeSidecar,
} from "../dist/sidecar.js";

const IDENTITY = {
	token: "mk_" + "a".repeat(43),
	publicKeyHex: "b".repeat(64),
	baseUrl: DEFAULT_BASE_URL,
};

let root;
let pluginDir;

function makePluginDir(id = "modkit") {
	const dir = join(root, ".obsidian", "plugins", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0" }), "utf8");
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "modkit-setup-"));
	pluginDir = makePluginDir();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("writeSidecar", () => {
	test("writes the contract, 0600, and reads back as what it wrote", () => {
		const result = writeSidecar(pluginDir, IDENTITY, { now: new Date("2026-08-31T12:00:00.000Z"), version: "0.1.0", host: "mac-mini" });

		assert.equal(result.path, join(pluginDir, SIDECAR_FILE_NAME));
		assert.equal(result.created, true);
		assert.equal(result.mode, 0o600);

		const stat = statSync(result.path);
		assert.equal(stat.mode & 0o777, 0o600, "a credential must not be readable by other users");

		const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
		assert.deepEqual(Object.keys(onDisk), ["_note", "version", "baseUrl", "token", "pinnedPublicKey", "pairedAt", "pairedBy"]);
		assert.equal(onDisk.version, SIDECAR_VERSION);
		assert.equal(onDisk.token, IDENTITY.token);
		assert.equal(onDisk.pinnedPublicKey, IDENTITY.publicKeyHex);
		assert.equal(onDisk.baseUrl, DEFAULT_BASE_URL);
		assert.equal(onDisk.pairedAt, "2026-08-31T12:00:00.000Z");
		assert.equal(onDisk.pairedBy, "modkit setup 0.1.0 on mac-mini");
		// The note is for a human who opens the file, and has one job beyond decoration: telling
		// them it is live and naming the LiveSync setting that would replicate it.
		assert.match(onDisk._note, /credential/i);
		assert.match(onDisk._note, /syncInternalFilesIgnorePatterns/);
	});

	test("leaves no temp file behind — the write is a rename, not an in-place truncate", () => {
		writeSidecar(pluginDir, IDENTITY);
		assert.equal(readSidecar(pluginDir).readable, true);
		assert.deepEqual(
			readdirSync(pluginDir).filter((name) => name.includes(".part")),
			[],
		);
	});

	test("is idempotent, and says what actually changed", () => {
		const first = writeSidecar(pluginDir, IDENTITY, { now: new Date("2026-08-31T12:00:00.000Z") });
		assert.equal(first.created, true);

		const second = writeSidecar(pluginDir, IDENTITY, { now: new Date("2026-08-31T13:00:00.000Z") });
		assert.equal(second.created, false);
		assert.equal(second.tokenChanged, false);
		assert.equal(second.publicKeyChanged, false);
		assert.deepEqual(second.changes, [], "a second identical run must not claim it did something");
		assert.notEqual(second.pairedAt, first.pairedAt, "pairedAt is refreshed");
		assert.equal(JSON.parse(readFileSync(second.path, "utf8")).pairedAt, second.pairedAt);
	});

	test("a rotated token and key overwrite, and are reported", () => {
		writeSidecar(pluginDir, IDENTITY);
		const rotated = { ...IDENTITY, token: "mk_" + "c".repeat(43), publicKeyHex: "d".repeat(64) };
		const result = writeSidecar(pluginDir, rotated);

		assert.equal(result.tokenChanged, true);
		assert.equal(result.publicKeyChanged, true);
		assert.ok(result.changes.some((line) => /bearer token changed/.test(line)));
		assert.ok(result.changes.some((line) => /pinned signing key changed/.test(line)));
		assert.equal(readSidecar(pluginDir).record.token, rotated.token);
	});

	test("a deliberately remote baseUrl survives a second setup run, and --base-url overrides it", () => {
		// The failure this prevents is invisible: a phone pointed at mac-mini, silently repointed at
		// 127.0.0.1 by a setup run on the desktop, with nothing erroring.
		writeSidecar(pluginDir, { ...IDENTITY, baseUrl: "http://mac-mini:8501" });
		const result = writeSidecar(pluginDir, IDENTITY);

		assert.equal(result.baseUrl, "http://mac-mini:8501");
		assert.equal(result.baseUrlPreserved, true);
		assert.equal(result.previousBaseUrl, "http://mac-mini:8501");
		assert.ok(result.changes.some((line) => /kept baseUrl/.test(line)));
		assert.equal(readSidecar(pluginDir).record.baseUrl, "http://mac-mini:8501");

		const forced = writeSidecar(pluginDir, IDENTITY, { overwriteBaseUrl: true });
		assert.equal(forced.baseUrl, DEFAULT_BASE_URL);
		assert.equal(forced.baseUrlPreserved, false);
	});

	test("a default baseUrl is not 'deliberate', so this daemon's own origin replaces it", () => {
		writeSidecar(pluginDir, IDENTITY);
		const result = writeSidecar(pluginDir, { ...IDENTITY, baseUrl: "http://100.64.1.2:8501" });
		assert.equal(result.baseUrl, "http://100.64.1.2:8501");
		assert.equal(result.baseUrlPreserved, false);
		assert.ok(result.changes.some((line) => /baseUrl .* → /.test(line)));
	});

	test("an unreadable sidecar is replaced, and said to have been", () => {
		writeFileSync(sidecarPath(pluginDir), "{ this is not json", "utf8");
		const result = writeSidecar(pluginDir, IDENTITY);
		assert.equal(result.created, false);
		assert.equal(result.replacedUnreadable, true);
		assert.equal(readSidecar(pluginDir).record.token, IDENTITY.token);
	});

	test("a legacy hand-pasted record (daemonToken, no version) is upgraded in place", () => {
		writeFileSync(sidecarPath(pluginDir), JSON.stringify({ _note: "old", daemonToken: "mk_old" }), "utf8");
		const result = writeSidecar(pluginDir, IDENTITY);
		assert.equal(result.tokenChanged, true);
		assert.equal(JSON.parse(readFileSync(result.path, "utf8")).version, SIDECAR_VERSION);
	});
});

describe("writeSidecar refuses", () => {
	test("a directory that does not exist", () => {
		assert.throws(() => writeSidecar(join(root, "nope"), IDENTITY), (err) => {
			assert.ok(err instanceof SidecarError);
			assert.equal(err.code, "no-plugin-dir");
			return true;
		});
	});

	test("a directory with no manifest.json — one typo must not scatter credentials", () => {
		const dir = join(root, "Documents");
		mkdirSync(dir, { recursive: true });
		assert.throws(() => writeSidecar(dir, IDENTITY), (err) => err.code === "no-manifest");
		assert.throws(() => readFileSync(sidecarPath(dir), "utf8"), /ENOENT/, "nothing may be written on a refusal");
	});

	test("another plugin's folder", () => {
		const other = makePluginDir("obsidian-livesync");
		assert.throws(() => writeSidecar(other, IDENTITY), (err) => {
			assert.equal(err.code, "foreign-plugin");
			assert.match(err.message, /obsidian-livesync/);
			return true;
		});
	});

	test("a manifest.json that is not JSON", () => {
		writeFileSync(join(pluginDir, "manifest.json"), "not json", "utf8");
		assert.throws(() => writeSidecar(pluginDir, IDENTITY), (err) => err.code === "unreadable-manifest");
	});
});

describe("assertModkitPluginFolder", () => {
	test("accepts modkit's own folder and reports its version", () => {
		const folder = assertModkitPluginFolder(pluginDir);
		assert.equal(folder.dir, pluginDir);
		assert.equal(folder.pluginVersion, "0.1.0");
	});
});

describe("readSidecar", () => {
	test("reports absent, unreadable and readable as three different states", () => {
		assert.deepEqual(readSidecar(pluginDir), { path: sidecarPath(pluginDir), present: false, readable: false, record: null });

		writeFileSync(sidecarPath(pluginDir), "[]", "utf8");
		const arrayFile = readSidecar(pluginDir);
		assert.equal(arrayFile.present, true);
		assert.equal(arrayFile.readable, false);

		writeSidecar(pluginDir, IDENTITY);
		assert.equal(readSidecar(pluginDir).readable, true);
	});
});

describe("mode enforcement", () => {
	test("the file lands 0600 however permissive the directory is", () => {
		// The real failure this guards is a umask or a mount that widens the file. It cannot be
		// produced directly (the writer re-chmods), so this asserts the invariant the writer leaves:
		// after a successful write the file is 0600 whatever the directory allows.
		chmodSync(pluginDir, 0o777);
		const result = writeSidecar(pluginDir, IDENTITY);
		assert.equal(statSync(result.path).mode & 0o777, 0o600);
	});
});
