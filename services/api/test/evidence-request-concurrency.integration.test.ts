/**
 * PRO-048 / EVIDENCE-03 — evidence-request state changes under concurrency
 * (live PostgreSQL).
 *
 * Sends from OPEN each minted an intake link outside any lock and the last write
 * won, so the other links stayed ACTIVE with no request (and stayed ACTIVE after
 * the request was cancelled). A cancel and a close that overlapped both returned
 * 200, with both timestamps and both terminal events. Each round here races the
 * real routes; the assertions are on the stored rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";


describe("evidence requests under concurrency (PRO-048)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const base = "/v1/evidence-requests";

  const call = (method: "POST", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET ??= "integration-only-intake-secret-pro048-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { teamA } = harness.fixtures;
    const organizationId = (
      await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } })
    ).organizationId;
    await prisma.team.update({ where: { id: teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, {
      organizationId,
      status: "ACTIVE",
      activationState: "ACTIVATED",
      seatCount: 25,
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function createRequest(title: string): Promise<string> {
    const { teamA } = harness.fixtures;
    const res = await call("POST", base, teamA.memberToken, {
      teamId: teamA.teamId,
      evidenceId: teamA.evidenceId,
      requestType: "ADDITIONAL_EVIDENCE",
      title,
      instructions: "Please photograph the panel.",
      priority: "NORMAL",
      dueAtUtc: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      recipientMode: "EXTERNAL_CONTRIBUTOR",
      recipientLabel: "Claimant",
      recipientEmail: "claimant@test.proovra.local",
      createIntakeLink: true,
      deliverables: [
        { title: "Primary", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    return (JSON.parse(res.body) as { request: { id: string } }).request.id;
  }

  it("parallel sends from OPEN bind one link; every other minted link is revoked; cancel leaves none ACTIVE", async () => {
    const { teamA } = harness.fixtures;
    for (let round = 0; round < 4; round++) {
      const id = await createRequest(`race send ${round}`);
      // The OPEN state the audit seeded: reachable after a send that failed past DRAFT → OPEN.
      await prisma.evidenceRequest.update({ where: { id }, data: { status: "OPEN" } });
      const before = new Set((await prisma.workflowIntakeLink.findMany({ select: { id: true } })).map((l) => l.id));
      const sends = await Promise.all([0, 1, 2].map(() => call("POST", `${base}/${id}/send`, teamA.memberToken)));
      for (const s of sends) expect(s.statusCode, s.body).toBe(200);
      const tokens = sends.map((s) => (JSON.parse(s.body) as { rawToken?: string | null }).rawToken).filter(Boolean);
      expect(tokens.length, "exactly one send hands out a token").toBe(1);

      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id }, select: { intakeLinkId: true, status: true } });
      const minted = (await prisma.workflowIntakeLink.findMany({ select: { id: true, status: true } })).filter((l) => !before.has(l.id));
      const active = minted.filter((l) => l.status !== "REVOKED");
      expect(active.map((l) => l.id), `round ${round}`).toEqual([row.intakeLinkId]);
      const linkEvents = await prisma.evidenceRequestEvent.count({ where: { evidenceRequestId: id, eventType: "EVIDENCE_REQUEST_LINK_CREATED" } });
      expect(linkEvents).toBe(1);

      const cancel = await call("POST", `${base}/${id}/cancel`, teamA.memberToken, { reviewerNote: "No longer needed." });
      expect(cancel.statusCode, cancel.body).toBe(200);
      const after = await prisma.workflowIntakeLink.findMany({ where: { id: { in: minted.map((l) => l.id) } }, select: { status: true } });
      expect(after.every((l) => l.status === "REVOKED"), `round ${round}`).toBe(true);
    }
  });

  it("a cancel and a close that overlap: exactly one wins, with one timestamp and one terminal event", async () => {
    const { teamA } = harness.fixtures;
    for (let round = 0; round < 6; round++) {
      const id = await createRequest(`race terminal ${round}`);
      const sent = await call("POST", `${base}/${id}/send`, teamA.memberToken);
      expect(sent.statusCode, sent.body).toBe(200);
      const [cancel, close] = await Promise.all([
        call("POST", `${base}/${id}/cancel`, teamA.memberToken, { reviewerNote: "Cancelled." }),
        call("POST", `${base}/${id}/close`, teamA.memberToken, { reviewerNote: "Closed." }),
      ]);
      const codes = [cancel.statusCode, close.statusCode].sort();
      expect(codes, `${cancel.body} | ${close.body}`).toEqual([200, 409]);
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id }, select: { status: true, cancelledAtUtc: true, closedAtUtc: true } });
      expect([row.cancelledAtUtc, row.closedAtUtc].filter(Boolean)).toHaveLength(1);
      const terminal = await prisma.evidenceRequestEvent.count({
        where: { evidenceRequestId: id, eventType: { in: ["EVIDENCE_REQUEST_CANCELLED", "EVIDENCE_REQUEST_CLOSED"] } },
      });
      expect(terminal).toBe(1);
      expect(row.status).toBe(cancel.statusCode === 200 ? "CANCELLED" : "CLOSED");
    }
  });

  it("positive control: a sequential repeat send is refused as before and leaves the one link ACTIVE", async () => {
    const { teamA } = harness.fixtures;
    const id = await createRequest("sequential send");
    const first = await call("POST", `${base}/${id}/send`, teamA.memberToken);
    expect(first.statusCode, first.body).toBe(200);
    const again = await call("POST", `${base}/${id}/send`, teamA.memberToken);
    expect(again.statusCode, again.body).toBe(409);
    const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("SENT");
    const link = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: row.intakeLinkId! } });
    expect(link.status).toBe("ACTIVE");
  });
});
