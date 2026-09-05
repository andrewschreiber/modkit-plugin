/**
 * `registry.ts` — the id → repo bridge.
 *
 * modkit reads a target plugin's *source* to understand it, then targets the *runtime* shape. The
 * only thing standing between "the user picked `obsidian-tasks-plugin`" and "here is its source" is
 * the community registry, which carries one `repo` field per plugin. That single field is the whole
 * source bridge (DESIGN §4).
 *
 * Four properties this module exists to guarantee:
 *
 * 1. **The plugin never fetches the registry.** It is ~2.1 MB for a one-field lookup; pulling that
 *    through `requestUrl` on a phone is absurd. The plugin asks the daemon, which asks GitHub at
 *    most once every `ttlMs`.
 * 2. **Revalidate, do not re-download.** `raw.githubusercontent.com` serves this file with an
 *    `ETag`, and a conditional `If-None-Match` GET returns `304` with **zero bytes** — verified by
 *    measurement. A `304` is a touch of `fetchedAt`, nothing more.
 * 3. **Serve stale on failure.** A registry fetch failure degrades to "I cannot resolve source for
 *    this target right now" — never to a *wrong* repo, and never to blocking a target whose source
 *    is already cached. Silence beats a plausible wrong answer here, because a wrong repo produces
 *    a confidently-generated patch against someone else's code.
 * 4. **Only `repo` is taken from the registry.** Its `author` and `description` differ from the
 *    installed `manifest.json`'s — Tasks' registry author is the org, its manifest author is the
 *    people. Join on `id`, display the manifest's fields, use the registry for `repo` alone.
 *
 * The cached artefact is the **derived index**, not the raw payload: five fields per record, keyed
 * by id. Keeping the 2 MB original as well would double the disk for nothing, since every read this
 * daemon performs is a lookup by id.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A registry record. Measured over the whole file: exactly these five keys on **every** record, no
 * optional fields and no nesting.
 */
export interface RegistryRecord {
  id: string;
  name: string;
  author: string;
  description: string;
  /** `owner/name` — no scheme, no host, no trailing `.git`. Build the URL yourself. */
  repo: string;
}

/** What the cache knows about its own freshness. */
export interface RegistryState {
  etag: string | null;
  /** ISO-8601 UTC. Updated on a `200` *and* on a `304`, since a 304 confirms freshness. */
  fetchedAt: string;
  /** Records in the index. */
  count: number;
  /** Bytes of the payload the index was built from, for triage. */
  bytes: number;
}

/** The answer to one lookup, including how much to trust it. */
export interface RegistryLookup {
  record: RegistryRecord | null;
  /**
   * - `fresh` — the index was inside its TTL, or was just revalidated.
   * - `stale` — the network failed and this came out of a cache past its TTL. Usable, but a
   *   just-published plugin will be missing.
   * - `unavailable` — there is no index at all. `record` is always `null`.
   */
  freshness: 'fresh' | 'stale' | 'unavailable';
  state: RegistryState | null;
  /** Set when the last refresh failed. Carried so a refusal can name the real cause. */
  warning?: string;
}

export interface RegistryOptions {
  /** The daemon's `.state` root. The index lands at `<stateDir>/registry/index.json`. */
  stateDir: string;
  /**
   * How long an index is trusted before revalidation. The CDN's own `max-age=300` is the CDN's
   * concern, not a requirement on us: the file grows by tens of records a day, so 12 h is generous.
   */
  ttlMs?: number;
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export const COMMUNITY_PLUGINS_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

interface IndexFile {
  version: 1;
  etag: string | null;
  fetchedAt: string;
  bytes: number;
  records: Record<string, RegistryRecord>;
}

function isRecordShape(v: unknown): v is RegistryRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['id'] === 'string' && typeof r['repo'] === 'string';
}

export class PluginRegistry {
  readonly #stateDir: string;
  readonly #ttlMs: number;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  /** The loaded index, held in memory so a lookup never re-parses a megabyte of JSON. */
  #index: IndexFile | null = null;
  /** Single-flight: concurrent generations must not each pull 2 MB. */
  #inflight: Promise<void> | null = null;
  #lastError: string | null = null;

