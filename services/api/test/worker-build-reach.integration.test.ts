/**
 * The exchange build reads records for the person who asked. It runs later, on a
 * worker, so their reach is read again there: someone off a restricted case when the
 * build runs gets no record of it, and the manifest counts what was left out.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./helpers/read-zip.js";

const upload = vi.hoisted(() => ({ last: null as Buffer | null }));
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async (...args: unknown[]) => {
    const flat = args.flatMap((a) => (a && typeof a === "object" && !Buffer.isBuffer(a) ? Object.values(a) : [a]));
    upload.last = (flat.find((a) => Buffer.isBuffer(a)) as Buffer) ?? upload.last;
  },
}));
vi.mock("../../worker/src/config.js", () => ({ env: { S3_BUCKET: "test-bucket" } }));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

describe("a worker build rechecks the requester's reach (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hidden: string;
  let open: string;
  let listedUserId: string;
  let offUserId: string;

  const evidence = async (teamId: string, organizationId: string | null, ownerUserId: string) =>
    (
      await prisma.evidence.create({
        data: { teamId, organizationId, ownerUserId, type: "PHOTO", status: "SIGNED", sizeBytes: 10n, title: "build" } as never,
        select: { id: true },
      })
    ).id;

  const manifestFor = async (createdByUserId: string) => {
    const { buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js");
    const pkg = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: h.fixtures.teamA.teamId,
        kind: "EVIDENCE",
        state: "BUILDING",
        evidenceIds: [hidden, open] as never,
        createdByUserId,
      },
      select: { id: true },
    });
    upload.last = null;
    await buildExchangePackage(pkg.id, prisma as never);
    expect(upload.last, "the build uploaded a package").not.toBeNull();
    const manifest = readZipEntries(upload.last as unknown as Buffer).get("package-manifest.json");
    return JSON.parse(String(manifest)) as { evidenceIds: string[]; excludedOutOfScope: number };
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { teamA } = h.fixtures;
    listedUserId = teamA.memberUserId;
    offUserId = teamA.adminUserId;
    const restricted = await prisma.case.create({
      data: {
        name: `build-${randomUUID().slice(0, 8)}`,
        teamId: teamA.teamId,
        ownerUserId: teamA.ownerUserId,
        restrictedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    await prisma.caseAccess.create({ data: { caseId: restricted.id, userId: listedUserId } });
    const { organizationId } = await prisma.team.findUniqueOrThrow({
      where: { id: teamA.teamId },
      select: { organizationId: true },
    });
    hidden = await evidence(teamA.teamId, organizationId, teamA.ownerUserId);
    open = await evidence(teamA.teamId, organizationId, teamA.ownerUserId);
    await prisma.caseEvidenceLink.create({
      data: { caseId: restricted.id, evidenceId: hidden, teamId: teamA.teamId } as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a requester on the list gets both records", async () => {
    const manifest = await manifestFor(listedUserId);
    expect(manifest.evidenceIds.sort()).toEqual([hidden, open].sort());
    expect(manifest.excludedOutOfScope).toBe(0);
  });

  it("a requester off the list gets the open record, and one is counted as left out", async () => {
    const manifest = await manifestFor(offUserId);
    expect(manifest.evidenceIds).toEqual([open]);
    expect(manifest.excludedOutOfScope).toBe(1);
  });
});
