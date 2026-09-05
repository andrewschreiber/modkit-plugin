/**
 * `prompt.ts` — what the model is told, and the shape of what it must say back.
 *
 * This module is deliberately dependency-free at runtime (types only) and pure: everything here is
 * `(input) -> string`, so it can be unit-tested without a network, a model, or a vault. That is the
 * property that made its ancestor — an earlier app's customize prompt builder — the most portable thing in
 * that codebase, and it is the property worth keeping.
 *
 * ## What was carried over from that earlier prompt, and why
 *
 * - **Segment order: identity → target → evidence → the user's words → the required output shape.**
 *   The request is the last thing before the ask, so it is closest to the answer.
 * - **The user's sentence is never rewritten, summarised or normalised.** It is the durable artifact
 *   of the whole product: it is stored with the mod and it is what regeneration runs against when
 *   the target moves. Every other segment may degrade; this one may not.
 * - **One owner for the byte budget.** Several independent features (source, evidence, hazards)
 *   compete for one budget and none can see the others, so the fixed segments are measured *first*
 *   and the remainder is handed to the degradable ones in a fixed order.
 * - **A degradation ladder, not a truncation.** Dropping the child skeleton costs the model nothing
 *   it cannot re-derive; dropping an element's text costs it the identity of the thing the user
 *   pointed at. So they go in that order, and the last rung still *says* that something was dropped
 *   — an agent told nothing edits the wrong thing.
 * - **`clean()` on every field at serialize time**, even fields the capturing side already cleaned.
 *   One unsanitised field is one leaked bearer token in a prompt that gets logged.
 *
 * ## What was deliberately reversed
 *
 * That prompt is one line under 4096 bytes because its transport is a TUI where a newline is the
 * submit key. Ours goes to `claude -p` on stdin: newlines are free, and the budget is the model's
 * context rather than a hub's request cap. So the one-line rule and the 4 KB cap are dropped, and
 * the ladder is repointed at what is actually large here — the target's source.
 */

import type {
  ClientEnvironment,
  CommandCallbackProperty,
  ElementEvidence,
  NoEffectPolicy,
  PickEvidence,
  ReachTarget,
  RefusalReason,
  RegenerationOrigin,
  TargetRef,
  TargetVersionRange,
  ValidationFinding,
} from '@modkit/types';
import { REACH_PLANE_LABELS, targetVersion } from '@modkit/types';

