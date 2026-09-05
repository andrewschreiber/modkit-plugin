# modkit — design

**modkit** lets an agent write and edit software at runtime, from a plain-language request, in the
app you are already using.

The first product is an **Obsidian plugin that mods Obsidian plugins**: invoke a command, point at
what you want changed, describe the change, and a daemon generates a patch that installs and
enables itself without restarting the app.

Rewritten 2026-08-31 for that pivot. Prior revisions designed a self-modifying Capacitor host from
scratch; most of that work turned out to be rebuilding what Obsidian already provides. The
investigations that established it are in `research/`, and every superseded claim is in git
(`acc53d6` → `aa168a8`) — the corrections are recorded rather than erased, because several of them
are the reason this shape was chosen.

---

## 1. The ladder

The product has two halves, and only one of them generalizes.

**The agent half** — the UI, the daemon, the codegen pipeline, the patch template, the validator,
regeneration-from-intent, the safety apparatus. This is where the product risk lives, and it is
identical on every host.

**The host half** — a plugin runtime, module resolution, patch handles, a teardown contract, a
distribution channel. This does **not** generalize. It gets rebuilt per host class.

So the ladder is not "solve it once and widen." It is: **build the agent half against a host that
gives the host half away, then write host adapters.**

| Rung | Host cooperation | Given free | To build |
|---|---|---|---|
| **1. Obsidian** | total, by design | runtime, resolver, exported classes, reclaim contract, distribution, DOM planes | agent half only |
| **2. A Capacitor app whose developer installs modkit** | partial | DOM planes | host adapter + agent half |
| — Arbitrary Capacitor app | none | DOM planes | everything; target acquisition unsolved, and on iOS it needs re-signing someone's `.ipa` |
| **3. React Native** | none, and **no DOM** | almost nothing | see §1.2 |

### 1.1 Why rung 1 is not merely "easiest first"

Obsidian is the only place the actual product risk can be tested. **7,013 plugins update on other
people's schedules**, continuously — which is a live, adversarial, free test bed for the exact
failure the maintenance story must survive: a patch breaking because its target changed underneath
it. A host we control cannot produce that. Neither can a cooperating Capacitor app in month one.

### 1.2 React Native is a different problem, not a further one

RN removes the cheap planes entirely — no DOM means no CSS tier, no DOM decoration, no capture-phase
interception, which is most of what makes rungs 1 and 2 affordable. `wiki/joplin-mobile-plugins.md`
measured the consequence: Joplin mobile is React Native, and its plugins run in a hidden WebView
inside an opaque-origin sandboxed iframe, talking to the app over RPC, because a plugin cannot be in
a native UI even in principle. Its iOS-installable catalogue is **17 plugins**; Obsidian's is
**~5,100**. That gap is mostly the shell choice.

RN gives one thing back: Metro emits a runtime module registry rather than inlined ESM — the webpack
shape, which is what makes Vencord's source-rewrite technique available there. A trade, not a step.
Treat rung 3 as "and eventually," not as stage three of a plan.

---

## 2. What Obsidian gives us

Established by direct investigation; see `research/obsidian-patching.md` and
`research/obsidian-lifecycle.md` for the source citations.

- **A plugin runtime with live reload.** `app.plugins.disablePlugin(id)` + `enablePlugin(id)`.
  `pjeby/hot-reload` is a shipping proof that a plugin can be re-evaluated in a running app.
- **The leaf rule, enforced by architecture.** Plugin code is a leaf — the host imports nothing from
  it — so re-evaluating one is "evaluate a fresh module, discard the old object graph," never
  "re-point existing importers." That is why no restart is needed.
- **Host-supplied module resolution.** A plugin marks `obsidian` external; the host evaluates its
  CJS with a `require` the host controls. Imports resolve to the *running app*.
- **102 exported classes.** `Workspace.prototype` is the real prototype. Patch handles are stable,
  named, and minification-proof. For classes the API doesn't export, `instance.constructor.prototype`
  generalizes.
- **The `Component` reclaim contract.** `register`, `registerEvent`, `registerDomEvent`,
  `registerInterval`, `addChild`; and `Plugin`'s *entire* public surface is acquisitions the host
  owns and reclaims. There is no "take a reference and do as you like" in that API.
