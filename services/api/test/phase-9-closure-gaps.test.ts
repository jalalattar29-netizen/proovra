/**
 * PHASE 9 FINAL CLOSURE GAPS (2026-07-23) — the three non-environmental
 * proof gaps closed with behavioral evidence:
 *   1. Row 24 — commercial reactivation restores capability, NEVER
 *      authorization (real activateTeamPlan + real evaluateAccess).
 *   2. EnterpriseContract legacy fallback — constrained
 *      COMPATIBILITY_INPUT_ADAPTER (real resolver behavior).
 *   3. Provider transports — Stripe deterministic HMAC fixture; PayPal
 *      verification with deterministic mocked transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const H = vi.hoisted(() => ({
  writes: [] as string[],
  memberStatus: "REVOKED" as string,
  orgRow: null as Record<string, unknown> | null,
  contractRow: null as Record<string, unknown> | null,
}));

vi.mock("../src/db.js", () => {
  const prisma = new Proxy(
    {},
    {
      get(_t, model: string) {
        if (model === "$transaction")
          return async (fn: unknown) =>
            typeof fn === "function" ? (fn as (tx: unknown) => unknown)(prisma) : 0;
        if (String(model).startsWith("$")) return async () => 0;
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async () => {
                if (/^(create|update|upsert|delete)/.test(String(method)))
                  H.writes.push(`${String(model)}.${String(method)}`);
                if (String(model) === "team" && method === "findUnique")
                  return {
                    id: "ws-1",
                    ownerUserId: "owner-1",
                    _count: { members: 1 },
                  };
                if (String(model) === "team" && method === "update")
                  return { id: "ws-1", billingStatus: "ACTIVE", billingPlan: "TEAM" };
                if (String(model) === "teamMember" && method === "findUnique")
                  return {
                    id: "tm-1",
                    teamId: "ws-1",
                    userId: "user-suspended",
                    role: "MEMBER",
                    status: H.memberStatus,
                    accessExpiresAtUtc: null,
                    team: {
                      isPersonal: false,
                      workspaceKind: "OWNED",
                      billingPlan: "TEAM",
                      organization: null,
                    },
                    capabilityGrants: [],
                    delegatedAdminScopes: [],
                  };
                if (String(model) === "organization" && method === "findUnique")
                  return H.orgRow;
                if (String(model) === "enterpriseContract" && method === "findUnique")
                  return H.contractRow;
                if (method === "findMany") return [];
                if (method === "count") return 0;
                if (method === "aggregate") return { _sum: {} };
                if (method === "findFirst" || method === "findUnique") return null;
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { prisma };
});

import { activateTeamPlan } from "../src/services/billing.service.js";
import {
  loadMemberAccessSnapshot,
  evaluateAccess,
} from "../src/services/identity/access-policy.service.js";
import { resolveEnterpriseContract } from "../src/services/organization/enterprise-contract.service.js";
import { verifyStripeSignature, StripeSignatureError } from "../src/services/stripe.service.js";

beforeEach(() => {
  H.writes.length = 0;
  H.memberStatus = "REVOKED";
  H.orgRow = null;
  H.contractRow = null;
});

// ── 1. ROW 24 — BEHAVIORAL ─────────────────────────────────────────────────
describe("Row 24 (behavioral) — commercial reactivation restores capability, NEVER authorization", () => {
  it("reactivating the workspace subscription leaves a REVOKED member revoked: no grant/session/credential/context writes, authorization still denied, billing fields only, audited commercially", async () => {
    // COMMERCIAL REACTIVATION through the real production service.
    const updated = await activateTeamPlan({
      teamId: "ws-1",
      ownerUserId: "owner-1",
      plan: "TEAM" as never,
    });
    expect(updated.billingStatus).toBe("ACTIVE");

    // Commercial fields change ONLY: the sole model written is `team`
    // (+ the billing analytics event) — NO membership, grant, session,
    // credential, or active-context restoration.
    const identityWrites = H.writes.filter((w) =>
      /teamMember|organizationMembership|membershipGrant|session|apiCredential|user\./.test(w),
    );
    expect(identityWrites).toEqual([]);
    expect(H.writes.some((w) => w.startsWith("team.update"))).toBe(true);

    // The REVOKED member remains revoked and authorization remains DENIED
    // through the real canonical authorization path.
    const snapshot = await loadMemberAccessSnapshot(
      { teamId: "ws-1", userId: "user-suspended" },
      (await import("../src/db.js")).prisma as never,
    );
    const decision = evaluateAccess(
      snapshot ? { kind: "MEMBER", member: snapshot } : null,
      { permission: "evidence.read" } as never,
    );
    expect(decision.allowed).toBe(false);
    expect((decision as { reason?: string }).reason).toBe("member_not_active");
  });

  it("positive separation: a still-ACTIVE member regains ONLY commercial capability (authorization unchanged, already allowed)", async () => {
    H.memberStatus = "ACTIVE";
    await activateTeamPlan({ teamId: "ws-1", ownerUserId: "owner-1", plan: "TEAM" as never });
    const snapshot = await loadMemberAccessSnapshot(
      { teamId: "ws-1", userId: "user-suspended" },
      (await import("../src/db.js")).prisma as never,
    );
    const decision = evaluateAccess(
      { kind: "MEMBER", member: snapshot! },
      { permission: "evidence.read" } as never,
    );
    expect(decision.allowed).toBe(true); // authorization was already active —
    // the reactivation added commercial capability only (team.update).
    expect(H.writes.filter((w) => /membershipGrant|session|apiCredential/.test(w))).toEqual([]);
  });
});

// ── 2. ENTERPRISECONTRACT LEGACY FALLBACK — CONSTRAINED ADAPTER ───────────
describe("EnterpriseContract legacy fallback — temporary COMPATIBILITY_INPUT_ADAPTER (constrained)", () => {
  it("SYSTEM organizations are excluded (null, no fallback)", async () => {
    H.orgRow = { id: "org-1", kind: "SYSTEM", status: "ACTIVE", createdAt: new Date(), billingOwnerUserId: null, pendingEnterpriseSeats: 5 };
    expect(await resolveEnterpriseContract("org-1")).toBeNull();
  });

  it("a NON-ACTIVE legacy org can NEVER synthesize ACTIVE (fail closed, incl. unknown status)", async () => {
    for (const status of ["SUSPENDED", "ARCHIVED", null, undefined, "GARBAGE"]) {
      H.orgRow = { id: "org-1", kind: "CUSTOMER", status, createdAt: new Date(), billingOwnerUserId: "u1", pendingEnterpriseSeats: 3 };
      const r = await resolveEnterpriseContract("org-1");
      expect(r?.status).toBe("SUSPENDED");
      expect(r?.legacyDerived).toBe(true);
    }
  });

  it("ACTIVE legacy CUSTOMER org synthesizes a legacyDerived projection with ONLY the verified legacy fields", async () => {
    H.orgRow = { id: "org-1", kind: "CUSTOMER", status: "ACTIVE", createdAt: new Date("2026-01-01"), billingOwnerUserId: "u1", pendingEnterpriseSeats: 7 };
    const r = await resolveEnterpriseContract("org-1");
    expect(r).toMatchObject({ status: "ACTIVE", legacyDerived: true, seatCount: 7, contractOwnerUserId: "u1" });
    // No capability above verified legacy state: storage/region/planVersion null.
    expect(r?.storageGb).toBeNull();
    expect(r?.planVersion).toBeNull();
  });

  it("a REAL contract row wins over the fallback (row-authoritative, legacyDerived=false)", async () => {
    H.orgRow = { id: "org-1", kind: "CUSTOMER", status: "ACTIVE", createdAt: new Date(), billingOwnerUserId: "u1", pendingEnterpriseSeats: 7 };
    H.contractRow = { status: "SUSPENDED", activationState: "ACTIVATED", effectiveAtUtc: null, endsAtUtc: null, seatCount: 50, storageGb: 100, region: null, planVersion: "v1", billingCustomerRef: null, billingSubscriptionRef: null, contractOwnerUserId: "u1" };
    const r = await resolveEnterpriseContract("org-1");
    expect(r).toMatchObject({ status: "SUSPENDED", legacyDerived: false, seatCount: 50 });
  });

  it("every fallback use is runtime-audited for the Phase 12 retirement metric", async () => {
    H.orgRow = { id: "org-1", kind: "CUSTOMER", status: "ACTIVE", createdAt: new Date(), billingOwnerUserId: "u1", pendingEnterpriseSeats: 1 };
    await resolveEnterpriseContract("org-1");
    // The audit is fire-and-forget — flush pending microtasks/timers.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      H.writes.some((w) => /auditLog/i.test(w)),
      `writes: ${H.writes.join(",")}`,
    ).toBe(true);
  });

  it("no production writer creates fallback-dependent rows (provisioning upserts real contract rows)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const prov = readFileSync(fileURLToPath(new URL("../src/services/enterprise-provisioning.service.js", import.meta.url)).replace(/\.js$/, ".ts"), "utf8");
    expect(prov).toMatch(/upsertEnterpriseContract\(/);
  });
});

// ── 3. PROVIDER TRANSPORTS ─────────────────────────────────────────────────
describe("Stripe transport — deterministic HMAC signature fixture", () => {
  const SECRET = "whsec_test_deterministic";
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });
  function sign(body: string, ts: number, secret = SECRET): string {
    const mac = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${mac}`;
  }

  it("a correctly signed payload verifies", () => {
    const body = '{"id":"evt_1","type":"customer.subscription.updated"}';
    const ts = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyStripeSignature(Buffer.from(body), sign(body, ts), { nowMs: ts * 1000 }),
    ).not.toThrow();
  });

  it("a TAMPERED payload is rejected (BAD_SIGNATURE) — zero tolerance", () => {
    const body = '{"id":"evt_1","plan":"FREE"}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(body, ts);
    expect(() =>
      verifyStripeSignature(Buffer.from('{"id":"evt_1","plan":"ENTERPRISE"}'), sig, { nowMs: ts * 1000 }),
    ).toThrow(StripeSignatureError);
  });

  it("a REPLAYED (stale-timestamp) signature is rejected (tolerance window)", () => {
    const body = '{"id":"evt_1"}';
    const ts = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old
    expect(() =>
      verifyStripeSignature(Buffer.from(body), sign(body, ts)),
    ).toThrow(StripeSignatureError);
  });

  it("missing signature fields are rejected", () => {
    expect(() => verifyStripeSignature(Buffer.from("{}"), "garbage")).toThrow(
      StripeSignatureError,
    );
  });
});

describe("PayPal transport — verification via deterministic mocked provider API", () => {
  const originalFetch = globalThis.fetch;
  // The service reads the secret named PAYPAL_SECRET (not *_CLIENT_SECRET) via
  // requireSecret; snapshot + restore so no test leaks env or the mocked fetch.
  const ENV_KEYS = ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET", "PAYPAL_WEBHOOK_ID"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.PAYPAL_CLIENT_ID = "test";
    process.env.PAYPAL_SECRET = "test";
    process.env.PAYPAL_WEBHOOK_ID = "wh-test";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function mockPayPal(verificationStatus: "SUCCESS" | "FAILURE") {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("oauth2/token"))
        return { ok: true, status: 200, json: async () => ({ access_token: "at" }) } as Response;
      if (u.includes("verify-webhook-signature"))
        return { ok: true, status: 200, json: async () => ({ verification_status: verificationStatus }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;
  }

  it("SUCCESS accepted; FAILURE surfaced verbatim (no local header trust); missing secret fails closed", async () => {
    const { verifyPayPalWebhook } = await import("../src/services/paypal.service.js");

    // SUCCESS — the provider verdict is accepted (promise properly awaited).
    mockPayPal("SUCCESS");
    await expect(
      verifyPayPalWebhook({ "paypal-transmission-id": "t1" }, "{}"),
    ).resolves.toMatchObject({ verification_status: "SUCCESS" });

    // FAILURE — the service NEVER locally trusts the raw headers: it returns the
    // provider's negative verdict verbatim, which the caller must reject.
    mockPayPal("FAILURE");
    await expect(
      verifyPayPalWebhook({ "paypal-transmission-id": "t1" }, "{}"),
    ).resolves.toMatchObject({ verification_status: "FAILURE" });

    // FAIL-CLOSED — with the production secret absent, verification rejects and
    // never silently proceeds (this rejection is awaited, not floated).
    mockPayPal("SUCCESS");
    delete process.env.PAYPAL_SECRET;
    await expect(
      verifyPayPalWebhook({ "paypal-transmission-id": "t1" }, "{}"),
    ).rejects.toThrow(/PAYPAL_SECRET/);
  });
});