import type { SourceBundle, SourceHazard } from './source.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Sanitisation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Copied rather than imported, so this module stays runtime-dependency-free and unit-testable. The
 * duplication is the point: a redaction table that lives behind an import is a redaction table that
 * gets dropped by a refactor nobody connected to the prompt.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer «redacted»'],
  [/([?&](?:t|token|key)=)[^&\s"']+/gi, '$1«redacted»'],
  [/\b[0-9a-f]{24,}\b/gi, '«hex»'],
];

function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Redact, flatten, cap. The ellipsis is U+2026 — three bytes, which is why everything measures with `textBytes`. */
export function clean(s: string, max: number): string {
  let t = String(s);
  for (const [re, to] of REDACTIONS) t = t.replace(re, to);
  t = stripControl(t).replace(/\s+/g, ' ').trim();
  t = t.replace(/["\\[\]]/g, "'");
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/** Bytes, never `.length`. A multi-byte character is one character and three bytes. */
export function textBytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/* ────────────────────────────────────────────────────────────────────────────
 * The template the output must conform to
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The canonical patch.
 *
 * This is the single most load-bearing string in the daemon: it is simultaneously the shape the
 * validator enforces, the safety apparatus the mod carries at runtime, and the only example the
 * model gets. Every construct in it is there for a reason that is written next to it, because a
 * template whose rules are unexplained is a template the model will "improve".
 *
 * Ordering is non-negotiable and is asserted by the validator: **gate → L0 pre-flight → install
 * inside `this.register()` → L2 verify → arm → L3 counter → Notice.**
 *
 * Two shapes here are subtler than they look:
 *
 * 1. **`around()` sits DIRECTLY inside `this.register(...)`** rather than being captured into a
 *    variable and registered later. That is what makes it impossible to install a patch whose
 *    uninstaller is never registered — the validator's `patch-must-be-registered` rule is a lexical
 *    check, and this is the shape that satisfies it.
 * 2. **The wrapper is a pass-through until `armed` is set.** That is how a patch is all-or-nothing
 *    *without* holding a rollback array: every `around()` installs immediately, and nothing in any
 *    wrapper does anything until every check for every member has passed. A failed check therefore
 *    leaves an inert wrapper and a loud health state, never a half-applied patch.
 *
 * This is the template, full stop — there is no separate hand-written TypeScript source it has to
 * be kept in step with. It used to be projected from `templates/patch/main.ts`, but that file was
 * never what shipped: this string is what the model sees and what the validator checks, so a hand
 * copy that only *looked* authoritative was a second place the two could silently drift. The
 * `modkit*` member names are the contract modkit's mod list reads — `modkitStatus()`,
 * `modkitProbe()`, `modkitPublish()` — so a rename here has to stay consistent with the mod list on
 * its own. `PromptInput.templateSource` overrides this at runtime if a caller has a better copy.
 *
 * ⚠️ **No backtick may appear anywhere inside this literal.** It is a raw template literal, so a
 * backtick in one of its comments silently ends it and the rest of the file becomes a syntax error
 * — twice during authoring, both times from a comment quoting an identifier. Use "double quotes".
 */
export const PATCH_PLUGIN_TEMPLATE = String.raw`import { Notice, Plugin, requireApiVersion } from "obsidian";
import { around } from "monkey-around";

/* ── Generation-time facts. Every one is re-asserted at load, before anything is installed. ── */
const MOD_ID = "modkit-mod-tasks-count-a91c";
const MOD_LABEL = "Mod: Tasks — announce the task count";
const TARGET_LABEL = "Tasks";
const TARGET_MEMBER = "getTasks";
const VERSION_FROM = "7.14.0";
const VERSION_TO = "";                 /* "" means open-ended */
const APP_MIN_VERSION = "1.7.2";
const NO_EFFECT_MODE = "on-demand";    /* or "event-driven" */
const NO_EFFECT_DEADLINE_MS = 30000;

function semverRank(v) {
  /* Ranked rather than compared field-by-field so there is no computed indexing anywhere in this
     file — a validator that rejects computed access on the host graph should not have to tell
     locals apart to let this through. Pre-release suffixes are ignored on purpose; five digits per
     field is far more than any plugin uses. */
  const parts = String(v).split("-")[0].split(".").concat(["0", "0", "0"]).slice(0, 3);
  let rank = 0;
  for (const part of parts) rank = rank * 100000 + (Number(part) || 0);
  return rank;
}

function cmpSemver(a, b) {
  const ra = semverRank(a);
  const rb = semverRank(b);
  if (ra < rb) return -1;
  return ra > rb ? 1 : 0;
}

function descriptorFor(holder, name) {
  /* Walk the chain by hand. Both "name in holder" and a bare read report a healthy-looking value
     for an accessor, and a bare read INVOKES the getter. */
  let o = holder;
  while (o) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return d;
    o = Object.getPrototypeOf(o);
  }
  return null;
}

export default class ModkitMod extends Plugin {
  async onload() {
    this.modkitCalls = 0;
    /* Calls modkit induced by probing, kept apart from the ones the app made. Only modkitCalls is
       evidence that the patched path is live in normal use. */
    this.modkitProbeCalls = 0;
    this.modkitProbing = false;
    this.modkitArmed = false;
    this.modkitFaulted = false;
    this.modkitVersionSeen = null;
    this.modkitHealth = { state: "target-gone", detail: "not checked yet" };

    /* 1 ── the version gate. Runs FIRST, before the first around() call. */
    if (!requireApiVersion(APP_MIN_VERSION)) {
      this.modkitHalt("target-moved", "needs Obsidian " + APP_MIN_VERSION);
      return;
    }
    const version = this.modkitTargetVersion();
    this.modkitVersionSeen = version;
    if (version === null) {
      this.modkitHalt("target-gone", TARGET_LABEL + " is not installed or not enabled");
      return;
    }
    if (cmpSemver(version, VERSION_FROM) < 0) {
      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is below " + VERSION_FROM);
      return;
    }
    if (VERSION_TO && cmpSemver(version, VERSION_TO) >= 0) {
      this.modkitHalt("target-moved", TARGET_LABEL + " " + version + " is at or past " + VERSION_TO);
      return;
    }

    /* 2 ── the handle. Literal ids only, and every hop optional-chained: app.plugins is
       undocumented and may simply not be there. */
    const target = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
    if (!target) {
      this.modkitHalt("target-gone", TARGET_LABEL + " is not enabled");
      return;
    }
    const holder = target.constructor?.prototype;
    if (!holder) {
      this.modkitHalt("target-gone", "the target class has no prototype");
      return;
    }

    /* 3 ── L0 pre-flight: the three silent no-op classes, each caught BEFORE anything installs. */
    const desc = descriptorFor(holder, TARGET_MEMBER);
    if (!desc) {
      this.modkitHalt("target-moved", TARGET_MEMBER + "() is not on the target any more");
      return;
    }
    if (desc.get || desc.set) {
      this.modkitHalt("error", TARGET_MEMBER + " is an accessor — around() cannot patch it");
      return;
    }
    if (typeof desc.value !== "function") {
      this.modkitHalt("target-moved", TARGET_MEMBER + " is not a function");
      return;
    }
    if (desc.writable === false && desc.configurable === false) {
      this.modkitHalt("error", TARGET_MEMBER + " is non-writable — the patch would be swallowed");
      return;
    }
    /* The bound-at-construction class, caught at RUNTIME rather than guessed from source: if the
       live object shadows the member with its own copy (this.x = this._x.bind(this) in a
       constructor or a class-field initialiser), the prototype is off the call path and patching it
       would install cleanly and change nothing. */
    if (Object.prototype.hasOwnProperty.call(target, TARGET_MEMBER)) {
      this.modkitHalt(
        "error",
        TARGET_MEMBER + " is shadowed by a bound copy on the live object — patching the prototype would do nothing",
      );
      return;
    }
    const baseRef = desc.value;

    /* 4 ── install. around() goes DIRECTLY inside this.register(), so the uninstaller can never be
       dropped. The wrapper stays a pass-through until step 5 arms it, which is how a multi-member
       patch is all-or-nothing without holding uninstallers of its own. */
    const self = this;
    this.register(
      around(holder, {
        getTasks(next) {
          return function (...args) {
            if (!self.modkitArmed) return next.apply(this, args);
            self.modkitBump();
            const result = next.apply(this, args);
            try {
              /* ── the requested change goes here ── */
            } catch (err) {
              /* A fault in OUR change must never take the target down with it, and must be
                 attributed to this mod — otherwise the user files modkit's bug against the
                 plugin's author. */
              self.modkitFault(err);
            }
            return result;
          };
        },
      }),
    );

    /* 5 ── L2: the assignment must actually have taken. The only reliable catch for a write that
       was swallowed rather than refused. */
    if (holder.getTasks === baseRef) {
      this.modkitHalt("error", "the patch did not take — the property was not replaced");
      return;
    }

    this.modkitArmed = true;
    /* "applied" is a claim about an EFFECT, not about installation. For an event-driven mod the
       contract defines it as "invoked at least once", and at this moment nothing has been invoked:
       a member the target only reaches when it re-reads a file does nothing to whatever the target
       already has in memory. Claiming applied here is how a mod that will not visibly do anything
       until the next edit reports itself as finished — the user sees no change and concludes it is
       broken. So report the honest state, say what will make it show, and let the first real call
       promote it. An on-demand mod has no call to wait for and is applied the moment it arms. */
    this.modkitHealth =
      NO_EFFECT_MODE === "event-driven"
        ? {
            state: "no-effect",
            detail:
              "in place, but " +
              TARGET_MEMBER +
              "() has not run yet — anything " +
              TARGET_LABEL +
              " has already loaded stays as it was until it is used again",
          }
        : { state: "applied", detail: "" };
    this.modkitPublish();

    /* 6 ── L3. The row is already honest from the moment it arms, and modkitBump promotes it the
       instant the first real call lands, so this interval is a net rather than the main path: it
       catches a promotion that should have happened and did not. An on-demand mod arms no
       deadline — a call count of zero is expected there, not a fault. */
    if (NO_EFFECT_MODE === "event-driven") {
      this.registerInterval(window.setInterval(() => this.modkitCheckNoEffect(), NO_EFFECT_DEADLINE_MS));
    }

    new Notice(MOD_LABEL + ": patched " + TARGET_LABEL + " " + version);
  }

  modkitTargetVersion() {
    try {
      return (
        this.app?.plugins?.manifests?.["obsidian-tasks-plugin"]?.version ??
        this.app?.plugins?.plugins?.["obsidian-tasks-plugin"]?.manifest?.version ??
        null
      );
    } catch {
      return null;
    }
  }

  modkitBump() {
    if (this.modkitProbing === true) {
      this.modkitProbeCalls += 1;
      return;
    }
    this.modkitCalls += 1;
    /* The first real call is the evidence "applied" was waiting for, so promote as it happens
       rather than up to a deadline later — the user has just done the thing that makes the mod
       visible and is looking at it now. Published on the 0 → 1 transition only: after that this is
       one integer comparison on the target's call path and nothing else. */
    if (this.modkitCalls === 1 && this.modkitHealth.state === "no-effect") {
      this.modkitHealth = { state: "applied", detail: "" };
      this.modkitPublish();
    }
  }

  modkitHalt(state, detail) {
    /* Never throw, and never fail quietly. The plugin stays enabled and inert so the user can see
       it in modkit's mod list and ask for a regeneration. */
    this.modkitHealth = { state: state, detail: detail };
    console.warn("[" + MOD_ID + "] " + state + ": " + detail);
    new Notice(MOD_LABEL + " — not applied: " + detail);
    this.modkitPublish();
  }

  modkitFault(err) {
    /* Attributed loudly, and the Notice only once per load: the alternative is a user reporting
       modkit's bug to the plugin's author. */
    const detail = err && err.message ? String(err.message) : String(err);
    this.modkitHealth = { state: "error", detail: detail };
    console.error("[" + MOD_ID + "] this modkit mod (not " + TARGET_LABEL + ") threw: " + detail);
    if (!this.modkitFaulted) {
      this.modkitFaulted = true;
      new Notice(MOD_LABEL + " — this modkit mod errored, not " + TARGET_LABEL + ". See the console.");
    }
    this.modkitPublish();
  }

  modkitCheckNoEffect() {
    if (this.modkitArmed !== true) return;
    if (this.modkitCalls > 0) {
      /* The wrapper has run since an earlier check demoted this row. "no-effect" reports silence,
         and silence can end: a member that is only called when the target re-parses a file is not
         called at all while the target's cache is still warm, so a correct patch can sit at zero
         calls for as long as the user does not edit anything. Without this arm the row stays wrong
         for the rest of the session and a working mod reads as broken.

         "no-effect" is the ONLY state promoted out of. It is the only one this check writes, so it
         is the only one it may withdraw; error, target-moved and target-gone are verdicts that a
         call count cannot overturn.

         What makes this safe is that modkitCalls counts only calls the APP made. modkitProbe()
         exercises the same wrapper on purpose, and a probe that could promote its own row would
         make "applied" mean "modkit asked the mod to prove itself" — so probe calls are counted
         separately and never reach this branch. */
      if (this.modkitHealth.state === "no-effect") {
        this.modkitHealth = { state: "applied", detail: "called " + this.modkitCalls + " time(s)" };
        this.modkitPublish();
      }
      return;
    }
    if (this.modkitHealth.state !== "applied") return;
    this.modkitHealth = { state: "no-effect", detail: TARGET_MEMBER + "() has not been called since load" };
    console.warn("[" + MOD_ID + "] no-effect: nothing called " + TARGET_MEMBER + "()");
    /* Deliberately NOT a Notice. Silence so far is not a failure — a member that only runs when the
       target re-parses says nothing until the user edits something, and this check has been seen
       demoting a mod that was working correctly. A toast cannot be withdrawn when the row is; it
       belongs in the mod list, which is where the promotion above will correct it. */
    this.modkitPublish();
  }

  /* The pull side of health reporting. modkit's mod list reads this — keep the name and the shape. */
  modkitStatus() {
    return {
      modId: MOD_ID,
      state: this.modkitHealth.state,
      detail: this.modkitHealth.detail,
      invocations: this.modkitCalls,
      targetVersionSeen: this.modkitVersionSeen,
    };
  }

  /* The push side. Entirely best-effort: a mod must still work with modkit disabled, uninstalled,
     or older than the method being called, because mods arrive on other devices by vault sync where
     modkit itself may not be installed at all. */
  modkitPublish() {
    try {
      const host = this.app?.plugins?.plugins?.["modkit"];
      if (host && typeof host.modkitReportHealth === "function") {
        host.modkitReportHealth(MOD_ID, this.modkitStatus());
      }
    } catch {
      /* reporting health must never be the thing that breaks a mod */
    }
  }

  /* The no-effect probe: exercises the patched path and asserts the observable difference. This is
     also the artifact that becomes the frozen regression test. Zero arguments, returns a boolean. */
  async modkitProbe() {
    /* A probe is modkit exercising the wrapper itself, so it must not look like the app using it:
       modkitProbing routes the bump into modkitProbeCalls, which no health check reads. Otherwise
       "verify now" could promote a row to applied having proved only that the probe works. */
    try {
      this.modkitProbing = true;
      const before = this.modkitProbeCalls;
      const target = this.app?.plugins?.plugins?.["obsidian-tasks-plugin"];
      if (!target || typeof target.getTasks !== "function") return false;
      target.getTasks();
      return this.modkitProbeCalls > before;
    } catch {
      return false;
    } finally {
      this.modkitProbing = false;
    }
  }
}
`;

/**
 * The exception to {@link PATCH_PLUGIN_TEMPLATE}: a plane-E \`css\`-mode mod has no \`around()\` to
 * install, no target member to gate on, and no per-call counter to arm, so following the canonical
 * template's ordering literally would mean writing dead machinery around an empty wrapper — which is
 * exactly the shape that let a \`<style>\`-injecting mod look complete. This is what one looks like
 * instead. It still satisfies every rule in the reclaim contract that applies to it: no top-level
 * side effects, exactly one default export extending \`Plugin\`, and a \`modkitProbe()\` that exists
 * and returns a value — \`missing-no-effect-probe\` checks for exactly that, on every plane alike.
 *
 * There is deliberately no \`requireApiVersion\` runtime gate in \`onload()\` here, unlike
 * {@link PATCH_PLUGIN_TEMPLATE}: Obsidian applies \`styles.css\` to every window the moment the mod
 * is *enabled*, before \`onload()\` runs at all, so an early return from \`onload()\` cannot suppress
 * it — a gate here would be inert for the one thing a css-mode mod ships. The version floor still
 * exists; it lives in \`manifest.json\`'s \`minAppVersion\` (generate.ts writes it from the same
 * \`appMinVersion\` field), which Obsidian itself enforces by refusing to load the plugin at all below
 * that floor.
 *
 * ⚠️ Same caveat as {@link PATCH_PLUGIN_TEMPLATE}: no backtick anywhere in this literal.
 */
export const CSS_MODE_EXAMPLE = String.raw`import { Plugin } from "obsidian";

const MOD_ID = "modkit-mod-hide-search-icon-9c2b";
const MOD_LABEL = "Mod: hide the Search tab icon";

export default class ModkitMod extends Plugin {
  async onload() {
    /* A css-mode plane-E mod ships every rule as "stylesCss", not as a <style> element written
       here. Obsidian applies styles.css to every open window — Settings included, which it opens
       as a separate window — the moment this mod is enabled, and removes it again on disable. So
       onload() does no styling work at all: no createElement("style"), no innerHTML, no
       .style.cssText, and no requireApiVersion gate either — manifest.json's minAppVersion is what
       gates a css-mode mod, because Obsidian enforces that before onload() ever runs. */
    console.log("[" + MOD_ID + "] " + MOD_LABEL + " — styles.css applied by Obsidian");
  }

  /* Whether the selector matched anything is counted by modkit itself, from the live DOM, after
     this mod is enabled — not by a call counter in here, because there is no around() wrapper to
     count calls through. This method exists only to satisfy the reclaim contract's probe rule. */
  async modkitProbe() {
    return true;
  }
}
`;

/* ────────────────────────────────────────────────────────────────────────────
 * The invariant rules — these go in the system prompt
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The reclaim contract, stated as hard requirements rather than as style advice.
 *
 * They are written this way on purpose: the validator will reject on exactly these rule ids, and a
 * model that is *told* the rule can satisfy it, where a model that is merely rejected by it learns
 * nothing. The ids match `ValidationRuleId` in `@modkit/types` so a rejection is legible to whoever
 * reads it next.
 */
const RECLAIM_CONTRACT = `## Hard requirements — the validator rejects on these

Obsidian's Component contract is the whole reason a mod is safely removable. Obsidian can only
*document* it; modkit enforces it, and that enforcement is the one structural advantage modkit has
over the ecosystem it is joining.

- \`no-top-level-side-effects\` — at module scope you may write only: imports, \`const\` declarations
  with a static initialiser, function declarations, and the single default-exported class. Nothing
  runs at load. All work happens in \`onload()\`.
- \`patch-must-be-registered\` — every \`around(...)\` call must sit **lexically inside**
  \`this.register(...)\`. Do not capture the uninstaller into a variable; do not collect uninstallers
  into an array and register them later. \`this.register(around(holder, { ... }))\` is the only
  accepted shape.
- \`no-raw-listener\` — never \`addEventListener\`, and never an inline handler assignment
  (\`el.onclick = fn\`, \`es.onmessage = fn\`): nothing removes either one at unload. Use
  \`this.registerDomEvent(el, type, fn)\`.
- \`no-raw-timer\` — never a bare \`setTimeout\`/\`setInterval\`. Use
  \`this.registerInterval(window.setInterval(fn, ms))\`. A window held in a local or on \`this\` is
  fine: \`this.registerInterval(this.win.setInterval(fn, ms))\`.
- \`event-must-be-registered\` — every \`on(...)\` subscription on a host object must be the **direct
  argument** of \`this.registerEvent\`: \`this.registerEvent(this.app.workspace.on("file-open", fn))\`.
  An unregistered EventRef is the most common leak in the whole Obsidian ecosystem — the handler
  outlives the mod and then fires against a dead object.
- \`must-be-reclaimed\` — anything the mod takes hold of comes back at unload, not only listeners and
  timers:
    - a \`MutationObserver\`/\`ResizeObserver\`/\`IntersectionObserver\` is bound to a const and
      \`this.register(() => obs.disconnect())\`;
    - an \`EventSource\` gets \`this.register(() => es.close())\`;
    - a node put into a tree the mod did not build gets \`this.register(() => el.remove())\`;
    - a class or attribute added to an element the mod did not create gets its inverse registered —
      or, better, ship the rule in \`stylesCss\` instead of touching the host element at all.
  Anything the mod created itself (\`activeDocument.createElement(...)\`) it owns, and may configure
  freely; it still has to be removed if it was inserted.
- \`inject-stylesheet\` — never create or insert a \`<style>\` element, write \`.style.cssText\`,
  build a \`<style>\` tag as a string, or reach for \`CSSStyleSheet\`/\`adoptedStyleSheets\`. Every one
  of those writes a stylesheet into whichever document happens to be \`activeDocument\` when
  \`onload()\` runs — and Obsidian opens Settings as a **separate window**, so a mod enabled from
  there styles Settings, not the workspace the user is looking at. \`stylesCss\` is the answer:
  Obsidian applies it to **every** window itself, the moment the mod is enabled, and removes it on
  disable. On a plane-E \`css\`-mode mod this is a hard rejection; on every other plane it is a
  warning, because a mod that patches behaviour may legitimately touch one class, but any CSS it
  needs still belongs in \`stylesCss\` rather than injected.
- \`no-bare-global\` — no \`document\`, \`window\`, \`globalThis\`, \`process\`, \`require\`,
  \`localStorage\`, \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, \`Worker\` outside a
  \`this.register*()\` acquisition. Use \`requestUrl\` from \`obsidian\` if you need HTTP.
- \`no-host-assignment\` — never assign to a property of an object you do not own. Patch through
  \`around()\`, never by assignment. **Note the consequence:** inside a wrapper, do not write
  \`self.someField = x\`; call a method on the plugin instead (\`self.modkitBump()\`), because only
  an assignment rooted at \`this\` is accepted.
- \`no-eval\` — no \`eval\`, no \`new Function\`.
- \`import-not-allowed\` — you may import from \`"obsidian"\` and \`"monkey-around"\` and nothing
  else. No node builtins at all, and **never** the \`node:\` prefix: \`external\` lists do not cover
  \`node:\`-prefixed specifiers and the build fails outright.
- \`default-export-must-extend-plugin\` — exactly one default export, a class extending \`Plugin\`.
- \`no-dynamic-host-member\` — index the host graph with **string literals only**:
  \`this.app?.plugins?.plugins?.["some-plugin-id"]\`, never \`plugins[SOME_CONST]\`. A computed access
  is the trivial bypass for every name-based rule above, so it is rejected even when it is innocent.
- \`unguarded-internal-access\` — \`app.plugins\`, \`app.commands\` and \`app.viewRegistry\` are
  **undocumented**. Every hop is optional-chained, and a missing hop is a refusal path, never a throw.
- Before the first \`around()\`, read the **target's own** version off the
  app graph (\`app.plugins.manifests["<id>"].version\`, as \`modkitTargetVersion()\` does) and compare
  it. \`requireApiVersion(...)\` gates Obsidian and is also required; it is not a gate on the target.
  Reading the mod's own \`this.manifest.version\` gates nothing.
- Before installing, take
  \`Object.getOwnPropertyDescriptor(<the same holder you pass to around()>, <the member you wrap>)\`
  and refuse when it has \`.get\` or \`.set\`. The descriptor has to be taken **on the object being
  patched, for the member being patched**, and the code that takes it has to actually run — a
  descriptor read on some other object answers a different question.
- When patching a **prototype**, also check
  \`Object.prototype.hasOwnProperty.call(<the live instance the prototype came from>, <the member>)\`
  and refuse when it is true: the live object is shadowing the member with its own bound copy and
  the prototype is off the call path. Asking any other object answers a different question.
- \`missing-no-effect-probe\` — the mod ships \`modkitProbe()\`.

Anything the mod creates in the DOM must carry \`data-modkit-mod\` so leaks are detectable and the
mod is attributable.`;

/** The reachability rule and the three silent-no-op classes. The core of the whole system prompt. */
const REACH_AND_REFUSAL = `## How to decide what to bind to

The five reach planes, in preference order A > B > C > D > E — except that a purely presentational
request ("make this smaller / hidden / a different colour") should go straight to E:

  A  a class exported from the \`obsidian\` module — \`Workspace.prototype.onDragLeaf\`, etc.
     Public API, named, minification-proof. Best when it exists.
  B  a live object on the app graph — \`app.vault.adapter\`, \`app.workspace\`. Narrowest blast radius.
  C  a foreign plugin's class, via \`app.plugins.plugins["id"].constructor.prototype\`. The default
     for modding another plugin.
  D  the command registry — \`app.commands.commands["<pluginId>:<commandId>"]\`, patching whichever of
     \`callback\` / \`checkCallback\` / \`editorCallback\` / \`editorCheckCallback\` carries the
     implementation. **This plane is load-bearing, not a convenience.** Many plugin behaviours are
     module-local free functions installed as command callbacks and have no prototype handle at all.
     Obsidian Tasks' toggle-done is exactly this: \`plugin.addCommand({ id: "toggle-done",
     editorCheckCallback: toggleDone })\` where \`toggleDone\` is an imported free function. Patching
     the wrong callback property is a silent no-op, so name the right one.
  E  DOM / CSS. The only plane needing no runtime handle, and the weakest binding to intent, because
     class names are unversioned.

### Plane E has two modes, and \`reachMode: "css"\` is not optional dress-up

Set \`reachMode\` to \`"css"\` for anything satisfiable by CSS alone — hide it, resize it, recolour
it, reposition it — and \`"dom"\` only when the change needs to *read* or *react to* the element,
not merely style it (a click handler, text content that depends on state).

A \`css\`-mode mod puts **every rule** in \`stylesCss\` and its \`main.js\` does **no styling work at
all**: no \`createElement("style")\`, no \`createEl("style", …)\`, no \`innerHTML\`/\`insertAdjacentHTML\`
carrying a \`<style>\` tag, no \`.style.cssText\`. This is not a style preference — it is the difference
between working and not. Obsidian applies \`styles.css\` to **every** open window the instant the mod
is enabled and removes it again on disable, which is exactly the reversible, multi-window-correct
behaviour a \`<style>\` element written from \`onload()\` does not have: Obsidian opens **Settings as a
separate window**, so a mod enabled or reinstalled while Settings is focused writes its injected
\`<style>\` into the *Settings* document, reports itself \`applied\`, and the workspace the user is
actually looking at never changes (measured 2026-09-02, reproduced with a regenerated help-button
mod). \`stylesCss\` has no such window to get wrong, on desktop or mobile.

Whether the selector actually matched anything is counted by modkit itself, from the live DOM, after
the mod is enabled — not by anything in \`main.js\`. So a \`css\`-mode mod's \`onload()\` has nothing
to arm, nothing to count, and no no-effect deadline to register; leave \`noEffectProbeSource\` minimal
(it still has to exist and return a value — see the example below) rather than reaching for the
around()-based counting the canonical template uses for every other plane.

### The reachability rule, and it holds in every bundle we have measured

esbuild renames **bindings** and preserves **member names**. \`TasksPlugin\` becomes \`Dd\`;
\`getTasks\` stays \`getTasks\`. Therefore:

> **Anything expressed as a class member is a stable runtime handle. Anything that is a module-local
> binding is not.**

Two corollaries the source will otherwise mislead you about:

- TypeScript \`private\` is a **compile-time fiction**. A \`private\` method is an ordinary, patchable
  own property of the prototype at runtime. Do not refuse a reachable target because the source
  marked it private.
- A module-local free function has no prototype handle **ever**. If it is installed as a command
  callback, plane D reaches it. If it is not, refuse.

## The three silent-no-op classes — detect them, never discover them later

\`around()\` fails silently in three distinct ways. Each installs cleanly, throws nothing, and
changes nothing. This is the number that must be zero.

1. **Accessors.** \`around()\` reads a property and then writes it. Against a getter-only member
   (Tasks' \`apiV1\`, QuickAdd's \`api\`) the read *invokes the getter* and the write hits an
   accessor with no setter. Not patchable this way at all. → refuse with \`accessor\`.
2. **Bound at construction.** \`this.x = this._x.bind(this)\` in a constructor or a class-field
   initialiser puts a bound copy on the instance; the prototype method it was bound from is no
   longer on the call path, so patching the prototype afterwards does nothing. Both Obsidian Tasks
   renderers are built this way. → refuse with \`bound-at-construction\`, or bind to the **instance
   field** instead and say that you did (that reaches one instance, not the class).
3. **A missing method.** \`around()\` on a method that does not exist does not error — it *creates*
   the property, and only throws when something calls it. → refuse with \`method-missing\`.

Also refuse a **non-writable, non-configurable** member (\`non-writable\`): the assignment is
swallowed in sloppy mode, which is a perfect silent no-op.

## Refusing is a correct, first-class outcome

An honest "I cannot reach that, and here is why" always beats a patch that silently does nothing. A
refusal is not a failure of this job — it is one of the two right answers. Refuse rather than:

- guessing at a symbol you did not see in the source;
- patching something adjacent that you *can* reach and hoping it is close enough;
- writing a mod that would work only if a field you never saw happens to exist.

When you refuse, name the specific symbol and what its shape is. \`suggestion\` is for a real
alternative — a different plane, a narrower request, a thing the user must enable first — and is
omitted rather than invented.`;

/** The persona. Replaces the coding-agent system prompt outright, per `--system-prompt`. */
export const SYSTEM_PROMPT = `You are modkit's patch author. You write one thing: a **patch** — a small, new Obsidian
plugin whose only job is to monkey-patch a target through Obsidian's public API, live, with a
guaranteed teardown.

You never rewrite anyone else's \`main.js\`. You never fork a plugin. You produce either a patch that
you can justify from the source in front of you, or a refusal that names what could not be reached.

Your output is **plain JavaScript, ES module syntax**, not TypeScript. This is not a style
preference: the validator parses the exact text you write, so a TypeScript transform would shift
every reported line number and make every error message a lie.

${REACH_AND_REFUSAL}

${RECLAIM_CONTRACT}

## The template your \`source\` must conform to

Follow its ordering exactly — gate → L0 pre-flight → install inside \`this.register()\` → L2 verify →
arm → L3 counter → Notice — and keep the \`modkit*\` member names, which modkit's mod list reads.
Change the identifiers, the target, the patched member and the body; keep the machinery.

\`\`\`js
${PATCH_PLUGIN_TEMPLATE}\`\`\`

### The one exception: a \`css\`-mode plane-E mod does not follow the template above

It has no \`around()\` to install, so the gate, the L0 pre-flight, the arm step and the L3 counter all
disappear — writing them anyway is dead code, not diligence, and every completeness requirement that
only makes sense once something is installed stops applying with it. What does not disappear: exactly
one default export extending \`Plugin\`, and a \`modkitProbe()\` that returns a value. This is the shape:

\`\`\`js
${CSS_MODE_EXAMPLE}\`\`\`

Write comments that explain **why**, not what. Do not narrate the code.`;

/* ────────────────────────────────────────────────────────────────────────────
 * The structured-output contract
 * ──────────────────────────────────────────────────────────────────────────── */

const REFUSAL_REASONS: RefusalReason[] = [
  'accessor',
  'bound-at-construction',
  'method-missing',
  'non-writable',
  'module-local',
  'target-not-installed',
  'target-disabled',
  'ambiguous-target',
  'no-source-available',
  'unsupported-request',
  'policy',
];

/**
 * Flat on purpose.
 *
 * A discriminated union would be the honest shape, but a schema with `oneOf` is the one thing most
 * likely to be handled differently by a future CLI, and the cost of getting it wrong is a whole
 * generation lost to a parse error. So: one flat object with an `outcome` discriminant, every
 * variant field optional, and `parseGenerationOutput` doing the narrowing where the failure is
 * cheap and legible.
 */
export const GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['patch', 'refusal'] },
    explanation: {
      type: 'string',
      description: 'One or two plain-language sentences the user reads. Required for both outcomes.',
    },

    /* ── refusal ── */
    refusalReason: { type: 'string', enum: REFUSAL_REASONS },
    refusalDetail: {
      type: 'string',
      description: 'The technical specifics: the symbol, its shape, and where in the source you saw it.',
    },
    refusalSuggestion: {
      type: 'string',
      description: 'A real alternative, or the empty string. Never invent one.',
    },
    refusalNeededPaths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'ONLY with refusalReason "no-source-available", and only when the missing file was named in the omitted list: the exact repo-relative paths you needed and did not get, e.g. ["src/Obsidian/Cache.ts"]. They will be fetched and you will be asked again, so name the file that would let you answer rather than describing it. Empty array if the source is not the problem.',
    },

    /* ── the reach that was used (or attempted, on a refusal) ── */
    plane: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] },
    reachMember: { type: 'string', description: 'The method being wrapped. Planes A, B, C.' },
    reachExportName: { type: 'string', description: 'Plane A: the exported obsidian symbol, e.g. "Workspace".' },
    reachHolder: {
      type: 'string',
      enum: ['prototype', 'static', 'instance'],
      description: 'Plane A: prototype|static. Plane C: prototype|instance.',
    },
    reachPath: { type: 'string', description: 'Plane B: dotted path from app, excluding "app.", e.g. "vault.adapter".' },
    reachPluginId: { type: 'string', description: 'Planes C and D: the target plugin manifest id.' },
    reachVia: { type: 'string', description: 'Plane C: an optional intermediate property off the plugin instance.' },
    reachCommandId: { type: 'string', description: 'Plane D: the full "<pluginId>:<commandId>" registry key.' },
    reachCommandProperty: {
      type: 'string',
      enum: ['callback', 'checkCallback', 'editorCallback', 'editorCheckCallback'],
      description: 'Plane D: which callback property carries the implementation. The wrong one is a silent no-op.',
    },
    reachSelector: { type: 'string', description: 'Plane E: a CSS selector that uniquely resolves at runtime.' },
    reachMode: {
      type: 'string',
      enum: ['css', 'dom'],
      description:
        'Plane E, required. `css` for anything satisfiable by CSS alone (ships stylesCss, no styling code in `source`); ' +
        '`dom` for behaviour that needs registerDomEvent or similar. Omitting this on a plane-E answer is treated as an ' +
        'incomplete reach, the same as a missing selector.',
    },
    reachViewType: { type: 'string', description: 'Plane E: the view type the selector resolves inside, if known.' },

    /* ── the patch ── */
    modName: { type: 'string', description: 'Display name for the generated plugin, e.g. "Mod: Tasks — log done".' },
    modDescription: {
      type: 'string',
      description:
        "manifest.json description. Obsidian's own plugin list renders it, so it is where the mod announces itself: say what it mods, at which version, and that disabling it reverts.",
    },
    source: { type: 'string', description: 'The entire main.js, plain JavaScript ES module, conforming to the template.' },
    stylesCss: {
      type: 'string',
      description:
        'The styles.css Obsidian applies to every window while this mod is enabled. Required (every rule the request needs, non-empty) for a plane-E css-mode mod — that is the only place its CSS may live, never a <style> element in `source`. Empty string for a dom-mode plane-E mod or any other plane with nothing to style.',
    },
    targetVersionFrom: { type: 'string', description: 'Inclusive lower bound of the target versions this works against.' },
    targetVersionTo: { type: 'string', description: 'Exclusive upper bound, or the empty string for open-ended.' },
    appMinVersion: { type: 'string', description: 'Minimum Obsidian version. Empty string to inherit modkit\u2019s floor.' },
    noEffectMode: {
      type: 'string',
      enum: ['event-driven', 'on-demand'],
      description:
        'event-driven fires on its own in normal use, so a call count of zero past the deadline is a real finding. on-demand only fires when the user does the thing, so zero is expected.',
    },
    noEffectDeadlineMs: { type: 'number', description: 'event-driven only. 30000 is a sane default.' },
    noEffectProbeSource: {
      type: 'string',
      description:
        'The body of modkitProbe() as it appears in `source`, repeated here so modkit can store the test separately from the code.',
    },
  },
  required: ['outcome', 'explanation'],
  additionalProperties: false,
};

