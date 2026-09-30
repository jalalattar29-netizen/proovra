/**
 * ET-DC-07 — reserving a direct-capture record is atomic with binding it to
 * its session. Live PostgreSQL 16, real HTTP for the session.
 *
 * On a40ca76f reserveDirectCaptureEvidence ran createEvidence on the GLOBAL
 * client inside its own transaction: the Evidence row and its EVIDENCE_CREATED
 * custody committed on their own, so a reserve that failed after them (the
 * session binding) left an unbound committed record, and the retry minted a
 * second one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("direct-capture reserve is atomic (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reserve: (typeof import("../src/services/capture-trust/direct-capture-ingest.service.js"))["reserveDirectCaptureEvidence"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ reserveDirectCaptureEvidence: reserve } = await import("../src/services/capture-trust/direct-capture-ingest.service.js"));
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 180_000);

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** The real client, except that binding the record to its session fails. */
  function failingAtBind(): typeof prisma {
    const bindFailing = (tx: object) =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop !== "captureSession") return typeof v === "function" ? v.bind(target) : v;
          return new Proxy(v as object, {
            get(model, method) {
              if (method === "update") {
                return async () => {
                  throw new Error("INJECTED_BIND_FAILURE");
                };
              }
              const m = Reflect.get(model, method);
              return typeof m === "function" ? m.bind(model) : m;
            },
          });
        },
      });
    return new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
            target.$transaction((tx) => fn(bindFailing(tx)), opts as never);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof prisma;
  }

  it("a reserve that fails at the binding leaves no record, and the retry creates exactly one", async () => {
    const A = h.fixtures.teamA;
    const open = await h.app.inject({
      method: "POST",
      url: "/v1/capture/direct-sessions",
      headers: { authorization: `Bearer ${A.ownerToken}` },
      payload: { mode: "PROOVRA_MOBILE_APP", teamId: A.teamId, deviceId: null },
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    // Records this session could have minted (the harness seeds its own).
    const since = new Date();
    const records = () =>
      prisma.evidence.count({
        where: { ownerUserId: A.ownerUserId, teamId: A.teamId, acquisitionMode: "PROOVRA_MOBILE_APP", createdAt: { gte: since } } as never,
      });

    await expect(
      reserve({ prisma: failingAtBind(), sessionId, ownerUserId: A.ownerUserId, type: "PHOTO", mimeType: "image/jpeg" }),
    ).rejects.toThrow("INJECTED_BIND_FAILURE");
    expect(await records()).toBe(0);

    const retry = await reserve({ sessionId, ownerUserId: A.ownerUserId, type: "PHOTO", mimeType: "image/jpeg" });
    expect(await records()).toBe(1);
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { finalizedEvidenceId: true } });
    expect(session.finalizedEvidenceId).toBe(retry.evidenceId);
  });
});
