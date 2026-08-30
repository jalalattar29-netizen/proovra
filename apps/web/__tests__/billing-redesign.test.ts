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
/**
 * BILLING SURFACE CORRECTION (2026-08-29) — the MANAGE drawer is part of the
 * surface.
 *
 * A subscription that already exists is managed in one place now, so the moves
 * the server lists and the cancellation that ends them moved off the card and
 * into this file. The contracts follow them.
 */
const MANAGE = "../app/(app)/billing/_sections/ManagePlanDrawer.tsx";
/**
 * BILLING REDESIGN (2026-08-30) — the plan card, the usage row and the
 * collaboration card became ONE overview panel plus two compact panels beside
 * it. What they said moved with them; the contracts follow.
 */
const OVERVIEW = "../app/(app)/billing/_sections/BillingOverview.tsx";
/**
 * BILLING UI REFINEMENT (2026-09-01) — the payment-method selector is its own
 * authority now, so the contracts about it point at the one file that owns it
 * rather than at whichever drawer happened to declare the rows.
 */
const PAYMENT_CHOICE = "../app/(app)/billing/_sections/PaymentMethodChoice.tsx";
const PRICING = "../app/pricing/page.tsx";

/**
 * BILLING SURFACE CORRECTION (2026-08-29) — the route's own stylesheet is part
 * of the surface.
 *
 * The layout invariants below (auto-fit grids, wrapping that never clips
 * customer copy) used to be inline styles and are now `bill-*` rules in
 * `billing.css`, alongside the canonical `app-*` primitives the route
 * consumes. The INVARIANT did not move; only the file it lives in did, so the
 * scan follows it rather than being relaxed.
 */
const BILLING_CSS = "../app/(app)/billing/billing.css";

const billingSources = () =>
  [
    PAGE,
    PLAN_USAGE,
    STORAGE_HISTORY,
    CHECKOUT,
    SELECTOR,
    DRAWER,
    FORMAT,
    MANAGE,
    OVERVIEW,
    PAYMENT_CHOICE,
  ]
    .map(read)
    .concat(readRaw(BILLING_CSS))
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

test("collaboration teams and members are separate facts, and no workspace meter remains", () => {
  /*
   * BILLING REDESIGN (2026-08-30) — these were two progress meters in a
   * page-wide card that existed to carry "0 of 2". A value that size is a
   * fact, not a meter, so they are rows in the capabilities panel — and the
   * property that mattered is unchanged: teams and members are counted
   * separately, and no meter counts WORKSPACES at all.
   */
  const src = read(OVERVIEW);
  assert.match(src, /Collaboration teams/);
  assert.match(src, /collaborationTeams/);
  assert.match(src, /Members/);
  assert.match(src, /seats/);

  // The retired model, which billed a workspace as its own subject.
  const all = billingSources();
  assert.doesNotMatch(all, /Team Workspace/);
  assert.doesNotMatch(all, /workspaces\s+used/i);
  assert.doesNotMatch(all, /ownedWorkspaces/);

  // And it is said in words, so nobody re-derives the retired model from a
  // number that looks like a workspace count.
  assert.match(src, /They are not separately\s*\n?\s*billed workspaces/);
});

