/**
 * Signature verification for a generated artifact — the gate between "the daemon said this is a
 * mod" and "modkit wrote a `main.js` into the vault".
 *
 * Three properties this file is shaped around:
 *
 * 1. **No `node:crypto`, anywhere.** Obsidian mobile is a Capacitor WebView with no node, and a
 *    verifier that only works on desktop is a verifier that silently degrades to "trust it" on the
 *    device where the artifact arrived by sync. Ed25519 comes from `@noble/ed25519` (pure JS) and
 *    SHA-256/SHA-512 from WebCrypto `subtle`, which is available in both hosts.
 *
 * 2. **A signature over the wrong thing is worse than no signature**, because it looks like safety.
 *    So verification does not stop at "the bytes are signed": it checks that the signed payload
 *    actually *binds* the four fields an installer acts on — the generated plugin id, the digest of
 *    `main.js`, the target being modded, and the protocol version. See {@link checkBinding}.
 *
 * 3. **Fail closed, and name the check.** Every failure carries a `check` slug and a `detail`, so
 *    the user is told which of ~15 distinct things went wrong rather than "signature invalid".
 *
 * Ordering is deliberate and two steps of it are lifted from a place that got them wrong first:
 * the certificate's validity window is checked **only after** its signature verifies (otherwise a
 * forged cert reports a date problem and sends whoever is debugging to the clock instead of to the
 * forgery), and nothing is decoded-and-acted-on before the signature covering it verifies.
 */

import * as ed from "@noble/ed25519";
import {
	MODKIT_CERT_PURPOSE,
	MODKIT_MOD_ID_PREFIX,
	MODKIT_PROTOCOL_VERSION,
	targetKey,
} from "@modkit/types";
import type {
	ArtifactPayload,
	DelegationCert,
	SignedArtifact,
	SignedCert,
} from "@modkit/types";

/* ────────────────────────────────────────────────────────────────────────────
 * Result types
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why verification failed. Coarser than {@link VerifyFailure.check} on purpose: the code is what the
 * UI branches on, the check slug is what it prints.
 */
export type VerifyFailureCode =
	/** No usable root key is pinned in settings. With require-signature on, this is a refusal. */
	| "unpinned"
	/** `crypto.subtle` is missing, so neither hash is computable. Verification cannot even be attempted. */
	| "crypto-unavailable"
	/** The envelope, certificate or payload is not the shape it claims to be. */
	| "malformed"
	/** The certificate is not signed by the pinned root key. */
	| "cert-signature"
	/** The certificate is authentic but is not a modkit artifact-signing delegation. */
	| "cert-untrusted"
	/** The certificate is authentic and correct, but not valid at this moment. */
	| "cert-window"
	/** The payload is not signed by the key the certificate delegates to. */
	| "artifact-signature"
	/** Signed and authentic, but from a peer speaking a different wire contract. */
	| "protocol-mismatch"
	/** Signed and authentic, but past its `expiresAt` — a stale reply being replayed. */
	| "expired"
	/** `sha256(mainJs)` is not the digest that was signed. */
	| "digest-mismatch"
	/** Authentic, unexpired — and about a different mod, target or file than the one asked for. */
	| "binding-mismatch";

/** Verification succeeded. The payload returned here is the only one an installer may act on. */
export interface VerifyOk {
	ok: true;
	/** The decoded payload, after every check. Use *this*, never a separately-decoded copy. */
	payload: ArtifactPayload;
	/** The delegation certificate that vouched for the signing key. */
	cert: DelegationCert;
	/** Key id of the subkey that signed the payload, for logs and the mod list. */
	kid: string;
	/** Lowercase hex SHA-256 actually computed over `mainJs` — equal to `payload.sha256`. */
	digest: string;
}

/** Verification failed. Nothing may be written to disk. */
export interface VerifyFailure {
	ok: false;
	code: VerifyFailureCode;
	/**
	 * Which named check failed, as a stable slug (`"cert.issuer"`, `"payload.sha256"`, …). This is
	 * the answer to "which check failed" and it belongs in the message the user sees.
	 */
	check: string;
	/** One sentence, in the user's terms. */
	message: string;
	/** The specifics — what was expected, what was found. Safe to log; contains no secrets. */
	detail: string;
}

