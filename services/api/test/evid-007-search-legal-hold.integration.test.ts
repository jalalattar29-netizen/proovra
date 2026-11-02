/**
 * EVID-007 — the "On legal hold" filter and badge see application legal holds, at
 * every scope, the moment they change.
 *
 * Before: both read a column fed only by the S3 object hold, which PROOVRA refuses
 * by design, so the filter returned nothing for genuinely held records.
 *
 * FIXTURES (labelled): hold rows are seeded directly because placing one needs a
 * contract term (Legal Hold entitlement). The search documents are real rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("EVID-007 search sees application legal holds (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let search: typeof import("../src/services/search/evidence-search.service.js");

  const A = () => h.fixtures.teamA;

  async function indexed(label: string, legalHoldState: string | null = null) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    const ev = await prisma.evidence.create({
      data: {
        title: label,
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    await prisma.evidenceSearchDocument.create({
      data: {
        teamId: A().teamId,
        documentType: "EVIDENCE",
        sourceId: ev.id,
        evidenceId: ev.id,
        title: label,
        sourceUpdatedAtUtc: new Date(),
        legalHoldState,
      } as never,
    });
    return ev.id;
  }

  const hold = (data: Record<string, unknown>) =>
    prisma.evidenceLegalHold.create({
      data: {
        teamId: A().teamId,
        status: "ACTIVE",
        title: "evid-007 hold (fixture row)",
        reason: "evid-007",
        placedByUserId: A().ownerUserId,
        ...data,
      } as never,
      select: { id: true },
    });

  const run = async (onLegalHold?: boolean) => {
    const res = await search.executeSearch(
      {
        filter: { teamId: A().teamId, ...(onLegalHold === undefined ? {} : { onLegalHold }), limit: 100 },
        actorUserId: A().ownerUserId,
        isReviewerCapable: true,
      } as never,
      prisma as never,
    );
    return (res as unknown as { rows: Array<{ evidenceId: string | null; badges: string[] }> }).rows;
  };

  const release = (id: string) =>
    prisma.evidenceLegalHold.update({
      where: { id },
      data: { status: "RELEASED", releasedAtUtc: new Date(), releasedByUserId: A().ownerUserId },
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    search = await import("../src/services/search/evidence-search.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a case-scope hold: the filter returns its records, the badge shows, and a release ends both at once", async () => {
    const held = await indexed(`held ${randomUUID()}`);
    const free = await indexed(`free ${randomUUID()}`);
    const c = await prisma.case.create({
      data: { name: "evid-007 case", teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    await prisma.caseEvidenceLink.create({
      data: { caseId: c.id, evidenceId: held, teamId: A().teamId } as never,
    });
    const h1 = await hold({ scope: "CASE", caseId: c.id });

    const on = await run(true);
    expect(on.map((r) => r.evidenceId)).toContain(held);
    expect(on.map((r) => r.evidenceId)).not.toContain(free);
    expect(on.find((r) => r.evidenceId === held)?.badges).toContain("legal-hold");
    const off = await run(false);
    expect(off.map((r) => r.evidenceId)).toContain(free);
    expect(off.map((r) => r.evidenceId)).not.toContain(held);

    await release(h1.id);
    expect((await run(true)).map((r) => r.evidenceId)).not.toContain(held);
    const after = (await run()).find((r) => r.evidenceId === held);
    expect(after?.badges).not.toContain("legal-hold");
  });

  it("an evidence-scope hold is seen; a stored OFF is not a hold", async () => {
    const held = await indexed(`direct ${randomUUID()}`);
    const off = await indexed(`off ${randomUUID()}`, "OFF");
    const h1 = await hold({ scope: "EVIDENCE", evidenceId: held });
    const on = await run(true);
    expect(on.map((r) => r.evidenceId)).toContain(held);
    expect(on.map((r) => r.evidenceId)).not.toContain(off);
    expect((await run()).find((r) => r.evidenceId === off)?.badges).not.toContain("legal-hold");
    await release(h1.id);
  });

  it("a workspace-scope hold covers every record", async () => {
    const one = await indexed(`wide ${randomUUID()}`);
    const h1 = await hold({ scope: "WORKSPACE" });
    expect((await run(true)).map((r) => r.evidenceId)).toContain(one);
    expect((await run(false)).map((r) => r.evidenceId)).not.toContain(one);
    await release(h1.id);
  });

  it("another workspace's hold marks nothing here", async () => {
    const mine = await indexed(`mine ${randomUUID()}`);
    const foreign = await prisma.evidenceLegalHold.create({
      data: {
        teamId: h.fixtures.teamB.teamId,
        scope: "WORKSPACE",
        status: "ACTIVE",
        title: "foreign (fixture row)",
        reason: "evid-007",
        placedByUserId: h.fixtures.teamB.ownerUserId,
      } as never,
      select: { id: true },
    });
    expect((await run(true)).map((r) => r.evidenceId)).not.toContain(mine);
    await prisma.evidenceLegalHold.update({
      where: { id: foreign.id },
      data: { status: "RELEASED", releasedAtUtc: new Date(), releasedByUserId: h.fixtures.teamB.ownerUserId },
    });
  });
});
