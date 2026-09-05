/**
 * ONE EVIDENCE RECORD, ONE PAYER — across every commercial context, against
 * live PostgreSQL 16.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * Reproduced against the local fixture stack on 2026-09-05. A Personal PRO
 * account at its 100-record cap holding 3 evidence credits:
 *
 *   POST /v1/evidence            201
 *   PUT  <presigned>             200
 *   POST /v1/evidence/:id/complete   402 INSUFFICIENT_EVIDENCE_CREDITS
 *
 * The wallet still read 3. The record stranded in UPLOADING. A purchased
 * credit was admitted at creation and unspendable at completion.
 *
 * The two phases resolve the same subject through different builders:
 * `createEvidence` asks with `teamId: null` for a personal capture, and
 * `completeEvidence` asks with `evidence.teamId` — which since
 * HOME-DATA-OWNERSHIP is never null, because a personal record carries its
 * owner's personal Team id. `getTeamWorkspaceScope` hard-coded `credits: 0`.
 * A runtime probe printed the disagreement exactly:
 *
 *   CREATE    billingShape=SINGLE_OCCUPANT plan=PRO credits=3 teamId=null
 *   COMPLETE  billingShape=SINGLE_OCCUPANT plan=PRO credits=0 teamId=4d799dbf
 *
 * Same shape, same plan, same owner — only the wallet differed.
 *
 * WHAT IS PINNED
 * ---------------------------------------------------------------------------
 * The invariant, not the instance: for any Evidence record, the COMMERCIAL
 * PRINCIPAL resolved at admission must equal the one resolved at funding. A
 * balance that disagrees is a refusal a customer can see; a PRINCIPAL that
 * disagrees would not surface at all — it would succeed, and bill somebody
 * else.
 *
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * Records are created through `POST /v1/evidence` on the booted app. Scopes
 * come from `resolveEnforcementScopeForRequester` — the production resolver,
 * with the production inputs — never from a stub. Funding is driven through
 * `settleEvidenceCompletionFunding` inside a real interactive transaction,
 * exactly as `completeEvidence` invokes it, against the real entitlement row
 * and the real credit ledger.
 *
 * WHAT IS NOT COVERED HERE, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * Object-store reads, hashing, signing and timestamping are not stood up —
 * they do not participate in the funding decision. The complete journey
 * (create → presign → upload → complete → SIGNED, one credit consumed) is
 * proven separately against the local fixture stack with MinIO.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
  type OrganizationTenant,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

describe("EVIDENCE FUNDING — one record, one payer (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;

  let resolveScope: typeof import("../src/services/billing-enforcement.service.js")["resolveEnforcementScopeForRequester"];
  let settle: typeof import("../src/services/billing-enforcement.service.js")["settleEvidenceCompletionFunding"];
  let principalOf: typeof import("../src/services/workspace-billing.service.js")["commercialPrincipalOf"];

  const inject = (opts: { url: string; token: string; payload?: unknown }) =>
    harness.app.inject({
      method: "POST",
      url: opts.url,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(opts.payload ? { "content-type": "application/json" } : {}),
      },
      ...(opts.payload ? { payload: opts.payload as never } : {}),
    });

  /** Create one record through the real route. Returns the raw reply. */
  const create = (token: string, teamId?: string) =>
    inject({
      url: "/v1/evidence",
      token,
      payload: {
        type: "DOCUMENT",
        mimeType: "text/plain",
        ...(teamId ? { teamId } : {}),
      },
    });

  /**
   * The scope `completeEvidence` builds: from the PERSISTED row, never from
   * what the caller happened to have in hand.
   */
  async function completionScope(evidenceId: string) {
    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { ownerUserId: true, teamId: true },
    });
    return resolveScope({ ownerUserId: ev.ownerUserId, teamId: ev.teamId });
  }

  /** Settle exactly as completeEvidence does: inside an interactive tx. */
  const settleOne = async (evidenceId: string) => {
    const scope = await completionScope(evidenceId);
    return prisma.$transaction((tx) => settle({ scope, evidenceId }, tx as never));
  };

  const creditsOf = async (userId: string) =>
    (
      await prisma.entitlement.findFirst({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
        select: { credits: true },
      })
    )?.credits ?? 0;

  const consumptionsFor = (evidenceId: string) =>
    prisma.evidenceCreditLedgerEntry.count({
      where: { evidenceId, entryType: "CONSUMPTION" },
    });

  /** Bank credits the way the canonical writer does: balance + ledger, together. */
  async function bankCredits(userId: string, credits: number) {
    await prisma.$transaction(async (tx) => {
      const ent = await tx.entitlement.findFirstOrThrow({
        where: { userId, active: true },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const updated = await tx.entitlement.update({
        where: { id: ent.id },
        data: { credits: { increment: credits } },
        select: { credits: true },
      });
      await tx.evidenceCreditLedgerEntry.create({
        data: {
          userId,
          entryType: "PURCHASE",
          creditsDelta: credits,
          provider: "STRIPE",
          providerRef: `fixture-${userId}-${Date.now()}-${Math.random()}`,
          balanceAfter: updated.credits,
        },
      });
    });
  }

  /** Hold exactly `count` records against the personal enforcement predicate. */
  async function holdExactly(t: PersonalTenant, count: number) {
    const have = await prisma.evidence.count({
      where: {
        ownerUserId: t.owner.userId,
        deletedAt: null,
        lifecycleState: { not: "DESTROYED" },
        OR: [{ teamId: null }, { teamId: t.personalTeamId }],
      },
    });
    if (have < count) {
      await prisma.evidence.createMany({
        data: Array.from({ length: count - have }, () => ({
          ownerUserId: t.owner.userId,
          teamId: t.personalTeamId,
          organizationId: t.personalOrganizationId,
          type: "PHOTO" as const,
        })),
      });
    }
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({
      resolveEnforcementScopeForRequester: resolveScope,
      settleEvidenceCompletionFunding: settle,
    } = await import("../src/services/billing-enforcement.service.js"));
    ({ commercialPrincipalOf: principalOf } = await import(
      "../src/services/workspace-billing.service.js"
    ));

    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `efp-${Date.now().toString(36)}`,
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
    await harness?.cleanup?.();
  });

  // =========================================================================
  // THE INVARIANT, at the resolver.
  // =========================================================================
  describe("the same subject resolves to the same principal from either input", () => {
    it("a Personal Space reached by user id and by team id is ONE payer", async () => {
      const t = await seedPersonalTenant(deps, "PRO");

      // The two inputs the two lifecycle phases actually use.
      const byUser = await resolveScope({ ownerUserId: t.owner.userId, teamId: null });
      const byTeam = await resolveScope({
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
      });

      expect(principalOf(byUser)).toBe(`PERSONAL:${t.owner.userId}`);
      expect(principalOf(byTeam)).toBe(principalOf(byUser));

      /*
       * And the wallet travels with the payer. This is the assertion the bug
       * failed: everything else already agreed.
       */
      await bankCredits(t.owner.userId, 4);
      const afterByUser = await resolveScope({ ownerUserId: t.owner.userId, teamId: null });
      const afterByTeam = await resolveScope({
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
      });
      expect(afterByUser.credits).toBe(4);
      expect(afterByTeam.credits).toBe(4);
      expect(afterByTeam.billingShape).toBe("SINGLE_OCCUPANT");
    });

    it("a personal storage add-on is visible from either input too", async () => {
      /*
       * The STORAGE twin of the wallet defect, found in the same audit.
       * `workspace_storage_addons` is keyed (owner_user_id, team_id) and a
       * personal add-on is bought with no team, so its row carries a NULL
       * team id. Asking by team id used to match nothing — the allowance
       * shrank between admission and completion, and a customer who had paid
       * for extra storage watched an upload finish and then fail.
       */
      const t = await seedPersonalTenant(deps, "PRO");
      await prisma.workspaceStorageAddon.create({
        data: {
          ownerUserId: t.owner.userId,
          teamId: null,
          addonKey: "PERSONAL_10_GB",
          extraStorageBytes: 10n * 1024n * 1024n * 1024n,
          status: "ACTIVE",
          billingCycle: "MONTHLY",
          paymentProvider: "STRIPE",
        },
      });

      const byUser = await resolveScope({ ownerUserId: t.owner.userId, teamId: null });
      const byTeam = await resolveScope({
        ownerUserId: t.owner.userId,
        teamId: t.personalTeamId,
      });
      expect(byUser.activeStorageAddonBytes).toBe(10n * 1024n * 1024n * 1024n);
      expect(byTeam.activeStorageAddonBytes).toBe(byUser.activeStorageAddonBytes);
    });
    it("a shared workspace is the payer, never the member who uploaded", async () => {
      const member = await seedUser(deps, "team-member");
      await setAccountPlan(deps, member.userId, "PRO");
      await bankCredits(member.userId, 5);

      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: member.userId,
        billingPlan: "TEAM",
      });
      const scope = await resolveScope({
        ownerUserId: member.userId,
        teamId: ws.teamId,
      });

      expect(scope.billingShape).toBe("SHARED");
      expect(principalOf(scope)).toBe(`WORKSPACE:${ws.teamId}`);
      /*
       * THE RULE THAT PROTECTS THE CUSTOMER. A member holding five personal
       * credits must not fund shared workspace evidence with them. The wallet
       * is absent from a SHARED scope by construction, so there is nothing for
       * the admission or settlement paths to spend.
       */
      expect(scope.credits).toBe(0);
    });
  });

  // =========================================================================
  // PERSONAL PRO — the matrix.
  //
  // The cap is set through the canonical grandfather override rather than by
  // creating a hundred records: the override is interpreted by the same
  // envelope the published cap goes through (`effectiveLifetimeRecordCap`), so
  // the boundary under test is identical and the suite stays fast. The
  // published cap of 100 is proven end-to-end against the fixture stack.
  // =========================================================================
  describe("Personal PRO", () => {
    const CAP = 2;

    async function proTenantAtCap(records: number, credits: number) {
      const t = await seedPersonalTenant(deps, "PRO", {
        legacyRecordCapOverride: CAP,
      });
      await holdExactly(t, records);
      if (credits > 0) await bankCredits(t.owner.userId, credits);
      return t;
    }

    it("A. below the cap with no credits — created and funded by the PLAN", async () => {
      const t = await proTenantAtCap(CAP - 1, 0);
      const res = await create(t.owner.token, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const settled = await settleOne(id);
      expect(settled.funding).toBe("PLAN");
      expect(await consumptionsFor(id)).toBe(0);
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });

    it("B. at the cap with no credits — refused at creation", async () => {
      const t = await proTenantAtCap(CAP, 0);
      const res = await create(t.owner.token, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as { code?: string; error?: { code?: string } };
      expect(body.code ?? body.error?.code).toBe("EVIDENCE_RECORD_LIMIT_REACHED");
    });

    it("C. at the cap WITH credits — created, funded by a credit, exactly one spent", async () => {
      const t = await proTenantAtCap(CAP, 2);
      const res = await create(t.owner.token, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      // The two phases agree about who pays.
      const createScope = await resolveScope({ ownerUserId: t.owner.userId, teamId: null });
      const completeScope = await completionScope(id);
      expect(principalOf(completeScope)).toBe(principalOf(createScope));

      const settled = await settleOne(id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(1);
      expect(await consumptionsFor(id)).toBe(1);

      const entry = await prisma.evidenceCreditLedgerEntry.findUniqueOrThrow({
        where: { evidenceId: id },
        select: { creditsDelta: true, balanceAfter: true, userId: true },
      });
      expect(entry.creditsDelta).toBe(-1);
      expect(entry.balanceAfter).toBe(1);
      // Charged to the PRINCIPAL, which for a Personal Space is the person.
      expect(entry.userId).toBe(t.owner.userId);
    });

    it("D. settling the same record twice spends one credit, not two", async () => {
      const t = await proTenantAtCap(CAP, 2);
      const res = await create(t.owner.token, t.personalTeamId);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const first = await settleOne(id);
      const second = await settleOne(id);
      expect(first.funding).toBe("EVIDENCE_CREDIT");
      expect(second.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(1);
      expect(await consumptionsFor(id)).toBe(1);
    });

    it("E. a completion that rolls back after settling burns nothing", async () => {
      const t = await proTenantAtCap(CAP, 2);
      const res = await create(t.owner.token, t.personalTeamId);
      const id = (JSON.parse(res.body) as { id: string }).id;

      await expect(
        prisma.$transaction(async (tx) => {
          await settle({ scope: await completionScope(id), evidenceId: id }, tx as never);
          // Whatever fails after the spend — signing, storage, the custody
          // write — takes the spend with it.
          throw new Error("completion failed after settlement");
        }),
      ).rejects.toThrow("completion failed after settlement");

      expect(await creditsOf(t.owner.userId)).toBe(2);
      expect(await consumptionsFor(id)).toBe(0);
    });
  });

  // =========================================================================
  // PERSONAL FREE — a credit legally extends it, and always could.
  // =========================================================================
  describe("Personal FREE", () => {
    it("at the published 3-record cap, a banked credit funds the fourth", async () => {
      const t = await seedPersonalTenant(deps, "FREE");
      await holdExactly(t, 3);

      const refused = await create(t.owner.token, t.personalTeamId);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(
        (JSON.parse(refused.body) as { code?: string }).code,
      ).toBe("FREE_LIMIT_REACHED");

      await bankCredits(t.owner.userId, 1);
      const allowed = await create(t.owner.token, t.personalTeamId);
      expect(allowed.statusCode, allowed.body).toBe(201);
      const id = (JSON.parse(allowed.body) as { id: string }).id;

      const settled = await settleOne(id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(0);
    });
  });

  // =========================================================================
  // PAYG — the legacy resolution row. No free allowance at all.
  // =========================================================================
  describe("PAYG (legacy resolution row)", () => {
    it("with no credits, the FIRST record is refused — there is no allowance", async () => {
      const t = await seedPersonalTenant(deps, "PAYG");
      const res = await create(t.owner.token, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(402);
      expect((JSON.parse(res.body) as { code?: string; error?: { code?: string } }).code ??
        (JSON.parse(res.body) as { error?: { code?: string } }).error?.code)
        .toBe("INSUFFICIENT_EVIDENCE_CREDITS");
    });

    it("with a credit, the record is created AND fundable", async () => {
      /*
       * This is the case the scope bug broke hardest. PAYG has no free
       * allowance, so EVERY completion is credit-funded — and with the wallet
       * absent at completion, admission passed and settlement then refused
       * every single record. A PAYG account could not finish anything.
       */
      const t = await seedPersonalTenant(deps, "PAYG");
      await bankCredits(t.owner.userId, 1);

      const res = await create(t.owner.token, t.personalTeamId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const settled = await settleOne(id);
      expect(settled.funding).toBe("EVIDENCE_CREDIT");
      expect(await creditsOf(t.owner.userId)).toBe(0);
      expect(await consumptionsFor(id)).toBe(1);
    });
  });

  // =========================================================================
  // SHARED WORKSPACES — the member's wallet is not the workspace's wallet.
  // =========================================================================
  describe("shared workspaces", () => {
    it("TEAM: workspace evidence is funded by the workspace, not the uploader", async () => {
      const owner = await seedUser(deps, "team-owner");
      await setAccountPlan(deps, owner.userId, "TEAM");
      await bankCredits(owner.userId, 3);
      const ws = await seedOwnedWorkspace(deps, {
        ownerUserId: owner.userId,
        billingPlan: "TEAM",
        // The workspace pays for itself, and only an ACTIVE subscription makes
        // its TEAM plan effective — an inactive one resolves to FREE, which is
        // the shared-workspace gate, not the funding question under test.
        billingStatus: "ACTIVE",
      });

      const res = await create(owner.token, ws.teamId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const scope = await completionScope(id);
      expect(principalOf(scope)).toBe(`WORKSPACE:${ws.teamId}`);

      const settled = await settleOne(id);
      expect(settled.funding).toBe("PLAN");
      // The personal wallet is untouched — three credits in, three credits out.
      expect(await creditsOf(owner.userId)).toBe(3);
      expect(await consumptionsFor(id)).toBe(0);
    });

    it("ORGANIZATION: an Enterprise workspace never reaches the retail wallet", async () => {
      const org: OrganizationTenant = await seedOrganizationTenant(deps, {
        billingPlan: "ENTERPRISE",
        ownerAccountPlan: "FREE",
      });
      await bankCredits(org.owner.userId, 2);

      const res = await create(org.owner.token, org.workspaceId);
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { id: string }).id;

      const scope = await completionScope(id);
      expect(scope.billingShape).toBe("SHARED");
      expect(principalOf(scope)).toBe(`WORKSPACE:${org.workspaceId}`);

      const settled = await settleOne(id);
      expect(settled.funding).toBe("PLAN");
      expect(await creditsOf(org.owner.userId)).toBe(2);
      expect(await consumptionsFor(id)).toBe(0);
    });
  });

  // =========================================================================
  // THE GUARD — funding a record with somebody else's scope is a fault.
  // =========================================================================
  it("refuses to fund a record with a scope that is not its payer", async () => {
    const a = await seedPersonalTenant(deps, "PRO");
    const b = await seedPersonalTenant(deps, "PRO");
    const res = await create(a.owner.token, a.personalTeamId);
    const id = (JSON.parse(res.body) as { id: string }).id;

    const wrongScope = await resolveScope({ ownerUserId: b.owner.userId, teamId: null });
    await expect(
      prisma.$transaction((tx) =>
        settle({ scope: wrongScope, evidenceId: id }, tx as never),
      ),
    ).rejects.toThrow(/funding scope does not match/i);
    expect(await consumptionsFor(id)).toBe(0);
  });
});
