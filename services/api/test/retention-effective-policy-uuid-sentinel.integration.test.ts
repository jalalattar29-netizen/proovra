/**
 * EFFECTIVE RETENTION RESOLUTION, against live PostgreSQL.
 *
 * THE BUG THIS PROVES FIXED
 * ---------------------------------------------------------------------------
 * `resolveEffectiveRetentionPolicy` built its `OR` array with a no-op arm for
 * each optional filter the caller did not supply:
 *
 *     input.evidenceType ? { scope: "EVIDENCE_TYPE", ... } : { id: "__never__" }
 *
 * `EvidenceRetentionPolicy.id` is `@db.Uuid`. "__never__" is not a UUID, so
 * PostgreSQL rejected the WHOLE query with
 *
 *     invalid input syntax for type uuid: "__never__"
 *
 * and Prisma surfaced it as a P2007/P2023 known-request error. The sentinel
 * was intended to match nothing; instead it invalidated the statement.
 *
 * The consequence was not an edge case. The DEFAULT call — a workspace with no
 * evidence type, no jurisdiction and no case — hit all three no-op arms, so the
 * resolver failed for the most ordinary question it exists to answer: "what
 * retention governs this workspace?". Every such call also raised a
 * `severity: critical` operational alert, teaching operators to ignore that
 * alert class.
 *
 * These are BEHAVIOUR tests against the real resolver and the real table. No
 * fixture tells the resolver what to conclude: rows are written, the resolver
 * is asked, and the answer is compared with what the rows imply.
 *
 * A "no matching policy" answer is a DOMAIN RESULT and must be returned as one.
 * A database failure must still surface as a thrown error — the fix must not
 * convert an infrastructure failure into a false "no policy applies".
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("effective retention resolution (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let resolveEffectiveRetentionPolicy: (typeof import("../src/services/governance-lifecycle/retention-engine.service.js"))["resolveEffectiveRetentionPolicy"];
  let teamId = "";
  let otherTeamId = "";

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ resolveEffectiveRetentionPolicy } = await import(
      "../src/services/governance-lifecycle/retention-engine.service.js"
    ));
    teamId = harness.fixtures.teamA.teamId;
    otherTeamId = harness.fixtures.teamB.teamId;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function clearPolicies(): Promise<void> {
    await prisma.evidenceRetentionPolicy.deleteMany({
      where: { teamId: { in: [teamId, otherTeamId] } },
    });
  }

  async function writePolicy(input: {
    team: string;
    scope: string;
    scopeQualifier?: string | null;
    caseId?: string | null;
    retentionDays?: number | null;
    displayName?: string;
  }): Promise<string> {
    const row = await prisma.evidenceRetentionPolicy.create({
      data: {
        team: { connect: { id: input.team } },
        createdBy: { connect: { id: harness.fixtures.teamA.ownerUserId } },
        displayName: input.displayName ?? `fixture ${input.scope}`,
        status: "ACTIVE",
        scope: input.scope,
        scopeQualifier: input.scopeQualifier ?? null,
        caseId: input.caseId ?? null,
        retentionDays: input.retentionDays ?? 365,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  // ---------------------------------------------------------------------
  // THE REPRODUCTION. This is the call the governance page makes.
  // ---------------------------------------------------------------------
  it("resolves with NO optional filters — the default call that crashed", async () => {
    await clearPolicies();
    const decision = await resolveEffectiveRetentionPolicy({ teamId });
    expect(decision.reason).toBe("no_active_policy");
    expect(decision.source).toBe("none");
    expect(decision.policy).toBeNull();
  });

  it("resolves with only an evidenceType supplied", async () => {
    await clearPolicies();
    const decision = await resolveEffectiveRetentionPolicy({
      teamId,
      evidenceType: "PHOTO",
    });
    expect(decision.reason).toBe("no_active_policy");
  });

  it("resolves with only a jurisdiction supplied", async () => {
    await clearPolicies();
    const decision = await resolveEffectiveRetentionPolicy({
      teamId,
      jurisdiction: "EU",
    });
    expect(decision.reason).toBe("no_active_policy");
  });

  it("resolves with only a caseId supplied", async () => {
    await clearPolicies();
    const decision = await resolveEffectiveRetentionPolicy({
      teamId,
      caseId: harness.fixtures.teamA.caseId,
    });
    expect(decision.reason).toBe("no_active_policy");
  });

  // ---------------------------------------------------------------------
  // The resolver must still RESOLVE, not merely not crash.
  // ---------------------------------------------------------------------
  it("returns the WORKSPACE policy when only a workspace policy exists", async () => {
    await clearPolicies();
    await writePolicy({ team: teamId, scope: "WORKSPACE", retentionDays: 30 });
    const decision = await resolveEffectiveRetentionPolicy({ teamId });
    expect(decision.policy).not.toBeNull();
    expect(decision.policy?.scope).toBe("WORKSPACE");
    expect(decision.source).toBe("team_policy");
  });

  it("prefers the EVIDENCE_TYPE policy over the workspace policy when the type is supplied", async () => {
    await clearPolicies();
    await writePolicy({ team: teamId, scope: "WORKSPACE", retentionDays: 30 });
    await writePolicy({
      team: teamId, scope: "EVIDENCE_TYPE", scopeQualifier: "PHOTO", retentionDays: 90,
    });
    const withType = await resolveEffectiveRetentionPolicy({ teamId, evidenceType: "PHOTO" });
    expect(withType.policy?.scope).toBe("EVIDENCE_TYPE");
    // ...and must NOT leak that policy into a call that did not ask for it.
    const withoutType = await resolveEffectiveRetentionPolicy({ teamId });
    expect(withoutType.policy?.scope).toBe("WORKSPACE");
  });

  it("prefers the CASE policy when a caseId is supplied", async () => {
    await clearPolicies();
    await writePolicy({ team: teamId, scope: "WORKSPACE", retentionDays: 30 });
    await writePolicy({
      team: teamId, scope: "CASE", caseId: harness.fixtures.teamA.caseId, retentionDays: 3650,
    });
    const decision = await resolveEffectiveRetentionPolicy({
      teamId, caseId: harness.fixtures.teamA.caseId,
    });
    expect(decision.policy?.scope).toBe("CASE");
  });

  it("matches a REGULATORY policy only for the jurisdiction asked for", async () => {
    await clearPolicies();
    await writePolicy({
      team: teamId, scope: "REGULATORY", scopeQualifier: "EU", retentionDays: 2555,
    });
    const eu = await resolveEffectiveRetentionPolicy({ teamId, jurisdiction: "EU" });
    expect(eu.policy?.scope).toBe("REGULATORY");
    const uk = await resolveEffectiveRetentionPolicy({ teamId, jurisdiction: "UK" });
    expect(uk.policy).toBeNull();
    expect(uk.reason).toBe("no_active_policy");
  });

  // ---------------------------------------------------------------------
  // Tenancy must survive the change.
  // ---------------------------------------------------------------------
  it("never returns another workspace's policy", async () => {
    await clearPolicies();
    await writePolicy({ team: otherTeamId, scope: "WORKSPACE", retentionDays: 9999 });
    const decision = await resolveEffectiveRetentionPolicy({ teamId });
    expect(decision.policy).toBeNull();
    expect(decision.reason).toBe("no_active_policy");
  });

  // ---------------------------------------------------------------------
  // Malformed caller input must not be silently coerced into a match.
  // ---------------------------------------------------------------------
  it("treats a caseId that matches nothing as 'no policy', not as an error", async () => {
    await clearPolicies();
    await writePolicy({ team: teamId, scope: "WORKSPACE", retentionDays: 30 });
    const decision = await resolveEffectiveRetentionPolicy({
      teamId, caseId: randomUUID(),
    });
    // The workspace policy still applies; the unmatched case simply adds nothing.
    expect(decision.policy?.scope).toBe("WORKSPACE");
  });

  // ---------------------------------------------------------------------
  // An infrastructure failure must NOT become a false "no policy applies".
  // ---------------------------------------------------------------------
  it("propagates a database error instead of reporting 'no policy applies'", async () => {
    const exploding = {
      evidenceRetentionPolicy: {
        findMany: async () => { throw new Error("simulated database failure"); },
      },
    } as unknown as Parameters<typeof resolveEffectiveRetentionPolicy>[1];
    await expect(
      resolveEffectiveRetentionPolicy({ teamId }, exploding),
    ).rejects.toThrow(/simulated database failure/);
  });
});
