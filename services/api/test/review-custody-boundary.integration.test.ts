/**
 * REVIEW IS NOT FORENSIC CUSTODY (owner decision 2026-10-24) — executed proof.
 *
 * The confirmed defect: internal Review workflow activity was appended to the
 * record's forensic custody chain (REVIEW_DECISION_RECORDED, payload
 * `{ status, actorUserId }`), classified as reportable, marked the latest
 * report stale ("7 reportable custody events were recorded after report v4"),
 * was printed in the next report's Chain of Custody with the internal
 * actorUserId, and shipped in the verification packages.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), Redis + the REAL report worker
 * (BullMQ job read back and run in-process), MinIO (original, report PDF,
 * packages), real Chromium (the PDF is rendered and its text extracted), the
 * API over HTTP, the production custody appender. WHAT IS DOUBLED: the
 * external RFC 3161 authority only.
 *
 * HISTORY. The seven events the incident recorded are stored history; they
 * are seeded here through the production custody appender with the same
 * sequence and meanings (synthetic identifiers — no Production value). They
 * must stay byte-identical, must not count as reportable, and must not reach
 * any external artifact. NEW Review activity, driven through the real routes,
 * must write no forensic custody at all.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { readZipEntries } from "./point5/_zip-entries.js";

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

/** Deterministic sentinels — never a real identifier. */
const SENTINEL_ACTOR = "5e57a1e0-0000-4000-8000-00000000a11d";
const SENTINEL_NOTE = "SENTINEL-INTERNAL-NOTE-7f3c";
/** The incident's seven events, in order (sequence 352…372 in Production). */
const HISTORICAL_STATUSES = ["REOPENED", "IN_REVIEW", "CLOSED", "REOPENED", "IN_REVIEW", "APPROVED_INTERNAL", "CLOSED"] as const;
/** What no external artifact may carry. */
const FORBIDDEN_IN_EXTERNAL = [
  SENTINEL_ACTOR,
  SENTINEL_NOTE,
  "REVIEW_DECISION_RECORDED",
  "Review decision recorded",
  "APPROVED_INTERNAL",
  "NOT_ACCEPTED",
  "actorUserId",
];

