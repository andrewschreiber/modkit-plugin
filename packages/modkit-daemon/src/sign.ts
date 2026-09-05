/**
 * Ed25519 signing: a two-key chain, and the daemon-side mirror of the plugin's verifier.
 *
 * **Why two keys.** A long-lived **root** key does exactly one thing: sign a short-lived
 * delegation certificate naming a signing subkey. The subkey signs artifacts. The plugin pins
 * only the root public key, so rotating the day-to-day signing key never requires touching a
 * setting on a device — and a compromised subkey expires on its own.
 *
 * **Domain separation.** The wire format (`@modkit/types`) signs the ASCII bytes of a base64
 * string with no prefix, so separation is structural rather than lexical, and it is worth naming
 * because it is the property that keeps a root signature from being replayable as an artifact
 * signature:
 *   - the **root** key signs only a document whose first field is `purpose: MODKIT_CERT_PURPOSE`;
 *   - the **subkey** signs only a document whose first field is `protocol: MODKIT/1`;
 *   - a subkey is never a root and never signs a cert, because it is generated here and its
 *     public half only ever appears inside a cert the root signed.
 * That `purpose` field is 40 bytes that make it structurally impossible for a root-signed
 * document from some future feature to be presented here as a signing delegation.
 *
 * **Base64, not a sorted-key replacer.** An earlier scheme in this ecosystem signed the object
 * with `JSON.stringify(obj, sortedKeyArray)`. A replacer *array* filters keys at **every depth**,
 * so nested objects serialise as `{}` — signed and verified consistently on both sides while
 * covering nothing. Signing an opaque base64 string removes the entire class of problem.
 */

import crypto, { type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  MODKIT_CERT_PURPOSE,
  MODKIT_PROTOCOL_VERSION,
  type ArtifactPayload,
  type DelegationCert,
  type EffectsDeclaration,
  type GeneratorInfo,
  type NoEffectPolicy,
  type ObsidianPluginManifest,
  type ReachTarget,
  type SignedArtifact,
  type SignedCert,
  type TargetRef,
  type TargetVersionRange,
} from '@modkit/types';

import type { Logger } from './log.js';
import { ensureDir, readJsonSync, writeAtomicSync, writeJsonSync, type StateLayout } from './state.js';

// `ModEffect` and `EffectsDeclaration` live in `@modkit/types` now — both sides of the wire need
// them, and this module re-exports them so the existing `import type { ModEffect } from './sign.js'`
// call sites keep working unchanged.
export type { ModEffect, EffectsDeclaration } from '@modkit/types';

/** A DER Ed25519 SPKI is this fixed 12-byte prefix followed by exactly the 32 key bytes. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const HEX32 = /^[0-9a-f]{64}$/;

/* ────────────────────────────────────────────────────────────────────────────
 * Primitives
 * ──────────────────────────────────────────────────────────────────────────── */

/** Mint a keypair and write the private half as PKCS8 PEM, `0600`, in a `0700` directory. */
export function mintPrivateKey(file: string): KeyObject {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  writeAtomicSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 0o600);
  return privateKey;
}

export function loadOrMintPrivateKey(file: string): { key: KeyObject; created: boolean } {
  if (existsSync(file)) {
    try {
      return { key: crypto.createPrivateKey(readFileSync(file, 'utf8')), created: false };
    } catch (err) {
      throw new Error(`${file} exists but is not a readable PKCS8 private key: ${String(err)}`);
    }
  }
  return { key: mintPrivateKey(file), created: true };
}

/**
 * The raw 32-byte public key as lowercase hex, **derived from the private key** every time.
 * Never stored alongside it — two files that can disagree eventually will.
 */
export function pubkeyHex(privateKey: KeyObject): string {
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32)).toString('hex');
}

