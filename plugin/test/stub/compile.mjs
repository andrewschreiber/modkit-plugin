/**
 * Bundle an arbitrary slice of `src/` for a test to import, the same way `test/build-tests.mjs`
 * bundles `test/plugin-api.ts`.
 *
 * ## Why this exists instead of another export line in `test/plugin-api.ts`
 *
 * `plugin-api.ts` is the project's single test entry point and it is the right place for this. It
 * is also owned by another agent for the duration of this session, and two agents appending to one
 * file is how a suite ends up half-built. So the three surfaces added here (`daemon/client.ts`,
 * `host/supervisor.ts`, `picker/selector.ts`, `picker/picker.ts`) are bundled from their own
 * throwaway entry instead. **When the file-ownership split ends, fold these into
 * `test/plugin-api.ts` and delete this module** — that entry buys a real thing this one does not:
 * `tsconfig.test.json` typechecks it, so a renamed export in `src/` becomes a build failure rather
 * than an `undefined` at call time. Nothing here catches that (esbuild strips types without
 * resolving them), which is why each test below asserts `typeof` on what it imported.
 *
 * ## The two things it copies from `build-tests.mjs`, and why
 *
 * 1. **`obsidian` is redirected to `../stub/obsidian.mjs` and marked `external`.** External is the
 *    point: an inlined stub would give each bundle a private copy, and `Notice.log` in a test would
 *    not be the `Notice.log` the code under test appended to. The specifier is relative to the
 *    *output* file, so every bundle must land in `test/build/`.
 * 2. **The output is real JavaScript on disk, not type-stripped `.ts`.** Node's type stripping would
 *    make the suite depend on which `node` resolved, and a suite that runs for one and not the other
 *    is worse than none.
 *
 * The output name carries the pid because `node --test` runs test files in parallel processes, and
 * two of them writing one path is a race that would show up as a truncated import. Each bundle is
 * removed on process exit.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import esbuild from "esbuild";

const STUB_DIR = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = dirname(STUB_DIR);
const OUT_DIR = join(TEST_DIR, "build");

/** Resolved at run time by Node, relative to a file in `OUT_DIR`. */
const OBSIDIAN_STUB_SPECIFIER = "../stub/obsidian.mjs";

const obsidianStub = {
	name: "obsidian-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: OBSIDIAN_STUB_SPECIFIER, external: true }));
	},
};

const built = new Map();

/**
 * Bundle `exports` (a snippet of TypeScript re-exporting from `../../src/...`) and import it.
 *
 * @param {string} name   Distinguishes this bundle's output file. One per test file.
 * @param {string} source The entry's TypeScript. Written as if it sat in `test/stub/`.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
export async function compileSurface(name, source) {
	const cached = built.get(name);
	if (cached !== undefined) return cached;

	mkdirSync(OUT_DIR, { recursive: true });
	const outfile = join(OUT_DIR, `${name}-${String(process.pid)}.mjs`);

	await esbuild.build({
		stdin: { contents: source, resolveDir: STUB_DIR, sourcefile: `${name}-entry.ts`, loader: "ts" },
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		plugins: [obsidianStub],
		minify: false,
		sourcemap: "inline",
		logLevel: "warning",
	});

	process.on("exit", () => {
		try {
			rmSync(outfile, { force: true });
		} catch {
			/* a leftover in a gitignored build dir is not worth failing a run over */
		}
	});

	const namespace = await import(`file://${outfile}`);
	built.set(name, namespace);
	return namespace;
}
