/**
 * PROOVRA — Pricing hardening canonical-contract test.
 *
 * Pins every invariant introduced by the pricing-hardening change set
 * so that public Pricing UI, API catalog, backend enforcement, Stripe
 * /PayPal mapping, and migration guarantees can never silently drift.
 *
 * Test style: source-contract (file-text assertions). No DB I/O. The
 * shape mirrors `phase-10-billing-guards.test.ts`.
 *
 * If you need to change a value here, you are changing the public
 * pricing contract. Update the spec (and probably the migration),
 * update this test, then update the code.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SHARED_BILLING_CATALOG = resolve(
  REPO_ROOT,
  "packages/shared-billing/src/plan-catalog.ts",
);
const SHARED_BILLING_CODES = resolve(
  REPO_ROOT,
  "packages/shared/src/collaboration-team-billing-codes.ts",
);
const API_BILLING_PRICING = resolve(
  API_ROOT,
  "src/services/billing-pricing.service.ts",
);
const API_BILLING_ENFORCEMENT = resolve(
  API_ROOT,
  "src/services/billing-enforcement.service.ts",
);
const API_ENTERPRISE_MIDDLEWARE = resolve(
  API_ROOT,
  "src/middleware/require-enterprise-feature.ts",
);
const API_AI_ROUTES = resolve(
  API_ROOT,
  "src/routes/ai.routes.ts",
);
const API_SCIM_ROUTES = resolve(API_ROOT, "src/routes/scim.routes.ts");
const API_SAML_ROUTES = resolve(API_ROOT, "src/routes/saml-auth.routes.ts");
const API_GOVERNANCE_ROUTES = resolve(
  API_ROOT,
  "src/routes/governance-lifecycle.routes.ts",
);
const API_IDENTITY_SECURITY_ROUTES = resolve(
  API_ROOT,
  "src/routes/identity-security.routes.ts",
);
const API_IDENTITY_ROUTES = resolve(API_ROOT, "src/routes/identity.routes.ts");
const API_MFA_ADMIN_ROUTES = resolve(
  API_ROOT,
  "src/routes/mfa-admin.routes.ts",
);
const PRISMA_SCHEMA = resolve(API_ROOT, "prisma/schema.prisma");
const MIGRATION_PATH = resolve(
  API_ROOT,
  "prisma/migrations/20270826000000_pricing_hardening_enterprise_plan_record_caps/migration.sql",
);
const WEB_PRICING_PAGE = resolve(
  REPO_ROOT,
  "apps/web/app/pricing/page.tsx",
);
const WEB_COMPARISON_TABLE = resolve(
  REPO_ROOT,
  "apps/web/components/pricing/PricingComparisonTable.tsx",
);
const WEB_PRICING_TYPES = resolve(
  REPO_ROOT,
  "apps/web/app/pricing/types.ts",
);
const WEB_BILLING_SUMMARY = resolve(
  REPO_ROOT,
  "apps/web/lib/api/billing-summary.ts",
);
const WEB_PLATFORM_CONTEXT_TYPES = resolve(
  REPO_ROOT,
  "apps/web/lib/platform-context/types.ts",
);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// ──────────────────────────────────────────────────────────────────────
// 1. Canonical PLAN_CAPABILITIES
// ──────────────────────────────────────────────────────────────────────
describe("canonical plan capabilities (shared-billing)", () => {
  const text = read(SHARED_BILLING_CATALOG);

  it("declares ENTERPRISE in PlanType union", () => {
    expect(text).toMatch(
      /export type PlanType =\s*"FREE"\s*\|\s*"PAYG"\s*\|\s*"PRO"\s*\|\s*"TEAM"\s*\|\s*"ENTERPRISE"/,
    );
  });

  it("PRO ships a 100-record lifetime cap (no unlimited)", () => {
    expect(text).toMatch(/PRO:\s*\{[\s\S]*?maxEvidenceRecords:\s*100/);
  });

  it("TEAM ships a 500-record rolling-30-day monthly cap", () => {
    expect(text).toMatch(
      /TEAM:\s*\{[\s\S]*?maxEvidenceRecordsPerMonth:\s*500/,
    );
  });

  it("FREE keeps the 3-record lifetime cap", () => {
    expect(text).toMatch(/FREE:\s*\{[\s\S]*?maxEvidenceRecords:\s*3/);
  });

  it("AI advisory monthly caps match the published spec", () => {
    expect(text).toMatch(
      /FREE:\s*\{[\s\S]*?aiAdvisoryMonthlyOperations:\s*0/,
    );
    expect(text).toMatch(
      /PRO:\s*\{[\s\S]*?aiAdvisoryMonthlyOperations:\s*100/,
    );
    expect(text).toMatch(
      /TEAM:\s*\{[\s\S]*?aiAdvisoryMonthlyOperations:\s*500/,
    );
    expect(text).toMatch(
      /ENTERPRISE:\s*\{[\s\S]*?aiAdvisoryMonthlyOperations:\s*null/,
    );
  });

  it("ENTERPRISE entry exists with the canonical feature flags", () => {
    expect(text).toMatch(/ENTERPRISE:\s*\{/);
    expect(text).toMatch(/ssoScim/);
    expect(text).toMatch(/mfaEnforcement/);
    expect(text).toMatch(/legalHold/);
    expect(text).toMatch(/retentionPolicy/);
    expect(text).toMatch(/organizationAuditLogs/);
    expect(text).toMatch(/objectLock/);
    expect(text).toMatch(/accessReviews/);
    expect(text).toMatch(/sessionGovernance/);
  });

  it("storage envelopes match the canonical spec", () => {
    expect(text).toMatch(/PRO:\s*\{[\s\S]*?includedStorageBytes:\s*100n\s*\*\s*GB/);
    expect(text).toMatch(/TEAM:\s*\{[\s\S]*?includedStorageBytes:\s*500n\s*\*\s*GB/);
  });

  it("monthly price cents preserve existing Stripe/PayPal mapping", () => {
    expect(text).toMatch(/PRO:\s*\{[\s\S]*?monthlyPriceCents:\s*1900/);
    expect(text).toMatch(/TEAM:\s*\{[\s\S]*?monthlyPriceCents:\s*7900/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. New error codes (canonical vocabulary)
// ──────────────────────────────────────────────────────────────────────
describe("shared billing error codes", () => {
  const text = read(SHARED_BILLING_CODES);
  for (const code of [
    "EVIDENCE_RECORD_LIMIT_REACHED",
    "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
    "AI_MONTHLY_LIMIT_REACHED",
    "ENTERPRISE_FEATURE_REQUIRED",
  ]) {
    it(`declares ${code}`, () => {
      expect(text).toContain(code);
    });
  }
  it("maps codes to HTTP statuses", () => {
    expect(text).toMatch(/EVIDENCE_RECORD_LIMIT_REACHED:\s*409/);
    expect(text).toMatch(/EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED:\s*409/);
    expect(text).toMatch(/AI_MONTHLY_LIMIT_REACHED:\s*429/);
    expect(text).toMatch(/ENTERPRISE_FEATURE_REQUIRED:\s*402/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Catalog endpoint emits ENTERPRISE + new fields
// ──────────────────────────────────────────────────────────────────────
describe("/v1/billing/pricing catalog shape (API)", () => {
  const text = read(API_BILLING_PRICING);
  it("includes ENTERPRISE in the response", () => {
    expect(text).toMatch(/enterprise:\s*\{/);
    expect(text).toContain("pricingModel");
    expect(text).toMatch(/pricingModel:\s*"CUSTOM"/);
  });

  it("projects new evidence + AI cap fields", () => {
    expect(text).toContain("maxEvidenceRecords");
    expect(text).toContain("maxEvidenceRecordsPerMonth");
    expect(text).toContain("aiAdvisoryMonthlyOperations");
  });

  it("preserves existing Stripe price-ID env-var resolution", () => {
    for (const env of [
      "STRIPE_PAYG_PRICE_ID_EUR",
      "STRIPE_PAYG_PRICE_ID_USD",
      "STRIPE_PRO_PRICE_ID_EUR",
      "STRIPE_PRO_PRICE_ID_USD",
      "STRIPE_TEAM_PRICE_ID_EUR",
      "STRIPE_TEAM_PRICE_ID_USD",
    ]) {
      expect(text).toContain(env);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Enforcement wires monthly window + legacy override + AI gate
// ──────────────────────────────────────────────────────────────────────
describe("billing-enforcement guards (API)", () => {
  const text = read(API_BILLING_ENFORCEMENT);

  it("enforces a rolling 30-day window for the TEAM monthly cap", () => {
    expect(text).toContain("THIRTY_DAYS_MS");
    expect(text).toContain("maxEvidenceRecordsPerMonth");
    expect(text).toContain("EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED");
  });

  it("honours the grandfather cap via the canonical envelope (§9.7 fold)", () => {
    // The raw override is interpreted ONLY inside resolveCommercialContext;
    // enforcement consumes the envelope-resolved commercialLimits.
    expect(text).not.toMatch(/scope\.legacyRecordCapOverride/);
    expect(text).toContain("commercialLimits?.effectiveLifetimeRecordCap");
    expect(text).toContain("effectiveLifetimeCap");
  });

  it("emits the new EVIDENCE_RECORD_LIMIT_REACHED code", () => {
    expect(text).toContain("EVIDENCE_RECORD_LIMIT_REACHED");
  });

  it("exposes a plan-aware AI monthly gate", () => {
    expect(text).toContain("assertWorkspaceAllowsAiOperation");
    expect(text).toContain("AI_MONTHLY_LIMIT_REACHED");
    expect(text).toContain("recordWorkspaceAiOperation");
    // EntitlementUsage table is the durable monthly counter.
    expect(text.toLowerCase()).toContain("entitlementusage");
  });

  it("exposes assertWorkspaceAllowsEnterpriseFeature", () => {
    expect(text).toContain("assertWorkspaceAllowsEnterpriseFeature");
    expect(text).toContain("ENTERPRISE_FEATURE_REQUIRED");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Enterprise gate Fastify preHandler exists
// ──────────────────────────────────────────────────────────────────────
// LEGACY-003 (2026-08-15) — `src/middleware/require-enterprise-feature.ts` was
// REMOVED and these two assertions retired with it. It was a SECOND
// enterprise-entitlement gate with zero importers: `billing-enforcement.service`
// is the live one and every route uses it. Asserting the export shape and the
// 402 code of a middleware no route installs described a control that could not
// fire; the entitlement denials that DO fire are asserted elsewhere in this
// file against the live enforcement path.
describe("enterprise feature gate middleware (API) — removed", () => {
  it("the parallel enterprise gate stays removed", () => {
    expect(
      existsSync(API_ENTERPRISE_MIDDLEWARE),
      "require-enterprise-feature.ts is REMOVED (LEGACY-003) and must not return",
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. AI routes are gated by the plan-aware monthly cap
// ──────────────────────────────────────────────────────────────────────
describe("AI route wiring", () => {
  const text = read(API_AI_ROUTES);
  for (const fn of [
    "assertWorkspaceAllowsAiOperation",
    "recordWorkspaceAiOperation",
    // §9.7 — AI scope now flows through the canonical commercial envelope.
    "resolveCommercialContext",
  ]) {
    it(`imports ${fn}`, () => {
      expect(text).toContain(fn);
    });
  }
  it("gates all three AI endpoints (chat, capture session, capture item)", () => {
    const matches = text.match(/assertWorkspaceAllowsAiOperation/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. Prisma schema + migration
// ──────────────────────────────────────────────────────────────────────
describe("Prisma schema + migration", () => {
  const schema = read(PRISMA_SCHEMA);
  it("PlanType enum includes ENTERPRISE", () => {
    expect(schema).toMatch(/enum PlanType \{[\s\S]*?ENTERPRISE[\s\S]*?\}/);
  });
  it("Entitlement has legacyRecordCapOverride", () => {
    expect(schema).toContain("legacyRecordCapOverride");
    expect(schema).toContain("legacy_record_cap_override");
  });
  it("Evidence has the team+createdAt compound index", () => {
    expect(schema).toMatch(
      /@@index\(\[teamId,\s*createdAt\(sort: Desc\)\]\)/,
    );
  });

  const migration = read(MIGRATION_PATH);
  it("migration adds ENTERPRISE to PlanType enum", () => {
    expect(migration).toMatch(/ALTER TYPE\s+"PlanType"\s+ADD VALUE/);
    expect(migration).toContain("ENTERPRISE");
  });
  it("migration backfills override for PRO accounts above 100 records", () => {
    expect(migration).toContain("legacy_record_cap_override");
    expect(migration).toContain("> 100");
    expect(migration).toContain("plan = 'PRO'");
  });
  it("migration does NOT delete data", () => {
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Public Pricing UI never advertises "Unlimited" for self-serve plans
// ──────────────────────────────────────────────────────────────────────
describe("public pricing UI vs catalog parity", () => {
  const page = read(WEB_PRICING_PAGE);
  const types = read(WEB_PRICING_TYPES);

  it("Pro card no longer says 'Unlimited evidence records'", () => {
    expect(page).not.toContain("Unlimited evidence records");
  });
  it("Pro card shows 100 evidence records included", () => {
    expect(page).toContain("evidence records included");
  });
  it("Team card shows 500 evidence records / month", () => {
    expect(page).toContain("evidence records / month");
  });
  // UX refinement: the Fair-Usage block + AI advisory disclaimer were
  // moved off the primary pricing flow (the spec routes them to FAQ /
  // Billing Terms / Checkout / Documentation / Legal pages). Pin their
  // absence from the pricing page so the IA can't regress back to the
  // legal-documentation-block feel.
  it("Fair-usage block is NOT on the primary pricing page (moved to FAQ/docs)", () => {
    expect(page).not.toContain("Fair usage &amp; operational safeguards");
    expect(page).not.toContain("Plan caps describe the included monthly allowance");
  });
  it("AI advisory disclaimer is NOT on the primary pricing page (moved to FAQ/docs)", () => {
    expect(page).not.toContain("AI assistance is advisory and does not determine truth");
  });
  it("Compact Enterprise governance strip has been removed (no chip rail)", () => {
    expect(page).not.toContain("Enterprise governance — included only on Enterprise");
  });
  it("Built For Enterprise card carries the 3 canonical enterprise-focused bullets", () => {
    for (const title of [
      "Enterprise Identity",
      "Governance & Compliance",
      "Preservation Infrastructure",
    ]) {
      expect(page).toContain(title);
    }
  });
  it("Enterprise pricing card lists 5 capability groups (not detailed bullets)", () => {
    expect(page).toContain('"Identity & Access"');
    expect(page).toContain('"Governance Controls"');
    expect(page).toContain('"Preservation Infrastructure"');
    expect(page).toContain('"Enterprise Security"');
    expect(page).toContain('"Procurement & SLA"');
    // The detailed bullets `"Security review, SLA, procurement support"` and
    // `"Legal hold, retention, organization audit logs"` must not live on
    // the Enterprise card anymore — those specifics belong in the comparison
    // table. (The comparison-table row label "SAML SSO, SCIM, MFA enforcement"
    // is intentionally preserved.)
    expect(page).not.toContain('"Security review, SLA, procurement support"');
    expect(page).not.toContain('"Legal hold, retention, organization audit logs"');
  });
  it("Comparison table is split into two enterprise tables", () => {
    expect(page).toContain("Plans &amp; Capacity");
    expect(page).toContain("Operations &amp; Governance");
  });
  // PHASE 12 POINT 4 PASS D/G — the invariant moved to the LIVE page.
  //
  // `components/pricing/PricingComparisonTable.tsx` had zero importers: the
  // pricing page renders its own split tables (asserted above). Pinning the
  // unmounted component asserted "Unlimited" was absent from a file no user
  // could reach, while the page that ships was covered only indirectly. The
  // rule now applies where the table is actually rendered.
  it("the rendered comparison tables never advertise 'Unlimited' capacity", () => {
    expect(page).not.toMatch(/values:\s*\[[^\]]*"Unlimited"[^\]]*\]/);
    expect(page).toContain("/ month");
    expect(page).toContain("included");
  });

  it("the unmounted comparison-table component stays removed", () => {
    expect(existsSync(WEB_COMPARISON_TABLE)).toBe(false);
  });
  it("PlanType in web types declares ENTERPRISE", () => {
    expect(types).toContain(
      '"FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE"',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9a. Enterprise-feature route gates wired
// ──────────────────────────────────────────────────────────────────────
describe("enterprise feature route gates", () => {
  it("billing-enforcement exports assertTeamAllowsEnterpriseFeature", () => {
    const text = read(API_BILLING_ENFORCEMENT);
    expect(text).toContain("export async function assertTeamAllowsEnterpriseFeature");
  });

  it("SCIM gates non-Enterprise tenants via shared resolver", () => {
    const text = read(API_SCIM_ROUTES);
    expect(text).toContain("resolveTeamEnterpriseFeatureGate");
    expect(text).toContain("enterpriseFeatureRequired");
    expect(text).toContain('"application/scim+json"');
    expect(text).toMatch(/code\(402\)/);
    // The Enterprise gate logic itself lives in the shared service.
    const sharedResolver = read(
      resolve(API_ROOT, "src/services/enterprise-gate-resolvers.service.ts"),
    );
    expect(sharedResolver).toContain("enterpriseFeatures[feature]");
  });

  it("SAML admin routes gate via the shared connection resolver", () => {
    const text = read(API_SAML_ROUTES);
    expect(text).toContain("resolveSamlConnectionEnterpriseGate");

    // PHASE 13 §1.2 — this used to require FOUR inline `await
    // resolveSamlConnectionEnterpriseGate(connectionId)` calls, one per admin
    // handler. That was counting COPIES of a decision, and the copies were the
    // problem: each handler also ordered the gate ahead of its authorization
    // check, so an outsider could read another workspace's plan (402) and tell
    // it apart from an absent connection (404).
    //
    // The four copies are now ONE call inside `authorizeSamlOperator`, which
    // every admin handler routes through. So the property to assert is that all
    // four handlers reach the gate — not that they each write it out.
    const gateCalls =
      text.match(/await resolveSamlConnectionEnterpriseGate\(connectionId\)/g) ?? [];
    expect(gateCalls.length).toBeGreaterThanOrEqual(1);
    const authzCalls =
      text.match(/await authorizeSamlOperator\(req, connectionId\)/g) ?? [];
    expect(
      authzCalls.length,
      "each of the four SAML admin handlers must route through the single authority",
    ).toBeGreaterThanOrEqual(4);
    // And the authority must consult the gate AFTER establishing membership,
    // so the plan is never readable by someone outside the workspace.
    const authorityBody = text.slice(
      text.indexOf("async function authorizeSamlOperator"),
      text.indexOf("Builds the ACS (AssertionConsumerService) URL"),
    );
    expect(authorityBody.indexOf("teamMember.findFirst")).toBeGreaterThan(0);
    expect(authorityBody.indexOf("resolveSamlConnectionEnterpriseGate")).toBeGreaterThan(
      authorityBody.indexOf("teamMember.findFirst"),
    );
    // The gate definition lives in the shared service, NOT in saml-auth.routes.ts.
    const sharedResolver = read(
      resolve(API_ROOT, "src/services/enterprise-gate-resolvers.service.ts"),
    );
    expect(sharedResolver).toContain("export async function resolveSamlConnectionEnterpriseGate");
    // Defence-in-depth: saml-auth.routes.ts must NOT inline the gate.
    expect(text).not.toContain("export async function assertSamlConnectionIsEnterprise");
  });

  it("Governance routes gate retention-policy + destruction-review + lifecycle mutations", () => {
    const text = read(API_GOVERNANCE_ROUTES);
    expect(text).toContain("assertTeamAllowsEnterpriseFeature");
    expect(text).toContain("denyIfTeamNotEnterprise");
    // Retention policy: POST + PATCH + transition POST = 3 gates with retentionPolicy.
    const retentionMatches =
      text.match(/denyIfTeamNotEnterprise\(reply, body\.teamId, "retentionPolicy"\)/g) ??
      [];
    expect(retentionMatches.length).toBeGreaterThanOrEqual(3);
    // Destruction review create + transition + lifecycle transition = 3 gates with legalHold.
    const legalHoldMatches =
      text.match(/denyIfTeamNotEnterprise\(reply, body\.teamId, "legalHold"\)/g) ?? [];
    expect(legalHoldMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("Session governance routes gate sessions/revoke + revoke-all + list", () => {
    const text = read(API_IDENTITY_SECURITY_ROUTES);
    expect(text).toContain("denyIfTeamNotEnterprise");
    const matches =
      text.match(/denyIfTeamNotEnterprise\(reply, [^)]+, "sessionGovernance"\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("Identity access-review admin routes gate list + regenerate + decision", () => {
    const text = read(API_IDENTITY_ROUTES);
    expect(text).toContain("denyIfTeamNotEnterprise");
    const matches =
      text.match(/denyIfTeamNotEnterprise\(reply, [^)]+, "accessReviews"\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("MFA enforcement policy PATCH gated; user-self routes NOT gated", () => {
    const text = read(API_MFA_ADMIN_ROUTES);
    expect(text).toContain('assertTeamAllowsEnterpriseFeature(params.teamId, "mfaEnforcement")');
    // Defensive: the gate must appear AFTER the policy patch route start,
    // NOT in the user-self digest-preferences/recovery-event handlers.
    // We check digest-preferences handlers do NOT contain the gate call.
    const digestSection = text.slice(text.indexOf("/v1/identity/mfa-admin/digest-preferences"));
    expect(digestSection).not.toContain('assertTeamAllowsEnterpriseFeature(');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 9. In-app billing surfaces stay aligned with public Pricing
// ──────────────────────────────────────────────────────────────────────
describe("in-app billing alignment", () => {
  const billingSummary = read(WEB_BILLING_SUMMARY);
  const platformContextTypes = read(WEB_PLATFORM_CONTEXT_TYPES);

  it("billing-summary no longer coerces caps >= 1000 to 'unlimited'", () => {
    expect(billingSummary).not.toContain("UNLIMITED_THRESHOLD");
  });

  it("billing-summary projectMax returns 'unlimited' ONLY for ENTERPRISE", () => {
    expect(billingSummary).toMatch(
      /if\s*\(plan\s*===\s*"ENTERPRISE"\)\s*return\s*"unlimited"/,
    );
  });

  it("WorkspacePlan list now includes ENTERPRISE", () => {
    expect(platformContextTypes).toMatch(
      /WORKSPACE_PLANS\s*=\s*\[[\s\S]*?"ENTERPRISE"[\s\S]*?\]/,
    );
  });
});
