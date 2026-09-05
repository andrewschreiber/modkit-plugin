# `templates/patch` — the shape every generated mod takes

A **patch** is a brand-new Obsidian plugin whose only job is to patch its target through Obsidian's
public API. modkit never rewrites anyone else's `main.js`.

## The template lives in `prompt.ts`, not in this directory

The template itself is `PATCH_PLUGIN_TEMPLATE` in
`packages/modkit-daemon/src/prompt.ts` — a plain-JavaScript template literal, not a file here. It
used to also exist as a hand-written TypeScript file at `templates/patch/main.ts`, with a comment
asking whoever edited one to keep the other in step by hand. That was two copies of one fact and no
mechanism enforcing the "by hand" part, so it drifted from `PATCH_PLUGIN_TEMPLATE` invisibly. The
TypeScript file is gone; `PATCH_PLUGIN_TEMPLATE` is the only template now.

**Why JS, and why `prompt.ts`, and not the other way round:**

1. **It is the exemplar the model is shown.** `PATCH_PLUGIN_TEMPLATE` is spliced directly into the
   system prompt — the model reads exactly these bytes, fills in the generation-time constants and
   the body of the wrapper marked `── the requested change goes here ──`, and inherits everything
   else already correct.
2. **It is the shape the daemon's validator enforces.**
   `packages/modkit-daemon/src/validate.ts` rejects generated code that departs from the rules
   below, by rule id. `packages/modkit-daemon/test/validate.test.mjs` asserts that
   `PATCH_PLUGIN_TEMPLATE` itself validates with **zero findings**, so the template and the
   validator cannot drift apart without a test going red.
3. **It has to be plain JavaScript**, because generated mods are plain JavaScript: acorn parses the
   exact text the model wrote, so every line and column in a validation finding is *true*.
   Validating a TypeScript source would mean validating the output of a transform, and every
   reported location becomes a lie. A hand-written TypeScript template can look authoritative while
   being neither what the model sees nor what the validator checks — which is exactly what
   `templates/patch/main.ts` was.

Since the model, the validator and the "documentation" all need to agree on the same bytes, keeping
them in one JS string in the one file that builds the prompt is the whole fix — there is nothing
left to keep "in step."

## What's still here

| File | What it is |
|---|---|
| `manifest.json` | The exemplar `manifest.json`. `isDesktopOnly` is **always** `false`: mods arrive on other devices by vault sync, and Obsidian mobile is a Capacitor WebView. |
| `README.md` | This file. |
| *(no `main.ts`/`main.js`)* | The template lives in `prompt.ts` — see above. |

This directory still matters at build time: `buildPatchPlugin()` points esbuild's `resolveDir` here,
so a generated mod's bare `monkey-around` import resolves from this directory (through the workspace
root's hoisted `node_modules`). The *enforced* dependency allowlist is the validator's
`import-not-allowed` rule; this is the second half of the same fence, not a substitute for it.

## The ordering, which is not negotiable

    version gate → L0 pre-flight → install inside this.register() → L2 verify → arm → L3 counter → Notice

Each step exists because *its absence is a silent failure* — a patch that installs, reports nothing,
and does nothing. That is the number PLAN §M3 says must be zero.

**1 · The version gate runs first.** Outside its range the mod installs nothing, raises a `Notice`,
reports `target-moved`, and **returns normally**. It never throws: a plugin that throws on load is a
plugin the user cannot see, and the maintenance story depends on a broken mod staying visible and
regenerable.

**2 · L0 pre-flight catches the three silent-no-op classes before anything installs.**

| Class | Why `around()` cannot do it | How the template detects it |
|---|---|---|
| **accessor** | `around()` reads the property then writes it back; a getter-only member is not patchable this way at all (Tasks `apiV1`, QuickAdd `api`). | `Object.getOwnPropertyDescriptor` walked up the chain by hand, then `desc.get \|\| desc.set`. A plain read would *invoke* the getter — a side effect we have no right to cause on a foreign object. |
| **bound at construction** | A method captured with `.bind(this)` when the object was built is off the prototype call path; patching the prototype afterwards changes nothing that is ever called. True of both Tasks renderers. | `Object.prototype.hasOwnProperty.call(target, member)` — an own property on the live object shadows the prototype. |
| **method missing** | `around()` on a missing method does **not** error. It *creates* the property and fails only when something calls it. | `descriptorFor()` returning `null`. |