- **Distribution — in principle, and NOT in this vault today (measured 2026-08-31).** Plugins live in
  the vault, so a vault sync *can* carry them to every device. The vault this was measured in has
  `syncInternalFiles = false` and `usePluginSync = false`, so `.obsidian/` does not replicate at all:
  neither modkit nor a generated patch reaches the phone. This page previously asserted the general
  case as if it were the configured one — it was reasoning about how Obsidian works, never checked
  against how this vault is set up.
  Turning that sync on is the fix and it has a cost: `daemon-token.json` is a live bearer token and
  pinned key sitting in the plugin folder, so replication ships the credential to every device. The
  intended shape is `syncInternalFilesIgnorePatterns` for that one path plus a one-time manual paste
  on the phone — which is the case the manual path in §6 exists for, and why it was kept when desktop
  pairing became automatic.
- **`requestUrl()`** — HTTP/HTTPS "without any CORS restrictions," so the plugin can reach the daemon
  from desktop *and* mobile.
- **`DataAdapter.write`/`mkdir` + `vault.configDir`** — a plugin can create
  `.obsidian/plugins/<new-id>/main.js`.
- **An imperative DOM UI.** Patching a method changes what you see. On a React host that is three
  separate claims and two of them are false; here they coincide.

---

## 3. The patch model

**A mod is a new plugin that patches its target. We never rewrite anyone's `main.js`.**

```ts
const target = this.app.plugins.plugins["some-plugin"];
this.register(around(target.constructor.prototype, {
  someMethod(next) { return function (...args) { /* … */ return next.apply(this, args); }; }
}));
```

This is Hover Editor's exact technique — it already patches `SlidingPanesPlugin.prototype` — and it
buys everything that makes a mod a mod:

| | patch | rewriting their `main.js` |
|---|---|---|
| Reversible without a restart | yes | no |
| Individually listable and disable-able | yes | no |
| Survives the target updating, or fails loudly | yes | silently clobbered |
| Attributable | yes | you have forked a GPL plugin inside someone's vault |

The target may equally be **Obsidian's own UI** — most Obsidian customization is core patching, and
the machinery is identical. The element picker decides which.

### Generated code must go through the reclaim contract

Every acquisition uses `this.register(...)` / `registerDomEvent` / `registerInterval`, and every
patch is installed through `around()` so the uninstaller is registered. Obsidian can only *document*
this; a plugin calling `document.addEventListener` directly still leaks.

**modkit enforces it, because its author is a compiler.** The daemon-side validator parses the
pre-bundle source with `acorn` and rejects bare global access, assignment to host objects, raw
listeners or timers, unreachable targets (§4.2), and top-level statements other than exports. That
enforcement is the single structural advantage modkit has over the ecosystem it is joining, and over
hand-editing a `main.js`.

**And it has repeatedly been found fail-open, so do not read that as "the code is safe."** Three
adversarial review rounds have run against it (2026-08-31). Round one found ten bypasses. Round two
closed all ten — all fifteen replay fixtures now error — and found eleven more, of which six were
closed. The bypasses all have **one shape**: a rule that asks a question about a *name or a token* —
which identifier, which method, which holder — where the honest question is about **provenance**.
`const { prototype } = target.constructor; prototype.getTasks = fn` is the
same permanent patch of a foreign prototype as the direct form, expressed with one destructuring in
front of it, and a name-based rule cannot see the difference. Every hardening pass has been in the
one direction: replace name tests with "did this expression come from the host graph?", and
propagate that answer through locals, parameters, containers and returns to a fixed point.

The standing verdict, and it should stay in this document until it is false: **the validator is not
yet trustworthy enough to run generated code against a plugin you actually rely on.** It fails closed
on everything it models and open on everything it does not, and the boundary keeps moving outward
under review. Treat each round's clean sheet as "no bypass found by *this* attacker," never as
proof.

Use **`monkey-around`** rather than reimplementing wrapper semantics: it handles late-bound prototype
originals, static-property preservation, `dedupe` for duplicate installs, and mid-stack removal by
*neutering* rather than splicing — which matters here, because other plugins patch the same
prototypes and we are never the only patcher.

---

## 4. Target acquisition — the remaining hard problem

