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

const ROUTE_SRC = readSource("../src/routes/admin-billing.routes.ts");
/**
 * ADM-030 (2026-08-27) — the billing AGGREGATE moved out of the route.
 *
 * The route is now a validator and a projection boundary; every query lives in
 * services/admin/billing.service.ts. These contracts follow the LOGIC rather
 * than the path, because asserting them against the route alone would pass
 * vacuously the moment anything moved.
 */
const SERVICE_SRC = readSource("../src/services/admin/billing.service.ts");
const SRC = [ROUTE_SRC, SERVICE_SRC].join(String.fromCharCode(10));

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
    expect(SRC).toContain("client.payment.groupBy");
    expect(SRC).toMatch(/_sum:\s*\{\s*amountCents:\s*true\s*\}/);
    expect(SRC).toMatch(/status\s*===\s*"SUCCEEDED"/);
    // ADM-012 — revenue accumulates PER CURRENCY. A single `+=` across every
    // currency group produces a number that is not money in any of them, and
    // the tile then labelled the result EUR.
    expect(SRC).toContain("bucket.succeededCents += row._sum.amountCents ?? 0");
    expect(SRC).toContain("revenueByCurrency");
  });

  it("computes plan mix + subscription status from real groupBy", () => {
    expect(SRC).toMatch(/client\.subscription\.groupBy/);
    // ADM-006 — the bare groupBy(plan) is gone: it counted CANCELED
    // subscriptions under a live plan name. Status is the dimension now, and
    // pending cancellation gets its own bucket (ADM-016).
    expect(SRC).toContain("pendingCancellation");
    expect(SRC).toMatch(/by:\s*\[\s*"status"\s*\]/);
  });
});

describe("Phase P1 admin-billing — HONEST MRR / ARR", () => {
  it("returns null subscription MRR/ARR (not derivable from schema)", () => {
    // ADM-024 — MRR/ARR are now the shared Metric shape (VALUE / NOT_MEASURED /
    // UNKNOWN / ERROR) rather than a bare null, so a metric the platform cannot
    // derive is distinguishable from one whose query failed. The honesty is
    // unchanged: Subscription still carries no billed amount, so it stays
    // NOT_MEASURED with the reason attached.
    expect(SRC).toContain("metricNotMeasured");
    expect(SRC).toContain("mrrCents");
    expect(SRC).toContain("arrCents");
    expect(SRC).toContain("arrCents");
  });

  it("derives storage add-on MRR from real amountCents (MONTHLY only)", () => {
    expect(SRC).toContain("workspaceStorageAddon");
    // Storage add-on MRR IS derivable — add-ons carry a real billed amount
    // and a billing cycle — and only MONTHLY rows are recurring revenue.
    expect(SRC).toMatch(/billingCycle !== "MONTHLY"/);
    expect(SRC).toContain("storageMrrByCurrency");
  });

  it("reports storage add-on MRR PER CURRENCY, never as one summed figure", () => {
    // `WorkspaceStorageAddon.currency` is a real column and this platform has
    // no exchange-rate authority, so a single total across currencies is not
    // an approximation — it is a number that is not money in any currency.
    expect(SRC).toContain("mrrByCurrency");
    expect(SRC).not.toContain("mrrContributionCents");
  });

  it("gives the add-on counts rows to drill into (ADM-029)", () => {
    // `orphanedCount` names an actionable condition. A count with no way to
    // reach the rows behind it is a terminal mystery number.
    expect(SRC).toContain("AdminBillingAddonRow");
    expect(SRC).toMatch(/orphaned: orphanedAddonIds\.has/);
  });

  it("emits an honest 'not measured' note when subscription MRR is null", () => {
    expect(SRC).toMatch(/not derivable|Not estimated/i);
  });
});

describe("Phase P1 admin-billing — webhook status real-or-not-connected", () => {
  it("reads processingStatus from both webhook tables", () => {
    expect(SRC).toContain("client.stripeWebhookEvent.groupBy");
    expect(SRC).toContain("client.paypalWebhookEvent.groupBy");
    expect(SRC).toMatch(/by:\s*\[\s*"processingStatus"\s*\]/);
  });

  it("reports real webhook counts; the not-connected verdict is the UI's", () => {
    // The verdict is now computed from the real counts (total === 0 means the
    // provider has never delivered), rather than a literal string constant.
    expect(SRC).toContain("processingStatus");
    expect(SRC).toMatch(/FAILED_PERMANENT|DEAD_LETTER/);
    // The verdict is derived from real failed-row counts rather than a literal.
    expect(SRC).toContain("failed");
    expect(SRC).toContain("lastReceivedAt");
    // The webhook verdict is derived from real failed-row counts rather than
    // from a literal health string.
    expect(SRC).toContain("lastReceivedAt");
    // The service now reports FACTS (total, failed, lastReceivedAt) and the
    // console renders the verdict — `total === 0` is drawn as "Not connected".
    // Deriving the verdict server-side AND rendering it client-side would be
    // two authorities for one judgement; the page owns the words.
    expect(SRC).toContain("total,");
    expect(SRC).toContain("failed,");
  });
});

describe("Phase P1 admin-billing — NO secrets / tokens / PII beyond email", () => {
  it("never selects providerPaymentId / provider secrets / card tokens", () => {
    expect(SRC).not.toMatch(/providerPaymentId:\s*true/);
    // ADM-030 — `providerSubId` IS selected now, and immediately MASKED. An
    // operator has to be able to correlate a row with a provider dashboard;
    // what must never leave this surface is the FULL handle, and `maskRef`
    // is what guarantees that.
    expect(SRC).toContain("maskRef");
    expect(SRC).toContain("providerSubRefMasked");
    expect(SRC).not.toMatch(/providerSubId: s\.providerSubId/);
    expect(SRC).not.toMatch(/token/i);
  });

  it("exposes only email as customer PII on payment rows", () => {
    expect(SRC).toContain("userEmail");
    // ADM-030 — the affected party is resolved in a BATCHED lookup rather than
    // a per-row include, and carries the workspace and customer as well as the
    // email, because an attention row that cannot say who is affected is the
    // finding this page closed.
    expect(SRC).toContain("userEmail");
    expect(SRC).toContain("resolveSubjects");
    // No broader user PII fields pulled in.
    // ADM-030 — a workspace name and a customer-organization name ARE selected
    // now, deliberately: every attention row has to answer "who is affected?",
    // and a UUID does not. Neither is personal PII. What this assertion is
    // actually for is the PERSON's name, which is still not selected — email
    // remains the only personal field on this surface.
    expect(SRC).not.toMatch(/displayName/);
    expect(SRC).not.toMatch(/firstName|lastName/);
    expect(SRC).not.toMatch(/phone:\s*true/);
  });
});
