/**
 * ET-CUS-12 — released redactions and review decisions reach the record's
 * custody chain. Live PostgreSQL 16, the production redaction activity emitter
 * and the real reviewer-workflow route.
 *
 * On a40ca76f both lived only in unhashed, mutable side tables
 * (redaction_activity, evidence_reviewer_audit_events), and the emitter's
 * docblock claimed a mirror into an audit chain that did not exist.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("redaction and review decisions on the custody chain (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record() {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `redact ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  const custody = async (evidenceId: string, type: string) =>
    (await prisma.custodyEvent.findMany({ where: { evidenceId, eventType: type as never }, select: { payload: true } })).map(
      (e) => e.payload as Record<string, unknown>,
    );

  it("a material redaction step is recorded on the record; a drafting step is not", async () => {
    const A = h.fixtures.teamA;
    const id = await record();
    const project = await prisma.redactionProject.create({
      data: { teamId: A.teamId, evidenceId: id, createdByUserId: A.ownerUserId, artifactKind: "IMAGE" } as never,
      select: { id: true },
    });
    const { emitRedactionActivity } = await import("../src/services/redaction/redaction-activity.service.js");
    await emitRedactionActivity({ teamId: A.teamId, projectId: project.id, code: "REGION_ADDED", actorUserId: A.ownerUserId });
    expect(await custody(id, "REDACTION_RECORDED")).toEqual([]);
    await emitRedactionActivity({ teamId: A.teamId, projectId: project.id, code: "VERSION_PUBLISHED", actorUserId: A.ownerUserId });
    expect(await custody(id, "REDACTION_RECORDED")).toEqual([
      expect.objectContaining({ code: "VERSION_PUBLISHED", projectId: project.id, actorUserId: A.ownerUserId }),
    ]);
  });

  it("a review status decision is recorded on the record; an assignment-only update is not", async () => {
    const id = await record();
    const patch = (body: unknown) =>
      h.app.inject({
        method: "PATCH",
        url: `/v1/evidence/${id}/reviewer-workflow`,
        headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
    const assigned = await patch({ priority: "HIGH" });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(await custody(id, "REVIEW_DECISION_RECORDED")).toEqual([]);
    const decided = await patch({ status: "CLOSED" });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await custody(id, "REVIEW_DECISION_RECORDED")).toEqual([
      expect.objectContaining({ status: "CLOSED" }),
    ]);
  });
});