test("pending invitations are named separately from accepted members", () => {
  // An invitation is not a member: counting them together tells an owner they
  // have seats filled that nobody has accepted.
  const src = read(OVERVIEW);
  assert.match(src, /Pending invites/);
  assert.match(src, /pendingInvites/);
  assert.match(src, /accepted/);
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
    // `canStartCheckout` no longer gates a button: the ONE action the card
    // renders is `planManagement`, and whether a checkout may be started is
    // folded into whether that action is enabled and which mode it opens. It
    // remains a projected fact, asserted where it lives.
    "canRequestCancellation",
    "canBuyEvidenceCredits",
    "contactAccountManager",
    // BILLING REDESIGN (2026-08-30) — and HOW the account holds this tier,
    // which decides whether a price, a cadence and a cancellation may be shown
    // at all. A granted entitlement is real access with no billing
    // relationship; the page said "Billed monthly · $19.00" to both.
    "planManagement",
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

  /*
   * BILLING SURFACE CORRECTION (2026-08-29) — ONE action on the card, and the
   * SERVER names it.
   *
   * The card used to render a button per offer, which is how a FREE account
   * came to face "Subscribe to Pro" and "Subscribe to Team" side by side —
   * both opening the same drawer — and how a PRO account was invited to
   * "Subscribe to Team" for what is an upgrade of the subscription it has.
   * `actions.planManagement` is that one decision; the OFFERS and their verbs
   * still exist and are rendered, inside the drawer the button opens.
   */
  assert.match(src, /actions\.planManagement\.label/);
  assert.match(src, /actions\.planManagement\.mode/);
  assert.match(src, /offer\.actionLabel/);
  assert.match(src, /offer\.effectSummary/);
  // The scheduled change is a server fact too, not a date the page works out.
  assert.match(src, /plan\.scheduledChange/);

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

test("a renewal date is rendered only for a REAL subscription", () => {
  /*
   * Tightened by the redesign. It used to be enough that the date was gated on
   * the monthly MODEL — but the model itself fell back to the catalogue price
   * whenever a paid tier had no subscription row, so a granted entitlement got
   * a renewal date for a renewal that will never happen. The gate is now
   * `accessKind === "SUBSCRIPTION"`, which is a fact about a subscription row
   * rather than about a price list.
   */
  const src = read(OVERVIEW);
  assert.match(src, /accessKind === "SUBSCRIPTION"/);
  assert.match(src, /Renews on/);
  assert.match(src, /Cancels on/);

  // And a granted tier says what it is instead.
  assert.match(src, /Granted access — no active billing subscription/);
});

test("the cancel confirmation describes what the provider will actually do", () => {
  const src = read(PAGE);
  // The dialog this replaces promised "ends at the current period" while the
  // route called Stripe's immediate DELETE.
  assert.match(src, /ask your payment provider to stop renewing/);
  // The exact date is CONFIRMED after the provider answers, never asserted
  // before. Stripe cancels at period end and PayPal cancels immediately, and
  // which one this account gets is not knowable until it replies.
  assert.match(src, /confirm the exact date after they answer/);
});

test("the cancel confirmation states the whole consequence, not just the plan", () => {
  const src = read(PAGE);

  // BILLING SURFACE CORRECTION (2026-08-29). Cancelling also cancels the
  // RECURRING STORAGE ADD-ONS bound to the subscription
  // (`cancelDependentRecurringAddons`, in the same transaction). A customer not
  // told that finds out when the capacity goes.
  assert.match(src, /recurring storage add-on/);
  assert.match(src, /no recurring storage add-ons, so nothing else is cancelled/);

  // And the fear this dialog actually raises: does the evidence survive.
  assert.match(src, /Your evidence is not deleted/);
  assert.match(
    src,
    /custody history, hashes,\s*\n?\s*\/\/?\s*signatures and verification packages|custody history, hashes,[\s\S]{0,40}signatures and verification packages/,
  );

  // Where it ends up. FREE on the same Personal Workspace — never a deleted
  // account, and never a workspace that goes away.
  assert.match(src, /Your account moves to Free/);
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
  // Customer copy wraps rather than truncating. A clipped renewal date or a
  // clipped "you keep access until" is a billing statement nobody can read.
  assert.match(src, /overflow-wrap: anywhere|overflowWrap: "anywhere"/);
  // And the one wide thing on the page scrolls inside its own surface.
  assert.match(src, /app-table-surface--scroll/);
});

test("billing.css clips no customer copy and reuses the shared table", () => {
  // Comments are prose, not rules: this file explains WHY it clips nothing,
  // and that explanation must not itself trip the scan.
  const css = stripComments(readRaw(BILLING_CSS));

  // `overflow: hidden` appears exactly once, on the meter TRACK, which holds a
  // coloured bar and no words.
  const clips = css.match(/overflow:\s*hidden/g) ?? [];
  assert.equal(clips.length, 1, "billing.css must clip nothing but the meter track");
  assert.match(css, /\.bill-metric__track \{[^}]*overflow: hidden/);

  // No line clamping anywhere: a clamped billing sentence is an unreadable one.
  assert.doesNotMatch(css, /line-clamp/);

  // Every touch target reaches 44px.
  assert.match(css, /min-block-size: 44px/);

  // Logical properties, so the page mirrors in Arabic without a second sheet.
  assert.doesNotMatch(css, /\bmargin-left:|\bmargin-right:|\bpadding-left:|\bpadding-right:/);
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

test("Pricing says the tiers apply to the ONE Personal Workspace", () => {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — REPLACES a test that
  // required the page to say "additional workspaces need their own Team plan".
  //
  // That sentence was true of the old model and it was the clearest statement
  // of it anywhere in the product: it told a customer that TEAM was somewhere
  // else they would have to go, and — read carefully — that their evidence
  // would not be coming with them. The test correctly pinned the copy; the
  // copy was describing the thing being corrected.
  const src = read(PRICING);
  assert.doesNotMatch(src, /additional workspaces need their own Team plan/);
  assert.doesNotMatch(src, /Personal \+ owned workspaces/);
  assert.doesNotMatch(src, /Owned team workspaces/);
  assert.match(src, /Team upgrades the same one/);
  assert.match(src, /Your Personal Workspace/);
  // ENTERPRISE keeps the only Organization language on the page.
  assert.match(src, /Enterprise Organization/);
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

test("Pricing advertises the Collaboration Team cap and no workspace cap", () => {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the comparison table
  // published "Up to 2" and "Up to 5" additional workspaces on PRO and TEAM.
  // That row was the page saying in plain words that a higher tier buys more
  // workspaces; it buys higher allowances on the ONE Personal Workspace.
  const src = read(PRICING);
  assert.doesNotMatch(src, /label: "Owned workspaces"/);
  assert.doesNotMatch(src, /maxOwnedWorkspaces/);
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
  // A WORD boundary, not a substring. The bare pattern also matched inside
  // "ACTIVATED" — the enterprise contract activation state — so a value the
  // server sends would have failed a test about tax claims the product does
  // not make.
  // A WORD boundary, not a substring. The bare pattern also matched inside
  // "ACTIVATED" — the enterprise contract activation state — so a value the
  // server sends would have failed a test about tax claims the product does
  // not make.
  assert.doesNotMatch(billing, /\bVAT\b/);
});

test("Pricing renders no fabricated fallback for a served commercial value", () => {
  const src = read(PRICING);
  // COMM-002's rule, still holding: a value the server has not sent renders the
  // bounded placeholder, never an invented literal.
  assert.match(src, /const CATALOG_VALUE_UNAVAILABLE = "—"/);
  assert.match(src, /function catalogValue/);
});

// ===========================================================================
// 6. The final PERSONAL/ORGANIZATION model on the page
// ===========================================================================

test("no workspace is a billing subject anywhere in the Billing UI", () => {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28). There were three
  // subjects and the middle one never paid for anything: the server
  // enumerated one billing account per Owned Workspace, each with its own
  // plan card, checkout target, payment history and storage catalogue.
  const src = billingSources();
  assert.doesNotMatch(src, /"WORKSPACE"/);
  assert.doesNotMatch(src, /kind: "team"/);
  // And the DTO the page reads from carries only the two real ones.
  const dto = read("../lib/api/billing-accounts.ts");
  assert.match(dto, /BillingAccountType = "PERSONAL" \| "ORGANIZATION"/);
});

test("a plan move states its own verb, its own effect, and comes from the server", () => {
  /*
   * The moves live in the MANAGE drawer now. The card carries one button,
   * because a card that renders a button per offer is what produced
   * "Subscribe to Pro" beside "Subscribe to Team" on a FREE account and
   * "Subscribe to Team" in front of a PRO one. What the moves say, and who
   * decides it, is unchanged.
   */
  const src = read(MANAGE);
  assert.match(src, /planOffers \?\? \[\]/);
  assert.match(src, /offer\.actionLabel/);
  assert.match(src, /offer\.effectSummary/);
  assert.match(src, /data-billing-manage-offer-action=\{offer\.action\}/);
  /*
   * BILLING PLAN-SELECTION CORRECTION (2026-08-31) — this asserted
   * `offer.action === "DOWNGRADE" ? "secondary" : "primary"`, which ranked the
   * customer's choice: moving DOWN got a quieter button than moving up.
   *
   * Both are plan actions and both now carry the drawer's near-black
   * treatment. What is still true — and is the thing that assertion was really
   * protecting — is that a downgrade is not dressed as a destructive action.
   * It destroys nothing, and the red belongs to cancellation alone.
   */
  assert.match(src, /className="bill-plan-action"/);
  assert.doesNotMatch(src, /variant="destructive"/);
  // Neither the card nor the drawer decides the direction itself.
  assert.doesNotMatch(src, /=== "TEAM" \?/);
  assert.doesNotMatch(read(PLAN_USAGE), /=== "TEAM" \?/);
});

test("cancellation is reachable from the plan card in one step", () => {
  /*
   * THE defect. A PRO or TEAM owner could not find how to stop paying: the
   * card offered "Change plan" and the cancellation sat beside two "Subscribe"
   * buttons as though it were a fourth way to buy something. Everything a
   * subscription can have done to it — including ending it — is now behind the
   * ONE button the card renders.
   */
  const card = read(OVERVIEW);
  const manage = read(MANAGE);

  assert.match(card, /data-billing-plan-management/);
  assert.match(manage, /data-billing-manage-cancel/);
  assert.match(manage, /Cancel subscription/);

  // What the customer is told before they commit, in the drawer itself.
  //
  // The sentence this replaces — "Your account moves to Free on the same
  // workspace. Your evidence, custody history and verification packages are
  // not deleted." — named an internal object ("the same workspace") and
  // promised a permanence no retention policy can guarantee unconditionally.
  // The replacement says the same reassurance in the customer's terms and
  // subject to the rules that actually govern it.
  assert.match(manage, /Your plan will move to Free/);
  assert.match(
    manage,
    /evidence and custody records remain available\s*\n?\s*under the applicable retention and access rules/,
  );
  // And the heading is the verb the button uses, not a third word for it.
  assert.doesNotMatch(manage, /End subscription/);

  // A refusal is EXPLAINED rather than rendered as an absence: a viewer who
  // may not cancel and a payer whose subscription we cannot find are different
  // problems, and showing nothing for both is what made a missing subscription
  // look like a product with no way out.
  assert.match(manage, /cancellationUnavailableReason/);
  assert.match(manage, /NO_SUBSCRIPTION_BOUND/);
});

test("FREE never reaches the paid plan-transition route", () => {
  /*
   * THE ROOT DEFECT THIS CLOSES.
   *
   * A FREE account with a stale non-terminal Subscription row was projected as
   * a SUBSCRIPTION, so the page opened the MANAGER, both tiers came back as
   * "upgrades", and pressing one called `/v1/billing/subscription/plan` — which
   * compared the request against the ROW's plan and scheduled a period-end
   * move. The customer was told "You will move to Pro at the end of this
   * billing period" without ever being shown a payment method.
   *
   * The fix is at BOTH authorities, and both are asserted here, because a fix
   * in only one of them is a fix a stale tab can walk around.
   */
  const projection = readRaw(
    "../../../services/api/src/services/billing/billing-account-projection.service.ts",
  );
  const transition = readRaw(
    "../../../services/api/src/services/billing/plan-transition.service.ts",
  );

  // 1. The PROJECTION: a row is necessary and not sufficient.
  assert.match(projection, /const subscriptionRowLive = Boolean\(/);
  assert.match(
    projection,
    /const liveSubscription = subscriptionRowLive && entitledToPaidTier;/,
  );
  assert.match(projection, /scope\.plan !== prismaPkg\.PlanType\.FREE/);
  // The offer verbs read the SAME fact the mode does, never a second copy.
  assert.match(projection, /hasLiveSubscription: liveSubscription/);
  // The disagreement is counted rather than silently repaired on a read path.
  assert.match(projection, /billing_subscription_entitlement_mismatch_total/);

  // 2. The TRANSITION resolver: FREE resolves to a purchase, whatever rows
  //    survive beside it.
  assert.match(transition, /resolveCommercialContext/);
  assert.match(
    transition,
    /entitled\.scope\.plan === prismaPkg\.PlanType\.FREE/,
  );
  assert.match(transition, /kind: "NEW_SUBSCRIPTION"/);
});

test("the FREE chooser is a purchase, and says nothing a subscription would", () => {
  const drawer = read(CHECKOUT);

  // A payment method is chosen BEFORE anything is committed, through the ONE
  // shared selector rather than rows written into this drawer.
  assert.match(drawer, /<PaymentMethodChoice/);
  assert.doesNotMatch(drawer, /data-billing-provider-option/);
  // The CTA names the PLAN — the thing that could be wrong.
  assert.match(drawer, /Continue with \$\{selectedPlanOffer\.displayName\}/);
  // The plan checkout authority, never the plan-change route.
  assert.match(drawer, /"\/v1\/billing\/checkout\/stripe"/);
  assert.match(drawer, /"\/v1\/billing\/checkout\/paypal"/);
  assert.doesNotMatch(drawer, /\/v1\/billing\/subscription\/plan/);
  /*
   * BILLING UI REFINEMENT (2026-09-01) — the SUMMARY panel is gone, and this
   * asserted it was there.
   *
   * It restated the selected plan, the cadence, the total and a cancellation
   * sentence beneath the card that already showed all of it, so choosing a
   * tier grew the drawer by a block that said nothing new. The recurring-charge
   * statement that mattered survives, said once for the section.
   */
  assert.doesNotMatch(drawer, /data-billing-plan-summary/);
  assert.match(drawer, /data-billing-plan-terms/);
  assert.match(drawer, /billed monthly/);

  // None of the words that belong to a subscription somebody already has.
  for (const forbidden of [
    /end of this billing period/i,
    /charges the difference/i,
    /prorat/i,
    /End subscription/,
  ]) {
    assert.doesNotMatch(drawer, forbidden);
  }
});

test("the Billing page renders exactly one level-1 heading", () => {
  /*
   * THE HYDRATION DEFECT.
   *
   * `PageHeader` renders its own <h1> around whatever `title` is given — its
   * own contract says "header renders a single <h1>". Billing passed an <h1>,
   * producing <h1><h1>Billing</h1></h1>: invalid heading structure, a React
   * hydration error logged on every load, and two level-1 headings for anyone
   * navigating by heading.
   *
   * Fixed at the CONSUMER, not by relaxing the shell — the shell is right that
   * a page has one <h1>, and other pages depend on that.
   */
  const page = read(PAGE);

  // The title is a SPAN handed to the header, never a heading of its own.
  assert.match(page, /<span className="cc-title" data-billing-title>/);
  assert.doesNotMatch(page, /<h1[\s>]/);

  // And the shell it hands it to still owns the one <h1>.
  const shell = read("../components/ui/PageShell.tsx");
  const h1s = shell.match(/<h1[\s>]/g) ?? [];
  assert.equal(h1s.length, 1, "PageShell must render exactly one <h1>");
});

test("ONE payment-method selector serves every Billing purchase", () => {
  /*
   * The card/PayPal rows were written inline in the checkout drawer, so every
   * other Billing purchase inherited whatever that drawer happened to do —
   * and improving them anywhere would have meant improving them three times.
   */
  const selector = read(PAYMENT_CHOICE);
  const drawer = read(CHECKOUT);

  // The selector owns the options, the marks and the accessible names.
  assert.match(selector, /data-billing-provider-option/);
  assert.match(selector, /"STRIPE"/);
  assert.match(selector, /"PAYPAL"/);
  assert.match(selector, /Credit or debit card/);

  // The drawer CONSUMES it and declares none of that itself. All three intents
  // — plan, credits, storage — go through this one drawer, so one usage here
  // is one selector for all of them.
  assert.match(drawer, /<PaymentMethodChoice/);
  assert.doesNotMatch(drawer, /data-billing-provider-option/);
  assert.doesNotMatch(drawer, /name="provider"/);

  // And no OTHER Billing surface has grown its own copy.
  const others = [PAGE, OVERVIEW, STORAGE_HISTORY, MANAGE, PLAN_USAGE].map(read).join("\n");
  assert.doesNotMatch(others, /data-billing-provider-option/);
  assert.doesNotMatch(others, /FaCcVisa|FaCcMastercard|FaCcPaypal/);
});

test("the payment marks are local, decorative, and not the accessible name", () => {
  const selector = read(PAYMENT_CHOICE);

  // Bundled with the app, not fetched at runtime and not hotlinked.
  assert.match(selector, /from "react-icons\/fa"/);
  assert.doesNotMatch(selector, /https?:\/\//);
  // Every mark is hidden from assistive technology...
  const marks = selector.match(/<FaCc\w+/g) ?? [];
  assert.equal(marks.length, 3, "visa, mastercard and paypal");
  assert.equal((selector.match(/aria-hidden/g) ?? []).length, 3);
  // ...and each option carries a real name instead.
  assert.match(selector, /app-visually-hidden/);
  assert.match(selector, /label: "PayPal"/);
  // The card option is never named after two networks — that would claim a
  // coverage this surface has no authority to promise.
  assert.doesNotMatch(selector, /label: "Visa/);
});

test("Evidence and Storage share a row, and history spans beneath them", () => {
  const page = read(PAGE);

  // The two allowance cards are siblings in the allowances row...
  const row = page.slice(
    page.indexOf('data-billing-row="allowances"'),
    page.indexOf('data-billing-row="details"'),
  );
  assert.ok(row.length > 0, "the allowances row must exist");
  assert.match(row, /<EvidenceDetailCard/);
  assert.match(row, /<StorageAddonsSection/);

  // ...and history is OUTSIDE it, at the page's own width.
  assert.doesNotMatch(row, /<BillingHistorySection/);
  assert.match(page, /<BillingHistorySection/);

  // The two-standing-columns grid is gone, not merely unused.
  assert.doesNotMatch(page, /bill-grid__column/);
  const css = readRaw(BILLING_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /\.bill-grid/);
  assert.match(css, /\.bill-row \{/);
  // Equal columns: an unequal pair read as a main card and an afterthought.
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("the plan status is words, and the Billing-only capsule is deleted", () => {
  const overview = read(OVERVIEW);
  const css = readRaw(BILLING_CSS).replace(/\/\*[\s\S]*?\*\//g, "");

  // The canonical no-capsule primitive, reused rather than restyled locally.
  assert.match(overview, /<AppStatusText/);
  assert.match(overview, /data-billing-plan-status/);
  // The capsule and its three Billing-only colour literals are gone.
  assert.doesNotMatch(css, /\.bill-overview__status\[/);
  assert.doesNotMatch(css, /border-radius: 999px;[\s\S]{0,120}#15803d/);
  assert.doesNotMatch(overview, /className="bill-overview__status"/);
});

test("the Billing secondary action is scoped, and skips the actions it must not touch", () => {
  const css = readRaw(BILLING_CSS).replace(/\/\*[\s\S]*?\*\//g, "");

  const rules = css
    .split("\n")
    .filter((l) => l.includes("bill-secondary-action") && l.includes("{"));
  assert.ok(rules.length > 0, "the variant must exist");
  for (const rule of rules) {
    assert.match(
      rule,
      /\.bill-page |\.bill-panel |\.bill-overview /,
      `unscoped rule: ${rule.trim()}`,
    );
  }
  // Nothing global.
  assert.doesNotMatch(css, /\.app-primary-action/);

  // The actions that MUST NOT take it.
  const drawer = read(MANAGE);
  const cancelBlock = drawer.slice(drawer.indexOf("data-billing-manage-cancel") - 600);
  assert.doesNotMatch(cancelBlock, /bill-secondary-action/);
  const storage = read(STORAGE_HISTORY);
  const abandon = storage.slice(
    storage.indexOf("data-billing-payment-abandon") - 400,
    storage.indexOf("data-billing-payment-abandon") + 200,
  );
  assert.doesNotMatch(abandon, /bill-secondary-action/);
  // And the checkout CTA stays black.
  assert.match(read(CHECKOUT), /className="bill-plan-action"/);
  assert.doesNotMatch(read(CHECKOUT), /bill-secondary-action/);
});

test("the support strip is visible, actionable, and cannot take the session", () => {
  const page = read(PAGE);
  const css = readRaw(BILLING_CSS).replace(/\/\*[\s\S]*?\*\//g, "");

  // It reads as a way out rather than grey text on a grey surface.
  assert.match(css, /\.bill-support-strip \{[^}]*--accent-050/);
  assert.match(page, /bill-support-strip__icon/);
  assert.match(page, /bill-support-strip__action ui-button bill-secondary-action/);
  // The vague reassurance about money is gone.
  assert.doesNotMatch(page, /Your billing records are the ones we act on/);

  // Still a strip, not another full-width card.
  assert.doesNotMatch(css, /\.bill-support-strip \{[^}]*display: grid/);
});

test("a GRANTED tier keeps the truth and gains a real purchase", () => {
  /*
   * A manually granted tier has no provider subscription, so it must not show
   * cancellation or a prorated transition — and it must not be a dead end
   * either. The way out is a NEW checkout, decided by the SERVER.
   */
  const projection = readRaw(
    "../../../services/api/src/services/billing/billing-account-projection.service.ts",
  );
  const overview = read(OVERVIEW);
  const page = read(PAGE);

  // The server composes it, from the same ladder the offers use.
  assert.match(projection, /secondaryPlanAction/);
  assert.match(projection, /kind: "START_SUBSCRIPTION" as const/);
  assert.match(projection, /function grantedUpgradeTarget/);
  assert.match(projection, /accessKind === "GRANTED" && canManage/);

  // The page renders it and derives nothing.
  assert.match(overview, /actions\.secondaryPlanAction/);
  assert.match(overview, /data-billing-start-subscription/);
  assert.doesNotMatch(overview, /=== "GRANTED" \? "TEAM"/);

  // It opens a CHECKOUT, never the plan-transition route.
  assert.match(page, /onStartSubscription=\{\(planKey\) =>\s*\n?\s*setCheckout\(\{ kind: "PLAN", planKey \}\)/);
});

test("the plan-drawer button hierarchy cannot reach a button outside it", () => {
  /*
   * The near-black plan action and the outlined-red cancellation are a
   * property of THIS decision surface. Written as a global variant they would
   * have repainted "New Case", every Evidence action and the auth CTAs; every
   * rule is therefore a descendant of `.bill-drawer`, which is the panel class
   * on the Billing drawer's own dialog.
   */
  const css = readRaw(BILLING_CSS);
  const declared = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const rules = declared
    .split("\n")
    .filter((l) => /bill-plan-action|bill-cancel-action/.test(l) && l.includes("{"));
  assert.ok(rules.length > 0, "the drawer variants must exist");
  for (const rule of rules) {
    assert.match(rule, /\.bill-drawer\s/, `unscoped rule: ${rule.trim()}`);
  }

  // Nothing global is touched by this file.
  assert.doesNotMatch(declared, /\.app-primary-action/);
  assert.doesNotMatch(declared, /^\s*\.ui-button/m);

  // The scope class is actually on the panel, or every rule above is inert.
  assert.match(read(DRAWER), /className="bill-drawer"/);
});

test("Evidence is ONE card with one purchase entry point", () => {
  const page = read(PAGE);
  const overview = read(OVERVIEW);

  // The duplicate card is DELETED, not hidden.
  assert.doesNotMatch(page, /data-billing-credits\b/);
  assert.doesNotMatch(page, /Evidence credits/);
  assert.doesNotMatch(page, /Credits do not expire/);
  assert.doesNotMatch(page, /Record more evidence without changing your plan/);

  // And its content lives in the card that remains.
  assert.match(overview, /data-billing-credit-balance/);
  assert.match(overview, /data-billing-buy-credits/);
  assert.match(overview, /Buy credits/);

  // ONE purchase button in the whole Evidence section: the page must not carry
  // a second one beside the card's.
  const pageBuys = page.match(/data-billing-buy-credits/g) ?? [];
  assert.equal(pageBuys.length, 0, "the purchase belongs to the Evidence card alone");
});

test("FREE storage says a plan is what the button opens", () => {
  const storage = read(STORAGE_HISTORY);

  assert.match(storage, /data-billing-storage-upgrade/);
  assert.match(storage, /View plans/);
  // It calls the CHOOSER, never the capacity catalogue FREE cannot buy from.
  assert.match(storage, /onClick=\{onChoosePlan\}/);
  // The words that would describe a destination this button does not have.
  const locked = storage.slice(0, storage.indexOf("const addons = projection.storageAddons"));
  assert.doesNotMatch(locked, /Add storage/);
  assert.doesNotMatch(locked, /Manage storage/);

  // And the server, not the page, composes the reason.
  const projection = readRaw(
    "../../../services/api/src/services/billing/billing-account-projection.service.ts",
  );
  assert.match(projection, /Additional storage is available with Pro and Team\./);
});

test("a scheduled downgrade is stated before the plan can be misread", () => {
  // On the OVERVIEW, so it is read before the one action is pressed…
  const card = read(OVERVIEW);
  assert.match(card, /data-billing-scheduled-change/);
  assert.match(card, /plan\.scheduledChange/);
  assert.match(card, /You keep everything you have now until then/);

  // …and again in the DRAWER, above the moves, because it changes what every
  // one of them means. No second move may be queued while one is outstanding.
  const manage = read(MANAGE);
  assert.match(manage, /data-billing-manage-scheduled/);
  assert.match(manage, /!plan\.scheduledChange/);
});

test("changing plan is a different act from starting a checkout", () => {
  const page = read(PAGE);
  // Collapsing them is how a PRO customer wanting TEAM ended up paying twice.
  assert.match(page, /changePlan\(\{ plan: offer\.planKey \}\)/);
  assert.match(page, /onChangePlan=/);
  // The confirmation text is the SERVER's, not a sentence assembled here.
  assert.match(page, /description: offer\.effectSummary/);
  // A PayPal approval link means the buyer has not agreed yet.
  assert.match(page, /result\.approvalUrl/);
});

test("cancellation names no subject the client could get wrong", () => {
  const page = read(PAGE);
  const dto = read("../lib/api/billing-accounts.ts");
  assert.match(page, /requestCancellation\(\)/);
  assert.match(dto, /requestCancellation\(\): Promise<CancellationResult>/);
  assert.doesNotMatch(dto, /teamId: input\.teamId/);
});

test("Pricing opens in a NEW TAB, safely", () => {
  const page = read(PAGE);
  // It is a reference read WHILE deciding. In the same tab it replaced the
  // page, losing usage, renewal date and any half-finished checkout.
  assert.match(page, /target="_blank"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /data-billing-view-pricing/);
});

test("the help link goes somewhere that can actually help", () => {
  const page = read(PAGE);
  // It pointed at the PRIVACY section of Settings, which has nothing to say
  // about billing and no way to reach a person.
  assert.doesNotMatch(page, /settings#privacy/);
  assert.match(page, /"\/support"/);
});

test("the advertised abandon action is executable in the case it exists for", () => {
  /*
   * THE CONTRADICTION THIS CLOSES.
   *
   * The projection said `canAbandon: true`, the row offered "Abandon payment
   * attempt", and the endpoint answered 503 whenever the provider could not be
   * reached — which is the ONE case the action exists for. An advertised
   * action that cannot complete in its own use case is worse than no action,
   * because the customer keeps pressing it.
   *
   * The page now asks the server FIRST, and only shows the confirmation when
   * the server itself says one is required. The decision is the server's; the
   * page renders it.
   */
  const page = read(PAGE);

  // The machine-readable outcome, not a sentence the browser has to parse.
  assert.match(page, /ABANDON_CONFIRMATION_REQUIRED/);
  // The second request carries the customer's answer.
  assert.match(page, /abandonPayment\(selected, entry\.id, \{\s*\n?\s*confirmed: true,?\s*\n?\s*\}\)/);
  // The confirmation is the mandate's exact question and options.
  assert.match(page, /Abandon this payment attempt\?/);
  assert.match(page, /confirmLabel: "Abandon local attempt"/);
  assert.match(page, /cancelLabel: "Keep pending"/);
  // Warning, not destruction: nothing is deleted and no money moves.
  assert.match(page, /tone: "warning"/);
});

test("no Billing message claims what the provider did not prove", () => {
  /*
   * "Nothing has been charged" is a claim about MONEY. It is only ours to make
   * where the provider proved it, or where no charge was ever attempted — and
   * it was being said in a branch that had just admitted the provider could
   * not be reached.
   */
  const page = read(PAGE);
  const service = readRaw(
    "../../../services/api/src/services/billing/pending-payments.service.ts",
  );

  for (const [name, src] of [
    ["the page", page],
    ["the payment service", stripComments(service)],
  ] as const) {
    assert.doesNotMatch(
      src,
      /nothing has been charged/i,
      `${name} must not claim what the provider did not prove`,
    );
  }

  // What it says instead is about what PROOVRA did, which is knowable.
  assert.match(page, /unchanged in PROOVRA/);
});

test("a provider failure is told apart from an outage", () => {
  // Three of the four ways a provider call fails are not outages, and "try
  // again shortly" is the wrong advice for all three.
  const page = read(PAGE);
  for (const outcome of [
    "PROVIDER_REFERENCE_NOT_FOUND",
    "PROVIDER_REFERENCE_INVALID",
    "PROVIDER_AUTHORIZATION_FAILED",
  ]) {
    assert.match(page, new RegExp(outcome), `the page must handle ${outcome}`);
  }

  // And each says something a customer can act on.
  assert.match(page, /could not find this payment attempt/);
  assert.match(page, /cannot be matched with your payment provider automatically/);
  assert.match(page, /Our team has been notified/);
});

test("neither off-page link can take the session with it", () => {
  const raw = readRaw(PAGE);

  /*
   * BILLING SURFACE CORRECTION (2026-08-29) — the ROOT CAUSE, pinned.
   *
   * "Get help" was a same-tab client-routed <Link>. `/support` lives OUTSIDE
   * the `(app)` route group, so following it tore down the authenticated
   * shell — and the access token is held in MEMORY ONLY (lib/api.ts: "In-memory
   * only ... NEVER persist"), so that navigation destroyed the only copy of it.
   * Coming back to Billing then landed on a signed-out shell, which read as
   * "Support signs me out". Nothing about /support logs anyone out; leaving the
   * app in the same tab does.
   *
   * Both off-page destinations are therefore plain anchors that open a NEW
   * tab. This asserts the property that fixes it — a new browsing context —
   * rather than the destination, because changing the destination alone would
   * have left the session being destroyed by whatever it pointed at next.
   */
  for (const marker of ["data-billing-view-pricing", "data-billing-support-action"]) {
    const at = raw.indexOf(marker);
    assert.ok(at > 0, `${marker} is not rendered`);

    // The anchor's own attributes: search back to the tag that opens it.
    const open = raw.lastIndexOf("<a", at);
    assert.ok(open > 0, `${marker} is not on an anchor`);
    const tag = raw.slice(open, raw.indexOf(">", at) + 1);

    assert.match(tag, /target="_blank"/, `${marker} must open a new tab`);
    assert.match(
      tag,
      /rel="noopener noreferrer"/,
      `${marker} must not hand a window handle back`,
    );
  }

  // And neither is a client-routed <Link>, which would navigate in place.
  assert.doesNotMatch(raw, /<Link[^>]*data-billing-support-action/);
  assert.doesNotMatch(raw, /<Link[^>]*data-billing-view-pricing/);
});

test("being OVER an allowance is explained, not rendered as a broken sum", () => {
  const src = read(FORMAT);
  // "176 of 127" reads as a broken counter; it is a real and legitimate state.
  assert.match(src, /meter\.used > meter\.limit/);
  assert.match(src, /more than the/);
  assert.match(src, /Nothing has been removed/);

  /*
   * BILLING SURFACE CORRECTION (2026-08-29) — `describeMeter` no longer
   * attributes the enforced cap to the PLAN.
   *
   * It works from a used/limit pair and cannot tell whose limit it is. On a
   * personal lifetime allowance that number can be a grandfathered per-account
   * limit while the plan includes something else entirely, which is how a PRO
   * customer whose plan includes 100 was told "49 over the 127 your plan
   * includes".
   *
   * `describeEvidenceAdmission` MAY say it, and does, because the server sends
   * it both numbers and it only says "your plan includes" where the cap in
   * force really is the plan's own. So this is scoped to the formatter that
   * cannot know.
   */
  const describeMeterBody = src.slice(
    src.indexOf("export function describeMeter"),
    src.indexOf("export type EvidencePresentation"),
  );
  assert.ok(describeMeterBody.length > 0, "describeMeter not found");
  assert.doesNotMatch(describeMeterBody, /your plan includes/);
});

test("the credit purchase states every number a customer is agreeing to", () => {
  const src = read(CHECKOUT);

  /*
   * "3 available" directly above a Buy button was once the only quantity on
   * screen. The fix for that was two full-width boxes — "What you have now"
   * and "What you are buying" — each repeating the drawer's own explanation
   * and neither stating a total.
   *
   * It is ONE summary now, in the order a person checks a purchase: what I
   * have, what I am buying, what each costs, what it comes to, what I will
   * have afterwards.
   */
  for (const marker of [
    "data-billing-credit-balance",
    "data-billing-credit-quantity",
    "data-billing-credit-total",
    "data-billing-credit-after",
  ]) {
    assert.match(src, new RegExp(marker), `the summary must state ${marker}`);
  }
  assert.match(src, /creditsPerPurchase/);

  // The quantity is the server's; a browser-chosen one is one a browser can
  // get wrong, and the credit API grants exactly one per purchase.
  assert.doesNotMatch(src, /useState.*creditQuantity/);

  // Said once, in the summary, rather than twice in two boxes.
  assert.match(src, /One-time payment · Credits do not expire/);
  const occurrences = src.split("Credits do not expire").length - 1;
  assert.equal(occurrences, 1, "the drawer must not repeat its own explanation");
});

test("no workspace allowance meter survives on the page", () => {
  const src = billingSources();
  assert.doesNotMatch(src, /ownedWorkspaces/);
  assert.doesNotMatch(src, /maxOwnedWorkspaces/);
});

// ===========================================================================
// 7. The Organization experience
// ===========================================================================

test("an Enterprise agreement offers no self-service move it cannot honour", () => {
  // Enterprise is contracted. A checkout button that routes to Stripe would be
  // offering to replace a signed agreement with a card payment.
  const projection = read(
    "../../../services/api/src/services/billing/billing-account-projection.service.ts",
  );
  assert.match(projection, /canStartCheckout: false/);
  assert.match(projection, /contactAccountManager: true/);
  // The ONE action an Enterprise account is offered is its agreement; a
  // checkout button would be offering to replace a signed agreement with a
  // card payment.
  assert.match(projection, /mode: "VIEW_AGREEMENT"/);
  /*
   * Changing an agreement routes through the account manager. The card's ONE
   * action is the AGREEMENT — a checkout there would be offering to replace a
   * signed agreement with a card payment — and the route to a person is the
   * support strip, which switches destination on the same server verdict.
   */
  assert.match(read(PAGE), /Contact your account manager/);
  assert.match(read(PAGE), /contact-sales/);
  assert.match(read(PAGE), /actions.contactAccountManager/);
});

test("a silent agreement is never rendered as a limit of zero", () => {
  // "12 of 0 accepted members" reads as a breach and is not one: an agreement
  // is allowed to be silent about seats, and no number we could substitute
  // would be the agreement's.
  //
  // The fact moved from a page-wide meter card into the capabilities panel;
  // the property is unchanged. A null limit renders what IS known — how many
  // were accepted — rather than a denominator nobody agreed to.
  const overview = read(OVERVIEW);
  assert.match(overview, /seats\.limit === null/);
  assert.match(overview, /accepted/);

  // The Enterprise contract card still carries the agreement's own wording.
  // ONE sentence for one fact: the overview and `describeMeter` say it the
  // same way, because two phrasings for the same allowance is how a surface
  // starts contradicting itself.
  assert.match(read(OVERVIEW), /Your agreement sets this allowance/);
  assert.match(read(FORMAT), /Your agreement sets this allowance/);

  const dto = read("../lib/api/billing-accounts.ts");
  assert.match(dto, /limit: number \| null; pendingInvites/);
});

test("FREE explains why storage add-ons are absent, and offers the move", () => {
  // Found in browser verification: a FREE customer saw a full 250 MB meter,
  // no way to add capacity, and no explanation — left to guess whether the
  // feature was missing, broken, or simply not theirs.
  const storage = read(STORAGE_HISTORY);
  assert.match(storage, /data-billing-storage-locked/);
  assert.match(storage, /storageAddonsLocked/);
  assert.match(storage, /data-billing-storage-upgrade/);
  // The sentence and the tier come from the SERVER; the page renders them.
  assert.match(storage, /\{locked\.reason\}/);
  assert.match(storage, /locked\.unlockedByPlan/);
  assert.doesNotMatch(storage, /Extra storage is part of Pro and Team/);
});
