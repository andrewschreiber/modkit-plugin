# modkit

An agent that writes and edits software at runtime, from a plain-language request, inside the app
you are already using.

**The first product is an Obsidian plugin that mods Obsidian plugins.** Invoke a command, point at
what you want changed, describe the change in a sentence. A daemon generates a *patch* that
installs and enables itself — no restart, no file paths, no terminal. It patches its target through
Obsidian's own API and never rewrites anyone's `main.js`, so every mod is listable, individually
disable-able, and reversible.

Those three properties are the *design*; they hold only for generated code that goes through the
reclaim contract, and keeping it there is the validator's job. See [What it can and cannot do
today](#what-it-can-and-cannot-do-today) — that job is not finished.

## Why Obsidian first

The product has two halves. The **agent half** — UI, daemon, codegen, validator,
regeneration-from-intent — is where the risk lives and is the same on every host. The **host half** —
plugin runtime, module resolution, patch handles, teardown contract, distribution — does not
generalize; it gets rebuilt per host.

Obsidian gives the host half away: 102 exported classes as stable patch handles, host-supplied
`require`, the `Component` reclaim contract, live per-plugin reload, and vault sync as a delivery
channel. It also provides something no host we control could — **7,013 plugins updating on other
people's schedules**, which is a free adversarial test bed for the one thing that must work: a patch
surviving its target changing underneath it.

Later rungs: a Capacitor app whose developer installs modkit, then possibly React Native. Those need
host adapters, not a generalization. See [DESIGN.md](DESIGN.md) §1.

## 60 seconds

Right-click something in Obsidian — a tab, a button, a panel — and choose **Customize…** (on a
phone, tap the stars in the ribbon and then the thing you want changed). Say what you want in a
sentence ("hide this," "make this red," "move this to the left"). modkit generates a patch, shows you
exactly what it's about to install and what it does, and you approve it. It applies immediately,
live, no restart. If nothing on screen matches what the patch was aimed at, the mod list says so on
that mod's row instead of pretending it worked. Changed your mind, or the app changed underneath it?
**Write it again** from the mod list regenerates the patch from your original sentence against
however the app looks now.

## Install on your Mac

You need:

- **Node ≥ 22.12** — `.nvmrc` pins the 22 line, so `nvm use` in this directory gets you a
  supported one. Newer works too; 22.12 is the floor the daemon is built and typed against.
- **A logged-in `claude` CLI, or `codex`** — modkit shells out to one of them to generate patches,
  the same way you'd use it from a terminal (see [Backends](#backends); Claude is the default)
- **Obsidian**, with a vault you're comfortable modding

```sh
git clone https://github.com/andrewschreiber/modkit-plugin.git
cd modkit-plugin
npm install
npm run setup
```

`npm run setup`:

1. **Builds** the plugin and the daemon.
2. **Installs the plugin** into your vault (`$OBSIDIAN_VAULT`, or `~/Documents/Obsidian Vault` by
   default — pass `--vault <path>` for a different one).
3. **Mints keys** — an Ed25519 keypair the daemon signs every patch with, and a bearer token — and
   hands them to the plugin over a local file, not a copy-paste.
4. **Starts the daemon** in your current login session (it needs that session to authenticate the
   model CLI; see the comments in `scripts/setup.mjs` if you're curious why).
5. **Proves it with one request** — health check, a signed round trip, an authenticated call — so
   "setup finished" means "it actually works," not just "files got copied."

Re-run `npm run setup` any time — after a reboot, after a rebuild, to check status
(`npm run setup:status`), or to tear it back down (`npm run reset`, which leaves the plugin and your
mods alone).

## Turn it on in Obsidian

**If you built it yourself** (above): Settings → Community plugins → turn on **modkit**. If Obsidian
was already open, hit the refresh button next to "Installed plugins" first so it notices the new
folder.

**Why there is no BRAT one-liner.** BRAT installs a plugin's three built files and nothing else,
and those three files on their own are not a working modkit: every request goes to a daemon that has
to run on *your* Mac, under a login session that can authenticate `claude` or `codex`. Anyone who
can satisfy that has a terminal and a clone already, and `npm run setup` puts the plugin in the vault
for them — so BRAT would add a second, worse install path that ends in a plugin that cannot reach
anything. Clone and run setup; it is the shorter road.

## On your phone

The daemon runs on your Mac; your phone reaches it over [Tailscale](https://tailscale.com/), which
also encrypts the connection (the plugin warns about plain HTTP off loopback for any other network).

1. **On the Mac,** bind the daemon to its tailnet address instead of loopback:

   ```sh
   npm run setup -- --tailnet        # or: --host <your-mac's-tailnet-ip>
   ```

   Setup prints the URL the phone should use and the daemon's bearer token.

2. **Get the plugin onto the phone.** Obsidian's own `.obsidian/` sync and LiveSync both skip plugin
   folders by default, so either turn on hidden-file / plugin sync in the sync tool you use, or
   install modkit on the phone the same way as on desktop (BRAT, once a release exists). If you do
   sync hidden files, exclude `.obsidian/plugins/modkit/daemon-token.json` — it is a live credential,
   and the token is meant to be typed once, not replicated.

3. **Pair once.** On the phone: Settings → modkit → **Daemon URL** (the tailnet URL from step 1),
   **Auth token** (paste it), then **Test connection**, which also pins the daemon's signing key.

4. Tap the stars in the ribbon, tap the thing you want changed, say what you want, review, done. The
   same command (**Mod this…**) is in the command palette.

**This path is new — it has not been loaded on a phone yet, by anyone.** It is the least-tested part
of modkit. Only CSS changes ship, which is also the part that behaves identically on desktop and
mobile; a report of what actually happens on a phone is genuinely useful.

## Backends

modkit talks to a model to generate patches. The default is **Claude**, via the `claude` CLI.

Three places can set it, and the later ones win:

1. **`modkit.config.json`** at the repo root — every daemon setting, in one file. Copy
   `modkit.config.example.json` to start; `AGENTS.md` documents every key.
2. **`MODKIT_*` environment variables** — the same settings, and they beat the file, so adding a
   config file never changes a setup that already works.
3. **Settings → modkit → Model** in Obsidian — a per-vault backend and model, so one vault can use
   a different model without touching the daemon.

```json
{ "backend": "claude", "model": "opus" }
```

**When a generation fails, ask before guessing.** Settings → modkit → Model → **Check** (or
`GET /v1/model-check?deep=1`) separates the three failures that look identical from the outside:
modkit cannot find your CLI (it reports every path it looked in — usually a PATH problem, since the
daemon inherits the PATH of whichever shell ran `npm run setup`), the CLI is there but signed out
(it tells you to run `claude login`), or something else broke. `--version` succeeding proves
nothing here: a CLI whose OAuth session expired answers it perfectly happily.

**Codex** (`codex exec`) works too, with one honest caveat you have to accept by name:

```sh
MODKIT_BACKEND=codex MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1 npm run setup
```

The daemon runs `codex exec` with `--sandbox read-only` and approvals off, which is the least
privilege codex-cli 0.152.0 offers — and measured, that still lets the model's shell tool **read
any file on the machine** during a generation. The `claude` transport runs with tools disabled and
has no such path. Until codex grows a "no shell tool" switch the daemon refuses `MODKIT_BACKEND=codex`
unless you set the acknowledgment, so turning it on is a deliberate act rather than a default.
`model` / `MODKIT_MODEL` is passed through to whichever backend is active; leave it unset for
codex's default. Choosing codex in Obsidian's settings is a *request* — the daemon still refuses it
without the acknowledgment, and says so on that screen rather than failing every generation.

## What it can and cannot do today

modkit is running in a real vault, and the thesis it exists to test — that a generated patch can
survive its target changing underneath it — is still untested. Concretely, as of this writing:

- **Modding Obsidian's own UI (CSS) ships.** This is what's behind Customize… today: hide something,
  recolor something, resize something. A CSS mod is a tiny plugin carrying a `styles.css`, which
  Obsidian applies to every window itself — including the separate Settings window — and removes
  when the mod is turned off.
- **modkit tells you when a mod does nothing.** After a mod is enabled it counts what its selector
  matches on screen and checks its stylesheet is actually attached. Zero matches shows up on the mod's
  row in Settings → modkit as "nothing on screen matches …" with **Write it again** beside it, and
  in a short notice — never as a silent "applied". Two of the first mods ever generated here did
  nothing for a day before anyone noticed; that is why this exists.
- **Modding a third-party plugin exists, but hasn't been proven yet.** The mechanism (patching a
  plugin's own prototype, the same technique [Hover
  Editor](https://github.com/nothingislost/obsidian-hover-editor) uses) works — a full install /
  remove / reload round trip against a real plugin passes every assertion that is attributable to the
  patch. But no generated patch has yet survived its target plugin receiving a real update, which is
  the whole point of the project. So in this release **Mod plugin…** only appears in the command
  palette when **Debug logging** is on in Settings → modkit. Treat it as experimental.
- **Every mod goes through a review screen first.** Before anything installs, you see the generated
  source and a plain-language description of what it does and what it can reach (network, other
  files, etc). Nothing installs without you looking at that and approving it. The validator that
  checks the generated code for the daemon is a second layer, not the boundary — the review screen
  is the boundary, and it defaults on.
- **Every mod is reversible.** Settings → modkit lists every mod you've installed; disable or delete
  any of them and Obsidian's own plugin-unload path tears down whatever it patched. modkit never
  rewrites another plugin's files, so uninstalling a mod can never corrupt what it modified.

## Safety

- **Signed, not just generated.** The daemon signs every patch (Ed25519) with a key pinned to your
  vault; the plugin refuses anything that doesn't verify.
- **A human reads it first.** The review screen is on by default and is the actual safety boundary —
  see above. Turning it off (Settings → modkit) is the one setting that removes that boundary.
- **Never rewrites anyone's `main.js`.** A mod is a *separate* plugin that patches its target through
  Obsidian's own API (`monkey-around`, the same library Hover Editor ships). Your other plugins, and
  Obsidian itself, are never edited on disk.
- **Unsandboxed, honestly.** Generated code runs with the same access any Obsidian plugin has —
  filesystem, network, everything. That is the same trust you already extend to every community
  plugin you install, not more, but it is not a sandbox. See [DESIGN.md](DESIGN.md) §6 for the full
  threat model and what isn't solved yet.

## Read next

- [DESIGN.md](DESIGN.md) — what and why
- [PLAN.md](PLAN.md) — in what order, and how we know each step worked
- `research/` — source investigations: how Obsidian plugins reach past the API, how they load and
  unload, and how Capacitor crosses the ESM gap
