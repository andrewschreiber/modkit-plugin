/**
 * `@modkit/types` — the wire and storage contract shared by the modkit Obsidian plugin and the
 * modkit daemon.
 *
 * Nothing in here has a runtime dependency, and nothing in here touches the DOM, `node:*`, or
 * `obsidian`. Both sides import it: the plugin bundles it with esbuild, the daemon imports it as
 * plain ESM. That is deliberate — a shape that only one side knows is a shape the two sides can
 * silently disagree about.
 *
 * Two conventions run through the whole file:
 *
 * 1. **Discriminated unions over optional-everything.** A refusal has no `main.js`; a success has
 *    no refusal reason; a failed job has no result. Where a field would only be meaningful for one
 *    variant, it lives on that variant.
 * 2. **Timestamps are ISO-8601 UTC strings** (`new Date().toISOString()`), not epoch numbers —
 *    every one of these lands in a JSON file a human reads while debugging.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Protocol
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The wire-contract version. Bump it whenever a change to this file would make an older peer
 * misread a document rather than fail to parse one.
 *
 * Both sides check it and **fail loudly**: the daemon rejects a `GenerateRequest` whose `protocol`
 * is not this value with {@link ApiErrorCode} `protocol-mismatch`, and the plugin refuses to install
 * an artifact whose payload carries a different one. The failure mode this prevents is a daemon
 * left running from an older build quietly producing artifacts a newer plugin half-understands.
 */
export const MODKIT_PROTOCOL_VERSION = 'MODKIT/1' as const;

/** The literal type of {@link MODKIT_PROTOCOL_VERSION}, for use as a discriminant. */
export type ModkitProtocol = typeof MODKIT_PROTOCOL_VERSION;

/** Domain separation for the Ed25519 delegation certificate. See {@link DelegationCert}. */
export const MODKIT_CERT_PURPOSE = 'modkit-artifact-v1' as const;

