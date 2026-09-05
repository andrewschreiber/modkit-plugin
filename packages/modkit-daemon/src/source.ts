/**
 * `source.ts` — plugin id + installed version → the target's own source, at the matching tag.
 *
 * This is the second half of the source bridge. `registry.ts` answers *which repo*; this module
 * answers *what does it look like at the version the user actually has installed*.
 *
 * ## Four decisions, all measured
 *
 * **1. Resolve at the INSTALLED version, never at `HEAD`.** The two live targets in this vault are
 * ~21 months and a major version behind (Tasks 7.14.0 against 8.4.0; QuickAdd 1.11.5 against
 * 2.23.0). The shapes a patch binds to do not exist at HEAD in the same form, so generating against
 * HEAD would produce confident, wrong patches. If the tag cannot be resolved, we fail loudly rather
 * than falling back to a branch.
 *
 * **2. Tags are BARE semver, no `v` prefix** — verified against both repos (`7.14.0` resolves,
 * `v7.14.0` 404s). That is not luck: the community submission process requires a release whose tag
 * equals `manifest.json`'s `version`. So the tag is derivable from the installed manifest with no
 * lookup at all. A fallback ladder exists anyway, because 7,000-odd repos will not all be tidy.
 *
 * **3. Trees API plus raw blobs, never tarballs.** QuickAdd's 1.11.5 tarball is 29 MB, of which
 * `docs/` is 28 MB; its `src/` is 784 KB across 139 files. Tasks' is 12 MB for 181 source blobs.
 * Downloading a snapshot costs 25–40× the useful bytes. We list once through the API and fetch only
 * the files we chose, over `raw.githubusercontent.com`.
 *
 * **4. Tag probes go through raw, not the API.** `api.github.com` is rate-limited to 60/hour
 * unauthenticated, and burning three of those on "does this tag exist" is how a daemon stops working
 * on a busy afternoon. `raw.githubusercontent.com/<repo>/<tag>/manifest.json` answers the same
 * question from a CDN with no rate limit. Exactly one API call per `(repo, tag)` survives — the tree
 * listing — and it is cached forever, because a tag is immutable by construction. This is the one
 * cache in the system that is genuinely write-once.
 *
 * ## What this module is NOT
 *
 * It is building a **model context**, not a mirror. Everything below is about spending a byte budget
 * well: the whole point of selecting files is that the interesting 40 KB of a 784 KB tree is what
 * makes a good patch, and the other 744 KB is what makes an expensive one.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseSemver } from './semver.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Shapes
 * ──────────────────────────────────────────────────────────────────────────── */

/** One file, as it will appear in the prompt. */
export interface SourceFile {
  /** Repo-relative path, e.g. `src/main.ts`. */
  path: string;
  /** Bytes of `text` as included (post-truncation). */
  bytes: number;
  text: string;
  /** True when the file was too large and only its head was kept. */
  truncated: boolean;
  /** Selection score, kept so the prompt's degradation ladder can drop the weakest first. */
  score: number;
}

/** Everything fetched for one `(repo, tag)`, ordered most-relevant first. */
export interface SourceBundle {
  repo: string;
  tag: string;
  /** How the tag was resolved — `raw-probe`, `raw-probe-v`, `api-ref`, `api-ref-v`, `api-tag-scan`. */
  resolvedVia: string;
  commitSha: string | null;
  files: SourceFile[];
  totalBytes: number;
  /** Candidates that scored in but did not fit the budget. Named so the prompt can say so. */
  omitted: Array<{ path: string; bytes: number }>;
  /** GitHub truncates very large trees; when true the listing itself was incomplete. */
  treeTruncated: boolean;
  /** Of the requested symbols, which were actually found in the fetched text. */
  symbolsFound: string[];
  symbolsMissing: string[];
}

export type TagResolution =
  | { ok: true; tag: string; via: string; sha: string | null }
  | { ok: false; error: string; tried: string[] };

export type SourceResult =
  | { ok: true; bundle: SourceBundle }
  | { ok: false; error: string; reason: 'tag' | 'tree' | 'network' | 'bad-repo' };

