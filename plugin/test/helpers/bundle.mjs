/**
 * Load `plugin/dist/main.js` — the artifact that is actually copied into a vault — the way Obsidian
 * does: as CommonJS, with `require("obsidian")` answered by the host.
 *
 * ## Why the shipped bundle and not the source
 *
 * Everything between `src/main.ts` and the file in `.obsidian/plugins/modkit/main.js` is esbuild
 * configuration, and configuration is exactly where a plugin breaks silently: a stray `node:`
 * import, an inline sourcemap carrying absolute machine paths, an `external` list that stopped
 * matching. Those defects cannot be seen from the TypeScript. So the load contract is asserted
 * against the bundle.
 *
 * ## Where this is crude
 *
 * The bundle is evaluated with `vm.runInThisContext`, so it shares this test's realm and its
 * globals. A real Obsidian plugin runs in the renderer's realm, with a real DOM. That means:
 *
 * - `instanceof` against a real DOM class is meaningless here (there are no real DOM classes);
 * - the plugin can see globals the test set, and vice versa — nothing below relies on that, and a
 *   test that did would be measuring the harness;
 * - `require` answers exactly one specifier and throws for every other, which doubles as the
 *   assertion that the bundle asks the host for nothing but `obsidian`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as obsidianStub from "../stub/obsidian.mjs";

export const BUNDLE_PATH = fileURLToPath(new URL("../../dist/main.js", import.meta.url));

export function readBundleSource() {
	return readFileSync(BUNDLE_PATH, "utf8");
}

/**
 * Evaluate the bundle and return its `module.exports`.
 *
 * `requested` collects every specifier the bundle asked for, so a caller can assert on it. Any
 * specifier other than `obsidian` throws — Obsidian's own loader would not resolve it either.
 */
export function loadBundle({ source = readBundleSource() } = {}) {
	const requested = [];
	const nodeRequire = createRequire(import.meta.url);
	const fakeRequire = (id) => {
		requested.push(id);
		if (id === "obsidian") return obsidianStub;
		throw new Error(
			`the modkit bundle asked its host for "${id}" — Obsidian only provides "obsidian" and a short list of editor packages`,
		);
	};
	fakeRequire.resolve = (id) => (id === "obsidian" ? "obsidian" : nodeRequire.resolve(id));

	const module = { exports: {} };
	const wrapper = vm.runInThisContext(
		`(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
		{ filename: BUNDLE_PATH },
	);
	wrapper(module.exports, fakeRequire, module, BUNDLE_PATH, dirname(BUNDLE_PATH));

	return { exports: module.exports, requested, obsidian: obsidianStub };
}
