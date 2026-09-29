/**
 * ET-REC-09 — an operator's manual re-send / cancel of a message is audited and
 * conditional on the state that was read. Live PostgreSQL 16, the real routes.
 *
 * On a40ca76f neither route wrote an audit row, and both updated with
 * `where: { id }` after a separate read, so two concurrent cancels both
 * "succeeded" and a concurrent send could be overwritten.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("communications retry: audited and conditional (live PostgreSQL 16)", () => {
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

  async function message(status: "FAILED" | "RETRY_SCHEDULED") {
    return (
      await prisma.communicationMessage.create({
        data: {
          teamId: h.fixtures.teamA.teamId,
          channel: "EMAIL",
          purpose: "EVIDENCE_REQUEST",
          recipientHash: randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
          recipientPreview: "r•••@example.test",
          status,
        } as never,
        select: { id: true },
      })
    ).id;
  }
  const post = (id: string, verb: "retry" | "cancel-retry") =>
    h.app.inject({
      method: "POST",
      url: `/v1/communications/messages/${id}/${verb}`,
      headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ teamId: h.fixtures.teamA.teamId }),
    });
  const audits = (id: string, action: string) =>
    prisma.adminAuditLog.findMany({
      where: { action, resourceId: id },
      select: { outcome: true, previousState: true, resultingState: true, workspaceId: true },
    });

  it("a manual re-send is audited with the transition", async () => {
    const id = await message("FAILED");
    const res = await post(id, "retry");
    expect(res.statusCode, res.body).toBe(200);
    expect(await audits(id, "communications.message.retry_requested")).toEqual([
      { outcome: "success", previousState: "FAILED", resultingState: "RETRY_SCHEDULED", workspaceId: h.fixtures.teamA.teamId },
    ]);
  });

  it("two concurrent cancels: exactly one applies and exactly one is audited", async () => {
    const id = await message("RETRY_SCHEDULED");
    const answers = await Promise.all([post(id, "cancel-retry"), post(id, "cancel-retry")]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 409]);
    expect(await audits(id, "communications.message.retry_cancelled")).toHaveLength(1);
    const row = await prisma.communicationMessage.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(row.status).toBe("CANCELLED");
  });
});
