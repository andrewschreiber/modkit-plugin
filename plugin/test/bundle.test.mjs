/**
 * The load contract of the shipped artifact.
 *
 * Everything here is a property of `plugin/dist/main.js` as a *file*, and every one of them is
 * invisible from the TypeScript:
 *
 * - Obsidian loads a plugin as **CommonJS** and reads `module.exports.default`. If esbuild's format
 *   or the entry's export shape ever changes, the plugin does not fail loudly — Obsidian reports
 *   "failed to load" and the vault carries on without it.
 * - A `node:` import is fatal on **mobile**, where Obsidian is a Capacitor WebView with no Node.
 *   The esbuild config lists both the bare and `node:`-prefixed spellings of every builtin as
 *   external for exactly that reason (`builtinModules` carries the prefix for only four names), and
 *   the way that regresses is silently, in a module nobody tested on a phone.
 * - An **inline sourcemap** embeds absolute paths from the build machine. The dev build enables one;
 *   the production build does not, and shipping the dev build would leak `/Users/<name>/…` into
 *   every vault the plugin is installed into. The absolute-path assertion below is what notices.
 * - **No key material.** The daemon's private keys live in `.state/`, `0600`, and nothing in the
 *   plugin should ever have seen one. This is cheap to check and catastrophic to get wrong.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { afterEach, beforeEach, describe } from "node:test";

import { BUNDLE_PATH, loadBundle, readBundleSource } from "./helpers/bundle.mjs";
import { Plugin } from "./stub/obsidian.mjs";
import { installDomGlobals } from "./stub/dom.mjs";

const source = readBundleSource();

let dom;
beforeEach(() => {
	dom = installDomGlobals();
});
afterEach(() => {
	dom.restore();
});

describe("the built bundle loads the way Obsidian loads it", () => {
	test("evaluates as CommonJS and marks itself __esModule", async () => {
		const { exports } = loadBundle({ source });
		assert.equal(exports.__esModule, true, "Obsidian reads the default export through the esModule interop");
	});

	test("its default export is a class extending Plugin", async () => {
		const { exports, obsidian } = loadBundle({ source });
		const ModkitPlugin = exports.default;

		assert.equal(typeof ModkitPlugin, "function", "module.exports.default must be the plugin class");
		assert.equal(
			Object.getPrototypeOf(ModkitPlugin),
			obsidian.Plugin,
			"the plugin class must extend the host's Plugin, not a bundled copy of it",
		);
		assert.equal(obsidian.Plugin, Plugin, "the bundle and the test must be talking about one Plugin");
		assert.equal(ModkitPlugin.name, "ModkitPlugin");
	});

	test("asks its host for `obsidian` and nothing else", async () => {
		// Anything else would have to be provided by Obsidian's own loader, and its list is short.
		const { requested } = loadBundle({ source });
		assert.deepEqual([...new Set(requested)], ["obsidian"]);
	});

	test("contains no `node:` import, in either spelling", () => {
		// Fatal on mobile, where there is no Node at all.
		const nodePrefixed = source.match(/["'`]node:[a-z_/]+["'`]/g) ?? [];
		assert.deepEqual(nodePrefixed, [], `the bundle carries node: imports: ${nodePrefixed.join(", ")}`);

		const requires = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
		assert.deepEqual([...new Set(requires)], ["obsidian"], "the bundle requires something other than obsidian");
	});

	test("carries no key material", () => {
		// Needles that indicate *material*, not prose. The plugin legitimately names the daemon's
		// files in its own help text ("the daemon writes one to .state/modkit/daemon.token") and a
		// test that flagged that would be a test people learn to disable.
		const forbidden = [
			["-----BEGIN", "a PEM block"],
			["PRIVATE KEY", "a private key"],
			["secrets/root.key", "the daemon's root key file"],
			["secrets/sign.key", "the daemon's signing key file"],
		];
		for (const [needle, what] of forbidden) {
			assert.equal(source.includes(needle), false, `the bundle contains ${what} ("${needle}")`);
		}

		// A pinned key is a *setting*, entered by the user; nothing 64-hex-shaped should be baked in.
		const hexBlobs = (source.match(/\b[0-9a-f]{64}\b/g) ?? []).filter((h) => !/^0+$/.test(h) && !/^f+$/.test(h));
		assert.deepEqual(hexBlobs, [], `the bundle embeds 64-hex constants: ${hexBlobs.slice(0, 3).join(", ")}`);
	});

	test("carries no absolute path from the build machine", () => {
		// This also catches a dev build being shipped: `sourcemap: "inline"` embeds every source path.
		const absolute = [...new Set(source.match(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g) ?? [])];
		assert.deepEqual(absolute, [], `the bundle leaks build-machine paths: ${absolute.join(", ")}`);
		assert.equal(
			source.includes("sourceMappingURL"),
			false,
			"the production bundle must carry no sourcemap — an inline one embeds absolute paths",
		);
		assert.equal(source.includes(fileURLToPath(new URL("../", import.meta.url))), false);
	});

	test("ships beside a manifest Obsidian can key on, and a styles.css", () => {
		// Obsidian identifies a plugin by `manifest.id`, not by its folder, and loads `styles.css`
		// automatically if it is there. Both are emitted by the build, not by hand.
		const dist = new URL("../dist/", import.meta.url);
		const shipped = JSON.parse(readFileSync(new URL("manifest.json", dist), "utf8"));
		const authored = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
		assert.deepEqual(shipped, authored, "dist/manifest.json has drifted from plugin/manifest.json");
		assert.equal(shipped.id, "modkit");
		assert.equal(shipped.isDesktopOnly, false, "modkit must load on mobile, where mods arrive by sync");
		assert.doesNotThrow(() => readFileSync(new URL("styles.css", dist), "utf8"));
	});

	test("is readable, not minified — a tool that asks you to audit what it installed", () => {
		// DESIGN §6 makes auditability the open trust gap for generated code. `minify: false` in both
		// build modes is the standing commitment; a long single line is how that silently reverses.
		const longest = source.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
		assert.ok(longest < 2000, `the longest line is ${longest} characters — the bundle looks minified`);
		assert.ok(source.startsWith("/*"), "the build banner should be the first thing in the file");
	});

	test("the file under test is the one the vault installer copies", () => {
		assert.match(BUNDLE_PATH, /plugin\/dist\/main\.js$/);
	});
});
