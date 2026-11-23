/**
 * ET-CUS-03 — a legal hold reaches the custody chain of EVERY record it covers.
 * Live PostgreSQL 16, the production legal-hold commands and the shared
 * reconciler the Worker's governance sweep runs.
 *
 * On a40ca76f custody was a fire-and-forget fan-out after commit with failures
 * swallowed; CASE scope was capped at 1000 in one Promise.all burst; WORKSPACE
 * scope and evidence linked to a held case afterwards were never recorded.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("legal hold coverage on the custody chain (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let runtime: typeof import("@proovra/shared-runtime");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    holds = await import("../src/services/governance/legal-hold.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `held ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  /**
   * The sweep pages every non-historical hold by a durable id cursor, at most
   * `maxHolds` (200) per run, and wraps. On CI's ONE shared integration
   * database other suites' holds are on the same cursor, so "two runs reach my
   * hold" held only while the database had few holds. Sweep until the cursor
   * has covered every hold once (each record's event is written once, so extra
   * passes are harmless) — the property under test, scoped correctly.
   */
  async function sweepAllHolds(): Promise<void> {
    const total = await prisma.evidenceLegalHold.count({
      where: { historical: false, status: { in: ["ACTIVE", "RELEASED"] } },
    });
    const passes = Math.ceil(total / 200) + 1;
    for (let i = 0; i < passes; i += 1) await runtime.reconcileLegalHoldCustody(prisma as never);
  }
  const events = async (evidenceId: string, holdId: string) =>
    (
      await prisma.custodyEvent.findMany({
        where: { evidenceId, payload: { path: ["legalHoldId"], equals: holdId } },
        orderBy: { sequence: "asc" },
        select: { eventType: true },
      })
    ).map((e) => String(e.eventType));

  it("EVIDENCE scope: placement and release are on the record's chain as the command commits", async () => {
    const A = h.fixtures.teamA;
    const id = await record(A.teamId, A.ownerUserId);
    const hold = await holds.placeCanonicalLegalHold({ teamId: A.teamId, scope: "EVIDENCE", evidenceId: id, actorUserId: A.ownerUserId, title: "Evidence hold" });
    expect(await events(id, hold.id)).toEqual(["LEGAL_HOLD_PLACED"]);
    await holds.releaseCanonicalLegalHold({ teamId: A.teamId, holdId: hold.id, actorUserId: A.ownerUserId, releaseNote: "done" });
    expect(await events(id, hold.id)).toEqual(["LEGAL_HOLD_PLACED", "LEGAL_HOLD_RELEASED"]);
  });

  it("CASE scope: every linked record, a record linked afterwards, once each", async () => {
    const A = h.fixtures.teamA;
    const kase = await prisma.case.create({ data: { teamId: A.teamId, name: `held case ${randomUUID().slice(0, 6)}`, ownerUserId: A.ownerUserId } as never, select: { id: true } });
    const linked = [await record(A.teamId, A.ownerUserId), await record(A.teamId, A.ownerUserId), await record(A.teamId, A.ownerUserId)];
    for (const evidenceId of linked) {
      await prisma.caseEvidenceLink.create({ data: { teamId: A.teamId, caseId: kase.id, evidenceId, role: "PRIMARY", source: "USER" } as never });
    }
    const hold = await holds.placeCanonicalLegalHold({ teamId: A.teamId, scope: "CASE", caseId: kase.id, actorUserId: A.ownerUserId, title: "Case hold" });
    for (const id of linked) expect(await events(id, hold.id)).toEqual(["CASE_LEGAL_HOLD_APPLIED"]);

    const late = await record(A.teamId, A.ownerUserId);
    await prisma.caseEvidenceLink.create({ data: { teamId: A.teamId, caseId: kase.id, evidenceId: late, role: "PRIMARY", source: "USER" } as never });
    expect(await events(late, hold.id)).toEqual([]);
    // Two concurrent sweeps first (the once-each property under a race), then
    // enough passes to cover every hold on the shared cursor.
    await Promise.all([
      runtime.reconcileLegalHoldCustody(prisma as never),
      runtime.reconcileLegalHoldCustody(prisma as never),
    ]);
    await sweepAllHolds();
    expect(await events(late, hold.id)).toEqual(["CASE_LEGAL_HOLD_APPLIED"]);
    for (const id of linked) expect(await events(id, hold.id)).toEqual(["CASE_LEGAL_HOLD_APPLIED"]);

    await holds.releaseCanonicalLegalHold({ teamId: A.teamId, holdId: hold.id, actorUserId: A.ownerUserId, releaseNote: "done" });
    for (const id of [...linked, late]) {
      expect(await events(id, hold.id)).toEqual(["CASE_LEGAL_HOLD_APPLIED", "CASE_LEGAL_HOLD_RELEASED"]);
    }
  });

  it("WORKSPACE scope: every record of the workspace, including one created afterwards", async () => {
    const B = h.fixtures.teamB;
    const before = await record(B.teamId, B.ownerUserId);
    const hold = await holds.placeCanonicalLegalHold({ teamId: B.teamId, scope: "WORKSPACE", actorUserId: B.ownerUserId, title: "Workspace hold" });
    expect(await events(before, hold.id)).toEqual(["LEGAL_HOLD_PLACED"]);
    const after = await record(B.teamId, B.ownerUserId);
    await sweepAllHolds();
    expect(await events(after, hold.id)).toEqual(["LEGAL_HOLD_PLACED"]);
    // Nothing outside the workspace.
    const other = await record(h.fixtures.teamA.teamId, h.fixtures.teamA.ownerUserId);
    expect(await events(other, hold.id)).toEqual([]);
    await holds.releaseCanonicalLegalHold({ teamId: B.teamId, holdId: hold.id, actorUserId: B.ownerUserId, releaseNote: "done" });
    expect(await events(after, hold.id)).toEqual(["LEGAL_HOLD_PLACED", "LEGAL_HOLD_RELEASED"]);
  });
});