describe("Review / Custody / Artifact boundary (Postgres + Redis + MinIO, real worker, real Chromium)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let processor: typeof import("../../worker/src/processor.js");
  let workerStorage: typeof import("../../worker/src/storage.js");
  let extractPdfText: (pdf: Buffer) => Promise<string>;
  let appendCustodyEventTx: (tx: unknown, input: { evidenceId: string; eventType: string; payload: unknown }) => Promise<unknown>;
  let reportQueue: import("bullmq").Queue;
  let clearRates: () => Promise<unknown>;
  let evidenceId: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    appendCustodyEventTx = runtime.appendCustodyEventTx as never;
    processor = await import("../../worker/src/processor.js");
    workerStorage = await import("../../worker/src/storage.js");
    ({ extractPdfText } = await import("../../worker/src/output-verification.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    const { Queue } = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    reportQueue = new Queue("report", { connection: new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) });
    await reportQueue.obliterate({ force: true });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
    evidenceId = await captureAndFinalize();
    await runReportJobs(evidenceId);
  }, 900_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await reportQueue?.obliterate({ force: true }).catch(() => undefined);
    await reportQueue?.close();
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function runReportJobs(id: string): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const requests = await prisma.reportGenerationRequest.findMany({
        where: { evidenceId: id, state: { in: ["QUEUED", "FAILED_RETRYABLE"] } },
        select: { id: true },
      });
      if (requests.length === 0) return;
      for (const r of requests) {
        const job = await reportQueue.getJob(`report-${r.id}`);
        if (!job) continue;
        (job as { attemptsMade: number }).attemptsMade = 0;
        await processor.processGenerateReport(job as never);
      }
    }
  }

  async function captureAndFinalize(): Promise<string> {
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "text/plain", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, { partIndex: 0, mimeType: "text/plain", originalFileName: "boundary.txt" });
    expect(part.statusCode, part.body).toBe(201);
    const put = await fetch(part.json().upload.putUrl as string, {
      method: "PUT",
      body: Buffer.from(`review-custody-boundary ${id} ${randomBytes(8).toString("hex")}`),
      headers: { "content-type": "text/plain" },
    });
    expect(put.status).toBe(200);
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    return id;
  }

  async function status(id = evidenceId) {
    const res = await call("GET", `/v1/evidence/${id}/artifacts/status`, A().ownerToken);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      outputs: {
        freshness: { hasNewerFacts: boolean; reportVersion: number; changes: Array<{ code: string; count?: number }> } | null;
        offer?: { revision?: string } | null;
      };
    };
  }

  async function newVersion(reason: string): Promise<number> {
    const before = await prisma.report.count({ where: { evidenceId } });
    const st = await status();
    const res = await call(
      "POST",
      `/v1/evidence/${evidenceId}/reports/regenerate`,
      A().ownerToken,
      { intent: "NEW_VERSION", reason, ...(st.outputs.offer?.revision ? { offerRevision: st.outputs.offer.revision } : {}) },
      { "idempotency-key": `boundary-${randomBytes(6).toString("hex")}` },
    );
    expect(res.statusCode, res.body).toBeLessThan(300);
    await runReportJobs(evidenceId);
    expect(await prisma.report.count({ where: { evidenceId } })).toBe(before + 1);
    return before + 1;
  }

  async function objectBytes(bucket: string, key: string): Promise<Buffer> {
    const stream = (await workerStorage.getObjectStream({ bucket, key })) as AsyncIterable<Buffer>;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  /** Seed the incident's seven events as STORED HISTORY, through the production appender. */
  async function seedHistoricalReviewCustody(): Promise<Array<{ id: string; sequence: number; eventHash: string | null; payload: unknown }>> {
    for (const status of HISTORICAL_STATUSES) {
      await prisma.$transaction((tx) =>
        appendCustodyEventTx(tx, { evidenceId, eventType: "REVIEW_DECISION_RECORDED", payload: { status, actorUserId: SENTINEL_ACTOR } }),
      );
    }
    return prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "REVIEW_DECISION_RECORDED" },
      orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, eventHash: true, payload: true },
    });
  }

  /** surface → forbidden values it carries. Empty means clean. */
  function leaks(surface: string, body: string, found: string[]): void {
    for (const forbidden of FORBIDDEN_IN_EXTERNAL) if (body.includes(forbidden)) found.push(`${surface}: ${forbidden}`);
    // No raw identifier of a user or workspace (deterministic fixture values).
    // OWNER DECISION 2026-10-24: the FULL forensic package keeps its documented
    // recomputable evidence-custody chain, so the owner and the workspace stay
    // where genuine evidence custody records them; no reviewer, member or
    // admin identifier, and nothing in any other artifact.
    const fullForensic = surface.startsWith("FULL_FORENSIC") && !surface.endsWith(".pdf");
    for (const [label, value] of identifiers()) {
      if (!value || !body.includes(value)) continue;
      if (fullForensic && (label === "owner" || label === "team")) continue;
      found.push(`${surface}: ${label} id`);
    }
    if (/status:\s*(CLOSED|REOPENED|IN_REVIEW)/.test(body)) found.push(`${surface}: review status line`);
  }

  const identifiers = (): Array<[string, string]> => [
    ["owner", A().ownerUserId],
    ["admin", A().adminUserId],
    ["member", A().memberUserId],
    ["viewer", (A() as { viewerUserId?: string }).viewerUserId ?? ""],
    ["team", A().teamId],
  ];

  /** The first value under `key`, anywhere in a response body. */
  function findKey(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object") return undefined;
    if (key in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[key];
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findKey(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  const reviewCustodyRows = () => prisma.custodyEvent.count({ where: { evidenceId, eventType: "REVIEW_DECISION_RECORDED" } });
  const custodyCount = () => prisma.custodyEvent.count({ where: { evidenceId } });

  let historical: Array<{ id: string; sequence: number; eventHash: string | null; payload: unknown }> = [];

  it("1 — the seven historical Review events make NO report owed (zero reportable changes, Update available absent)", async () => {
    const baseline = await status();
    expect(baseline.outputs.freshness?.hasNewerFacts ?? false).toBe(false);
    historical = await seedHistoricalReviewCustody();
    expect(historical.map((r) => (r.payload as { status: string }).status)).toEqual([...HISTORICAL_STATUSES]);
    const after = await status();
    expect(after.outputs.freshness?.hasNewerFacts ?? false).toBe(false);
    expect(after.outputs.freshness?.changes ?? []).toEqual([]);
  });

  it("2 — a report issued after them carries no Review event, verdict, status or internal actor (real Chromium PDF text)", async () => {
    const version = await newVersion("Boundary proof: issue a version after historical review custody.");
    const report = await prisma.report.findFirstOrThrow({ where: { evidenceId, version } });
    const pdf = await objectBytes(report.storageBucket!, report.storageKey!);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = (await extractPdfText(pdf)).replace(/\s+/g, " ");
    const found: string[] = [];
    leaks("PDF report text", text, found);
    expect(found).toEqual([]);
  });

  it("3 — neither package (FULL forensic, EXTERNAL disclosure) carries Review data, in any entry name or byte", async () => {
    const latest = await prisma.report.findFirstOrThrow({ where: { evidenceId }, orderBy: { version: "desc" } });
    const packages = await prisma.verificationPackage.findMany({
      where: { evidenceId, reportVersion: latest.version, state: "PUBLISHED" } as never,
    });
    expect(packages.map((p) => (p as { disclosureProfile: string | null }).disclosureProfile).sort()).toEqual(["EXTERNAL_DISCLOSURE", "FULL_FORENSIC"]);
    const found: string[] = [];
    const chains: Array<{ profile: string; events: Array<{ sequence: number; prevEventHash?: string | null; eventHash?: string | null }> }> = [];
    for (const pkg of packages) {
      const profile = (pkg as { disclosureProfile: string }).disclosureProfile;
      const zip = await objectBytes(pkg.storageBucket!, pkg.storageKey!);
      const entries = readZipEntries(zip);
      for (const [name, bytes] of entries) {
        leaks(`${profile} entry name ${name}`, name, found);
        // Text entries are scanned as text; the embedded PDF as extracted text.
        const body = name.endsWith(".pdf") ? (await extractPdfText(bytes)).replace(/\s+/g, " ") : bytes.toString("utf8");
        leaks(`${profile} ${name}`, body, found);
      }
      // The chain stays continuous: every sequence present, hashes linked.
      const custody = JSON.parse(entries.get("custody.json")?.toString("utf8") ?? "null") as
        | { events?: Array<{ sequence: number; prevEventHash?: string | null; eventHash?: string | null }> }
        | Array<{ sequence: number; prevEventHash?: string | null; eventHash?: string | null }>
        | null;
      chains.push({ profile, events: Array.isArray(custody) ? custody : (custody?.events ?? []) });
    }
    expect(found).toEqual([]);
    // The chain stays continuous: every sequence present, hashes linked.
    for (const { profile, events } of chains) {
      expect(events.length, profile).toBeGreaterThan(0);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.sequence, `${profile}: custody sequences stay continuous`).toBe(events[i - 1]!.sequence + 1);
        expect(events[i]!.prevEventHash, `${profile}: custody hashes stay linked`).toBe(events[i - 1]!.eventHash);
      }
    }
  });

  it("4 — Public Verify carries no Review event, verdict or internal actor", async () => {
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { verificationRef: true } });
    const page = await call("GET", `/public/verify/${encodeURIComponent(ev.verificationRef!)}`, null);
    expect(page.statusCode, page.body).toBe(200);
    const found: string[] = [];
    leaks("Public Verify API", page.body, found);
    expect(found).toEqual([]);
  });

  it("5 — issuing a report or package never makes that same version stale", async () => {
    const st = await status();
    expect(st.outputs.freshness?.hasNewerFacts ?? false).toBe(false);
    expect(st.outputs.freshness?.changes ?? []).toEqual([]);
    // Nor says its custody changed after it: the report and its package's own
    // issuance bookkeeping is never a forensic change after the snapshot —
    // on the Evidence page or on Public Verify.
    const ws = await call("GET", `/v1/evidence/${evidenceId}/review-workspace`, A().ownerToken);
    expect(ws.statusCode, ws.body).toBe(200);
    const wsConsistency = findKey(ws.json(), "trustDecisionConsistency") as { reasons: Array<{ code: string }> } | undefined;
    expect(wsConsistency, "the Evidence page states its trust consistency").toBeTruthy();
    expect(Array.isArray(wsConsistency!.reasons)).toBe(true);
    const wsCodes = wsConsistency!.reasons.map((r) => r.code);
    expect(wsCodes).not.toContain("FORENSIC_CUSTODY_CHANGED");
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { verificationRef: true } });
    const pv = await call("GET", `/public/verify/${encodeURIComponent(ev.verificationRef!)}`, null);
    const pvConsistency = findKey(pv.json(), "trustDecisionConsistency") as { reasons: Array<{ code: string }> } | undefined;
    expect(pvConsistency, "Public Verify states its trust consistency").toBeTruthy();
    const pvCodes = pvConsistency!.reasons.map((r) => r.code);
    expect(pvCodes).not.toContain("FORENSIC_CUSTODY_CHANGED");
  });

  it("6 — NEW Review activity through the real routes writes zero forensic custody, owes no report, and stays in Review history + tenant audit", async () => {
    const custodyBefore = await custodyCount();
    const auditBefore = await prisma.adminAuditLog.count({ where: { workspaceId: A().teamId, resourceId: { not: null } } });
    const wf0 = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/claim`, A().memberToken, { teamId: A().teamId })).statusCode).toBe(200);
    const wf1 = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
    expect(
      (await call("PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, A().memberToken, { status: "IN_REVIEW", priority: "HIGH", expectedUpdatedAt: wf1.updatedAt.toISOString() })).statusCode,
    ).toBe(200);
    const decide = (decision: string, note?: string) =>
      call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().memberToken, {
        decision,
        note: note ?? null,
        ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
      });
    expect((await decide("REQUEST_MORE_INFO", SENTINEL_NOTE)).statusCode).toBe(200);
    const wf2 = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
    expect((await call("PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, A().memberToken, { status: "IN_REVIEW", expectedUpdatedAt: wf2.updatedAt.toISOString() })).statusCode).toBe(200);
    expect((await decide("ESCALATE", SENTINEL_NOTE)).statusCode).toBe(200);
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "APPROVE_INTERNAL", note: null })).statusCode).toBe(200);
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().memberToken, { decision: "APPROVE_INTERNAL", note: null })).statusCode).toBe(200);
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "CLOSE", note: "closing" })).statusCode).toBe(200);
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "REOPEN", note: "again" })).statusCode).toBe(200);

    expect(wf0.id).toBe(wf1.id);
    // Zero forensic custody for any of it.
    expect(await custodyCount(), "Review activity wrote forensic custody").toBe(custodyBefore);
    expect(await reviewCustodyRows()).toBe(HISTORICAL_STATUSES.length);
    // No report owed by it.
    const st = await status();
    expect(st.outputs.freshness?.hasNewerFacts ?? false).toBe(false);
    // Durable in Review history and the tenant audit.
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: wf0.id, createdAt: { gt: wf0.updatedAt } } })).toBeGreaterThanOrEqual(8);
    expect(await prisma.workflowReviewDecision.count({ where: { workflowId: wf0.id } })).toBeGreaterThanOrEqual(3);
    const audit = await prisma.adminAuditLog.findMany({
      where: { workspaceId: A().teamId, action: { startsWith: "review" }, createdAt: { gt: wf0.updatedAt } } as never,
      select: { action: true },
    });
    const actions = new Set(audit.map((a) => a.action));
    for (const expected of ["review.claimed", "review.decision.recorded", "review.closed", "review.reopened"]) {
      expect(actions, `tenant audit lacks ${expected}: ${[...actions].join(", ")}`).toContain(expected);
    }
    expect(await prisma.adminAuditLog.count({ where: { workspaceId: A().teamId, resourceId: { not: null } } })).toBeGreaterThan(auditBefore);
  });

  it("7 — APPROVED then CLOSED projects Workflow Closed · Decision Approved (never 'Not accepted')", async () => {
    // State after test 6: reopened into a new round — close it with no verdict
    // first (No decision), then reopen, approve twice (escalated → second
    // review) and close: Closed · Approved.
    const ws = async () => {
      const res = await call("GET", `/v1/evidence/${evidenceId}/review-workspace`, A().adminToken);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().reviewWorkflow as { workflowState: string; decision: string; status: string };
    };
    const begin = async () => {
      const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
      const res = await call("PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, A().memberToken, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() });
      expect(res.statusCode, res.body).toBe(200);
    };
    await begin();
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "CLOSE", note: "no verdict" })).statusCode).toBe(200);
    expect(await ws()).toMatchObject({ workflowState: "CLOSED", decision: "NO_DECISION" });
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "REOPEN", note: "again" })).statusCode).toBe(200);
    expect((await ws()).decision).toBe("NO_DECISION");
    await begin();
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().memberToken, { decision: "APPROVE_INTERNAL", note: null })).statusCode).toBe(200);
    expect((await ws()).decision).toBe("APPROVED");
    expect((await call("POST", `/v1/review-operations/evidence/${evidenceId}/decision`, A().adminToken, { decision: "CLOSE", note: "done" })).statusCode).toBe(200);
    expect(await ws()).toMatchObject({ workflowState: "CLOSED", decision: "APPROVED" });
  });

  it("8 — the historical rows are byte-identical after everything, and a reconciliation run twice changes nothing", async () => {
    const now = await prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: "REVIEW_DECISION_RECORDED" },
      orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, eventHash: true, payload: true },
    });
    expect(now).toEqual(historical);
    const digest = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const { reconcileWorkflowProjection } = await import("../src/services/reviewer-ops/review-decision.service.js");
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
    const snapshot = async () =>
      digest([
        await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } }),
        await prisma.custodyEvent.count({ where: { evidenceId } }),
        (await status()).outputs.freshness,
      ]);
    await reconcileWorkflowProjection(wf.id);
    const first = await snapshot();
    await reconcileWorkflowProjection(wf.id);
    expect(await snapshot()).toBe(first);
  });
});
