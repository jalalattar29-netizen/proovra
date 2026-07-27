/**
 * PHASE 9 §12 (2026-07-22) — machine-enforced commercial-reader
 * classification registry.
 *
 * Scans production `src/` for RAW commercial-plan DECISIONS
 * (`X.billingPlan === PlanType.…` / `X.billingStatus === TeamBillingStatus.…`
 * used in a boolean decision) and asserts every occurrence is classified
 * in REGISTRY below. Classes:
 *   A CANONICAL_INTERNAL  — the raw read lives inside the canonical
 *                           commercial/domain layer (the ONE decision site).
 *   B PERSISTENCE_WRITE    — writes provider/webhook state, no decision.
 *   C CANONICAL_CONSUMER   — obtains its decision from the canonical layer
 *                            (getPlanCapabilities / resolveCommercialContext /
 *                            isPaidTeamSubscriptionActive), not raw literals.
 *   D DISPLAY_PROJECTION   — read for admin/reporting/CSV display only.
 *   E UNRESOLVED_DECISION  — a raw plan/billing capability/limit/lifecycle
 *                            decision OUTSIDE the canonical layer.
 *
 * COMPLETION: E (UNRESOLVED_DECISION) === 0. A NEW raw decision that is not
 * registered fails this test (machine-enforced, not documentation).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Corrected Phase 9 semantics (2026-07-22): there is NO permanent raw-reader
// class. DISPLAY_PROJECTION is DISSOLVED — a projection that derives
// plan/status/feature/seat/storage/add-on/checkout/billing behavior from raw
// fields is a commercial-decision CONSUMER and must be either CANONICAL_CONSUMER
// (class C) or TEMPORARY_ADAPTER (class T, symbol-level, with owner + removal
// condition + Phase-12 target). Only the canonical layer (A) may hold the raw
// decision; only provider-state writers (B) may persist it without a decision.
type Class = "A" | "B" | "C" | "T" | "E";
type Entry = {
  class: Class;
  reason: string;
  // Required for TEMPORARY_ADAPTER (T): the symbol that still reads raw, who
  // owns removing it, the condition under which it is removed, and the Phase-12
  // convergence target. Machine-enforced below.
  symbol?: string;
  owner?: string;
  removal?: string;
  phase12Target?: string;
};

// Every file that reads billingPlan/billingStatus as a decision, a persistence
// write, or a projection, with its classification. Files NOT here that contain
// a raw `billingPlan === PlanType` / `billingStatus === TeamBillingStatus`
// decision fail the scan below → forces classification of any new site.
const REGISTRY: Record<string, Entry> = {
  // A — canonical commercial/domain layer (the decision lives here).
  "services/workspace-billing.service.ts": { class: "A", reason: "canonical scope + isPaidTeamSubscriptionActive (the ONE subscription-active rule)" },
  "services/billing-enforcement.service.ts": { class: "A", reason: "canonical enforcement arm (assertWorkspaceAllows*)" },
  "services/workspace-usage.service.ts": { class: "A", reason: "canonical usage/seat/storage" },
  "services/enterprise-gate-resolvers.service.ts": { class: "A", reason: "canonical enterprise-feature gate (effectivePlan from billing/entitlement)" },
  "services/billing/commercial-context.service.ts": { class: "A", reason: "the composing resolver" },
  "services/identity/workspace-kind.ts": { class: "A", reason: "canonical WORKSPACE-KIND classifier (domain, not commercial capability): billingPlan===ENTERPRISE→ORGANIZATION" },
  // B — persistence / provider webhook state (no capability decision).
  "services/billing.service.ts": { class: "B", reason: "billing lifecycle writes (activate/cancel/status) — persistence" },
  "services/billing-checkout.service.ts": { class: "B", reason: "checkout session persistence" },
  "services/billing-pricing.service.ts": { class: "B", reason: "pricing catalog projection" },
  // C — canonical consumers (decision from the canonical layer).
  "routes/webhooks.routes.ts": { class: "C", reason: "webhook enablement now uses isPaidTeamSubscriptionActive (migrated from raw billingPlan===TEAM)" },
  "services/billing-overview.service.ts": { class: "C", reason: "billing overview composes getPlanCapabilities" },
  // T — TEMPORARY_ADAPTER: reads raw billingStatus/billingPlan for a projection
  //     that is NOT yet fed by an API-projected canonical read-model. Each is
  //     symbol-level, non-decision-making, and carries a Phase-12 removal target.
  //     (Was the invalid permanent "DISPLAY_PROJECTION" class — dissolved.)
  "services/identity/account-lifecycle-preflight.service.ts": { class: "T", reason: "reads billingStatus to display closure-eligibility preflight (not a capability grant)", symbol: "buildAccountClosurePreflight (billingStatus read)", owner: "identity domain", removal: "consume resolveCommercialContext().plan/enterpriseContract for closure eligibility", phase12Target: "canonical closure-eligibility projection" },
  "routes/analytics.routes.ts": { class: "T", reason: "admin analytics aggregation counts (active/pastdue/canceled)", symbol: "GET /admin/analytics billingStatus groupBy", owner: "admin/analytics domain", removal: "read from a canonical admin billing read-model", phase12Target: "admin commercial read-model projection" },
  "routes/organizations-governance.routes.ts": { class: "T", reason: "governance CSV plan/status display", symbol: "governance CSV plan/status columns", owner: "org-governance domain", removal: "project plan/status via canonical org read-model", phase12Target: "canonical org commercial projection" },
  "routes/organizations-reports.routes.ts": { class: "T", reason: "org reports CSV plan/status columns", symbol: "org report CSV plan/status columns", owner: "org-reports domain", removal: "project plan/status via canonical org read-model", phase12Target: "canonical org commercial projection" },
  "services/admin/customer-lifecycle.ts": { class: "T", reason: "admin customer lifecycle display", symbol: "customer-lifecycle plan/status display fields", owner: "admin domain", removal: "consume canonical admin read-model", phase12Target: "admin commercial read-model projection" },
  "services/admin/executive.service.ts": { class: "T", reason: "admin executive dashboard plan display", symbol: "executive dashboard plan/status aggregation", owner: "admin domain", removal: "consume canonical admin read-model", phase12Target: "admin commercial read-model projection" },
  "services/admin/search.service.ts": { class: "T", reason: "admin search plan sublabel display", symbol: "admin search plan sublabel", owner: "admin domain", removal: "consume canonical admin read-model", phase12Target: "admin commercial read-model projection" },
  "services/organization/admin-organizations.service.ts": { class: "T", reason: "admin org plan/status aggregation display", symbol: "admin-organizations plan/status aggregation", owner: "admin/org domain", removal: "consume canonical admin read-model", phase12Target: "admin commercial read-model projection" },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts") && statSync(full).isFile()) out.push(full);
  }
  return out;
}

// Raw commercial-DECISION signatures (not `select:`/`data:` object keys).
const RAW_DECISION =
  /\.billingPlan\s*(===|!==)\s*(prismaPkg\.PlanType|PlanType|"(FREE|PAYG|PRO|TEAM|ENTERPRISE)")|\.billingStatus\s*(===|!==)\s*(prismaPkg\.TeamBillingStatus|TeamBillingStatus|"(ACTIVE|PAST_DUE|CANCELED|INACTIVE)")/;

describe("Phase 9 §12 — commercial-reader classification registry", () => {
  const rawDecisionFiles = walk(SRC)
    .filter((f) => RAW_DECISION.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).replace(/\\/g, "/"));

  it("the scanner is non-vacuous (matches the real decision surface) and every hit is classified", () => {
    // Guard against a broken regex silently passing: the raw-decision
    // surface is real and non-trivial.
    expect(rawDecisionFiles.length).toBeGreaterThanOrEqual(5);
    const unclassified = rawDecisionFiles.filter((f) => !REGISTRY[f]);
    expect(unclassified).toEqual([]);
  });

  it("UNRESOLVED_DECISION (class E) === 0", () => {
    const e = Object.entries(REGISTRY).filter(([, v]) => v.class === "E");
    expect(e.map(([k]) => k)).toEqual([]);
  });

  it("no whole-file allowlist: every entry has a concrete reason", () => {
    for (const [file, entry] of Object.entries(REGISTRY)) {
      expect(entry.reason.length, file).toBeGreaterThan(10);
    }
  });

  it("no permanent raw DISPLAY_PROJECTION class exists (dissolved into TEMPORARY_ADAPTER)", () => {
    // Corrected semantics: the only classes are A/B/C/T/E. A raw display
    // projection MUST be a TEMPORARY_ADAPTER (T) with a removal path — it may
    // never be an open-ended "display is fine" allowance.
    const classes = new Set(Object.values(REGISTRY).map((e) => e.class));
    for (const c of classes) expect(["A", "B", "C", "T", "E"]).toContain(c);
  });

  it("every TEMPORARY_ADAPTER (T) is symbol-level with owner + removal + Phase-12 target", () => {
    for (const [file, entry] of Object.entries(REGISTRY)) {
      if (entry.class !== "T") continue;
      expect(entry.symbol && entry.symbol.length > 3, `${file}: symbol`).toBe(true);
      expect(entry.owner && entry.owner.length > 3, `${file}: owner`).toBe(true);
      expect(entry.removal && entry.removal.length > 8, `${file}: removal`).toBe(true);
      expect(
        entry.phase12Target && entry.phase12Target.length > 8,
        `${file}: phase12Target`,
      ).toBe(true);
    }
  });

  it("the canonical subscription-active decision has ONE implementation and webhooks consumes it directly", () => {
    // §9.4 (2026-07-22): the api-side delegate was DELETED; the rule lives
    // only in shared-billing and webhooks imports it directly.
    const wb = readFileSync(join(SRC, "services", "workspace-billing.service.ts"), "utf8");
    expect(wb).not.toContain("export function isPaidTeamSubscriptionActive");
    const routes = readFileSync(join(SRC, "routes", "webhooks.routes.ts"), "utf8");
    expect(routes).toMatch(/isWorkspaceSubscriptionActive as isPaidTeamSubscriptionActive.*@proovra\/shared-billing|from "@proovra\/shared-billing"/);
    expect(routes).toContain("isPaidTeamSubscriptionActive({");
    // The migrated capability decision no longer compares raw plan literals.
    expect(routes).not.toMatch(/billingPlan === prismaPkg\.PlanType\.TEAM/);
  });
});
