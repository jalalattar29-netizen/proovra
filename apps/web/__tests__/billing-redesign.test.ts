/**
 * BILLING COMMERCIAL CORRECTNESS — Gate C.
 *
 * Source contracts over the redesigned Billing page and the corrected Pricing
 * page. These assert the things a render test cannot: that a legacy element is
 * GONE rather than hidden, that no client file re-derives a commercial value,
 * and that the two surfaces describe the same product.
 *
 * `node:test`, matching this package's convention (see the repo's web test
 * runner — these suites are not vitest).
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readRaw = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Strip comments before scanning.
 *
 * These assertions are about what the page RENDERS, not about what its source
 * says. Without this, a comment explaining "we removed 'Effective capability
 * view' because it was an internal resolver output" would itself fail the test
 * that forbids that string — which would leave the codebase unable to record
 * why anything was removed. Prose is not product copy.
 */
const stripComments = (src: string): string =>
  src
    .replace(new RegExp("\\/\\*[\\s\\S]*?\\*\\/", "g"), "")
    .replace(new RegExp("(^|[^:])\\/\\/.*$", "gm"), "$1");

const read = (rel: string): string => stripComments(readRaw(rel));
const exists = (rel: string): boolean =>
  existsSync(fileURLToPath(new URL(rel, import.meta.url)));

const PAGE = "../app/(app)/billing/page.tsx";
const PLAN_USAGE = "../app/(app)/billing/_sections/PlanAndUsage.tsx";
const STORAGE_HISTORY = "../app/(app)/billing/_sections/StorageAndHistory.tsx";
const CHECKOUT = "../app/(app)/billing/_sections/CheckoutDrawer.tsx";
const SELECTOR = "../app/(app)/billing/_sections/AccountSelector.tsx";
const DRAWER = "../app/(app)/billing/_sections/BillingDrawer.tsx";
const FORMAT = "../app/(app)/billing/_sections/format.ts";
const PRICING = "../app/pricing/page.tsx";

const billingSources = () =>
  [PAGE, PLAN_USAGE, STORAGE_HISTORY, CHECKOUT, SELECTOR, DRAWER, FORMAT]
    .map(read)
    .join("\n");

// ===========================================================================
// 1. The legacy Billing UI is DELETED, not hidden
// ===========================================================================

test("the legacy Billing components no longer exist on disk", () => {
  // Deleted, per file, with its replacement:
  //   CheckoutPanel        -> _sections/CheckoutDrawer.tsx (a drawer, on intent)
  //   PersonalWorkspaceCard-> _sections/PlanAndUsage.tsx (one account at a time)
  //   TeamWorkspaceCard    -> _sections/PlanAndUsage.tsx
  //   StorageAddonsPanel   -> _sections/StorageAndHistory.tsx
  //   BillingHistoryCard   -> _sections/StorageAndHistory.tsx
  //   _sections/PaymentsSection.tsx -> _sections/StorageAndHistory.tsx
  for (const gone of [
    "../components/billing/CheckoutPanel.tsx",
    "../components/billing/PersonalWorkspaceCard.tsx",
    "../components/billing/TeamWorkspaceCard.tsx",
    "../components/billing/StorageAddonsPanel.tsx",
    "../components/billing/BillingHistoryCard.tsx",
    "../app/(app)/billing/_sections/PaymentsSection.tsx",
  ]) {
    assert.equal(exists(gone), false, `${gone} must be deleted, not hidden`);
  }
});

test("no Billing source imports a deleted component", () => {
  const src = billingSources();
  for (const name of [
    "CheckoutPanel",
    "PersonalWorkspaceCard",
    "TeamWorkspaceCard",
    "StorageAddonsPanel",
    "BillingHistoryCard",
    "PaymentsSection",
  ]) {
    assert.doesNotMatch(src, new RegExp(`\\b${name}\\b`), `${name} still referenced`);
  }
});

