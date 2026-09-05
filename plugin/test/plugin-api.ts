/**
 * The single entry point the tests import, bundled once by `build-tests.mjs`.
 *
 * One bundle rather than one per module, deliberately: `ModInstaller`, `ModStore` and `Host`
 * collaborate, and bundling them separately would give each bundle its own private copy of the
 * others — two `ModStore` classes, two module-level caches, and assertions that quietly stop
 * meaning what they say. This file is not shipped and is not part of the plugin's `tsc` project
 * (`plugin/tsconfig.json` includes only `src`); it exists so the tests exercise the same source the
 * plugin does, compiled the same way.
 */

export {
	configureEd25519,
	isValidPubkeyHex,
	isVerified,
	sha256Hex as verifySha256Hex,
	verifyArtifact,
} from "../src/daemon/verify";
export type { VerifyExpectations, VerifyFailure, VerifyOk, VerifyResult } from "../src/daemon/verify";

export { ModInstaller, sha256Hex as installerSha256Hex } from "../src/install/installer";
export type { InstallableMod, InstallResult, ModRecordSeed } from "../src/install/installer";

export { makeHealth, ModStore } from "../src/install/modstore";

export { Host, probeHost } from "../src/host/host";

export {
	applyPairing,
	clampTimeout,
	DEFAULT_DAEMON_BASE_URL,
	DEFAULT_SETTINGS,
	isSeedableBaseUrl,
	isValidPubkey,
	normalizeBaseUrl,
	normalizePubkey,
	normalizeSettings,
	parseData,
	parseSidecar,
	settingsBlockers,
	SettingsStore,
	SIDECAR_VERSION,
	TOKEN_FILE_NAME,
} from "../src/settings/settings";
export type { PairingApplication, PairingRecord, PairingStatus, SidecarProblem, SidecarRead } from "../src/settings/settings";

export { targetKey, MODKIT_MOD_ID_PREFIX, MODKIT_PROTOCOL_VERSION, MODKIT_CERT_PURPOSE } from "@modkit/types";
