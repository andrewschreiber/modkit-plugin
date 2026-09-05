/**
 * The sign/verify roundtrip — the highest-risk contract in modkit.
 *
 * The daemon's `signArtifact` and the plugin's `verifyArtifact` were written independently and share
 * only a document in `@modkit/types`. If they silently drift, modkit installs an artifact into a
 * vault without ever having verified it, and nothing anywhere reports a problem. So every test here
 * runs **both real implementations**: the daemon's compiled `dist/sign.js` produces the envelope,
 * and the plugin's compiled `verify.ts` judges it. Nothing is minted by the test itself except the
 * forgeries.
 *
 * Every refusal is asserted by its **named check**, not merely by `ok === false`. A verifier that
 * fails everything for the same reason is indistinguishable from one that works, and the check slug
 * is the only thing that tells them apart.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before, describe } from "node:test";

import { isVerified, verifyArtifact, targetKey, MODKIT_CERT_PURPOSE } from "./build/plugin-api.mjs";
import {
	decodePayload,
	encodePayload,
	HOUR,
	makeDraft,
	makeKeyring,
	sign,
	T0,
	verifySignedArtifact,
} from "./helpers/daemon.mjs";

/** One keyring for the whole file: minting Ed25519 keys per test buys nothing and costs seconds. */
let fixture;
let keyring;
let rootPubkeyHex;

before(() => {
	fixture = makeKeyring();
	keyring = fixture.keyring;
	rootPubkeyHex = keyring.rootPubkeyHex;
});

after(() => {
	fixture.cleanup();
});

/** Sign the base64 payload text the way the daemon does — ASCII bytes, `null` algorithm. */
function signAscii(privateKey, ascii) {
	return crypto.sign(null, Buffer.from(ascii, "ascii"), privateKey).toString("base64");
}

/** Expectations that bind everything a real install would bind. */
function expectationsFor(artifact, overrides = {}) {
	const payload = decodePayload(artifact.payload);
	return {
		rootPubkeyHex,
		modId: payload.modId,
		targetKey: targetKey(payload.target),
		now: T0,
		clockSkewMs: 0,
		...overrides,
	};
}

/** Assert a refusal names the check we expect, and report what it actually said when it does not. */
function assertRefused(result, { code, check }) {
	assert.equal(result.ok, false, `expected a refusal, got ok=true`);
	assert.equal(result.check, check, `wrong check slug; detail was: ${result.detail}`);
	assert.equal(result.code, code, `wrong failure code; detail was: ${result.detail}`);
	assert.ok(result.message.length > 0, "a refusal must carry a message for the user");
	assert.ok(result.detail.length > 0, "a refusal must carry a detail for the log");
}

describe("sign/verify roundtrip — happy path", () => {
	test("the plugin accepts what the daemon signed, and returns the signed payload", async () => {
		const draft = makeDraft();
		const artifact = sign(keyring, draft);

		const result = await verifyArtifact(artifact, expectationsFor(artifact));

		assert.ok(isVerified(result), `verification failed: ${result.check ?? ""} ${result.detail ?? ""}`);
		assert.equal(result.payload.modId, draft.modId);
		assert.equal(result.payload.mainJs, draft.mainJs, "the bytes an installer writes must be the signed bytes");
		assert.equal(result.payload.request, draft.request, "the user's sentence travels verbatim");
		assert.equal(result.kid, keyring.kid, "the reported key id is the subkey the cert delegates to");
		assert.equal(result.cert.purpose, MODKIT_CERT_PURPOSE);
		assert.equal(result.cert.issuer, rootPubkeyHex);
		assert.equal(
			result.digest,
			crypto.createHash("sha256").update(draft.mainJs, "utf8").digest("hex"),
			"the digest is computed over main.js, not copied from the payload",
		);
	});

	test("the daemon's own verifier agrees with the plugin's", () => {
		const artifact = sign(keyring, makeDraft());
		const mirror = verifySignedArtifact(artifact, rootPubkeyHex, T0);
		assert.equal(mirror.ok, true, `the daemon's mirror rejected its own artifact: ${mirror.detail ?? ""}`);
		assert.equal(mirror.kid, keyring.kid);
	});

	test("verification with no modId/targetKey still succeeds — weaker, and legitimate", async () => {
		// A mod arriving by sync has no in-flight request to compare against. It must still verify,
		// and it must still be strictly weaker: the binding checks simply do not run.
		const artifact = sign(keyring, makeDraft());
		const result = await verifyArtifact(artifact, { rootPubkeyHex, now: T0, clockSkewMs: 0 });
		assert.ok(isVerified(result));
	});

	test("an artifact for a modkit-namespaced id with a styles.css survives the roundtrip", async () => {
		const draft = makeDraft({ stylesCss: ".modkit-quiet { opacity: 0.5 }" });
		const artifact = sign(keyring, draft);
		const result = await verifyArtifact(artifact, expectationsFor(artifact));
		assert.ok(isVerified(result));
		assert.equal(result.payload.stylesCss, draft.stylesCss);
	});
});

