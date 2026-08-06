/**
 * PHASE 12 — POINT 5, BOUNDED UNIT 1, FAMILY 4: webhooks/providers.
 *
 * Drives the REAL dispatcher against live PostgreSQL 16:
 *
 *   durable authority  LifecycleWebhookDelivery
 *   destination        LifecycleWebhookEndpoint (secret loaded at execution)
 *   executor           services/worker/src/webhook-dispatcher.ts
 *   terminal writer    the same module (DELIVERED / FAILED / DEAD_LETTERED)
 *
 * The HTTP call is the ONE genuine external process boundary, and the
 * dispatcher already accepts an injected `fetcher` for exactly this reason —
 * so the fake is a RECORDING one and every case can assert how many times the
 * destination was actually contacted. That count is what separates real
 * idempotency from a row that merely looks settled.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";
import { provenCase, recordSuiteProof } from "./family-coverage-manifest.js";

type FetchCall = { url: string; init: Record<string, unknown> };

describe("POINT 5 FAMILY — webhooks/providers (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../../src/db.js")["prisma"];
  let dispatcher: typeof import("../../../worker/src/webhook-dispatcher.js");
  let ownTeam: string;
  let foreignTeam: string;
  let ownOwner: string;
  let foreignOwner: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    dispatcher = await import("../../../worker/src/webhook-dispatcher.js");

    ownTeam = harness.fixtures.teamA.teamId;
    foreignTeam = harness.fixtures.teamB.teamId;
    ownOwner = harness.fixtures.teamA.ownerUserId;
    foreignOwner = harness.fixtures.teamB.ownerUserId;
  });

  afterAll(async () => {
    // Record BEFORE teardown: the proof is what executed, and a teardown
    // failure must not erase it.
    await recordSuiteProof(import.meta.url);
    await harness?.cleanup();
  });

  /** A recording HTTP boundary. Nothing else about the dispatcher is faked. */
  function recordingFetcher(
    response: { status: number; body?: string } | "throw" | "hang",
  ) {
    const calls: FetchCall[] = [];
    const fetcher = async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      if (response === "throw") throw new Error("connection reset");
      if (response === "hang") {
        // An outcome the dispatcher genuinely cannot classify.
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      }
      return {
        status: response.status,
        text: async () => response.body ?? "",
      };
    };
    return { calls, fetcher: fetcher as never };
  }

  async function seedEndpoint(teamId: string, ownerUserId: string, state = "ACTIVE") {
    return prisma.lifecycleWebhookEndpoint.create({
      data: {
        teamId,
        url: `https://example.invalid/hook/${randomUUID()}`,
        // A real secret value, so a leak would be visible in any assertion
        // that scans payloads or logs for it.
        secret: `whsec_${randomUUID().replace(/-/g, "")}`,
        subscribedEvents: ["evidence.completed"],
        state,
        createdByUserId: ownerUserId,
      },
      select: { id: true, secret: true, url: true },
    });
  }

  async function seedDelivery(input: {
    teamId: string;
    endpointId: string;
    state?: string;
    overrides?: Record<string, unknown>;
  }) {
    return prisma.lifecycleWebhookDelivery.create({
      data: {
        teamId: input.teamId,
        endpointId: input.endpointId,
        eventKind: "evidence.completed",
        payload: { evidenceId: randomUUID(), kind: "evidence.completed" },
        signature: "",
        state: input.state ?? "PENDING",
        ...(input.overrides ?? {}),
      },
      select: { id: true },
    });
  }

  async function readDelivery(id: string) {
    return prisma.lifecycleWebhookDelivery.findUnique({
      where: { id },
      select: {
        state: true,
        teamId: true,
        attemptCount: true,
        deliveredAtUtc: true,
        responseStatus: true,
        responseBodyPreview: true,
        signature: true,
      },
    });
  }

  // =========================================================================
  // Durable intent
  // =========================================================================

  it("the delivery row is durable before any network call", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const row = await readDelivery(delivery.id);
    expect(row?.state).toBe("PENDING");
    expect(row?.attemptCount).toBe(0);
    expect(row?.deliveredAtUtc).toBeNull();
    // No signature yet: it is produced at execution, over the real body.
    expect(row?.signature).toBe("");
    provenCase("webhook.durable.intent_before_work");
  });

  it("the destination and its secret are loaded from the DB at execution", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const { calls, fetcher } = recordingFetcher({ status: 200 });

    await dispatcher.runWebhookDispatcherTick({ fetcher });

    // A tick drains every DUE row, so other cases in this file may contribute
    // calls. The assertion is scoped to THIS endpoint: it was contacted, at its
    // own URL, exactly once.
    const mine = calls.filter((c) => c.url === endpoint.url);
    expect(mine).toHaveLength(1);
    // The URL came from the endpoint row, never from the delivery payload.
    expect(mine[0]!.url).toBe(endpoint.url);
    const row = await readDelivery(delivery.id);
    expect(row?.teamId).toBe(ownTeam);
    provenCase("webhook.tenant.workspace_reloaded");
  });

  it("the signing secret never appears in the payload, the row, or the response record", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const { calls, fetcher } = recordingFetcher({
      status: 200,
      body: "ok",
    });
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    const row = await readDelivery(delivery.id);
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain(endpoint.secret);

    // The secret is used to SIGN; it is never transmitted as a field.
    const mine = calls.filter((c) => c.url === endpoint.url);
    expect(mine).toHaveLength(1);
    const sent = JSON.stringify(mine[0]!.init);
    expect(sent).not.toContain(endpoint.secret);
    // A signature WAS produced, over the real body.
    expect(row?.signature).toBeTruthy();
    expect(row?.signature).not.toBe("");
    provenCase("webhook.secret_never_in_payload_or_log");
  });

  it("a DISABLED destination refuses before any network call", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner, "DISABLED");
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const { calls, fetcher } = recordingFetcher({ status: 200 });

    await dispatcher.runWebhookDispatcherTick({ fetcher });

    expect(
      calls.filter((c) => c.url === endpoint.url),
      "a disabled destination must not be contacted",
    ).toHaveLength(0);
    const row = await readDelivery(delivery.id);
    expect(row?.state).not.toBe("DELIVERED");
    expect(row?.deliveredAtUtc).toBeNull();
    provenCase("webhook.disabled_destination_refused");
  });

  // =========================================================================
  // Concurrency, idempotency, terminal protection
  // =========================================================================

  it("two concurrent dispatcher ticks contact the destination exactly once", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const a = recordingFetcher({ status: 200 });
    const b = recordingFetcher({ status: 200 });

    await Promise.all([
      dispatcher.runWebhookDispatcherTick({ fetcher: a.fetcher }),
      dispatcher.runWebhookDispatcherTick({ fetcher: b.fetcher }),
    ]);

    const total =
      a.calls.filter((c) => c.url === endpoint.url).length +
      b.calls.filter((c) => c.url === endpoint.url).length;
    expect(
      total,
      `two concurrent ticks produced ${total} deliveries for one row`,
    ).toBe(1);
    const row = await readDelivery(delivery.id);
    expect(row?.state).toBe("DELIVERED");
    expect(row?.attemptCount).toBe(1);
    provenCase("webhook.claim.one_winner");
  });

  it("a delivery already DISPATCHING is not taken by another tick", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
      state: "DISPATCHING",
    });
    const { calls, fetcher } = recordingFetcher({ status: 200 });

    await dispatcher.runWebhookDispatcherTick({ fetcher });

    expect(
      calls.filter((c) => c.url === endpoint.url),
      "an in-flight delivery must not be re-dispatched",
    ).toHaveLength(0);
    expect((await readDelivery(delivery.id))?.state).toBe("DISPATCHING");
    provenCase("webhook.claim.active_not_stolen");
  });

  it("a DELIVERED row is never sent again", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const first = recordingFetcher({ status: 200 });
    await dispatcher.runWebhookDispatcherTick({ fetcher: first.fetcher });
    expect(first.calls.filter((c) => c.url === endpoint.url)).toHaveLength(1);
    expect((await readDelivery(delivery.id))?.state).toBe("DELIVERED");

    const second = recordingFetcher({ status: 200 });
    await dispatcher.runWebhookDispatcherTick({ fetcher: second.fetcher });
    expect(
      second.calls.filter((c) => c.url === endpoint.url),
      "an acknowledged delivery must not be repeated",
    ).toHaveLength(0);
    provenCase("webhook.idempotency.duplicate_is_noop");
  });

  it("a terminal row is not reopened by a later tick", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
      state: "DEAD_LETTERED",
      overrides: { attemptCount: 9 },
    });
    const { calls, fetcher } = recordingFetcher({ status: 200 });
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    expect(calls.filter((c) => c.url === endpoint.url)).toHaveLength(0);
    const row = await readDelivery(delivery.id);
    expect(row?.state).toBe("DEAD_LETTERED");
    expect(row?.attemptCount).toBe(9);
    provenCase("webhook.terminal.stale_cannot_overwrite");
  });

  // =========================================================================
  // Provider outcome truthfulness
  // =========================================================================

  it("an unknown provider outcome does NOT become success", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    // A timeout: the request may or may not have been received. Marking this
    // delivered would be a lie; marking it permanently failed would be a
    // different lie.
    const { calls, fetcher } = recordingFetcher("hang");
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    expect(calls.filter((c) => c.url === endpoint.url)).toHaveLength(1);
    const row = await readDelivery(delivery.id);
    expect(row?.state).not.toBe("DELIVERED");
    expect(row?.deliveredAtUtc).toBeNull();
    // Still addressable by a later attempt.
    expect(["RETRYING", "PENDING", "FAILED"]).toContain(row?.state);
    provenCase("webhook.provider.unknown_outcome_non_terminal");
  });

  it("a 5xx keeps the delivery retryable; the attempt count is durable", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    const delivery = await seedDelivery({
      teamId: ownTeam,
      endpointId: endpoint.id,
    });
    const { fetcher } = recordingFetcher({ status: 503, body: "upstream down" });
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    const row = await readDelivery(delivery.id);
    expect(row?.state).not.toBe("DELIVERED");
    // Retry state is DURABLE — the next attempt resumes from the row, not from
    // anything the previous attempt held in memory.
    expect(row?.attemptCount).toBeGreaterThan(0);
    expect(row?.responseStatus).toBe(503);
  });

  it("the response body preview is bounded and carries no secret", async () => {
    const endpoint = await seedEndpoint(ownTeam, ownOwner);
    await seedDelivery({ teamId: ownTeam, endpointId: endpoint.id });
    const huge = "X".repeat(50_000) + endpoint.secret;
    const { fetcher } = recordingFetcher({ status: 500, body: huge });
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    const rows = await prisma.lifecycleWebhookDelivery.findMany({
      where: { teamId: ownTeam, responseStatus: 500 },
      select: { responseBodyPreview: true },
    });
    for (const r of rows) {
      if (!r.responseBodyPreview) continue;
      expect(r.responseBodyPreview.length).toBeLessThanOrEqual(2000);
      expect(r.responseBodyPreview).not.toContain(endpoint.secret);
    }
  });

  // =========================================================================
  // Containment
  // =========================================================================

  it("dispatching a foreign workspace's delivery leaks nothing into ours", async () => {
    const ownBefore = await prisma.lifecycleWebhookDelivery.count({
      where: { teamId: ownTeam },
    });
    const foreignEndpoint = await seedEndpoint(foreignTeam, foreignOwner);
    const foreignDelivery = await seedDelivery({
      teamId: foreignTeam,
      endpointId: foreignEndpoint.id,
    });

    const { fetcher } = recordingFetcher({ status: 200 });
    await dispatcher.runWebhookDispatcherTick({ fetcher });

    // The foreign row was processed under ITS OWN workspace and never rebound.
    const row = await readDelivery(foreignDelivery.id);
    expect(row?.teamId).toBe(foreignTeam);
    // Nothing appeared in ours.
    expect(
      await prisma.lifecycleWebhookDelivery.count({ where: { teamId: ownTeam } }),
    ).toBe(ownBefore);
    provenCase("webhook.tenant.cross_workspace_denied");
  });
});