/** The patch variant of a model answer, already narrowed into modkit's own types. */
export interface ModelPatch {
  reach: ReachTarget;
  modName: string;
  modDescription: string;
  source: string;
  stylesCss?: string;
  targetVersionRange: TargetVersionRange;
  appMinVersion?: string;
  noEffect: NoEffectPolicy;
  explanation: string;
}

/** The refusal variant. */
export interface ModelRefusal {
  reason: RefusalReason;
  explanation: string;
  detail: string;
  suggestion?: string;
  attempted?: ReachTarget;
  /**
   * Repo-relative paths the model says it needed and did not get. Only meaningful alongside
   * `no-source-available`; the pipeline pins these and asks once more (see `generate.ts` §4b).
   *
   * Measured 2026-09-03: the prompt already told the model to "say which" omitted file it needed
   * and the model did — naming `src/Obsidian/Cache.ts` in prose, twice — but nothing could act on
   * prose, so a correct and specific refusal was a dead end.
   */
  neededPaths?: string[];
}

export type ModelOutput = { kind: 'patch'; patch: ModelPatch } | { kind: 'refusal'; refusal: ModelRefusal };

export type ParseResult = { ok: true; value: ModelOutput } | { ok: false; error: string };

/** Trimmed, de-duplicated, empties dropped. A malformed value is no value, never a throw. */
function strArray(raw: Record<string, unknown>, key: string): string[] {
  const v = raw[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function str(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Narrow the flat answer into a `ReachTarget`.
 *
 * Returns `null` rather than a partial object when the plane's own required fields are missing: a
 * reach we cannot describe is a reach we cannot gate, fingerprint, or explain in the mod list, and
 * carrying half of one forward is how a mod ends up unattributable.
 */
function reachFrom(raw: Record<string, unknown>): ReachTarget | null {
  const plane = str(raw, 'plane');
  const member = str(raw, 'reachMember');
  switch (plane) {
    case 'A': {
      const exportName = str(raw, 'reachExportName');
      if (!exportName || !member) return null;
      const holder = str(raw, 'reachHolder') === 'static' ? 'static' : 'prototype';
      return { plane: 'A', exportName, holder, member };
    }
    case 'B': {
      const path = str(raw, 'reachPath');
      if (!path || !member) return null;
      return { plane: 'B', path, member };
    }
    case 'C': {
      const pluginId = str(raw, 'reachPluginId');
      if (!pluginId || !member) return null;
      const holder = str(raw, 'reachHolder') === 'instance' ? 'instance' : 'prototype';
      const via = str(raw, 'reachVia');
      return { plane: 'C', pluginId, holder, member, ...(via ? { via } : {}) };
    }
    case 'D': {
      const commandId = str(raw, 'reachCommandId');
      if (!commandId) return null;
      const property = str(raw, 'reachCommandProperty');
      const allowed: CommandCallbackProperty[] = [
        'callback',
        'checkCallback',
        'editorCallback',
        'editorCheckCallback',
      ];
      if (!allowed.includes(property as CommandCallbackProperty)) return null;
      const pluginId = str(raw, 'reachPluginId') || commandId.split(':')[0] || '';
      return { plane: 'D', commandId, pluginId, property: property as CommandCallbackProperty };
    }
    case 'E': {
      const selector = str(raw, 'reachSelector');
      const reachMode = str(raw, 'reachMode');
      // Require the model to actually state `css` or `dom` rather than defaulting an absent or
      // mis-cased value to `css`. A silent default here used to turn a dom-mode mod that simply
      // omitted the (optional-by-schema) field into a mod treated as css-mode, which then failed
      // `css-mod-without-stylesheet` with a reclaim-contract message that has nothing to do with
      // the actual problem. Returning `null` instead routes it through the same "reach fields were
      // incomplete" pipeline error every other plane already gets for a missing required field.
      if (!selector || (reachMode !== 'css' && reachMode !== 'dom')) return null;
      const viewType = str(raw, 'reachViewType');
      return { plane: 'E', selector, mode: reachMode, ...(viewType ? { viewType } : {}) };
    }
    default:
      return null;
  }
}

/**
 * Turn the model's structured output into something the pipeline can act on.
 *
 * Every failure here is a *pipeline* failure, not a refusal — the model was asked a question in a
 * shape and answered in a different one. Saying which field was wrong matters, because this is the
 * error a human debugs when a generation mysteriously produces nothing.
 */
export function parseGenerationOutput(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'model output was not a JSON object' };
  }
  const raw = input as Record<string, unknown>;
  const outcome = str(raw, 'outcome');
  const explanation = str(raw, 'explanation');

  if (outcome === 'refusal') {
    const reason = str(raw, 'refusalReason');
    if (!REFUSAL_REASONS.includes(reason as RefusalReason)) {
      return { ok: false, error: `refusal carried an unknown reason "${reason}"` };
    }
    const suggestion = str(raw, 'refusalSuggestion');
    const attempted = reachFrom(raw);
    const neededPaths = strArray(raw, 'refusalNeededPaths');
    return {
      ok: true,
      value: {
        kind: 'refusal',
        refusal: {
          reason: reason as RefusalReason,
          explanation: explanation || 'The requested change could not be reached.',
          detail: str(raw, 'refusalDetail'),
          ...(suggestion ? { suggestion } : {}),
          ...(attempted ? { attempted } : {}),
          ...(neededPaths.length > 0 ? { neededPaths } : {}),
        },
      },
    };
  }

  if (outcome !== 'patch') {
    return { ok: false, error: `outcome was "${outcome}", expected "patch" or "refusal"` };
  }

  const source = typeof raw['source'] === 'string' ? raw['source'] : '';
  if (!source.trim()) return { ok: false, error: 'outcome was "patch" but `source` was empty' };

  const reach = reachFrom(raw);
  if (!reach) {
    return { ok: false, error: `outcome was "patch" but the reach fields for plane "${str(raw, 'plane')}" were incomplete` };
  }

  const from = str(raw, 'targetVersionFrom');
  const to = str(raw, 'targetVersionTo');
  const modeRaw = str(raw, 'noEffectMode');
  const mode = modeRaw === 'event-driven' ? 'event-driven' : 'on-demand';
  const deadline = typeof raw['noEffectDeadlineMs'] === 'number' ? raw['noEffectDeadlineMs'] : 30_000;
  const probe = str(raw, 'noEffectProbeSource');
  const styles = str(raw, 'stylesCss');
  const appMin = str(raw, 'appMinVersion');

  return {
    ok: true,
    value: {
      kind: 'patch',
      patch: {
        reach,
        modName: str(raw, 'modName') || 'modkit mod',
        modDescription: str(raw, 'modDescription'),
        source,
        ...(styles ? { stylesCss: styles } : {}),
        targetVersionRange: { from, to: to || null },
        ...(appMin ? { appMinVersion: appMin } : {}),
        noEffect: {
          mode,
          ...(mode === 'event-driven' ? { deadlineMs: deadline } : {}),
          ...(probe ? { probeSource: probe } : {}),
        },
        explanation: explanation || 'No explanation was given.',
      },
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Building the case-specific prompt
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PromptInput {
  /** The user's sentence, **verbatim**. Never rewritten, never summarised, never truncated. */
  request: string;
  target: TargetRef;
  /** Display name from the installed manifest, when known. */
  targetName?: string | undefined;
  /** `owner/name`, when the registry resolved it. */
  repo?: string | undefined;
  /** What the picker believed. Advisory — the model may choose differently and must say which it used. */
  proposedReach?: ReachTarget | undefined;
  evidence?: PickEvidence | undefined;
  client?: ClientEnvironment | undefined;
  source?: SourceBundle | null | undefined;
  hazards?: SourceHazard[] | undefined;
  /** The client's runtime pre-flight, verbatim, when it ran one. */
  preflight?: string | undefined;
  regeneration?: RegenerationOrigin | undefined;
  /** Identity of the mod being produced. The id is stable across regenerations; only the version moves. */
  modId: string;
  modVersion: string;
  minAppVersion: string;
  /** Overrides the built-in template (`PATCH_PLUGIN_TEMPLATE`) with a caller-supplied copy. */
  templateSource?: string | undefined;
  /** Total budget for the user turn. The system prompt is measured separately and never degrades. */
  maxBytes?: number | undefined;
  /** How much of the budget the evidence block may claim before source does. */
  evidenceReserveBytes?: number | undefined;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  bytes: number;
  /** What had to be dropped to fit, in the order it was dropped. Empty when nothing was. */
  degraded: string[];
}

const DEFAULT_MAX_BYTES = 320_000;
const DEFAULT_EVIDENCE_RESERVE = 4_000;

export function buildGenerationPrompt(input: PromptInput): BuiltPrompt {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const evidenceReserve = input.evidenceReserveBytes ?? DEFAULT_EVIDENCE_RESERVE;
  const degraded: string[] = [];

  const system = input.templateSource
    ? SYSTEM_PROMPT.replace(PATCH_PLUGIN_TEMPLATE, input.templateSource)
    : SYSTEM_PROMPT;

  // Fixed segments are measured first, because three independent features compete for one budget and
  // none of them can see the others.
  const head = fixedSegments(input);
  const tail = askSegment(input);
  const fixedBytes = textBytes(head) + textBytes(tail) + 64;

  const remaining = Math.max(0, maxBytes - fixedBytes);
  const evidenceBlock = fitEvidence(input.evidence, Math.min(remaining, evidenceReserve), degraded);
  const sourceBlock = fitSource(input.source, Math.max(0, remaining - textBytes(evidenceBlock)), degraded);

  const prompt = [head, evidenceBlock, sourceBlock, tail].filter(Boolean).join('\n\n');
  return { system, prompt, schema: GENERATION_SCHEMA, bytes: textBytes(prompt), degraded };
}

function fixedSegments(input: PromptInput): string {
  const parts: string[] = [];
  const version = targetVersion(input.target);

  parts.push('# The request\n\nThe user asked, verbatim:\n\n> ' + input.request.trim().replace(/\n/g, '\n> '));

  const targetLines: string[] = [];
  if (input.target.kind === 'plugin') {
    const name = input.targetName ?? input.target.pluginName ?? input.target.pluginId;
    targetLines.push(`- plugin: **${name}** (\`${input.target.pluginId}\`) version \`${version}\` — the version installed right now, and the anchor for the version gate`);
    const repo = input.repo ?? input.target.repo;
    if (repo) targetLines.push(`- repo: \`${repo}\``);
  } else {
    targetLines.push(`- target: **Obsidian itself**, apiVersion \`${version}\``);
    if (input.target.internalPluginId) {
      targetLines.push(`- core internal plugin: \`${input.target.internalPluginId}\``);
    }
  }
  if (input.client) {
    targetLines.push(
      `- client: Obsidian \`${input.client.obsidianApiVersion}\` on ${input.client.platform}, modkit \`${input.client.modkitVersion}\``,
    );
  }
  targetLines.push(`- the mod you are writing: id \`${input.modId}\` (**never change it**), version \`${input.modVersion}\`, minAppVersion \`${input.minAppVersion}\``);
  parts.push(`# The target\n\n${targetLines.join('\n')}`);

  if (input.regeneration) {
    const r = input.regeneration;
    parts.push(
      `# This is a REGENERATION\n\n` +
        `The mod \`${r.modId}\` was generated against target version \`${r.previousTargetVersion}\` and is being rebuilt because: **${r.trigger}**.\n` +
        `Regenerate from the original intent above against the source below — do not try to repair the old patch, and do not change the mod id.` +
        (r.assertionsFrozen
          ? `\nThe user has already confirmed this mod behaves correctly, so the observable behaviour and \`modkitProbe()\` must stay the same. Only the bindings may change.`
          : ''),
    );
  }

  if (input.proposedReach) {
    parts.push(
      `# Proposed reach (advisory)\n\n` +
        `The picker believed plane **${input.proposedReach.plane}** — ${REACH_PLANE_LABELS[input.proposedReach.plane]} — ` +
        `\`${describeReach(input.proposedReach)}\`.\n` +
        `You have the source and it does not; choose differently if the source says otherwise, and report the plane you actually used.`,
    );
  }

  if (input.preflight && input.preflight.trim()) {
    parts.push(
      `# Runtime pre-flight, from the user's live app\n\n` +
        `\`\`\`\n${clean(input.preflight, 2_000)}\n\`\`\`\n` +
        `This is what the property actually looked like in the running app, which outranks anything the source implies.`,
    );
  }

  if (input.hazards && input.hazards.length > 0) {
    const lines = input.hazards
      .slice(0, 20)
      .map((h) => `- **${h.kind}** \`${h.symbol}\` — ${h.note}${h.path === '(none)' ? '' : ` (\`${h.path}:${h.line}\`: \`${clean(h.excerpt, 140)}\`)`}`);
    parts.push(
      `# Static hazards found in the source\n\n${lines.join('\n')}\n\n` +
        `This is a regex pass over one tagged snapshot: a hazard here is strong evidence, and its **absence is not a guarantee**. The runtime pre-flight in the mod you write is what actually decides.`,
    );
  }

  return parts.join('\n\n');
}

function askSegment(input: PromptInput): string {
  const noSource = !input.source || input.source.files.length === 0;
  return (
    `# Your answer\n\n` +
    `Return the structured object. Set \`outcome\` to \`"patch"\` **or** \`"refusal"\` — both are correct answers, and a refusal that names the unreachable symbol is worth far more than a patch that installs and does nothing.\n\n` +
    (noSource
      ? `⚠️ No source was available for this target. Unless the request is purely presentational (plane E, which needs no source), refuse with \`no-source-available\` rather than guessing at symbols.\n\n`
      : '') +
    `For a patch:\n` +
    `- \`source\` is the **entire** \`main.js\`, plain JavaScript, conforming to the template in your instructions.\n` +
    `- \`targetVersionFrom\` should normally be the installed version above; set \`targetVersionTo\` only if you have a reason from the source.\n` +
    `- \`noEffectMode\` is \`"event-driven"\` only if the patched member fires on its own in ordinary use. If the user has to do something to trigger it, it is \`"on-demand"\` and a call count of zero is expected.\n` +
    `- If \`plane\` is \`"E"\` and \`reachMode\` is \`"css"\`: put every rule in \`stylesCss\` (non-empty — an empty one ships a mod that does nothing) and follow the css-mode example, not the canonical template — no \`createElement("style")\`, no \`<style>\` element of any kind in \`source\`.\n` +
    `- \`explanation\` is one or two sentences of plain language for the mod list: what it does, and how.\n\n` +
    `Do not include any prose outside the structured object.`
  );
}

function describeReach(reach: ReachTarget): string {
  switch (reach.plane) {
    case 'A':
      return `${reach.exportName}.${reach.holder === 'static' ? '' : 'prototype.'}${reach.member}`;
    case 'B':
      return `app.${reach.path}.${reach.member}`;
    case 'C':
      return `app.plugins.plugins["${reach.pluginId}"]${reach.via ? `.${reach.via}` : ''}${reach.holder === 'prototype' ? '.constructor.prototype' : ''}.${reach.member}`;
    case 'D':
      return `app.commands.commands["${reach.commandId}"].${reach.property}`;
    case 'E':
      return `${reach.selector} (${reach.mode})`;
  }
}

/* ── Source, degrading from the weakest end ────────────────────────────────── */

function fitSource(bundle: SourceBundle | null | undefined, budget: number, degraded: string[]): string {
  if (!bundle || bundle.files.length === 0) return '';

  const kept: typeof bundle.files = [];
  const dropped: string[] = [];
  let used = 0;
  const overhead = 200; // heading + fence per file

  // The bundle is already ordered most-relevant-first, so dropping from the end drops the weakest.
  for (const file of bundle.files) {
    const cost = file.bytes + overhead;
    if (used + cost > budget) {
      dropped.push(file.path);
      continue;
    }
    kept.push(file);
    used += cost;
  }
  if (dropped.length > 0) degraded.push(`source: dropped ${dropped.length} file(s) to fit`);
  if (kept.length === 0) return '';

  const header =
    `# ${bundle.repo} source at tag \`${bundle.tag}\`\n\n` +
    `Resolved by \`${bundle.resolvedVia}\`. This is the code the user actually has installed — **not** the repo's HEAD, which is a different and often major version. Reason only from what is here.` +
    (bundle.treeTruncated ? `\n\n⚠️ GitHub truncated the file listing, so this tree is incomplete.` : '') +
    (bundle.symbolsMissing.length > 0
      ? `\n\n⚠️ These symbols were looked for and **not found** in any fetched file: ${bundle.symbolsMissing.map((s) => `\`${s}\``).join(', ')}.`
      : '');

  const blocks = kept.map((f) => {
    const lang = f.path.endsWith('.json') ? 'json' : f.path.endsWith('.css') ? 'css' : 'ts';
    return `## \`${f.path}\`${f.truncated ? ' (truncated)' : ''}\n\n\`\`\`${lang}\n${f.text}\n\`\`\``;
  });

  const omitted = [...dropped, ...bundle.omitted.map((o) => o.path)];
  const footer =
    omitted.length > 0
      ? `\n\n${omitted.length} further file(s) in this repo were not included: ${omitted.slice(0, 15).map((p) => `\`${p}\``).join(', ')}${omitted.length > 15 ? ', …' : ''}. If the answer is definitely in one of them, refuse with \`no-source-available\` and **put the exact paths in \`refusalNeededPaths\`** — they will be fetched and you will be asked again, so this is a request, not a dead end. A guess is worse than a refusal.`
      : '';

  return `${header}\n\n${blocks.join('\n\n')}${footer}`;
}

