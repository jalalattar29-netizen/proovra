/**
 * Platform Control Center P1 — Platform Security & Incidents contract suite.
 *
 * Style: source-contract (reads the route source, asserts structural
 * contracts). This is the dominant admin-route test convention in the repo
 * (see phase-p1-identity-operations.test.ts): the live Fastify integration
 * harness is gated behind RUN_LIVE_INTEGRATION and is off by default, so the
 * enforceable, deterministic guarantees are asserted against source.
 *
 * The contracts below pin the guarantees the platform-security aggregate MUST
 * hold:
 *   1. requirePlatformAdmin gates BOTH endpoints (non-platform callers denied).
 *   2. Severity / incident counts are computed from REAL rows (groupBy /
 *      count), never fabricated constants.
 *   3. NO secrets / raw tokens / raw IP addresses / free-form metadata are
 *      selected into the payload.
 *   4. The operator-safe incident projection is reused (no raw incident leak).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SRC = readSource("../src/routes/admin-security.routes.ts");

describe("Phase P1 admin-security — requirePlatformAdmin gate", () => {
  it("imports and applies requirePlatformAdmin on every route", () => {
    expect(SRC).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    // Both GET routes must carry the preHandler gate.
    const gated = SRC.match(/preHandler:\s*requirePlatformAdmin/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes exactly the two platform aggregate endpoints", () => {
    expect(SRC).toContain('"/v1/admin/security-events"');
    expect(SRC).toContain('"/v1/admin/incidents"');
  });

  it("is READ-ONLY — declares no create/update/delete prisma writes", () => {
    expect(SRC).not.toMatch(/prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/);
  });
});

describe("Phase P1 admin-security — counts are REAL, never fabricated", () => {
  it("computes severity breakdown from a real groupBy over SecurityEvent", () => {
    expect(SRC).toContain("prisma.securityEvent.groupBy");
    expect(SRC).toMatch(/by:\s*\[\s*"severity"\s*\]/);
  });

  it("computes incident severity + status breakdown from real groupBy", () => {
    expect(SRC).toContain("prisma.operationalIncident.groupBy");
    expect(SRC).toMatch(/by:\s*\[\s*"severity"\s*\]/);
    expect(SRC).toMatch(/by:\s*\[\s*"status"\s*\]/);
  });

  it("derives unresolvedCount from OPEN + ACKNOWLEDGED real status counts", () => {
    expect(SRC).toContain("unresolvedCount");
    expect(SRC).toMatch(/OPEN.*ACKNOWLEDGED|ACKNOWLEDGED.*OPEN/s);
  });

  it("does not hard-code any severity/incident count literals into the payload", () => {
    // The reply shape must reference computed variables, not inline numbers.
    expect(SRC).toMatch(/severityBreakdown,/);
    expect(SRC).toMatch(/unresolvedCount,/);
    // No fabricated non-zero seed like `CRITICAL: 7`.
    expect(SRC).not.toMatch(/(CRITICAL|HIGH|WARNING|INFO):\s*[1-9]\d*/);
  });
});

describe("Phase P1 admin-security — NO secrets / tokens / raw IP / metadata", () => {
  it("never selects raw IP, hashed IP, user-agent, or free-form details from SecurityEvent", () => {
    expect(SRC).not.toContain("ipAddressHash");
    expect(SRC).not.toMatch(/userAgent:\s*true/);
    expect(SRC).not.toMatch(/details:\s*true/);
  });

  it("never selects raw ipAddress, metadata, or hash from AdminAuditLog", () => {
    expect(SRC).not.toMatch(/ipAddress:\s*true/);
    expect(SRC).not.toMatch(/metadata:\s*true/);
    expect(SRC).not.toMatch(/\bhash:\s*true/);
    expect(SRC).not.toMatch(/userAgent:\s*true/);
  });

  it("reuses the operator-safe projectIncident projection (no raw incident leak)", () => {
    expect(SRC).toContain("projectIncident");
    expect(SRC).toContain(
      'from "../services/observability/incident.service.js"',
    );
    // ADM-010 — still the canonical projectIncident; each row is then ENRICHED
    // with the workspace and customer it affects, because the projection omitted
    // teamId entirely and an operator looking at forty open incidents could not
    // tell whether they belonged to forty customers or to one. The enrichment
    // adds names; it removes nothing and re-derives no incident field.
    expect(SRC).toContain("projectIncident(row)");
    expect(SRC).toContain("affected");
  });
});
