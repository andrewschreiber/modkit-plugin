# Configuring modkit — a guide for agents

This file is written for a coding agent (Claude Code, Codex, or similar) that has been asked to
change how modkit is configured. It is the shortest path from "make modkit use opus" to the exact
file and key. A human can read it too, but the audience is a tool that wants an unambiguous answer.

## The one thing to understand first

**modkit is two programs**, and a setting lives in exactly one of them:

| | The daemon | The Obsidian plugin |
|---|---|---|
| What it is | a Node process on the user's Mac | a plugin inside Obsidian |
| What it decides | which model CLI runs, ports, budgets, key lifetimes | which daemon to talk to, what to do with a generated mod |
| Configured by | `modkit.config.json` or `MODKIT_*` env vars | Settings → modkit, stored in the vault's `data.json` |
| Changing it takes effect | on daemon restart (`npm run setup`) | immediately |

If you are asked to change *which model writes the mods*, that is a daemon setting — but the plugin
can override it per-vault. See [Choosing a backend and model](#choosing-a-backend-and-model).

## Daemon settings

Two equivalent surfaces, and **the environment always wins over the file**, so adding a config file
never changes an existing setup.

### The config file

`modkit.config.json` at the repo root, or wherever `MODKIT_CONFIG` points. Plain JSON object.
Unknown keys are a startup error naming the accepted set — a typo never silently does nothing.
Keys beginning `//` are ignored, so you can leave notes.

```json
{
  "// why": "this vault generates with opus and logs verbosely",
  "backend": "claude",
  "model": "opus",
  "logLevel": "debug"
}
```

`npm run setup` after editing, to restart the daemon.

### Every setting

| Config-file key | Environment variable | Default | What it does |
|---|---|---|---|
| `host` | `MODKIT_HOST` | `127.0.0.1` | Bind address. Wildcards (`0.0.0.0`) are refused outright. Use a tailnet IP for phone access. |
| `port` | `MODKIT_PORT` | `8501` | Listening port. |
| `stateDir` | `MODKIT_STATE_DIR` | `<repo>/.state/modkit` | Signing keys, token, job history, logs. |
| `concurrency` | `MODKIT_CONCURRENCY` | `1` | Generations at once. Each shells out to a model; 1 or 2 is sane. |
| `backend` | `MODKIT_BACKEND` | `claude` | `claude` or `codex`. `codex` additionally requires the acknowledgment below. |
| `model` | `MODKIT_MODEL` | `sonnet` (claude) / `""` (codex) | Model id. Empty means "let the CLI pick". |
| `codexAcknowledgeSandbox` | `MODKIT_CODEX_ACKNOWLEDGE_SANDBOX` | `false` | Required to use codex at all. **Read the warning below before setting it.** |
| `claudeBin` | `MODKIT_CLAUDE_BIN` | auto-detected | Absolute path to the `claude` CLI. Set this when auto-detection fails. |
| `codexBin` | `MODKIT_CODEX_BIN` | auto-detected | Absolute path to the `codex` CLI. |
| `jobRetention` | `MODKIT_JOB_RETENTION` | `200` | Terminal jobs kept before eviction. |
| `maxBodyBytes` | `MODKIT_MAX_BODY_BYTES` | `2097152` | Request body cap. The DOM-outline evidence blob is the only large field. |
| `artifactTtlHours` | `MODKIT_ARTIFACT_TTL_HOURS` | `72` | How long a signed artifact stays installable. |
| `certTtlDays` | `MODKIT_CERT_TTL_DAYS` | `30` | Signing-subkey certificate lifetime. |
| `certRenewBeforeDays` | `MODKIT_CERT_RENEW_BEFORE_DAYS` | `7` | Mint a fresh subkey this long before expiry. |
| `logLevel` | `MODKIT_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

The table above is generated against `CONFIG_KEYS` in `packages/modkit-daemon/src/state.ts`. If you
add a setting, add it there and it becomes file-configurable with no further code.

## Choosing a backend and model

Three places can decide, and they compose in this order (last wins):

1. **The daemon's own config** — `backend` / `model` above. The default for every vault.
2. **The vault's settings** — Settings → modkit → Model. Sends a per-request override. `Daemon's
   choice` (the default) sends nothing.
3. **Neither** overrides the safety gate below.

To make one vault use a different model without touching the daemon, use (2). To change it for
everything, use (1).

### The codex gate — do not route around this

`codex` is refused unless the daemon's operator sets `codexAcknowledgeSandbox` / 
`MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1` **in the daemon's own configuration**. Not in the plugin, not
in a request.

The reason is measured, not theoretical: under every sandbox flag codex-cli 0.152.0 offers,
`codex exec`'s shell tool can read **any file the daemon can read**. `--sandbox read-only` blocks
writes, not reads, and no flag on that version removes the shell tool. modkit's generation prompt
carries untrusted third-party plugin source, so a prompt injection there can exfiltrate arbitrary
files as the generation's output. The `claude` transport runs `--tools ''` and has no such path.

If a user asks you to "just make codex work", the correct action is to tell them what the
acknowledgment means and let them set it — not to patch the gate.

## Diagnosing "the model call failed"

Ask the daemon before guessing:

```sh
curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:8501/v1/model-check?deep=1'
```

or press **Check** in Settings → modkit → Model. The response distinguishes the three failures that
look identical from the outside:

- **`binPath: null`** — modkit cannot find the CLI. Its `searched` array lists every place it
  looked. Usually a PATH problem: the daemon inherits the PATH of whichever shell ran
  `npm run setup`, and the `claude` installer's `~/.local/bin` typically reaches PATH through a
  shell rc file the daemon never sources. Fix with `claudeBin` / `MODKIT_CLAUDE_BIN`.
- **`signedIn: false`** — the CLI is there but its session expired. Run the command in
  `loginCommand` (`claude login` or `codex login`). A generation that fails this way reports
  `model-auth` and is **not** retryable; retrying re-runs the same dead session.
- **`signedIn: null` with a `hint`** — something else failed. The hint carries the transport's own
  error; do not send the user to a login command for a network error.

`--version` succeeding proves nothing about auth. A CLI with a dead OAuth session answers it fine.
That is why `deep=1` spends one minimal model turn — it is the only definitive check.

## Plugin settings

Stored in the vault at `.obsidian/plugins/modkit/data.json` under `settings`, and editable in
Settings → modkit. The auth token is deliberately **not** in that file — it lives beside it in
`daemon-token.json`, mode 0600, and is stripped from the settings blob on every write.

| Key | Default | What it does |
|---|---|---|
| `daemonBaseUrl` | `http://127.0.0.1:8501` | Which daemon to talk to. |
| `daemonPubkey` | `""` | Pinned root Ed25519 key, 64 lowercase hex. |
| `requireSignature` | `true` | Refuse an artifact that does not verify. **Turning this off means arbitrary code from whatever answers on `daemonBaseUrl` is written into the vault.** |
| `reviewBeforeEnable` | `true` | Show the generated source and wait for approval. **This is the actual safety boundary** — the validator is a filter, not a gate. |
| `autoEnableGeneratedMods` | `true` | Turn a mod on as soon as it installs. |
| `modelBackend` | `""` | `""` (daemon's choice), `claude`, or `codex`. |
| `modelName` | `""` | Model id, or `""` for the daemon's. |
| `requestTimeoutMs` | `30000` | Per-HTTP-call timeout. Bounds one request, not a generation. |
| `debugLogging` | `false` | Verbose console output, and reveals the Phase-0 experiment command. |

Editing `data.json` by hand is supported — the plugin normalises field by field on load, so one bad
key falls back to its default rather than resetting the file. Obsidian must be restarted, or the
plugin toggled, for a hand edit to be picked up.

## Things not to do

- **Do not weaken `requireSignature` or `reviewBeforeEnable` to make something work.** They are the
  two controls that do not depend on a static analyser being complete.
- **Do not patch the codex gate.** See above.
- **Do not put secrets in `modkit.config.json`.** It is a normal tracked-adjacent file at the repo
  root; the token and signing keys live in `stateDir`, which is gitignored.
- **Do not add a second config parser.** The file is layered under the environment by
  `withConfigFile()` precisely so there is one validator.