A fourth, cheaper one is checked in the same block: a **non-writable, non-configurable** property.
esbuild's CJS output is not automatically strict, so the assignment inside `around()` would be
*swallowed* rather than throwing — a perfect silent no-op.

**Refusing is a correct outcome.** An honest "I cannot reach that, here is why" always beats a patch
that silently does nothing.

**3 · `around()` is installed directly inside `this.register(...)`.** Teardown becomes automatic and
order-independent. Obsidian's typings do not say whether registered callbacks run LIFO or FIFO, nor
whether a throwing one aborts the rest, so both are unspecified and `guardUninstall()` wraps every
uninstaller body in try/catch. The `around()` call still sits lexically inside `this.register(...)`
through that wrapper, which is what the validator's `patch-must-be-registered` rule requires; the
validator accepts exactly one level of wrapping.

**4 · The wrapper is inert until `armed` is set.** This is how a multi-member patch is
all-or-nothing *without* holding a rollback array. Every `around()` installs immediately and no
wrapper does anything until every check for every member has passed. A failed check therefore leaves
an inert pass-through and a loud health state, never a half-applied patch — and the inert wrappers
are still removed at unload, because they were registered.

**5 · L2 verifies the assignment actually took**, which is the only reliable catch for a write that
was swallowed rather than refused.

**6 · L3 counts invocations.** An `event-driven` mod that has not fired by `NO_EFFECT_DEADLINE_MS`
reports `no-effect` and says so. An `on-demand` mod arms no deadline, because a call count of zero is
expected there rather than a fault.

## Health, and how it reaches modkit

Five states, and only five — `applied`, `no-effect`, `target-moved`, `target-gone`, `error` (the
`ModHealthState` vocabulary from `@modkit/types`, restated locally because a mod may not import that
package).

Reporting is **both push and pull**, and both are best-effort:

```ts
// pull — modkit's mod list reads this. Keep the name and the shape.
modkitStatus(): { modId, state, detail, invocations, targetVersionSeen }

// push — modkit is told immediately, if modkit is there at all.
app.plugins.plugins["modkit"]?.modkitReportHealth?.(modId, status)
```

The push side is optional-chained twice and wrapped in try/catch, because a mod must keep working
with modkit disabled, uninstalled, or older than the method being called. Mods reach other devices by
vault sync, where modkit itself may not be installed.

`modkitProbe()` is the no-effect probe: zero arguments, returns a boolean, exercises the patched path
and asserts the observable difference. It is run once at install behind an explicit "verify now", and
on later loads once the user has confirmed the behaviour — at which point the assertion freezes and
only the binding regenerates. It is also the artifact that becomes the frozen regression test.

## Attribution

Modding other people's plugins has an attribution problem: a user hits a bug and reports it to the
plugin's author. The mitigation is that mods are **visibly ours, named, and individually
disable-able**.

- Every `Notice` leads with `MOD_LABEL`, which names the mod and its target.
- `manifest.json`'s `description` says what a mod is and how to remove it.
- The build stamps a banner at the top of `main.js` saying the same thing.
- A fault inside the mod's own change is caught, logged as
  `[<modId>] this modkit mod (not <target>) threw …`, and surfaced once per load. Errors raised by
  the **target** propagate untouched — they are the target's, and swallowing them would be worse than
  useless.
- Anything the mod puts in the DOM carries `data-modkit-mod`, which makes leak accounting a single
  `querySelectorAll` and makes every element attributable.

## The rules the validator enforces

Rule ids are part of the contract (`ValidationRuleId` in `@modkit/types`) — they appear in job
errors, in the mod list, and in whatever the user is shown when a generation is rejected.

