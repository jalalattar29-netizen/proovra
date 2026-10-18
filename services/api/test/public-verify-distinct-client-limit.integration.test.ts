/**
 * ET-PKG-17 — two clients cannot lock a record's public Verify page.
 * Live Redis (the integration runner's disposable er-redis), the real route.
 *
 * On a40ca76f the per-evidence bucket counted REQUESTS shared by every viewer
 * of the record, so two clients at their own per-IP allowance exhausted it and
 * every legitimate viewer got 429 for the window. The bucket now counts
 * DISTINCT clients; request volume per client is the per-IP bucket's job.
 *
 * (2026-10-18) The per-record bucket runs once the identifier has resolved to
 * a record (a canonical pvr_ reference here); an id that is not a capability
 * is the uniform 404 before it, behind the per-client bucket only. The page
 * behind the reference need not be servable: the limiter decides first.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("public Verify per-record limit counts distinct clients (live Redis)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let generateVerificationRef: () => string;
  const saved = {
    perEvidence: process.env.VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX,
    perIp: process.env.VERIFY_RATE_LIMIT_MAX,
  };
  const open = (id: string, ip: string) =>
    h.app.inject({ method: "GET", url: `/public/verify/${id}`, remoteAddress: ip });

  beforeAll(async () => {
    process.env.VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX = "3";
    process.env.VERIFY_RATE_LIMIT_MAX = "1000";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ generateVerificationRef } = await import("@proovra/shared-runtime"));
  }, 180_000);

  /** A record holding its canonical reference; returns the reference. */
  async function referencedRecord(): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ref = generateVerificationRef();
    await prisma.evidence.create({
      data: { title: "limit", type: "PHOTO", status: "CREATED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, verificationRef: ref } as never,
    });
    return ref;
  }
  afterAll(async () => {
    if (saved.perEvidence === undefined) delete process.env.VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX;
    else process.env.VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX = saved.perEvidence;
    if (saved.perIp === undefined) delete process.env.VERIFY_RATE_LIMIT_MAX;
    else process.env.VERIFY_RATE_LIMIT_MAX = saved.perIp;
    await h?.cleanup();
  });

  it("two clients hammering a record never lock out a third; the cap is reached only by distinct clients", async () => {
    const id = await referencedRecord();
    const tag = randomUUID().slice(0, 4);
    const a = `198.51.100.${10 + (parseInt(tag, 16) % 50)}`;
    const b = `198.51.100.${70 + (parseInt(tag, 16) % 50)}`;
    for (let i = 0; i < 20; i += 1) {
      expect((await open(id, a)).statusCode).not.toBe(429);
      expect((await open(id, b)).statusCode).not.toBe(429);
    }
    // A third distinct viewer is admitted (3 = the cap).
    expect((await open(id, "203.0.113.5")).statusCode).not.toBe(429);
    // A fourth distinct client in the same window is refused …
    const fourth = await open(id, "203.0.113.6");
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers["retry-after"]).toBeDefined();
    // … while an admitted client keeps its access.
    expect((await open(id, a)).statusCode).not.toBe(429);
    // Another record's window is unaffected.
    expect((await open(await referencedRecord(), "203.0.113.6")).statusCode).not.toBe(429);
  });
});
