/**
 * GOVERNANCE POLICY AUDIT — the row is written, or the change does not happen
 * (PA-03, live PostgreSQL 16).
 *
 * Two defects, one cause (a catch that discarded the error):
 *
 *   1. A policy EVALUATION with no policy in play was audited with the
 *      all-zero UUID as its policy. `governance_policy_audits.policy_id` is a
 *      foreign key to `governance_policies`, so PostgreSQL refused every such
 *      row and the record of the evaluation was lost. (Seen in the CI
 *      full-stack log as `governance_policy_audits_policy_id_fkey`.)
 *
 *   2. A policy MUTATION — create, activate, deprecate, assign — committed
 *      first and wrote its audit row afterwards, through the same swallowing
 *      writer. A failed audit write left a changed policy with no record.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("governance policy audit (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let policies: typeof import("../src/services/governance/governance-policy.service.js");
  let evaluation: typeof import("../src/services/governance/policy-evaluation.service.js");
  let metrics: typeof import("../src/services/ops/metrics.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    policies = await import("../src/services/governance/governance-policy.service.js");
    evaluation = await import("../src/services/governance/policy-evaluation.service.js");
    metrics = await import("../src/services/ops/metrics.service.js");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const auditRows = (teamId: string) =>
    prisma.governancePolicyAudit.findMany({ where: { teamId }, orderBy: { occurredAtUtc: "asc" } });

  const newPolicy = (teamId: string, actor: string, slug = `pa03-${randomUUID().slice(0, 8)}`) =>
    policies.createPolicy({
      teamId,
      kind: "SECURITY",
      slug,
      name: "PA-03 fixture",
      summary: "fixture",
      enforcementMode: "AUDIT_ONLY",
      rule: {},
      createdByUserId: actor,
    });

  it("an evaluation with no policy in play is recorded, with no policy — and nothing is reported lost", async () => {
    const A = h.fixtures.teamA;
    const before = (await auditRows(A.teamId)).length;
    const failedBefore = metrics.readCounter("governance_policy_audit_write_failed_total");

    const result = await evaluation.evaluateRedactionPolicy({ teamId: A.teamId, evidenceId: randomUUID() });
    expect(result.decision).toBe("ALLOW");
    expect(result.policyId).toBeNull();

    const rows = await auditRows(A.teamId);
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.code).toBe("POLICY_EVALUATED");
    expect(row.policyId).toBeNull();
    expect(row.reason).toContain("redaction:allow");
    expect(metrics.readCounter("governance_policy_audit_write_failed_total")).toBe(failedBefore);

    // No row anywhere stands in for "no policy" with the all-zero UUID.
    expect(
      await prisma.governancePolicyAudit.count({ where: { policyId: "00000000-0000-0000-0000-000000000000" } }),
    ).toBe(0);
  });

  it("the audit reader returns a no-policy row as such", async () => {
    const A = h.fixtures.teamA;
    const listed = await policies.listPolicyAudit({ teamId: A.teamId });
    const evaluated = listed.find((r) => r.code === "POLICY_EVALUATED");
    expect(evaluated).toBeDefined();
    expect(evaluated!.policyId).toBeNull();
  });

  it("creating, activating, deprecating and assigning a policy each leave exactly one audit row", async () => {
    const A = h.fixtures.teamA;
    const created = await newPolicy(A.teamId, A.ownerUserId);
    expect(created.ok).toBe(true);
    const policyId = (created as { policyId: string }).policyId;

    expect((await policies.activatePolicy({ teamId: A.teamId, policyId, actorUserId: A.ownerUserId })).ok).toBe(true);
    expect(
      (
        await policies.assignPolicy({
          teamId: A.teamId,
          policyId,
          scope: "WORKSPACE",
          scopeTargetId: A.teamId,
          assignedByUserId: A.ownerUserId,
        })
      ).ok,
    ).toBe(true);
    expect((await policies.deprecatePolicy({ teamId: A.teamId, policyId, actorUserId: A.ownerUserId })).ok).toBe(true);

    const codes = (await prisma.governancePolicyAudit.findMany({ where: { policyId }, orderBy: { occurredAtUtc: "asc" } })).map(
      (r) => r.code,
    );
    expect([...codes].sort()).toEqual(["POLICY_ACTIVATED", "POLICY_ASSIGNED", "POLICY_CREATED", "POLICY_DEPRECATED"]);
  });

  it("a policy change whose audit row cannot be written does not happen", async () => {
    const A = h.fixtures.teamA;
    const created = await newPolicy(A.teamId, A.ownerUserId);
    const policyId = (created as { policyId: string }).policyId;
    const rowsBefore = await prisma.governancePolicyAudit.count({ where: { policyId } });

    // The actor id is not a UUID: PostgreSQL refuses the AUDIT row (22P02).
    // The policy update in the same transaction must not survive it.
    await expect(
      policies.activatePolicy({ teamId: A.teamId, policyId, actorUserId: "not-a-uuid" }),
    ).rejects.toBeDefined();
    expect((await prisma.governancePolicy.findUniqueOrThrow({ where: { id: policyId } })).state).toBe("DRAFT");

    await expect(
      policies.deprecatePolicy({ teamId: A.teamId, policyId, actorUserId: "not-a-uuid" }),
    ).rejects.toBeDefined();
    expect((await prisma.governancePolicy.findUniqueOrThrow({ where: { id: policyId } })).state).toBe("DRAFT");

    await expect(
      policies.assignPolicy({
        teamId: A.teamId,
        policyId,
        scope: "WORKSPACE",
        scopeTargetId: A.teamId,
        assignedByUserId: "not-a-uuid",
      }),
    ).rejects.toBeDefined();
    expect(await prisma.governancePolicyAssignment.count({ where: { policyId } })).toBe(0);

    expect(await prisma.governancePolicyAudit.count({ where: { policyId } })).toBe(rowsBefore);
  });

  it("a policy cannot be created without its audit row", async () => {
    const A = h.fixtures.teamA;
    const slug = `pa03-noaudit-${randomUUID().slice(0, 8)}`;
    await expect(newPolicy(A.teamId, "not-a-uuid", slug)).rejects.toBeDefined();
    expect(await prisma.governancePolicy.count({ where: { teamId: A.teamId, slug } })).toBe(0);
  });

  it("an evaluation audit the database refuses is counted, and the evaluation still answers", async () => {
    const failedBefore = metrics.readCounter("governance_policy_audit_write_failed_total");
    // A team id that is not a UUID: the row cannot be written.
    const result = await evaluation.evaluateRedactionPolicy({ teamId: "not-a-uuid", evidenceId: randomUUID() });
    expect(result.decision).toBe("ALLOW");
    expect(metrics.readCounter("governance_policy_audit_write_failed_total")).toBe(failedBefore + 1);
  });

  it("no writer of the audit table discards its error, and there is one writer", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    const svc = read("services/governance/governance-policy.service.ts");
    expect(svc.match(/governancePolicyAudit\.create\(/g)?.length).toBe(1);
    expect(svc).not.toMatch(/swallow/);
    expect(read("services/governance/policy-evaluation.service.ts")).not.toContain("00000000-0000-0000-0000-000000000000");
  });
});
