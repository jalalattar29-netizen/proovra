/**
 * PROOVRA Platform Admin (items J + K) — Global Timeline + Alerts Center
 * contract suite.
 *
 * Style: source-contract (reads the route/service source, asserts structural
 * contracts). This mirrors the dominant admin-route test convention in the
 * repo (see phase-admin-security.test.ts): the live Fastify integration
 * harness is gated behind RUN_LIVE_INTEGRATION and off by default, so the
 * enforceable, deterministic guarantees are asserted against source.
 *
 * Contracts pinned here:
 *   1. requirePlatformAdmin gates BOTH endpoints (non-platform callers denied).
 *   2. Both endpoints are READ-ONLY (no prisma writes).
 *   3. The PLATFORM timeline EXCLUDES evidence custody events (never reads
 *      Evidence / custody chains).
 *   4. The alerts list is honest — an empty list is a valid, real result;
 *      counts are computed from REAL rows, never fabricated.
 *   5. NO secrets / raw or hashed IP / tokens / free-form metadata are
 *      selected into either payload.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const TIMELINE_ROUTE = readSource("../src/routes/admin-timeline.routes.ts");
const TIMELINE_SVC = readSource("../src/services/admin/timeline.service.ts");
const ALERTS_ROUTE = readSource("../src/routes/admin-alerts.routes.ts");
const ALERTS_SVC = readSource("../src/services/admin/alerts.service.ts");

// -----------------------------------------------------------------------------
// Platform-admin gate — both endpoints
// -----------------------------------------------------------------------------

describe("admin timeline + alerts — requirePlatformAdmin gate", () => {
  it("timeline route imports and applies requirePlatformAdmin", () => {
    expect(TIMELINE_ROUTE).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(TIMELINE_ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("alerts route imports and applies requirePlatformAdmin", () => {
    expect(ALERTS_ROUTE).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(ALERTS_ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("each route exposes exactly its one platform endpoint", () => {
    expect(TIMELINE_ROUTE).toContain('"/v1/admin/timeline"');
    expect(ALERTS_ROUTE).toContain('"/v1/admin/alerts"');
  });

  it("carries the TENANT_SCOPE_EXCEPTION: platform_admin_global marker", () => {
    expect(TIMELINE_ROUTE).toContain("TENANT_SCOPE_EXCEPTION: platform_admin_global");
    expect(ALERTS_ROUTE).toContain("TENANT_SCOPE_EXCEPTION: platform_admin_global");
  });

  it("exports the required async route factories", () => {
    expect(TIMELINE_ROUTE).toMatch(
      /export async function adminTimelineRoutes\s*\(/,
    );
    expect(ALERTS_ROUTE).toMatch(/export async function adminAlertsRoutes\s*\(/);
  });
});

// -----------------------------------------------------------------------------
// Read-only
// -----------------------------------------------------------------------------

describe("admin timeline + alerts — READ-ONLY", () => {
  it("timeline route + service declare no create/update/delete prisma writes", () => {
    for (const src of [TIMELINE_ROUTE, TIMELINE_SVC]) {
      expect(src).not.toMatch(
        /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/,
      );
    }
  });

  it("alerts route + service declare no create/update/delete prisma writes", () => {
    for (const src of [ALERTS_ROUTE, ALERTS_SVC]) {
      expect(src).not.toMatch(
        /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Timeline EXCLUDES evidence custody events
// -----------------------------------------------------------------------------

describe("timeline — PLATFORM feed, NOT evidence custody", () => {
  it("never reads Evidence / custody / verification chains", () => {
    // The service must not touch any evidence-custody model.
    expect(TIMELINE_SVC).not.toMatch(/prisma\.evidence\b/i);
    expect(TIMELINE_SVC).not.toMatch(/prisma\.custody/i);
    expect(TIMELINE_SVC).not.toMatch(/prisma\.\w*custodyEvent/i);
    expect(TIMELINE_SVC).not.toMatch(/prisma\.verificationChain/i);
  });

  it("only reads the five sanctioned platform-operational sources", () => {
    expect(TIMELINE_SVC).toContain("prisma.adminAuditLog.findMany");
    expect(TIMELINE_SVC).toContain("prisma.organizationAuditEvent.findMany");
    expect(TIMELINE_SVC).toContain("prisma.securityEvent.findMany");
    expect(TIMELINE_SVC).toContain("prisma.operationalIncident.findMany");
    expect(TIMELINE_SVC).toContain("prisma.analyticsEvent.findMany");
  });

  it("restricts analytics to a bounded billing/team allow-list", () => {
    expect(TIMELINE_SVC).toContain("TIMELINE_ANALYTICS_EVENT_TYPES");
    expect(TIMELINE_SVC).toContain("billing_payment_failed");
    expect(TIMELINE_SVC).toContain("team_plan_activated");
    // The analytics query must be scoped by the allow-list, not an open scan.
    expect(TIMELINE_SVC).toMatch(/eventType:\s*\{\s*in:/);
  });

  it("supports source / severity / organizationId filters", () => {
    expect(TIMELINE_SVC).toMatch(/source\b/);
    expect(TIMELINE_SVC).toMatch(/severity\b/);
    expect(TIMELINE_SVC).toMatch(/organizationId\b/);
  });
});

// -----------------------------------------------------------------------------
// Alerts honesty
// -----------------------------------------------------------------------------

describe("alerts — honest, read-only, real counts", () => {
  it("declares itself a read-only snapshot (no ack/resolve workflow)", () => {
    expect(ALERTS_SVC).toMatch(/readOnly:\s*true/);
  });

  it("returns an empty list honestly when there are no signals", () => {
    // The list is built by pushing onto an array that starts empty; there is
    // no fabricated seed alert.
    expect(ALERTS_SVC).toMatch(/const alerts:\s*PlatformAlert\[\]\s*=\s*\[\]/);
    expect(ALERTS_SVC).not.toMatch(
      /alerts\.push\(\s*\{\s*[^}]*title:\s*"(Example|Sample|Demo|Placeholder)/,
    );
  });

  it("computes severity counts from the REAL alert rows", () => {
    // counts are accumulated from the built list, not hard-coded. The counts
    // object is seeded to all-zero, then incremented per real alert.
    expect(ALERTS_SVC).toMatch(/counts\[a\.severity\]\s*\+=\s*1/);
    expect(ALERTS_SVC).toMatch(
      /counts:\s*Record<AlertSeverity,\s*number>\s*=\s*\{\s*critical:\s*0,\s*high:\s*0,\s*medium:\s*0,\s*low:\s*0,?\s*\}/,
    );
    // The returned `total` must be the real list length, never a literal.
    expect(ALERTS_SVC).toMatch(/total:\s*alerts\.length/);
  });

  it("derives alerts from the sanctioned live signals", () => {
    expect(ALERTS_SVC).toContain('status: "OPEN"');
    expect(ALERTS_SVC).toMatch(/severity:\s*\{\s*in:\s*\["HIGH",\s*"CRITICAL"\]/);
    expect(ALERTS_SVC).toContain("getQueueInventory");
    expect(ALERTS_SVC).toContain("getWorkerHealth");
    expect(ALERTS_SVC).toContain("buildEvidenceHealthSnapshot");
    expect(ALERTS_SVC).toContain('status: "FAILED"');
    expect(ALERTS_SVC).toContain("outageDetectedAtUtc");
  });
});

// -----------------------------------------------------------------------------
// No secrets / raw IP / tokens / metadata
// -----------------------------------------------------------------------------

describe("timeline + alerts — NO secrets / raw IP / tokens / metadata", () => {
  it("timeline never selects raw/hashed IP, user-agent, or free-form detail", () => {
    // Assert on actual Prisma `select` leakage — `field: true` — not on the
    // prose comments that document what is deliberately NOT selected.
    expect(TIMELINE_SVC).not.toMatch(/ipAddress:\s*true/);
    expect(TIMELINE_SVC).not.toMatch(/ipAddressHash:\s*true/);
    expect(TIMELINE_SVC).not.toMatch(/userAgent:\s*true/);
    expect(TIMELINE_SVC).not.toMatch(/\bmetadata:\s*true/);
    expect(TIMELINE_SVC).not.toMatch(/details:\s*true/);
    expect(TIMELINE_SVC).not.toMatch(/\bhash:\s*true/);
  });

  it("alerts never selects raw/hashed IP, secrets, or provider payment ids", () => {
    expect(ALERTS_SVC).not.toMatch(/ipAddress:\s*true/);
    expect(ALERTS_SVC).not.toMatch(/ipAddressHash/);
    expect(ALERTS_SVC).not.toMatch(/clientSecret/);
    expect(ALERTS_SVC).not.toMatch(/samlCertificate/);
    expect(ALERTS_SVC).not.toMatch(/providerPaymentId/);
  });
});
