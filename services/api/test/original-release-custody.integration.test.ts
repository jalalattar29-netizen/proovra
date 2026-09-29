/**
 * ET-CUS-07 — every response that hands out a presigned URL to an ORIGINAL
 * object leaves a custody fact. Live PostgreSQL 16, real HTTP. (Presigning is
 * a local computation; no object store is contacted.)
 *
 * On a40ca76f only /original wrote one — as EVIDENCE_VIEWED — so the parts
 * listing and record views released original bytes with no trace, and
 * EVIDENCE_DOWNLOADED was never emitted.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("original byte release is on the custody chain (live PostgreSQL 16)", () => {
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

  async function signedRecordWithParts(n: number) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `release ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        storageBucket: "release-bucket",
        storageKey: `originals/${randomUUID()}.jpg`,
      } as never,
      select: { id: true },
    });
    for (let i = 0; i < n; i++) {
      await prisma.evidencePart.create({
        data: { evidenceId: ev.id, partIndex: i, storageBucket: "release-bucket", storageKey: `parts/${ev.id}/${i}.jpg`, mimeType: "image/jpeg" } as never,
      });
    }
    return ev.id;
  }
  const events = async (evidenceId: string) =>
    (
      await prisma.custodyEvent.findMany({
        where: { evidenceId, eventType: { in: ["EVIDENCE_DOWNLOADED", "EVIDENCE_VIEWED", "VERIFY_VIEWED"] as never } },
        orderBy: { sequence: "asc" },
        select: { eventType: true, payload: true },
      })
    ).map((e) => ({ type: String(e.eventType), ...(e.payload as Record<string, unknown>) }));
  const get = (url: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${h.fixtures.teamA.ownerToken}` } });

  it("the parts listing that hands out part URLs records EVIDENCE_DOWNLOADED with the count", async () => {
    const id = await signedRecordWithParts(3);
    const res = await get(`/v1/evidence/${id}/parts`);
    expect(res.statusCode, res.body).toBe(200);
    const issued = (res.json().parts as Array<{ url?: string | null }>).filter((p) => p.url).length;
    const recorded = (await events(id)).filter((e) => e.channel === "parts_listing");
    expect(issued).toBe(3); // the default workspace policy releases originals
    expect(recorded).toEqual([expect.objectContaining({ type: "EVIDENCE_DOWNLOADED", originalUrlsIssued: 3 })]);
  });

  it("/original records EVIDENCE_DOWNLOADED, not EVIDENCE_VIEWED", async () => {
    const id = await signedRecordWithParts(1);
    const res = await get(`/v1/evidence/${id}/original`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await events(id)).toEqual([expect.objectContaining({ type: "EVIDENCE_DOWNLOADED", channel: "original", originalUrlsIssued: 1 })]);
  });

  it("a record view records exactly the original URLs it included", async () => {
    const id = await signedRecordWithParts(2);
    const res = await get(`/v1/evidence/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    // The same URL can appear twice in the body (an item and the primaryItem
    // that points at it); what was issued is the set of distinct URLs.
    const distinct = new Set(JSON.stringify(res.json()).match(/"viewUrl":"[^"]+"/g) ?? []);
    expect(distinct.size).toBe(2);
    const recorded = (await events(id)).filter((e) => e.channel === "record_view");
    expect(recorded).toEqual([expect.objectContaining({ type: "EVIDENCE_VIEWED", accessMode: "original_url_issued", originalUrlsIssued: 2 })]);
  });
});
