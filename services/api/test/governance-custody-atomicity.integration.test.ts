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
 *
 * (2026-10-18) The publication authority was retired; the governance write it
 * covered is now the verification DISCLOSURE authority
 * (verification-disclosure.service.ts): the policy update and its
 * VERIFICATION_DISCLOSURE_CHANGED event commit together, and concurrent
 * changes are serialized by a compare-and-swap on the policy version.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("governance mutations are atomic with their custody (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let disclosure: typeof import("../src/services/public-verify/verification-disclosure.service.js");
  let certification: typeof import("../src/services/evidence-certification.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    disclosure = await import("../src/services/public-verify/verification-disclosure.service.js");
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
        data: { title: `atomic ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, verificationDisclosureMode: "VERIFICATION_ONLY" } as never,
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

  const policyOf = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: {
        verificationDisclosureMode: true,
        showRecordedLocation: true,
        verificationDisclosureVersion: true,
        verificationDisclosureChangedAtUtc: true,
        verificationAccessState: true,
      },
    });

  it("a disclosure change whose custody event cannot be written does not change the policy", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    await expect(
      withFailingCustody(id, "VERIFICATION_DISCLOSURE_CHANGED", () =>
        disclosure.changeVerificationDisclosure({
          evidenceId: id,
          actorUserId: A.ownerUserId,
          mode: "CONTENT_PREVIEW",
          showRecordedLocation: true,
          expectedVersion: 0,
        }),
      ),
    ).rejects.toThrow();
    expect(await policyOf(id)).toMatchObject({
      verificationDisclosureMode: "VERIFICATION_ONLY",
      showRecordedLocation: false,
      verificationDisclosureVersion: 0,
      verificationDisclosureChangedAtUtc: null,
    });
    expect(await count(id, "VERIFICATION_DISCLOSURE_CHANGED")).toBe(0);

    // When custody can be written, the policy and its event land together.
    const ok = await disclosure.changeVerificationDisclosure({
      evidenceId: id,
      actorUserId: A.ownerUserId,
      mode: "CONTENT_PREVIEW",
      showRecordedLocation: true,
      expectedVersion: 0,
    });
    expect(ok).toMatchObject({ outcome: "CHANGED", current: { mode: "CONTENT_PREVIEW", showRecordedLocation: true, version: 1 } });
    expect(await policyOf(id)).toMatchObject({ verificationDisclosureMode: "CONTENT_PREVIEW", showRecordedLocation: true, verificationDisclosureVersion: 1 });
    const events = await prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "VERIFICATION_DISCLOSURE_CHANGED" as never } });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      fromMode: "VERIFICATION_ONLY",
      toMode: "CONTENT_PREVIEW",
      fromShowRecordedLocation: false,
      toShowRecordedLocation: true,
      changedByUserId: A.ownerUserId,
    });
    // Access is a separate axis: never written by a disclosure change.
    expect((await policyOf(id)).verificationAccessState).toBe("AVAILABLE");
  });

  it("two racing changes from the same version make one change and record exactly one event; the loser is a CONFLICT", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    const results = await Promise.all([
      disclosure.changeVerificationDisclosure({ evidenceId: id, actorUserId: A.ownerUserId, mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 }),
      disclosure.changeVerificationDisclosure({ evidenceId: id, actorUserId: A.ownerUserId, mode: "CONTENT_PREVIEW", showRecordedLocation: true, expectedVersion: 0 }),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["CHANGED", "CONFLICT"]);
    expect(await count(id, "VERIFICATION_DISCLOSURE_CHANGED")).toBe(1);
    expect((await policyOf(id)).verificationDisclosureVersion).toBe(1);
    // The loser is told the current policy, so it can review and retry.
    const loser = results.find((r) => r.outcome === "CONFLICT") as { current: { version: number } };
    expect(loser.current.version).toBe(1);
  });

  it("two identical racing changes are idempotent: one change, one event, the other UNCHANGED", async () => {
    const id = await record();
    const A = h.fixtures.teamA;
    const results = await Promise.all(
      [0, 1].map(() =>
        disclosure.changeVerificationDisclosure({ evidenceId: id, actorUserId: A.ownerUserId, mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 }),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual(["CHANGED", "UNCHANGED"]);
    expect(await count(id, "VERIFICATION_DISCLOSURE_CHANGED")).toBe(1);
    // A stale version asking for what is already true changes nothing either.
    const stale = await disclosure.changeVerificationDisclosure({ evidenceId: id, actorUserId: A.ownerUserId, mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 });
    expect(stale.outcome).toBe("UNCHANGED");
    expect(await count(id, "VERIFICATION_DISCLOSURE_CHANGED")).toBe(1);
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
