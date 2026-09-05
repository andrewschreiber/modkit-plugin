/**
 * The daemon half of the roundtrip: a real keyring in a throwaway `.state/` tree, and a real
 * `signArtifact` call.
 *
 * Nothing here re-implements signing. `loadKeyring` mints the root key, the subkey and the
 * delegation certificate exactly as the daemon does at startup, and `signArtifact` produces exactly
 * the envelope the daemon puts on the wire. That is the whole point of the roundtrip test: the two
 * sides of this contract were written by agents who never spoke, so the only assertion worth making
 * is between the two real implementations.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_DIST = new URL("../../../packages/modkit-daemon/dist/", import.meta.url);

export const { loadKeyring, signArtifact, verifySignedArtifact, pubkeyHex, sha256Hex: daemonSha256Hex } =
	await import(new URL("sign.js", DAEMON_DIST).href);
export const { ensureState } = await import(new URL("state.js", DAEMON_DIST).href);
export const { silentLogger } = await import(new URL("log.js", DAEMON_DIST).href);

/** Fixed instants, so every expiry assertion is about the code and not about the wall clock. */
export const T0 = Date.parse("2026-08-31T12:00:00.000Z");
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/**
 * A keyring in a fresh temp directory. Returns the keyring plus a `cleanup()`; the caller owns
 * both. The private keys never leave the temp tree and the tree is removed after the test.
 */
export function makeKeyring({ now = T0, certTtlMs = 7 * DAY, certRenewBeforeMs = HOUR } = {}) {
	const root = mkdtempSync(join(tmpdir(), "modkit-test-state-"));
	const layout = ensureState(root);
	const keyring = loadKeyring(layout, silentLogger(), { certTtlMs, certRenewBeforeMs, now });
	return {
		keyring,
		layout,
		root,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A complete, well-formed draft. Individual tests override single fields. */
export function makeDraft(overrides = {}) {
	const modId = overrides.modId ?? "modkit-mod-quieter-tasks";
	const mainJs =
		"'use strict';\n" +
		"const obsidian = require('obsidian');\n" +
		"module.exports = class extends obsidian.Plugin { async onload() { this.register(() => {}); } };\n";
	return {
		modId,
		manifest: {
			id: modId,
			name: "Quieter tasks",
			version: "0.1.0",
			minAppVersion: "1.7.2",
			description: "Stops the tasks plugin shouting.",
			author: "modkit",
			isDesktopOnly: false,
		},
		mainJs,
		request: "make the tasks plugin stop shouting",
		target: { kind: "plugin", pluginId: "obsidian-tasks-plugin", pluginName: "Tasks", pluginVersion: "7.4.0" },
		reach: { plane: "C", pluginId: "obsidian-tasks-plugin", holder: "prototype", member: "onload" },
		targetVersionRange: { from: "7.0.0", to: null },
		noEffect: { mode: "on-demand" },
		explanation: "Wraps the plugin's notice helper so it logs instead of shouting.",
		model: "claude-opus-4-6",
		...overrides,
	};
}

export function sign(keyring, draft = makeDraft(), { now = T0, artifactTtlMs = HOUR, daemonVersion = "0.1.0" } = {}) {
	return signArtifact(draft, { keyring, daemonVersion, artifactTtlMs, now });
}

/** Base64 of UTF-8 JSON — the daemon's payload encoding, mirrored for building tampered fixtures. */
export function encodePayload(payload) {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodePayload(b64) {
	return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

export const daemonDistPath = fileURLToPath(DAEMON_DIST);
