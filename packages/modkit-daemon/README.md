# `@modkit/daemon`

The half of modkit that runs on your machine. The Obsidian plugin points at it, describes a change
in a sentence, and this process reads the target plugin's source, asks a model for a patch,
validates it, bundles it, signs it, and hands back a signed artifact the plugin installs into the
vault.

It speaks the contract in [`@modkit/types`](../modkit-types), over HTTP, on one local port.

---

## Setup — one command, then one click

```sh
npm install          # once, at the workspace root — creates the @modkit/* workspace links
npm run setup
```

That is the whole setup on the machine the daemon runs on. `setup` builds, installs the plugin into
your vault, mints the token and the Ed25519 keys if they do not exist, writes the sidecar file the
plugin reads, installs a LaunchAgent so the daemon is always running, and then **proves it works
by using it** — it waits for `/v1/health`, checks the public key the daemon serves is the one it
just pinned, makes an authenticated call with the token it just wrote, and confirms the same call
without the token is refused. It reports success on having *used* the files, never on having written
them.

What is left for you is the one step that is genuinely Obsidian's:

> **Obsidian → Settings → Community plugins → enable "modkit"**

Nothing to copy, nothing to paste, no key to pin.

```
npm run setup -- --vault <path>     # a vault other than $OBSIDIAN_VAULT / ~/Documents/Obsidian Vault
npm run setup -- --base-url <url>   # point the plugin at a daemon somewhere else (see The sidecar)
npm run setup -- --no-build         # set up whatever is already built
npm run setup -- --no-agent         # do not install or touch the LaunchAgent
npm run setup -- --rotate           # mint a NEW token and root key (invalidates every installed patch)
npm run setup:status                # report everything, change nothing
npm run reset                       # remove the agent and the credentials; keep the plugin + keys
```

Re-run `npm run setup` after any rebuild: it reinstalls the plugin, boots the old daemon out before
booting the new one in, and re-proves the result. That last part is the point — a stale daemon
serving old code while every file on disk looks correct is invisible from the outside.

### Running it by hand

The daemon is still just a process, and for development in a terminal that is often what you want:

```sh
npm run build --workspace=@modkit/daemon
npm run daemon              # == node packages/modkit-daemon/dist/index.js
```

Two things to know. It binds `127.0.0.1:8501`, so it will not start while the LaunchAgent holds the
port — `npm run reset`, or `launchctl bootout gui/$(id -u)/com.brain.modkit-daemon`, first. And on
its very first run in a fresh `.state/` it mints a token and prints it once:

```
  ┌─ modkit daemon ────────────────────────────────────────────────
  │  A new API token was minted. Paste it into the modkit plugin
  │  settings — it is shown here once and never logged.
  │
  │    mk_………
  │
  │  Stored 0600 at …/.state/modkit/daemon.token
  └────────────────────────────────────────────────────────────────
```

That banner is for the manual path below. On the desktop path you can ignore it: `setup` reads the
same file.

---

## The sidecar

The plugin needs two strings from the daemon: the **bearer token** for every route but
`/v1/health`, and the **root public key** it pins signatures against (the 64 hex characters on
`/v1/health` and in the `modkit daemon listening` log line).

### The desktop path — `npm run setup` (default)

The daemon and the plugin are the same uid on the same filesystem, so the token travels over a
`0600` file instead of over a human. `setup` writes exactly one file:

```
<vault>/.obsidian/plugins/modkit/daemon-token.json      0600
{
  "_note":            "…what this is, that it is live, and the LiveSync setting to check…",
  "version":          1,
  "baseUrl":          "http://127.0.0.1:8501",
  "token":            "mk_…",
  "pinnedPublicKey":  "…64 hex…",
  "pairedAt":         "2026-08-31T17:14:23.816Z",
  "pairedBy":         "modkit setup 0.1.0 on mac-mini"
}
```