- `import-not-allowed` — only `"obsidian"` and `"monkey-around"`. No node builtins, and **never** the
  `node:` prefix: esbuild's `external` list does not cover `node:`-prefixed specifiers and the build
  fails outright, quite apart from Obsidian mobile having no node.
- `no-top-level-side-effects` — module scope holds imports, `const` with a static initialiser,
  function declarations, and the one default-exported class. Nothing runs at load.
  *(This is why the class uses `declare` fields and assigns in `onload()`: a field with an
  initialiser makes esbuild emit a `__publicField` helper at module scope below ES2022.)*
- `no-bare-global` — no `document`, `window`, `setTimeout`, `fetch`, `require`, … Use
  `activeDocument` / `activeWindow` (documented Obsidian globals, and the popout-window-correct
  ones), `requestUrl` from `obsidian` for HTTP, and take everything else through
  `this.registerDomEvent(el, type, fn)` or `this.registerInterval(window.setInterval(fn, ms))`.
- `no-raw-timer`, `no-raw-listener` — the same rule from the other side. `addEventListener` is never
  acceptable; `registerDomEvent` is what Obsidian removes for you.
- `no-host-assignment` — never assign to a property of an object the mod does not own. Patch through
  `around()`. **The consequence inside a wrapper:** write `self.modkitBump()`, not
  `self.modkitCalls += 1`, because only an assignment rooted at `this` is accepted.
- `patch-must-be-registered` — `this.register(around(holder, {...}))`, or one wrapper call around it.
  Never captured into a variable and registered later.
- `no-dynamic-host-member` — index the host graph with **string literals only**. That is why
  `TARGET_ID` exists for messages while every use site spells the id out.
- `unguarded-internal-access` — `app.plugins`, `app.commands` and `app.viewRegistry` are absent from
  `obsidian.d.ts`. Every hop from one of them onward is `?.`, and a missing hop is a refusal path.
- `default-export-must-extend-plugin`, `missing-version-gate`, `missing-no-effect-probe`,
  `accessor-target`, `bound-method-target` — the structural contract above, checked statically.
- `no-eval` — no `eval`, no `new Function`, no dynamic `import()`.

## Reach planes

The template shows plane **C** — a foreign plugin's class via
`app.plugins.plugins[id].constructor.prototype` — because that is the default for modding another
plugin. The others differ only in how `holder` is obtained; everything after step 3 is identical.

| | Handle | Notes |
|---|---|---|
| **A** | `Workspace.prototype`, etc. | A class exported from the `obsidian` module. Public API, named, minification-proof. Best when it exists. |
| **B** | `app.vault.adapter`, `app.workspace` | A live object on the app graph. Narrowest blast radius. |
| **C** | `app.plugins.plugins["id"].constructor.prototype` | What this template shows. |
| **D** | `app.commands.commands["<pluginId>:<commandId>"]` | The command registry, patching whichever of `callback` / `checkCallback` / `editorCallback` / `editorCheckCallback` carries the implementation. **Load-bearing, not a convenience:** many plugin behaviours are module-local free functions installed as command callbacks and have no prototype handle at all. Patching the wrong callback property is a silent no-op, so the L0 pre-flight matters here more than anywhere. |
| **E** | DOM / CSS | Needs no runtime handle, so it is the right answer for "make this smaller / hidden / a different colour" — and the weakest binding to intent, because class names are unversioned. Use `activeDocument` and stamp `data-modkit-mod`. |

Preference order is A > B > C > D > E, except that a purely presentational request should go straight
to E.

## The reachability rule

esbuild renames **bindings** and preserves **member names**. `TasksPlugin` becomes `Dd`; `getTasks`
stays `getTasks`. Therefore:

> Anything expressed as a class member is a stable runtime handle. Anything that is a module-local
> binding is not.

Two corollaries the target's source will otherwise mislead you about:

- TypeScript `private` is a **compile-time fiction**. A `private` method is an ordinary, patchable own
  property of the prototype at runtime. Do not refuse a reachable target because the source marked it
  private.
- A module-local free function has no prototype handle, ever. If it is installed as a command
  callback, plane D reaches it. If it is not, **refuse**.
