/**
 * PHASE 9 §12 (2026-07-22) — commercial correctness invariants.
 *
 * The mandate's required proofs that the canonical commercial model holds
 * across the codebase. Behavioral where the surface allows; source-
 * contract where the proof is "this code path must NOT do X" (absence of
 * a dangerous coupling).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("Phase 9 §12.3 — TEAM never provisions Enterprise", () => {
  it("self-service org creation is retired; Enterprise only via platform-admin provisioning", () => {
    const orgs = read("routes/organizations.routes.ts");
    expect(orgs).toContain("org_self_service_creation_retired");
    const admin = read("routes/admin-provisioning.routes.ts");
    // Every enterprise-assigning route is gated by requirePlatformAdmin.
    expect(admin).toContain("requirePlatformAdmin");
    expect(admin).toContain("provisionEnterpriseCustomerIdempotent");
    // The self-service billing/checkout path never assigns ENTERPRISE.
    const checkout = read("services/billing-checkout.service.ts");
    expect(checkout).not.toMatch(/PlanType\.ENTERPRISE|"ENTERPRISE"/);
  });
});

describe("Phase 9 §12 — Organization join never changes the personal plan", () => {
  it("org-invite acceptance grants membership only; never touches Entitlement/billingPlan", () => {
    const accept = read(
      "services/organization/org-invite-acceptance.service.ts",
    );
    // Membership orchestration + audit only — no entitlement/plan mutation.
    expect(accept).not.toMatch(/entitlement\.(update|create|upsert|updateMany)/i);
    expect(accept).not.toMatch(/billingPlan/);
    expect(accept).not.toMatch(/PlanType\./);
  });
});

describe("Phase 9 §12.6 — billing failure/cancellation never deletes Evidence", () => {
  it("cancelTeamPlan mutates only team billing fields — no evidence/membership deletion", () => {
    const billing = read("services/billing.service.ts");
    const at = billing.indexOf("export async function cancelTeamPlan");
    expect(at).toBeGreaterThan(-1);
    const fn = billing.slice(at, at + 1600);
    // The only mutation is team.update with billing fields.
    expect(fn).toMatch(/billingPlan:\s*prismaPkg\.PlanType\.FREE/);
    expect(fn).toMatch(/billingStatus:\s*prismaPkg\.TeamBillingStatus\.CANCELED/);
    // NEVER deletes evidence or purges memberships on cancellation.
    expect(fn).not.toMatch(/evidence\.(delete|deleteMany|update)/i);
    expect(fn).not.toMatch(/teamMember\.(delete|deleteMany)/i);
    expect(fn).not.toMatch(/massRevoke|purgeWorkspace/);
  });
});

describe("Phase 9 §12.5 — members cannot see owner payments; org billing capability-gated", () => {
  it("org workspace listing gates billing visibility behind a capability flag", () => {
    const orgs = read("routes/organizations.routes.ts");
    // billingPlan projection is gated by a canSeeBilling capability.
    expect(orgs).toMatch(/billingPlan:\s*canSeeBilling/);
  });
});

describe("Phase 9 §12.1/§12.7 — one canonical resolver + ACTIVE-only seats", () => {
  it("resolveCommercialContext composes the canonical primitives (no parallel model)", () => {
    const svc = read("services/billing/commercial-context.service.ts");
    expect(svc).toContain("resolveWorkspaceScopeForUser");
    expect(svc).toContain("getPlanCapabilities");
    expect(svc).toContain("getWorkspaceUsage");
    expect(svc).toContain("resolveEnterpriseContract");
    // §12.7 — seats come from usage.teamMemberCount (ACTIVE-only).
    expect(svc).toContain("consumed: usage.teamMemberCount");
  });

  it("the ACTIVE-only seat rule is the single source (workspace-usage counts ACTIVE members)", () => {
    const usage = read("services/workspace-usage.service.ts");
    expect(usage).toMatch(/teamId:\s*scope\.teamId,\s*status:\s*"ACTIVE"/);
  });
});
