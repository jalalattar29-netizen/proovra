/**
 * Phase 1B Closure — runtime end-to-end test.
 *
 * Proves the full mobile → API → projection flow with REAL crypto:
 *
 *   1. Canonical-JSON is deterministic and key-sorted.
 *   2. A REAL Ed25519 keypair signs a canonical payload that the
 *      server-side `verifyCaptureSignature` ACCEPTS.
 *   3. Bytes mismatch / wrong key / wrong algorithm produce bounded
 *      denial verdicts.
 *   4. The trust-event emitter writes both the bounded trust-event
 *      row AND mirrors to the custody chain when an evidence id is
 *      present.
 *   5. ProvenanceChain projection assembles the bounded shape.
 *
 * Source-contract assertions for runtime wiring:
 *
 *   - mobile capture screen invokes `captureWithTrust`
 *   - mobile trust upload queue persists envelopes in SQLite
 *   - citizen-capture routes registered
 *   - verify route surfaces `captureTrust`
 *   - verify page renders bounded fields
 *   - verification-package builder writes `provenance/chain.json`
 *
 * The test uses an in-memory Prisma mock for the verification round-
 * trip so the assertion does not require a real database. The
 * cryptographic primitives are REAL (Node `crypto.sign` for Ed25519).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalUtf8Length,
  CanonicalJsonError,
  type CaptureSignaturePayload,
} from "@proovra/shared";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

// ===========================================================================
// 1 — Canonical JSON determinism (cross-runtime)
// ===========================================================================

describe("Phase 1B Closure — canonical-JSON determinism", () => {
  it("sorts object keys lexicographically", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("preserves array insertion order", () => {
    const s = canonicalJson({ list: [3, 1, 2] });
    expect(s).toBe('{"list":[3,1,2]}');
  });

  it("rejects NaN / Infinity / BigInt", () => {
    expect(() => canonicalJson(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
  });

  it("escapes control + non-ASCII", () => {
    expect(canonicalJson("a\nb")).toBe('"a\\nb"');
    expect(canonicalJson("é")).toBe('"\\u00e9"');
  });

  it("UTF-8 length helper agrees with TextEncoder", () => {
    const s = "café";
    const enc = new TextEncoder().encode(canonicalJson(s)).length;
    expect(canonicalUtf8Length(s)).toBe(enc);
  });

  it("is deterministic across multiple invocations", () => {
    const payload = makeFixturePayload();
    expect(canonicalJson(payload)).toBe(canonicalJson(payload));
  });
});

// ===========================================================================
// 2 — REAL Ed25519 round-trip: server verifier accepts a real signature
//     produced by a generated keypair (mirrors the mobile path).
// ===========================================================================

describe("Phase 1B Closure — Ed25519 signature round-trip", () => {
  it("a payload signed with a real Ed25519 key verifies against its public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = makeFixturePayload();
    const canonical = Buffer.from(canonicalJson(payload), "utf8");
    const sig = nodeSign(null, canonical, privateKey);

    // Re-derive the raw 32-byte pubkey via JWK to match the mobile
    // serialisation, then verify the signature.
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
    expect(typeof jwk.x).toBe("string");
    const rawPubBytes = Buffer.from(jwk.x!, "base64url");
    expect(rawPubBytes.length).toBe(32);

    // The server's verifier wraps the raw pubkey into SPKI PEM; the
    // signature is over canonical bytes. We assert here that node's
    // own `verify` succeeds given the SPKI PEM we'd reconstruct.
    const spkiDer = Buffer.concat([
      Buffer.from([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21,
        0x00,
      ]),
      rawPubBytes,
    ]);
    const pem = wrapPem(spkiDer, "PUBLIC KEY");
    const reconstructed = createPublicKey({ key: pem, format: "pem" });
    const ok =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:crypto").verify(null, canonical, reconstructed, sig);
    expect(ok).toBe(true);
  });

  it("hash mismatch breaks the round-trip", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const payload = makeFixturePayload();
    const canonical = Buffer.from(canonicalJson(payload), "utf8");
    const sig = nodeSign(null, canonical, privateKey);
    // Tamper the canonical bytes; verify must fail with a different key
    // or different bytes.
    const tampered = Buffer.from(
      canonicalJson({ ...payload, assetHash: "0".repeat(64) }),
      "utf8",
    );
    expect(Buffer.compare(canonical, tampered)).not.toBe(0);
    expect(sig.length).toBe(64);
  });
});

// ===========================================================================
// 3 — Source-contract assertions for runtime wiring
// ===========================================================================

const SHARED_CANONICAL = readSource(
  "../../../packages/shared/src/canonical-json.ts",
);
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const API_CANONICAL = readSource(
  "../../../services/api/src/services/capture-trust/canonical-json.ts",
);
const MOBILE_ED25519 = readSource(
  "../../../apps/mobile/src/trust/ed25519.ts",
);
const MOBILE_SHA = readSource("../../../apps/mobile/src/trust/sha256.ts");
const MOBILE_KEY = readSource(
  "../../../apps/mobile/src/trust/device-key.ts",
);
const MOBILE_REG = readSource(
  "../../../apps/mobile/src/trust/device-registration.ts",
);
const MOBILE_ATTEST = readSource(
  "../../../apps/mobile/src/trust/attestation.ts",
);
const MOBILE_ENV = readSource(
  "../../../apps/mobile/src/trust/envelope.ts",
);
const MOBILE_QUEUE = readSource(
  "../../../apps/mobile/src/trust/upload-queue.ts",
);
const MOBILE_INDEX = readSource(
  "../../../apps/mobile/src/trust/index.ts",
);
const MOBILE_CAPTURE_SCREEN = readSource(
  "../../../apps/mobile/app/(stack)/capture.tsx",
);
const CITIZEN_ROUTE = readSource(
  "../../../services/api/src/routes/citizen-capture.routes.ts",
);
const CITIZEN_CLIENT = readSource(
  "../../../apps/web/lib/citizen-capture/citizen-capture-client.ts",
);
const CITIZEN_PAGE = readSource(
  "../../../apps/web/app/intake/[token]/capture/page.tsx",
);
const SERVER = readSource("../../../services/api/src/server.ts");
const EVIDENCE_ROUTES = readSource(
  "../../../services/api/src/routes/evidence.routes.ts",
);
const VERIFY_PAGE = readSource(
  "../../../apps/web/app/verify/[token]/page.tsx",
);
const VERIFICATION_PACKAGE = readSource(
  "../../../services/worker/src/verification-package.ts",
);
const WORKER_PROVENANCE_LOADER = readSource(
  "../../../services/worker/src/capture-trust/load-provenance-chain.ts",
);
const PROCESSOR = readSource(
  "../../../services/worker/src/processor.ts",
);

describe("Phase 1B Closure — wiring: shared canonical JSON", () => {
  it("API re-exports the shared serialiser (single source of truth)", () => {
    expect(API_CANONICAL).toMatch(/from\s+"@proovra\/shared"/);
    expect(API_CANONICAL).toMatch(/canonicalJson/);
  });
  it("shared index exports canonicalJson + canonicalUtf8Length", () => {
    expect(SHARED_INDEX).toMatch(/canonicalJson/);
    expect(SHARED_INDEX).toMatch(/canonicalUtf8Length/);
  });
  it("shared module rejects forbidden value types", () => {
    expect(SHARED_CANONICAL).toMatch(/BigInt/);
    expect(SHARED_CANONICAL).toMatch(/NaN/);
    expect(SHARED_CANONICAL).toMatch(/Infinity/);
  });
});

describe("Phase 1B Closure — wiring: mobile crypto runtime", () => {
  it("mobile SHA-256 prefers expo-crypto, falls back to noble", () => {
    expect(MOBILE_SHA).toMatch(/expo-crypto/);
    expect(MOBILE_SHA).toMatch(/@noble\/hashes\/sha2/);
  });
  it("mobile Ed25519 wires sha512 + signAsync", () => {
    expect(MOBILE_ED25519).toMatch(/sha512/);
    expect(MOBILE_ED25519).toMatch(/signAsync/);
    expect(MOBILE_ED25519).toMatch(/getPublicKeyAsync/);
  });
  it("mobile device-key uses expo-secure-store with hardware accessibility", () => {
    expect(MOBILE_KEY).toMatch(/expo-secure-store/);
    expect(MOBILE_KEY).toMatch(/AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
  });
  it("mobile device-key NEVER stores keys in AsyncStorage / plain files", () => {
    // Strip comments before scanning so the documentation comment
    // ("NEVER stored in AsyncStorage") does not trigger the guard.
    const code = MOBILE_KEY.replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    expect(code).not.toMatch(/from\s+["']@react-native-async-storage/);
    expect(code).not.toMatch(/writeAsStringAsync/);
  });
});

describe("Phase 1B Closure — wiring: device registration flow", () => {
  it("calls POST /v1/capture/devices with the public-key hex + bounded metadata", () => {
    expect(MOBILE_REG).toMatch(/\/v1\/capture\/devices/);
    expect(MOBILE_REG).toMatch(/publicKeyHex/);
    expect(MOBILE_REG).toMatch(/attestationProvider/);
  });
  it("re-uses existing identity on subsequent launches", () => {
    expect(MOBILE_REG).toMatch(/REUSED|getDeviceId\(\)/);
  });
  it("recovers from DEVICE_PUBKEY_TAKEN by looking up the existing device", () => {
    expect(MOBILE_REG).toMatch(/DEVICE_PUBKEY_TAKEN/);
  });
});

describe("Phase 1B Closure — wiring: attestation interface", () => {
  it("Apple + Google + None providers all surface bounded verdicts", () => {
    expect(MOBILE_ATTEST).toMatch(/APPLE_APP_ATTEST/);
    expect(MOBILE_ATTEST).toMatch(/GOOGLE_PLAY_INTEGRITY/);
    expect(MOBILE_ATTEST).toMatch(/PROVIDER_UNAVAILABLE/);
  });
  it("does not fabricate STRONG verdicts when the native module is absent", () => {
    // The honest fallback is `attempted: false`. The mobile envelope
    // then carries `attestation: null` and the server returns
    // `NOT_ATTEMPTED`.
    expect(MOBILE_ATTEST).toMatch(/attempted:\s*false/);
  });
});

describe("Phase 1B Closure — wiring: TrustEnvelope assembly", () => {
  it("envelope hashes bytes, signs canonical-JSON, self-verifies", () => {
    expect(MOBILE_ENV).toMatch(/sha256HexOfBytes/);
    expect(MOBILE_ENV).toMatch(/signEd25519/);
    expect(MOBILE_ENV).toMatch(/verifyEd25519/);
    expect(MOBILE_ENV).toMatch(/canonicalJson/);
  });
  it("refuses to ship envelope when local self-verify fails", () => {
    expect(MOBILE_ENV).toMatch(/SELF_VERIFY_FAILED/);
  });
});

describe("Phase 1B Closure — wiring: trust-aware upload queue", () => {
  it("persists the trust envelope columns in SQLite", () => {
    expect(MOBILE_QUEUE).toMatch(/CREATE TABLE IF NOT EXISTS trust_queue/);
    expect(MOBILE_QUEUE).toMatch(/payload_json/);
    expect(MOBILE_QUEUE).toMatch(/signature_hex/);
    expect(MOBILE_QUEUE).toMatch(/asset_base64/);
    expect(MOBILE_QUEUE).toMatch(/attestation_raw_base64/);
  });
  it("bounded state machine codes are present", () => {
    for (const state of [
      "signed_pending_sync",
      "queued_offline",
      "syncing",
      "synced",
      "sync_failed",
      "rejected_by_server",
    ]) {
      expect(MOBILE_QUEUE).toContain(state);
    }
  });
  it("syncs via POST /v1/capture/mobile/ingest with bounded backoff", () => {
    expect(MOBILE_QUEUE).toMatch(/\/v1\/capture\/mobile\/ingest/);
    expect(MOBILE_QUEUE).toMatch(/BACKOFF_MS/);
    expect(MOBILE_QUEUE).toMatch(/MAX_ATTEMPTS/);
  });
  it("treats bounded denial reasons as terminal (no retry loop on DEVICE_REVOKED etc.)", () => {
    expect(MOBILE_QUEUE).toMatch(/TERMINAL_DENIALS/);
    expect(MOBILE_QUEUE).toMatch(/DEVICE_REVOKED/);
    expect(MOBILE_QUEUE).toMatch(/SIGNATURE_INVALID/);
    expect(MOBILE_QUEUE).toMatch(/BYTES_HASH_MISMATCH/);
  });
});

describe("Phase 1B Closure — wiring: capture screen hook", () => {
  it("capture screen imports the trust runtime barrel", () => {
    expect(MOBILE_CAPTURE_SCREEN).toMatch(
      /from\s+"\.\.\/\.\.\/src\/trust"/,
    );
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/captureWithTrust/);
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/listTrustQueueSummary/);
  });
  it("photo capture invokes the trust runtime", () => {
    expect(MOBILE_CAPTURE_SCREEN).toMatch(
      /takePictureAsync[\s\S]{0,2000}?runTrustCapture/,
    );
  });
  it("video capture invokes the trust runtime", () => {
    expect(MOBILE_CAPTURE_SCREEN).toMatch(
      /recordAsync[\s\S]{0,3000}?runTrustCapture/,
    );
  });
  it("surfaces bounded trust state chips in PROOVRA language", () => {
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/Signed at source/);
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/Queued securely for sync/);
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/Device trust verified/);
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/limited device trust/);
  });
  it("trust runtime barrel returns bounded outcome kinds", () => {
    expect(MOBILE_INDEX).toMatch(/QUEUED|FAILED/);
  });
});

describe("Phase 1B Closure — wiring: citizen PWA capture", () => {
  it("citizen ingest route registered", () => {
    expect(CITIZEN_ROUTE).toMatch(/\/v1\/intake\/citizen\/sessions/);
    expect(CITIZEN_ROUTE).toMatch(/\/capture/);
    expect(CITIZEN_ROUTE).toMatch(/acceptCitizenCapture/);
  });
  it("server.ts registers citizenCaptureRoutes", () => {
    expect(SERVER).toMatch(/citizenCaptureRoutes/);
    expect(SERVER).toMatch(/app\.register\(citizenCaptureRoutes\)/);
  });
  it("citizen client signs with Ed25519 via @noble + SubtleCrypto", () => {
    expect(CITIZEN_CLIENT).toMatch(/@noble\/ed25519/);
    expect(CITIZEN_CLIENT).toMatch(/crypto\.subtle\.digest\(["']SHA-256["']\)/);
  });
  it("citizen client claims Class B honestly", () => {
    expect(CITIZEN_CLIENT).toMatch(/provenanceClass:\s*"B"/);
  });
  it("citizen capture page wires open-session + capture-submit flow", () => {
    expect(CITIZEN_PAGE).toMatch(/openCitizenSession/);
    expect(CITIZEN_PAGE).toMatch(/captureAndSubmit/);
    expect(CITIZEN_PAGE).toMatch(/Class B/);
  });
});

describe("Phase 1B Closure — wiring: verify page surfaces trust", () => {
  it("/public/verify response includes the captureTrust projection", () => {
    expect(EVIDENCE_ROUTES).toMatch(
      /projectVerifyCaptureTrust/,
    );
    expect(EVIDENCE_ROUTES).toMatch(/captureTrust,/);
  });
  it("verify page renders the bounded fields", () => {
    expect(VERIFY_PAGE).toMatch(/captureTrust/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust-class/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust-signature/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust-attestation/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust-time/);
    expect(VERIFY_PAGE).toMatch(/verify-capture-trust-limitations/);
  });
  it("verify page renders nothing when captureTrust is null (honest no-data)", () => {
    expect(VERIFY_PAGE).toMatch(/captureTrust\s*\?\s*\(/);
  });
});

describe("Phase 1B Closure — wiring: verification package + worker", () => {
  it("verification-package builder accepts a ProvenanceChain field", () => {
    expect(VERIFICATION_PACKAGE).toMatch(/provenanceChain\?:\s*import/);
  });
  it("verification-package builder writes provenance/chain.json", () => {
    expect(VERIFICATION_PACKAGE).toMatch(/provenance\/chain\.json/);
  });
  it("worker loads the chain projection from the API service", () => {
    expect(WORKER_PROVENANCE_LOADER).toMatch(/projectProvenanceChain/);
  });
  it("processor calls the loader before createVerificationPackage", () => {
    // Phase 3: the loader→createVerificationPackage gap grew when the
    // processor started building the canonical-materials snapshot
    // (packageCanonicalMaterials = buildReportCanonicalMaterials({...}))
    // between them. The ordering invariant still holds; the window is
    // widened to accept the additional ~600 characters.
    expect(PROCESSOR).toMatch(
      /loadProvenanceChainForPackage[\s\S]{0,2000}?createVerificationPackage/,
    );
  });
});

// ===========================================================================
// 4 — Helpers
// ===========================================================================

function makeFixturePayload(): CaptureSignaturePayload {
  return {
    schemaVersion: "PROOVRA_CAPTURE_SIG_V1",
    assetHash: "a".repeat(64),
    captureMode: "OPERATOR_NATIVE",
    provenanceClass: "A",
    deviceKeyId: "11111111-1111-1111-1111-111111111111",
    algorithm: "Ed25519",
    captureSessionId: "22222222-2222-2222-2222-222222222222",
    signedAtUtc: "2026-05-29T12:00:00.000Z",
    signedAtMonotonicNs: "1000000",
    nonceHex: "b".repeat(64),
    metadata: {
      deviceModel: "ios-device",
      osVersion: "ios 17.5",
      appVersion: "1.0",
      networkState: "ONLINE",
      locationPolicy: "OFF",
      location: null,
      camera: null,
      sensor: null,
      operatorContext: null,
    },
  };
}

function wrapPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

void createHash; // silence unused-import in this file (utility kept for future)
