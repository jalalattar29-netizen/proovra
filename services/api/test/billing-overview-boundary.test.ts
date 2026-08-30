/**
 * THE BOUNDARY AROUND THE PERSONAL STORAGE PROJECTION.
 *
 * `readBillingOverview` is named for what it used to be. It is now a
 * convenience read for ONE person's own storage and plan facts, consumed by
 * Home, the sidebar storage widget and the storage wall — and a name that
 * says "billing overview" invites exactly the mistake this file exists to
 * prevent: someone reaching for it when they need a price, a contract, an
 * organization, or an authorization decision.
 *
 * A docblock asks. These assert.
 *
 * The rule is not "this file is bad". It delegates to the canonical
 * primitives and always did. The rule is that it has exactly ONE subject —
 * the caller's personal account — and that Enterprise commercial truth is
 * reachable only through the account projection, which fails closed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES. Scanning the raw text made
 * the guard trip on the docblock that explains the very boundary it is
 * enforcing — which teaches the next person to delete the explanation rather
 * than keep the rule.
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SERVICE = "src/services/billing-overview.service.ts";

describe("billing-overview — the personal boundary holds", () => {
  const src = code(SERVICE);
  const withComments = read(SERVICE);

  it("resolves ONE subject: the caller's personal account", () => {
    // Every commercial context it opens names PERSONAL_ACCOUNT. A WORKSPACE
    // subject here would be the per-workspace rollup coming back.
    const subjects = src.match(/type:\s*"(PERSONAL_ACCOUNT|WORKSPACE)"/g) ?? [];
    expect(subjects.length, "it must resolve at least one subject").toBeGreaterThan(0);
    expect(
      subjects.filter((m) => m.includes("WORKSPACE")),
      "a WORKSPACE subject means the retired per-workspace rollup is back",
    ).toEqual([]);
  });

  it("the retired Owned-Workspace-as-billing-subject shape stays gone", () => {
    // The exact shape `billing-accounts.service.ts` retired on 2026-08-28.
    expect(src).not.toMatch(/\bteams,\s*$/m);
    expect(src).not.toMatch(/workspaces\.teams/);
    expect(src).not.toMatch(/activeTeamPlans/);
    expect(src).not.toMatch(/overSeatLimitTeams/);
    expect(src).not.toMatch(/nearStorageLimitTeams/);
  });

  it("it reads no organization and no enterprise contract", () => {
    // THE POINT. An ORGANIZATION billing account is the Enterprise subject,
    // and it is reachable only through `resolveBillingAccountForViewer`,
    // which refuses a viewer without billing authority on that organization.
    // If this file could produce one, that gate would have a way around it.
    for (const forbidden of [
      "resolveEnterpriseContract",
      "enterpriseContract",
      "EnterpriseContract",
      "organizationMembership",
      "checkOrgAccess",
      "prisma.organization",
    ]) {
      expect(src, `${forbidden} does not belong in a personal projection`).not.toContain(
        forbidden,
      );
    }
  });

  it("it states no PLAN price and no capability set", () => {
    // Plan pricing and billing capabilities are resolved per viewer by the
    // canonical projection, which withholds amounts INDEPENDENTLY of the
    // account. A second surface answering either would be a second answer to
    // a question only that one may answer.
    //
    // THE ONE MONETARY FIGURE HERE, STATED PLAINLY: a storage add-on's own
    // `amountCents`, which is what the caller already paid for their OWN
    // add-on and is what the storage wall shows beside a refusal. It is a
    // record of a purchase, not a price being quoted, and it is not gated
    // because the person reading it is the person who bought it.
    for (const forbidden of [
      "getPlanPriceCents",
      "getStorageAddonPriceCents",
      "resolveCheckoutCurrency",
      "BillingCapability",
      "ALL_BILLING_CAPABILITIES",
      "billing-accounts.service",
      "billing-account-projection",
    ]) {
      expect(src, `${forbidden} belongs to the canonical projection`).not.toContain(
        forbidden,
      );
    }
  });

  it("every figure comes from a canonical primitive", () => {
    // It is not a second calculator, and this is what keeps it from becoming
    // one: no local plan table, no local storage arithmetic against a literal.
    expect(src).toContain("resolveCommercialContext");
    expect(src).toContain("getWorkspaceUsage");
    expect(src).toContain("getPlanCapabilities");
  });

  it("its return type is named for what it is", () => {
    expect(src).toMatch(/export type PersonalStorageProjection/);
  });

  it("it says in its own words that it is not the billing authority", () => {
    // The rules above stop the code from crossing the line. This stops the
    // EXPLANATION from being removed, which is what a future reader will
    // reach for first when they wonder whether this is the right function.
    expect(withComments).toMatch(/NOT the billing authority/);
    expect(withComments).toMatch(/buildBillingAccountProjection/);
  });
});

describe("billing-overview — its consumers stay inside the boundary", () => {
  it("no route serves it as an account-scoped billing answer", () => {
    const routes = code("src/routes/billing.routes.ts");
    // The legacy endpoint remains for the surfaces that read personal
    // storage. What must never happen is a NEW account-scoped route built on
    // it: `/v1/billing/accounts/:type/:id` is the account contract, and it
    // resolves through the authorization chokepoint.
    const accountRouteBodies =
      routes.match(/\/v1\/billing\/accounts[\s\S]{0,1200}?\n\s{4}\},/g) ?? [];
    for (const body of accountRouteBodies) {
      expect(
        body,
        "an account-scoped route must not read the personal projection",
      ).not.toContain("readBillingOverview");
    }
  });

  it("the evidence review-workspace snapshot resolves its own subject", () => {
    const evidence = code("src/routes/evidence.routes.ts");
    // It used to search the aggregate's `workspaces.teams` for the record's
    // workspace. It resolves that one workspace canonically now.
    expect(evidence).toMatch(/async function resolveWorkspaceCapabilitySnapshot/);
    expect(evidence).not.toMatch(/params\.overview\.workspaces\.teams/);
  });
});