  constructor(options: RegistryOptions) {
    this.#stateDir = options.stateDir;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#url = options.url ?? COMMUNITY_PLUGINS_URL;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  get #indexPath(): string {
    return join(this.#stateDir, 'registry', 'index.json');
  }

  /** Resolve one plugin id. This is the only method the generation pipeline needs. */
  async lookup(id: string): Promise<RegistryLookup> {
    await this.ensureFresh();
    const index = this.#index;
    if (!index) {
      return {
        freshness: 'unavailable',
        record: null,
        state: null,
        ...(this.#lastError ? { warning: this.#lastError } : {}),
      };
    }
    const record = index.records[id] ?? null;
    const state = this.#state(index);
    const stale = this.#isStale(index);
    return {
      record,
      freshness: stale ? 'stale' : 'fresh',
      state,
      ...(stale && this.#lastError ? { warning: this.#lastError } : {}),
    };
  }

  /** The cache's current state, without touching the network. */
  state(): RegistryState | null {
    return this.#index ? this.#state(this.#index) : null;
  }

  /**
   * Load from disk if needed, then revalidate if past the TTL. Never throws: a failure leaves the
   * previous index in place and records why.
   */
  async ensureFresh(force = false): Promise<void> {
    if (this.#inflight) return this.#inflight;
    const work = this.#ensureFreshInner(force).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = work;
    return work;
  }

  async #ensureFreshInner(force: boolean): Promise<void> {
    if (!this.#index) await this.#load();
    if (!force && this.#index && !this.#isStale(this.#index)) return;
    await this.#revalidate();
  }

  async #load(): Promise<void> {
    try {
      const raw = await readFile(this.#indexPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const file = parsed as Partial<IndexFile>;
      if (file.version !== 1 || typeof file.records !== 'object' || file.records === null) return;
      this.#index = {
        version: 1,
        etag: typeof file.etag === 'string' ? file.etag : null,
        fetchedAt: typeof file.fetchedAt === 'string' ? file.fetchedAt : new Date(0).toISOString(),
        bytes: typeof file.bytes === 'number' ? file.bytes : 0,
        records: file.records as Record<string, RegistryRecord>,
      };
    } catch {
      // No cache yet, or an unreadable one. Either way the next revalidate builds it.
    }
  }

  #isStale(index: IndexFile): boolean {
    const age = this.#now() - Date.parse(index.fetchedAt);
    return !Number.isFinite(age) || age > this.#ttlMs;
  }

  #state(index: IndexFile): RegistryState {
    return {
      etag: index.etag,
      fetchedAt: index.fetchedAt,
      count: Object.keys(index.records).length,
      bytes: index.bytes,
    };
  }

  async #revalidate(): Promise<void> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'modkit-daemon',
    };
    // The whole point of the ETag: a fresh-enough file costs us zero bytes to confirm.
    if (this.#index?.etag) headers['if-none-match'] = this.#index.etag;

    try {
      const res = await this.#fetch(this.#url, { headers, redirect: 'follow' });

      if (res.status === 304 && this.#index) {
        this.#index = { ...this.#index, fetchedAt: new Date(this.#now()).toISOString() };
        this.#lastError = null;
        await this.#persist();
        this.#log(`registry: 304, index still current (${Object.keys(this.#index.records).length} records)`);
        return;
      }

      if (!res.ok) {
        this.#lastError = `registry fetch failed: HTTP ${res.status}`;
        this.#log(this.#lastError);
        return;
      }

      const body = await res.text();
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        // The top level is an array. If that ever stops being true, keeping the old index is
        // strictly better than building a wrong one.
        this.#lastError = 'registry payload was not a JSON array';
        this.#log(this.#lastError);
        return;
      }

      const records: Record<string, RegistryRecord> = {};
      for (const entry of parsed) {
        if (!isRecordShape(entry)) continue;
        records[entry.id] = {
          id: entry.id,
          name: typeof entry.name === 'string' ? entry.name : entry.id,
          author: typeof entry.author === 'string' ? entry.author : '',
          description: typeof entry.description === 'string' ? entry.description : '',
          repo: entry.repo,
        };
      }

      const count = Object.keys(records).length;
      if (count === 0) {
        this.#lastError = 'registry payload contained no usable records';
        this.#log(this.#lastError);
        return;
      }

      this.#index = {
        version: 1,
        etag: res.headers.get('etag'),
        fetchedAt: new Date(this.#now()).toISOString(),
        bytes: Buffer.byteLength(body, 'utf8'),
        records,
      };
      this.#lastError = null;
      await this.#persist();
      this.#log(`registry: refreshed, ${count} records`);
    } catch (e) {
      // Serve stale. The caller sees `freshness: 'stale'` and the reason.
      this.#lastError = `registry fetch failed: ${(e as Error).message}`;
      this.#log(this.#lastError);
    }
  }

  /** Atomic, so a crash mid-write cannot leave a half-parsed index behind. */
  async #persist(): Promise<void> {
    const index = this.#index;
    if (!index) return;
    try {
      const dir = join(this.#stateDir, 'registry');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.#indexPath}.part`;
      await writeFile(tmp, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#indexPath);
    } catch (e) {
      this.#log(`registry: could not persist index: ${(e as Error).message}`);
    }
  }
}
