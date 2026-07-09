/**
 * PROOVRA Platform Admin — Executive Dashboard contract suite.
 *
 * Style: source-contract (matches phase-admin-billing + the admin-route
 * convention). Pins the honesty guarantees the executive aggregate MUST
 * hold:
 *   1. requirePlatformAdmin gates the endpoint; non-platform callers are
 *      denied (the middleware returns 403 — the route never rolls its own).
 *   2. The route is READ-ONLY (no create/update/delete on any model).
 *   3. Gross revenue is derived from Payment (SUCCEEDED amountCents) — REAL.
 *   4. Growth rate %, MRR, ARR and renewal-risk are HONEST NULL — returned
 *      as `{ value: null, notMeasured: "<reason>" }`, never fabricated.
 *   5. Active/enterprise customers, leads, usage MoM, top-customers and
 *      at-risk are computed from real rows.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTE = readSource("../src/routes/admin-executive.routes.ts");
const SERVICE = readSource("../src/services/admin/executive.service.ts");

describe("Phase admin-executive — platform-admin gate + read-only", () => {
  it("imports and applies requirePlatformAdmin on the route", () => {
    expect(ROUTE).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"'
    );
    expect(ROUTE).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("does NOT roll its own admin / capability check (the gate is the boundary)", () => {
    // Non-platform callers are denied by the shared middleware, which
    // returns 403 — the route must not hand-roll a parallel check.
    expect(ROUTE).not.toMatch(/isPlatformAdmin/);
  });

  it("carries the TENANT_SCOPE_EXCEPTION global-admin annotation", () => {
    expect(ROUTE).toContain(
      "TENANT_SCOPE_EXCEPTION: platform_admin_global"
    );
  });

  it("exposes exactly the executive endpoint via GET", () => {
    expect(ROUTE).toContain('"/v1/admin/executive"');
    expect(ROUTE).toMatch(/app\.get\(/);
    expect(ROUTE).toMatch(/export async function adminExecutiveRoutes/);
  });

  it("is READ-ONLY — declares no writes in route or service", () => {
    const writeRe =
      /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/;
    expect(ROUTE).not.toMatch(writeRe);
    expect(SERVICE).not.toMatch(writeRe);
  });
});

describe("Phase admin-executive — REAL revenue from Payment", () => {
  it("derives gross revenue from SUCCEEDED Payment.amountCents", () => {
    expect(SERVICE).toContain("prisma.payment.aggregate");
    expect(SERVICE).toMatch(/status:\s*"SUCCEEDED"/);
    expect(SERVICE).toMatch(/_sum:\s*\{\s*amountCents:\s*true\s*\}/);
  });

  it("computes this-month vs last-month gross revenue windows", () => {
    expect(SERVICE).toMatch(/grossRevenueCentsThisMonth/);
    expect(SERVICE).toMatch(/grossRevenueCentsLastMonth/);
  });
});

describe("Phase admin-executive — REAL customer / lead / usage counts", () => {
  it("counts active organizations + active-billing teams + enterprise teams", () => {
    expect(SERVICE).toMatch(/prisma\.organization\.count/);
    expect(SERVICE).toMatch(/status:\s*"ACTIVE"/);
    expect(SERVICE).toMatch(/billingStatus:\s*"ACTIVE"/);
    expect(SERVICE).toMatch(/billingPlan:\s*"ENTERPRISE"/);
  });

  it("counts leads from DemoRequest + ContactSalesRequest by status", () => {
    expect(SERVICE).toMatch(/prisma\.demoRequest\.groupBy/);
    expect(SERVICE).toMatch(/prisma\.contactSalesRequest\.groupBy/);
  });

  it("ranks top customers by real live-evidence count per team", () => {
    expect(SERVICE).toMatch(/prisma\.evidence\.groupBy/);
    expect(SERVICE).toMatch(/by:\s*\[\s*"teamId"\s*\]/);
    expect(SERVICE).toMatch(/deletedAt:\s*null/);
  });

  it("flags at-risk customers with an auditable, labelled rule", () => {
    expect(SERVICE).toMatch(/PAST_DUE/);
    expect(SERVICE).toMatch(/outageDetectedAtUtc/);
    expect(SERVICE).toMatch(/outageClearedAtUtc:\s*null/);
    // The rule string is surfaced to the operator.
    expect(SERVICE).toMatch(/AT_RISK_RULE/);
  });
});

describe("Phase admin-executive — HONEST NULL (never fabricated)", () => {
  it("returns growth rate % as not-measured null with a reason", () => {
    expect(SERVICE).toMatch(/growthRatePct:\s*notMeasured\(/);
  });

  it("returns MRR and ARR as not-measured null with a reason", () => {
    expect(SERVICE).toMatch(/mrrCents:\s*notMeasured\(/);
    expect(SERVICE).toMatch(/arrCents:\s*notMeasured\(/);
  });

  it("returns renewal-risk $ as not-measured null with a reason", () => {
    expect(SERVICE).toMatch(/renewalRiskCents:\s*notMeasured\(/);
  });

  it("notMeasured always yields { value: null } — never a fabricated number", () => {
    expect(SERVICE).toMatch(
      /function notMeasured[\s\S]*?return\s*\{\s*value:\s*null,\s*notMeasured:\s*reason\s*\}/
    );
    // No fabricated MRR/ARR/growth numeric literal is assigned to those keys.
    expect(SERVICE).not.toMatch(/mrrCents:\s*\d/);
    expect(SERVICE).not.toMatch(/arrCents:\s*\d/);
    expect(SERVICE).not.toMatch(/growthRatePct:\s*[-\d]/);
  });
});