test("the removed legacy fields do not appear anywhere on the page", () => {
  const src = billingSources();
  const banned: Array<[RegExp, string]> = [
    [/Effective capability view/, "internal resolver output as customer copy"],
    [/Workspace plan view/, "internal resolver output as customer copy"],
    [/Billing ownership:/, "a nullable FK rendered as prose"],
    [/Near limit:/, "a boolean the customer cannot act on"],
    [/Limit reached:/, "a boolean the customer cannot act on"],
    [/Extra add-on bytes/, "raw byte count duplicating the storage meter"],
    [/Checkout Console/, "the always-expanded checkout panel"],
    [/Jump to plan checkout/, "duplicate navigation between billing panels"],
    [/Most popular/, "a marketing badge inside a paid-account console"],
    [/\bProjects\b/, "a metric PROOVRA has no concept of"],
    [/Storage history/, "a chart with no time-series behind it"],
    [/operating under the owner's PRO entitlement/, "factually wrong since §9.4"],
  ];
  for (const [pattern, why] of banned) {
    assert.doesNotMatch(src, pattern, `${pattern} — ${why}`);
  }
});

test("no fabricated payment-method or invoice surface", () => {
  const src = billingSources();
  // PROOVRA stores no provider customer id and issues no invoices, so a card
  // brand, a last-4 or an invoice number would be invented data.
  for (const pattern of [
    /Manage payment methods/i,
    /card ending/i,
    /last4|lastFour/i,
    /\bInvoices\b/,
    /Download invoice/i,
    /VAT invoice/i,
  ]) {
    assert.doesNotMatch(src, pattern, `${pattern} has no canonical authority`);
  }
  // The section that DOES exist is named for what it is.
  assert.match(read(STORAGE_HISTORY), /Billing history/);
});

// ===========================================================================
// 2. The invalid Teams metric is gone, and the replacements are separate
// ===========================================================================

test("the invalid 'Teams — N of M' metric and its source are gone", () => {
  const src = billingSources();
  // The numerator was a Collaboration Team membership count in the ACTIVE
  // workspace; the denominator was the ACCOUNT's Owned Workspace cap.
  assert.doesNotMatch(src, /Current usage/);
  assert.doesNotMatch(src, /teamsUsed/);
  assert.doesNotMatch(src, /teamsMax/);
  assert.doesNotMatch(src, /useBillingSummary/);
});

test("owned workspaces, collaboration teams and members are three separate meters", () => {
  const src = read(PLAN_USAGE);
  assert.match(src, /Owned workspaces/);
  assert.match(src, /Collaboration teams/);
  assert.match(src, /Accepted members/);
  // Each reads its OWN server field; none is derived from another.
  assert.match(src, /c\.ownedWorkspaces/);
  assert.match(src, /c\.collaborationTeams/);
  assert.match(src, /c\.seats/);
});

test("pending invitations are named separately from accepted members", () => {
  const src = read(PLAN_USAGE);
  assert.match(src, /pendingInvites/);
  assert.match(src, /not counted here/);
});

// ===========================================================================
// 3. The page renders; it does not decide
// ===========================================================================

test("no Billing client file imports the commercial catalog", () => {
  const src = billingSources();
  // The browser must not hold a second copy of the plan table. The page this
  // replaces read a workspace-creation cap out of the platform envelope and
  // rendered it as a team-membership denominator.
  assert.doesNotMatch(src, /@proovra\/shared-billing/);
  assert.doesNotMatch(src, /PLAN_CAPABILITIES/);
  assert.doesNotMatch(src, /getPlanCapabilities/);
});

test("actions are read from the server projection, never from plan names", () => {
  const src = billingSources();
  // Every affordance on the page comes from a server-projected verdict.
  for (const action of [
    "canStartCheckout",
    "canRequestCancellation",
    "canBuyEvidenceCredits",
    "contactAccountManager",
    // Even the manage button's WORD: "Upgrade" and "Change" are different
    // claims about the account's commercial state.
    "manageLabel",
  ]) {
    assert.match(
      src,
      new RegExp("actions\\." + action),
      `the page must read actions.${action} from the projection`,
    );
  }
  // Whether ONE add-on may be cancelled is a per-row server verdict too — it
  // depends on the viewer's capability, on whether the row is a grandfathered
  // one-time purchase, and on the subscription's state.
  assert.match(src, /addon\.canCancel/);
  // And whether the banner appears at all.
  assert.match(src, /projection\.actionRequired/);

  // No `plan === "PRO"` style branching anywhere.
  assert.doesNotMatch(src, /plan\s*===\s*["'](FREE|PRO|TEAM|ENTERPRISE)["']/);
});

test("every error path goes through toSafeUserError", () => {
  const src = billingSources();
  assert.match(src, /toSafeUserError/);
  // Raw provider/internal messages reached the toast in two places in the panel
  // this replaces.
  assert.doesNotMatch(src, /err instanceof Error\s*\?\s*err\.message/);
  assert.doesNotMatch(src, /addToast\((?:err|error)\.message/);
});

// ===========================================================================
// 4. Honest meters and states
// ===========================================================================

test("a meter never substitutes zero for an unknown or excluded value", () => {
  const src = read(FORMAT);
  assert.match(src, /case "NOT_INCLUDED":/);
  assert.match(src, /case "CONTRACT_MANAGED":/);
  assert.match(src, /case "UNAVAILABLE":/);
  assert.match(src, /Not included/);
  assert.match(src, /Contract-managed/);
  assert.match(src, /Unavailable/);
});

test("evidence wording carries the plan's real measurement window", () => {
  const src = read(FORMAT);
  assert.match(src, /lifetime records/);
  assert.match(src, /records in the last 30 days/);
});

test("every lifecycle state has a distinct WORD, not just a colour", () => {
  const src = read(FORMAT);
  for (const label of [
    "Active",
    "Trial",
    "Payment failed",
    "Action required",
    "Canceling",
    "Cancelled",
    "No subscription",
  ]) {
    assert.match(src, new RegExp(`label: "${label}"`), `missing lifecycle label ${label}`);
  }
});

test("a renewal date is rendered only for a monthly subscription", () => {
  const src = read(PLAN_USAGE);
  // A credit purchase has no renewal date. The card this replaces printed a
  // "Next period" row regardless.
  assert.match(src, /renews && plan\.model === "MONTHLY"/);
});

test("the cancel confirmation describes what the provider will actually do", () => {
  const src = read(PAGE);
  // The dialog this replaces promised "ends at the current period" while the
  // route called Stripe's immediate DELETE.
  assert.match(src, /ask your payment provider to stop renewing/);
  assert.match(src, /we will tell you the exact date/);
});

// ===========================================================================
// 5. Accessibility and layout
// ===========================================================================

test("the account selector is a real listbox with keyboard support", () => {
  const src = read(SELECTOR);
  assert.match(src, /aria-haspopup="listbox"/);
  assert.match(src, /role="listbox"/);
  assert.match(src, /role="option"/);
  assert.match(src, /aria-selected=/);
  assert.match(src, /aria-activedescendant=/);
  for (const key of ["ArrowDown", "ArrowUp", "Escape", "Enter"]) {
    assert.match(src, new RegExp(`"${key}"`), `missing key handling for ${key}`);
  }
});

test("the selector hides itself when there is only one account", () => {
  assert.match(read(SELECTOR), /if \(accounts\.length < 2\) return null;/);
});

test("selection is not signalled by colour alone", () => {
  // A tick as well as a background — the state has to survive monochrome and a
  // screen reader.
  assert.match(read(SELECTOR), /✓/);
});

test("the checkout drawer traps focus, restores it, and closes on Escape", () => {
  const src = read(DRAWER);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-labelledby=/);
  assert.match(src, /restoreRef\.current\?\.focus/);
  assert.match(src, /e\.key === "Escape"/);
  assert.match(src, /e\.key !== "Tab"/);
  assert.match(src, /document\.body\.style\.overflow/);
});

test("checkout is a drawer, not an always-expanded page section", () => {
  const page = read(PAGE);
  assert.match(page, /<CheckoutDrawer/);
  assert.match(page, /open=\{checkout !== null\}/);
});

test("layout uses logical properties so RTL needs no second stylesheet", () => {
  const src = billingSources();
  assert.match(src, /insetInlineStart|borderInlineStart|marginInlineStart/);
  // No physical left/right positioning in the billing surfaces.
  assert.doesNotMatch(src, /\bleft:\s*0\b/);
  assert.doesNotMatch(src, /\bright:\s*0\b/);
});

test("money and percentages are bidi-isolated", () => {
  const src = billingSources();
  // "€19.00" must not reorder inside an Arabic sentence.
  assert.match(src, /<bdi>/);
});

test("interactive controls meet the 44px touch target", () => {
  const src = billingSources();
  assert.match(src, /minHeight: 44/);
  assert.match(src, /minWidth: 44/);
});

test("wide content is never allowed to scroll the page body", () => {
  const src = billingSources();
  // Meters and cards use auto-fit grids with a minimum column, so 390px stacks
  // rather than overflowing.
  assert.match(src, /repeat\(auto-fit, minmax\(/);
  assert.match(src, /overflowWrap: "anywhere"/);
});

// ===========================================================================
// 6. Pricing and Billing describe the same product
// ===========================================================================

test("Pricing no longer claims every plan includes reports and packages", () => {
  const src = read(PRICING);
  const block = src.slice(
    src.indexOf("const everyPlanIncludes"),
    src.indexOf("const enterpriseFeatures"),
  );
  // FREE has `reportsIncluded: false` and `verificationPackageIncluded: false`,
  // and the comparison table on the same page always said so.
  assert.doesNotMatch(block, /label: "Reports"/);
  assert.doesNotMatch(block, /label: "Verification Packages"/);
});

test("Pricing describes the implemented PAYG credit product", () => {
  const src = read(PRICING);
  assert.match(src, /One credit records one evidence item/);
  assert.match(src, /Credits never expire/);
  assert.match(src, /your account stays on Free/);
  // The unenforceable perpetual promises are gone.
  assert.doesNotMatch(src, /5 GB storage/);
  assert.doesNotMatch(src, /50 AI operations/);
});

test("Pricing states that additional workspaces do not inherit PRO", () => {
  assert.match(
    read(PRICING),
    /additional workspaces need their own Team plan/,
  );
});

test("Pricing names TEAM's rolling window and cumulative capacity", () => {
  const src = read(PRICING);
  assert.match(src, /evidence records in any 30 days/);
  assert.match(src, /cumulative storage/);
});

test("Pricing no longer sells entitlements the code refuses", () => {
  const src = read(PRICING);
  // `retentionPolicy` is false on TEAM and `denyIfTeamNotEnterprise` 402s it.
  assert.doesNotMatch(src, /"Basic retention"/);
  // No `organizationAuditLogs` equivalent exists below ENTERPRISE.
  assert.doesNotMatch(src, /"Team audit logs"/);
  assert.doesNotMatch(src, /"Limited integrations"/);
  assert.doesNotMatch(src, /"Team governance"/);
});

test("Pricing separates the Owned Workspace cap from the Collaboration Team cap", () => {
  const src = read(PRICING);
  assert.match(src, /label: "Owned workspaces"/);
  assert.match(src, /maxOwnedWorkspaces/);
  assert.match(src, /maxCollaborationTeamsPerWorkspace/);
  assert.match(src, /accepted members per Team/);
  // The overloaded fields cannot come back.
  assert.doesNotMatch(src, /maxOwnedTeams/);
  assert.doesNotMatch(src, /maxMembersPerTeam/);
});

test("Pricing states storage add-ons are monthly", () => {
  const src = read(PRICING);
  assert.match(src, /Monthly, from \+10 GB/);
  assert.match(src, /Monthly, from \+100 GB/);
});

test("neither surface claims VAT handling the product cannot perform", () => {
  const pricing = read(PRICING);
  const billing = billingSources();
  // No tax engine, no billing address, no VAT-id authority exists.
  assert.doesNotMatch(pricing, /VAT may apply/);
  assert.match(pricing, /exclude any taxes that may be handled by/);
  assert.doesNotMatch(billing, /VAT/);
});

test("Pricing renders no fabricated fallback for a served commercial value", () => {
  const src = read(PRICING);
  // COMM-002's rule, still holding: a value the server has not sent renders the
  // bounded placeholder, never an invented literal.
  assert.match(src, /const CATALOG_VALUE_UNAVAILABLE = "—"/);
  assert.match(src, /function catalogValue/);
});