/* ── Evidence, degrading by the ladder ─────────────────────────────────────── */

interface RefOptions {
  upDepth: number;
  txtMax: number;
  rect: boolean;
  skel: boolean;
}

const LADDER: RefOptions[] = [
  { upDepth: 3, txtMax: 40, rect: true, skel: true }, // L0 — everything
  { upDepth: 3, txtMax: 40, rect: true, skel: false }, // L1 — drop the child skeleton
  { upDepth: 3, txtMax: 40, rect: false, skel: false }, // L2 — drop the on-screen rect
  { upDepth: 3, txtMax: 20, rect: false, skel: false }, // L3 — halve the text
  { upDepth: 1, txtMax: 20, rect: false, skel: false }, // L4 — ancestry 3 → 1
];

function renderRef(ref: ElementEvidence, index: number, opts: RefOptions): string {
  const parts = [`#${index + 1}`, `${clean(ref.sel, 60)}${clean(ref.nth, 10)}`];
  if (ref.gone) parts.push('(gone — replaced by a re-render before it could be described)');
  if (ref.up && opts.upDepth > 0) {
    parts.push(`in ${clean(ref.up.split('<').slice(0, opts.upDepth).join('<'), 90)}`);
  }
  if (ref.label) parts.push(`(aria '${clean(ref.label, 30)}')`);
  if (ref.txt) parts.push(`'${clean(ref.txt, opts.txtMax)}'`);
  if (ref.rect && opts.rect) parts.push(`@${clean(ref.rect, 24)}`);
  if (ref.skel && opts.skel) parts.push(clean(ref.skel, 120));
  if (ref.selector) parts.push(`selector: ${clean(ref.selector, 120)}`);
  return `[${parts.join(' ')}]`;
}

