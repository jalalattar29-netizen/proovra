/**
 * DEC-12 (RG-20, B7B-F06 / PRO-G2-13) — custom Trust Center AUTHORING is an
 * Enterprise capability, end to end.
 *
 * `DEFAULT_ENTITLEMENTS.FEATURE_TRUST_CENTER` used to be true, so every
 * self-serve owner (Free included) could author and publish custom trust
 * content. It is now false. These cases drive the REAL resolver — the one
 * `assertFeatureEntitlement`, and so every trust authoring route, reads —
 * with a doubled commercial context:
 *
 *   - Free / PAYG / Pro / Team cannot author;
 *   - an Enterprise workspace under an ACTIVE contract can, with nothing stored;
 *   - an Enterprise plan with no, or a lapsed, contract cannot;
 *   - an explicit operator grant still grants (DEC-12 keeps valid grants), an
 *     expired one does not;
 *   - READS and the canonical platform seed never ask the key, so published
 *     canonical content stays readable on every plan.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const commercial = vi.hoisted(() => ({
  plan: "FREE" as string,
  contract: null as Record<string, unknown> | null,
}));

vi.mock("../src/services/billing/commercial-context.service.js", () => ({
  resolveCommercialContext: async () => ({
    plan: commercial.plan,
    enterpriseContract: commercial.contract,
  }),
}));

import {
  DEFAULT_ENTITLEMENTS,
  PLAN_LINE_ENTITLEMENTS,
  assertFeatureEntitlement,
  resolveEntitlement,
} from "../src/services/packaging/entitlement.service.js";

function contract(over: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    status: "ACTIVE",
    activationState: "ACTIVATED",
    effectiveAtUtc: new Date("2026-01-01T00:00:00Z"),
    endsAtUtc: null,
    seatCount: 50,
    storageGb: 100,
    evidenceRecordsPerMonth: null,
    aiOperationsPerMonth: null,
    collaborationTeamsMax: null,
    collaborationTeamMembersMax: null,
    legalHoldEnabled: null,
    region: null,
    planVersion: null,
    billingCustomerRef: null,
    billingSubscriptionRef: null,
    contractOwnerUserId: null,
    legacyDerived: false,
    ...over,
  };
}

type Grant = { valueBool: boolean; expiresAtUtc: Date | null } | null;
let grant: Grant;

const prismaDouble = () =>
  ({
    team: { findUnique: async () => ({ ownerUserId: "owner-1" }) },
    entitlementGrant: {
      findUnique: async () =>
        grant
          ? {
              id: "grant-1",
              key: "FEATURE_TRUST_CENTER",
              kind: "FEATURE",
              valueBool: grant.valueBool,
              valueNumber: null,
              source: "CUSTOM",
              productLine: null,
              grantedAtUtc: new Date("2026-06-01T00:00:00Z"),
              expiresAtUtc: grant.expiresAtUtc,
            }
          : null,
    },
    // The denial's lifecycle event: recorded, never needed for the answer.
    intelligenceActivityEvent: {
      create: async () => ({}),
    },
  }) as never;

const TEAM = "11111111-1111-4111-8111-111111111111";
const mayAuthor = async () =>
  (await resolveEntitlement({ prisma: prismaDouble(), teamId: TEAM, key: "FEATURE_TRUST_CENTER" })).value;

beforeEach(() => {
  commercial.plan = "FREE";
  commercial.contract = null;
  grant = null;
});

describe("DEC-12 — who may author custom Trust Center content", () => {
  it("the default no longer grants it, and the ENTERPRISE line still sells it", () => {
    expect(DEFAULT_ENTITLEMENTS.FEATURE_TRUST_CENTER).toEqual({ kind: "FEATURE", value: false });
    expect(PLAN_LINE_ENTITLEMENTS.ENTERPRISE.FEATURE_TRUST_CENTER).toBe(true);
  });

  for (const plan of ["FREE", "PAYG", "PRO", "TEAM"]) {
    it(`${plan} cannot author`, async () => {
      commercial.plan = plan;
      // Even handed a contract, which a non-Enterprise workspace never has.
      commercial.contract = contract();
      expect(await mayAuthor()).toBe(false);
    });
  }

  it("Enterprise under an ACTIVE contract can author, with no stored grant", async () => {
    commercial.plan = "ENTERPRISE";
    commercial.contract = contract();
    const res = await resolveEntitlement({ prisma: prismaDouble(), teamId: TEAM, key: "FEATURE_TRUST_CENTER" });
    expect(res.value).toBe(true);
    expect(res.source).toBe("PLAN");
  });

  it("an Enterprise plan with no contract, or a lapsed one, cannot author — even with a stored grant", async () => {
    commercial.plan = "ENTERPRISE";
    grant = { valueBool: true, expiresAtUtc: null };
    for (const c of [null, contract({ status: "SUSPENDED" }), contract({ status: "TERMINATED" })]) {
      commercial.contract = c;
      expect(await mayAuthor()).toBe(false);
    }
  });

  it("an explicit operator grant still grants a non-Enterprise workspace; an expired one does not", async () => {
    commercial.plan = "PRO";
    grant = { valueBool: true, expiresAtUtc: null };
    expect(await mayAuthor()).toBe(true);
    grant = { valueBool: true, expiresAtUtc: new Date("2026-01-01T00:00:00Z") };
    expect(await mayAuthor()).toBe(false);
  });

  it("the gate the authoring routes call refuses Pro and admits Enterprise", async () => {
    commercial.plan = "PRO";
    const pro = await assertFeatureEntitlement({ prisma: prismaDouble(), teamId: TEAM, key: "FEATURE_TRUST_CENTER", actorUserId: "u-1" });
    expect(pro).toMatchObject({ ok: false, denial: "ENTITLEMENT_REQUIRED" });
    commercial.plan = "ENTERPRISE";
    commercial.contract = contract();
    const ent = await assertFeatureEntitlement({ prisma: prismaDouble(), teamId: TEAM, key: "FEATURE_TRUST_CENTER", actorUserId: "u-1" });
    expect(ent).toEqual({ ok: true });
  });
});

describe("DEC-12 — reads and the canonical seed never ask the authoring key", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/routes/trust-and-governance.routes.ts", import.meta.url)),
    "utf8",
  );
  // One block per registered route: "  app.<verb>(\n    \"<path>\", ...".
  const routes = src
    .split(/\n {2}app\.(?=(?:get|post|put|patch|delete)\()/)
    .slice(1)
    .map((block) => ({
      verb: block.slice(0, block.indexOf("(")),
      path: /"([^"]+)"/.exec(block)?.[1] ?? "",
      block,
    }))
    .filter((r) => r.path.startsWith("/v1/trust/"));

  it("the entitlement is asked in exactly one place, by the one trust write rule", () => {
    expect(src.match(/key: "FEATURE_TRUST_CENTER"/g)).toHaveLength(1);
    expect(src.match(/await refuseTrustAuthoring\(/g)).toHaveLength(1);
    expect(src).toContain("if (spec.customerAuthored && (await refuseTrustAuthoring(reply, ctx))) return true;");
  });

  it("no GET under /v1/trust/ runs the write rule", () => {
    const gets = routes.filter((r) => r.verb === "get");
    expect(gets.length).toBeGreaterThanOrEqual(8);
    for (const r of gets) expect(r.block, r.path).not.toContain("refuseTrustWrite(");
  });

  it("the canonical seeds are not customer-authored; every other trust write is", () => {
    const writes = routes.filter((r) => r.block.includes("refuseTrustWrite("));
    const authored = (r: { block: string }) => /customerAuthored: (true|false)/.exec(r.block)?.[1];
    expect(Object.fromEntries(writes.map((r) => [r.path, authored(r)]))).toEqual({
      "/v1/trust/articles": "true",
      "/v1/trust/articles/seed": "false",
      "/v1/trust/subprocessors": "true",
      "/v1/trust/subprocessors/seed": "false",
      "/v1/trust/status/incidents": "true",
      "/v1/trust/status/incidents/:id/updates": "true",
      "/v1/trust/status/maintenance": "true",
    });
  });
});
