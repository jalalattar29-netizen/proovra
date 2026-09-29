/**
 * ET-CUS-06 / ET-CUS-09 — custody exported in packages is complete and
 * recomputable. Live PostgreSQL 16, the production worker modules.
 *
 * On a40ca76f:
 *   - a verification package built later for an issued report selected custody
 *     by atUtc, so an event whose own time lay after issuance but whose sequence
 *     was earlier dropped out, leaving a sequence gap and a broken link;
 *   - the exchange package's custody-chain.json omitted every payload (no hash
 *     could be recomputed), stopped at 500 events, and turned a database error
 *     into an empty chain.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const uploaded = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../../worker/src/storage.js", () => ({
  putObjectBuffer: async (p: { key: string; body: Buffer }) => {
    uploaded.set(p.key, Buffer.from(p.body));
  },
}));
vi.mock("../../worker/src/config.js", () => ({ env: { S3_BUCKET: "test-bucket" } }));
vi.mock("../../worker/src/db.js", () => ({ prisma: {} }));

/** The formula the package states, implemented from its words. */
function canonical(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const recompute = (evidenceId: string, e: { sequence: number; eventType: string; atUtc: string; payload: unknown; prevEventHash: string | null }) =>
  createHash("sha256")
    .update(canonical({ v: 1, evidenceId, sequence: e.sequence, eventType: e.eventType, atUtc: e.atUtc, payload: e.payload ?? null, prevEventHash: e.prevEventHash ?? null }), "utf8")
    .digest("hex");

describe("package custody is complete and recomputable (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record() {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `pkg ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }
  const append = (evidenceId: string, atUtc: Date, i: number) =>
    prisma.$transaction((tx) =>
      runtime.appendCustodyEventTx(tx, { evidenceId, eventType: "EVIDENCE_VIEWED" as never, atUtc, payload: { i } }),
    );

  it("ET-CUS-06: the chain at issuance is a contiguous prefix even when an event's own time is out of order", async () => {
    const id = await record();
    const issued = new Date(Date.now() - 60_000);
    await append(id, new Date(issued.getTime() - 3_000), 1);
    // Sequence 2 carries a time AFTER issuance (e.g. a token's genTime)...
    await append(id, new Date(issued.getTime() + 30_000), 2);
    // ...sequence 3 was recorded before issuance.
    await append(id, new Date(issued.getTime() - 1_000), 3);
    await append(id, new Date(issued.getTime() + 45_000), 4);
    // Contrast — the prior selection (by time) leaves a gap at sequence 2.
    const byTime = await prisma.custodyEvent.findMany({
      where: { evidenceId: id, atUtc: { lte: issued } },
      orderBy: { sequence: "asc" },
      select: { sequence: true },
    });
    expect(byTime.map((e) => e.sequence)).toEqual([1, 3]);
    const { custodyThroughIssuance } = await import("../../worker/src/custody-issuance-cutoff.js");
    const events = await custodyThroughIssuance(prisma as never, id, issued);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    let prev: string | null = null;
    for (const e of events) {
      expect(e.prevEventHash).toBe(prev);
      prev = e.eventHash;
    }
  });

  it("ET-CUS-09: the exchange custody chain carries every event with its payload, and every hash recomputes", async () => {
    const id = await record();
    for (let i = 0; i < 520; i++) await append(id, new Date(), i);
    const A = h.fixtures.teamA;
    const pkg = await prisma.evidenceExchangePackage.create({
      data: { teamId: A.teamId, kind: "EVIDENCE", state: "BUILDING", evidenceIds: [id] as never, createdByUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    const { buildExchangePackage } = await import("../../worker/src/exchange-package-builder.js");
    await buildExchangePackage(pkg.id, prisma as never);
    const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: pkg.id }, select: { storageKey: true, state: true } });
    expect(row.state).toBe("READY");
    const { readZipEntries } = await import("./point5/_zip-entries.js");
    const zip = readZipEntries(uploaded.get(row.storageKey!)!);
    const chain = JSON.parse(zip.get(`evidence/${id}/custody-chain.json`)!.toString("utf8")) as {
      eventCount: number;
      events: Array<{ sequence: number; eventType: string; atUtc: string; payload: unknown; prevEventHash: string | null; eventHash: string }>;
    };
    expect(chain.events).toHaveLength(520);
    expect(chain.eventCount).toBe(520);
    for (const e of chain.events) expect(recompute(id, e)).toBe(e.eventHash);
  }, 120_000);
});
