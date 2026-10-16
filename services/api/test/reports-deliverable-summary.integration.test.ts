/**
 * REPORTS & ARTIFACTS — the compact summary, its filters and the record
 * status, over real HTTP against live PostgreSQL 16 (2026-10-16).
 *
 * The page used to show fifteen per-axis counters; the redesign shows six,
 * and every one is a promise about the rows its filter returns:
 *
 *   * each record-status count equals the list total of its `status` filter,
 *     and the five statuses partition the workspace (no double counting);
 *   * "Reports ready" / "Packages ready" equal their lifecycle filters;
 *   * a failed attempt SUPERSEDED by a newer report is not a current failure —
 *     not in "Needs attention", not "Updated report failed", not on the row;
 *   * a failure made AFTER the latest report still is;
 *   * dimensions compose (status AND report AND package), unknown values are
 *     refused, and "oldest first" pages in the other direction;
 *   * the row's verb is the server's, per role: OWNER / ADMIN / MEMBER may
 *     retry, a VIEWER is told why not.
 *
 * The worker is not involved: the rows it would write are written directly.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Row = {
  evidenceId: string;
  report: { state: string; updateFailed: boolean };
  outputs: {
    report: { action: string; actionUnavailableReason: string | null; terminalReasonCode: string | null };
  };
  deliverable: { status: string; reason: string };
};
type Envelope = {
  sections: {
    summary: { status: string; data: Record<string, number> | null };
    artifacts: { status: string; items: Row[]; nextCursor: string | null; total: number | null };
  };
};

describe("reports deliverable summary (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: string[] = [];
  const ids: Record<string, string> = {};

  const T = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function evidence(label: string, createdAt: Date): Promise<string> {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A.teamId },
      select: { organizationId: true, ownerUserId: true },
    });
    const row = await prisma.evidence.create({
      data: {
        title: `rpt-summary ${label} ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: "ACTIVE" as never,
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        sizeBytes: 5_000n,
        createdAt,
      },
      select: { id: true },
    });
    created.push(row.id);
    return row.id;
  }
  async function report(evidenceId: string, version: number, at: Date) {
    await prisma.report.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `reports/${evidenceId}/v${version}.pdf`,
        generatedAtUtc: at,
        sizeBytes: 1_000n,
      },
    });
  }
  async function pkg(evidenceId: string, version: number, at: Date) {
    await prisma.verificationPackage.create({
      data: {
        evidenceId,
        version,
        storageBucket: "b",
        storageKey: `verification/${evidenceId}/v${version}.zip`,
        generatedAtUtc: at,
        sizeBytes: 9_000n,
        reportVersion: version,
      },
    });
  }
  async function request(evidenceId: string, state: string, at: Date, terminalReasonCode: string | null = null) {
    await prisma.reportGenerationRequest.create({
      data: {
        teamId: h.fixtures.teamA.teamId,
        evidenceId,
        artifactType: "REPORT",
        purpose: "evidence_completed",
        forceRegenerate: false,
        requestedByMachineId: "rpt-summary-test",
        expectedPolicyVersion: 0,
        idempotencyKey: `RPT-SUMMARY:${randomUUID()}`,
        state,
        terminalReasonCode,
        createdAtUtc: at,
      },
    });
  }

  const get = async (query: string, token = h.fixtures.teamA.ownerToken) => {
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/reports/artifacts?teamId=${h.fixtures.teamA.teamId}${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res;
  };
  /** Every row the query returns, across pages. */
  async function all(query: string, token?: string): Promise<{ total: number | null; rows: Row[] }> {
    const rows: Row[] = [];
    let cursor: string | null = null;
    let total: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      const res = await get(`&summary=0&limit=100${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token);
      expect(res.statusCode, res.body).toBe(200);
      const env = res.json() as Envelope;
      expect(env.sections.artifacts.status).toBe("ok");
      total = env.sections.artifacts.total;
      rows.push(...env.sections.artifacts.items);
      cursor = env.sections.artifacts.nextCursor;
      if (!cursor) break;
    }
    return { total, rows };
  }
  const idsOf = (rows: Row[]) => rows.map((r) => r.evidenceId);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });

    // A complete pair, produced by a succeeded request.
    ids.complete = await evidence("complete", T(70));
    await request(ids.complete, "SUCCEEDED", T(69));
    await report(ids.complete, 1, T(68));
    await pkg(ids.complete, 1, T(68));

    // THE DEFECT: an attempt failed at T-60, and a NEWER report (T-50, with its
    // package) superseded it. That failure is history.
    ids.superseded = await evidence("superseded", T(65));
    await request(ids.superseded, "FAILED_TERMINAL", T(60), "RETRY_BUDGET_EXHAUSTED");
    await report(ids.superseded, 1, T(50));
    await pkg(ids.superseded, 1, T(50));

    // A failure made AFTER the latest report: current.
    ids.updateFailed = await evidence("update-failed", T(64));
    await report(ids.updateFailed, 1, T(40));
    await pkg(ids.updateFailed, 1, T(40));
    await request(ids.updateFailed, "FAILED_RETRYABLE", T(30));

    // No report; the first attempt failed and may be retried.
    ids.failed = await evidence("failed", T(63));
    await request(ids.failed, "FAILED_RETRYABLE", T(20));

    // Work in flight.
    ids.queued = await evidence("queued", T(62));
    await request(ids.queued, "QUEUED", T(10));

    // A report whose package was never produced; nothing in flight.
    ids.packageMissing = await evidence("package-missing", T(61));
    await request(ids.packageMissing, "SUCCEEDED", T(9));
    await report(ids.packageMissing, 1, T(8));

    // Owed its first report; nothing requested.
    ids.awaiting = await evidence("awaiting", T(59));
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  it("the five record statuses partition the workspace, and each count equals its filter's rows", async () => {
    const res = await get("&limit=1");
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as Envelope).sections.summary.data!;
    expect(data).toBeTruthy();

    const statuses = [
      ["ready", "recordsReady"],
      ["in_progress", "recordsInProgress"],
      ["needs_attention", "recordsNeedingAttention"],
      ["incomplete", "recordsIncomplete"],
      ["not_available", "recordsNotAvailable"],
    ] as const;
    const seen = new Map<string, string>();
    let sum = 0;
    for (const [filter, field] of statuses) {
      const { total, rows } = await all(`&status=${filter}`);
      expect(typeof data[field], field).toBe("number");
      expect(total, `${field} vs status=${filter}`).toBe(data[field]);
      expect(rows).toHaveLength(data[field]);
      for (const r of rows) {
        // No record is counted in two statuses.
        expect(seen.get(r.evidenceId), `${r.evidenceId} in ${filter} and ${seen.get(r.evidenceId)}`).toBeUndefined();
        seen.set(r.evidenceId, filter);
        // The row says the same thing its filter does.
        expect(r.deliverable.status.toLowerCase()).toBe(filter);
      }
      sum += data[field];
    }
    const everything = await all("");
    expect(data.recordsTotal).toBe(sum);
    expect(everything.total).toBe(data.recordsTotal);
    expect(seen.size).toBe(data.recordsTotal);

    // The per-axis metrics shown beside them equal their own filters.
    for (const [lifecycle, field] of [
      ["report_ready", "reportsReady"],
      ["package_ready", "packagesReady"],
      ["report_update_failed", "reportsUpdateFailed"],
      ["package_missing", "packagesMissingForLatestReport"],
      ["report_awaiting_issuance", "reportsAwaitingFirstIssuance"],
    ] as const) {
      expect((await all(`&lifecycle=${lifecycle}`)).total, field).toBe(data[field]);
    }
  });

  it("each fixture lands in exactly the status its canonical facts give it", async () => {
    const statusOf = async (filter: string) => new Set(idsOf((await all(`&status=${filter}`)).rows));
    const ready = await statusOf("ready");
    const attention = await statusOf("needs_attention");
    const progress = await statusOf("in_progress");
    const incomplete = await statusOf("incomplete");

    expect(ready.has(ids.complete)).toBe(true);
    expect(ready.has(ids.superseded)).toBe(true);
    expect(attention.has(ids.updateFailed)).toBe(true);
    expect(attention.has(ids.failed)).toBe(true);
    expect(progress.has(ids.queued)).toBe(true);
    expect(incomplete.has(ids.packageMissing)).toBe(true);
    expect(incomplete.has(ids.awaiting)).toBe(true);
  });

  it("a failure superseded by a newer report is NOT a current failure — not counted, not filtered, not on the row", async () => {
    const attention = idsOf((await all("&status=needs_attention")).rows);
    expect(attention).not.toContain(ids.superseded);
    const updateFailed = idsOf((await all("&lifecycle=report_update_failed")).rows);
    expect(updateFailed).not.toContain(ids.superseded);
    expect(updateFailed).toContain(ids.updateFailed);

    const row = (await all("&lifecycle=report_ready")).rows.find((r) => r.evidenceId === ids.superseded)!;
    expect(row.report.updateFailed).toBe(false);
    expect(row.deliverable).toEqual({ status: "READY", reason: "COMPLETE" });
    // The superseded terminal's code does not travel with a READY report.
    expect(row.outputs.report.terminalReasonCode).toBeNull();

    const current = (await all("&lifecycle=report_ready")).rows.find((r) => r.evidenceId === ids.updateFailed)!;
    expect(current.report.updateFailed).toBe(true);
    expect(current.deliverable).toEqual({ status: "NEEDS_ATTENTION", reason: "REPORT_UPDATE_FAILED" });
  });

  it("dimensions compose with AND: status, report and package filters narrow one query", async () => {
    const both = idsOf((await all("&status=needs_attention&lifecycle=report_ready")).rows);
    expect(both).toContain(ids.updateFailed);
    expect(both).not.toContain(ids.failed); // needs attention, but has no report

    const pair = idsOf((await all("&lifecycle=report_ready,package_ready")).rows);
    expect(pair).toEqual(expect.arrayContaining([ids.complete, ids.superseded, ids.updateFailed]));
    expect(pair).not.toContain(ids.packageMissing);

    const none = await all("&status=ready&lifecycle=report_failed");
    expect(none.total).toBe(0);
    expect(none.rows).toEqual([]);
  });

  it("refuses unknown filter values instead of silently ignoring them", async () => {
    expect((await get("&status=FAILED_TERMINAL")).statusCode).toBe(400);
    expect((await get("&lifecycle=report_ready,package_ready_x")).statusCode).toBe(400);
    expect((await get("&sort=sideways")).statusCode).toBe(400);
    // The single value every existing deep link sends still parses.
    expect((await get("&lifecycle=report_awaiting_issuance&summary=0")).statusCode).toBe(200);
  });

  it("sorts by capture date in either direction, and pages forward in both", async () => {
    const mine = new Set(Object.values(ids));
    const newest = idsOf((await all("")).rows).filter((id) => mine.has(id));
    const oldest = idsOf((await all("&sort=oldest")).rows).filter((id) => mine.has(id));
    expect(newest).toHaveLength(mine.size);
    expect(oldest).toEqual([...newest].reverse());

    // Page through oldest-first one row at a time: no row skipped or repeated.
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res = await get(`&summary=0&limit=1&sort=oldest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const env = res.json() as Envelope;
      paged.push(...idsOf(env.sections.artifacts.items));
      cursor = env.sections.artifacts.nextCursor;
      if (!cursor) break;
    }
    expect(paged.filter((id) => mine.has(id))).toEqual(oldest);
    expect(new Set(paged).size).toBe(paged.length);
  });

  it("the row's verb is the server's per role: owner, admin and member may retry; a viewer is told why not", async () => {
    const A = h.fixtures.teamA;
    const verbFor = async (token: string) =>
      (await all("&status=needs_attention", token)).rows.find((r) => r.evidenceId === ids.failed)!.outputs.report;
    for (const token of [A.ownerToken, A.adminToken, A.memberToken]) {
      expect((await verbFor(token)).action).toBe("RETRY");
    }
    const viewer = await verbFor(A.viewerToken);
    expect(viewer.action).toBe("NONE");
    expect(viewer.actionUnavailableReason).toBe("PERMISSION_DENIED");
  });
});
