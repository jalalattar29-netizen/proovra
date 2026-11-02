/**
 * The workspace-scope gate failed on reads that omitted a Personal workspace's
 * legacy NULL-team rows. Each read is checked on real rows: the owner's legacy
 * row is in, a stranger's legacy row is out.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("canonical scope on the reads the gate reported (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reach: typeof import("../src/services/access/record-reach.js");
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let ownLegacy: string;
  let strangerLegacy: string;
  let ownCase: string;
  let strangerCase: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    reach = await import("../src/services/access/record-reach.js");
    holds = await import("../src/services/governance/legal-hold.service.js");

    const legacyRecord = async (ownerUserId: string) =>
      (
        await prisma.evidence.create({
          data: {
            title: `legacy-${randomUUID().slice(0, 8)}`,
            type: "PHOTO",
            status: "SIGNED",
            teamId: null,
            ownerUserId,
            sizeBytes: 10n,
            lifecycleState: "PENDING_DESTRUCTION",
            destructionClaimedAtUtc: new Date(),
          } as never,
          select: { id: true },
        })
      ).id;
    const restrictedCase = async (ownerUserId: string) =>
      (
        await prisma.case.create({
          data: {
            name: `legacy-${randomUUID().slice(0, 8)}`,
            teamId: null,
            ownerUserId,
            restrictedAtUtc: new Date(),
          } as never,
          select: { id: true },
        })
      ).id;

    const stranger = h.fixtures.teamB.ownerUserId;
    ownLegacy = await legacyRecord(h.fixtures.personal.userId);
    strangerLegacy = await legacyRecord(stranger);
    ownCase = await restrictedCase(h.fixtures.personal.userId);
    strangerCase = await restrictedCase(stranger);
    await prisma.caseEvidenceLink.create({ data: { caseId: ownCase, evidenceId: ownLegacy } as never });
    await prisma.caseEvidenceLink.create({ data: { caseId: strangerCase, evidenceId: strangerLegacy } as never });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a personal workspace's hidden set holds its owner's legacy rows and no one else's", async () => {
    const someoneElse = h.fixtures.teamA.memberUserId;
    const hidden = await reach.hiddenRecordIdsInWorkspace(h.fixtures.personal.teamId, someoneElse, prisma);
    expect(hidden.caseIds).toContain(ownCase);
    expect(hidden.evidenceIds).toContain(ownLegacy);
    expect(hidden.caseIds).not.toContain(strangerCase);
    expect(hidden.evidenceIds).not.toContain(strangerLegacy);
  });

  it("the owner is not hidden from their own legacy case", async () => {
    const hidden = await reach.hiddenRecordIdsInWorkspace(
      h.fixtures.personal.teamId,
      h.fixtures.personal.userId,
      prisma,
    );
    expect(hidden.caseIds).not.toContain(ownCase);
  });

  it("a workspace hold names the committed legacy record of that workspace only", async () => {
    const named = await holds.listRecordsCommittedToDestruction(
      { teamId: h.fixtures.personal.teamId, scope: "WORKSPACE", caseId: null } as never,
      prisma,
    );
    expect(named).toContain(ownLegacy);
    expect(named).not.toContain(strangerLegacy);
  });

  it("a shared workspace stays strict", async () => {
    const named = await holds.listRecordsCommittedToDestruction(
      { teamId: h.fixtures.teamB.teamId, scope: "WORKSPACE", caseId: null } as never,
      prisma,
    );
    expect(named).not.toContain(strangerLegacy);
  });
});
