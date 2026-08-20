/**
 * BULK ARCHIVE — persistence, not presentation (live PostgreSQL 16).
 *
 * The Evidence Library's Archive bulk action is a mutation with lifecycle and
 * custody consequences, so proving the dialog behaves is not proving the
 * action worked. This suite drives the REAL `POST /v1/evidence/bulk` route
 * through the real Fastify app against a real database and then reads the rows
 * back:
 *
 *   - the archive is persisted, once, with a custody event;
 *   - archive is NOT deletion — the record, its retention and its lifecycle
 *     stay intact;
 *   - a record that is already archived is reported, never re-stamped;
 *   - a legal hold, a missing capability and another tenant's record are each
 *     refused per record, with the rest of the batch still committing;
 *   - 50 records in one request all land.
 *
 * Runs in the INTEGRATION project, which supplies the database: the harness
 * boots a throwaway PostgreSQL 16 via testcontainers and migrates it with the
 * canonical `prisma migrate deploy`. No conditional gate — the unit project
 * excludes the `.integration.test.ts` suffix, and this project runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceBulkRequest } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Evidence bulk ARCHIVE — persisted lifecycle (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { organizationId: true },
    });
    organizationId = team.organizationId as string;
  }, 600_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  /**
   * A fictional record in team A, owned by team A's owner.
   *
   * `organizationId` is carried explicitly: the schema's
   * `evidence_team_implies_org_chk` constraint refuses a team-scoped record
   * that names no organization.
   */
  let organizationId: string;
  async function seedRecord(over: Record<string, unknown> = {}): Promise<string> {
    const team = harness.fixtures.teamA;
    const row = await prisma.evidence.create({
      data: {
        title: `Fictional bulk-archive record ${Math.floor(performance.now() * 1000)}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: team.teamId,
        organizationId,
        ownerUserId: team.ownerUserId,
        ...over,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /**
   * The payload is built by the SAME function the browser uses, so this suite
   * exercises the bytes the page sends rather than a hand-authored body that
   * happens to be valid. A hand-authored body is precisely what let a
   * `caseId: null` from the real client fail in production while every test
   * here passed.
   */
  async function bulkArchive(ids: string[], token: string) {
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: { authorization: `Bearer ${token}` },
      payload: buildEvidenceBulkRequest({
        action: "ARCHIVE",
        evidenceIds: ids,
        caseId: null,
      }),
    });
    return { status: res.statusCode, body: res.json() as {
      successCount: number;
      failedCount: number;
      results: Array<{ evidenceId: string; ok: boolean; reason?: string }>;
    } };
  }

  const archiveEvents = (evidenceId: string) =>
    prisma.custodyEvent.count({
      where: { evidenceId, eventType: "EVIDENCE_ARCHIVED" },
    });

  it("archives one eligible record and writes exactly one custody event", async () => {
    const id = await seedRecord();
    const { status, body } = await bulkArchive([id], harness.fixtures.teamA.ownerToken);

    expect(status).toBe(200);
    expect(body.successCount).toBe(1);
    expect(body.failedCount).toBe(0);

    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true, deletedAt: true, deletedAtUtc: true, retentionUntilUtc: true },
    });
    // Persisted…
    expect(row.archivedAt).not.toBeNull();
    // …and archive is NOT deletion.
    expect(row.deletedAt).toBeNull();
    expect(row.deletedAtUtc).toBeNull();
    expect(await archiveEvents(id)).toBe(1);
  });

  it("archives 50 records in one request, each exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) ids.push(await seedRecord());

    const { body } = await bulkArchive(ids, harness.fixtures.teamA.ownerToken);
    expect(body.successCount).toBe(50);
    expect(body.failedCount).toBe(0);

    const archived = await prisma.evidence.count({
      where: { id: { in: ids }, archivedAt: { not: null } },
    });
    expect(archived).toBe(50);

    const events = await prisma.custodyEvent.groupBy({
      by: ["evidenceId"],
      where: { evidenceId: { in: ids }, eventType: "EVIDENCE_ARCHIVED" },
      _count: { _all: true },
    });
    expect(events.length).toBe(50);
    for (const group of events) expect(group._count._all).toBe(1);
  });

  it("reports an already-archived record instead of re-stamping its archive time", async () => {
    const already = await seedRecord({ archivedAt: new Date("2026-01-05T10:00:00.000Z") });
    const fresh = await seedRecord();

    const { body } = await bulkArchive(
      [already, fresh],
      harness.fixtures.teamA.ownerToken,
    );

    expect(body.successCount).toBe(1);
    expect(body.failedCount).toBe(1);
    const failure = body.results.find((r) => r.evidenceId === already);
    expect(failure?.ok).toBe(false);
    expect(failure?.reason).toBe("ALREADY_ARCHIVED");

    // The original lifecycle time survives — this is what re-archiving
    // silently overwrote.
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: already },
      select: { archivedAt: true },
    });
    expect(row.archivedAt?.toISOString()).toBe("2026-01-05T10:00:00.000Z");
    // No second custody event for a record that did not change.
    expect(await archiveEvents(already)).toBe(0);
    // The eligible record in the same batch still committed.
    expect(await archiveEvents(fresh)).toBe(1);
  });

  it("refuses a record under an active legal hold while the rest of the batch commits", async () => {
    const held = await seedRecord();
    const free = await seedRecord();
    await prisma.evidenceLegalHold.create({
      data: {
        evidenceId: held,
        teamId: harness.fixtures.teamA.teamId,
        scope: "EVIDENCE",
        title: "Fictional matter",
        reason: "Fictional preservation obligation",
        status: "ACTIVE",
        placedByUserId: harness.fixtures.teamA.ownerUserId,
      } as never,
    });

    const { body } = await bulkArchive([held, free], harness.fixtures.teamA.ownerToken);

    const failure = body.results.find((r) => r.evidenceId === held);
    expect(failure?.ok).toBe(false);
    expect(failure?.reason).toMatch(/LEGAL_HOLD/);
    const heldRow = await prisma.evidence.findUniqueOrThrow({
      where: { id: held },
      select: { archivedAt: true, deletedAt: true },
    });
    expect(heldRow.archivedAt).toBeNull();
    expect(heldRow.deletedAt).toBeNull();
    // Partial success: the unheld record still archived.
    expect(body.results.find((r) => r.evidenceId === free)?.ok).toBe(true);
  });

  it("refuses a record the actor may not archive, and changes nothing", async () => {
    const id = await seedRecord();
    const { body } = await bulkArchive([id], harness.fixtures.teamA.viewerToken);

    expect(body.successCount).toBe(0);
    expect(body.failedCount).toBe(1);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true },
    });
    expect(row.archivedAt).toBeNull();
    expect(await archiveEvents(id)).toBe(0);
  });

  it("refuses another tenant's record without confirming it exists", async () => {
    const id = await seedRecord();
    const { body } = await bulkArchive([id], harness.fixtures.teamB.ownerToken);

    expect(body.successCount).toBe(0);
    const failure = body.results[0];
    expect(failure?.ok).toBe(false);
    // The anti-enumeration answer: not found, never "forbidden, it exists".
    expect(failure?.reason).toMatch(/not found/i);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true, teamId: true },
    });
    expect(row.archivedAt).toBeNull();
    expect(row.teamId).toBe(harness.fixtures.teamA.teamId);
  });

  it("accepts the browser's own payload for an action with no target case", async () => {
    const id = await seedRecord();
    // Exactly what the page serialises: no `caseId` key at all.
    const payload = buildEvidenceBulkRequest({
      action: "ARCHIVE",
      evidenceIds: [id],
      caseId: null,
    });
    expect(Object.keys(payload).sort()).toEqual(["action", "evidenceIds"]);

    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true },
    });
    expect(row.archivedAt).not.toBeNull();
  });

  it("refuses the payload the browser used to send (caseId: null)", async () => {
    const id = await seedRecord();
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
      // The pre-fix body, verbatim. It is invalid against the canonical
      // contract, and the API must keep saying so rather than being widened
      // to accept it.
      payload: { action: "ARCHIVE", evidenceIds: [id], caseId: null },
    });
    expect(res.statusCode).toBe(400);
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { archivedAt: true },
    });
    // Nothing was applied.
    expect(row.archivedAt).toBeNull();
  });

  it("rejects a batch larger than the documented bound instead of truncating it", async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
      payload: { action: "ARCHIVE", evidenceIds: ids },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
