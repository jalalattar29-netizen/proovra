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
 *      verify-trust-projection, citizen-capture).
 *   6. Capture-trust routes file exists with the bounded surface.
 *   7. Server registers captureTrustRoutes.
 *   8. Mobile capture-trust scaffolding declares the bounded contract.
 *
 * Source-contract style: parses source rather than importing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
const SHARED_CAPTURE_TRUST = readSource("../../../packages/shared/src/capture-trust.ts");
const SHARED_SDK_FOUNDATION = readSource("../../../packages/shared/src/capture-sdk-foundation.ts");
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const PRISMA_SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const SERVICE_ATTESTATION = readSource("../../../services/api/src/services/capture-trust/attestation-verifier.service.ts");
const SERVICE_DEVICE_IDENTITY = readSource("../../../services/api/src/services/capture-trust/device-identity.service.ts");
const SERVICE_SIGNATURE = readSource("../../../services/api/src/services/capture-trust/signature-verifier.service.ts");
const SERVICE_TRUST_EVENT = readSource("../../../services/api/src/services/capture-trust/trust-event.service.ts");
const SERVICE_PROVENANCE_PROJECTION = readSource("../../../services/api/src/services/capture-trust/provenance-projection.service.ts");
const SERVICE_VERIFY_TRUST = readSource("../../../services/api/src/services/capture-trust/verify-trust-projection.service.ts");
const SERVICE_CITIZEN = readSource("../../../services/api/src/services/capture-trust/citizen-capture.service.ts");
const SERVICE_CANONICAL_JSON = readSource("../../../services/api/src/services/capture-trust/canonical-json.ts");
const ROUTES_CAPTURE_TRUST = readSource("../../../services/api/src/routes/capture-trust.routes.ts");
const SERVER = readSource("../../../services/api/src/server.ts");
const MOBILE_CAPTURE_TRUST = readSource("../../../apps/mobile/src/capture-trust.ts");
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
            expect(SHARED_CAPTURE_TRUST).toMatch(new RegExp(`export\\s+const\\s+${name}\\b`));
        });
    }
    it("provenance classes are exactly A/B/C in canonical order", () => {
        const m = SHARED_CAPTURE_TRUST.match(/CAPTURE_PROVENANCE_CLASSES\s*=\s*\[([^\]]+)\]/);
        expect(m).toBeTruthy();
        const cls = (m[1] ?? "")
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
    it("provenance chain schema version is v1", () => {
        expect(SHARED_CAPTURE_TRUST).toContain('"PROOVRA_PROVENANCE_CHAIN_V1"');
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
        const block = PRISMA_SCHEMA.match(/^model Device \{[\s\S]*?\n\}/m);
        expect(block).toBeTruthy();
        const s = block[0];
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
        const block = PRISMA_SCHEMA.match(/^model CaptureDeviceAttestation \{[\s\S]*?\n\}/m);
        expect(block).toBeTruthy();
        expect(block[0]).toMatch(/@@unique\(\[deviceId,\s*nonceHex\]\)/);
    });
    it("declares CaptureTrustEventRecord model with bounded code field", () => {
        expect(PRISMA_SCHEMA).toMatch(/^model CaptureTrustEventRecord \{/m);
        const block = PRISMA_SCHEMA.match(/^model CaptureTrustEventRecord \{[\s\S]*?\n\}/m);
        expect(block[0]).toContain("code");
        expect(block[0]).toContain("sequence");
        expect(block[0]).toContain("eventHash");
        expect(block[0]).toContain("prevEventHash");
    });
    it("CustodyEventType enum includes CAPTURE_TRUST_EVENT", () => {
        expect(PRISMA_SCHEMA).toMatch(/enum CustodyEventType \{[\s\S]*?CAPTURE_TRUST_EVENT/);
    });
});
// ===========================================================================
// 4 — Service files exist with bounded surfaces
// ===========================================================================
describe("Phase 1B — services", () => {
    it("attestation verifier exposes verifyDeviceAttestation + bounded provider classes", () => {
        expect(SERVICE_ATTESTATION).toMatch(/export\s+async\s+function\s+verifyDeviceAttestation/);
        expect(SERVICE_ATTESTATION).toMatch(/AppleAppAttestProvider/);
        expect(SERVICE_ATTESTATION).toMatch(/GooglePlayIntegrityProvider/);
        expect(SERVICE_ATTESTATION).toMatch(/TeeOnlyProvider/);
        expect(SERVICE_ATTESTATION).toMatch(/NoneProvider/);
    });
    it("attestation verifier honors a ±5-minute time window", () => {
        expect(SERVICE_ATTESTATION).toMatch(/FIVE_MIN_MS/);
    });
    it("attestation verifier enforces nonce replay defence per device", () => {
        expect(SERVICE_ATTESTATION).toMatch(/ASSERTION_REPLAYED/);
    });
    it("device identity service exposes registerDevice + revokeDevice + lookups", () => {
        expect(SERVICE_DEVICE_IDENTITY).toMatch(/export\s+async\s+function\s+registerDevice/);
        expect(SERVICE_DEVICE_IDENTITY).toMatch(/export\s+async\s+function\s+revokeDevice/);
        expect(SERVICE_DEVICE_IDENTITY).toMatch(/export\s+async\s+function\s+findDeviceByPubkey/);
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
    it("provenance projection assembles capture + server + time + derivations", () => {
        expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/capture:/);
        expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/server:/);
        expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/time:/);
        expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/derivations/);
        expect(SERVICE_PROVENANCE_PROJECTION).toMatch(/STANDING_PROVENANCE_LIMITATIONS/);
    });
    it("verify-page trust projection NEVER returns device/session ids", () => {
        // Bounded public projection — operator-internal identifiers MUST
        // NOT appear in the public projection shape.
        const projTypeBlock = SERVICE_VERIFY_TRUST.match(/export\s+type\s+VerifyTrustProjection\s*=\s*\{[\s\S]*?\};/);
        expect(projTypeBlock).toBeTruthy();
        expect(projTypeBlock[0]).not.toMatch(/deviceId/);
        expect(projTypeBlock[0]).not.toMatch(/captureSessionId/);
    });
    it("citizen capture service clamps to provenance class B/C", () => {
        expect(SERVICE_CITIZEN).toMatch(/CITIZEN_PWA/);
        expect(SERVICE_CITIZEN).toMatch(/clampProvenanceClass/);
    });
});
// ===========================================================================
// 5 — Routes registered
// ===========================================================================
describe("Phase 1B — routes", () => {
    it("declares capture-trust routes", () => {
        expect(ROUTES_CAPTURE_TRUST).toMatch(/export\s+async\s+function\s+captureTrustRoutes/);
    });
    for (const route of [
        '"/v1/capture/devices"',
        '"/v1/capture/devices/:id"',
        '"/v1/capture/devices/:id/revoke"',
        '"/v1/capture/mobile/ingest"',
        '"/v1/capture/sessions/:id/trust-timeline"',
        '"/v1/provenance/:evidenceId"',
    ]) {
        it(`registers route path ${route}`, () => {
            expect(ROUTES_CAPTURE_TRUST).toContain(route);
        });
    }
    it("mobile ingest verifies signature + (optional) attestation", () => {
        expect(ROUTES_CAPTURE_TRUST).toMatch(/verifyCaptureSignature/);
        expect(ROUTES_CAPTURE_TRUST).toMatch(/verifyDeviceAttestation/);
    });
    it("mobile ingest demotes provenance class on weak/failed attestation", () => {
        expect(ROUTES_CAPTURE_TRUST).toMatch(/attestationVerdictKeepsClassA/);
        expect(ROUTES_CAPTURE_TRUST).toMatch(/CAPTURE_PROVENANCE_DOWNGRADED/);
    });
    it("server registers captureTrustRoutes", () => {
        expect(SERVER).toMatch(/captureTrustRoutes/);
        expect(SERVER).toMatch(/app\.register\(captureTrustRoutes\)/);
    });
});
// ===========================================================================
// 6 — Mobile scaffolding
// ===========================================================================
describe("Phase 1B — mobile capture-trust scaffolding", () => {
    it("declares the captureTrustMode + prepareTrustEnvelope bounded surface", () => {
        expect(MOBILE_CAPTURE_TRUST).toMatch(/captureTrustMode/);
        expect(MOBILE_CAPTURE_TRUST).toMatch(/prepareTrustEnvelope/);
        expect(MOBILE_CAPTURE_TRUST).toMatch(/DISABLED|ENABLED_SHADOW|ENABLED/);
    });
    it("ships the gap report inline with the scaffolding", () => {
        expect(MOBILE_CAPTURE_TRUST).toMatch(/Mobile PWA \+ Capture Audit/);
    });
});