/** Every generated mod's plugin id starts with this, so mods are identifiable in the vault. */
export const MODKIT_MOD_ID_PREFIX = 'modkit-mod-' as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Reach planes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The five ways a mod can get a runtime handle on the thing it wants to change.
 *
 * - `A` — a class exported from the `obsidian` module (`Workspace.prototype`, …). Most robust:
 *   the handle is public API, named, and minification-proof.
 * - `B` — a live object on the app graph (`app.vault.adapter`, `app.workspace`, …). Patches that
 *   one object only; narrowest blast radius.
 * - `C` — `app.plugins.plugins[id].constructor.prototype`, a foreign plugin's class. The default
 *   for modding another plugin.
 * - `D` — `app.commands.commands["<pluginId>:<commandId>"]`, the command registry. Load-bearing:
 *   many plugin behaviours are module-local free functions installed as command callbacks and have
 *   **no prototype handle at all** (Obsidian Tasks' toggle-done is exactly this). Without plane D
 *   those requests would be refused for a reason that is not actually true.
 * - `E` — DOM / CSS. The only plane needing no runtime handle, and therefore the right answer for
 *   "make this smaller / hidden / a different colour" — but it binds to unversioned class names,
 *   so it is the weakest binding to intent.
 *
 * Generator preference order is A > B > C > D > E, except that a purely presentational request
 * should go straight to E.
 */
export type ReachPlaneId = 'A' | 'B' | 'C' | 'D' | 'E';

/** Stable, ordered list of the planes — safe to iterate for UI. */
export const REACH_PLANE_IDS = ['A', 'B', 'C', 'D', 'E'] as const;

/** One-line human labels, so plugin and daemon describe a plane identically. */
export const REACH_PLANE_LABELS: Record<ReachPlaneId, string> = {
  A: 'exported Obsidian class prototype',
  B: 'live object on the app graph',
  C: "foreign plugin's class prototype",
  D: 'command registry entry',
  E: 'DOM / CSS',
};

/** Which side of a class the member lives on. */
export type MemberHolder = 'prototype' | 'static' | 'instance';

/** The four shapes a registered Obsidian `Command` can carry its implementation in. */
export type CommandCallbackProperty =
  | 'callback'
  | 'checkCallback'
  | 'editorCallback'
  | 'editorCheckCallback';

/** Plane A — a class exported from the `obsidian` module. */
export interface ReachExportedClass {
  plane: 'A';
  /** The exported symbol, exactly as the `obsidian` module names it, e.g. `"Workspace"`. */
  exportName: string;
  /** `prototype` for an instance method, `static` for a class-level one. */
  holder: Extract<MemberHolder, 'prototype' | 'static'>;
  /** The method being wrapped, e.g. `"onDragLeaf"`. */
  member: string;
}

/** Plane B — a singleton reached by property path from `app`. */
export interface ReachAppGraphObject {
  plane: 'B';
  /**
   * Dotted path from `app`, **excluding** the leading `app.` — e.g. `"vault.adapter"`.
   * Every hop is optional-chained at runtime; a missing hop is a refusal, never a crash.
   */
  path: string;
  /** The method being wrapped on that object. */
  member: string;
}

/** Plane C — a foreign plugin's class, reached through its live instance. */
export interface ReachPluginPrototype {
  plane: 'C';
  /** The target plugin's manifest id, e.g. `"obsidian-tasks-plugin"`. */
  pluginId: string;
  /**
   * `prototype` patches the class (every instance, past and future);
   * `instance` patches the one live plugin object (`app.plugins.plugins[id]`) and tears down with
   * `delete`, which is the narrower and safer choice when the request is about one object.
   */
  holder: Extract<MemberHolder, 'prototype' | 'instance'>;
  /** The method being wrapped. */
  member: string;
  /**
   * Optional intermediate property walked off the plugin instance before taking
   * `.constructor.prototype` — e.g. `"instance"` for a core internal plugin, or a sub-object the
   * plugin exposes. Absent means the plugin object itself.
   */
  via?: string;
}

/** Plane D — the command registry. */
export interface ReachCommand {
  plane: 'D';
  /** Fully-qualified registry key, `"<pluginId>:<commandId>"`. */
  commandId: string;
  /** The owning plugin id — the part of `commandId` before the first `:`. Carried explicitly so a core command (no plugin) is representable. */
  pluginId: string;
  /** Which callback property carries the implementation. Patching the wrong one is a silent no-op. */
  property: CommandCallbackProperty;
}

/** Plane E — DOM decoration and/or stylesheet. */
export interface ReachDom {
  plane: 'E';
  /**
   * A CSS selector that uniquely resolves at runtime. Generated from the picked element; the
   * daemon must assume it can match zero nodes on a later app version.
   */
  selector: string;
  /** `css` ships a `styles.css`; `dom` attaches behaviour through `registerDomEvent`. */
  mode: 'css' | 'dom';
  /** The view type the selector was resolved inside, when the picker could determine one. */
  viewType?: string;
}

/**
 * A concrete, checkable statement of what a mod attaches to. Discriminated on `plane`, so the
 * fields that exist are exactly the fields that mean something for that plane.
 */
export type ReachTarget =
  | ReachExportedClass
  | ReachAppGraphObject
  | ReachPluginPrototype
  | ReachCommand
  | ReachDom;

/* ────────────────────────────────────────────────────────────────────────────
 * Targets and versions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What is being modded. A union rather than one interface with optional fields, because a core
 * Obsidian target has no plugin version and a plugin target has no meaningful app version — and
 * conflating them is how a version gate ends up comparing the wrong two numbers.
 */
export type TargetRef =
  | {
      kind: 'plugin';
      /** Manifest id, e.g. `"obsidian-tasks-plugin"`. */
      pluginId: string;
      /** Display name from the manifest, for UI only. */
      pluginName?: string;
      /** The version installed **at the moment of the request** — the anchor for the version gate. */
      pluginVersion: string;
      /** `owner/name` from the community registry, when known. This is the source bridge. */
      repo?: string;
    }
  | {
      kind: 'core';
      /** Obsidian's `apiVersion` at the moment of the request. */
      appVersion: string;
      /** Set when the target is a core *internal* plugin, e.g. `"page-preview"`. */
      internalPluginId?: string;
    };

/** Stable key for a target — the plugin id, or `"obsidian"` for core. Use it for grouping and display. */
export function targetKey(target: TargetRef): string {
  return target.kind === 'plugin' ? target.pluginId : (target.internalPluginId ?? 'obsidian');
}

/** The version a gate should compare against for this target. */
export function targetVersion(target: TargetRef): string {
  return target.kind === 'plugin' ? target.pluginVersion : target.appVersion;
}

/**
 * The versions of the target a mod claims to work against, checked at every load.
 *
 * `from` is **inclusive**, `to` is **exclusive**; `to: null` means open-ended. Comparison is a
 * three-field numeric semver compare with pre-release suffixes ignored — there is no range syntax
 * (`^`, `~`) here on purpose, because a range parser is more surface than the problem needs.
 */
export interface TargetVersionRange {
  from: string;
  to: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Evidence captured by the element picker
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One picked DOM node, described durably. Deliberately a set of short strings rather than raw
 * `outerHTML`: class tokens survive minification verbatim while component identifiers do not, and
 * a wrong class name fails loudly (nothing matches) where a wrong source location fails
 * confidently.
 */
export interface ElementEvidence {
  /** Tag plus up to three of the node's own classes, e.g. `"li.today-box"`. */
  sel: string;
  /** Position among same-tag siblings, e.g. `"[2/5]"`, or `""` when it is the only one. */
  nth: string;
  /** Up to three classed ancestors, nearest first, e.g. `"ul.today-boxes<section.card"`. */
  up: string;
  /** `aria-label` / `placeholder` / `alt`, else `""`. */
  label: string;
  /** Sanitised `textContent`, else `""`. */
  txt: string;
  /** Rounded CSS-px viewport rect, `"x,y WxH"`. CSS px, never visual px. */
  rect: string;
  /** One-level child outline, e.g. `"<li.today-box><p.today-box-text/></li>"`. */
  skel: string;
  /**
   * True when the node had already been replaced by a re-render before it could be described.
   * Reported rather than dropped: "the thing I pointed at no longer exists" is information the
   * generator can use, and silently shipping four refs when five were picked is not.
   */
  gone?: boolean;
  /** A uniquely-resolving runtime selector, when one could be generated. Feeds {@link ReachDom}. */
  selector?: string;
}

/** Everything the UI captured about *where* the user was pointing when they made the request. */
export interface PickEvidence {
  /** The picked nodes, in pick order. May be empty for a plugin-picker request. */
  elements: ElementEvidence[];
  /** The view type of the leaf the pick resolved into, e.g. `"markdown"`. */
  viewType?: string;
  /** Viewport size label, e.g. `"1440x900"` — a rect means nothing without it. */
  viewport?: string;
  /**
   * An indented outline of the surrounding DOM (`tag.class "text" [WxH]`), capped by the capturing
   * side. Sent inline; if it would be large the capturing side truncates rather than omitting the
   * request.
   */
  domOutline?: string;
  /** Command ids visible/relevant at pick time — the cheapest route to a plane-D target. */
  commandIds?: string[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Client environment
 * ──────────────────────────────────────────────────────────────────────────── */

/** Where the plugin is running. Mirrors Obsidian's own `Platform.isDesktopApp` / `isMobileApp`. */
export type ModkitPlatform = 'desktop' | 'mobile';

/** Identity of the requesting client. Recorded on every job so a bad generation is attributable. */
export interface ClientEnvironment {
  /** The modkit plugin's own manifest version. */
  modkitVersion: string;
  /** Obsidian's `apiVersion`, e.g. `"1.12.7"`. */
  obsidianApiVersion: string;
  platform: ModkitPlatform;
  /** Optional OS label for triage only. Never used for a decision. */
  os?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Generate request
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Which CLI the daemon shells out to for a generation.
 *
 * Lives in the contract rather than only in the daemon because the plugin now offers a picker:
 * a client that can *ask* for a backend has to name the same set the daemon validates against, and
 * two copies of that union would drift the first time a third transport lands.
 */
export type ModelBackend = 'claude' | 'codex';

export function isModelBackend(value: unknown): value is ModelBackend {
  return value === 'claude' || value === 'codex';
}

/**
 * A client's per-request override of the daemon's configured backend and model.
 *
 * Both fields are optional and both mean "leave the daemon's own choice alone" when absent — never
 * "use the empty string". They are carried on the request rather than set through a mutating
 * config endpoint so that a generation is reproducible from its own record: the job that ran, and
 * the mod it produced, name the backend that produced them.
 *
 * **Asking for `codex` is not the same as getting it.** The daemon refuses a `codex` override
 * unless its operator set `MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1` in the daemon's *own* environment —
 * see {@link HealthResponse.codexAvailable}. That gate exists because codex's shell tool has
 * machine-wide filesystem read access under every sandbox flag codex-cli 0.152.0 offers, and a UI
 * toggle must not be able to turn that on for someone who never read why it is a decision.
 */
export interface ModelOverride {
  /** Which transport to use for this generation. Absent means the daemon's configured backend. */
  backend?: ModelBackend;
  /** The model id to pass to that transport. Absent means the daemon's configured model. */
  model?: string;
}

/** `POST /v1/generate` body. */
export interface GenerateRequest {
  protocol: ModkitProtocol;
  /**
   * A client-generated key that is stable for one user intent. A retry after a dropped response
   * **must** reuse it, and the daemon must return the existing job rather than starting a second
   * expensive generation. Recommended: a UUID minted when the compose modal is submitted.
   */
  idempotencyKey: string;
  /**
   * The user's sentence, verbatim. This is the durable artifact of the whole product: it is stored
   * with the mod and it is what regeneration runs against when the target moves (DESIGN §5). Never
   * normalise, summarise or rewrite it on the way through.
   */
  request: string;
  /** What is being modded, and at which version. */
  target: TargetRef;
  /**
   * The plane the client believes is right, when the picker could determine one. Advisory: the
   * daemon reads the target's source and may choose differently, and the plane that was actually
   * used comes back on the artifact.
   */
  proposedReach?: ReachTarget;
  /** What the user was pointing at. */
  evidence?: PickEvidence;
  client: ClientEnvironment;
  /**
   * The root public key the plugin has pinned (64 lowercase hex). Sent so a key mismatch produces
   * a clear error from the daemon instead of an unexplained verification failure on the device.
   */
  pinnedRootPubkey?: string;
  /** Set when this request is a regeneration; see {@link RegenerateRequest}. */
  regenerationOf?: RegenerationOrigin;
  /** Per-request backend/model override; see {@link ModelOverride}. */
  modelOverride?: ModelOverride;
}

/** Provenance for a regenerated mod. */
export interface RegenerationOrigin {
  /** The mod being regenerated. */
  modId: string;
  /** The target version the previous generation was built against. */
  previousTargetVersion: string;
  /** Why regeneration was triggered. */
  trigger: 'target-moved' | 'no-effect' | 'target-gone' | 'user-requested' | 'error';
  /**
   * True once the user has confirmed the mod behaves as intended. From then on the generated
   * assertions are frozen and only the bindings regenerate (DESIGN §5).
   */
  assertionsFrozen: boolean;
}

/**
 * `POST /v1/regenerate` body.
 *
 * Carries the same `request`/`evidence`/`proposedReach` a `GenerateRequest` does, read back from
 * the plugin's own ledger (`ModRecord.request`, `.evidence`, `.reach`) rather than from the
 * daemon's archive: the ledger is the plugin's own copy of "the regeneration seed", and the wire
 * contract should not make the daemon's `.state` a second source of truth for it. A wiped `.state`
 * must not make an otherwise-fine mod unregenerable while the plugin still holds the sentence.
 */
export interface RegenerateRequest {
  protocol: ModkitProtocol;
  idempotencyKey: string;
  modId: string;
  /** The user's sentence, verbatim, from the plugin's own record — never re-derived or rewritten. */
  request: string;
  /** What the user was pointing at when the mod was first generated, from the plugin's record. */
  evidence?: PickEvidence;
  /** The plane that worked last time, from the plugin's record — the best available hint this time. */
  proposedReach?: ReachTarget;
  /** The target's version *now*, which is what makes this different from the original generation. */
  target: TargetRef;
  client: ClientEnvironment;
  origin: RegenerationOrigin;
  /** Per-request backend/model override; see {@link ModelOverride}. */
  modelOverride?: ModelOverride;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The generated artifact
 * ──────────────────────────────────────────────────────────────────────────── */

/** An Obsidian `manifest.json`, as written into `.obsidian/plugins/<id>/`. */
export interface ObsidianPluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  fundingUrl?: string;
  /** Always `false` for generated mods — they must run on mobile, where they arrive by sync. */
  isDesktopOnly: boolean;
}

/** How a mod expects to be invoked, which is what makes "no effect" a decidable question. */
export type NoEffectMode =
  /** Fires on its own in normal use. If it has not fired by the deadline, that is a real finding. */
  | 'event-driven'
  /** Only fires when the user does the thing. A call count of zero is expected, not a fault. */
  | 'on-demand';

/** The mod's own self-check contract — the antidote to a patch that installs and does nothing. */
export interface NoEffectPolicy {
  mode: NoEffectMode;
  /**
   * For `event-driven` only: how long after load to wait before reporting {@link ModHealthState}
   * `no-effect`. Ignored for `on-demand`.
   */
  deadlineMs?: number;
  /**
   * Source of a zero-argument function returning `boolean | Promise<boolean>` that exercises the
   * patched path and asserts the observable difference. Run once at install behind an explicit
   * user "verify now", and on later loads once the mod is verified. This is also the artifact that
   * becomes the frozen regression test.
   */
  probeSource?: string;
}

/** Who and what produced an artifact. Recorded so a bad batch is identifiable after the fact. */
export interface GeneratorInfo {
  /** The model that actually served the request — read from `modelUsage`, never echoed from the request. */
  model: string;
  /** The daemon's own version. */
  daemonVersion: string;
  generatedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The effects axis
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One thing a mod does to something that is not itself.
 *
 * The reclaim contract asks a single question — *can Obsidian take this patch back* — and five
 * adversarial rounds have now established that it holds. What it never asked is whether the
 * patch's **effects** can be taken back, and they cannot: disabling a mod does not un-rewrite a
 * note, un-trash a file, un-disable a plugin, un-send a POST, or un-run a subprocess. That is a
 * second axis, and unlike the first it is not decidable — so it is *declared*, never enforced,
 * and it is rendered to a person rather than gated on.
 *
 * `kind` is deliberately a bare `string`. This module renders nothing; the plugin's review modal
 * does, and it is written to show an unrecognised kind verbatim rather than drop it — a newer
 * daemon must never be able to make an effect invisible by naming it something this build has no
 * label for.
 */
export interface ModEffect {
  /**
   * The vocabulary the plugin has labels for: `vault-write`, `vault-delete`, `plugin-settings`,
   * `plugin-lifecycle`, `network`, `host-dom`, `process`. Anything else renders as itself.
   */
  kind: string;
  /** One phrase naming the specific thing — `vault.trash()` in `onload`, `fetch("https://…")`. */
  detail?: string;
  /** Where in the model's source it was seen, when the analyser knows. 1-based. */
  line?: number;
  column?: number;
  /** The offending source line, trimmed. */
  excerpt?: string;
}

/**
 * Everything a mod does outside its own patch, as the validator saw it.
 *
 * Three states, and they must stay distinguishable all the way to the screen:
 * - **absent** (no declaration on the payload at all) — this daemon does not analyse effects, and
 *   the reader is told exactly that rather than shown a reassuring blank;
 * - **`{ effects: [] }`** — analysed, nothing found: the common, boring case;
 * - **`partial: true`** — analysed and the analyser knows its own answer is incomplete (dynamic
 *   dispatch it could not follow), so an empty list is *not* "no effects".
 */
export interface EffectsDeclaration {
  effects: readonly ModEffect[];
  partial?: boolean;
}

/**
 * Everything a mod is, as one signed document.
 *
 * ⚠️ **This object is never itself the signature input.** It is serialised to JSON, base64-encoded,
 * and the *base64 string* is what gets signed and what travels in {@link SignedArtifact.payload}.
 * That is a deliberate departure from a "sign the object with a sorted-key replacer" scheme: a
 * `JSON.stringify(obj, keyArray)` replacer filters keys **at every depth**, so nested objects like
 * `manifest` and `target` would serialise as `{}` and be signed and verified consistently on both
 * sides while covering nothing. Signing an opaque string removes the whole class of problem and
 * lets this payload nest freely.
 */
export interface ArtifactPayload {
  protocol: ModkitProtocol;
  /** The generated plugin's id — also its directory name under `.obsidian/plugins/`. */
  modId: string;
  manifest: ObsidianPluginManifest;
  /** The built CJS bundle, verbatim. This is what gets written to `main.js`. */
  mainJs: string;
  /** A `styles.css`, for plane-E mods that ship one. */
  stylesCss?: string;
  /** Lowercase hex SHA-256 of `utf8(mainJs)`. Identity and on-disk integrity, not transport integrity. */
  sha256: string;
  /** The user's original sentence, echoed back so intent travels with the artifact. */
  request: string;
  /** What it patches. */
  target: TargetRef;
  /** How it reaches it. */
  reach: ReachTarget;
  /** The versions of the target it claims to work against, checked at load. */
  targetVersionRange: TargetVersionRange;
  /** Minimum Obsidian version, checked with `requireApiVersion()` before anything is installed. */
  appMinVersion?: string;
  noEffect: NoEffectPolicy;
  /**
   * What the mod does to things that are not itself. Travels **inside** the signed payload, so the
   * declaration a person reviews is the one the daemon computed over the bytes it signed — a
   * declaration carried alongside the artifact would be editable in transit by anything that could
   * edit the artifact, which is exactly the position the signature exists to remove.
   */
  effects?: EffectsDeclaration;
  /** One or two sentences, in plain language, of what this mod does and how. Shown in the mod list. */
  explanation: string;
  generator: GeneratorInfo;
  issuedAt: string;
  /** After this, the plugin refuses to install the artifact. Keeps a stale reply from being replayed. */
  expiresAt: string;
}

/** The short-lived subkey delegation. The plugin pins only the long-lived **root** key. */
export interface DelegationCert {
  /** Domain separation — must equal {@link MODKIT_CERT_PURPOSE}, checked before anything else. */
  purpose: typeof MODKIT_CERT_PURPOSE;
  /** Key id, for logs and for saying *which* key signed when there is more than one. */
  kid: string;
  /** The delegated signing subkey: raw 32-byte Ed25519 public key, 64 lowercase hex. */
  pubkey: string;
  /** The root key that signed this cert: raw 32-byte Ed25519 public key, 64 lowercase hex. */
  issuer: string;
  notBefore: string;
  notAfter: string;
}

/**
 * A delegation cert plus the root signature over it.
 *
 * The validity window is checked **only after** the signature verifies. The other order makes a
 * forged cert report a date problem, which sends whoever is debugging to the clock instead of to
 * the forgery.
 */
export interface SignedCert {
  /** Standard (padded) base64 of `utf8(JSON.stringify(cert))`. */
  cert: string;
  /** Standard base64 of the raw 64-byte Ed25519 signature by the root key over `ascii(cert)`. */
  sig: string;
}

/**
 * The envelope the daemon returns and the plugin verifies before a single byte reaches the vault.
 *
 * Verification order, and none of it is optional:
 * 1. `cert.sig` verifies against the pinned root key, over the ASCII bytes of `cert.cert`.
 * 2. `purpose` equals {@link MODKIT_CERT_PURPOSE}; only then is the cert's window checked.
 * 3. `sig` verifies against the cert's `pubkey`, over the ASCII bytes of `payload`.
 * 4. Only then is `payload` decoded and its `protocol` / `expiresAt` checked.
 *
 * An unverified payload never names a file this plugin writes.
 */
export interface SignedArtifact {
  protocol: ModkitProtocol;
  /** Standard (padded) base64 of `utf8(JSON.stringify(payload))`. See {@link ArtifactPayload}. */
  payload: string;
  /** Standard base64 of the raw 64-byte Ed25519 signature over `ascii(payload)`. */
  sig: string;
  cert: SignedCert;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Refusal
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a request could not be turned into a patch. A refusal is a **first-class, correct outcome** —
 * an honest "I cannot reach that, here is why" always beats a patch that silently does nothing.
 *
 * The first three are the silent-no-op classes that must be caught before generation, not
 * discovered in production:
 * - `accessor` — `around()` reads a property then writes it, so a getter-only member is not
 *   patchable this way at all (Tasks' `apiV1`, QuickAdd's `api`).
 * - `bound-at-construction` — the method was captured with `.bind(this)` when the object was
 *   built, so it is off the prototype call path and patching the prototype afterwards does
 *   nothing. True of both Tasks renderers.
 * - `method-missing` — `around()` on a missing method silently *creates* the property and only
 *   errors when something calls it.
 */
export type RefusalReason =
  | 'accessor'
  | 'bound-at-construction'
  | 'method-missing'
  | 'non-writable'
  | 'module-local'
  | 'target-not-installed'
  | 'target-disabled'
  | 'ambiguous-target'
  | 'no-source-available'
  | 'unsupported-request'
  | 'policy';

/** The refusal variant of a generation. Carries no `main.js`, by construction. */
export interface GenerateRefusal {
  kind: 'refused';
  reason: RefusalReason;
  /** What was being modded, so the mod list can still show the attempt. */
  target: TargetRef;
  /** The plane that was tried, when one got far enough to be identified. */
  attempted?: ReachTarget;
  /** One or two sentences the user reads. Plain language, names the thing that could not be reached. */
  explanation: string;
  /** The technical specifics — symbol name, descriptor shape, what the pre-flight saw. */
  detail: string;
  /**
   * An honest alternative, when there is one: a different plane, a narrower request, a thing to
   * turn on first. Omitted rather than invented.
   */
  suggestion?: string;
}

/** The success variant. Carries no refusal reason, by construction. */
export interface GenerateBuilt {
  kind: 'built';
  /** The generated plugin id, duplicated out of the signed payload so the UI need not decode it. */
  modId: string;
  /** The plane actually used, likewise duplicated for display. Authoritative copy is inside `artifact`. */
  reach: ReachTarget;
  /** Human explanation, likewise duplicated for display. */
  explanation: string;
  /** The signed envelope. Nothing is written to the vault until this verifies. */
  artifact: SignedArtifact;
  /**
   * Non-fatal validator findings. An artifact is only built when there are no `error`-severity
   * findings, so anything here is a warning worth showing but not worth blocking on.
   */
  warnings?: ValidationFinding[];
}

/** The outcome of a generation that ran to completion. */
export type GenerateResult = GenerateBuilt | GenerateRefusal;

/** Narrowing helper. */
export function isRefusal(result: GenerateResult): result is GenerateRefusal {
  return result.kind === 'refused';
}

/** Narrowing helper. */
export function isBuilt(result: GenerateResult): result is GenerateBuilt {
  return result.kind === 'built';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Validator findings
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The rules the daemon-side validator enforces on generated code. This enforcement is the single
 * structural advantage modkit has over the ecosystem it is joining, so the rule ids are part of
 * the contract rather than an implementation detail: they appear in job errors, in the mod list,
 * and in whatever the user gets shown when a generation is rejected.
 */
export type ValidationRuleId =
  /** The source did not parse as an ES module. */
  | 'parse'
  /** A top-level statement other than an import, an export, or a static declaration. */
  | 'no-top-level-side-effects'
  /** Reads a banned global outside a `this.register*()` acquisition. */
  | 'no-bare-global'
  /** Assigns to a property of an object it does not own — patch through `around()`, never by assignment. */
  | 'no-host-assignment'
  /** A raw `setTimeout` / `setInterval` not wrapped in `this.registerInterval(...)`. */
  | 'no-raw-timer'
  /** A raw `addEventListener` instead of `this.registerDomEvent(...)`. */
  | 'no-raw-listener'
  /** An `around()` call not lexically inside `this.register(...)`, so the patch never uninstalls. */
  | 'patch-must-be-registered'
  /** `eval` or `new Function`. */
  | 'no-eval'
  /** An import of something other than `obsidian` or `monkey-around`. */
  | 'import-not-allowed'
  /** Missing or wrong default export — it must be exactly one class extending `Plugin`. */
  | 'default-export-must-extend-plugin'
  /** Computed member access on the host graph, the trivial bypass for every name-based rule here. */
  | 'no-dynamic-host-member'
  /** An undocumented internal (`app.plugins`, `app.commands`, `app.viewRegistry`) reached without `?.`. */
  | 'unguarded-internal-access'
  /** The template's version gate is absent or does not run before the first `around()`. */
  | 'missing-version-gate'
  /** The no-effect probe required by {@link NoEffectPolicy} is absent. */
  | 'missing-no-effect-probe'
  /** The chosen target is an accessor — see {@link RefusalReason} `accessor`. */
  | 'accessor-target'
  /** The chosen target is bound at construction — see {@link RefusalReason} `bound-at-construction`. */
  | 'bound-method-target';

/**
 * `error` blocks the artifact; `warning` is reported and shipped. There is no `info` — a finding
 * nobody has to act on is noise in a list whose whole value is that everything in it matters.
 */
export type ValidationSeverity = 'error' | 'warning';

/** One validator finding. */
export interface ValidationFinding {
  /**
   * The rule that fired. Typed as the known union *or* an arbitrary string, so the daemon can add
   * a rule without a protocol bump while the known ids still autocomplete and narrow.
   */
  rule: ValidationRuleId | (string & {});
  severity: ValidationSeverity;
  /** What is wrong, in the imperative: what the code did and what it should have done instead. */
  message: string;
  /** 1-based line in the validated source. */
  line: number;
  /** 1-based column in the validated source. */
  column: number;
  /**
   * The offending source line, trimmed. Load-bearing when the validated text is not the text the
   * model wrote (a TypeScript transform shifts every location), because then the line number alone
   * is a lie.
   */
  excerpt?: string;
  /** Which file the location refers to. Defaults to `main.js`. */
  file?: string;
}

/** The validator's whole answer. `ok` is exactly "no finding has severity `error`". */
export interface ValidationReport {
  ok: boolean;
  findings: ValidationFinding[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Jobs
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Generation takes seconds to minutes, so `/v1/generate` is async and the plugin polls
 * `/v1/jobs/:id`.
 *
 * `refused` is a **terminal success**, not a failure: the daemon did its job and the answer was
 * "no". `failed` means the pipeline itself broke.
 */
export type JobStatus =
  | 'queued'
  | 'generating'
  | 'validating'
  | 'building'
  | 'done'
  | 'refused'
  | 'failed';

/** A one-line, user-facing progress note. Not a log — the log stays on the daemon. */
export interface JobProgress {
  /** e.g. `"reading obsidian-tasks-plugin at 7.21.0"`. Shown verbatim in a `Notice`. */
  message: string;
  /** 0–1, when the daemon can honestly estimate it. Omitted rather than faked. */
  fraction?: number;
  updatedAt: string;
}

/** Machine-readable classification of a job failure. */
export type JobErrorCode =
  | 'model-failed'
  | 'model-timeout'
  /**
   * The backend CLI is not signed in, or its session expired. Distinct from `model-failed`
   * because it is the one model error a *user* can fix, and the fix is a login command rather
   * than a retry — `JobError.retryable` is false for it.
   */
  | 'model-auth'
  | 'budget-exceeded'
  | 'source-fetch-failed'
  | 'validation-failed'
  | 'build-failed'
  | 'signing-failed'
  | 'bad-request'
  | 'protocol-mismatch'
  | 'internal';

/** Why a job failed. Distinct from a refusal: this is modkit breaking, not modkit declining. */
export interface JobError {
  code: JobErrorCode;
  /** One sentence for the user. */
  message: string;
  /** Everything else — stderr tail, esbuild message, model error string. May be long. */
  detail?: string;
  /** True when the identical request could plausibly succeed on a retry. */
  retryable: boolean;
  /** Present when `code` is `validation-failed`. */
  findings?: ValidationFinding[];
}

/** Fields every job carries regardless of status. */
export interface JobBase {
  protocol: ModkitProtocol;
  id: string;
  /** Echoed from the request, so a client that lost the response can find its job again. */
  idempotencyKey: string;
  /** For display in a job list without decoding the whole request. */
  targetKey: string;
  /** The user's sentence, for the same reason. */
  request: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the job reached a terminal status. */
  finishedAt?: string;
  progress?: JobProgress;
}

/** A job still running. Carries neither a result nor an error. */
export interface JobRunning extends JobBase {
  status: 'queued' | 'generating' | 'validating' | 'building';
}

/** A job that produced an installable artifact. */
export interface JobDone extends JobBase {
  status: 'done';
  result: GenerateBuilt;
  finishedAt: string;
}

/** A job that correctly declined. */
export interface JobRefused extends JobBase {
  status: 'refused';
  result: GenerateRefusal;
  finishedAt: string;
}

/** A job that broke. */
export interface JobFailed extends JobBase {
  status: 'failed';
  error: JobError;
  finishedAt: string;
}

/** `GET /v1/jobs/:id` response. */
export type Job = JobRunning | JobDone | JobRefused | JobFailed;

/** True once the job will never change again. */
export function isTerminalJob(job: Job): job is JobDone | JobRefused | JobFailed {
  return job.status === 'done' || job.status === 'refused' || job.status === 'failed';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mod health
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The vocabulary the whole product reports in — the mod list, and any notice a mod raises about
 * itself. Five states, and they are deliberately the only five:
 *
 * - `applied` — the patch installed, the version gate passed, and (for an `event-driven` mod) it
 *   has been invoked at least once.
 * - `no-effect` — it installed but nothing happened: an `event-driven` mod past its deadline with
 *   a call count of zero, or a probe that returned false. This is the number PLAN §M3 says must be
 *   zero, and silence here is the failure mode that poisons everything downstream.
 * - `target-moved` — the target is present but has changed underneath the mod: the installed
 *   version fell outside {@link TargetVersionRange}. The mod is inert and is a regeneration
 *   candidate.
 * - `target-gone` — the target plugin is not installed, not enabled, or no longer exposes the
 *   member at all.
 * - `error` — the mod threw during load or during a patched call.
 *
 * **Do not add a sixth.** Two states that appear in the recon material map onto these rather than
 * extending them: an out-of-range version gate is `target-moved` (with the bounds in `detail`),
 * and "installed but never invoked" is `no-effect`. A vocabulary that grows a case per symptom
 * stops being a vocabulary.
 */
export type ModHealthState = 'applied' | 'no-effect' | 'target-moved' | 'target-gone' | 'error';

/** Ordered worst-first, for sorting a mod list so the things that need attention are at the top. */
export const MOD_HEALTH_SEVERITY: Record<ModHealthState, number> = {
  error: 0,
  'target-gone': 1,
  'target-moved': 2,
  'no-effect': 3,
  applied: 4,
};

/** A mod's current health, as last observed. */
export interface ModHealth {
  state: ModHealthState;
  /**
   * Why, specifically, in one sentence the user can act on — `"Tasks 7.22.0 is outside 7.20.0–7.22.0"`,
   * not `"version mismatch"`. Empty string is allowed only for `applied`.
   */
  detail: string;
  lastCheckedAt: string;
  /** The target version seen at that check; `null` when the target was not installed. */
  targetVersionSeen?: string | null;
  /** How many times the patched member has been invoked since this mod last loaded. */
  invocations?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Persisted mod records
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What modkit stores in its own `data.json` for each installed mod.
 *
 * The load-bearing field is `request`. Regeneration does not repair a broken patch — it regenerates
 * from the original intent against the new source, so a record that has lost the sentence that
 * produced it is a mod that can never be repaired.
 */
export interface ModRecord {
  protocol: ModkitProtocol;
  /** The generated plugin id, and its directory under `.obsidian/plugins/`. */
  modId: string;
  /** Display name, from the generated manifest. */
  name: string;
  /** **The regeneration seed.** The user's sentence, verbatim, forever. */
  request: string;
  /** What the user was pointing at, kept so a regeneration reuses the same pick. */
  evidence?: PickEvidence;
  /** The target, and the version it was generated against — not the version installed today. */
  target: TargetRef;
  /** The plane that was used. */
  reach: ReachTarget;
  targetVersionRange: TargetVersionRange;
  /** Hex SHA-256 of the `main.js` on disk, so a hand-edited mod is detectable. */
  sha256: string;
  /** Plain-language description shown in the mod list. */
  explanation: string;
  generator: GeneratorInfo;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether modkit believes the mod should be enabled. This is modkit's own intent — the authority
   * on what is actually running is Obsidian's enabled-plugins set, and the two can disagree if the
   * user toggles the mod in Obsidian's own plugin list.
   */
  enabled: boolean;
  health: ModHealth;
  /**
   * Set once the user has confirmed the mod does what they asked. From then on the generated
   * assertions are frozen and only bindings regenerate — the mitigation for having no oracle
   * independent of the model that wrote the code.
   */
  userVerifiedAt?: string;
  /** Present when this record replaced an earlier generation. */
  regeneratedFrom?: RegenerationOrigin;
  /** The job that produced it, for tracing back to daemon logs. */
  jobId?: string;
}

/**
 * The shape of modkit's `data.json`. The plugin owns its own settings type and is expected to
 * intersect it with this.
 */
export interface ModkitDataFile {
  protocol: ModkitProtocol;
  mods: ModRecord[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * HTTP surface
 * ──────────────────────────────────────────────────────────────────────────── */

/** `GET /v1/health` — the one unauthenticated route. */
export interface HealthResponse {
  ok: true;
  service: 'modkit';
  protocol: ModkitProtocol;
  /** The daemon's version. */
  version: string;
  /** The pinned **root** Ed25519 public key, 64 lowercase hex — so a client can detect a key change. */
  pubkey: string;
  /** The model the daemon is configured to generate with. */
  model: string;
  /** The backend the daemon is configured to generate with. */
  backend: ModelBackend;
  /**
   * Whether this daemon will honour a `codex` override at all — i.e. whether its operator set
   * `MODKIT_CODEX_ACKNOWLEDGE_SANDBOX=1`. A client offering a backend picker reads this so it can
   * say *why* codex is unavailable instead of letting someone choose an option that will fail on
   * every generation.
   */
  codexAvailable: boolean;
  uptimeMs: number;
}

/**
 * `GET /v1/model-check` — can this daemon actually reach a model right now?
 *
 * Authenticated, and cheap by default. `?deep=1` spends one minimal model turn, which is the only
 * way to distinguish "signed in" from "the binary exists": a CLI with a dead OAuth session still
 * answers `--version` happily.
 */
export interface ModelCheckResponse {
  protocol: ModkitProtocol;
  backend: ModelBackend;
  /** Absolute path the daemon will spawn, or `null` when it could not find the CLI at all. */
  binPath: string | null;
  /** Everywhere it looked, so a "not found" can name the places instead of shrugging. */
  searched: string[];
  /** `<bin> --version`, when the binary ran. */
  version: string | null;
  /** `true` signed in, `false` definitely not, `null` not asked (shallow check). */
  signedIn: boolean | null;
  /** The one sentence to act on, or `null` when nothing needs fixing. */
  hint: string | null;
  /** e.g. `claude login` — what to run when `signedIn` is false. */
  loginCommand: string;
}

/** `202` from `POST /v1/generate` and `POST /v1/regenerate`. */
export interface JobAccepted {
  protocol: ModkitProtocol;
  jobId: string;
  status: JobStatus;
  /** True when an existing job was returned because the idempotency key had been seen before. */
  deduped?: boolean;
}

/** `POST /v1/validate` — dev-only introspection over a source string. */
export interface ValidateRequest {
  protocol: ModkitProtocol;
  source: string;
}

/** Transport-level failures, distinct from a {@link JobError} inside a job that started. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'protocol-mismatch'
  | 'rate-limited'
  | 'internal';

/** The body of every non-2xx response. */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    detail?: string;
    /** Present on `protocol-mismatch`, so the mismatch is legible without reading two changelogs. */
    expectedProtocol?: string;
    receivedProtocol?: string;
  };
}
