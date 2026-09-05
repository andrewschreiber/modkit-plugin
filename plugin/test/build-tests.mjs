/**
 * Compile what the tests import, before `node --test` runs.
 *
 * Two things get built, and the reason for each is the same: **the tests must exercise the real
 * compiled code, not a re-implementation of it.**
 *
 * 1. `packages/modkit-daemon/dist/` — because the sign/verify roundtrip signs with the daemon's own
 *    `signArtifact`, not with a test-local Ed25519 helper. A test that minted its own signatures
 *    would agree with itself forever while the two sides drifted apart.
 * 2. `plugin/test/build/plugin-api.mjs` — the plugin's TypeScript, bundled through esbuild with
 *    `obsidian` redirected to the stub.
 *
 * ## Why bundle instead of running the `.ts` directly
 *
 * Node's type stripping would be the obvious shortcut and it is not available here: the `node` that
 * `npm run` resolves on this box is not necessarily the one on the interactive PATH, and a suite
 * that runs for one of them and not the other is worse than no suite. Everything imported by a test
 * is built JavaScript.
 *
 * ## How `obsidian` is redirected
 *
 * An esbuild `onResolve` hook rewrites the bare specifier `obsidian` to `../stub/obsidian.mjs` and
 * marks it **external**, so the import survives into the output and is resolved by Node at run time.
 * Marking it external is the point: were it inlined, each bundle would hold a private copy of the
 * stub and `Notice.log` in a test would not be the `Notice.log` the plugin appended to.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import esbuild from "esbuild";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(TEST_DIR);
const REPO_ROOT = dirname(PLUGIN_DIR);
const OUT_DIR = join(TEST_DIR, "build");

/** `obsidian` resolves to this at run time, relative to a file in `OUT_DIR`. */
const OBSIDIAN_STUB_SPECIFIER = "../stub/obsidian.mjs";

const obsidianStub = {
	name: "obsidian-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: OBSIDIAN_STUB_SPECIFIER, external: true }));
	},
};

/** `tsc -b` on the daemon project, which also builds `@modkit/types` through its project reference. */
function buildDaemon() {
	const tsc = join(REPO_ROOT, "node_modules", ".bin", "tsc");
	if (!existsSync(tsc)) {
		throw new Error(`cannot build the daemon: ${tsc} is missing — run npm install at the repo root`);
	}
	const result = spawnSync(tsc, ["-b", join(REPO_ROOT, "packages", "modkit-daemon")], {
		stdio: "inherit",
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`tsc -b packages/modkit-daemon failed with status ${String(result.status)}`);
	}
	const sign = join(REPO_ROOT, "packages", "modkit-daemon", "dist", "sign.js");
	if (!existsSync(sign)) throw new Error(`the daemon built but ${sign} is not there`);
}

async function buildPluginApi() {
	mkdirSync(OUT_DIR, { recursive: true });
	await esbuild.build({
		entryPoints: [join(TEST_DIR, "plugin-api.ts")],
		outfile: join(OUT_DIR, "plugin-api.mjs"),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		plugins: [obsidianStub],
		// Not minified and with a sourcemap: when a test fails, the line it names should be findable.
		minify: false,
		sourcemap: "inline",
		logLevel: "warning",
	});
}

buildDaemon();
await buildPluginApi();
process.stdout.write("test fixtures built: daemon dist + plugin/test/build/plugin-api.mjs\n");
