/**
 * PHASE 9 STEP H (2026-07-22) — machine-enforced COMMERCIAL AUTHORITY-WRITER
 * registry. Locks the exact production files allowed to WRITE each commercial
 * persistence surface. A new, unregistered writer for any commercial-state
 * field FAILS this test — preventing a second billing writer / parallel
 * authority from being introduced silently.
 *
 * Non-vacuous: each surface asserts SET EQUALITY against the known writer set
 * (a removed/renamed writer also fails, catching drift in both directions).
 * Evidence rows are recorded in program-ledger.md (STEP 1 authority matrix).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts") && statSync(full).isFile()) out.push(full);
  }
  return out;
}
const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).replace(/\\/g, "/"), body: readFileSync(f, "utf8") }));

function writersMatching(re: RegExp): string[] {
  return FILES.filter((f) => re.test(f.body)).map((f) => f.rel).sort();
}

// Each surface: the exact regex identifying a WRITE, and the LOCKED allowlist
// of production files permitted to perform it (with a per-file reason).
const AUTHORITY_WRITERS: Array<{
  surface: string;
  write: RegExp;
  allowed: Record<string, string>;
}> = [
  {
    surface: "Entitlement (personal-account commercial state)",
    write: /\.entitlement\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/billing.service.ts": "canonical: ensureEntitlement/setPersonalPlan/addCredits/consumeCredits",
      "services/auth.service.ts": "bootstrap FREE entitlement on account creation",
      "services/email-password-auth.service.ts": "bootstrap FREE entitlement on email-password signup",
      "services/billing-enforcement.service.ts": "credit decrement inside enforcement tx (usage, not plan)",
    },
  },
  {
    surface: "Subscription (provider projection)",
    write: /\.subscription\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/billing.service.ts": "canonical: upsertSubscription (the ONE provider-state writer)",
      "routes/billing.routes.ts": "user-initiated cancel-at-period-end flag update",
    },
  },
  {
    surface: "Team billing columns (owned-workspace commercial state)",
    // Concrete enum-member assignment only — excludes type annotations
    // (`billingPlan: prismaPkg.PlanType;`) and read projections
    // (`billingStatus: teamWorkspace.billingStatus`).
    write: /billing(Plan|Status):\s*prismaPkg\.(PlanType|TeamBillingStatus)\.\w/,
    allowed: {
      "services/billing.service.ts": "canonical: activateTeamPlan/cancelTeamPlan/syncTeamBillingSnapshot/refreshTeamSeatState",
    },
  },
  {
    surface: "EnterpriseContract (customer-org commercial state)",
    write: /\.enterpriseContract\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/organization/enterprise-contract.service.ts": "canonical: upsertEnterpriseContract",
      "services/enterprise-provisioning.service.ts": "provisioning activation/seat-change contract update",
    },
  },
  {
    surface: "Organization.pendingEnterpriseSeats (provisioning marker)",
    write: /pendingEnterpriseSeats:\s*(seats|null|\d)/,
    allowed: {
      "services/enterprise-provisioning.service.ts": "set on provision, cleared on consume (compat marker → EnterpriseContract.seatCount)",
    },
  },
  {
    surface: "WorkspaceStorageAddon (storage add-on state)",
    write: /\.workspaceStorageAddon\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/billing.service.ts": "canonical: upsertWorkspaceStorageAddon/cancelWorkspaceStorageAddon",
      "routes/billing.routes.ts": "storage add-on purchase/cancel route → billing.service",
    },
  },
];

describe("Phase 9 STEP H — commercial authority-writer registry", () => {
  for (const s of AUTHORITY_WRITERS) {
    it(`${s.surface}: only the LOCKED writer set may write it (no new parallel authority)`, () => {
      const found = writersMatching(s.write);
      const allowed = Object.keys(s.allowed).sort();
      // Non-vacuous: the write signature must actually match something.
      expect(found.length, `${s.surface}: scanner matched nothing`).toBeGreaterThan(0);
      // Set equality — a NEW unregistered writer OR a removed known writer fails.
      expect(found, s.surface).toEqual(allowed);
    });
  }
});

/**
 * PHASE 9 STEP 5/10 — anti-divergence for the SUBSCRIPTION-ACTIVE / grace
 * DECISION. After migrating billing-guards onto the canonical resolver, the
 * ONLY commercial-capability decision over `Subscription.status` lives in
 * `commercial-context.service` (`resolvePaidLifecycle`). Every other file that
 * references `SubscriptionStatus` does so for provider→enum NORMALIZATION,
 * PERSISTENCE, or a display QUERY filter — never an independent active/grace
 * decision. This allowlist is LOCKED: a new raw `Subscription.status` site
 * fails the test and must be classified.
 */
const SUBSCRIPTION_STATUS_REF =
  /\bSubscriptionStatus\.(ACTIVE|PAST_DUE|CANCELED|TRIALING)\b/;
const SUBSCRIPTION_STATUS_ALLOWED: Record<string, string> = {
  "services/billing/commercial-context.service.ts": "CANONICAL: the ONE subscription-active + grace decision (resolvePaidLifecycle)",
  "routes/webhooks.routes.ts": "PROVIDER PROJECTION: normalizes Stripe/PayPal event strings → SubscriptionStatus + write routing (no capability decision)",
  "services/billing.service.ts": "PERSISTENCE: upsertSubscription status write",
  "routes/billing.routes.ts": "display subscription query filter + user cancel-at-period-end write",
  "routes/teams.routes.ts": "display: team subscription lookup query filter (no active/grace decision)",
};

describe("Phase 9 STEP 5 — subscription-active decision is centralized (anti-divergence)", () => {
  it("SubscriptionStatus is referenced only by the LOCKED allowlist (no new raw active/grace decision)", () => {
    const found = FILES.filter((f) => SUBSCRIPTION_STATUS_REF.test(f.body)).map((f) => f.rel).sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(Object.keys(SUBSCRIPTION_STATUS_ALLOWED).sort());
  });

  it("billing-guards holds NO independent subscription/grace engine (delegates to the resolver)", () => {
    const bg = FILES.find((f) => f.rel === "services/collaboration-team/billing-guards.ts")!.body;
    expect(bg).toContain("resolveCommercialContext");
    expect(bg).not.toMatch(/subscription\.findFirst/);
    expect(bg).not.toMatch(/Date\.now\(\)\s*-\s*periodEndMs/); // the old grace calc
  });
});
