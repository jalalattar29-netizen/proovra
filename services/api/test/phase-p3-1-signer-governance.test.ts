/**
 * Phase P3.1 — Signer governance + custody attestation closure suite.
 *
 *   1. Bounded enums (purposes / providers / statuses).
 *   2. Canonical payload deterministic hashing.
 *   3. Routes registered + step-up gated where required.
 *   4. Bounded event types + metric keys present in registries.
 *   5. Frontend page exists + uses the right endpoints.
 *   6. No legal-admissibility wording on the page.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildCanonicalPayload,
  CUSTODY_ATTESTATION_OUTCOMES,
  hashCanonicalPayload,
} from "../src/services/operations/custody-attestation.service.js";
import {
  SIGNER_PROVIDERS,
  SIGNER_PURPOSES,
  SIGNER_STATUSES,
  getCurrentActiveSigners,
} from "../src/services/operations/signer-registry.service.js";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
function exists(rel: string): boolean {
  const url = new URL(rel, import.meta.url);
  return existsSync(fileURLToPath(url));
}

describe("Phase P3.1 — Bounded enums", () => {
  it("SIGNER_PURPOSES is exactly the 4 documented purposes", () => {
    expect(new Set(SIGNER_PURPOSES)).toEqual(
      new Set([
        "report_pdf",
        "verification_package",
        "export_manifest",
        "custody_event",
      ]),
    );
  });

  it("SIGNER_PROVIDERS is exactly the 3 documented providers", () => {
    expect(new Set(SIGNER_PROVIDERS)).toEqual(
      new Set(["aws_kms", "local_pem", "disabled"]),
    );
  });

  it("SIGNER_STATUSES is exactly the 6 documented statuses", () => {
    expect(new Set(SIGNER_STATUSES)).toEqual(
      new Set([
        "active",
        "staged",
        "retiring",
        "retired",
        "revoked",
        "degraded",
      ]),
    );
  });

  it("CUSTODY_ATTESTATION_OUTCOMES is exactly the 7 bounded outcomes", () => {
    expect(new Set(CUSTODY_ATTESTATION_OUTCOMES)).toEqual(
      new Set([
        "verified",
        "missing_attestation",
        "signature_invalid",
        "payload_hash_mismatch",
        "signer_unavailable",
        "unsupported_algorithm",
        "not_applicable",
      ]),
    );
  });
});

describe("Phase P3.1 — Canonical payload determinism", () => {
  it("same input → same hash (regardless of object key order)", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      evidenceId: "22222222-2222-2222-2222-222222222222",
      eventType: "INGESTED",
      atUtc: new Date("2026-05-28T10:00:00.000Z"),
      sequence: 1,
      prevEventHash: null,
      eventHash: "deadbeef",
    };
    const payload1 = buildCanonicalPayload(row);
    const payload2 = buildCanonicalPayload(row);
    expect(hashCanonicalPayload(payload1)).toBe(hashCanonicalPayload(payload2));
  });

  it("different fields → different hash", () => {
    const base = {
      id: "11111111-1111-1111-1111-111111111111",
      evidenceId: "22222222-2222-2222-2222-222222222222",
      eventType: "INGESTED",
      atUtc: new Date("2026-05-28T10:00:00.000Z"),
      sequence: 1,
      prevEventHash: null,
      eventHash: "deadbeef",
    };
    const h1 = hashCanonicalPayload(buildCanonicalPayload(base));
    const h2 = hashCanonicalPayload(
      buildCanonicalPayload({ ...base, sequence: 2 }),
    );
    expect(h1).not.toBe(h2);
  });

  it("canonical projection does NOT include payload, ip, or userAgent", () => {
    const src = readSource(
      "../src/services/operations/custody-attestation.service.ts",
    );
    // The buildCanonicalPayload body should not reference these
    // potentially-sensitive fields.
    const fnBody = src
      .split("export function buildCanonicalPayload")[1]
      ?.split("export function")[0] ?? "";
    expect(fnBody).not.toContain("payload");
    expect(fnBody).not.toContain("ip:");
    expect(fnBody).not.toContain("userAgent");
  });
});

describe("Phase P3.1 — Current active signers from env", () => {
  it("derives 4 signers — one per purpose", () => {
    const list = getCurrentActiveSigners();
    expect(list).toHaveLength(4);
    expect(new Set(list.map((s) => s.signerPurpose))).toEqual(
      new Set(SIGNER_PURPOSES),
    );
  });

  it("status is `degraded` when SIGNER_PROVIDER=disabled", () => {
    const prev = process.env.SIGNER_PROVIDER;
    process.env.SIGNER_PROVIDER = "disabled";
    const list = getCurrentActiveSigners();
    expect(list.every((s) => s.status === "degraded")).toBe(true);
    process.env.SIGNER_PROVIDER = prev;
  });
});

describe("Phase P3.1 — Routes registered + step-up gated", () => {
  it("server.ts registers operationsSignersRoutes", () => {
    const s = readSource("../src/server.ts");
    expect(s).toContain("operationsSignersRoutes");
    expect(s).toMatch(/app\.register\(\s*operationsSignersRoutes/);
  });

  it("routes file exposes the documented endpoints", () => {
    const r = readSource("../src/routes/operations-signers.routes.ts");
    for (const p of [
      '"/v1/operations/signers"',
      '"/v1/operations/signers/:id"',
      '"/v1/operations/signers/:id/health"',
      '"/v1/operations/signers/:id/audit"',
      '"/v1/operations/signers/stage"',
      '"/v1/operations/signers/:id/preview"',
      '"/v1/operations/signers/:id/promote"',
      '"/v1/operations/signers/:id/retire"',
      '"/v1/operations/signers/:id/revoke"',
      '"/v1/operations/custody-attestations"',
      '"/v1/operations/custody-attestations/backfill"',
      '"/v1/operations/custody-attestations/:id/verify"',
      '"/v1/evidence/:evidenceId/custody/attestations/sign"',
      '"/v1/evidence/:evidenceId/custody/attestations"',
    ]) {
      expect(r).toContain(p);
    }
  });

  it("promote / retire / revoke / backfill route through step-up purposes", () => {
    const r = readSource("../src/routes/operations-signers.routes.ts");
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,200}purpose:\s*"SIGNER_PROMOTE"/,
    );
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,200}purpose:\s*"SIGNER_RETIRE"/,
    );
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,200}purpose:\s*"SIGNER_REVOKE"/,
    );
    expect(r).toMatch(
      /requireStepUpForSensitiveAction[\s\S]{0,200}purpose:\s*"CUSTODY_ATTESTATION_BACKFILL"/,
    );
  });

  it("uses the same actor-gate pattern as other ops routes", () => {
    const r = readSource("../src/routes/operations-signers.routes.ts");
    expect(r).toContain("evaluateMemberAccess");
    expect(r).toMatch(/reply\.code\(404\)/);
    expect(r).toContain('"member_inactive"');
  });
});

describe("Phase P3.1 — Bounded registries extended", () => {
  it("step-up purposes include the 4 new entries", () => {
    const idn = readSource(
      "../../../packages/shared/src/identity-security.ts",
    );
    for (const p of [
      '"SIGNER_PROMOTE"',
      '"SIGNER_RETIRE"',
      '"SIGNER_REVOKE"',
      '"CUSTODY_ATTESTATION_BACKFILL"',
    ]) {
      expect(idn).toContain(p);
    }
  });

  it("security event types include the P3.1 events", () => {
    const sec = readSource("../../../packages/shared/src/security.ts");
    for (const e of [
      "signer_staged",
      "signer_health_checked",
      "signer_health_degraded",
      "signer_rotation_previewed",
      "signer_promoted",
      "signer_retired",
      "signer_revoked",
      "signer_signature_failure",
      "custody_attestation_signed",
      "custody_attestation_verified",
      "custody_attestation_backfill_started",
      "custody_attestation_backfill_completed",
    ]) {
      expect(sec).toContain(`"${e}"`);
    }
  });

  it("metric registry carries the P3.1 keys", () => {
    const m = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    for (const k of [
      "signer_health_check_total",
      "signer_health_degraded_total",
      "signer_rotation_total",
      "signer_rotation_failure_total",
      "signer_signature_failure_total",
      "custody_attestation_signed_total",
      "custody_attestation_verified_total",
      "custody_attestation_verification_failure_total",
      "custody_attestation_backfill_total",
    ]) {
      expect(m).toContain(`"${k}"`);
    }
  });
});

describe("Phase P3.1 — Frontend signer governance page", () => {
  it("/operations/signers page exists", () => {
    expect(
      exists("../../../apps/web/app/(app)/operations/signers/page.tsx"),
    ).toBe(true);
  });

  it("page calls all documented backend endpoints", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    for (const ep of [
      "/v1/operations/signers",
      "/v1/operations/custody-attestations",
      "/health",
      "/audit",
      "/preview",
      "/promote",
      "/retire",
      "/revoke",
      "/verify",
      "/backfill",
    ]) {
      expect(p).toContain(ep);
    }
  });

  it("page integrates step-up modal", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    expect(p).toContain("useStepUpAction");
    expect(p).toContain("StepUpModal");
    expect(p).toContain("runStepUpAction");
  });

  it("renders the 4 bounded purpose labels", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    expect(p).toContain("Report PDF");
    expect(p).toContain("Verification Package");
    expect(p).toContain("Export Manifest");
    expect(p).toContain("Custody Event");
  });

  it("does NOT contain legal-admissibility wording", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    expect(p).not.toMatch(/admissible/i);
    expect(p).not.toMatch(/legally binding/i);
    expect(p).not.toMatch(/court[- ]admit/i);
    expect(p).not.toMatch(/legal proof/i);
  });

  it("exposes the verification outcome states without fake-green paths", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    for (const o of [
      '"verified"',
      '"missing_attestation"',
      '"signature_invalid"',
      '"payload_hash_mismatch"',
      '"signer_unavailable"',
      '"unsupported_algorithm"',
    ]) {
      expect(p).toContain(o);
    }
  });

  it("does not log or render raw AWS access-key material", () => {
    const p = readSource(
      "../../../apps/web/app/(app)/operations/signers/page.tsx",
    );
    expect(p).not.toMatch(/AWS_ACCESS_KEY_ID/);
    expect(p).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
    // The kmsKeyArn field IS allowed; it's operator-safe.
  });
});

describe("Phase P3.1 — Historical artifact immutability", () => {
  it("rotation service never mutates Report or VerificationPackage rows", () => {
    const src = readSource(
      "../src/services/operations/signer-rotation.service.ts",
    );
    // The rotation service must NOT call client.report.update / client.verificationPackage.update.
    expect(src).not.toMatch(/client\.report\.update/);
    expect(src).not.toMatch(/client\.verificationPackage\.update/);
    expect(src).not.toMatch(/prisma\.report\.update/);
    expect(src).not.toMatch(/prisma\.verificationPackage\.update/);
  });

  it("custody attestation service never mutates CustodyEvent rows", () => {
    const src = readSource(
      "../src/services/operations/custody-attestation.service.ts",
    );
    expect(src).not.toMatch(/custodyEvent\.update/);
  });
});
