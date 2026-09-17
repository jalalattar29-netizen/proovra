/**
 * Phase 1B — Mobile Capture Trust Platform contract test.
 *
 * Pins the canonical surface introduced by Phase 1B:
 *
 *   1. Shared capture-trust contracts exist + are bounded.
 *   2. Shared SDK foundation exists + is type-only.
 *   3. Prisma schema declares Device, CaptureDeviceAttestation,
 *      CaptureTrustEventRecord with the bounded fields.
 *   4. CustodyEventType enum includes `CAPTURE_TRUST_EVENT`.
 *   5. Service files exist (attestation-verifier, device-identity,
 *      signature-verifier, trust-event, provenance-projection,
 *      direct-capture-ingest).
 *   6. Capture-trust routes file exists with the bounded surface.
 *   7. Server registers captureTrustRoutes.
 *   8. The mobile app submits through the direct-capture session client.
 *
 * UC-0 (2026-09-16): the metadata-trusting attestation providers, the
 * receipt-only mobile ingest, the verify-trust projection and the citizen
 * capture service were retired; the executing proof of their replacements is
 * uc0-acquisition-capture.integration.test.ts.
 *
 * Source-contract style: parses source rather than importing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SHARED_CAPTURE_TRUST = readSource(
  "../../../packages/shared/src/capture-trust.ts",
);
const SHARED_SDK_FOUNDATION = readSource(
  "../../../packages/shared/src/capture-sdk-foundation.ts",
);
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const PRISMA_SCHEMA = readSource(
  "../../../services/api/prisma/schema.prisma",
);

const SERVICE_ATTESTATION = readSource(
  "../../../services/api/src/services/capture-trust/attestation-verifier.service.ts",
);
const SERVICE_DEVICE_IDENTITY = readSource(
  "../../../services/api/src/services/capture-trust/device-identity.service.ts",
);
const SERVICE_SIGNATURE = readSource(
  "../../../services/api/src/services/capture-trust/signature-verifier.service.ts",
);
const SERVICE_TRUST_EVENT = readSource(
  "../../../services/api/src/services/capture-trust/trust-event.service.ts",
);
const SERVICE_PROVENANCE_PROJECTION = readSource(
  "../../../services/api/src/services/capture-trust/provenance-projection.service.ts",
);
const SERVICE_DIRECT_CAPTURE = readSource(
  "../../../services/api/src/services/capture-trust/direct-capture-ingest.service.ts",
);
const SHARED_RUNTIME_CHAIN = readSource(
  "../../../packages/shared-runtime/src/capture-trust/provenance-chain.ts",
);
const SERVICE_CANONICAL_JSON = readSource(
  "../../../services/api/src/services/capture-trust/canonical-json.ts",
);

const ROUTES_CAPTURE_TRUST = readSource(
  "../../../services/api/src/routes/capture-trust.routes.ts",
);
const SERVER = readSource("../../../services/api/src/server.ts");
// Phase 12 Point 4 (Pass E) — retargeted from `apps/mobile/src/
// capture-trust.ts` (the Phase-1B scaffold) to the shipped runtime.
// The scaffold declared the contract but never implemented it:
// `prepareTrustEnvelope` threw "Phase 1B.1 wiring pending" and
// `maxProvenanceClassForMobileMode` returned a hardcoded "A". Phase 1B
// Closure landed the real implementation in `apps/mobile/src/trust/*`,
// which the capture screen imports via `runTrustCapture` — leaving the
// scaffold as a shadow declaration with zero importers. It was deleted;
// the contract is pinned on the code that actually runs.
// UC-0 — `apps/mobile/src/trust/*` was retired in turn (it shipped bytes as
// base64 JSON to a receipt-only route); the running code is now the
// direct-capture session client.
const MOBILE_DIRECT_CAPTURE = readSource("../../../apps/mobile/src/direct-capture.ts");
/** Source without comments — prose that NAMES a retired behaviour is not the behaviour. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}
const MOBILE_CAPTURE_SCREEN = readSource(
  "../../../apps/mobile/app/(stack)/capture.tsx",
);

// ===========================================================================
// 1 — Shared capture-trust contracts
// ===========================================================================

describe("Phase 1B — shared capture-trust contracts", () => {
  const REQUIRED_ENUMS = [
    "CAPTURE_PROVENANCE_CLASSES",
    "CAPTURE_MODES",
    "MAX_PROVENANCE_CLASS_BY_MODE",
    "CAPTURE_SIGNATURE_ALGORITHMS",
    "DEVICE_ATTESTATION_PROVIDERS",
    "DEVICE_ATTESTATION_VERDICTS",
    "DEVICE_ATTESTATION_FAILURE_REASONS",
    "CAPTURE_SIGNATURE_VERDICTS",
    "CAPTURE_TRUST_EVENT_CODES",
    "CAPTURE_INGEST_WARNINGS",
    "CAPTURE_INGEST_DENIAL_REASONS",
    "PROVENANCE_CHAIN_SCHEMA_VERSION",
    "PROVENANCE_LIMITATION_CODES",
    "STANDING_PROVENANCE_LIMITATIONS",
  ];

  for (const name of REQUIRED_ENUMS) {
    it(`exports ${name}`, () => {
      expect(SHARED_CAPTURE_TRUST).toMatch(
        new RegExp(`export\\s+const\\s+${name}\\b`),
      );
    });
  }

  it("provenance classes are exactly A/B/C in canonical order", () => {
    const m = SHARED_CAPTURE_TRUST.match(
      /CAPTURE_PROVENANCE_CLASSES\s*=\s*\[([^\]]+)\]/,
    );
    expect(m).toBeTruthy();
    const cls = (m![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    expect(cls).toEqual(["A", "B", "C"]);
  });

  it("attestation providers include Apple App Attest + Google Play Integrity", () => {
    expect(SHARED_CAPTURE_TRUST).toContain('"APPLE_APP_ATTEST"');
    expect(SHARED_CAPTURE_TRUST).toContain('"GOOGLE_PLAY_INTEGRITY"');
  });

  it("canonical signature schema version is v1", () => {
    expect(SHARED_CAPTURE_TRUST).toContain('"PROOVRA_CAPTURE_SIG_V1"');
  });

  it("provenance chain schema is V2 (additive), V1 still named for issued packages", () => {
    expect(SHARED_CAPTURE_TRUST).toContain('"PROOVRA_PROVENANCE_CHAIN_V2"');
    expect(SHARED_CAPTURE_TRUST).toContain('"PROOVRA_PROVENANCE_CHAIN_V1"');
  });

  it("the public Class A/B/C labels are retired", () => {
    expect(SHARED_CAPTURE_TRUST).not.toMatch(/export\s+function\s+provenanceClassLabel/);
  });

  it("shared index re-exports the trust constants + types", () => {
    expect(SHARED_INDEX).toMatch(/CAPTURE_PROVENANCE_CLASSES/);
    expect(SHARED_INDEX).toMatch(/PROVENANCE_CHAIN_SCHEMA_VERSION/);
    expect(SHARED_INDEX).toMatch(/CaptureSignaturePayload/);
    expect(SHARED_INDEX).toMatch(/ProvenanceChain/);
  });
});

// ===========================================================================
// 2 — SDK foundation
// ===========================================================================

describe("Phase 1B — SDK foundation", () => {
  it("declares Capture / Provenance / Trust abstractions", () => {
    expect(SHARED_SDK_FOUNDATION).toMatch(/interface\s+CaptureSource/);
    expect(SHARED_SDK_FOUNDATION).toMatch(/interface\s+ProvenanceSigner/);
    expect(SHARED_SDK_FOUNDATION).toMatch(/interface\s+TrustEnvelope/);
  });

  it("is type-only (no top-level executable code)", () => {
    // The SDK foundation file MUST not declare `export const` or
    // `export function` runtime helpers. Bounded contract.
    expect(SHARED_SDK_FOUNDATION).not.toMatch(/^export\s+const\s+/m);
    expect(SHARED_SDK_FOUNDATION).not.toMatch(/^export\s+function\s+/m);
  });

  it("shared index re-exports SDK foundation types", () => {
    expect(SHARED_INDEX).toMatch(/CaptureSource/);
    expect(SHARED_INDEX).toMatch(/ProvenanceSigner/);
    expect(SHARED_INDEX).toMatch(/TrustEnvelope/);
  });
});

// ===========================================================================
// 3 — Prisma schema
// ===========================================================================

describe("Phase 1B — Prisma schema", () => {
  it("declares Device model", () => {
    expect(PRISMA_SCHEMA).toMatch(/^model Device \{/m);
  });

  it("Device carries teamId + ownerUserId + bounded fields", () => {
    const block = PRISMA_SCHEMA.match(
      /^model Device \{[\s\S]*?\n\}/m,
    );
    expect(block).toBeTruthy();
    const s = block![0];
    for (const field of [
      "teamId",
      "ownerUserId",
      "label",
      "publicKeyHex",
      "publicKeyFingerprint",
      "attestationProvider",
      "revokedAtUtc",
      "revocationReason",
    ]) {
      expect(s).toContain(field);
    }
  });

  it("declares CaptureDeviceAttestation model", () => {
    expect(PRISMA_SCHEMA).toMatch(/^model CaptureDeviceAttestation \{/m);
  });

  it("CaptureDeviceAttestation enforces nonce uniqueness per device", () => {
    const block = PRISMA_SCHEMA.match(
      /^model CaptureDeviceAttestation \{[\s\S]*?\n\}/m,
    );
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/@@unique\(\[deviceId,\s*nonceHex\]\)/);
  });

  it("declares CaptureTrustEventRecord model with bounded code field", () => {
    expect(PRISMA_SCHEMA).toMatch(/^model CaptureTrustEventRecord \{/m);
    const block = PRISMA_SCHEMA.match(
      /^model CaptureTrustEventRecord \{[\s\S]*?\n\}/m,
    );
    expect(block![0]).toContain("code");
    expect(block![0]).toContain("sequence");
    expect(block![0]).toContain("eventHash");
    expect(block![0]).toContain("prevEventHash");
  });

  it("CustodyEventType enum includes CAPTURE_TRUST_EVENT", () => {
    expect(PRISMA_SCHEMA).toMatch(
      /enum CustodyEventType \{[\s\S]*?CAPTURE_TRUST_EVENT/,
    );
  });
});

// ===========================================================================
// 4 — Service files exist with bounded surfaces
// ===========================================================================

describe("Phase 1B — services", () => {
  it("attestation verifier fails closed and never reads client metadata", () => {
    expect(SERVICE_ATTESTATION).toMatch(
      /export\s+async\s+function\s+verifyDeviceAttestation/,
    );
    expect(SERVICE_ATTESTATION).toMatch(/UnverifiablePlatformProvider/);
    expect(SERVICE_ATTESTATION).toMatch(/TeeOnlyProvider/);
    expect(SERVICE_ATTESTATION).toMatch(/NoneProvider/);
    expect(SERVICE_ATTESTATION).toMatch(/CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE/);
    expect(code(SERVICE_ATTESTATION)).not.toMatch(/chainVerifiedByWorker|deviceIntegrityLabel|md\[/);
    // No provider can produce a positive verdict: the result type says so.
    expect(SERVICE_ATTESTATION).toMatch(/verdict: "FAILED" \| "UNVERIFIED";/);
  });

  it("attestation verifier honors a ±5-minute time window", () => {
    expect(SERVICE_ATTESTATION).toMatch(/FIVE_MIN_MS/);
  });

  it("attestation verifier enforces nonce replay defence per device", () => {
    expect(SERVICE_ATTESTATION).toMatch(
      /ASSERTION_REPLAYED/,
    );
  });

  it("device identity service exposes registerDevice + revokeDevice + lookups", () => {
    expect(SERVICE_DEVICE_IDENTITY).toMatch(
      /export\s+async\s+function\s+registerDevice/,
    );
    expect(SERVICE_DEVICE_IDENTITY).toMatch(
      /export\s+async\s+function\s+revokeDevice/,
    );
    expect(SERVICE_DEVICE_IDENTITY).toMatch(
      /export\s+async\s+function\s+findDeviceByPubkey/,
    );
  });

  it("device identity uniqueness gate by public key fingerprint", () => {
    expect(SERVICE_DEVICE_IDENTITY).toMatch(/DEVICE_PUBKEY_TAKEN/);
  });

  it("signature verifier supports Ed25519 + ECDSA P-256", () => {
    expect(SERVICE_SIGNATURE).toMatch(/Ed25519/);
    expect(SERVICE_SIGNATURE).toMatch(/ECDSA_P256_SHA256/);
    expect(SERVICE_SIGNATURE).toMatch(/ed25519RawPubkeyToPem/);
    expect(SERVICE_SIGNATURE).toMatch(/p256RawPubkeyToPem/);
  });

  it("canonical-JSON serialiser is re-exported from shared (single source of truth)", () => {
    // Phase 1B Closure — the API canonical-JSON file is now a thin
    // re-export of `@proovra/shared` so the bytes the mobile signer
    // signs are exactly the bytes the API verifier verifies.
    expect(SERVICE_CANONICAL_JSON).toMatch(/from\s+"@proovra\/shared"/);
    expect(SERVICE_CANONICAL_JSON).toMatch(/CanonicalJsonError/);
    expect(SERVICE_CANONICAL_JSON).toMatch(/canonicalize/);
  });

  it("trust event emitter integrates with custody-events", () => {
    expect(SERVICE_TRUST_EVENT).toMatch(/appendCustodyEvent/);
    expect(SERVICE_TRUST_EVENT).toMatch(/CAPTURE_TRUST_EVENT/);
  });

  it("trust event emitter writes capture_trust_events with sequence + hash chain", () => {
    expect(SERVICE_TRUST_EVENT).toMatch(/captureTrustEventRecord/);
    expect(SERVICE_TRUST_EVENT).toMatch(/buildTrustEventHash/);
  });

  it("the API provenance projection delegates to THE shared implementation", () => {
    expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/loadProvenanceChain/);
    for (const section of ["acquisition", "captureSession:", "derivedArtifacts", "capture:", "server:", "time:", "STANDING_PROVENANCE_LIMITATIONS"]) {
      expect(SHARED_RUNTIME_CHAIN).toContain(section);
    }
    // The mode comes from the acquisition authority only.
    expect(code(SHARED_RUNTIME_CHAIN)).not.toMatch(/uploadSource/);
    expect(SHARED_RUNTIME_CHAIN).toMatch(/projectRecordedAttestationVerdict/);
  });

  it("the direct-capture adapter orchestrates the canonical authorities", () => {
    expect(SERVICE_DIRECT_CAPTURE).toMatch(/createEvidence\(/);
    expect(SERVICE_DIRECT_CAPTURE).toMatch(/completeEvidence\(/);
    expect(SERVICE_DIRECT_CAPTURE).toMatch(/CAPTURE_SESSION_BOUND/);
    expect(SERVICE_DIRECT_CAPTURE).toMatch(/randomBytes\(32\)/);
    expect(code(SERVICE_DIRECT_CAPTURE)).not.toMatch(/putObjectBuffer|assetBase64/);
  });

  it("telemetry privacy: the capture path never logs nonces, digests, signatures or tokens", () => {
    for (const src of [SERVICE_DIRECT_CAPTURE, ROUTES_CAPTURE_TRUST, SERVICE_TRUST_EVENT]) {
      const calls = code(src).match(/\b(?:log(?:Warn|Info|Error)|console\.\w+|captureException)\([\s\S]*?\);/g) ?? [];
      for (const call of calls) {
        expect(call).not.toMatch(/nonce|sha256|digest|signature|attestationToken|assertion|payload/i);
      }
    }
    // The server stores only the nonce's hash, never the nonce.
    expect(code(SERVICE_DIRECT_CAPTURE)).toMatch(/nonceSha256:\s*sha256HexOf\(nonceHex\)/);
    // Neither the session row nor the STARTED trust event carries the nonce.
    const src = code(SERVICE_DIRECT_CAPTURE);
    const createAt = src.indexOf("db.captureSession.create(");
    const startedAt = src.indexOf('code: "CAPTURE_SESSION_STARTED"');
    expect(createAt).toBeGreaterThan(-1);
    expect(startedAt).toBeGreaterThan(createAt);
    const persisted = src.slice(createAt, src.indexOf("});", startedAt));
    expect(persisted).not.toMatch(/\bnonceHex\b(?!\))/);
  });
});

// ===========================================================================
// 5 — Routes registered
// ===========================================================================

describe("Phase 1B — routes", () => {
  it("declares capture-trust routes", () => {
    expect(ROUTES_CAPTURE_TRUST).toMatch(
      /export\s+async\s+function\s+captureTrustRoutes/,
    );
  });

  for (const route of [
    '"/v1/capture/devices"',
    '"/v1/capture/devices/:id"',
    '"/v1/capture/devices/:id/revoke"',
    '"/v1/capture/mobile/ingest"',
    '"/v1/capture/direct-sessions"',
    '"/v1/capture/direct-sessions/:id/evidence"',
    '"/v1/capture/direct-sessions/:id/parts/:partIndex/declaration"',
    '"/v1/capture/direct-sessions/:id/attestation"',
    '"/v1/capture/direct-sessions/:id/complete"',
    '"/v1/capture/sessions/:id/trust-timeline"',
    '"/v1/provenance/:evidenceId"',
  ]) {
    it(`registers route path ${route}`, () => {
      expect(ROUTES_CAPTURE_TRUST).toContain(route);
    });
  }

  it("the receipt-only mobile ingest is retired (410)", () => {
    expect(ROUTES_CAPTURE_TRUST).toMatch(/INGEST_RETIRED/);
    expect(code(ROUTES_CAPTURE_TRUST)).not.toMatch(/evidenceId:\s*""/);
    expect(code(ROUTES_CAPTURE_TRUST)).not.toMatch(/assetBase64/);
  });

  it("direct-session routes use the canonical authorization primitive", () => {
    expect(ROUTES_CAPTURE_TRUST).toMatch(/authorizeOrFail\(/);
    expect(ROUTES_CAPTURE_TRUST).toMatch(/permission: "evidence\.create"/);
    expect(ROUTES_CAPTURE_TRUST).toMatch(/antiEnumeration: true/);
  });

  it("server registers captureTrustRoutes", () => {
    expect(SERVER).toMatch(/captureTrustRoutes/);
    expect(SERVER).toMatch(/app\.register\(captureTrustRoutes\)/);
  });
});

// ===========================================================================
// 6 — Mobile scaffolding
// ===========================================================================

describe("UC-0 — mobile capture submits through the direct-capture session", () => {
  it("the client uses the session adapter and never ships bytes in JSON", () => {
    expect(MOBILE_DIRECT_CAPTURE).toMatch(/export async function openDirectCaptureSession/);
    expect(MOBILE_DIRECT_CAPTURE).toMatch(/export async function uploadDirectCaptureItem/);
    expect(MOBILE_DIRECT_CAPTURE).toMatch(/export async function completeDirectCapture/);
    expect(code(MOBILE_DIRECT_CAPTURE)).not.toMatch(/assetBase64|mobile\/ingest/);
  });

  it("the capture screen consumes the session client — not the retired trust queue", () => {
    expect(MOBILE_CAPTURE_SCREEN).toMatch(/from "\.\.\/\.\.\/src\/direct-capture"/);
    expect(MOBILE_CAPTURE_SCREEN).not.toMatch(/src\/trust"/);
    expect(MOBILE_CAPTURE_SCREEN).not.toMatch(/prepareTrustEnvelope/);
  });
});