export type VerifyResult = VerifyOk | VerifyFailure;

/** Narrowing helper, so call sites read as `if (isVerified(r))`. */
export function isVerified(result: VerifyResult): result is VerifyOk {
	return result.ok;
}

/**
 * What the caller already knows and is asking the signature to confirm.
 *
 * Every field except `rootPubkeyHex` is optional, and every one that is supplied tightens the
 * binding. Omitting `modId`/`targetKey` is legitimate (a mod arriving by sync has no in-flight
 * request to compare against) but it is strictly weaker: it proves the daemon authored *a* mod,
 * not that it authored *this* one.
 */
export interface VerifyExpectations {
	/** The pinned **root** Ed25519 public key, 64 hex characters. */
	rootPubkeyHex: string;
	/** The mod id the client asked for / announced. Compared against the signed payload. */
	modId?: string;
	/**
	 * `targetKey(target)` for the target the user pointed at. Compared against the signed payload's
	 * target, so an artifact for a different plugin cannot be installed under this request.
	 */
	targetKey?: string;
	/** Injectable clock, for tests. Defaults to `Date.now()`. */
	now?: number;
	/**
	 * Tolerance applied to both ends of every time window. Defaults to 5 minutes: two boxes with
	 * unsynchronised clocks is an ordinary condition, and a verifier that treats it as forgery
	 * teaches people to turn verification off.
	 */
	clockSkewMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Primitives
 * ──────────────────────────────────────────────────────────────────────────── */

const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(
	code: VerifyFailureCode,
	check: string,
	message: string,
	detail: string,
): VerifyFailure {
	return { ok: false, code, check, message, detail };
}

/** WebCrypto, or `null`. Never throws — "no crypto" is a reportable outcome, not an exception. */
function subtleOrNull(): SubtleCrypto | null {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	return c?.subtle ?? null;
}

/**
 * `ascii(s)` — the exact bytes the daemon signed.
 *
 * Both signature inputs are base64 strings, so ASCII and UTF-8 coincide; encoding them explicitly
 * as ASCII (and refusing anything else) means a payload smuggling a non-ASCII character cannot
 * produce two different byte strings on the two sides.
 */
function asciiBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code > 0x7f) throw new RangeError(`non-ASCII character at offset ${i}`);
		out[i] = code;
	}
	return out;
}

/**
 * The return type is inferred, not annotated. `TextEncoder.encode` is declared as
 * `Uint8Array<ArrayBuffer>`, and writing the wider `Uint8Array` here would widen it to
 * `Uint8Array<ArrayBufferLike>` — which `crypto.subtle.digest` rejects, because a `BufferSource`
 * may not be backed by a `SharedArrayBuffer`.
 */
