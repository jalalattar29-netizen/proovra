/**
 * REPORT-004 — output preferences hold OUTPUTS, never sealing. Live
 * PostgreSQL 16, the real web upload → /complete route; only the object
 * store, the signer and the TSA are doubled (the completion-cross-channel
 * pattern).
 *
 *   * a restrictive output policy no longer refuses /complete (was 409
 *     REPORT_BLOCKED_BY_POLICY, record stuck UPLOADING): the record is SIGNED
 *     and its first outputs are HELD;
 *   * no report or package request exists while held — an explicit request
 *     answers RECOVERABLE_BLOCKED and writes nothing;
 *   * download and publication are refused while held;
 *   * when the policy allows the outputs, the release issues the first pair
 *     EXACTLY ONCE, even under concurrent releases.
 * Control: the same upload under a permissive policy is sealed and requested at
 * completion with no hold.
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://output-hold-store.invalid/${encodeURIComponent(id(p))}?n=${randomBytes(4).toString("hex")}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`output-hold-sig:${hex}`).toString("base64"),
        keyId: "output-hold-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "output-hold-test-bucket";
process.env.S3_BUCKET = BUCKET;

function storeFromPutUrl(putUrl: string, bytes: Buffer) {
  const u = new URL(putUrl);
  objects.set(decodeURIComponent(u.pathname.slice(1)), bytes);
}

describe("REPORT-004 held outputs (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let release: typeof import("../src/services/governance/output-hold-release.service.js");
  let authority: typeof import("../src/services/reports/report-generation-authority.service.js");
  let decisions: typeof import("../src/services/reviewer-ops/review-decision.service.js");
  let clearRates: () => Promise<unknown>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    release = await import("../src/services/governance/output-hold-release.service.js");
    authority = await import("../src/services/reports/report-generation-authority.service.js");
    decisions = await import("../src/services/reviewer-ops/review-decision.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    await prisma?.workspaceGovernancePolicy.deleteMany({ where: { teamId: h.fixtures.teamA.teamId } }).catch(() => undefined);
    await h?.cleanup();
  }, 120_000);

  const A = () => h.fixtures.teamA;
  function call(method: "GET" | "POST", url: string, token: string, payload?: unknown) {
    return h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  }
  async function policy(over: Record<string, boolean>) {
    const base = {
      allowReportDownload: true,
      allowPackageDownload: true,
      allowPublicVerify: true,
      requireReviewBeforeReport: false,
      requireReviewBeforePackage: false,
    };
    await prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: A().teamId },
      create: { teamId: A().teamId, ...base, ...over } as never,
      update: { ...base, ...over } as never,
    });
  }
  async function upload(): Promise<string> {
    await clearRates();
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "PHOTO", mimeType: "image/jpeg", teamId: A().teamId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "photo.jpg",
    });
    expect(part.statusCode, part.body).toBe(201);
    storeFromPutUrl(part.json().upload.putUrl as string, Buffer.from(`held-${randomBytes(8).toString("hex")}`));
    return id;
  }
  const requests = (evidenceId: string) => prisma.reportGenerationRequest.count({ where: { evidenceId } });
  const held = (id: string) =>
    prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { status: true, signedAtUtc: true, outputsHeldAtUtc: true, outputsHeldReason: true },
    });

  it("control: a permissive policy seals and requests the first pair at completion, with no hold", async () => {
    await policy({});
    const id = await upload();
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    const ev = await held(id);
    expect(ev.status).toBe("SIGNED");
    expect(ev.outputsHeldAtUtc).toBeNull();
    expect(await requests(id)).toBe(1);
  });

  it("a restrictive output policy seals and holds; nothing is issued, downloaded or published; the release issues exactly once", async () => {
    await policy({ allowReportDownload: false, allowPublicVerify: false });
    const id = await upload();

    // Sealing proceeds (was 409 REPORT_BLOCKED_BY_POLICY, record never signed).
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    let ev = await held(id);
    expect(ev.status).toBe("SIGNED");
    expect(ev.signedAtUtc).not.toBeNull();
    expect(ev.outputsHeldAtUtc).not.toBeNull();
    expect(ev.outputsHeldReason).toBeTruthy();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EXPORT_BLOCKED_BY_POLICY" } })).toBe(1);

    // No report or package request while held, on any door.
    expect(await requests(id)).toBe(0);
    const asked = await authority.requestReportGeneration({
      evidenceId: id,
      purpose: "evidence_completed",
      requestedByMachineId: "test.report-004",
    });
    expect(asked).toMatchObject({ requested: false, reason: "outputs_held_by_policy", outcome: "RECOVERABLE_BLOCKED" });
    expect(await release.releaseHeldOutputs(id)).toBe("still_held");
    expect(await requests(id)).toBe(0);

    // Download and publication are refused while held.
    const download = await call("GET", `/v1/evidence/${id}/report/latest`, A().ownerToken);
    expect(download.statusCode, download.body).not.toBe(200);
    const link = await call("POST", `/v1/evidence/${id}/verify-links`, A().ownerToken, {
      audience: "Opposing counsel",
      expiresInDays: 7,
    });
    expect(link.statusCode, link.body).toBe(403);
    expect(await prisma.verificationShareToken.count({ where: { evidenceId: id, purpose: "OWNER_SHARE" } })).toBe(0);

    // The policy now allows the outputs: concurrent releases issue ONE pair.
    await policy({ allowPublicVerify: false });
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => release.releaseHeldOutputs(id)));
    expect(outcomes.filter((o) => o === "released")).toHaveLength(1);
    ev = await held(id);
    expect(ev.outputsHeldAtUtc).toBeNull();
    expect(ev.status).toBe("SIGNED");
    expect(await requests(id)).toBe(1);
    // A later release, or the workspace sweep, issues nothing more.
    expect(await release.releaseHeldOutputs(id)).toBe("not_held");
    await release.releaseHeldOutputsForWorkspace(A().teamId);
    expect(await requests(id)).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { resourceId: id, action: "evidence.outputs_hold_released" } })).toBe(1);
  });

  it("the workspace sweep a policy update runs releases that workspace's held records", async () => {
    await policy({ allowReportDownload: false });
    const id = await upload();
    expect((await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {})).statusCode).toBe(200);
    expect((await held(id)).outputsHeldAtUtc).not.toBeNull();
    await policy({});
    const swept = await release.releaseHeldOutputsForWorkspace(A().teamId);
    expect(swept.released).toBeGreaterThanOrEqual(1);
    expect((await held(id)).outputsHeldAtUtc).toBeNull();
    expect(await requests(id)).toBe(1);
  });

  // ===========================================================================
  // Follow-up (2026-11-06): the approval trigger, and the periodic sweep.
  // ===========================================================================

  /** Put the record's review where an APPROVE is a legal move (fixture state). */
  async function inReview(evidenceId: string): Promise<string> {
    const wf = await prisma.evidenceReviewWorkflow.findFirstOrThrow({ where: { evidenceId }, select: { id: true } });
    await prisma.evidenceReviewWorkflow.update({
      where: { id: wf.id },
      data: { status: "IN_REVIEW", assignedToUserId: A().ownerUserId } as never,
    });
    return wf.id;
  }

  it("an approving review releases a record held for review: exactly one first report request", async () => {
    await policy({ requireReviewBeforeReport: true, requireReviewBeforePackage: true });
    const id = await upload();
    expect((await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {})).statusCode).toBe(200);
    expect((await held(id)).outputsHeldAtUtc).not.toBeNull();
    expect(await requests(id)).toBe(0);

    const workflowId = await inReview(id);
    const decided = await decisions.recordReviewDecision({
      workflowId,
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      decision: "APPROVE",
    });
    expect(decided.workflow.status).toBe("APPROVED_INTERNAL");
    expect((await held(id)).outputsHeldAtUtc).toBeNull();
    expect(await requests(id)).toBe(1);
    // A replay of the same decision issues nothing more.
    await decisions.recordReviewDecision({ workflowId, teamId: A().teamId, actorUserId: A().ownerUserId, decision: "APPROVE" });
    expect(await requests(id)).toBe(1);
  });

  it("control: an approval that leaves the policy refusing releases nothing", async () => {
    await policy({ requireReviewBeforeReport: true, allowReportDownload: false });
    const id = await upload();
    expect((await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {})).statusCode).toBe(200);
    const workflowId = await inReview(id);
    const decided = await decisions.recordReviewDecision({
      workflowId,
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      decision: "APPROVE",
    });
    expect(decided.workflow.status).toBe("APPROVED_INTERNAL");
    expect((await held(id)).outputsHeldAtUtc).not.toBeNull();
    expect(await requests(id)).toBe(0);
  });

  it("the periodic sweep releases a hold no event released, leaves a refused one untouched, and reports stale holds", async () => {
    release.resetOutputHoldSweepCursor();
    // Two records held under a refusing policy.
    await policy({ allowReportDownload: false });
    const releasable = await upload();
    const refused = await upload();
    for (const id of [releasable, refused]) {
      expect((await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {})).statusCode).toBe(200);
      expect((await held(id)).outputsHeldAtUtc).not.toBeNull();
    }
    // `refused` is held for a reason the next policy still refuses: the
    // finalizing actor's role no longer has the output permission.
    await prisma.evidence.update({ where: { id: refused }, data: { outputsHeldActorUserId: A().viewerUserId } });
    // The policy becomes permissive WITHOUT the route (no event fires).
    await policy({});
    const before = await prisma.evidence.findUniqueOrThrow({ where: { id: refused }, select: { updatedAt: true, outputsHeldReason: true } });
    const custodyBefore = await prisma.custodyEvent.count({ where: { evidenceId: refused } });

    const first = await release.sweepHeldOutputs({ staleAfterMs: 0 });
    expect(first.released).toBeGreaterThanOrEqual(1);
    expect(first.stale).toBeGreaterThanOrEqual(1);
    expect((await held(releasable)).outputsHeldAtUtc).toBeNull();
    expect(await requests(releasable)).toBe(1);
    expect((await held(refused)).outputsHeldAtUtc).not.toBeNull();
    expect(await requests(refused)).toBe(0);

    // Further passes: nothing more issued, and the refused record is not
    // re-written (beyond a reason change on the first pass) nor its chain grown.
    const afterFirst = await prisma.evidence.findUniqueOrThrow({ where: { id: refused }, select: { updatedAt: true, outputsHeldReason: true } });
    for (let i = 0; i < 3; i += 1) {
      release.resetOutputHoldSweepCursor();
      await release.sweepHeldOutputs();
    }
    const afterMany = await prisma.evidence.findUniqueOrThrow({ where: { id: refused }, select: { updatedAt: true, outputsHeldReason: true } });
    expect(afterMany.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(await prisma.custodyEvent.count({ where: { evidenceId: refused } })).toBe(custodyBefore);
    expect(await requests(releasable)).toBe(1);
    expect(before.outputsHeldReason).toBeTruthy();
  });
});
