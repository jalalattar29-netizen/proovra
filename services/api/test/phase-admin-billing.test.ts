/**
 * Platform Control Center P1 — Billing & Revenue detail contract suite.
 *
 * Style: source-contract (matches phase-admin-security + the admin-route
 * convention). Pins the guarantees the billing aggregate MUST hold:
 *   1. requirePlatformAdmin gates the endpoint.
 *   2. Gross revenue reuses the analytics SUCCEEDED-payment sum computation.
 *   3. MRR / ARR are HONEST — subscription MRR/ARR is null (not derivable from
 *      the schema) while the derivable storage add-on MRR is a real number.
 *   4. Webhook status is real-or-"not-connected" from processingStatus rows.
 *   5. NO card tokens / Stripe secrets / customer PII beyond email.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SRC = readSource("../src/routes/admin-billing.routes.ts");

describe("Phase P1 admin-billing — requirePlatformAdmin gate + read-only", () => {
  it("imports and applies requirePlatformAdmin", () => {
    expect(SRC).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(SRC).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("exposes the billing detail endpoint", () => {
    expect(SRC).toContain('"/v1/admin/billing/detail"');
  });

  it("is READ-ONLY — declares no billing writes", () => {
    expect(SRC).not.toMatch(/prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/);
  });
});

describe("Phase P1 admin-billing — real revenue + plan counts", () => {
  it("reuses the analytics gross-revenue computation (SUCCEEDED payment sum)", () => {
    expect(SRC).toContain("prisma.payment.groupBy");
    expect(SRC).toMatch(/_sum:\s*\{\s*amountCents:\s*true\s*\}/);
    expect(SRC).toMatch(/status\s*===\s*"SUCCEEDED"/);
    expect(SRC).toMatch(/grossRevenueCents\s*\+=\s*row\._sum\.amountCents/);
  });

  it("computes plan mix + subscription status from real groupBy", () => {
    expect(SRC).toMatch(/prisma\.subscription\.groupBy/);
    expect(SRC).toMatch(/by:\s*\[\s*"plan"\s*\]/);
    expect(SRC).toMatch(/by:\s*\[\s*"status"\s*\]/);
  });
});

describe("Phase P1 admin-billing — HONEST MRR / ARR", () => {
  it("returns null subscription MRR/ARR (not derivable from schema)", () => {
    expect(SRC).toMatch(/subscriptionMrrCents:\s*number\s*\|\s*null\s*=\s*null/);
    expect(SRC).toMatch(/subscriptionArrCents:\s*number\s*\|\s*null\s*=\s*null/);
  });

  it("derives storage add-on MRR from real amountCents (MONTHLY only)", () => {
    expect(SRC).toContain("workspaceStorageAddon");
    expect(SRC).toMatch(/billingCycle\s*===\s*"MONTHLY"/);
    expect(SRC).toMatch(/storageMrrAccum\s*\+=\s*a\.amountCents/);
  });

  it("emits an honest 'not measured' note when subscription MRR is null", () => {
    expect(SRC).toMatch(/not measured/i);
  });
});

describe("Phase P1 admin-billing — webhook status real-or-not-connected", () => {
  it("reads processingStatus from both webhook tables", () => {
    expect(SRC).toContain("prisma.stripeWebhookEvent.groupBy");
    expect(SRC).toContain("prisma.paypalWebhookEvent.groupBy");
    expect(SRC).toMatch(/by:\s*\[\s*"processingStatus"\s*\]/);
  });

  it("maps zero rows to 'not-connected' and failures to 'degraded'", () => {
    expect(SRC).toContain('"not-connected"');
    expect(SRC).toContain('"degraded"');
    expect(SRC).toContain('"healthy"');
    expect(SRC).toMatch(/total\s*===\s*0.*not-connected/s);
  });
});

describe("Phase P1 admin-billing — NO secrets / tokens / PII beyond email", () => {
  it("never selects providerPaymentId / provider secrets / card tokens", () => {
    expect(SRC).not.toMatch(/providerPaymentId:\s*true/);
    expect(SRC).not.toMatch(/providerSubId:\s*true/);
    expect(SRC).not.toMatch(/token/i);
  });

  it("exposes only email as customer PII on payment rows", () => {
    expect(SRC).toContain("userEmail");
    expect(SRC).toMatch(/user:\s*\{\s*select:\s*\{\s*email:\s*true\s*\}\s*\}/);
    // No broader user PII fields pulled in.
    expect(SRC).not.toMatch(/name:\s*true/);
    expect(SRC).not.toMatch(/phone:\s*true/);
  });
});
