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
      "services/billing.service.ts": "canonical: ensureEntitlement/setPersonalPlan",
      "services/auth.service.ts": "bootstrap FREE entitlement on account creation",
      "services/email-password-auth.service.ts": "bootstrap FREE entitlement on email-password signup",
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the credit BALANCE moved
      // out of billing-enforcement into the canonical wallet, which owns the
      // conditional decrement and the matching ledger entry in ONE transaction.
      // `addCredits`/`consumeCredits` were deleted from billing.service.ts:
      // neither was idempotent, and `consumeCredits` accepted no transaction
      // client, so its caller inside the completion transaction was in fact
      // writing outside it.
      "services/billing/evidence-credits.service.ts": "canonical evidence-credit wallet: grant + conditional consume, ledger-backed",
    },
  },
  {
    surface: "Subscription (provider projection)",
    write: /\.subscription\.(create|update|upsert|updateMany|delete|deleteMany)\b/,
    allowed: {
      "services/billing.service.ts": "canonical: upsertSubscription (the ONE provider-state writer)",
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the cancel-at-period-end
      // write MOVED out of the route and into a dedicated service, and the
      // move is the point.
      //
      // In the route it sat after a Stripe `DELETE` (immediate termination,
      // while the dialog promised a period end) and after a PayPal failure that
      // was caught, logged and then written as CANCELED anyway. The service
      // asks the provider FIRST, writes only what the provider CONFIRMED, and
      // never writes the terminal CANCELED status at all — that stays the
      // webhook's, because it is the provider's own statement about its own
      // state.
      "services/billing/subscription-cancellation.service.ts":
        "canonical: provider-confirmed cancel-at-period-end (never the terminal CANCELED)",
      // BILLING RECONCILIATION (2026-08-27) — the ORDERING STAMP, and nothing
      // else.
      //
      // Reconciliation does not write subscription STATE: every lifecycle
      // transition it applies goes through `syncPlanForSubscription`, the same
      // handler the verified webhook calls. What it writes directly is one
      // column — `providerStateAtUtc`, the provider's own timestamp for the
      // state just applied — because that is the value the ordering guard
      // reads to discard an observation older than what is already recorded.
      // Routing a single audit stamp through the plan writer would have made
      // `upsertSubscription` take an argument only one caller ever uses.
      "services/billing/reconciliation/reconciliation.service.ts":
        "canonical: providerStateAtUtc ordering stamp only — every lifecycle transition goes through syncPlanForSubscription",
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
      // BILLING RECONCILIATION (2026-08-27) — two writers added, both for the
      // same defect: a recurring add-on is its OWN provider subscription, so
      // cancelling the base plan left it charging and nothing in the product
      // connected the two.
      //
      // Neither invents a lifecycle. The status they write comes from
      // `storageAddonStatusFromSubscription`, the shared mapping the webhook
      // uses, and neither writes ANY status the provider did not confirm — a
      // refused provider call leaves the row untouched so the orphan stays
      // visible instead of being marked cancelled and forgotten.
      "services/billing/reconciliation/reconciliation.service.ts":
        "canonical: applies the PROVIDER-observed add-on status through the shared mapping, plus the providerStateAtUtc ordering stamp",
      // BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the writer
      // MOVED out of `storage-addon-dependency.service.ts` and into the
      // obligation authority, and the move is the point: the cascade no longer
      // decides anything about an add-on's state, it records an obligation and
      // the authority transitions it. Every write here is a transition on a
      // durable obligation whose only resolved state, CONFIRMED, requires a
      // provider call to have SUCCEEDED or a provider observation to have
      // proved it. A provider failure writes the failure — never a
      // cancellation.
      "services/billing/dependent-cancellation.service.ts":
        "canonical: the dependent-cancellation obligation state machine — provider first, and CONFIRMED only on provider truth",
      // The direct add-on cancel route. It writes only after
      // `cancelStorageAddonAtProvider` confirms, and only the canceled-at
      // stamp when the provider scheduled rather than terminated — the
      // capacity the customer paid for is not taken early.
      "routes/billing.routes.ts":
        "canonical: direct add-on cancellation, recording only what the provider confirmed",
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
  // BILLING RECONCILIATION (2026-08-27) — the scheduled sweep names the three
  // repairable statuses when SELECTING which stored bindings to offer to the
  // reconciliation authority. It makes no active/grace decision: it decides
  // only which rows are worth asking a provider about.
  "jobs/billing-reconciliation.job.ts":
    "SELECTION: chooses repairable bindings to reconcile — no lifecycle decision",
  // BILLING RECONCILIATION (2026-08-27) — these two READ the enum to map a
  // provider observation onto the canonical status. Neither decides whether a
  // subscription is active or in grace: that stays
  // `commercial-context.service.ts`, and both hand the resulting status to
  // `syncPlanForSubscription` rather than acting on it themselves.
  "services/billing/reconciliation/reconciliation.service.ts":
    "MAPPING: provider observation -> canonical SubscriptionStatus, applied through the shared handler",
  "services/billing/subscription-lifecycle.handlers.ts":
    "CANONICAL: the shared lifecycle handler the webhook and reconciliation both call",
  "routes/webhooks.routes.ts": "PROVIDER PROJECTION: normalizes Stripe/PayPal event strings → SubscriptionStatus + write routing (no capability decision)",
  "services/billing.service.ts": "PERSISTENCE: upsertSubscription status write",
  "routes/billing.routes.ts": "display subscription query filter + user cancel-at-period-end write",
  "routes/teams.routes.ts": "display: team subscription lookup query filter (no active/grace decision)",
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — both new entries are
  // PRESENTATION and PROVIDER-INTERACTION, not a second active/grace decision.
  // The projection maps a status to a lifecycle LABEL for the UI (and defers to
  // `commercial-context`'s verdict for the grace question); the cancellation
  // service compares against the terminal status to stay idempotent and never
  // decides whether a subject is entitled to anything.
  "services/billing/billing-account-projection.service.ts":
    "DISPLAY: maps provider status → a lifecycle LABEL (grace verdict still comes from commercial-context)",
  "services/billing/subscription-cancellation.service.ts":
    "PROVIDER INTERACTION: idempotency check against the terminal status; no capability decision",
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
