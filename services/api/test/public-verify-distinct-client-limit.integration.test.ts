/**
 * ET-PKG-17 / AUD-29 — no set of clients can lock a record's public Verify page.
 * Live Redis (the integration runner's disposable er-redis), the real route.
 *
 * On a40ca76f the per-evidence bucket counted REQUESTS shared by every viewer
 * of the record, so two clients at their own per-IP allowance exhausted it and
 * every legitimate viewer got 429 for the window. The bucket now counts
 * DISTINCT clients; request volume per client is the per-IP bucket's job.
 *
 * AUD-29 (2026-10-20): a distinct-client bucket on a RESOLVED record still let
 * a burst of real viewers (or addresses an attacker controls) lock everyone
 * else out of a widely shared page. A resolved read is now bounded by each
 * client's own budget only; the distinct-client bound applies to a package
 * identifier that resolves to nothing (a rotating-address probe).
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

  it("AUD-29 — a resolved record is never refused for being read by many distinct viewers", async () => {
    const id = await referencedRecord();
    const tag = randomUUID().slice(0, 4);
    const a = `198.51.100.${10 + (parseInt(tag, 16) % 50)}`;
    for (let i = 0; i < 10; i += 1) expect((await open(id, a)).statusCode).not.toBe(429);
    // Ten distinct viewers with a per-identifier cap of 3: every one is admitted.
    for (let n = 1; n <= 10; n += 1) {
      const res = await open(id, `203.0.113.${n}`);
      expect(res.statusCode, `viewer ${n}`).not.toBe(429);
    }
  });

  it("AUD-29 — a package identifier that resolves to nothing is bounded by distinct missing clients", async () => {
    const sha = randomUUID().replace(/-/g, "").padEnd(64, "a");
    const miss = (ip: string) => h.app.inject({ method: "GET", url: `/public/verification-packages/by-sha256/${sha}`, remoteAddress: ip });
    for (let n = 1; n <= 3; n += 1) expect((await miss(`192.0.2.${n}`)).statusCode).toBe(404);
    const fourth = await miss("192.0.2.4");
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers["retry-after"]).toBeDefined();
    // An admitted client keeps its (404) answer.
    expect((await miss("192.0.2.1")).statusCode).toBe(404);
  });
});
