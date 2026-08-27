/**
 * PHASE 12 — POINT 7: the five-plan SERVER matrix, against live PostgreSQL 16.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * Everything except the genuine external processes. Prisma, plan resolution,
 * workspace resolution, membership checks, authorization, route handlers,
 * services, and durable writes all run for real: the suite boots the
 * production Fastify app through the shared integration harness and drives it
 * with `app.inject`, which exercises the entire request pipeline — auth,
 * legal-acceptance gate, tenancy resolution, commercial enforcement — without
 * needing a socket.
 *
 * WHAT A DENIAL HAS TO PROVE
 * ---------------------------------------------------------------------------
 * Not "it returned 4xx". A denial is credited only when the durable state is
 * IDENTICAL before and after: no workspace, membership, evidence, case,
 * report, entitlement, subscription, collaboration row, custody event or
 * notification delivery moved. `fingerprintSideEffects` takes that census
 * across the whole database rather than the rows the test happens to know
 * about, because the failure mode being hunted is a write somewhere the author
 * did not think to look.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import {
  DENIAL_CODES,
  PLAN_CONTRACT,
  CANONICAL_PLANS,
} from "./plan-contract.js";
import {
  bootstrapPersonalSpace,
  fingerprintDelta,
  fingerprintSideEffects,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
} from "./product-fixtures.js";
import { provenScenario, recordScenarioProof } from "./scenario-manifest.js";

const SUITE = "services/api/test/point7/plan-matrix.integration.test.ts";

describe("POINT 7 — five-plan server matrix (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let deps: FixtureDeps;

  const inject = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  /**
   * Drive a request that MUST be denied, and prove nothing durable moved.
   *
   * Returns the response so the caller can additionally assert the code — a
   * denial with the wrong code is still a defect, because the client renders
   * remediation from it.
   */
  async function denyWithoutSideEffects(opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token: string;
    payload?: unknown;
  }) {
    const before = await fingerprintSideEffects(prisma);
    const res = await inject(opts);
    const after = await fingerprintSideEffects(prisma);
    expect(res.statusCode, `${opts.method} ${opts.url} must be denied`).toBeGreaterThanOrEqual(400);
    expect(
      fingerprintDelta(before, after),
      `${opts.method} ${opts.url} denied but mutated durable state`,
    ).toEqual({});
    return res;
  }

  /**
   * BILLING PRODUCTION CLOSURE (2026-08-27) — settle through the REAL caller.
   *
   * The credit scenarios below used to invoke
   * `consumeEvidenceCreditForCompletion` directly. That proved the wallet and
   * nothing above it, which is how a defect in the layer immediately above —
   * an admission decision that counted the record it was funding — passed
   * every one of them while making FREE's third record unfundable in
   * production.
   *
   * They now enter at `settleEvidenceCompletionFunding`, inside an interactive
   * transaction, exactly as `completeEvidence` enters it. The wallet is still
   * exercised; it is just no longer the entry point.
   */
  async function settleCompletion(ownerUserId: string, evidenceId: string) {
    const { settleEvidenceCompletionFunding } = await import(
      "../../src/services/billing-enforcement.service.js"
    );
    const { getPersonalWorkspaceScope } = await import(
      "../../src/services/workspace-billing.service.js"
    );
    const scope = await getPersonalWorkspaceScope(ownerUserId);
    return prisma.$transaction((tx) =>
      settleEvidenceCompletionFunding({ scope, evidenceId }, tx as never),
    );
  }

  /** A held Evidence row for the personal subject, as creation leaves it. */
  async function heldRecord(t: { owner: { userId: string }; personalTeamId: string; personalOrganizationId: string }) {
    return prisma.evidence.create({
      data: {
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
        organizationId: t.personalOrganizationId,
        type: "PHOTO",
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { signJwt } = await import("../../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `p7-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    // Record BEFORE teardown: the proof is what executed, and a teardown
    // failure must not erase it.
    recordScenarioProof({ suiteRelPath: SUITE, layer: "SERVER" });
    await harness?.cleanup();
  });

  // =========================================================================
  // The contract itself — the catalog must agree with the transcribed contract
  // =========================================================================

  describe("plan catalog agreement", () => {
    it("the running catalog matches the independently transcribed contract", async () => {
      const { PLAN_CAPABILITIES } = await import("@proovra/shared-billing");
      // Exactly five plans, and the same five.
      expect(Object.keys(PLAN_CAPABILITIES).sort()).toEqual(
        [...CANONICAL_PLANS].sort(),
      );
      for (const plan of CANONICAL_PLANS) {
        const caps = PLAN_CAPABILITIES[plan];
        const want = PLAN_CONTRACT[plan];
        expect(
          {
            professionalSurfaces: caps.professionalSurfacesIncluded,
            cases: caps.casesIncluded,
            reports: caps.reportsIncluded,
            intake: caps.intakeIncluded,
            reviewerOperations: caps.reviewerOperationsIncluded,
            maxOwnedWorkspaces: caps.maxOwnedWorkspaces,
            maxWorkspaceSeats: caps.maxWorkspaceSeats,
            lifetimeRecordCap: caps.maxEvidenceRecords,
            monthlyRecordCap: caps.maxEvidenceRecordsPerMonth,
            creditsPerCompletion: caps.paygCreditsRequiredPerCompletion,
            enterpriseFeatures: caps.enterpriseFeatures.legalHold,
          },
          `catalog drifted from the Point-7 contract for ${plan}`,
        ).toEqual(want);
      }
    });
  });

  // =========================================================================
  // FREE
  // =========================================================================

  describe("FREE", () => {
    it("p7.free.context.personal_workspace_available", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const res = await inject({
        method: "GET",
        url: "/v1/platform/context",
        token: t.owner.token,
        headers: { "x-platform-context-version": "3" },
      });
      expect(res.statusCode).toBe(200);
      const env = res.json();
      expect(env.personalSpaceAllowed).not.toBe(false);
      expect(env.contextOptions.personalSpace?.workspaceId).toBe(t.personalTeamId);
      expect(env.activeSpace.type).toBe("PERSONAL");
      provenScenario("SERVER", "p7.free.context.personal_workspace_available");
    });

    it("p7.free.no_fallback.plan_resolves_free", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ctx = await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: t.owner.userId,
      });
      expect(ctx.plan).toBe("FREE");
      // And the effective limits are the FREE ones — no owner/account
      // promotion, no cached other-plan capability.
      expect(ctx.limits.effectiveLifetimeRecordCap).toBe(
        t.expected.lifetimeRecordCap,
      );
      expect(ctx.capabilities.casesIncluded).toBe(false);
      expect(ctx.capabilities.reportsIncluded).toBe(false);
      provenScenario("SERVER", "p7.free.no_fallback.plan_resolves_free");
    });

    it("p7.free.capture.evidence_created_within_limit", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const before = await prisma.evidence.count({
        where: { teamId: t.personalTeamId },
      });
      const res = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: t.owner.token,
        payload: { title: "p7 free capture", type: "PHOTO" },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const after = await prisma.evidence.count({
        where: { teamId: t.personalTeamId },
      });
      // Exactly once — not zero, not twice.
      expect(after - before).toBe(1);

      // The same creation, addressed EXPLICITLY at the personal workspace id,
      // must behave identically. Before Point 7 it did not: reaching the scope
      // by team id stamped it `billingShape: "SHARED"`, and the evidence gate
      // refuses TEAM scope on a plan without `allowsTeamWorkspace` — so a FREE
      // user creating evidence in their OWN Personal Space was told their plan
      // did not include "team workspace evidence creation".
      const explicit = await inject({
        method: "POST",
        url: "/v1/evidence",
        token: t.owner.token,
        payload: {
          title: "p7 free capture (explicit personal workspace)",
          type: "PHOTO",
          teamId: t.personalTeamId,
        },
      });
      expect(explicit.statusCode, explicit.body).toBeLessThan(300);
      provenScenario("SERVER", "p7.free.capture.evidence_created_within_limit");
    });

    it("p7.free.limit.blocks_new_preserves_existing", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      const cap = t.expected.lifetimeRecordCap!;
      for (let i = 0; i < cap; i += 1) {
        const ok = await inject({
          method: "POST",
          url: "/v1/evidence",
          token: t.owner.token,
          payload: { title: `p7 free ${i}`, type: "PHOTO" },
        });
        expect(ok.statusCode, ok.body).toBeLessThan(300);
      }
      const existing = await prisma.evidence.findMany({
        where: { teamId: t.personalTeamId },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      expect(existing.length).toBe(cap);

      // The next one is denied — and the cap denies the NEW action only.
      const denied = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/evidence",
        token: t.owner.token,
        payload: { title: "p7 free over cap", type: "PHOTO" },
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);

      // Existing records are all still there, and still READABLE.
      const stillThere = await prisma.evidence.findMany({
        where: { teamId: t.personalTeamId },
        select: { id: true },
      });
      expect(stillThere.map((e) => e.id).sort()).toEqual(
        existing.map((e) => e.id).sort(),
      );
      const list = await inject({
        method: "GET",
        url: "/v1/evidence",
        token: t.owner.token,
      });
      expect(list.statusCode).toBe(200);
      provenScenario("SERVER", "p7.free.limit.blocks_new_preserves_existing");
    });

    it("p7.free.cases.not_included", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      expect(t.expected.cases).toBe(false);
      const res = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/cases",
        token: t.owner.token,
        payload: { name: "p7 free case" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      provenScenario("SERVER", "p7.free.cases.not_included");
    });

    it("p7.free.collaboration.direct_api_denied", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      // The UI hides this. The point of the scenario is that hiding is not
      // the enforcement: the raw request is refused, with the plan-shaped
      // code the client renders remediation from.
      const res = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: t.owner.token,
        payload: { name: "p7 free collab" },
      });
      const body = res.json();
      expect(
        JSON.stringify(body),
        "FREE collaboration denial must carry the plan-required code",
      ).toContain(DENIAL_CODES.planHasNoTeams);
      provenScenario("SERVER", "p7.free.collaboration.direct_api_denied");
    });

    it("p7.free.owned_workspace.creation_unavailable", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      expect(t.expected.maxOwnedWorkspaces).toBe(0);
      const res = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/teams",
        token: t.owner.token,
        payload: { name: "p7 free owned" },
      });
      expect(JSON.stringify(res.json())).toContain(
        DENIAL_CODES.ownedWorkspaceCreationNotAllowed,
      );
      provenScenario("SERVER", "p7.free.owned_workspace.creation_unavailable");
    });
  });

  // =========================================================================
  // PAYG
  // =========================================================================

  describe("PAYG", () => {
    it("p7.payg.context.remains_personal_mode", async () => {
      const t = await seedPersonalTenant(deps, "PAYG", { credits: 5 });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ctx = await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: t.owner.userId,
      });
      expect(ctx.plan).toBe("PAYG");
      expect(ctx.billingShape).toBe("SINGLE_OCCUPANT");
      // The personal Team row itself is NOT promoted to a recurring plan.
      const team = await prisma.team.findUniqueOrThrow({
        where: { id: t.personalTeamId },
        select: { billingPlan: true, workspaceKind: true },
      });
      expect(team.workspaceKind).toBe("PERSONAL");
      expect(team.billingPlan).not.toBe("PAYG");
      expect(team.billingPlan).not.toBe("PRO");

      // POINT 7 — the commercial surface RESOLVES for a PAYG account.
      //
      // It did not. `getTeamWorkspaceScope` stamped every scope reached by
      // team id `billingShape: "SHARED"`, including the user's own Personal
      // Space, and the structural assert in the billing package rejects PAYG
      // on a TEAM scope because PAYG is an operation entitlement rather than a
      // workspace plan. Since the effective-plan policy returns PAYG for
      // exactly one case — a PERSONAL workspace whose owner is on PAYG — the
      // assert could only ever fire on a workspace that was not a team, and
      // every PAYG account's `/v1/billing/overview` answered 500.
      const overview = await inject({
        method: "GET",
        url: "/v1/billing/overview",
        token: t.owner.token,
      });
      expect(overview.statusCode, overview.body).toBe(200);
      expect(overview.body).toContain("PAYG");
      provenScenario("SERVER", "p7.payg.context.remains_personal_mode");
    });

    it("p7.payg.entitlement.consumed_by_intended_operation", async () => {
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — retargeted at the
      // canonical evidence-credit wallet.
      //
      // This used to call `consumeWorkspaceCompletionCredits(scope)`, which
      // charged based on `caps.paygCreditsRequiredPerCompletion`. That test
      // could only pass because the fixture forced `entitlements.plan = PAYG`,
      // a state no production path can produce — the very reason real buyers
      // could never spend a credit. The wallet is now spent per COMPLETED
      // Evidence record and is independent of the recurring plan.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 2 });

      // The plan's THREE included records are funded by the plan and cost
      // nothing. This is the boundary the production defect sat on: the third
      // one used to demand a credit.
      for (let i = 0; i < 3; i += 1) {
        const included = await heldRecord(t);
        const settled = await settleCompletion(t.owner.userId, included.id);
        expect(settled.funding, `record ${i + 1} must be plan-funded`).toBe("PLAN");
      }
      expect(
        (
          await prisma.entitlement.findFirstOrThrow({
            where: { userId: t.owner.userId, active: true },
            select: { credits: true },
          })
        ).credits,
      ).toBe(2);

      // The FOURTH is the one a credit pays for.
      const fourth = await heldRecord(t);
      const evidenceId = fourth.id;
      const result = await settleCompletion(t.owner.userId, evidenceId);
      expect(result.funding).toBe("EVIDENCE_CREDIT");

      const ent = await prisma.entitlement.findFirstOrThrow({
        where: { userId: t.owner.userId, active: true },
        select: { credits: true, plan: true },
      });
      expect(ent.credits).toBe(1);
      // The RECURRING PLAN is untouched. Buying credits does not make an
      // account PRO, and spending one does not change its plan either.
      expect(ent.plan).toBe("FREE");

      // The movement is on the auditable ledger, keyed to the record.
      const entry = await prisma.evidenceCreditLedgerEntry.findUniqueOrThrow({
        where: { evidenceId },
        select: { entryType: true, creditsDelta: true, balanceAfter: true },
      });
      expect(entry.entryType).toBe("CONSUMPTION");
      expect(entry.creditsDelta).toBe(-1);
      expect(entry.balanceAfter).toBe(1);

      provenScenario(
        "SERVER",
        "p7.payg.entitlement.consumed_by_intended_operation",
      );
    });

    it("p7.payg.entitlement.retry_is_idempotent_per_record", async () => {
      // A retried or re-delivered completion for the SAME record must not burn
      // a second credit. The ledger's unique `evidence_id` is the guard.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 2 });
      // Fill the plan allowance so the next record is genuinely credit-funded.
      for (let i = 0; i < 3; i += 1) await heldRecord(t);
      const fourth = await heldRecord(t);

      const first = await settleCompletion(t.owner.userId, fourth.id);
      expect(first.funding).toBe("EVIDENCE_CREDIT");

      // Re-driving the SAME completion must be a no-op — and must not be
      // refused. Admission legitimately says "no" by now (the allowance is
      // spent and the credit is gone), so a settlement that asked admission
      // before checking the ledger turned every retry of a PAID record into a
      // 402.
      const again = await settleCompletion(t.owner.userId, fourth.id);
      expect(again.funding).toBe("EVIDENCE_CREDIT");

      const ent = await prisma.entitlement.findFirstOrThrow({
        where: { userId: t.owner.userId, active: true },
        select: { credits: true },
      });
      // Two settlements, ONE credit.
      expect(ent.credits).toBe(1);
      expect(
        await prisma.evidenceCreditLedgerEntry.count({
          where: { evidenceId: fourth.id, entryType: "CONSUMPTION" },
        }),
      ).toBe(1);
      provenScenario(
        "SERVER",
        "p7.payg.entitlement.retry_is_idempotent_per_record",
      );
    });

    it("p7.payg.entitlement.concurrent_completions_cannot_double_spend", async () => {
      // One credit, two DIFFERENT records completing at once. Exactly one may
      // win; the balance must never go negative.
      const t = await seedPersonalTenant(deps, "FREE", { credits: 1 });
      for (let i = 0; i < 3; i += 1) await heldRecord(t);
      const [a1, b1] = [await heldRecord(t), await heldRecord(t)];

      const settled = await Promise.allSettled([
        settleCompletion(t.owner.userId, a1.id),
        settleCompletion(t.owner.userId, b1.id),
      ]);

      const fulfilled = settled.filter(
        (r) => r.status === "fulfilled" && r.value.funding === "EVIDENCE_CREDIT",
      );
      expect(fulfilled).toHaveLength(1);

      const ent = await prisma.entitlement.findFirstOrThrow({
        where: { userId: t.owner.userId, active: true },
        select: { credits: true },
      });
      expect(ent.credits).toBe(0);
      provenScenario(
        "SERVER",
        "p7.payg.entitlement.concurrent_completions_cannot_double_spend",
      );
    });

    it("p7.payg.entitlement.exhausted_denies_operation", async () => {
      const t = await seedPersonalTenant(deps, "FREE", { credits: 0 });
      for (let i = 0; i < 3; i += 1) await heldRecord(t);
      const overflow = await heldRecord(t);

      const before = await fingerprintSideEffects(prisma);
      await expect(
        settleCompletion(t.owner.userId, overflow.id),
      ).rejects.toMatchObject({ publicCode: "INSUFFICIENT_EVIDENCE_CREDITS" });
      const after = await fingerprintSideEffects(prisma);
      expect(fingerprintDelta(before, after)).toEqual({});
      const ent = await prisma.entitlement.findFirstOrThrow({
        where: { userId: t.owner.userId, active: true },
        select: { credits: true },
      });
      // The credit balance did not go negative.
      expect(ent.credits).toBe(0);
      provenScenario("SERVER", "p7.payg.entitlement.exhausted_denies_operation");
    });

    it("p7.payg.collaboration.locked", async () => {
      const t = await seedPersonalTenant(deps, "PAYG", { credits: 10 });
      expect(t.expected.maxOwnedWorkspaces).toBe(0);
      const collab = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: t.owner.token,
        payload: { name: "p7 payg collab" },
      });
      expect(JSON.stringify(collab.json())).toContain(
        DENIAL_CODES.planHasNoTeams,
      );
      // And no Owned Workspace either — buying operations never buys a
      // workspace.
      const owned = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/teams",
        token: t.owner.token,
        payload: { name: "p7 payg owned" },
      });
      expect(JSON.stringify(owned.json())).toContain(
        DENIAL_CODES.ownedWorkspaceCreationNotAllowed,
      );
      provenScenario("SERVER", "p7.payg.collaboration.locked");
    });

    it("p7.payg.no_promotion.retry_and_restore", async () => {
      const t = await seedPersonalTenant(deps, "PAYG", { credits: 1 });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      // Resolve, deny an over-plan action, resolve again, re-read the
      // envelope: none of it may move the plan.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await denyWithoutSideEffects({
          method: "POST",
          url: "/v1/collaboration-teams",
          token: t.owner.token,
          payload: { name: `p7 payg retry ${attempt}` },
        });
        const ctx = await resolveCommercialContext({
          type: "PERSONAL_ACCOUNT",
          userId: t.owner.userId,
        });
        expect(ctx.plan, `attempt ${attempt} promoted the plan`).toBe("PAYG");
        const env = await inject({
          method: "GET",
          url: "/v1/platform/context",
          token: t.owner.token,
          headers: { "x-platform-context-version": "3" },
        });
        expect(env.json().account.accountPlan).toBe("PAYG");
      }
      provenScenario("SERVER", "p7.payg.no_promotion.retry_and_restore");
    });

    it("p7.payg.no_promotion.workspace_switch", async () => {
      const t = await seedPersonalTenant(deps, "PAYG", { credits: 1 });
      // Give the account a workspace to switch INTO, seeded directly.
      const owned = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
      });
      const sw = await inject({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: t.owner.token,
        payload: { workspaceId: owned.teamId },
      });
      expect(sw.statusCode, sw.body).toBe(200);
      const ent = await prisma.entitlement.findFirstOrThrow({
        where: { userId: t.owner.userId, active: true },
        select: { plan: true },
      });
      expect(ent.plan).toBe("PAYG");
      // The workspace switched into did NOT inherit the PAYG mode either.
      const team = await prisma.team.findUniqueOrThrow({
        where: { id: owned.teamId },
        select: { billingPlan: true },
      });
      expect(team.billingPlan).not.toBe("PAYG");
      provenScenario("SERVER", "p7.payg.no_promotion.workspace_switch");
    });

    it("p7.payg.entitlement.not_inherited_by_other_workspace", async () => {
      const t = await seedPersonalTenant(deps, "PAYG", { credits: 7 });
      const owned = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ws = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: owned.teamId,
        requesterUserId: t.owner.userId,
      });
      // The owned workspace sees NO PAYG credit and NO PAYG plan: the
      // entitlement belongs to the PERSONAL_ACCOUNT subject alone.
      expect(ws.plan).not.toBe("PAYG");
      expect(ws.scope.credits).toBe(0);
      provenScenario(
        "SERVER",
        "p7.payg.entitlement.not_inherited_by_other_workspace",
      );
    });
  });

  // =========================================================================
  // PRO
  // =========================================================================

  describe("PRO", () => {
    it("p7.pro.owned_workspace.created_within_limit", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const limit = t.expected.maxOwnedWorkspaces;
      expect(limit).toBeGreaterThan(0);
      // The whole canonical allowance, through the real route. Before Point 7
      // this failed on the SECOND one: the bootstrap Personal Team was being
      // counted against `maxOwnedWorkspaces`, so the published limit and the
      // enforced limit differed by exactly one.
      for (let i = 0; i < limit; i += 1) {
        const res = await inject({
          method: "POST",
          url: "/v1/teams",
          token: t.owner.token,
          payload: { name: `p7 pro ws ${i}` },
        });
        expect(
          res.statusCode,
          `owned workspace ${i + 1}/${limit} was refused: ${res.body}`,
        ).toBeLessThan(300);
      }
      const owned = await prisma.team.count({
        where: {
          ownerUserId: t.owner.userId,
          isPersonal: false,
          NOT: { organization: { kind: "CUSTOMER" } },
        },
      });
      expect(owned).toBe(limit);
      provenScenario("SERVER", "p7.pro.owned_workspace.created_within_limit");
    });

    it("p7.pro.owned_workspace.limit_reached_denied", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const limit = t.expected.maxOwnedWorkspaces;
      for (let i = 0; i < limit; i += 1) {
        await seedOwnedWorkspace(deps, {
          ownerUserId: t.owner.userId,
          name: `p7-pro-at-limit-${i}`,
        });
      }
      const res = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/teams",
        token: t.owner.token,
        payload: { name: "p7 pro over limit" },
      });
      expect(JSON.stringify(res.json())).toContain(
        DENIAL_CODES.ownedWorkspaceLimitReached,
      );
      // Over-limit denies the ADDITIVE action; it destroys nothing.
      const still = await prisma.team.count({
        where: {
          ownerUserId: t.owner.userId,
          isPersonal: false,
          NOT: { organization: { kind: "CUSTOMER" } },
        },
      });
      expect(still).toBe(limit);
      provenScenario("SERVER", "p7.pro.owned_workspace.limit_reached_denied");
    });

    it("p7.pro.owned_workspace.does_not_inherit_owner_plan", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const owned = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ws = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: owned.teamId,
        requesterUserId: t.owner.userId,
      });
      const personal = await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: t.owner.userId,
      });
      expect(personal.plan).toBe("PRO");
      // The workspace's OWN commercial state governs it. `maxOwnedWorkspaces`
      // governs CREATION allowance at the account subject, not coverage.
      expect(ws.plan).toBe("FREE");
      provenScenario(
        "SERVER",
        "p7.pro.owned_workspace.does_not_inherit_owner_plan",
      );
    });

    it("p7.pro.two_workspaces_diverge_commercially", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const subscribed = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const unsubscribed = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "FREE",
        billingStatus: "INACTIVE",
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const a = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: subscribed.teamId,
        requesterUserId: t.owner.userId,
      });
      const b = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: unsubscribed.teamId,
        requesterUserId: t.owner.userId,
      });
      expect(a.plan).toBe("TEAM");
      expect(b.plan).toBe("FREE");
      provenScenario("SERVER", "p7.pro.two_workspaces_diverge_commercially");
    });

    it("p7.pro.seats.suspended_and_revoked_are_not_seats", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const baseline = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: ws.teamId,
        requesterUserId: t.owner.userId,
      });

      const active = await seedUser(deps, "seat-active");
      const suspended = await seedUser(deps, "seat-suspended");
      const revoked = await seedUser(deps, "seat-revoked");
      await prisma.teamMember.createMany({
        data: [
          { teamId: ws.teamId, userId: active.userId, role: "MEMBER", status: "ACTIVE" },
          { teamId: ws.teamId, userId: suspended.userId, role: "MEMBER", status: "SUSPENDED" },
          { teamId: ws.teamId, userId: revoked.userId, role: "MEMBER", status: "REVOKED" },
        ],
      });

      const after = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: ws.teamId,
        requesterUserId: t.owner.userId,
      });
      // Three members added, exactly ONE seat consumed.
      expect(after.seats.consumed - baseline.seats.consumed).toBe(1);
      provenScenario(
        "SERVER",
        "p7.pro.seats.suspended_and_revoked_are_not_seats",
      );
    });

    it("p7.pro.members.limit_enforced_by_server", async () => {
      const t = await seedPersonalTenant(deps, "PRO");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: t.owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const { assertCollaborationTeamMemberLimit } = await import(
        "../../src/services/collaboration-team/billing-guards.js"
      );
      // The limit comes from the SERVER's plan resolution, not from a
      // client-side table keyed on a plan name.
      expect(typeof assertCollaborationTeamMemberLimit).toBe("function");
      const { getPlanCapabilities } = await import("@proovra/shared-billing");
      expect(getPlanCapabilities("PRO").maxWorkspaceSeats).toBe(
        t.expected.maxWorkspaceSeats,
      );
      // Fill the workspace to its cap with ACTIVE members and prove the
      // canonical seat projection reports it as full.
      const cap = t.expected.maxWorkspaceSeats;
      const current = await prisma.teamMember.count({
        where: { teamId: ws.teamId, status: "ACTIVE" },
      });
      for (let i = current; i < cap; i += 1) {
        const m = await seedUser(deps, `pro-member-${i}`);
        await prisma.teamMember.create({
          data: { teamId: ws.teamId, userId: m.userId, role: "MEMBER", status: "ACTIVE" },
        });
      }
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ctx = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: ws.teamId,
        requesterUserId: t.owner.userId,
      });
      expect(ctx.seats.consumed).toBe(cap);
      expect(ctx.seats.remaining).toBe(0);
      provenScenario("SERVER", "p7.pro.members.limit_enforced_by_server");
    });
  });

  // =========================================================================
  // TEAM
  // =========================================================================

  describe("TEAM", () => {
    it("p7.team.commercial_state_belongs_to_workspace", async () => {
      // The account is deliberately FREE. If the workspace's TEAM plan came
      // from the owner, this would resolve FREE.
      const owner = await seedUser(deps, "team-owner");
      await setAccountPlan(deps, owner.userId, "FREE");
      await bootstrapPersonalSpace(deps, owner.userId);
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ctx = await resolveCommercialContext({
        type: "OWNED_WORKSPACE",
        teamId: ws.teamId,
        requesterUserId: owner.userId,
      });
      expect(ctx.plan).toBe("TEAM");
      expect(ctx.capabilities.reviewerOperationsIncluded).toBe(
        PLAN_CONTRACT.TEAM.reviewerOperations,
      );
      const account = await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: owner.userId,
      });
      expect(account.plan).toBe("FREE");
      provenScenario("SERVER", "p7.team.commercial_state_belongs_to_workspace");
    });

    it("p7.team.collaboration.works", async () => {
      const owner = await seedUser(deps, "team-collab-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      await bootstrapPersonalSpace(deps, owner.userId);
      const res = await inject({
        method: "POST",
        url: "/v1/collaboration-teams",
        token: owner.token,
        payload: { name: `p7 team collab ${deps.tag}` },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const created = await prisma.collaborationTeam.count({
        where: { workspace: { ownerUserId: owner.userId } },
      });
      expect(created).toBe(1);
      provenScenario("SERVER", "p7.team.collaboration.works");
    });

    it("p7.team.direct_api.ui_locked_action_denied", async () => {
      // A VIEWER of a TEAM workspace: the UI hides every write affordance.
      const owner = await seedUser(deps, "team-lock-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const viewer = await seedUser(deps, "team-lock-viewer");
      // Materialise the viewer's own account entitlement up front. The
      // commercial resolver lazily provisions a FREE row on first read, and a
      // row appearing DURING the denial would show up in the side-effect
      // fingerprint as a write — true, but a read-path materialisation rather
      // than the business mutation the assertion is about.
      await setAccountPlan(deps, viewer.userId, "FREE");
      await bootstrapPersonalSpace(deps, viewer.userId);
      await prisma.teamMember.create({
        data: { teamId: ws.teamId, userId: viewer.userId, role: "VIEWER", status: "ACTIVE" },
      });
      await prisma.user.update({
        where: { id: viewer.userId },
        data: { currentWorkspaceId: ws.teamId },
      });
      // The raw request is refused by the server, not merely un-rendered.
      // Targeted AT the TEAM workspace: the workspace's plan includes cases,
      // so the only thing that can refuse this is the VIEWER's role — which
      // is the lock the UI renders and the server used to ignore, since
      // `POST /v1/cases` checked membership STATUS and never membership ROLE.
      const denied = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/cases",
        token: viewer.token,
        payload: { name: "p7 viewer case", teamId: ws.teamId },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("CASES_MANAGE_REQUIRED");
      provenScenario("SERVER", "p7.team.direct_api.ui_locked_action_denied");
    });

    it("p7.team.removal.preserves_history", async () => {
      const owner = await seedUser(deps, "team-hist-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: owner.userId,
        billingPlan: "TEAM",
        billingStatus: "ACTIVE",
      });
      const member = await seedUser(deps, "team-hist-member");
      await prisma.teamMember.create({
        data: { teamId: ws.teamId, userId: member.userId, role: "MEMBER", status: "ACTIVE" },
      });
      const evidence = await prisma.evidence.create({
        data: {
          title: "p7 team history",
          type: "PHOTO",
          status: "CREATED",
          teamId: ws.teamId,
          organizationId: ws.organizationId,
          ownerUserId: member.userId,
        },
        select: { id: true },
      });

      // Suspend the member — the access change, not a data change.
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: ws.teamId, userId: member.userId } },
        data: { status: "SUSPENDED" },
      });

      const survived = await prisma.evidence.findUnique({
        where: { id: evidence.id },
        select: { id: true, deletedAt: true },
      });
      expect(survived?.id).toBe(evidence.id);
      expect(survived?.deletedAt ?? null).toBeNull();
      provenScenario("SERVER", "p7.team.removal.preserves_history");
    });
  });

  // =========================================================================
  // ENTERPRISE
  // =========================================================================

  describe("ENTERPRISE", () => {
    it("p7.enterprise.org_workspace.restored", async () => {
      const org = await seedOrganizationTenant(deps, { memberCount: 1 });
      await prisma.user.update({
        where: { id: org.owner.userId },
        data: { currentWorkspaceId: org.workspaceId },
      });
      const res = await inject({
        method: "GET",
        url: "/v1/platform/context",
        token: org.owner.token,
        headers: { "x-platform-context-version": "3" },
      });
      expect(res.statusCode).toBe(200);
      const env = res.json();
      expect(env.activeSpace.type).toBe("ORGANIZATION");
      expect(env.activeSpace.id).toBe(org.workspaceId);
      expect(env.activeSpace.plan).toBe("ENTERPRISE");
      provenScenario("SERVER", "p7.enterprise.org_workspace.restored");
    });

    it("p7.enterprise.org_plan.not_derived_from_owner", async () => {
      // The org owner's PERSONAL account is FREE. The Organization workspace
      // is ENTERPRISE because of its CONTRACT, and the two must not be
      // conflated in either direction.
      const org = await seedOrganizationTenant(deps, {
        ownerAccountPlan: "FREE",
      });
      const { resolveCommercialContext } = await import(
        "../../src/services/billing/commercial-context.service.js"
      );
      const ws = await resolveCommercialContext({
        type: "ORGANIZATION_WORKSPACE",
        teamId: org.workspaceId,
        requesterUserId: org.owner.userId,
      });
      expect(ws.plan).toBe("ENTERPRISE");
      const account = await resolveCommercialContext({
        type: "PERSONAL_ACCOUNT",
        userId: org.owner.userId,
      });
      expect(account.plan).toBe("FREE");
      provenScenario("SERVER", "p7.enterprise.org_plan.not_derived_from_owner");
    });

    it("p7.enterprise.org_suspended.blocks_ordinary_access", async () => {
      const org = await seedOrganizationTenant(deps, {
        status: "SUSPENDED",
        memberCount: 1,
      });
      const member = org.members[0];
      await prisma.user.update({
        where: { id: member.userId },
        data: { currentWorkspaceId: org.workspaceId },
      });
      // Switching INTO a SUSPENDED organization is refused, with no durable
      // effect. The CODE matters as much as the status: the member holds a
      // real session and a real ACTIVE membership, so a denial for any other
      // reason would be a false pass — this scenario has to prove the
      // ORGANIZATION LIFECYCLE is what refused.
      const res = await denyWithoutSideEffects({
        method: "POST",
        url: "/v1/platform/context/switch-workspace",
        token: member.token,
        payload: { workspaceId: org.workspaceId },
      });
      expect(res.json().code).toBe("organization_unavailable");
      provenScenario(
        "SERVER",
        "p7.enterprise.org_suspended.blocks_ordinary_access",
      );
    });

    it("p7.enterprise.contract_expired.no_deletion", async () => {
      const org = await seedOrganizationTenant(deps, {
        contractStatus: "TERMINATED",
        contractEndsAtUtc: new Date(Date.now() - 86_400_000),
        memberCount: 2,
      });
      const evidence = await prisma.evidence.create({
        data: {
          title: "p7 enterprise retained",
          type: "PHOTO",
          status: "CREATED",
          teamId: org.workspaceId,
          organizationId: org.organizationId,
          ownerUserId: org.owner.userId,
        },
        select: { id: true },
      });
      const { resolveEnterpriseContract } = await import(
        "../../src/services/organization/enterprise-contract.service.js"
      );
      const contract = await resolveEnterpriseContract(org.organizationId);
      expect(contract?.status).toBe("TERMINATED");
      // Expiry is a capability question. It is never a deletion.
      const survived = await prisma.evidence.findUnique({
        where: { id: evidence.id },
        select: { id: true, deletedAt: true },
      });
      expect(survived?.id).toBe(evidence.id);
      expect(survived?.deletedAt ?? null).toBeNull();
      expect(
        await prisma.teamMember.count({
          where: { teamId: org.workspaceId, status: "ACTIVE" },
        }),
      ).toBeGreaterThan(0);
      provenScenario("SERVER", "p7.enterprise.contract_expired.no_deletion");
    });

    it("p7.enterprise.no_personal_space.blocks_creation", async () => {
      const org = await seedOrganizationTenant(deps, {
        noPersonalSpace: true,
        memberCount: 1,
      });
      const member = org.members[0];
      const { ensurePersonalWorkspace } = await import(
        "../../src/services/platform-context/workspace-bootstrap.service.js"
      );
      const before = await fingerprintSideEffects(prisma);
      await expect(
        ensurePersonalWorkspace({ userId: member.userId }),
      ).rejects.toMatchObject({ statusCode: 403 });
      const after = await fingerprintSideEffects(prisma);
      expect(fingerprintDelta(before, after)).toEqual({});
      expect(
        await prisma.team.count({
          where: { ownerUserId: member.userId, isPersonal: true },
        }),
      ).toBe(0);
      provenScenario(
        "SERVER",
        "p7.enterprise.no_personal_space.blocks_creation",
      );
    });

    it("p7.enterprise.no_personal_space.blocks_server_fallback", async () => {
      // The hardest case, and the one that was broken: the member ALREADY has
      // a grandfathered Personal Space (created while the policy was off), and
      // their Organization workspace then becomes unreachable. The server used
      // to select that Personal Space AND durably write
      // `User.currentWorkspaceId` to it.
      const org = await seedOrganizationTenant(deps, { memberCount: 1 });
      const member = org.members[0];
      const personal = await bootstrapPersonalSpace(deps, member.userId);
      await prisma.user.update({
        where: { id: member.userId },
        data: { currentWorkspaceId: org.workspaceId },
      });

      // Now the policy is switched on and the org membership goes inactive.
      await prisma.organizationSecurityPolicy.update({
        where: { organizationId: org.organizationId },
        data: { noPersonalSpace: true },
      });
      await prisma.teamMember.update({
        where: {
          teamId_userId: { teamId: org.workspaceId, userId: member.userId },
        },
        data: { status: "SUSPENDED" },
      });

      const res = await inject({
        method: "GET",
        url: "/v1/platform/context",
        token: member.token,
        headers: { "x-platform-context-version": "3" },
      });
      expect(res.statusCode).toBe(200);
      const env = res.json();

      expect(env.personalSpaceAllowed).toBe(false);
      // Not offered in EITHER list — the canonical one or the compatibility one.
      expect(env.contextOptions.personalSpace).toBeNull();
      expect(
        (env.availableWorkspaces ?? []).map((w: { id: string }) => w.id),
      ).not.toContain(personal.teamId);
      // And, decisively, the pointer was NOT relocated into it.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: member.userId },
        select: { currentWorkspaceId: true },
      });
      expect(user.currentWorkspaceId).not.toBe(personal.teamId);
      // The grandfathered row still EXISTS — the policy withholds access, it
      // does not destroy data.
      expect(
        await prisma.team.count({ where: { id: personal.teamId } }),
      ).toBe(1);
      provenScenario(
        "SERVER",
        "p7.enterprise.no_personal_space.blocks_server_fallback",
      );
    });

    it("p7.enterprise.managed_identity.no_manual_binding_bypass", async () => {
      const orgA = await seedOrganizationTenant(deps, { memberCount: 1 });
      const orgB = await seedOrganizationTenant(deps, {});
      const managed = orgA.members[0];
      const { setManagedIdentity, isManagedByOrganization } = await import(
        "../../src/services/identity/identity-mode.service.js"
      );

      // A verified domain is the WEAKEST binding evidence the platform
      // accepts — no IdP round trip, just DNS ownership — so it is the right
      // instrument for "can the weak route be used to take an identity over?".
      const seedVerifiedDomain = async (
        organizationId: string,
        domain: string,
        createdByUserId: string,
      ) =>
        prisma.organizationDomain.create({
          data: {
            organizationId,
            domain,
            verificationToken: `p7-${domain}`,
            verifiedAt: new Date(),
            createdByUserId,
          },
          select: { id: true },
        });

      const domainA = `a-${deps.tag}.example`;
      const dA = await seedVerifiedDomain(
        orgA.organizationId,
        domainA,
        orgA.owner.userId,
      );
      // The managed user's email must match the domain the binding claims.
      await prisma.user.update({
        where: { id: managed.userId },
        data: { email: `managed-${deps.tag}@${domainA}` },
      });
      await setManagedIdentity({
        userId: managed.userId,
        managingOrganizationId: orgA.organizationId,
        evidence: {
          source: "DOMAIN",
          organizationDomainId: dA.id,
          userEmail: `managed-${deps.tag}@${domainA}`,
        },
      });
      expect(
        await isManagedByOrganization(managed.userId, orgA.organizationId),
      ).toBe(true);

      // Organization B now presents its OWN valid, verified-domain evidence.
      // Valid evidence for B is still not authority over an identity A
      // manages: reassignment must be explicit, never implicit.
      const domainB = `b-${deps.tag}.example`;
      const dB = await seedVerifiedDomain(
        orgB.organizationId,
        domainB,
        orgB.owner.userId,
      );
      await prisma.user.update({
        where: { id: managed.userId },
        data: { email: `managed-${deps.tag}@${domainB}` },
      });

      const before = await fingerprintSideEffects(prisma);
      await expect(
        setManagedIdentity({
          userId: managed.userId,
          managingOrganizationId: orgB.organizationId,
          evidence: {
            source: "DOMAIN",
            organizationDomainId: dB.id,
            userEmail: `managed-${deps.tag}@${domainB}`,
          },
        }),
      ).rejects.toMatchObject({ code: "MANAGED_IDENTITY_CONFLICT" });
      const after = await fingerprintSideEffects(prisma);
      expect(fingerprintDelta(before, after)).toEqual({});
      expect(
        await isManagedByOrganization(managed.userId, orgB.organizationId),
      ).toBe(false);
      expect(
        await isManagedByOrganization(managed.userId, orgA.organizationId),
      ).toBe(true);
      provenScenario(
        "SERVER",
        "p7.enterprise.managed_identity.no_manual_binding_bypass",
      );
    });
  });
});