export function publicKeyFromHex(hex: string): KeyObject {
  if (!HEX32.test(hex)) throw new Error('an Ed25519 public key must be 64 lowercase hex characters');
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/** `null` algorithm is correct for Ed25519: it signs the message, not a hash of it. */
function signAscii(privateKey: KeyObject, ascii: string): string {
  return crypto.sign(null, Buffer.from(ascii, 'ascii'), privateKey).toString('base64');
}

function verifyAscii(pubHex: string, ascii: string, sigB64: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(ascii, 'ascii'), publicKeyFromHex(pubHex), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

function b64Encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function b64DecodeJson<T>(b64: string): T {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as T;
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ────────────────────────────────────────────────────────────────────────────
 * The keyring
 * ──────────────────────────────────────────────────────────────────────────── */

export interface Keyring {
  /** What the plugin pins. 64 lowercase hex. */
  rootPubkeyHex: string;
  /** The subkey currently signing artifacts. */
  signPubkeyHex: string;
  kid: string;
  cert: SignedCert;
  /** Parsed out of the cert so artifact expiry can be clamped to it without decoding again. */
  certNotAfter: string;
  signKey: KeyObject;
}

export interface KeyringOptions {
  certTtlMs: number;
  certRenewBeforeMs: number;
  now?: number;
}

/**
 * Load the root key, then the current delegation cert — minting either if it is missing, and
 * minting a **fresh subkey plus cert** whenever the existing one is invalid, expired, or close
 * enough to expiry that an artifact signed now would outlive it.
 *
 * That last case is the one worth stating: a cert the daemon is happy with but the plugin rejects
 * produces total silence on the device, and the daemon is the only place anyone is watching.
 */
export function loadKeyring(layout: StateLayout, log: Logger, options: KeyringOptions): Keyring {
  ensureDir(layout.secretsDir);
  const now = options.now ?? Date.now();

  const root = loadOrMintPrivateKey(layout.rootKeyFile);
  const rootPubkeyHex = pubkeyHex(root.key);
  if (root.created) {
    log.warn('minted a new modkit ROOT signing key — every plugin pinning the old key must run setup again', {
      file: layout.rootKeyFile,
      rootPubkey: rootPubkeyHex,
    });
  }

  const existing = readJsonSync<SignedCert>(layout.certFile);
  if (existing && existsSync(layout.signKeyFile)) {
    const reuse = evaluateCert(existing, layout.signKeyFile, rootPubkeyHex, now, options.certRenewBeforeMs);
    if (reuse.ok) {
      log.info('using the existing signing delegation', { kid: reuse.keyring.kid, notAfter: reuse.keyring.certNotAfter });
      return reuse.keyring;
    }
    log.info('rotating the signing subkey', { reason: reuse.detail });
  }

  return mintDelegation(layout, root.key, rootPubkeyHex, now, options.certTtlMs, log);
}

type CertEvaluation = { ok: true; keyring: Keyring } | { ok: false; detail: string };

function evaluateCert(
  signed: SignedCert,
  signKeyFile: string,
  rootPubkeyHex: string,
  now: number,
  renewBeforeMs: number,
): CertEvaluation {
  if (typeof signed.cert !== 'string' || typeof signed.sig !== 'string') {
    return { ok: false, detail: 'stored cert is not a SignedCert' };
  }
  if (!verifyAscii(rootPubkeyHex, signed.cert, signed.sig)) {
    return { ok: false, detail: 'stored cert is not signed by the current root key' };
  }

  let cert: DelegationCert;
  try {
    cert = b64DecodeJson<DelegationCert>(signed.cert);
  } catch {
    return { ok: false, detail: 'stored cert does not decode to JSON' };
  }
  if (cert.purpose !== MODKIT_CERT_PURPOSE) return { ok: false, detail: `cert purpose is ${String(cert.purpose)}` };
  if (cert.issuer !== rootPubkeyHex) return { ok: false, detail: 'cert names a different root key' };

  const notAfter = Date.parse(cert.notAfter);
  if (!Number.isFinite(notAfter)) return { ok: false, detail: 'cert notAfter is unparseable' };
  if (notAfter - now <= renewBeforeMs) return { ok: false, detail: `cert expires ${cert.notAfter}` };

  let signKey: KeyObject;
  try {
    signKey = crypto.createPrivateKey(readFileSync(signKeyFile, 'utf8'));
  } catch {
    return { ok: false, detail: 'the delegated private key is missing or unreadable' };
  }
  if (pubkeyHex(signKey) !== cert.pubkey) {
    return { ok: false, detail: 'the delegated private key does not match the key named in the cert' };
  }

  return {
    ok: true,
    keyring: {
      rootPubkeyHex,
      signPubkeyHex: cert.pubkey,
      kid: cert.kid,
      cert: signed,
      certNotAfter: cert.notAfter,
      signKey,
    },
  };
}

function mintDelegation(
  layout: StateLayout,
  rootKey: KeyObject,
  rootPubkeyHex: string,
  now: number,
  certTtlMs: number,
  log: Logger,
): Keyring {
  const signKey = mintPrivateKey(layout.signKeyFile);
  const signPubkeyHex = pubkeyHex(signKey);
  const kid = sha256Hex(signPubkeyHex).slice(0, 16);

  const cert: DelegationCert = {
    purpose: MODKIT_CERT_PURPOSE,
    kid,
    pubkey: signPubkeyHex,
    issuer: rootPubkeyHex,
    // Backdated a minute: a device whose clock is a few seconds behind must not reject a cert
    // that was minted while it was asking for one.
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + certTtlMs).toISOString(),
  };
  const certB64 = b64Encode(cert);
  const signed: SignedCert = { cert: certB64, sig: signAscii(rootKey, certB64) };
  writeJsonSync(layout.certFile, signed, 0o600);

  log.info('minted a signing delegation', { kid, notAfter: cert.notAfter, signPubkey: signPubkeyHex });
  return { rootPubkeyHex, signPubkeyHex, kid, cert: signed, certNotAfter: cert.notAfter, signKey };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Signing an artifact
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What the generation pipeline hands back for signing: an {@link ArtifactPayload} minus everything
 * only the daemon can honestly fill in.
 *
 * `sha256`, `issuedAt`, `expiresAt` and `generator.daemonVersion` are computed here on purpose —
 * a digest supplied by the same step that produced the bytes proves nothing, and an expiry chosen
 * by the generator could outlive the certificate that authorises it.
 */
export interface ArtifactDraft {
  modId: string;
  manifest: ObsidianPluginManifest;
  /** The built CJS bundle, verbatim. Hashed here; this exact string is what the plugin writes. */
  mainJs: string;
  stylesCss?: string;
  /** The user's sentence, verbatim. Never normalised on the way through. */
  request: string;
  target: TargetRef;
  reach: ReachTarget;
  targetVersionRange: TargetVersionRange;
  appMinVersion?: string;
  noEffect: NoEffectPolicy;
  explanation: string;
  /**
   * What the mod does to things that are not itself. Travels **inside** the signed payload, so the
   * declaration a person reads in the review is the one the daemon computed over the bytes it
   * signed — a declaration carried alongside the artifact would be editable in transit by anything
   * that could edit the artifact, which is exactly the position the signature exists to remove.
   */
  effects?: EffectsDeclaration;
  /** The model that actually served — read from `modelUsage`, never echoed from the request. */
  model: string;
}

export interface SignArtifactOptions {
  keyring: Keyring;
  daemonVersion: string;
  artifactTtlMs: number;
  now?: number;
}

export function signArtifact(draft: ArtifactDraft, options: SignArtifactOptions): SignedArtifact {
  const now = options.now ?? Date.now();
  const certNotAfter = Date.parse(options.keyring.certNotAfter);

  // Clamp to the cert: an artifact that outlives the certificate that authorises it verifies here
  // and fails on the device, which is the one failure shape nobody is watching for.
  const expiresAt = Math.min(now + options.artifactTtlMs, certNotAfter);
  if (!(expiresAt > now)) {
    throw new Error('the signing certificate expires before this artifact would — rotate the subkey first');
  }

  const generator: GeneratorInfo = {
    model: draft.model,
    daemonVersion: options.daemonVersion,
    generatedAt: new Date(now).toISOString(),
  };

  const payload: ArtifactPayload = {
    protocol: MODKIT_PROTOCOL_VERSION,
    modId: draft.modId,
    manifest: draft.manifest,
    mainJs: draft.mainJs,
    ...(draft.stylesCss === undefined ? {} : { stylesCss: draft.stylesCss }),
    sha256: sha256Hex(draft.mainJs),
    request: draft.request,
    target: draft.target,
    reach: draft.reach,
    targetVersionRange: draft.targetVersionRange,
    ...(draft.appMinVersion === undefined ? {} : { appMinVersion: draft.appMinVersion }),
    noEffect: draft.noEffect,
    explanation: draft.explanation,
    ...(draft.effects === undefined ? {} : { effects: draft.effects }),
    generator,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };

  const payloadB64 = b64Encode(payload);
  const artifact: SignedArtifact = {
    protocol: MODKIT_PROTOCOL_VERSION,
    payload: payloadB64,
    sig: signAscii(options.keyring.signKey, payloadB64),
    cert: options.keyring.cert,
  };

  // Publish-time self-check, against the same rules the plugin applies. The daemon is the only
  // place anyone is watching; a mismatch discovered on the device is discovered as silence.
  const check = verifySignedArtifact(artifact, options.keyring.rootPubkeyHex, now);
  if (!check.ok) {
    throw new Error(`refusing to emit an artifact this daemon cannot verify: ${check.detail}`);
  }
  return artifact;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Verification (the daemon's mirror of the plugin's)
 * ──────────────────────────────────────────────────────────────────────────── */

export type VerifyResult =
  | { ok: true; kid: string; payload: ArtifactPayload }
  | { ok: false; reason: 'bad-cert' | 'bad-signature' | 'bad-payload'; detail: string };

/**
 * Verification order, and none of it is optional or reorderable:
 *
 * 1. the cert's signature against the pinned root key;
 * 2. `purpose` and `issuer` — and **only then** the cert's validity window;
 * 3. the artifact signature against the delegated key;
 * 4. only then is the payload decoded and its protocol and expiry checked.
 *
 * Step 2's ordering is the one that gets written the other way round first: checking the window
 * before the signature makes a *forged* cert report a date problem, which sends whoever is
 * debugging to the clock instead of to the forgery.
 */
export function verifySignedArtifact(
  artifact: SignedArtifact,
  rootPubkeyHex: string,
  now: number = Date.now(),
): VerifyResult {
  const cert = artifact.cert;
  if (!cert || typeof cert.cert !== 'string' || typeof cert.sig !== 'string') {
    return { ok: false, reason: 'bad-cert', detail: 'no delegation certificate' };
  }
  if (!verifyAscii(rootPubkeyHex, cert.cert, cert.sig)) {
    return { ok: false, reason: 'bad-cert', detail: 'the certificate is not signed by the pinned root key' };
  }

  let decodedCert: DelegationCert;
  try {
    decodedCert = b64DecodeJson<DelegationCert>(cert.cert);
  } catch {
    return { ok: false, reason: 'bad-cert', detail: 'the certificate is not decodable JSON' };
  }
  if (decodedCert.purpose !== MODKIT_CERT_PURPOSE) {
    return { ok: false, reason: 'bad-cert', detail: `certificate purpose is ${JSON.stringify(decodedCert.purpose)}` };
  }
  if (decodedCert.issuer !== rootPubkeyHex) {
    return { ok: false, reason: 'bad-cert', detail: 'certificate names a different issuer than the pinned root key' };
  }
  if (typeof decodedCert.pubkey !== 'string' || !HEX32.test(decodedCert.pubkey)) {
    return { ok: false, reason: 'bad-cert', detail: 'certificate names no usable subkey' };
  }
  if (Date.parse(decodedCert.notBefore) > now) {
    return { ok: false, reason: 'bad-cert', detail: `certificate is not valid until ${decodedCert.notBefore}` };
  }
  if (Date.parse(decodedCert.notAfter) <= now) {
    return { ok: false, reason: 'bad-cert', detail: `certificate expired ${decodedCert.notAfter}` };
  }

  if (typeof artifact.payload !== 'string' || typeof artifact.sig !== 'string') {
    return { ok: false, reason: 'bad-signature', detail: 'artifact carries no payload or signature' };
  }
  if (!verifyAscii(decodedCert.pubkey, artifact.payload, artifact.sig)) {
    return { ok: false, reason: 'bad-signature', detail: 'artifact is not signed by the delegated key' };
  }

  let payload: ArtifactPayload;
  try {
    payload = b64DecodeJson<ArtifactPayload>(artifact.payload);
  } catch {
    return { ok: false, reason: 'bad-payload', detail: 'payload is not decodable JSON' };
  }
  if (payload.protocol !== MODKIT_PROTOCOL_VERSION) {
    return { ok: false, reason: 'bad-payload', detail: `payload protocol is ${String(payload.protocol)}` };
  }
  if (payload.sha256 !== sha256Hex(payload.mainJs)) {
    return { ok: false, reason: 'bad-payload', detail: 'main.js does not match the signed digest' };
  }
  if (Date.parse(payload.expiresAt) <= now) {
    return { ok: false, reason: 'bad-payload', detail: `artifact expired ${payload.expiresAt}` };
  }

  return { ok: true, kid: decodedCert.kid, payload };
}

/** Decode a payload without verifying — for archiving alongside the artifact, never for a decision. */
export function decodePayload(artifact: SignedArtifact): ArtifactPayload | null {
  try {
    return b64DecodeJson<ArtifactPayload>(artifact.payload);
  } catch {
    return null;
  }
}