describe("sign/verify roundtrip — every refusal, by name", () => {
	test("flipped payload byte → artifact.sig", async () => {
		const artifact = sign(keyring, makeDraft());
		// Flip one base64 character of the signed text. The payload no longer decodes to what was
		// signed, and the signature over it must stop verifying.
		const at = Math.floor(artifact.payload.length / 2);
		const original = artifact.payload[at];
		const replacement = original === "A" ? "B" : "A";
		const tampered = { ...artifact, payload: artifact.payload.slice(0, at) + replacement + artifact.payload.slice(at + 1) };
		assert.notEqual(tampered.payload, artifact.payload, "the fixture must actually differ");

		const result = await verifyArtifact(tampered, expectationsFor(artifact));
		assertRefused(result, { code: "artifact-signature", check: "artifact.sig" });
	});

	test("tampered mainJs, re-signed with the real subkey → payload.sha256", async () => {
		// The dangerous shape: whoever tampered also holds the signing key, so the signature is
		// perfectly valid over a payload whose `sha256` no longer describes its own `mainJs`. Only
		// hashing the bytes catches this, which is why the digest is checked separately from the
		// signature.
		const artifact = sign(keyring, makeDraft());
		const payload = decodePayload(artifact.payload);
		payload.mainJs = `${payload.mainJs}\n/* smuggled */\nglobalThis.__owned = true;\n`;
		const forged = encodePayload(payload);

		const result = await verifyArtifact(
			{ ...artifact, payload: forged, sig: signAscii(keyring.signKey, forged) },
			expectationsFor(artifact),
		);
		assertRefused(result, { code: "digest-mismatch", check: "payload.sha256" });
	});

	test("wrong pinned root key → cert.sig", async () => {
		const artifact = sign(keyring, makeDraft());
		const someoneElse = crypto.createPublicKey(crypto.generateKeyPairSync("ed25519").privateKey);
		const der = someoneElse.export({ type: "spki", format: "der" });
		const otherRootHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");
		assert.notEqual(otherRootHex, rootPubkeyHex);

		const result = await verifyArtifact(artifact, expectationsFor(artifact, { rootPubkeyHex: otherRootHex }));
		assertRefused(result, { code: "cert-signature", check: "cert.sig" });
	});

	test("no pinned key at all → settings.rootPubkey", async () => {
		const artifact = sign(keyring, makeDraft());
		const result = await verifyArtifact(artifact, { rootPubkeyHex: "", now: T0 });
		assertRefused(result, { code: "unpinned", check: "settings.rootPubkey" });
	});

	test("modId mismatch → payload.modId", async () => {
		const artifact = sign(keyring, makeDraft());
		const result = await verifyArtifact(artifact, expectationsFor(artifact, { modId: "modkit-mod-something-else" }));
		assertRefused(result, { code: "binding-mismatch", check: "payload.modId" });
		assert.match(result.detail, /expected modId=modkit-mod-something-else/);
	});

	test("target mismatch → payload.target", async () => {
		// A correct signature over an artifact for a different plugin. This is the check that turns
		// "the daemon signed a mod" into "the daemon signed *this* mod".
		const artifact = sign(keyring, makeDraft());
		const result = await verifyArtifact(artifact, expectationsFor(artifact, { targetKey: "obsidian-dataview" }));
		assertRefused(result, { code: "binding-mismatch", check: "payload.target" });
		assert.match(result.detail, /signed target=obsidian-tasks-plugin/);
	});

	test("an attacker-minted cert that merely CLAIMS our issuer → cert.sig", async () => {
		// The forgery a naive verifier falls for: the certificate says `issuer: <our root>` and
		// delegates to the attacker's own subkey, and the artifact really is signed by that subkey.
		// Everything is internally consistent. The only thing wrong is that our root never signed it,
		// and that is checked before a single byte of the certificate is decoded.
		const attackerRoot = crypto.generateKeyPairSync("ed25519").privateKey;
		const attackerSub = crypto.generateKeyPairSync("ed25519").privateKey;
		const attackerSubHex = rawPubkeyHex(attackerSub);

		const cert = {
			purpose: MODKIT_CERT_PURPOSE,
			kid: "attacker00000000",
			pubkey: attackerSubHex,
			issuer: rootPubkeyHex, // the lie
			notBefore: new Date(T0 - HOUR).toISOString(),
			notAfter: new Date(T0 + HOUR).toISOString(),
		};
		const certB64 = encodePayload(cert);
		const genuine = sign(keyring, makeDraft());
		const payload = decodePayload(genuine.payload);
		payload.mainJs = "module.exports = class { onload() { /* attacker code */ } };\n";
		payload.sha256 = crypto.createHash("sha256").update(payload.mainJs, "utf8").digest("hex");
		const payloadB64 = encodePayload(payload);

		const forged = {
			protocol: genuine.protocol,
			payload: payloadB64,
			sig: signAscii(attackerSub, payloadB64),
			cert: { cert: certB64, sig: signAscii(attackerRoot, certB64) },
		};

		// The forgery really does claim our issuer — otherwise this test proves nothing.
		assert.equal(decodePayload(forged.cert.cert).issuer, rootPubkeyHex);

		const result = await verifyArtifact(forged, { rootPubkeyHex, now: T0, clockSkewMs: 0 });
		assertRefused(result, { code: "cert-signature", check: "cert.sig" });
	});

	test("a cert our root really signed, but naming a different issuer → cert.issuer", async () => {
		// The incoherent-document case, and it is reachable *after* the signature verifies: a
		// certificate can name an issuer other than the key that signed it. Refusing beats deciding
		// which of the two halves to believe.
		const rootKey = crypto.createPrivateKey(readFileSync(fixture.layout.rootKeyFile, "utf8"));
		const cert = {
			purpose: MODKIT_CERT_PURPOSE,
			kid: keyring.kid,
			pubkey: keyring.signPubkeyHex,
			issuer: "f".repeat(64),
			notBefore: new Date(T0 - HOUR).toISOString(),
			notAfter: new Date(T0 + HOUR).toISOString(),
		};
		const certB64 = encodePayload(cert);
		const genuine = sign(keyring, makeDraft());

		const result = await verifyArtifact(
			{ ...genuine, cert: { cert: certB64, sig: signAscii(rootKey, certB64) } },
			{ rootPubkeyHex, now: T0, clockSkewMs: 0 },
		);
		assertRefused(result, { code: "cert-untrusted", check: "cert.issuer" });
	});

	test("a root-signed document that is not a signing delegation → cert.purpose", async () => {
		// Domain separation. Without the `purpose` field, any future root-signed document could be
		// replayed here as a delegation and its signature would check out.
		const rootKey = crypto.createPrivateKey(readFileSync(fixture.layout.rootKeyFile, "utf8"));
		const cert = {
			purpose: "modkit-backup-manifest-v1",
			kid: keyring.kid,
			pubkey: keyring.signPubkeyHex,
			issuer: rootPubkeyHex,
			notBefore: new Date(T0 - HOUR).toISOString(),
			notAfter: new Date(T0 + HOUR).toISOString(),
		};
		const certB64 = encodePayload(cert);
		const genuine = sign(keyring, makeDraft());

		const result = await verifyArtifact(
			{ ...genuine, cert: { cert: certB64, sig: signAscii(rootKey, certB64) } },
			{ rootPubkeyHex, now: T0, clockSkewMs: 0 },
		);
		assertRefused(result, { code: "cert-untrusted", check: "cert.purpose" });
	});

	test("a stale reply being replayed → payload.notAfter", async () => {
		const artifact = sign(keyring, makeDraft(), { now: T0, artifactTtlMs: HOUR });
		const payload = decodePayload(artifact.payload);
		assert.equal(Date.parse(payload.expiresAt), T0 + HOUR, "the fixture must expire when we think it does");

		// One millisecond past the window, with no skew tolerance.
		const result = await verifyArtifact(artifact, expectationsFor(artifact, { now: T0 + HOUR + 1 }));
		assertRefused(result, { code: "expired", check: "payload.notAfter" });
	});

	test("the same stale reply is accepted while inside the clock-skew tolerance", async () => {
		// The other half of the freshness rule: two boxes with unsynchronised clocks is an ordinary
		// condition, and a verifier that calls it forgery teaches people to turn verification off.
		const artifact = sign(keyring, makeDraft(), { now: T0, artifactTtlMs: HOUR });
		const result = await verifyArtifact(
			artifact,
			expectationsFor(artifact, { now: T0 + HOUR + 1000, clockSkewMs: 60_000 }),
		);
		assert.ok(isVerified(result));
	});

	test("a payload trying to install itself as \"modkit\" → payload.modId", async () => {
		// Without the namespace check a signed artifact could overwrite any plugin in the vault,
		// modkit's own directory included — while it is running.
		const draft = makeDraft({ modId: "modkit" });
		draft.manifest = { ...draft.manifest, id: "modkit" };
		const artifact = sign(keyring, draft);

		const result = await verifyArtifact(artifact, { rootPubkeyHex, now: T0, clockSkewMs: 0 });
		assertRefused(result, { code: "binding-mismatch", check: "payload.modId" });
		assert.match(result.detail, /expected a "modkit-mod-" prefix/);
	});

	test("a payload whose manifest.id disagrees with its modId → payload.manifest.id", async () => {
		// The directory modkit creates comes from the manifest id, so this payload binds one name
		// and installs another. Re-signed, so the signature is not what refuses it.
		const artifact = sign(keyring, makeDraft());
		const payload = decodePayload(artifact.payload);
		payload.manifest = { ...payload.manifest, id: "modkit-mod-innocent" };
		const forged = encodePayload(payload);

		const result = await verifyArtifact(
			{ ...artifact, payload: forged, sig: signAscii(keyring.signKey, forged) },
			{ rootPubkeyHex, now: T0, clockSkewMs: 0 },
		);
		assertRefused(result, { code: "binding-mismatch", check: "payload.manifest.id" });
	});

	test("an envelope with no certificate → artifact.cert", async () => {
		const artifact = sign(keyring, makeDraft());
		const { cert: _dropped, ...naked } = artifact;
		const result = await verifyArtifact(naked, { rootPubkeyHex, now: T0 });
		assertRefused(result, { code: "malformed", check: "artifact.cert" });
	});

	test("verifyArtifact never throws, even on rubbish", async () => {
		// A verifier that can throw is one a caller can accidentally catch and continue past.
		for (const rubbish of [null, undefined, 42, "not an artifact", [], { payload: 1, sig: 2, cert: 3 }]) {
			const result = await verifyArtifact(rubbish, { rootPubkeyHex, now: T0 });
			assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(rubbish) ?? "undefined"}`);
			assert.ok(typeof result.check === "string" && result.check.length > 0);
		}
	});
});

describe("the daemon refuses to emit what it cannot verify", () => {
	test("signing against an expiring certificate throws rather than shipping silence", () => {
		// An artifact that outlives the cert authorising it verifies on the daemon and fails on the
		// device — the one failure shape nobody is watching for. `signArtifact` clamps, and refuses
		// outright when the clamp leaves nothing.
		const expiring = makeKeyring({ now: T0, certTtlMs: 2 * HOUR, certRenewBeforeMs: 0 });
		try {
			// Well past the certificate's own notAfter.
			assert.throws(
				() => sign(expiring.keyring, makeDraft(), { now: T0 + 3 * HOUR, artifactTtlMs: HOUR }),
				/certificate expires before this artifact/i,
			);
		} finally {
			expiring.cleanup();
		}
	});

	test("an artifact is clamped to the certificate's own expiry", () => {
		const shortLived = makeKeyring({ now: T0, certTtlMs: 30 * 60 * 1000, certRenewBeforeMs: 0 });
		try {
			const artifact = sign(shortLived.keyring, makeDraft(), { now: T0, artifactTtlMs: 24 * HOUR });
			const payload = decodePayload(artifact.payload);
			assert.equal(
				Date.parse(payload.expiresAt),
				Date.parse(shortLived.keyring.certNotAfter),
				"a 24h artifact under a 30m certificate must expire with the certificate",
			);
		} finally {
			shortLived.cleanup();
		}
	});
});

function rawPubkeyHex(privateKey) {
	const der = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
	return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}
