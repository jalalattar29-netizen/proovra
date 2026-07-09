/**
 * Platform Control Center — Cost Dashboard (item G) contract suite.
 *
 * Style: source-contract (matches phase-admin-billing). Pins the guarantees
 * the cost aggregate MUST hold:
 *   1. requirePlatformAdmin gates the endpoint (non-platform-admins denied).
 *   2. The plugin is read-only and carries the tenant-scope-exception comment.
 *   3. Costs are ESTIMATED (from estimatedCostUsdMicros), never billed.
 *   4. Unmetered categories return an explicit notConnected:true entry — NOT a
 *      fabricated number.
 *   5. Empty tables collapse to honest zeros / nulls (no error path).
 *   6. NO API keys / secrets / tokens / env values are ever read or returned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTES = readSource("../src/routes/admin-costs.routes.ts");
const SERVICE = readSource("../src/services/admin/costs.service.ts");

describe("Phase admin-costs — requirePlatformAdmin gate + read-only", () => {
  it("imports and applies requirePlatformAdmin (non-platform-admins are denied)", () => {
    expect(ROUTES).toContain(
      'import { requirePlatformAdmin } from "../middleware/require-platform-admin.js"',
    );
    expect(ROUTES).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("carries the platform_admin_global tenant-scope-exception comment", () => {
    expect(ROUTES).toContain(
      "TENANT_SCOPE_EXCEPTION: platform_admin_global",
    );
  });

  it("exposes the GET /v1/admin/costs endpoint with a windowDays query", () => {
    expect(ROUTES).toContain('"/v1/admin/costs"');
    expect(ROUTES).toMatch(/windowDays/);
    expect(ROUTES).toMatch(/app\.get/);
  });

  it("is READ-ONLY — declares no writes in routes or service", () => {
    const writeRe =
      /prisma\.\w+\.(create|update|delete|upsert|updateMany|deleteMany|createMany)\b/;
    expect(ROUTES).not.toMatch(writeRe);
    expect(SERVICE).not.toMatch(writeRe);
  });

  it("exports adminCostsRoutes", () => {
    expect(ROUTES).toMatch(/export async function adminCostsRoutes\(/);
  });
});

describe("Phase admin-costs — real per-provider costs from real models", () => {
  it("aggregates estimated cost from ProviderUsageEvent.estimatedCostUsdMicros", () => {
    expect(SERVICE).toContain("prisma.providerUsageEvent.groupBy");
    expect(SERVICE).toMatch(/estimatedCostUsdMicros/);
    expect(SERVICE).toMatch(/by:\s*\[\s*"provider"\s*\]/);
  });

  it("reads budget posture + alerts from real budget models", () => {
    expect(SERVICE).toContain("prisma.providerBudget.findMany");
    expect(SERVICE).toContain("prisma.providerBudgetAlert.findMany");
    expect(SERVICE).toMatch(/softLimitUsdMicros/);
    expect(SERVICE).toMatch(/hardLimitUsdMicros/);
  });

  it("reads semantic spend from SemanticUsageDaily and entitlements from EntitlementUsage", () => {
    expect(SERVICE).toContain("prisma.semanticUsageDaily.aggregate");
    expect(SERVICE).toContain("prisma.entitlementUsage.findMany");
    expect(SERVICE).toMatch(/eurSpentMicros/);
  });
});

describe("Phase admin-costs — HONEST cost labelling", () => {
  it("labels costs as ESTIMATED (not billed)", () => {
    expect(SERVICE).toMatch(/estimated:\s*true/);
    expect(SERVICE).toMatch(/ESTIMATED/);
  });

  it("keeps embeddings spend as EUR, separate from the USD total", () => {
    expect(SERVICE).toMatch(/currency:\s*"EUR"/);
    expect(SERVICE).toMatch(/currency:\s*"USD"/);
    // The EUR note must state it is NOT summed into the USD total.
    expect(SERVICE).toMatch(/NOT summed into the USD total/i);
  });
});

describe("Phase admin-costs — unmetered categories are notConnected, not fabricated", () => {
  it("returns explicit notConnected:true entries for unmetered categories", () => {
    expect(SERVICE).toMatch(/notConnected:\s*true/);
    expect(SERVICE).toMatch(/UNMETERED_CATEGORIES/);
  });

  it("covers storage $, bandwidth, infra, email, and SMS as unmetered", () => {
    expect(SERVICE).toMatch(/Storage/);
    expect(SERVICE).toMatch(/Bandwidth/i);
    expect(SERVICE).toMatch(/Cloudflare|Vercel|infrastructure/i);
    expect(SERVICE).toMatch(/Email/i);
    expect(SERVICE).toMatch(/SMS/);
  });

  it("attaches a reason to every not-connected category (never a fake number)", () => {
    expect(SERVICE).toMatch(/reason:/);
    // Each unmetered category is described with a reason, not a $0/number.
    expect(SERVICE).not.toMatch(/costUsd:\s*0\.0*\b.*storage/i);
  });
});

describe("Phase admin-costs — empty tables handled honestly, not as errors", () => {
  it("coerces null aggregate sums to zero rather than throwing", () => {
    // Micros helpers must tolerate null / undefined (empty tables).
    expect(SERVICE).toMatch(/micros == null/);
    expect(SERVICE).toMatch(/return 0/);
  });

  it("derives providerCount / budgetsAtRisk from array length (zero when empty)", () => {
    expect(SERVICE).toMatch(/providerCount:\s*perProvider\.length/);
    expect(SERVICE).toMatch(/budgetsAtRisk/);
  });
});

describe("Phase admin-costs — NO secrets / keys / tokens / env", () => {
  it("never reads API keys, secrets, tokens, or env values", () => {
    for (const src of [ROUTES, SERVICE]) {
      expect(src).not.toMatch(/apiKey/i);
      expect(src).not.toMatch(/\bsecret\b/i);
      expect(src).not.toMatch(/accessToken|\.token\b/i);
      expect(src).not.toMatch(/process\.env/);
    }
  });
});