It sits **beside** `data.json`, never inside it, and the plugin already reads it from there
(`plugin/src/settings/settings.ts`, `TOKEN_FILE_NAME`). `src/sidecar.ts` is the only writer;
`scripts/setup.mjs` calls it, then reads the bytes back and checks the mode before reporting
anything.

**This drops no security.** Every artifact is still Ed25519-signed by the daemon and still verified
against the pinned key by the plugin; the key just arrives over a same-uid filesystem channel rather
than a clipboard. Anything able to write that file could already write `main.js` into the vault
directly, which is strictly more power than handing modkit a token.

Precedence, because one field has a rule:

- **`token` and `pinnedPublicKey` are authoritative.** The file is the record of a completed
  setup, so a later run overwrites both, and the plugin prefers them over anything in its settings.
- **`baseUrl` is only a seed.** If you have deliberately pointed the plugin at a daemon on another
  box, a later `setup` run on this one will *not* silently drag it back to loopback — an existing
  non-default `baseUrl` is preserved, and `setup` says so. Pass `--base-url <url>` to repoint it on
  purpose.

Re-running `setup` is idempotent: it reuses the existing token and keys rather than minting new ones,
and prints `nothing changed but the timestamp` when that is the truth. Only `--rotate` mints fresh
secrets, and it moves the old ones aside rather than deleting them — every already-installed patch
pins the old root key and will stop verifying.

> ⚠️ **`daemon-token.json` is a live credential living inside your vault.** Today it is not
> replicated: Obsidian LiveSync's Customization sync only carries a plugin's `data.json`, which is
> exactly why the token is not in there. But **hidden-file sync (`syncInternalFiles`) carries
> everything under `.obsidian/`** — turning that on would push this token to every device on the
> vault. If you ever do, add `.obsidian/plugins/modkit/daemon-token.json` to
> `syncInternalFilesIgnorePatterns` first. The plugin's settings tab reads LiveSync's own settings
> and names the exposure when it sees it.

### The manual path — pasting, for a daemon that is NOT on this machine

**This is where the paste earns its place**, and it is the only case where it does: the daemon on
one box (say mac-mini) and the plugin on another device — a phone, or a second Mac — reaching it over
Tailscale. There is a real network hop, there is no shared filesystem, and a credential crossing it
by hand is the right shape.

1. Start the daemon on the host box, bound to an address the other device can reach:
   `MODKIT_HOST=<tailnet-ip> npm run daemon`. (A wildcard bind is refused at startup.)
2. Read the two strings: the token from the first-run banner or from
   `.state/modkit/daemon.token`, and the root pubkey from the `modkit daemon listening` log line or
   from `curl http://<host>:8501/v1/health`.
3. On the device: Obsidian → Settings → modkit → set the daemon URL, paste the API token, paste the
   pinned key, then **Test connection**.

The token is printed once and never logged again; if you lose it, read
`.state/modkit/daemon.token`, or delete that file and restart to mint a new one (which invalidates
the old one everywhere).

### The LaunchAgent — `com.brain.modkit-daemon`

`setup` installs `~/Library/LaunchAgents/com.brain.modkit-daemon.plist` (skip with `--no-agent`,
remove with `npm run reset`; `node scripts/launchagent.mjs install|uninstall|status|node` drives it
directly). `RunAtLoad` + `KeepAlive`, logging to `.state/modkit/logs/daemon.{out,err}.log`, which
`setup` pre-creates `0600` — launchd would create them `0644`, and the first-run token banner goes to
stdout.

Two details that are the difference between working and failing silently:

- **The plist names an absolute `node`, resolved and executed at install time.** `node` on a Mac
  with nvm is a shell function; the first real `node` on `PATH` here is v20.17.0 while the daemon's
  `engines` demand `>=22.12`, and launchd reads no shell config at all. So the installer runs
  `<node> -v` on each candidate, and then *imports the daemon's own entry module* under it, before
  writing the path into the plist. A wrong node fails at boot and presents as "daemon unreachable".