/** What the caller wants out of the tree. All optional; the defaults are sane for a patch request. */
export interface SourceSelection {
  /** Words from the user's request. Drive path scoring. */
  keywords?: string[];
  /** Class / method names the patch is likely to bind to. Drive both scoring and a second pass. */
  symbols?: string[];
  /** Paths to include verbatim if they exist, ahead of everything else. */
  paths?: string[];
  /** Include `styles.css` — worth it for a plane-E request, noise otherwise. */
  includeStyles?: boolean;
  /** Total budget across all files. Default 240 KB — roughly 60k tokens of source. */
  maxTotalBytes?: number;
  maxFiles?: number;
  /** A single file larger than this is truncated to its head. Default 60 KB. */
  maxFileBytes?: number;
}

export interface SourceFetcherOptions {
  stateDir: string;
  fetchImpl?: typeof fetch;
  /**
   * A GitHub token lifts the API's 60/hour anonymous ceiling. Optional by design: with the raw-first
   * tag probe, an unauthenticated daemon still gets one API call per new `(repo, tag)`, and every
   * repeat is served from cache.
   */
  token?: string | null;
  log?: (message: string) => void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────────── */

const DEFAULT_MAX_TOTAL_BYTES = 240_000;
const DEFAULT_MAX_FILES = 24;
const DEFAULT_MAX_FILE_BYTES = 60_000;

/** `owner/name`, GitHub's own character set. Also the guard that keeps a repo string out of a path. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue)$/;
const ALWAYS_WANTED = new Set(['manifest.json', 'package.json']);

/** Directories and suffixes that are never worth a byte of prompt. */
const PATH_EXCLUDE = [
  /(^|\/)node_modules\//,
  /(^|\/)docs?\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)coverage\//,
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /\.d\.ts$/,
  /\.(test|spec)\.[a-z]+$/,
  /(^|\/)\.github\//,
  /(^|\/)\.obsidian\//,
  /(^|\/)resources\//,
  /(^|\/)contributing\//,
  /(^|\/)sample[_-]vaults?\//,
  /(^|\/)examples?\//,
  /(^|\/)fixtures?\//,
  /(^|\/)vendor\//,
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'without', 'that', 'this', 'these', 'those',
  'when', 'then', 'than', 'from', 'into', 'onto', 'about', 'also', 'make', 'makes', 'made', 'add',
  'adds', 'set', 'sets', 'get', 'gets', 'use', 'uses', 'using', 'should', 'would', 'could', 'want',
  'wants', 'need', 'needs', 'please', 'just', 'only', 'not', 'dont', 'doesnt', 'plugin', 'obsidian',
  'instead', 'always', 'never', 'every', 'each', 'some', 'any', 'all',
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Keyword extraction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Turn the user's sentence into path-scoring keywords.
 *
 * Deliberately crude: this only ever decides *which of a plugin's own files to show the model*, and
 * being wrong costs a slightly worse context, never a wrong patch. Anything cleverer would be
 * pretending to an accuracy it does not have.
 */
export function extractKeywords(request: string, extra: string[] = []): string[] {
  const words = `${request} ${extra.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 24);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The fetcher
 * ──────────────────────────────────────────────────────────────────────────── */

interface TreeEntry {
  path: string;
  type: string;
  size: number;
  sha: string;
}

interface CachedTree {
  version: 1;
  repo: string;
  tag: string;
  sha: string | null;
  truncated: boolean;
  entries: TreeEntry[];
}

export class SourceFetcher {
  readonly #stateDir: string;
  readonly #fetch: typeof fetch;
  readonly #token: string | null;
  readonly #log: (message: string) => void;

  constructor(options: SourceFetcherOptions) {
    this.#stateDir = options.stateDir;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#token =
      options.token ?? process.env['MODKIT_GITHUB_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? null;
    this.#log = options.log ?? (() => {});
  }

  /**
   * The whole job: `(repo, version)` → a bundle of the most relevant source, within budget.
   */
  async fetchSource(
    repo: string,
    version: string,
    selection: SourceSelection = {},
  ): Promise<SourceResult> {
    if (!REPO_RE.test(repo)) {
      return { ok: false, error: `"${repo}" is not an owner/name repo reference`, reason: 'bad-repo' };
    }

    const tag = await this.resolveTag(repo, version);
    if (!tag.ok) {
      return {
        ok: false,
        // Refusing here is correct. Silently generating against HEAD is the alternative, and it
        // produces a patch that looks right and binds to code the user does not have.
        error: `${tag.error} (tried: ${tag.tried.join(', ')})`,
        reason: 'tag',
      };
    }

    let tree: CachedTree;
    try {
      tree = await this.#tree(repo, tag.tag, tag.sha);
    } catch (e) {
      return { ok: false, error: `could not list ${repo}@${tag.tag}: ${(e as Error).message}`, reason: 'tree' };
    }

    const bundle = await this.#select(repo, tag, tree, selection);
    return { ok: true, bundle };
  }

  /* ── Tag resolution ────────────────────────────────────────────────────── */

  /**
   * The ladder. Rungs 1–2 are CDN probes and cost no API quota; 3–5 only run for repos that break
   * the convention.
   */
  async resolveTag(repo: string, version: string): Promise<TagResolution> {
    const tried: string[] = [];
    const bare = version.trim();
    if (!bare) return { ok: false, error: 'no version given', tried };
    const prefixed = `v${bare}`;

    for (const [tag, via] of [
      [bare, 'raw-probe'],
      [prefixed, 'raw-probe-v'],
    ] as const) {
      tried.push(tag);
      if (await this.#rawTagExists(repo, tag)) return { ok: true, tag, via, sha: null };
    }

    for (const [tag, via] of [
      [bare, 'api-ref'],
      [prefixed, 'api-ref-v'],
    ] as const) {
      const sha = await this.#apiTagSha(repo, tag);
      if (sha) return { ok: true, tag, via, sha };
    }

    // Last rung: some repos tag `release-1.2.3` or pad differently. Compare parsed semver, not text.
    const scanned = await this.#scanTags(repo, bare);
    if (scanned) return { ok: true, tag: scanned, via: 'api-tag-scan', sha: null };

    return { ok: false, error: `no tag matching version ${bare} in ${repo}`, tried };
  }

  /** A tag exists if the repo's own manifest is served at it. No API quota spent. */
  async #rawTagExists(repo: string, tag: string): Promise<boolean> {
    try {
      const res = await this.#fetch(this.#rawUrl(repo, tag, 'manifest.json'), {
        method: 'GET',
        headers: { 'user-agent': 'modkit-daemon' },
        redirect: 'follow',
      });
      // Drain the body so the socket is reusable; a manifest is a few hundred bytes.
      if (res.ok) await res.text();
      return res.ok;
    } catch {
      return false;
    }
  }

  async #apiTagSha(repo: string, tag: string): Promise<string | null> {
    try {
      const res = await this.#fetch(
        `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
        { headers: this.#apiHeaders() },
      );
      if (!res.ok) return null;
      const body: unknown = await res.json();
      const obj = (body as { object?: { sha?: unknown } } | null)?.object;
      return typeof obj?.sha === 'string' ? obj.sha : null;
    } catch {
      return null;
    }
  }

  async #scanTags(repo: string, version: string): Promise<string | null> {
    try {
      const res = await this.#fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
        headers: this.#apiHeaders(),
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return null;
      const want = parseSemver(version);
      for (const entry of body) {
        const name = (entry as { name?: unknown } | null)?.name;
        if (typeof name !== 'string') continue;
        const got = parseSemver(name.replace(/^[^0-9]*/, ''));
        if (got && want && got[0] === want[0] && got[1] === want[1] && got[2] === want[2]) return name;
      }
      return null;
    } catch {
      return null;
    }
  }

  /* ── Tree listing (the one API call, cached forever) ───────────────────── */

  async #tree(repo: string, tag: string, sha: string | null): Promise<CachedTree> {
    const cached = await this.#readCache<CachedTree>(repo, tag, 'tree.json');
    if (cached && cached.version === 1 && Array.isArray(cached.entries)) return cached;

    const ref = sha ?? tag;
    const res = await this.#fetch(
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: this.#apiHeaders() },
    );
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const hint =
        res.status === 403 && remaining === '0'
          ? ' — GitHub API rate limit exhausted; set MODKIT_GITHUB_TOKEN'
          : '';
      throw new Error(`HTTP ${res.status}${hint}`);
    }
    const body: unknown = await res.json();
    const raw = (body as { tree?: unknown; truncated?: unknown; sha?: unknown } | null) ?? {};
    const entries: TreeEntry[] = [];
    if (Array.isArray(raw.tree)) {
      for (const item of raw.tree) {
        const e = item as { path?: unknown; type?: unknown; size?: unknown; sha?: unknown };
        if (typeof e.path !== 'string' || e.type !== 'blob') continue;
        entries.push({
          path: e.path,
          type: 'blob',
          size: typeof e.size === 'number' ? e.size : 0,
          sha: typeof e.sha === 'string' ? e.sha : '',
        });
      }
    }
    const tree: CachedTree = {
      version: 1,
      repo,
      tag,
      sha: typeof raw.sha === 'string' ? raw.sha : sha,
      truncated: raw.truncated === true,
      entries,
    };
    await this.#writeCache(repo, tag, 'tree.json', JSON.stringify(tree));
    return tree;
  }

  /* ── Selection ─────────────────────────────────────────────────────────── */

  async #select(
    repo: string,
    tag: TagResolution & { ok: true },
    tree: CachedTree,
    selection: SourceSelection,
  ): Promise<SourceBundle> {
    const maxTotal = selection.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const maxFiles = selection.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFile = selection.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const keywords = selection.keywords ?? [];
    const symbols = selection.symbols ?? [];

    const candidates = tree.entries
      .filter((e) => isCandidatePath(e.path, selection))
      .map((e) => ({ entry: e, score: scorePath(e, keywords, symbols, selection.paths ?? []) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

    const files: SourceFile[] = [];
    const omitted: Array<{ path: string; bytes: number }> = [];
    let total = 0;

    const take = async (candidate: { entry: TreeEntry; score: number }): Promise<boolean> => {
      if (files.length >= maxFiles) return false;
      const remaining = maxTotal - total;
      if (remaining < 2_000) return false;
      const text = await this.#blob(repo, tag.tag, candidate.entry.path);
      if (text === null) return false;
      const limit = Math.min(maxFile, remaining);
      const truncated = Buffer.byteLength(text, 'utf8') > limit;
      const kept = truncated ? `${truncateUtf8(text, limit - 120)}\n\n/* … truncated by modkit … */\n` : text;
      const bytes = Buffer.byteLength(kept, 'utf8');
      files.push({ path: candidate.entry.path, bytes, text: kept, truncated, score: candidate.score });
      total += bytes;
      return true;
    };

    // Pass 1 — best-scoring first, until the budget is spent.
    const deferred: Array<{ entry: TreeEntry; score: number }> = [];
    for (const candidate of candidates) {
      if (files.length >= maxFiles || total >= maxTotal - 2_000) {
        deferred.push(candidate);
        continue;
      }
      const took = await take(candidate);
      if (!took) deferred.push(candidate);
    }

    // Pass 2 — a symbol the patch must bind to that appears in none of the fetched text means the
    // scoring missed the file that defines it. Spend a little of what is left going to find it,
    // rather than handing the model a context that cannot answer its own question.
    const found = new Set<string>();
    const seen = files.map((f) => f.text).join('\n');
    for (const s of symbols) if (s && seen.includes(s)) found.add(s);
    let extraFetches = 0;
    if (symbols.length > found.size) {
      for (const candidate of [...deferred]) {
        if (extraFetches >= 8 || total >= maxTotal - 2_000) break;
        const text = await this.#blob(repo, tag.tag, candidate.entry.path);
        extraFetches += 1;
        if (text === null) continue;
        const hits = symbols.filter((s) => s && !found.has(s) && text.includes(s));
        if (hits.length === 0) continue;
        const remaining = maxTotal - total;
        const limit = Math.min(maxFile, remaining);
        const truncated = Buffer.byteLength(text, 'utf8') > limit;
        const kept = truncated ? `${truncateUtf8(text, limit - 120)}\n\n/* … truncated by modkit … */\n` : text;
        const bytes = Buffer.byteLength(kept, 'utf8');
        files.push({ path: candidate.entry.path, bytes, text: kept, truncated, score: candidate.score });
        total += bytes;
        for (const h of hits) found.add(h);
        deferred.splice(deferred.indexOf(candidate), 1);
      }
    }

    for (const d of deferred) omitted.push({ path: d.entry.path, bytes: d.entry.size });

    return {
      repo,
      tag: tag.tag,
      resolvedVia: tag.via,
      commitSha: tree.sha,
      files,
      totalBytes: total,
      omitted,
      treeTruncated: tree.truncated,
      symbolsFound: [...found],
      symbolsMissing: symbols.filter((s) => s && !found.has(s)),
    };
  }

  /** One file, over the CDN, cached write-once by `(repo, tag, path)`. */
  async #blob(repo: string, tag: string, path: string): Promise<string | null> {
    const key = `files/${encodeURIComponent(path)}`;
    const cached = await this.#readRaw(repo, tag, key);
    if (cached !== null) return cached;
    try {
      const res = await this.#fetch(this.#rawUrl(repo, tag, path), {
        headers: { 'user-agent': 'modkit-daemon' },
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const text = await res.text();
      await this.#writeCache(repo, tag, key, text);
      return text;
    } catch (e) {
      this.#log(`source: ${repo}@${tag}/${path}: ${(e as Error).message}`);
      return null;
    }
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────── */

  #apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'modkit-daemon',
    };
    if (this.#token) headers['authorization'] = `Bearer ${this.#token}`;
    return headers;
  }

  #rawUrl(repo: string, tag: string, path: string): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/${encodedPath}`;
  }

  /** A tag is immutable, so this directory never needs invalidating. */
  #cacheDir(repo: string, tag: string): string {
    const safe = `${repo.replace('/', '__')}@${tag}`.replace(/[^A-Za-z0-9._@-]/g, '_');
    return join(this.#stateDir, 'source', safe);
  }

  async #readRaw(repo: string, tag: string, key: string): Promise<string | null> {
    try {
      return await readFile(join(this.#cacheDir(repo, tag), key), 'utf8');
    } catch {
      return null;
    }
  }

  async #readCache<T>(repo: string, tag: string, key: string): Promise<T | null> {
    const raw = await this.#readRaw(repo, tag, key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async #writeCache(repo: string, tag: string, key: string, body: string): Promise<void> {
    try {
      const dest = join(this.#cacheDir(repo, tag), key);
      await mkdir(join(dest, '..'), { recursive: true, mode: 0o700 });
      const tmp = `${dest}.part`;
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, dest);
    } catch (e) {
      this.#log(`source: could not cache ${key}: ${(e as Error).message}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scoring
 * ──────────────────────────────────────────────────────────────────────────── */

function isCandidatePath(path: string, selection: SourceSelection): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (ALWAYS_WANTED.has(path)) return true;
  if (selection.includeStyles && base === 'styles.css') return true;
  if (PATH_EXCLUDE.some((re) => re.test(path))) return false;
  return SOURCE_EXT.test(base);
}

function scorePath(entry: TreeEntry, keywords: string[], symbols: string[], explicit: string[]): number {
  const path = entry.path;
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  if (explicit.includes(path)) return 5_000;
  if (path === 'manifest.json') return 4_000; // always: it is the version anchor
  if (path === 'package.json') return 500;
  if (base === 'styles.css') return 400;

  let score = 10;

  // The entry point is where the plugin class, its commands and its fields are declared. It is the
  // single most useful file in almost every plugin repo. A `main.js` anywhere else in the tree is a
  // built bundle (often of a *different*, vendored plugin) and earns no bonus at all.
  if (/^src\/main\.(ts|js|tsx|jsx)$/.test(lower)) score += 1_200;
  else if (/^main\.(ts|js|tsx|jsx)$/.test(lower)) score += 600;
  else if (base === 'index.ts' || base === 'index.js') score += 120;

  // A `.js` file sitting under a directory literally named "plugins" is someone else's built
  // bundle vendored into this repo (a sample vault, a demo, a fixture) — never the target's own
  // source, whatever its basename claims to be.
  if (/(^|\/)plugins\/.*\.js$/.test(lower)) score -= 5_000;

  for (const s of symbols) {
    if (!s) continue;
    const needle = s.toLowerCase();
    if (base.includes(needle)) score += 300;
    else if (lower.includes(needle)) score += 120;
  }

  for (const k of keywords) {
    if (base.includes(k)) score += 80;
    else if (lower.includes(k)) score += 30;
  }

  // Shallower is closer to the plugin's own structure; deep helper trees rarely carry the behaviour
  // a one-sentence request is about.
  const depth = path.split('/').length - 1;
  score += Math.max(0, 40 - depth * 12);

  // A very large file eats the budget that three useful ones would have used.
  if (entry.size > 80_000) score -= 200;
  else if (entry.size > 40_000) score -= 60;

  return score;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Cut on a character boundary: slicing bytes can split a multi-byte sequence.
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, maxBytes)).replace(/�+$/, '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Static hazard scan — the three silent-no-op classes, read off the source
 * ──────────────────────────────────────────────────────────────────────────── */

export type SourceHazardKind =
  /** `get member()` — `around()` reads through the getter and writes through the setter. Refuse. */
  | 'accessor'
  /** `this.member = this._member.bind(this)` — the bound copy is off the prototype call path. */
  | 'bound-at-construction'
  /** A module-local free function: no prototype handle exists, ever. Command registry or refuse. */
  | 'module-local'
  /** The symbol does not appear in the fetched source at all. */
  | 'not-found'
  /** `private` in the source; an ordinary patchable own property at runtime. Informational. */
  | 'private-modifier'
  /** Installed as a command callback — plane D is the only handle. */
  | 'command-callback';

export interface SourceHazard {
  kind: SourceHazardKind;
  symbol: string;
  path: string;
  /** 1-based. */
  line: number;
  excerpt: string;
  /** What it means for reachability, in one sentence, ready to go in the prompt. */
  note: string;
}

const HAZARD_NOTES: Record<SourceHazardKind, string> = {
  accessor:
    'declared as a getter — around() reads the property and then writes it, so patching it is not possible and this must be refused',
  'bound-at-construction':
    'bound with .bind(this) when the object was constructed, so the prototype method is off the call path and patching the prototype does nothing',
  'module-local':
    'a module-local free function with no prototype handle; only the command registry (plane D) can reach it, otherwise refuse',
  'not-found': 'not present anywhere in the fetched source at this tag',
  'private-modifier':
    "marked `private` in TypeScript, which is a compile-time fiction — at runtime it is an ordinary, patchable own property of the prototype",
  'command-callback':
    'registered as a command callback, so app.commands.commands["<pluginId>:<commandId>"] (plane D) is the handle',
};

/**
 * Read the fetched source for the three silent-no-op classes, plus two facts the model reliably gets
 * wrong on its own.
 *
 * This is **evidence, not a verdict.** It is a regex pass over one tagged snapshot, and it says so
 * in the prompt: a hazard here is a strong reason to refuse or to change plane, and its absence is
 * not a guarantee. The runtime pre-flight in the generated mod is what actually decides.
 *
 * Two of the findings exist because they are the model's own predictable errors:
 * `private-modifier` (it refuses reachable targets after reading `private` in the source) and
 * `command-callback` (it invents a prototype that never existed).
 */
export function scanHazards(
  bundle: SourceBundle,
  options: { member?: string | undefined; symbols?: string[] | undefined } = {},
): SourceHazard[] {
  const names = [...new Set([options.member, ...(options.symbols ?? [])].filter(Boolean))] as string[];
  if (names.length === 0) return [];

  const hazards: SourceHazard[] = [];
  const seenAnywhere = new Set<string>();

  for (const file of bundle.files) {
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trim();
      if (trimmed.length > 400) continue;

      for (const name of names) {
        if (!line.includes(name)) continue;
        seenAnywhere.add(name);
        const esc = escapeRe(name);

        const push = (kind: SourceHazardKind): void => {
          hazards.push({
            kind,
            symbol: name,
            path: file.path,
            line: i + 1,
            excerpt: trimmed.slice(0, 200),
            note: HAZARD_NOTES[kind],
          });
        };

        if (new RegExp(`\\bget\\s+${esc}\\s*\\(`).test(line)) push('accessor');
        if (new RegExp(`${esc}\\s*=\\s*this\\.[A-Za-z0-9_$]+\\.bind\\s*\\(\\s*this`).test(line)) {
          push('bound-at-construction');
        }
        if (new RegExp(`\\.bind\\s*\\(\\s*this\\s*\\)`).test(line) && new RegExp(`${esc}\\s*\\.bind`).test(line)) {
          push('bound-at-construction');
        }
        if (/^(export\s+)?(async\s+)?function\s/.test(trimmed) && new RegExp(`function\\s+${esc}\\b`).test(trimmed)) {
          push('module-local');
        }
        if (new RegExp(`\\bprivate\\s+(async\\s+)?${esc}\\s*[(:]`).test(line)) push('private-modifier');
        if (
          new RegExp(`(callback|checkCallback|editorCallback|editorCheckCallback)\\s*:\\s*${esc}\\b`).test(line)
        ) {
          push('command-callback');
        }
      }
    }
  }

  for (const name of names) {
    if (seenAnywhere.has(name)) continue;
    hazards.push({
      kind: 'not-found',
      symbol: name,
      path: '(none)',
      line: 0,
      excerpt: '',
      note: HAZARD_NOTES['not-found'],
    });
  }

  // De-duplicate: one line can match two patterns for the same name, and a repeated finding reads
  // as two independent pieces of evidence when it is one.
  const seen = new Set<string>();
  return hazards.filter((h) => {
    const key = `${h.kind}|${h.symbol}|${h.path}|${h.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