/**
 * The evidence block, degraded to fit.
 *
 * Skeleton and rect are re-derivable from the running app; text and ancestry are what *identify* the
 * element the user pointed at. So the ladder gives up the re-derivable things first, drops whole
 * refs from the end only when it must (the first tap is usually what the request is about), and its
 * last rung still says how many were dropped — because an agent told nothing edits the wrong thing.
 */
function fitEvidence(evidence: PickEvidence | undefined, budget: number, degraded: string[]): string {
  if (!evidence) return '';
  const refs = evidence.elements ?? [];
  const contextLines: string[] = [];
  if (evidence.viewType) contextLines.push(`- the pick resolved inside a \`${evidence.viewType}\` view`);
  if (evidence.viewport) contextLines.push(`- viewport ${clean(evidence.viewport, 20)}`);
  if (evidence.commandIds?.length) {
    contextLines.push(
      `- commands visible at pick time: ${evidence.commandIds.slice(0, 12).map((c) => `\`${clean(c, 80)}\``).join(', ')}`,
    );
  }

  if (refs.length === 0 && contextLines.length === 0) return '';

  const frame = (body: string): string =>
    `# Where the user was pointing\n\n` +
    (contextLines.length ? `${contextLines.join('\n')}\n\n` : '') +
    (body
      ? `Elements picked, in pick order: ${body}\n\n` +
        `These are the DOM classes **as rendered by the running app**. Obsidian's own class names are stable across versions but are not API, so treat them as a hint to the owning view and its plugin — they are the weakest binding available and are the reason plane E ranks last.`
      : '');

  if (refs.length === 0) return frame('');

  for (const opts of LADDER) {
    const body = refs.map((r, i) => renderRef(r, i, opts)).join(' ');
    const candidate = frame(body);
    if (textBytes(candidate) <= budget) {
      if (opts !== LADDER[0]) degraded.push('evidence: element refs abbreviated to fit');
      return candidate;
    }
  }

  // L5 — drop refs from the end, keeping the first.
  const opts = LADDER[LADDER.length - 1] as RefOptions;
  for (let keep = refs.length - 1; keep >= 1; keep -= 1) {
    const body = `${refs
      .slice(0, keep)
      .map((r, i) => renderRef(r, i, opts))
      .join(' ')} (+${refs.length - keep} more did not fit)`;
    const candidate = frame(body);
    if (textBytes(candidate) <= budget) {
      degraded.push(`evidence: ${refs.length - keep} element ref(s) dropped to fit`);
      return candidate;
    }
  }

  // L6 — say that something was dropped, which is strictly better than silence.
  degraded.push('evidence: all element refs dropped to fit');
  return `# Where the user was pointing\n\n${refs.length} element(s) were selected but did not fit in this message.`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The correction turn
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Build the retry prompt after the validator rejected the first attempt.
 *
 * The feedback loop is the point of having a machine author: the validator's findings are precise,
 * mechanical, and about the *shape* of the code rather than its intent, which is exactly the class
 * of error a second turn fixes reliably. So the findings go back with their rule ids, their line and
 * column, and the offending line — and the whole rejected source goes with them, because a model
 * asked to patch code it cannot see writes a different program.
 *
 * The original case is repeated in full. Dropping it to save bytes is how a correction turn produces
 * a valid patch for the wrong request.
 *
 * ## Why three rule names are withheld
 *
 * For a structural rule — "this `around()` is not inside `this.register(...)`" — naming the rule is
 * pure help: the message names the one legal form, so the cheapest edit that satisfies the rule *is*
 * the fix. The three L0 pre-flight rules were not like that. They were token-presence checks over
 * the whole file, so the cheapest edit that satisfied them was to paste the token in — and we handed
 * the model the rule id, which is the most efficient possible hint about which token. A verifier
 * reproduced exactly that: five lines of dead ceremony satisfied all three while an unguarded
 * `around()` installed on an accessor.
 *
 * `validate.ts` now binds those three to the patch (the descriptor must be taken on the same holder,
 * for a member the spec wraps, in code that actually runs), so satisfying them and being safe are
 * the same act. The names stay withheld anyway: it costs nothing, the behavioural requirement in the
 * message is what a correction needs, and it removes the standing incentive to optimise against an
 * id rather than against a hazard.
 */

/**
 * Rules whose *name* is withheld from the correction turn. The requirement still goes back in full —
 * only the id is dropped. See the note above.
 */
const NAME_WITHHELD_RULES: ReadonlySet<string> = new Set([
  'accessor-target',
  'bound-method-target',
  'missing-version-gate',
]);

export function buildCorrectionPrompt(
  input: PromptInput,
  rejectedSource: string,
  findings: ValidationFinding[],
  rejectedStylesCss?: string,
): BuiltPrompt {
  const base = buildGenerationPrompt(input);
  const errors = findings.filter((f) => f.severity === 'error');
  const shown = (errors.length > 0 ? errors : findings).slice(0, 30);

  const list = shown
    .map((f) => {
      const where = `${f.file ?? 'main.js'}:${f.line}:${f.column}`;
      const head = NAME_WITHHELD_RULES.has(f.rule) ? `at ${where}` : `\`${f.rule}\` at ${where}`;
      return `- ${head} — ${f.message}` + (f.excerpt ? `\n      ${f.excerpt}` : '');
    })
    .join('\n');

  // `css-mod-without-stylesheet` locates its finding at `styles.css`, and the ONLY fix for it is a
  // non-empty `stylesCss` — editing `source` cannot satisfy it. Without echoing the rejected
  // `stylesCss` back, a model that reads "return the complete corrected `source`" literally can fix
  // every `source`-side finding, re-omit `stylesCss` because nothing here reminded it that field
  // exists, and get rejected again on the one finding this turn never showed it.
  const stylesBlock =
    rejectedStylesCss !== undefined
      ? `You also produced this \`stylesCss\`:\n\n\`\`\`css\n${rejectedStylesCss || '/* (empty) */'}\n\`\`\`\n\n`
      : '';
  const stylesNote =
    rejectedStylesCss !== undefined
      ? ` A finding located at \`styles.css\` is fixed by returning a corrected, non-empty \`stylesCss\` — not by editing \`source\`.`
      : '';

  const correction =
    `# Your previous attempt was rejected by the validator\n\n` +
    `You produced this \`source\`:\n\n\`\`\`js\n${rejectedSource}\n\`\`\`\n\n` +
    stylesBlock +
    `The validator found ${errors.length} blocking problem(s):\n\n${list}\n\n` +
    `Fix every one of them and return the **complete** corrected \`source\` — not a diff, not a fragment.${stylesNote} ` +
    `The rules are in your instructions and they are not negotiable: they are what makes a mod removable, so code that breaks them is not shipped.\n\n` +
    `Each finding above states a **behaviour**, not a token to add. The validator checks that the pre-flight was taken on the object and member you actually patch, and that it runs — adding a line that merely mentions \`getOwnPropertyDescriptor\`, \`hasOwnProperty\` or a version does not satisfy anything and will be rejected again identically.\n\n` +
    `If a finding cannot be fixed without abandoning the approach — for example the only way to do what was asked is to assign to a host object, or to hold a timer you cannot register — then switch \`outcome\` to \`"refusal"\` and say so. That is the right answer, and it is better than a third attempt at the same shape.`;

  const prompt = `${base.prompt}\n\n${correction}`;
  return { ...base, prompt, bytes: textBytes(prompt) };
}