The plugin **instance** is reachable (`app.plugins.plugins[id]`), so its class prototype is. But
module-local functions inside the target's bundled `main.js` are not, and their `main.js` is built
output.

**The bridge: the community registry carries each plugin's repo URL.** The agent reads the target's
*source* to understand it, then targets the *runtime* shape. That is the source-symbol →
runtime-reference bridge, and it is tractable here only because the source is public.

**The rule that makes the bridge work, MEASURED in both installed bundles:** esbuild renames
*bindings* and preserves *member names* — `TasksPlugin` becomes `Dd`, but `getTasks` is still
`getTasks`. So **anything expressed as a class member is a stable handle; anything that is a
module-local binding is not.** That one sentence is the codegen prompt's reachability rule.

Consequences to design for:

- Some requests will be unreachable. The honest answer is to say so, not to fork the plugin.
- A patch that matches nothing must **say so** — Vencord's *"Patch by X had no effect"* is the
  breakage detector, and silence is the failure mode that poisons everything downstream. §4.2 makes
  this concrete: there are three ways to install a patch that throws nothing and does nothing.
- Patches carry a **target version range**, checked at load. Vencord's `fromBuild`/`toBuild`.
- Multi-part patches are **all-or-nothing** with rollback, so a half-applied patch never runs.

### 4.1 Five reach planes — this section said three until 2026-08-31

The original three were: exported class prototype, app-graph object, and
`instance.constructor.prototype`. Recon (the design notes §1.3) found that set incomplete
in a way that **falsified a stated milestone exit criterion**, so it is now five. The correction is
worth more than the tidy version: the missing plane was not an edge case, it was the only handle for
the one behaviour the plan had picked to demonstrate.

| | Plane | Handle | Robustness |
|---|---|---|---|
| **A** | exported class prototype | `Workspace.prototype`, from the `obsidian` module | most — named, stable, minification-proof |
| **B** | app-graph object | `app.workspace`, `app.vault.adapter`, … | high, but a live singleton rather than a class |
| **C** | foreign plugin class | `app.plugins.plugins[id].constructor.prototype` | good — member names survive esbuild |
| **D** | **command registry** | `app.commands.commands["<pluginId>:<commandId>"]` | good, but **INTERNAL** — absent from `obsidian.d.ts` |
| **E** | DOM / CSS | the rendered tree | least — no reclaim contract, no version gate |

They are encoded as data in `plugin/src/host/planes.ts`, not as branches in the generator, so the
daemon can reason about reach and the UI can say which plane a mod is using.

**Plane D is load-bearing, and here is what it cost to discover.** PLAN M1's exit criterion was
*"make Tasks' done-command also log to console."* That is **not reachable by prototype patching at
all.** Tasks registers the command with a module-local free function passed by *value*
(`obsidian-tasks@7.14.0:src/Commands/index.ts:27-32`):

```ts
plugin.addCommand({
    id: 'toggle-done',
    name: 'Toggle task done',
    editorCheckCallback: toggleDone,     // imported from ./ToggleDone, passed by value
});
```

In the shipped build `toggleDone` is the module-local binding `Rk`, inlined into a `Commands` class
that is never instantiated onto a reachable field. **There is no prototype handle for it, ever.**
The live `Command` *object* in `app.commands.commands` is the only handle that exists — and
patching that object's `editorCheckCallback` is ordinary `around()` work. Commander reads and writes
exactly this registry, so it is normal ecosystem practice rather than an exotic hack.

Plane D's cost is that it is undocumented: every hop from `app.commands` on must be optional-chained
and a missing hop must produce a refusal, not a throw.

### 4.2 Refusal is a correct outcome, and three silent no-ops make it mandatory

§4 used to gesture at "no-effect detection" abstractly. Recon turned that into three **structural**
failure modes, each of which installs cleanly, throws nothing, changes nothing, and reports success:

1. **`around()` cannot patch an ACCESSOR.** `around1` reads `const inherited = obj[method]` and then
   assigns `obj[method] = wrapper` (`monkey-around@3.0.0:index.ts:14,23`). Against a prototype
   getter the read *invokes* the getter and the write hits an own accessor with no setter. Both of
   this vault's candidate API surfaces are getters — `TasksPlugin.get apiV1()` (`src/main.ts:26`)
   and `QuickAdd.get api()` (`src/main.ts:27`).