- **The `PATH` in the plist is built, not inherited.** launchd gives a job almost no environment,
  and the daemon shells out to the `claude` CLI — so the installer resolves `claude`, puts its
  directory on the plist's `PATH` explicitly, and says where it found it (or warns that it did not).

### Configuration

All environment variables, all optional.

| Variable | Default | Notes |
|---|---|---|
| `MODKIT_HOST` | `127.0.0.1` | A wildcard (`0.0.0.0`, `::`) is **refused at startup**, not silently accepted. |
| `MODKIT_PORT` | `8501` | Measured free on this box; `8482`–`8500` are the brain hub band. |
| `MODKIT_STATE_DIR` | `<repo>/.state/modkit` | See below. |
| `MODKIT_CONCURRENCY` | `1` | Each running job is a model call with a real budget. |
| `MODKIT_MODEL` | `sonnet` | Reported on `/v1/health`; the generator decides what to do with it. |
| `MODKIT_JOB_RETENTION` | `200` | Terminal jobs kept, in memory and on disk. |
| `MODKIT_MAX_BODY_BYTES` | `2097152` | The DOM outline from the element picker is the only large field. |
| `MODKIT_ARTIFACT_TTL_HOURS` | `72` | How long a signed artifact stays installable. |
| `MODKIT_CERT_TTL_DAYS` | `30` | Lifetime of a signing-subkey delegation. |
| `MODKIT_CERT_RENEW_BEFORE_DAYS` | `7` | Rotate the subkey this long before the cert expires. |
| `MODKIT_LOG_LEVEL` | `info` | `debug` logs one line per request. |

---

## Routes

`GET /v1/health` is the only unauthenticated route. Everything else needs
`Authorization: Bearer <token>`; the comparison is constant-time, including on a length mismatch.

| Method | Route | Body in | Out |
|---|---|---|---|
| `GET` | `/v1/health` | — | `HealthResponse` — version, protocol, model, uptime, **root** pubkey |
| `POST` | `/v1/generate` | `GenerateRequest` | `202 JobAccepted` |
| `POST` | `/v1/regenerate` | `RegenerateRequest` | `202 JobAccepted` |
| `GET` | `/v1/jobs` | — | `{protocol, jobs: Job[]}` |
| `GET` | `/v1/jobs/:id` | — | `Job` |
| `POST` | `/v1/jobs/:id/cancel` | — | `{protocol, cancelled, job}` |
| `GET` | `/v1/mods` | — | `ModsResponse` |
| `POST` | `/v1/validate` | `ValidateRequest` | `ValidationReport` (dev-only introspection) |

Every non-2xx has the same body, `ApiErrorResponse`, with a machine-readable `code`.

**Generation is asynchronous and that is not negotiable.** It takes seconds to minutes, so
`/v1/generate` returns a job id in milliseconds and the plugin polls `/v1/jobs/:id`, rendering
`progress.message` in a `Notice`. A synchronous route would sit inside `requestUrl`'s socket for
minutes with nothing to show.

Three job outcomes, and the middle one is not a failure:

- `done` — an artifact was built and signed.
- `refused` — modkit *declined*, with a reason. An honest "I cannot reach that, here is why" is a
  correct outcome; a patch that silently does nothing is not.
- `failed` — modkit broke. `error.code` says how, and `error.retryable` says whether the identical
  request could plausibly succeed again.

Retries are safe: `idempotencyKey` is honoured, so a repeat of a request whose response was lost
returns the existing job (`deduped: true`) rather than buying a second model call.

---

## State

Everything lives under `.state/modkit/` (gitignored, `0700`, per-box — never committed, never
synced):

