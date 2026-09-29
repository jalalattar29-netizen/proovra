/**
 * ET-CUS-11 — a governance mutation and its custody event commit together.
 * Live PostgreSQL 16, the production services.
 *
 * A custody-append failure is injected for real: a temporary NOT VALID CHECK
 * constraint on custody_events that rejects one event type for one record.
 *
 * On a40ca76f each mutation committed first and appended custody afterwards
 * with a silent catch: the failure left the state changed and the chain
 * without it. A publication transition that LOST its race still appended an
 * event for a change it did not make.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("governance mutations are atomic with their custody (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let publication: typeof import("../src/services/governance/publication.service.js");
  let certification: typeof import("../src/services/evidence-certification.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    publication = await import("../src/services/governance/publication.service.js");
    certification = await import("../src/services/evidence-certification.service.js");
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record() {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `atomic ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, publicVerifyState: "PUBLISHED" } as never,
        select: { id: true },
      })
    ).id;
  }

  /** Make the custody append of `eventType` for `evidenceId` fail, for the duration of `fn`. */
  async function withFailingCustody<T>(evidenceId: string, eventType: string, fn: () => Promise<T>): Promise<T> {
    const name = `test_block_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await prisma.$executeRawUnsafe(
      `ALTER TABLE custody_events ADD CONSTRAINT ${name} CHECK (NOT (evidence_id = '${evidenceId}'::uuid AND event_type = '${eventType}')) NOT VALID`,
    );
    try {
      return await fn();
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE custody_events DROP CONSTRAINT ${name}`);
    }
  }

  const count = (evidenceId: string, eventType: string) =>
    prisma.custodyEvent.count({ where: { evidenceId, eventType: eventType as never } });

  it("a suspension whose custody event cannot be written does not suspend", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    await expect(
      withFailingCustody(id, "PUBLIC_VERIFY_SUSPENDED", () =>
        publication.suspendPublicVerify({ evidenceId: id, teamId: A.teamId, actorUserId: A.ownerUserId, reason: "review" }),
      ),
    ).rejects.toThrow();
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { publicVerifyState: true } });
    expect(ev.publicVerifyState).toBe("PUBLISHED");
    expect(await count(id, "PUBLIC_VERIFY_SUSPENDED")).toBe(0);
  });

  it("two racing unpublishes make one transition and record exactly one event", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    await Promise.allSettled([
      publication.unpublishPublicVerify({ evidenceId: id, teamId: A.teamId, actorUserId: A.ownerUserId }),
      publication.unpublishPublicVerify({ evidenceId: id, teamId: A.teamId, actorUserId: A.ownerUserId }),
    ]);
    expect(await count(id, "PUBLIC_VERIFY_UNPUBLISHED")).toBe(1);
  });

  it("a certification request whose custody event cannot be written creates no certification", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    await expect(
      withFailingCustody(id, "CERTIFICATION_REQUESTED", () =>
        certification.requestEvidenceCertification({
          evidenceId: id,
          declarationType: "CUSTODIAN" as never,
          requestedByUserId: A.ownerUserId,
          statementMarkdown: "I preserved this record.",
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.evidenceCertification.count({ where: { evidenceId: id } })).toBe(0);
    // And when custody can be written, both land.
    await certification.requestEvidenceCertification({
      evidenceId: id,
      declarationType: "CUSTODIAN" as never,
      requestedByUserId: A.ownerUserId,
      statementMarkdown: "I preserved this record.",
    });
    expect(await prisma.evidenceCertification.count({ where: { evidenceId: id } })).toBe(1);
    expect(await count(id, "CERTIFICATION_REQUESTED")).toBe(1);
  });
});