function utf8Bytes(s: string) {
	return new TextEncoder().encode(s);
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

/** Standard (padded) base64 → bytes. Throws on anything `atob` will not take. */
function base64ToBytes(b64: string): Uint8Array {
	if (!BASE64.test(b64)) throw new RangeError("not standard base64");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Base64 of UTF-8 JSON → parsed object. The two failure modes are reported separately. */
function decodeBase64Json(b64: string): { ok: true; value: unknown } | { ok: false; detail: string } {
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(b64);
	} catch (e) {
		return { ok: false, detail: `not decodable base64 (${errText(e)})` };
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (e) {
		return { ok: false, detail: `decoded bytes are not valid UTF-8 (${errText(e)})` };
	}
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (e) {
		return { ok: false, detail: `decoded text is not JSON (${errText(e)})` };
	}
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * @noble/ed25519 configuration
 * ──────────────────────────────────────────────────────────────────────────── */

let ed25519Configured = false;

/**
 * Point `@noble/ed25519`'s async SHA-512 hook at WebCrypto.
 *
 * v2 splits the API in two: the **sync** entry points (`ed.verify`) need `etc.sha512Sync`, which we
 * deliberately never set — a synchronous SHA-512 would have to be a second JS implementation, and
 * the whole reason this file exists is that there is exactly one code path on desktop and mobile.
 * The **async** entry point (`ed.verifyAsync`) uses `etc.sha512Async`, which v2.3.0 already defaults
 * to a `crypto.subtle.digest("SHA-512", …)` call.
 *
 * We install our own anyway, for two reasons that are not cosmetic:
 *
 * - The shipped default reads `globalThis.crypto` **at call time** and throws a bare
 *   `"crypto.subtle must be defined"` from deep inside the curve maths. Ours resolves `subtle` up
 *   front and throws a message naming modkit and the host, which is the difference between a
 *   diagnosable mobile failure and a mystery.
 * - The default hashes `m.buffer`. That is correct for the array it builds today, but it is wrong
 *   for any `Uint8Array` that is a *view* over a larger buffer, and depending on that invariant
 *   holding inside someone else's library is not a dependency worth having. We pass the view.
 *
 * Idempotent, and safe to call at plugin `onload()` as well as lazily from {@link verifyArtifact}.
 */
export function configureEd25519(): void {
	if (ed25519Configured) return;
	ed.etc.sha512Async = async (...messages: Uint8Array[]): Promise<Uint8Array> => {
		const subtle = subtleOrNull();
		if (!subtle) {
			throw new Error(
				"modkit: crypto.subtle is unavailable in this Obsidian host, so Ed25519 signatures cannot be verified",
			);
		}
		let total = 0;
		for (const m of messages) total += m.length;
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const m of messages) {
			joined.set(m, offset);
			offset += m.length;
		}
		return new Uint8Array(await subtle.digest("SHA-512", joined));
	};
	ed25519Configured = true;
}

/** Lowercase hex SHA-256 of `utf8(text)`. The digest an installer must reproduce before writing. */
export async function sha256Hex(text: string): Promise<string> {
	const subtle = subtleOrNull();
	if (!subtle) throw new Error("modkit: crypto.subtle is unavailable, cannot compute SHA-256");
	return toHex(new Uint8Array(await subtle.digest("SHA-256", utf8Bytes(text))));
}

/**
 * Is this string usable as a pinned root key? Exported so the settings tab can reject a bad paste
 * at the point of entry rather than at the point of installing a mod.
 */
export function isValidPubkeyHex(value: unknown): value is string {
	return typeof value === "string" && HEX_64.test(value.trim().toLowerCase());
}

/* ────────────────────────────────────────────────────────────────────────────
 * Verification
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Verify a signed artifact end to end. Resolves to {@link VerifyOk} only when **every** check
 * passes; there is no partial success and no "warning" tier, because the caller's only decision is
 * whether bytes reach the vault.
 *
 * This function never throws: an unexpected exception anywhere inside becomes a `malformed`
 * failure. A verifier that can throw is a verifier a caller can accidentally `catch` and continue
 * past.
 */
export async function verifyArtifact(
	artifact: SignedArtifact,
	expect: VerifyExpectations,
): Promise<VerifyResult> {
	try {
		return await verifyArtifactInner(artifact, expect);
	} catch (e) {
		return fail(
			"malformed",
			"verify.unexpected",
			"The signature check could not be completed, so nothing was installed.",
			`unexpected error during verification: ${errText(e)}`,
		);
	}
}

async function verifyArtifactInner(
	artifact: SignedArtifact,
	expect: VerifyExpectations,
): Promise<VerifyResult> {
	const now = expect.now ?? Date.now();
	const skew = expect.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

	// ── 0 · we must have a key, and a way to hash ────────────────────────────
	const root = typeof expect.rootPubkeyHex === "string" ? expect.rootPubkeyHex.trim().toLowerCase() : "";
	if (!HEX_64.test(root)) {
		return fail(
			"unpinned",
			"settings.rootPubkey",
			"No daemon public key is pinned, so this mod cannot be verified.",
			`pinned root key must be 64 hex characters; got ${root.length === 0 ? "an empty value" : `${root.length} characters`}`,
		);
	}
	if (!subtleOrNull()) {
		return fail(
			"crypto-unavailable",
			"host.cryptoSubtle",
			"This Obsidian host provides no WebCrypto, so signatures cannot be checked.",
			"globalThis.crypto.subtle is undefined",
		);
	}
	configureEd25519();

	// ── 1 · the envelope is the shape it claims to be ────────────────────────
	const envelopeProblem = checkEnvelopeShape(artifact);
	if (envelopeProblem) return envelopeProblem;
	const cert: SignedCert = artifact.cert;

	// ── 2 · the certificate is signed by the pinned root key ─────────────────
	// Verified over the base64 TEXT, before a single byte of it is decoded: nothing is parsed and
	// acted on until the signature covering it holds.
	const certSigOk = await verifySignature(cert.sig, cert.cert, root);
	if (!certSigOk.ok) {
		return fail(
			"cert-signature",
			"cert.sig",
			"This mod's certificate is not signed by the daemon key you pinned.",
			certSigOk.detail,
		);
	}

	// ── 3 · decode the certificate and check what it claims ──────────────────
	const certDecoded = decodeBase64Json(cert.cert);
	if (!certDecoded.ok) {
		return fail("malformed", "cert.cert", "This mod's certificate is unreadable.", certDecoded.detail);
	}
	const certProblem = checkCertClaims(certDecoded.value, root);
	if ("problem" in certProblem) return certProblem.problem;
	const delegation = certProblem.cert;

	// ── 4 · only now, the window ─────────────────────────────────────────────
	// Deliberately after the signature: checking it first makes a forged certificate report a date
	// problem, which sends whoever is debugging to the clock instead of to the forgery.
	const windowProblem = checkWindow(
		delegation.notBefore,
		delegation.notAfter,
		now,
		skew,
		"cert",
		"This mod's signing certificate is not valid right now.",
		"cert-window",
	);
	if (windowProblem) return windowProblem;

	// ── 5 · the payload is signed by the delegated subkey ────────────────────
	const payloadSigOk = await verifySignature(artifact.sig, artifact.payload, delegation.pubkey);
	if (!payloadSigOk.ok) {
		return fail(
			"artifact-signature",
			"artifact.sig",
			"This mod is not signed by the key its certificate delegates to.",
			payloadSigOk.detail,
		);
	}

	// ── 6 · decode the payload — authentic from here on ──────────────────────
	const payloadDecoded = decodeBase64Json(artifact.payload);
	if (!payloadDecoded.ok) {
		return fail(
			"malformed",
			"artifact.payload",
			"This mod's contents are unreadable.",
			payloadDecoded.detail,
		);
	}
	const shapeProblem = checkPayloadShape(payloadDecoded.value);
	if ("problem" in shapeProblem) return shapeProblem.problem;
	const payload = shapeProblem.payload;

	// ── 7 · protocol, on both the envelope and the payload ───────────────────
	const payloadProtocolOk = payload.protocol === MODKIT_PROTOCOL_VERSION;
	if (!payloadProtocolOk || artifact.protocol !== MODKIT_PROTOCOL_VERSION) {
		// Name the field that is actually wrong. Quoting the payload's version when the *envelope*
		// is the mismatched one produces "produced for MODKIT/1, but this modkit speaks MODKIT/1",
		// which is worse than no message at all.
		const wrong = payloadProtocolOk ? artifact.protocol : payload.protocol;
		return fail(
			"protocol-mismatch",
			payloadProtocolOk ? "artifact.protocol" : "payload.protocol",
			`This mod was produced for wire contract ${String(wrong)}, but this modkit speaks ${MODKIT_PROTOCOL_VERSION}.`,
			`envelope protocol=${String(artifact.protocol)}, payload protocol=${String(payload.protocol)}, expected ${MODKIT_PROTOCOL_VERSION}`,
		);
	}

	// ── 8 · freshness ────────────────────────────────────────────────────────
	const expiryProblem = checkWindow(
		payload.issuedAt,
		payload.expiresAt,
		now,
		skew,
		"payload",
		"This mod's signed reply is not valid right now — generate it again.",
		"expired",
	);
	if (expiryProblem) return expiryProblem;

	// ── 9 · the digest, then the binding ─────────────────────────────────────
	// The signature covers `payload.sha256`, not the bytes of `mainJs`. Hashing them and comparing
	// is what turns "these fields are signed" into "this file is signed".
	const digest = await sha256Hex(payload.mainJs);
	if (digest !== payload.sha256.toLowerCase()) {
		return fail(
			"digest-mismatch",
			"payload.sha256",
			"This mod's code does not match its signed digest, so it was not installed.",
			`signed sha256=${payload.sha256}, computed sha256=${digest} over ${payload.mainJs.length} characters of main.js`,
		);
	}

	const bindingProblem = checkBinding(payload, expect);
	if (bindingProblem) return bindingProblem;

	return { ok: true, payload, cert: delegation, kid: delegation.kid, digest };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The individual checks
 * ──────────────────────────────────────────────────────────────────────────── */

function checkEnvelopeShape(artifact: SignedArtifact): VerifyFailure | null {
	const a = artifact as unknown as Record<string, unknown> | null;
	if (typeof a !== "object" || a === null) {
		return fail("malformed", "artifact", "The daemon's reply was not a signed mod.", `envelope is ${a === null ? "null" : typeof a}`);
	}
	for (const key of ["payload", "sig"] as const) {
		if (!isNonEmptyString(a[key])) {
			return fail("malformed", `artifact.${key}`, "The daemon's reply is missing part of its signature.", `\`${key}\` is ${describe(a[key])}, expected a non-empty string`);
		}
	}
	const cert = a["cert"];
	if (typeof cert !== "object" || cert === null) {
		return fail("malformed", "artifact.cert", "The daemon's reply carries no signing certificate.", `\`cert\` is ${describe(cert)}, expected an object`);
	}
	const c = cert as Record<string, unknown>;
	for (const key of ["cert", "sig"] as const) {
		if (!isNonEmptyString(c[key])) {
			return fail("malformed", `artifact.cert.${key}`, "The daemon's reply carries an incomplete signing certificate.", `\`cert.${key}\` is ${describe(c[key])}, expected a non-empty string`);
		}
	}
	return null;
}

function checkCertClaims(
	value: unknown,
	rootPubkeyHex: string,
): { cert: DelegationCert } | { problem: VerifyFailure } {
	if (typeof value !== "object" || value === null) {
		return { problem: fail("malformed", "cert.body", "This mod's certificate is unreadable.", `certificate decoded to ${describe(value)}, expected an object`) };
	}
	const c = value as Record<string, unknown>;

	// Domain separation first. Without it, a root-signed document from some future modkit feature
	// could be replayed here as a signing delegation — the signature would be perfectly valid.
	if (c["purpose"] !== MODKIT_CERT_PURPOSE) {
		return { problem: fail("cert-untrusted", "cert.purpose", "This certificate was not issued for signing modkit mods.", `purpose is ${JSON.stringify(c["purpose"])}, expected "${MODKIT_CERT_PURPOSE}"`) };
	}
	const issuer = typeof c["issuer"] === "string" ? c["issuer"].toLowerCase() : "";
	if (issuer !== rootPubkeyHex) {
		// Reachable even though the root signature verified: a certificate can name an issuer other
		// than the key that signed it, and that mismatch means the document is not internally
		// coherent — refuse rather than reason about which of the two to believe.
		return { problem: fail("cert-untrusted", "cert.issuer", "This certificate names a different daemon key than the one you pinned.", `issuer=${issuer || "(absent)"}, pinned root=${rootPubkeyHex}`) };
	}
	const pubkey = typeof c["pubkey"] === "string" ? c["pubkey"].toLowerCase() : "";
	if (!HEX_64.test(pubkey)) {
		return { problem: fail("cert-untrusted", "cert.pubkey", "This certificate delegates to an unusable signing key.", `pubkey=${JSON.stringify(c["pubkey"])}, expected 64 hex characters`) };
	}
	const kid = c["kid"];
	if (!isNonEmptyString(kid)) {
		return { problem: fail("malformed", "cert.kid", "This certificate has no key id.", `kid is ${describe(kid)}`) };
	}
	const notBefore = c["notBefore"];
	const notAfter = c["notAfter"];
	if (!isNonEmptyString(notBefore) || !isNonEmptyString(notAfter)) {
		return { problem: fail("malformed", "cert.window", "This certificate has no validity window.", `notBefore=${describe(notBefore)}, notAfter=${describe(notAfter)}`) };
	}

	// Rebuilt field by field rather than cast: the returned certificate is the one the rest of the
	// function trusts, so it should contain exactly the values that were checked.
	return { cert: { purpose: MODKIT_CERT_PURPOSE, kid, pubkey, issuer, notBefore, notAfter } };
}

function checkPayloadShape(value: unknown): { payload: ArtifactPayload } | { problem: VerifyFailure } {
	if (typeof value !== "object" || value === null) {
		return { problem: fail("malformed", "payload.body", "This mod's contents are unreadable.", `payload decoded to ${describe(value)}, expected an object`) };
	}
	const p = value as Record<string, unknown>;
	for (const key of ["modId", "mainJs", "sha256", "request", "explanation", "issuedAt", "expiresAt"] as const) {
		if (!isNonEmptyString(p[key])) {
			return { problem: fail("malformed", `payload.${key}`, "This mod is missing information it must carry to be installable.", `\`${key}\` is ${describe(p[key])}, expected a non-empty string`) };
		}
	}
	for (const key of ["manifest", "target", "reach", "targetVersionRange", "noEffect", "generator"] as const) {
		const v = p[key];
		if (typeof v !== "object" || v === null) {
			return { problem: fail("malformed", `payload.${key}`, "This mod is missing information it must carry to be installable.", `\`${key}\` is ${describe(v)}, expected an object`) };
		}
	}
	if (p["stylesCss"] !== undefined && typeof p["stylesCss"] !== "string") {
		return { problem: fail("malformed", "payload.stylesCss", "This mod's stylesheet is not text.", `\`stylesCss\` is ${describe(p["stylesCss"])}`) };
	}
	if (p["effects"] !== undefined) {
		const effects = p["effects"];
		if (typeof effects !== "object" || effects === null || !Array.isArray((effects as Record<string, unknown>)["effects"])) {
			return { problem: fail("malformed", "payload.effects", "This mod's effects declaration is unreadable.", `\`effects\` is ${describe(effects)}, expected an object whose \`effects\` is an array`) };
		}
	}
	if (!HEX_64.test(String(p["sha256"]).toLowerCase())) {
		return { problem: fail("malformed", "payload.sha256", "This mod's signed digest is not a SHA-256.", `sha256=${JSON.stringify(p["sha256"])}, expected 64 hex characters`) };
	}
	// Everything the installer reads is checked above; the rest of the payload is the daemon's
	// contract and is cast, not re-derived. Casting after checking the fields you act on is honest;
	// casting blind is not.
	return { payload: value as ArtifactPayload };
}

/**
 * The check that makes the signature mean something.
 *
 * A valid signature over a payload for a *different* mod, or a different target, or produced under
 * a different wire contract, is a correct signature over the wrong thing. Each comparison here
 * turns one of those into a refusal.
 */
function checkBinding(payload: ArtifactPayload, expect: VerifyExpectations): VerifyFailure | null {
	// The directory modkit creates comes from the manifest id, so a payload whose signed `modId`
	// and `manifest.id` disagree is a payload that binds a *name* while installing something else.
	if (payload.manifest.id !== payload.modId) {
		return fail("binding-mismatch", "payload.manifest.id", "This mod's signed identity does not match the plugin it would install.", `signed modId=${payload.modId}, manifest.id=${String(payload.manifest.id)}`);
	}
	if (!payload.modId.startsWith(MODKIT_MOD_ID_PREFIX)) {
		// Without this, a signed artifact could install itself over any plugin id in the vault,
		// including modkit's own.
		return fail("binding-mismatch", "payload.modId", "This mod's id is not in modkit's namespace, so it was not installed.", `modId=${payload.modId}, expected a "${MODKIT_MOD_ID_PREFIX}" prefix`);
	}
	if (!isNonEmptyString(payload.manifest.version)) {
		return fail("malformed", "payload.manifest.version", "This mod's manifest has no version.", `manifest.version is ${describe(payload.manifest.version)}`);
	}
	if (expect.modId !== undefined && expect.modId !== payload.modId) {
		return fail("binding-mismatch", "payload.modId", "The daemon returned a different mod than the one requested.", `expected modId=${expect.modId}, signed modId=${payload.modId}`);
	}
	if (expect.targetKey !== undefined) {
		const signedTarget = targetKey(payload.target);
		if (signedTarget !== expect.targetKey) {
			return fail("binding-mismatch", "payload.target", "This mod patches a different plugin than the one you pointed at.", `expected target=${expect.targetKey}, signed target=${signedTarget}`);
		}
	}
	return null;
}

/**
 * Both time windows, with one implementation, because the two failures a user can act on are
 * "not yet" and "no longer" and they should read identically wherever they come from.
 */
function checkWindow(
	notBefore: string,
	notAfter: string,
	now: number,
	skewMs: number,
	scope: "cert" | "payload",
	message: string,
	outOfWindowCode: VerifyFailureCode,
): VerifyFailure | null {
	const from = Date.parse(notBefore);
	const to = Date.parse(notAfter);
	// Unparseable dates are `malformed`, not out-of-window: "expired" would be a claim about time
	// that we have no basis for making.
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return fail("malformed", `${scope}.window`, message, `unparseable timestamps: notBefore=${notBefore}, notAfter=${notAfter}`);
	}
	const nowIso = new Date(now).toISOString();
	if (now + skewMs < from) {
		return fail(outOfWindowCode, `${scope}.notBefore`, message, `not valid until ${notBefore}; now is ${nowIso} (±${skewMs}ms tolerance)`);
	}
	if (now - skewMs >= to) {
		return fail(outOfWindowCode, `${scope}.notAfter`, message, `expired at ${notAfter}; now is ${nowIso} (±${skewMs}ms tolerance)`);
	}
	return null;
}

/**
 * One Ed25519 check. `message` is a base64 string and is signed as its ASCII bytes; `sig` is
 * standard base64 of the raw 64-byte signature; `pubkeyHex` is the raw 32-byte key as hex.
 *
 * A malformed signature or key is reported as a *failed* verification rather than thrown, so a
 * corrupt field cannot become an exception that some caller treats as an error to retry past.
 */
async function verifySignature(
	sigB64: string,
	messageB64: string,
	pubkeyHex: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	let sig: Uint8Array;
	try {
		sig = base64ToBytes(sigB64);
	} catch (e) {
		return { ok: false, detail: `signature is not decodable base64 (${errText(e)})` };
	}
	if (sig.length !== 64) {
		return { ok: false, detail: `signature is ${sig.length} bytes, expected 64` };
	}
	let msg: Uint8Array;
	try {
		msg = asciiBytes(messageB64);
	} catch (e) {
		return { ok: false, detail: `signed text is not ASCII base64 (${errText(e)})` };
	}
	try {
		const ok = await ed.verifyAsync(sig, msg, pubkeyHex);
		return ok ? { ok: true } : { ok: false, detail: `Ed25519 verification failed against key ${pubkeyHex} over ${msg.length} bytes` };
	} catch (e) {
		return { ok: false, detail: `Ed25519 verification could not run: ${errText(e)}` };
	}
}

/** `typeof`, with the two distinctions `typeof` throws away. Used only in failure details. */
function describe(value: unknown): string {
	if (value === undefined) return "absent";
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return value.length === 0 ? "an empty string" : "a string";
	if (typeof value === "object") return "an object";
	return `a ${typeof value}`;
}