```
daemon.token            0600  the bearer token
secrets/root.key        0600  long-lived; signs delegation certificates and nothing else
secrets/sign.key        0600  short-lived subkey; signs artifacts and nothing else
secrets/cert.json       0600  the current delegation certificate
jobs/<jobId>.json       0600  written on every status change
mods/<modId>/…          0600  request.json (the regeneration seed), artifact, payload, main.js, manifest
registry/               0700  community-registry cache
logs/modkit.log         0600  JSON lines, rotated at 8 MB, one generation
tokens.jsonl            0600  one row per model call — the spend ledger
```

The permissions are re-asserted on every start, because `mkdir`'s mode only applies at creation: a
directory left `0755` by an earlier build stays world-readable forever otherwise.

A job that was running when the daemon stopped is **not** resumed — the model call died with the
process. Restore marks it `failed` and says so, because a job left `generating` forever is the one
state a polling client waits on indefinitely.

---

## Signing

Ed25519, two keys.

- The **root** key signs a short-lived **delegation certificate** naming a signing subkey, and
  nothing else.
- The **subkey** signs artifacts, and nothing else. It rotates on its own, seven days before the
  certificate expires, with no setting to change on any device.
- The plugin pins only the **root** public key — the 64 hex characters on `/v1/health`.

The plugin verifies with `@noble/ed25519` rather than `node:crypto`, because Obsidian mobile is a
Capacitor WebView with no node. The daemon runs the same verification on every artifact **before
returning it**: a mismatch caught here is a log line, and the same mismatch caught on the device is
silence.

Artifact expiry is clamped to the certificate's, so an artifact can never outlive the delegation
that authorises it.

---

## Trusting this daemon

Say it plainly, because the rest of the design depends on it being understood:

**This process runs a language model and writes the code it produces into your Obsidian vault, where
Obsidian executes it unsandboxed** — with `requestUrl` (no CORS) and full filesystem access through
the vault adapter. That is the same trust you already extend to every community plugin you install,
and for a single user's own vault it is a reasonable trade. It is **not** acceptable for a shipped
product, and closing that gap — review-before-enable, declared capabilities, a real threat model —
is explicitly open work (PLAN §M5).

Concretely, what this daemon does to limit the blast radius:

- It binds one **named** address, never a wildcard, and refuses to start if you configure one.
- Every route but `/v1/health` requires a bearer token, so another process on the same box cannot
  ask it to generate and sign code.
- The signing keys are `0600` in `.state/`, are never written anywhere else, and are excluded from
  git by both `*.key` and `.state/`.
- Nothing it generates reaches a vault unverified: it signs, then verifies its own output, and the
  plugin verifies again against a key it pinned.
- Generated code is validated against the `Component` reclaim contract before it is bundled — no
  bare globals, no raw listeners or timers, no assignment to host objects, every patch installed
  through `around()` inside `this.register(...)`. Code that fails is not shipped with a warning; it
  is not shipped.

What it deliberately does **not** do: sandbox the generated plugin, review it for you, or claim the
model's output is safe because it validated.

---

## Layout

| File | What it owns |
|---|---|
| `src/index.ts` | Composition root, listening, graceful shutdown. Importing it starts nothing. |
| `src/server.ts` | `node:http` routing, path normalisation, body caps, the error shape. |
| `src/jobs.ts` | The job queue: concurrency, idempotency, progress, cancellation, retention. |
| `src/sign.ts` | The keyring, artifact signing, and the daemon-side mirror of the plugin's verifier. |
| `src/auth.ts` | Token minting and constant-time bearer comparison. |
| `src/sidecar.ts` | The sidecar contract: writing `daemon-token.json` into a vault, and the `baseUrl` precedence rule. |
| `src/state.ts` | `.state/modkit` layout, atomic private writes, config. |
| `src/log.ts` | JSON-line logging, redaction, rotation. |
| `src/generate.ts` | The generation pipeline (prompting, source, registry, validate, build). |
| `src/validate.ts` | The generated-code validator. |

`index.ts` imports the last two through a **variable specifier**, so the daemon still starts,
serves `/v1/health`, and reports honestly when they are absent — rather than failing to build.
