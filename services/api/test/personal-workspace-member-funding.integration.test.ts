/**
 * F-01 (Free-user audit, 2026-11-13) — a member's capture in somebody else's
 * Personal workspace is the WORKSPACE's record, counted and funded once.
 *
 * THE DEFECT THIS PINS
 * ---------------------------------------------------------------------------
 * A Pro/Team owner's workspace is their Personal Team (`isPersonal`, billing
 * shape SINGLE_OCCUPANT) with other people's memberships in it. A Free person
 * holding the Member role (which carries `evidence.create`) could create and
 * upload there, and then:
 *
 *   - sealing failed 500 "Evidence funding scope does not match the record":
 *     settlement compared the scope's payer (the OWNER) with the record's
 *     `ownerUserId` (the MEMBER, kept as submitter attribution);
 *   - the record was counted in nobody's allowance: the personal population
 *     was `ownerUserId = owner AND team in (NULL, owner's team)`, so the
 *     member's row fell outside the owner's count, and outside the member's
 *     own count because it does not live in the member's Personal Space.
 *
 * THE RULE
 * ---------------------------------------------------------------------------
 * Create, reservation, quota counting and sealing answer to ONE population —
 * the workspace's canonical evidence population (`evidenceScopeFor`, the one
 * storage already counts): every record in the owner's Personal Team plus the
 * owner's legacy NULL-team rows. The payer is the owner (their allowance, then
 * their credits). The submitter stays `ownerUserId = member`.
 *
 * WHAT IS REAL: PostgreSQL 16, the API over HTTP (create, part, presigned PUT,
 * complete), MinIO, the signer, the capacity lock and settlement. DOUBLED: the
 * RFC 3161 authority.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  seedUser,
  setAccountPlan,
  type FixtureDeps,
  type PersonalTenant,
} from "./point7/product-fixtures.js";

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

describe("F-01 — members of a Personal workspace capture on the owner's allowance (Postgres + MinIO, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let countHeld: (typeof import("../src/services/billing-enforcement.service.js"))["countPersonalEvidenceRecords"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ countPersonalEvidenceRecords: countHeld } = await import("../src/services/billing-enforcement.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `pwm-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const call = (method: "POST", url: string, token: string, payload?: unknown, teamId?: string) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(teamId ? { "x-proovra-workspace-id": teamId } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const create = (token: string, teamId: string) =>
    call("POST", "/v1/evidence", token, { type: "DOCUMENT", mimeType: "text/plain", teamId }, teamId);

  async function upload(token: string, id: string, teamId: string) {
    const bytes = Buffer.from(`pwm-${id}-${randomBytes(8).toString("hex")}`);
    const part = await call(
      "POST",
      `/v1/evidence/${id}/parts`,
      token,
      { partIndex: 0, mimeType: "text/plain", originalFileName: "member.txt", sizeBytes: bytes.length },
      teamId,
    );
    expect(part.statusCode, part.body).toBe(201);
    const put = await fetch(part.json().upload.putUrl as string, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "text/plain" },
    });
    expect(put.status, await put.text()).toBe(200);
  }

  const finalize = (token: string, id: string, teamId: string) =>
    call("POST", `/v1/evidence/${id}/complete`, token, {}, teamId);

  async function captureSealed(token: string, teamId: string): Promise<string> {
    const created = await create(token, teamId);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    await upload(token, id, teamId);
    const done = await finalize(token, id, teamId);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe("SIGNED");
    return id;
  }

  const creditsOf = async (userId: string) =>
    (await prisma.entitlement.findFirstOrThrow({ where: { userId, active: true }, select: { credits: true } })).credits;

  async function bankCredits(userId: string, credits: number) {
    await prisma.$transaction(async (tx) => {
      const ent = await tx.entitlement.findFirstOrThrow({ where: { userId, active: true }, select: { id: true } });
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
          providerRef: `pwm-${userId}-${Date.now()}-${Math.random()}`,
          balanceAfter: updated.credits,
        },
      });
    });
  }

  async function join(owner: PersonalTenant, userId: string, role: "MEMBER" | "VIEWER") {
    await prisma.teamMember.create({
      data: { teamId: owner.personalTeamId, userId, role, status: "ACTIVE" },
    });
  }

  /** A PRO owner whose allowance is `cap` (the canonical grandfather override keeps the suite fast). */
  async function proOwnerWithFreeMember(cap: number) {
    const owner = await seedPersonalTenant(deps, "PRO", { legacyRecordCapOverride: cap });
    const member = await seedPersonalTenant(deps, "FREE");
    await join(owner, member.owner.userId, "MEMBER");
    return { owner, member };
  }

  it("owner and Free member both seal; every record counts once, in the owner's allowance; the member's Personal allowance is untouched", async () => {
    const { owner, member } = await proOwnerWithFreeMember(3);
    const ws = owner.personalTeamId;

    await captureSealed(owner.owner.token, ws);
    const memberRecord = await captureSealed(member.owner.token, ws);

    // Submitter attribution and workspace ownership are both preserved.
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: memberRecord },
      select: { ownerUserId: true, teamId: true, outputEarnedPlan: true },
    });
    expect(row.ownerUserId).toBe(member.owner.userId);
    expect(row.teamId).toBe(ws);
    // Settled on the workspace's plan, not the member's FREE plan.
    expect(row.outputEarnedPlan).toBe("PRO");

    expect(await countHeld(owner.owner.userId), "both records occupy the owner's allowance").toBe(2);
    expect(await countHeld(member.owner.userId), "the member's Personal allowance is untouched").toBe(0);
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: memberRecord } })).toBe(0);

    // The member's own Personal Space still has all three Free records.
    const own = await create(member.owner.token, member.personalTeamId);
    expect(own.statusCode, own.body).toBe(201);
    expect(await countHeld(member.owner.userId)).toBe(1);
    expect(await countHeld(owner.owner.userId)).toBe(2);

    // The third workspace record fills the owner's cap for BOTH people.
    await captureSealed(member.owner.token, ws);
    const ownerFourth = await create(owner.owner.token, ws);
    expect(ownerFourth.statusCode, ownerFourth.body).toBe(409);
    expect(ownerFourth.json().code).toBe("EVIDENCE_RECORD_LIMIT_REACHED");
    const memberFourth = await create(member.owner.token, ws);
    expect(memberFourth.statusCode, memberFourth.body).toBe(409);
    expect(memberFourth.json().code).toBe("EVIDENCE_RECORD_LIMIT_REACHED");
  }, 240_000);

  it("past the owner's allowance the OWNER's credit funds the member's record; the member's wallet is never touched", async () => {
    const { owner, member } = await proOwnerWithFreeMember(1);
    const ws = owner.personalTeamId;
    await captureSealed(owner.owner.token, ws);
    await bankCredits(owner.owner.userId, 1);
    await bankCredits(member.owner.userId, 2);

    const id = await captureSealed(member.owner.token, ws);
    const entry = await prisma.evidenceCreditLedgerEntry.findUniqueOrThrow({
      where: { evidenceId: id },
      select: { userId: true, entryType: true, creditsDelta: true },
    });
    expect(entry).toEqual({ userId: owner.owner.userId, entryType: "CONSUMPTION", creditsDelta: -1 });
    expect(await creditsOf(owner.owner.userId)).toBe(0);
    expect(await creditsOf(member.owner.userId)).toBe(2);

    // Nothing left: plan full, owner's wallet empty — refused, whoever asks.
    const next = await create(member.owner.token, ws);
    expect(next.statusCode, next.body).toBe(409);
  }, 240_000);

  it("a Viewer cannot create in the workspace and nothing is written", async () => {
    const owner = await seedPersonalTenant(deps, "PRO");
    const viewer = await seedPersonalTenant(deps, "FREE");
    await join(owner, viewer.owner.userId, "VIEWER");
    const before = await prisma.evidence.count({ where: { teamId: owner.personalTeamId } });

    const res = await create(viewer.owner.token, owner.personalTeamId);
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.evidence.count({ where: { teamId: owner.personalTeamId } })).toBe(before);
    expect(await countHeld(owner.owner.userId)).toBe(0);
    expect(await countHeld(viewer.owner.userId)).toBe(0);
  }, 240_000);

  it("a member removed between reservation and completion cannot seal; nothing is charged or earned", async () => {
    const { owner, member } = await proOwnerWithFreeMember(1);
    const ws = owner.personalTeamId;
    await bankCredits(owner.owner.userId, 1);

    const created = await create(member.owner.token, ws);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    await upload(member.owner.token, id, ws);
    // The live reservation holds the owner's slot while the upload runs.
    expect(await countHeld(owner.owner.userId)).toBe(1);

    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: ws, userId: member.owner.userId } },
      data: { status: "REVOKED" },
    });

    const done = await finalize(member.owner.token, id, ws);
    expect(done.statusCode, done.body).not.toBe(200);
    expect([403, 404]).toContain(done.statusCode);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { status: true, outputEarnedBasis: true },
    });
    expect(["CREATED", "UPLOADING"]).toContain(row.status);
    expect(row.outputEarnedBasis).toBeNull();
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: id } })).toBe(0);
    expect(await creditsOf(owner.owner.userId)).toBe(1);
    expect(await countHeld(member.owner.userId)).toBe(0);
  }, 240_000);

  it("owner and member racing for the last slot: exactly one is admitted", async () => {
    const { owner, member } = await proOwnerWithFreeMember(2);
    const ws = owner.personalTeamId;
    await captureSealed(member.owner.token, ws);

    const races = await Promise.all([create(owner.owner.token, ws), create(member.owner.token, ws)]);
    expect(races.map((r) => r.statusCode).sort(), races.map((r) => r.body).join(" | ")).toEqual([201, 409]);
    expect(await countHeld(owner.owner.userId)).toBe(2);
    expect(await countHeld(member.owner.userId)).toBe(0);
  }, 240_000);

  it("regression control — a lone Free Personal account keeps its own three", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 3; i++) await captureSealed(t.owner.token, t.personalTeamId);
    expect(await countHeld(t.owner.userId)).toBe(3);
    const fourth = await create(t.owner.token, t.personalTeamId);
    expect(fourth.statusCode, fourth.body).toBe(409);
    expect(fourth.json().code).toBe("FREE_LIMIT_REACHED");
  }, 240_000);

  it("regression control — an Enterprise workspace funds its own evidence; a Free member's allowance and wallet are untouched", async () => {
    const org = await seedOrganizationTenant(deps, { billingPlan: "ENTERPRISE", ownerAccountPlan: "FREE", memberCount: 0 });
    const member = await seedUser(deps, "ent-free-member");
    await setAccountPlan(deps, member.userId, "FREE", { credits: 2 });
    await prisma.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: member.userId, role: "ORG_MEMBER" },
    });
    await prisma.teamMember.create({
      data: { teamId: org.workspaceId, userId: member.userId, role: "MEMBER", status: "ACTIVE" },
    });

    const id = await captureSealed(member.token, org.workspaceId);
    expect(await prisma.evidenceCreditLedgerEntry.count({ where: { evidenceId: id } })).toBe(0);
    expect(await creditsOf(member.userId)).toBe(2);
    expect(await countHeld(member.userId)).toBe(0);
    expect(await countHeld(org.owner.userId)).toBe(0);
  }, 240_000);
});
