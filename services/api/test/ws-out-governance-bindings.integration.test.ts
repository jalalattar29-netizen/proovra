/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of many shapes. */
/**
 * WS-OUT / RG-20 + RG-18 — record bindings, canonical gates and verification
 * access transitions (live PostgreSQL, real routes).
 *
 *   PRO-G2-05  a personal workspace's legacy NULL-team record is in that
 *              workspace for the governance snapshot / timeline / status.
 *   PRO-G2-09  snapshot + timeline use the canonical authorizer: a suspended
 *              member gets the concealed 404, never the engine's reason.
 *   PRO-O1-07  reinstating a NULL-team personal record's page asks step-up.
 *   PRO-O1-12  reinstate never clears an operator SUSPENDED state.
 *
 * Every workspace here is created by this file.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("WS-OUT — record bindings and verification access (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let bootstrap: typeof import("../src/services/platform-context/workspace-bootstrap.service.js");

  const tag = () => randomUUID().slice(0, 8);
  const call = (method: string, url: string, who: Person | null, payload?: unknown, headers?: Record<string, string>) =>
    kit.call(method, url, who, payload, headers);

  async function personal(): Promise<{ teamId: string; owner: Person }> {
    const owner = await kit.person(null);
    const ws = await bootstrap.ensurePersonalWorkspace({ userId: owner.id });
    await prisma.team.update({ where: { id: ws.teamId }, data: { billingPlan: "PRO", billingStatus: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: ws.teamId } as never });
    const team = { id: ws.teamId };
    return { teamId: team.id, owner };
  }

  async function record(input: { teamId: string | null; ownerUserId: string; accessState?: string }): Promise<string> {
    const organizationId = input.teamId
      ? (await prisma.team.findUniqueOrThrow({ where: { id: input.teamId }, select: { organizationId: true } })).organizationId
      : null;
    return (
      await prisma.evidence.create({
        data: {
          title: `rec-${tag()}`,
          displayFileName: "rec.pdf",
          type: "PHOTO",
          status: "SIGNED",
          teamId: input.teamId,
          organizationId,
          ownerUserId: input.ownerUserId,
          sizeBytes: 1_000n,
          ...(input.accessState ? { verificationAccessState: input.accessState } : {}),
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    kit = await coverageKit(h);
    bootstrap = await import("../src/services/platform-context/workspace-bootstrap.service.js");
    stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("PRO-G2-05: a legacy NULL-team personal record answers snapshot, timeline and status in its owner's workspace; another workspace's record stays 404", async () => {
    const p = await personal();
    const legacy = await record({ teamId: null, ownerUserId: p.owner.id });
    const other = await personal();
    const foreign = await record({ teamId: other.teamId, ownerUserId: other.owner.id });

    const snap = await call("GET", `/v1/evidence/${legacy}/governance-snapshot?teamId=${p.teamId}`, p.owner);
    expect(snap.statusCode, snap.body).toBe(200);
    const status = await call("GET", `/v1/governance/evidence/${legacy}/status?teamId=${p.teamId}`, p.owner);
    expect(status.statusCode, status.body).toBe(200);
    const held = await call("GET", `/v1/governance/evidence/${legacy}/is-held?teamId=${p.teamId}`, p.owner);
    expect(held.statusCode, held.body).toBe(200);
    const holds = await call("GET", `/v1/governance/evidence/${legacy}/holds?teamId=${p.teamId}`, p.owner);
    expect(holds.statusCode, holds.body).toBe(200);

    const foreignSnap = await call("GET", `/v1/evidence/${foreign}/governance-snapshot?teamId=${p.teamId}`, p.owner);
    expect(foreignSnap.statusCode).toBe(404);
    const foreignStatus = await call("GET", `/v1/governance/evidence/${foreign}/status?teamId=${p.teamId}`, p.owner);
    expect(foreignStatus.statusCode).toBe(404);
  });

  it("PRO-G2-09: a suspended member gets the concealed 404 on snapshot and timeline, never the engine's reason", async () => {
    const p = await personal();
    const rec = await record({ teamId: p.teamId, ownerUserId: p.owner.id });
    const suspended = await kit.person(p.teamId, "ADMIN");
    await prisma.teamMember.updateMany({ where: { teamId: p.teamId, userId: suspended.id }, data: { status: "SUSPENDED" } as never });
    for (const path of ["governance-snapshot", "operational-timeline"]) {
      const res = await call("GET", `/v1/evidence/${rec}/${path}?teamId=${p.teamId}`, suspended);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(404);
      expect(res.body).not.toContain("member_not_active");
    }
  });

  it("PRO-O1-07: reinstating a NULL-team personal record's page asks a step-up and writes nothing without it", async () => {
    const p = await personal();
    const legacy = await record({ teamId: null, ownerUserId: p.owner.id, accessState: "WITHDRAWN" });
    const res = await call("POST", `/v1/evidence/${legacy}/verification-access/reinstate`, p.owner, {});
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    const after = await prisma.evidence.findUniqueOrThrow({ where: { id: legacy }, select: { verificationAccessState: true } });
    expect(after.verificationAccessState).toBe("WITHDRAWN");
  });

  it("PRO-O1-12: reinstate on an operator SUSPENDED page is refused; WITHDRAWN -> AVAILABLE still works", async () => {
    const p = await personal();
    const suspended = await record({ teamId: p.teamId, ownerUserId: p.owner.id, accessState: "SUSPENDED" });
    const header = await stepUp.approvedHeader({
      token: p.owner.token,
      userId: p.owner.id,
      teamId: p.teamId,
      purpose: "PUBLIC_VERIFY_RESTORE",
      resourceKind: "evidence",
      resourceId: suspended,
    });
    const refused = await call("POST", `/v1/evidence/${suspended}/verification-access/reinstate`, p.owner, {}, header);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(
      (await prisma.evidence.findUniqueOrThrow({ where: { id: suspended }, select: { verificationAccessState: true } }))
        .verificationAccessState,
    ).toBe("SUSPENDED");

    const withdrawn = await record({ teamId: p.teamId, ownerUserId: p.owner.id, accessState: "WITHDRAWN" });
    const header2 = await stepUp.approvedHeader({
      token: p.owner.token,
      userId: p.owner.id,
      teamId: p.teamId,
      purpose: "PUBLIC_VERIFY_RESTORE",
      resourceKind: "evidence",
      resourceId: withdrawn,
    });
    const ok = await call("POST", `/v1/evidence/${withdrawn}/verification-access/reinstate`, p.owner, {}, header2);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: "AVAILABLE", changed: true });
  });
});