2. **A method bound with `.bind(this)` at construction is off the prototype call path.** The bound
   copy was taken before the patch existed, so patching the prototype afterwards reaches nothing.
   This is true of **both Tasks renderers** — `InlineRenderer` and `QueryRenderer`, confirmed in the
   shipped build — which is its most UI-visible surface. Detection has to ask the *live instance*
   whether it shadows the member with its own copy; asking any other object does not answer the
   question.
3. **`around()` on a MISSING method silently creates it.** `around1` treats an absent method as
   inherited and the assignment *adds* the property. The patch fails only if something ever calls
   it — which may be never.

Detection uses `Object.getOwnPropertyDescriptor` walked up the prototype chain. It deliberately does
**not** use `in` or a bare property read: both report a healthy-looking `true` for an accessor, and
a bare read invokes the getter.

All three are now validator rules, refusing before anything is installed. **"I cannot reach that,
and here is why" is a correct answer, ranked above a patch that silently does nothing** — that third
number is the one PLAN M3 says must be zero.

### 4.3 A patch does not survive its *target* being reloaded

`around()` mutates the class object that exists now. `disablePlugin(id)` + `enablePlugin(id)`
re-evaluates the target's `main.js` and produces a **fresh class object with a fresh prototype** —
which is the same leaf rule from §2, seen from the losing side. The old prototype, and our wrapper on
it, becomes garbage: the mod goes **silently inert while still reporting itself as enabled.** This is
not exotic. QuickAdd ships a command that reloads a plugin, and every plugin update does it.

There is **no documented plugin-enable event** to hang re-application on — verified by enumerating
every `on(name: '…')` overload in `obsidian.d.ts`; Workspace, Vault and MetadataCache events exist
and none covers plugin lifecycle. So the supervisor (`plugin/src/host/supervisor.ts`) wraps the
INTERNAL `app.plugins.enablePlugin`/`disablePlugin` through `this.register()`, and falls back to a
`registerInterval` poll when those internals are absent. **That is the entire reason a supervisor
exists.**

⚠️ **The premise is UNVERIFIED against a real host.** That `enablePlugin` yields a fresh class object
is read from Obsidian's load path and from the leaf rule, not measured in a running app — and the
supervisor is a substantial piece of machinery built on top of it. **E2 measures it.** If it turns
out the class object is reused, the supervisor is over-engineering and should shrink.

---

## 5. Regeneration is the maintenance bet

A mod stores the **request that produced it**, the target plugin and its version, and its test. When
the target updates and the patch stops matching, the daemon does not repair the patch — it
regenerates from the original intent against the new source.

Two known weaknesses, both from review and both real:

1. **No independent oracle.** A test generated by the same model, from the same prompt, at the same
   time as the code, pins whatever the model operationalized. Mitigation: the user confirms the
   behaviour once; thereafter assertions freeze and only bindings regenerate.
2. **Isolation.** A per-mod test passing says nothing about whether the mod broke *the host* or
   another mod. The regression gate has to exercise the target's own behaviour with the mod mounted.

This is the claim rung 1 exists to test, against real update churn.

---

## 6. Trust, distribution eligibility, and what we are not deciding yet

### 6.1 Rung 1 is private-vault-only BY POLICY, not by choice

This section framed distribution as an App Store question until 2026-08-31. That was aiming at the
wrong gate. The binding constraint is one sentence in **Obsidian's own developer policies**:

> Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal
> releases.

**That is precisely modkit's shape.** modkit fetches generated code from a daemon and installs it as
a plugin, outside any release. So a community-registry submission is not merely deferred until it
"earns it" — as written, modkit is **ineligible**, and no amount of polish changes that. Any future
submission needs an actual answer, not a schedule: user-initiated per mod, locally inspectable before
enable, signed with a pinned key, and arguably with generation moved out of the plugin entirely.

This does not block anything now. Rung 1 targets one vault, which is exactly what the policy leaves
open. It does mean **"private first, then the registry if it earns it" was optimistic**, and the plan
should not carry a distribution milestone that assumes the door is ajar.

### 6.2 The threat model, still the largest open design gap

