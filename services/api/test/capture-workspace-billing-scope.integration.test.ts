/**
 * UC-TQ-006 — the POSITIVE half of the capture commercial-gate matrix, against
 * a live PostgreSQL.
 *
 * `capture-workspace-billing-scope.test.ts` runs in the DB-free unit project,
 * so for SHARED/TEAM and SINGLE_OCCUPANT/FREE the gate's allowance count
 * throws an infrastructure error that the unit test explicitly tolerates
 * (`if (caught) expect(caught.code).not.toBe("TEAM_PLAN_REQUIRED")`). That made
 * the "allowed" rows ALWAYS_TRUE: a DB outage, or any other refusal, passed.
 *
 * Here the same matrix runs with real workspace ids from the integration
 * harness, and an allowed row must RESOLVE — no error of any kind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { WorkspaceScope } from "../src/services/workspace-billing.service.js";

const CAPTURE_TEMPLATE_IDS = [
  "general-evidence-record",
  "insurance-claim",
  "legal-matter",
  "incident-investigation",
  "compliance-audit",
  "journalism-field-capture",
] as const;

describe("capture commercial gate — positive path (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let assertWorkspaceAllowsEvidenceCreation: typeof import("../src/services/billing-enforcement.service.js")["assertWorkspaceAllowsEvidenceCreation"];
  let NO_CONTRACT_LIMITS: typeof import("../src/services/billing/enterprise-contract-limits.js")["NO_CONTRACT_LIMITS"];
  let prisma: typeof import("../src/db.js")["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ assertWorkspaceAllowsEvidenceCreation } = await import(
      "../src/services/billing-enforcement.service.js"
    ));
    ({ NO_CONTRACT_LIMITS } = await import("../src/services/billing/enterprise-contract-limits.js"));
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function scope(
    billingShape: "SINGLE_OCCUPANT" | "SHARED",
    plan: "FREE" | "TEAM",
  ): Promise<WorkspaceScope> {
    const shared = billingShape === "SHARED";
    const teamId = shared ? harness.fixtures.teamA.teamId : null;
    const ownerUserId = shared ? harness.fixtures.teamA.ownerUserId : harness.fixtures.personal.userId;
    const organizationId = shared
      ? (await prisma.team.findUniqueOrThrow({ where: { id: teamId! }, select: { organizationId: true } }))
          .organizationId
      : null;
    return {
      billingShape,
      ownerUserId,
      teamId,
      organizationId,
      plan: plan as WorkspaceScope["plan"],
      credits: 0,
      teamSeats: 0,
      storageBytesOverride: null,
      activeStorageAddonBytes: 0n,
      legacyRecordCapOverride: null,
      contractLimits: NO_CONTRACT_LIMITS,
    } as WorkspaceScope;
  }

  it("the harness provides real workspaces with few enough records to be under every allowance", async () => {
    const shared = await prisma.evidence.count({ where: { teamId: harness.fixtures.teamA.teamId } });
    const personal = await prisma.evidence.count({ where: { ownerUserId: harness.fixtures.personal.userId } });
    expect(shared).toBeLessThan(500);
    expect(personal).toBeLessThan(3);
  });

  for (const template of CAPTURE_TEMPLATE_IDS) {
    it(`${template} × SHARED/TEAM → resolves (no error of any kind)`, async () => {
      await expect(assertWorkspaceAllowsEvidenceCreation(await scope("SHARED", "TEAM"))).resolves.toBeUndefined();
    });

    it(`${template} × SINGLE_OCCUPANT/FREE → resolves (no error of any kind)`, async () => {
      await expect(
        assertWorkspaceAllowsEvidenceCreation(await scope("SINGLE_OCCUPANT", "FREE")),
      ).resolves.toBeUndefined();
    });

    it(`${template} × SHARED/FREE → TEAM_PLAN_REQUIRED`, async () => {
      await expect(assertWorkspaceAllowsEvidenceCreation(await scope("SHARED", "FREE"))).rejects.toMatchObject({
        code: "TEAM_PLAN_REQUIRED",
      });
    });
  }
});
