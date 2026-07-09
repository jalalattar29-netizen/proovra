/**
 * Platform Control Center — Feature Usage / Adoption (item H) contract suite.
 *
 * Style: source-contract (matches phase-admin-billing + phase-admin-security).
 * Pins the guarantees the adoption aggregate MUST hold:
 *   1. requirePlatformAdmin gates the endpoint (non-platform is denied by it).
 *   2. The endpoint is READ-ONLY — no writes.
 *   3. There is NO fabricated composite "adoption score".
 *   4. Adoption is derived from REAL backing tables.
 *   5. Capabilities without a backing model render null / not-measured.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE = readSource("../src/routes/admin-adoption.routes.ts");
const SERVICE = readSource("../src/services/admin/adoption.service.ts");

describe("Phase H admin-adoption — requirePlatformAdmin gate + read-only", () => {
  it("imports and applies requirePlatformAdmin (platform-admin gate)", () => {
    expect(ROUTE).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("exposes the adoption endpoint via the named plugin export", () => {
    expect(ROUTE).toContain('"/v1/admin/adoption"');
    expect(ROUTE).toMatch(/export\s+async\s+function\s+adminAdoptionRoutes/);
  });

  it("carries the platform_admin_global tenant-scope exception comment", () => {
    expect(ROUTE).toContain(
      "TENANT_SCOPE_EXCEPTION: platform_admin_global",
    );
  });

  it("is READ-ONLY — neither route nor service declares any write", () => {
    for (const src of [ROUTE, SERVICE]) {
      expect(src).not.toMatch(
        /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/,
      );
    }
  });
});

describe("Phase H admin-adoption — NO fabricated adoption score", () => {
  it("never emits a composite adoption-score literal", () => {
    for (const src of [ROUTE, SERVICE]) {
      expect(src).not.toMatch(/adoptionScore/i);
      expect(src).not.toMatch(/compositeScore\s*[:=]\s*\d/);
    }
  });

  it("explicitly declares hasCompositeScore = false", () => {
    expect(SERVICE).toMatch(/hasCompositeScore:\s*false/);
  });
});

describe("Phase H admin-adoption — derived from REAL backing tables", () => {
  it("derives identity capabilities from real active-status rows", () => {
    expect(SERVICE).toContain("prisma.ssoConnection");
    expect(SERVICE).toContain("prisma.scimProvisioningToken");
    expect(SERVICE).toContain("prisma.organizationDomain");
    expect(SERVICE).toMatch(/verifiedAt:\s*\{\s*not:\s*null\s*\}/);
    expect(SERVICE).toMatch(/status:\s*"ACTIVE"/);
  });

  it("derives MFA policy from the real OrganizationSecurityPolicy column", () => {
    expect(SERVICE).toMatch(/prisma\.organizationSecurityPolicy\.count/);
    expect(SERVICE).toMatch(/mfaPolicyLevel:\s*\{\s*not:\s*"OFF"\s*\}/);
  });

  it("derives evidence/case/report/package capabilities from real tables", () => {
    expect(SERVICE).toContain("prisma.evidence.aggregate");
    expect(SERVICE).toContain("prisma.case.aggregate");
    expect(SERVICE).toContain("prisma.report.aggregate");
    expect(SERVICE).toContain("prisma.verificationPackage.aggregate");
    expect(SERVICE).toContain("prisma.evidenceLegalHold.aggregate");
    expect(SERVICE).toContain("prisma.evidenceRetentionPolicy.aggregate");
    expect(SERVICE).toContain("prisma.externalReviewerRoleAssignment.aggregate");
    expect(SERVICE).toContain("prisma.apiCredential");
    expect(SERVICE).toContain("prisma.providerUsageEvent.aggregate");
    expect(SERVICE).toContain("prisma.evidenceReviewWorkflow.aggregate");
  });
});

describe("Phase H admin-adoption — honest nulls for absent backing model", () => {
  it("marks redaction + search as not-measured with a null reason path", () => {
    // Both capabilities without a clear backing model go through notMeasured,
    // which forces every metric to null and populates `reason`.
    expect(SERVICE).toMatch(/key:\s*"redaction"/);
    expect(SERVICE).toMatch(/key:\s*"search"/);
    expect(SERVICE).toMatch(/notMeasured\(/);
  });

  it("notMeasured() returns null usage/first/last and measured=false", () => {
    // Pin the honest shape of the helper: every metric null, measured false.
    expect(SERVICE).toMatch(/function\s+notMeasured/);
    expect(SERVICE).toMatch(/usageCount:\s*null/);
    expect(SERVICE).toMatch(/firstUsedAt:\s*null/);
    expect(SERVICE).toMatch(/lastUsedAt:\s*null/);
    expect(SERVICE).toMatch(/measured:\s*false/);
  });

  it("used/neverUsed are derived honestly from a real usageCount", () => {
    expect(SERVICE).toMatch(/used:\s*input\.usageCount\s*>\s*0/);
    expect(SERVICE).toMatch(/neverUsed:\s*input\.usageCount\s*===\s*0/);
  });
});