- **Generated code runs unsandboxed in the user's vault**, with `requestUrl` (no CORS) and full
  filesystem access through the adapter. For single-user v1 that is the same trust the user already
  extends to every community plugin. It is **not** acceptable for a shipped product: signing,
  provenance, review-before-enable, capability declaration.
- Signing is the one piece that exists. The daemon signs artifacts Ed25519 and the plugin verifies
  against a pinned key, proven end to end across both sides. **That is transport integrity, not
  safety** — it proves the bytes came from our daemon, and says nothing about what they do.
- **Modding other people's plugins has an attribution problem.** A user hits a bug and reports it to
  the plugin author. Vencord lives with this; the mitigation is that patches are visibly ours, named,
  and individually disable-able.
- **Where generation runs.** Daemon on the user's own Mac for v1; the plugin reaches it with `requestUrl`.
  Mobile generation is a toggle rather than a redesign, since `requestUrl` works there too.
- **Apple's App Store is not the gate here.** Desktop has none; on mobile the result arrives as an
  ordinary plugin by sync, which is how every Obsidian plugin already arrives. The App Store clauses
  in §7 start mattering at rung 2, where we ship a host.

---

## 7. Findings carried forward from the pre-pivot design

Kept because they cost real work to establish and remain true.

- **`monkey-around` is small enough to read in full** — stable `wrapper` identity, mutable `current`
  closure, removal by neutering. `research/obsidian-patching.md` §4. *That brief's heading says "60
  lines" and this bullet copied it; MEASURED 2026-08-31 at the pinned version it is **73 lines**
  (`pjeby/monkey-around@3.0.0` `index.ts`), ~35 once bundled. The brief is dated evidence and stays
  as written — the correction belongs here. The conclusion is unchanged, depend rather than vendor,
  but a load-bearing count should be the one you can `wc -l`.*
- **Vencord is the mechanism reference for hostile hosts** — string-rewrite webpack factory source
  before evaluation, with ownership tracking, no-effect warnings, build-range gates and group
  rollback. Its lever is webpack-specific and does not port to Vite/ESM. Relevant at rung 2+.
- **`Capacitor.Plugins` is not patchable** — get-trap-only proxy over an empty target; assignment is
  silently swallowed. The choke point is `cap.nativePromise`. `research/capacitor-bridge.md`. Rung 2.
- **ESM re-evaluation is walled only for code that other code imports.** A leaf can be re-evaluated
  live, indefinitely. This is the rule the whole design now rests on.
- **App Store**: the governing clauses are DPLA §3.3.1(B), Guideline 2.5.2 and — the one an earlier
  draft missed entirely — Guideline 4.7, which requires an Apple-reviewable index of downloaded
  software. Matters at rung 2, not rung 1. Note this is a *different and weaker* gate than §6.1's
  Obsidian developer policy, which binds at rung 1 today.

## 8. Build facts established by building it (2026-08-31)

Small, measured, and each one cost a failure or a near-miss to learn.

- **`external: [...builtinModules]` does NOT cover `node:`-prefixed imports.** Of Node 24's 72
  `builtinModules` entries only four carry the prefix (`node:sea`, `node:sqlite`, `node:test`,
  `node:test/reporters`); the rest are bare. Built against the sample's exact config, an entry
  importing `node:fs` **fails hard** — *"Could not resolve `node:fs`"* — rather than degrading. Good:
  it is loud. But models write `node:fs` by habit, so this is a validator rule, not a comment.
- **`monkey-around` is a dependency, not a vendored copy.** npm latest is `3.0.0` (MEASURED), it has
  no dependencies of its own, and it gets bundled into every generated patch while `obsidian`
  stays external. Copying 73 lines into the template to avoid a dependency would trade a version
  number for a fork.
- **Signature verification uses `@noble/ed25519`, not WebCrypto.** Obsidian mobile is a Capacitor
  app — a WebView with no node — so `require('crypto')` is not available there, and whether that
  WebView exposes WebCrypto's `Ed25519` algorithm is **UNVERIFIED**. `@noble/ed25519` is pure JS,
  zero-dependency, already proven on a Capacitor WebView in another project's mobile OTA verifier, and
  gives desktop and mobile a single code path. One import, one branch, no platform fork.
