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
  assert.doesNotMatch(billing, /VAT/);
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
  // A downgrade is not dressed as a destructive action; it destroys nothing.
  assert.match(src, /offer\.action === "DOWNGRADE" \? "secondary" : "primary"/);
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
  assert.match(manage, /Your account moves to Free on the same workspace/);
  assert.match(manage, /custody history and verification packages are not deleted/);

  // A refusal is EXPLAINED rather than rendered as an absence: a viewer who
  // may not cancel and a payer whose subscription we cannot find are different
  // problems, and showing nothing for both is what made a missing subscription
  // look like a product with no way out.
  assert.match(manage, /cancellationUnavailableReason/);
  assert.match(manage, /NO_SUBSCRIPTION_BOUND/);
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
