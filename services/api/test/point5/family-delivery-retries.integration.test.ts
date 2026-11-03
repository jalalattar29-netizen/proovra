/**
 * PHASE 12 â€” POINT 5, FAMILY 6: the delivery sweeps (WORKFLOW-008).
 *
 * The worker's timers POST the cron-secret routes, and the work happens in the
 * api. The executor proved here is the email retry sweep behind
 * `/v1/notifications/process-retries`, which is also what collects anything the
 * outbox enqueued and the inline dispatch never reached. Live PostgreSQL 16;
 * only the provider socket is a double.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

const provider = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; idempotencyKey: string | null }>,
  mode: "ok" as "ok" | "server_error",
}));

describe("POINT 5 FAMILY â€” delivery sweeps (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let notifications: typeof import("../../src/services/notifications/index.js");
  let ownTeam: string;
  let foreignTeam: string;
  let ownOwner: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    notifications = await import("../../src/services/notifications/index.js");
    ownTeam = harness.fixtures.teamA.teamId;
    foreignTeam = harness.fixtures.teamB.teamId;
    ownOwner = harness.fixtures.teamA.ownerUserId;

    for (const [key, value] of Object.entries({
      NOTIFICATIONS_ENABLED: "true",
      RESEND_API_KEY: "point5-integration-only-not-a-real-key",
      EMAIL_TRANSPORT: "resend",
    })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
        const href = typeof url === "string" ? url : url.toString();
        if (!href.startsWith("https://api.resend.com/")) {
          throw new Error(`point5: unexpected outbound request to ${href}`);
        }
        const body = JSON.parse(init?.body ?? "{}") as { to?: string | string[] };
        const headers = init?.headers ?? {};
        provider.sent.push({
          to: Array.isArray(body.to) ? (body.to[0] ?? "") : (body.to ?? ""),
          idempotencyKey: headers["Idempotency-Key"] ?? headers["idempotency-key"] ?? null,
        });
        return provider.mode === "ok"
          ? ({
              ok: true,
              status: 200,
              json: async () => ({ id: `resend_${randomUUID()}` }),
              text: async () => "",
            } as never)
          : ({ ok: false, status: 503, json: async () => ({}), text: async () => "" } as never);
      },
    );
  }, 900_000);

  beforeEach(() => {
    provider.sent.length = 0;
    provider.mode = "ok";
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /** A notice as a real caller enqueues it, due long ago so it heads the sweep. */
  async function enqueued(teamId = ownTeam): Promise<{ id: string; recipient: string }> {
    const recipient = `delivery-${randomUUID()}@test.proovra.local`;
    const id = await prisma.$transaction((tx) =>
      notifications.enqueueEmailNotificationTx(tx as never, {
        eventType: "WORKSPACE_ACCESS_REMOVED",
        teamId,
        recipientEmail: recipient,
        template: {
          kind: "MembershipLifecycle",
          data: { workspaceName: "Delivery proof", roleLabel: null, actionUrl: null, effectiveOnLabel: null },
        } as never,
      }),
    );
    expect(id).toEqual(expect.any(String));
    await prisma.notificationDelivery.update({
      where: { id: id as string },
      data: { nextAttemptAtUtc: new Date("2001-01-01T00:00:00Z") },
    });
    return { id: id as string, recipient };
  }

  const sweep = () => notifications.processDueNotificationRetries({ batchSize: 500 }, prisma as never);
  const row = (id: string) => prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
  const sendsTo = (recipient: string) => provider.sent.filter((s) => s.to === recipient);

  it("the row commits with the change that caused it, before anything is sent", async () => {
    const recipient = `delivery-${randomUUID()}@test.proovra.local`;
    await expect(
      prisma.$transaction(async (tx) => {
        await notifications.enqueueEmailNotificationTx(tx as never, {
          eventType: "WORKSPACE_ACCESS_REMOVED",
          teamId: ownTeam,
          recipientEmail: recipient,
          template: {
            kind: "MembershipLifecycle",
            data: { workspaceName: "Rolled back", roleLabel: null, actionUrl: null, effectiveOnLabel: null },
          } as never,
        });
        throw new Error("the change did not happen");
      }),
    ).rejects.toThrow("the change did not happen");
    expect(await prisma.notificationDelivery.count({ where: { recipient } })).toBe(0);

    const kept = await enqueued();
    expect((await row(kept.id)).status).toBe("RETRY_SCHEDULED");
    expect(sendsTo(kept.recipient)).toHaveLength(0);
    provenCase("delivery.durable.intent_before_work");
  });

  it("the workspace is the row's: a sweep sends each row where it belongs", async () => {
    const mine = await enqueued(ownTeam);
    const theirs = await enqueued(foreignTeam);
    await sweep();
    expect(await row(mine.id)).toMatchObject({ status: "SENT", teamId: ownTeam, recipient: mine.recipient });
    expect(await row(theirs.id)).toMatchObject({ status: "SENT", teamId: foreignTeam, recipient: theirs.recipient });
    provenCase("delivery.tenant.workspace_reloaded");
  });

  it("another workspace cannot reach a delivery", async () => {
    const mine = await enqueued(ownTeam);
    const res = await notifications.resendNotificationDelivery(
      { id: mine.id, teamId: foreignTeam, actorUserId: harness.fixtures.teamB.ownerUserId },
      prisma as never,
    );
    expect(res).toEqual({ delivery: null, outcome: "not_found" });
    expect((await row(mine.id)).status).toBe("RETRY_SCHEDULED");
    expect(sendsTo(mine.recipient)).toHaveLength(0);

    // The authorized caller, as the positive control.
    const own = await notifications.resendNotificationDelivery(
      { id: mine.id, teamId: ownTeam, actorUserId: ownOwner },
      prisma as never,
    );
    expect(own.outcome).toBe("resent");
    expect(sendsTo(mine.recipient)).toHaveLength(1);
    provenCase("delivery.tenant.cross_workspace_denied");
  });

  it("two simultaneous sweeps send a row once", async () => {
    const { id, recipient } = await enqueued();
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(sendsTo(recipient)).toHaveLength(1);
    expect((await row(id)).status).toBe("SENT");
    provenCase("delivery.claim.one_winner");
  });

  it("a row another sweep holds is left alone", async () => {
    const { id, recipient } = await enqueued();
    await prisma.notificationDelivery.update({ where: { id }, data: { status: "PENDING" } });
    await sweep();
    expect(sendsTo(recipient)).toHaveLength(0);
    expect((await row(id)).status).toBe("PENDING");
    provenCase("delivery.claim.active_not_stolen");
  });

  it("a second sweep over a sent row does nothing", async () => {
    const { id, recipient } = await enqueued();
    await sweep();
    const sent = await row(id);
    await sweep();
    expect(sendsTo(recipient)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "SENT", providerMessageId: sent.providerMessageId });
    provenCase("delivery.idempotency.duplicate_is_noop");
  });

  it("a stale due time cannot reopen a terminal row", async () => {
    const { id, recipient } = await enqueued();
    await sweep();
    await prisma.notificationDelivery.update({
      where: { id },
      data: { nextAttemptAtUtc: new Date("2001-01-01T00:00:00Z") },
    });
    await sweep();
    expect(sendsTo(recipient)).toHaveLength(1);
    expect((await row(id)).status).toBe("SENT");
    provenCase("delivery.terminal.stale_cannot_overwrite");
  });

  it("a provider failure schedules a retry, is never read as delivered, and the retry reuses the key", async () => {
    const { id, recipient } = await enqueued();
    provider.mode = "server_error";
    await sweep();
    const failed = await row(id);
    expect(failed.status).toBe("RETRY_SCHEDULED");
    expect(failed.sentAtUtc).toBeNull();
    expect(failed.retryCount).toBe(1);

    provider.mode = "ok";
    await prisma.notificationDelivery.update({
      where: { id },
      data: { nextAttemptAtUtc: new Date("2001-01-01T00:00:00Z") },
    });
    await sweep();
    expect((await row(id)).status).toBe("SENT");
    const attempts = sendsTo(recipient);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((a) => a.idempotencyKey)).size).toBe(1);
    expect(attempts[0]!.idempotencyKey).toEqual(expect.any(String));
    provenCase("delivery.provider.failure_retryable_not_delivered");
  });
});
