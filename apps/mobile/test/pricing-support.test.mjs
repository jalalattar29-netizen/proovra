/**
 * PLAN CATALOGUE and SUPPORT — projections for the two content surfaces that
 * converged onto existing screens.
 *
 * The claims that matter:
 *   - a CUSTOM-priced plan is never rendered as free. Enterprise is
 *     sales-provisioned, and a price of zero would read as the opposite of
 *     what it means;
 *   - nothing here restates a price, a storage allowance or a seat count. They
 *     live behind the endpoint, and a client that restated them would be a
 *     second price list;
 *   - Support names every reference document by SLUG, so no legal text is
 *     copied into the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = async (rel) => {
  const src = readFileSync(resolve(HERE, rel), "utf8").replace(/^import type .*$/m, "");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const P = await load("../src/product/pricing.ts");
const S = await load("../src/product/support.ts");

const catalogue = (over = {}) => ({
  currency: "USD",
  free: { plan: "FREE", displayName: "Free", monthlyPriceCents: 0, storageLabel: "1 GB", seats: 1 },
  pro: { plan: "PRO", displayName: "Pro", monthlyPriceCents: 2900, storageLabel: "100 GB", seats: 5, reportsIncluded: true },
  team: { plan: "TEAM", displayName: "Team", monthlyPriceCents: 9900, storageLabel: "1 TB", seats: 10 },
  enterprise: {
    displayName: "Enterprise",
    pricingModel: "CUSTOM",
    capabilities: ["SAML SSO and SCIM provisioning", "Legal hold and custom retention policies"],
  },
  ...over,
});

/* ------------------------------------------------------------------ pricing */

test("the catalogue path is the canonical one", () => {
  assert.equal(P.buildPricingPath(), "/v1/billing/pricing");
  assert.equal(P.buildPricingPath("EUR"), "/v1/billing/pricing?currency=EUR");
});

test("every published plan is projected, in catalogue order", () => {
  const c = P.parsePricingCatalogue(catalogue());
  assert.deepEqual(c.plans.map((p) => p.plan), ["FREE", "PRO", "TEAM", "ENTERPRISE"]);
  assert.equal(c.currency, "USD");
});

test("a sales-provisioned plan is CUSTOM, never zero", () => {
  const c = P.parsePricingCatalogue(catalogue());
  const ent = c.plans.find((p) => p.plan === "ENTERPRISE");
  // Zero would render as "Free", which is the opposite of what Custom means.
  assert.equal(ent.monthlyPriceCents, null);
  assert.equal(ent.pricingModel, "CUSTOM");
  assert.equal(P.formatMonthlyPrice(ent.monthlyPriceCents, "USD"), "Custom pricing");
});

test("a real zero price is free, and a real price carries its currency", () => {
  assert.equal(P.formatMonthlyPrice(0, "USD"), "Free");
  assert.match(P.formatMonthlyPrice(2900, "USD"), /29/);
  assert.match(P.formatMonthlyPrice(2900, "USD"), /month/);
  // An unknown currency code shows the code rather than a bare number that
  // could be read as dollars.
  assert.match(P.formatMonthlyPrice(2900, "NOT_A_CURRENCY"), /NOT_A_CURRENCY/);
});

test("the summary line is built only from figures the server sent", () => {
  const c = P.parsePricingCatalogue(catalogue());
  const pro = c.plans.find((p) => p.plan === "PRO");
  assert.match(P.planSummaryLine(pro), /100 GB storage/);
  assert.match(P.planSummaryLine(pro), /5 seats/);
  assert.match(P.planSummaryLine(pro), /reports included/);

  // Absent facts are omitted, never guessed.
  const ent = c.plans.find((p) => p.plan === "ENTERPRISE");
  assert.equal(P.planSummaryLine(ent), "");
});

test("the current plan is matched case-insensitively and never by accident", () => {
  const c = P.parsePricingCatalogue(catalogue());
  const pro = c.plans.find((p) => p.plan === "PRO");
  assert.equal(P.isCurrentPlan(pro, "pro"), true);
  assert.equal(P.isCurrentPlan(pro, "PRO"), true);
  assert.equal(P.isCurrentPlan(pro, "TEAM"), false);
  assert.equal(P.isCurrentPlan(pro, null), false);
});

test("a plan the endpoint omits simply is not listed", () => {
  const partial = catalogue();
  delete partial.team;
  const c = P.parsePricingCatalogue(partial);
  assert.deepEqual(c.plans.map((p) => p.plan), ["FREE", "PRO", "ENTERPRISE"]);
});

/* ------------------------------------------------------------------ support */

test("every support reference is named by slug, never by text", () => {
  for (const ref of S.SUPPORT_REFERENCES) {
    assert.match(ref.slug, /^[a-z0-9-]+$/, ref.slug);
    assert.ok(ref.label.length > 0);
  }
  // The documents are the canonical legal ones.
  const slugs = S.SUPPORT_REFERENCES.map((r) => r.slug);
  assert.ok(slugs.includes("dpa"));
  assert.ok(slugs.includes("security"));
  assert.ok(slugs.includes("verification-methodology"));
});

test("the support routes resolve in-app wherever an in-app destination exists", () => {
  const byKey = Object.fromEntries(S.SUPPORT_ROUTES.map((r) => [r.key, r]));

  assert.equal(S.destinationPath(byKey.security.destination), "/legal/security");
  // The IN-APP Trust Center, not the public marketing page.
  assert.equal(S.destinationPath(byKey.legal.destination), "/(stack)/trust-center");
  // Only the two inbox routes leave the app, which is where a human reply
  // comes back from.
  assert.equal(S.destinationPath(byKey.product.destination), null);
  assert.equal(S.destinationPath(byKey.billing.destination), null);
});

test("no support destination points at the public web host", () => {
  for (const route of S.SUPPORT_ROUTES) {
    const path = S.destinationPath(route.destination);
    if (path) assert.doesNotMatch(path, /proovra\.com|^https?:/, route.key);
  }
});

test("mailto links are well formed and encode their subject", () => {
  assert.equal(S.mailtoUrl("a@b.test"), "mailto:a@b.test");
  assert.equal(S.mailtoUrl("a@b.test", "Help me"), "mailto:a@b.test?subject=Help%20me");
});
