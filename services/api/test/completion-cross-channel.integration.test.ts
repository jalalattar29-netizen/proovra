/**
 * UC-ARCH-002 / UC-ARCH-003 / UC-ARCH-005 / UC-ARCH-008 / UC-WEB-001 — ONE
 * creation and ONE finalization authority for every channel, executed through
 * the real HTTP routes against live PostgreSQL 16.
 *
 * Channels: web upload (POST /v1/evidence → parts → /complete), direct capture
 * (POST /v1/capture/direct-sessions … /complete) and external intake (public
 * token routes … /submit). Only the object store, the signer and the TSA are
 * doubled (the pattern of uc0-acquisition-capture.integration.test.ts).
 *
 * Proves, for each channel, including a repeated completion:
 *   - exactly one EVIDENCE_COMPLETED custody event;
 *   - exactly one evidence.create and one evidence.complete tenant-audit row;
 *   - exactly one reviewer workflow row (the record enters the reviewer queue);
 *   - the workspace default retention is stamped at creation;
 *   - no root upload URL is minted, and custody says so;
 * and that an intake record cannot be written or sealed by its owner of record
 * through the authenticated routes, and a web draft is finalized only at seal
 * and resumes into the same record on retry.
 */
import { createHash, randomBytes } from "node:crypto";
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
      `https://cross-channel-store.invalid/${encodeURIComponent(id(p))}?n=${randomBytes(4).toString("hex")}`,
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
        signatureBase64: Buffer.from(`cross-channel-sig:${hex}`).toString("base64"),
        keyId: "cross-channel-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "cross-channel-test-bucket";
process.env.S3_BUCKET = BUCKET;
const RETENTION_DAYS = 45;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function storeFromPutUrl(putUrl: string, bytes: Buffer) {
  const u = new URL(putUrl);
  objects.set(decodeURIComponent(u.pathname.slice(1)), bytes);
}

describe("one creation + finalization authority across channels (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const teamId = h.fixtures.teamA.teamId;
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    if (existing) {
      await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { defaultRetentionDays: RETENTION_DAYS } as never });
    } else {
      await prisma.workspaceGovernancePolicy.create({ data: { teamId, defaultRetentionDays: RETENTION_DAYS } as never });
    }
  }, 600_000);

  afterAll(async () => {
    if (h) {
      const teamId = h.fixtures.teamA.teamId;
      await prisma.workspaceGovernancePolicy
        .update({ where: { teamId }, data: { defaultRetentionDays: null } as never })
        .catch(() => undefined);
      if (originalBilling) {
        await prisma.team.update({ where: { id: teamId }, data: originalBilling as never }).catch(() => undefined);
      }
    }
    await h?.cleanup();
  }, 120_000);

  function call(method: "GET" | "POST", url: string, token: string | null, payload?: unknown) {
    return h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  }
  const A = () => h.fixtures.teamA;

  async function effects(evidenceId: string) {
    const [completed, createAudit, completeAudit, workflows, ev] = await Promise.all([
      prisma.custodyEvent.count({ where: { evidenceId, eventType: "EVIDENCE_COMPLETED" } }),
      prisma.adminAuditLog.count({ where: { resourceId: evidenceId, action: "evidence.create", outcome: "success" } }),
      prisma.adminAuditLog.count({ where: { resourceId: evidenceId, action: "evidence.complete", outcome: "success" } }),
      prisma.evidenceReviewWorkflow.count({ where: { evidenceId } }),
      prisma.evidence.findUniqueOrThrow({
        where: { id: evidenceId },
        select: { status: true, createdAt: true, retentionUntilUtc: true },
      }),
    ]);
    return { completed, createAudit, completeAudit, workflows, ev };
  }

  function expectCanonicalEffects(e: Awaited<ReturnType<typeof effects>>, label: string) {
    expect(e.ev.status, label).toBe("SIGNED");
    expect(e.completed, `${label}: EVIDENCE_COMPLETED`).toBe(1);
    expect(e.createAudit, `${label}: evidence.create audit`).toBe(1);
    expect(e.completeAudit, `${label}: evidence.complete audit`).toBe(1);
    expect(e.workflows, `${label}: reviewer workflow`).toBe(1);
    expect(e.ev.retentionUntilUtc, `${label}: retention`).not.toBeNull();
    const days = (e.ev.retentionUntilUtc!.getTime() - e.ev.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days), `${label}: retention days`).toBe(RETENTION_DAYS);
  }

  // --- channels -------------------------------------------------------------

  async function webUpload(opts: { captureSessionId?: string } = {}) {
    const token = A().ownerToken;
    const created = await call("POST", "/v1/evidence", token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: A().teamId,
      ...(opts.captureSessionId ? { captureSessionId: opts.captureSessionId } : {}),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    return { id, created };
  }
  async function webPart(id: string, index = 0) {
    const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, {
      partIndex: index,
      mimeType: "image/jpeg",
      originalFileName: `photo-${index}.jpg`,
    });
    expect(part.statusCode, part.body).toBe(201);
    storeFromPutUrl(part.json().upload.putUrl as string, Buffer.from(`web-${index}-${randomBytes(6).toString("hex")}`));
  }

  async function directCapture() {
    const token = A().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: A().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sid = open.json().session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sid}/evidence`, token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const id = reserve.json().evidence.evidenceId as string;
    const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "camera.jpg",
    });
    expect(part.statusCode, part.body).toBe(201);
    const bytes = Buffer.from(`mobile-${randomBytes(8).toString("hex")}`);
    storeFromPutUrl(part.json().upload.putUrl as string, bytes);
    const declare = await call("POST", `/v1/capture/direct-sessions/${sid}/parts/0/declaration`, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: null,
    });
    expect(declare.statusCode, declare.body).toBe(201);
    return { id, complete: () => call("POST", `/v1/capture/direct-sessions/${sid}/complete`, token) };
  }

  async function intakeUpToParts(opts: { caseId?: string } = {}) {
    const link = await call("POST", "/v1/workflow/intake-links", A().ownerToken, {
      teamId: A().teamId,
      ...(opts.caseId ? { caseId: opts.caseId } : {}),
      workflowTemplateSlug: "general-evidence-record",
      intakeMode: "EXTERNAL_REUSABLE",
      recipientLabel: "cross-channel",
      expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(link.statusCode, link.body).toBe(201);
    const linkId = (link.json() as { link?: { id: string }; id?: string }).link?.id ?? (link.json() as { id: string }).id;
    const t = encodeURIComponent((link.json() as { rawToken: string }).rawToken);
    const boot = await call("GET", `/v1/external-intake/${t}`, null);
    const opened = boot.json() as {
      session: { id: string };
      link: { consentPolicyVersion: string | null; consentDisclosureText: string | null };
    };
    const sid = opened.session.id;
    const consent = await call("POST", `/v1/external-intake/${t}/sessions/${sid}/consent`, null, {
      consent: {
        acceptedAtUtc: new Date().toISOString(),
        policyVersion: opened.link.consentPolicyVersion || "v1",
        disclosureTextHash: sha256(opened.link.consentDisclosureText ?? ""),
        termsAcknowledged: true,
        identityDisclosed: true,
        ipHash: null,
        userAgent: null,
      },
    });
    expect(consent.statusCode, consent.body).toBeLessThan(300);
    const bytes = Buffer.from(`intake-${randomBytes(8).toString("hex")}`);
    const part = await call("POST", `/v1/external-intake/${t}/sessions/${sid}/parts`, null, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "statement.jpg",
      checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
      webkitRelativePath: null,
    });
    expect(part.statusCode, part.body).toBe(201);
    storeFromPutUrl(part.json().upload.putUrl as string, bytes);
    const session = await prisma.workflowIntakeSession.findUniqueOrThrow({
      where: { id: sid },
      select: { evidenceId: true },
    });
    return {
      id: session.evidenceId!,
      linkId,
      token: t,
      sid,
      submit: () => call("POST", `/v1/external-intake/${t}/sessions/${sid}/submit`, null, {}),
    };
  }

  // --- UC-ARCH-003 / UC-ARCH-002 --------------------------------------------

  it("web upload: one completion custody event, audit pair, reviewer row and retention — repeated complete adds none", async () => {
    const { id } = await webUpload();
    await webPart(id);
    const first = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(first.statusCode, first.body).toBe(200);
    const again = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(again.statusCode, again.body).toBe(200);
    expectCanonicalEffects(await effects(id), "web");
  });

  it("direct capture: the same effects, exactly once, including a repeated complete", async () => {
    const dc = await directCapture();
    const first = await dc.complete();
    expect(first.statusCode, first.body).toBe(200);
    const again = await dc.complete();
    expect(again.statusCode).toBeLessThan(500);
    expectCanonicalEffects(await effects(dc.id), "direct-capture");
  });

  it("intake submission: the same effects, exactly once, including a repeated submit", async () => {
    const intake = await intakeUpToParts();
    const first = await intake.submit();
    expect(first.statusCode, first.body).toBeLessThan(300);
    const again = await intake.submit();
    expect(again.statusCode).toBeLessThan(500);
    const e = await effects(intake.id);
    expectCanonicalEffects(e, "intake");
    // The contributor, not the owner of record, completed it.
    const ev = await prisma.custodyEvent.findFirstOrThrow({
      where: { evidenceId: intake.id, eventType: "EVIDENCE_COMPLETED" },
      select: { payload: true },
    });
    expect((ev.payload as Record<string, unknown>).completedBy).toBe("EXTERNAL_CONTRIBUTOR");
    expect((ev.payload as Record<string, unknown>).completedByUserId).toBeNull();
  });

  // --- UC-CASE-003 ----------------------------------------------------------

  it("an intake link issued for a case puts the submitted record IN the case (once, source INTAKE)", async () => {
    const { id: caseId } = await prisma.case.create({
      data: { name: `intake-case-${randomBytes(3).toString("hex")}`, teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    const intake = await intakeUpToParts({ caseId });
    const first = await intake.submit();
    expect(first.statusCode, first.body).toBeLessThan(300);
    const again = await intake.submit();
    expect(again.statusCode).toBeLessThan(500);
    const rows = await prisma.caseEvidenceLink.findMany({ where: { caseId, evidenceId: intake.id }, select: { source: true } });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.source)).toBe("INTAKE");
    // A link without a case is unchanged: no case link at all.
    const plain = await intakeUpToParts();
    await plain.submit();
    expect(await prisma.caseEvidenceLink.count({ where: { evidenceId: plain.id } })).toBe(0);
    await prisma.caseEvidenceLink.deleteMany({ where: { caseId } });
    await prisma.case.delete({ where: { id: caseId } }).catch(() => undefined);
  });

  // --- UC-ARCH-008 ----------------------------------------------------------

  it("creation mints no root upload URL, and custody says none was issued", async () => {
    const { id, created } = await webUpload();
    const body = created.json() as Record<string, unknown>;
    expect(body.upload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("cross-channel-store.invalid");
    const auth = await prisma.custodyEvent.findFirstOrThrow({
      where: { evidenceId: id, eventType: "UPLOAD_AUTHORIZED" },
      select: { payload: true },
    });
    const payload = auth.payload as Record<string, unknown>;
    expect(payload.uploadUrlIssued).toBe(false);
    expect(String(payload.meaning)).toMatch(/No upload URL was issued/);
  });

  // --- UC-ARCH-005 ----------------------------------------------------------

  it("the link creator cannot add parts to, or seal, a contributor's in-flight intake record", async () => {
    const intake = await intakeUpToParts();
    const inject = await call("POST", `/v1/evidence/${intake.id}/parts`, A().ownerToken, {
      partIndex: 50,
      mimeType: "image/jpeg",
      originalFileName: "injected.jpg",
    });
    expect(inject.statusCode, inject.body).toBe(409);
    expect(await prisma.evidencePart.count({ where: { evidenceId: intake.id, partIndex: 50 } })).toBe(0);
    const seal = await call("POST", `/v1/evidence/${intake.id}/complete`, A().ownerToken, {});
    expect(seal.statusCode, seal.body).toBe(409);
    expect(seal.json().code).toBe("INTAKE_SUBMISSION_REQUIRED");
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: intake.id }, select: { status: true } })).status).not.toBe("SIGNED");
    // The in-flight record id is not disclosed to the link creator.
    const list = await call("GET", `/v1/workflow/intake-links/${intake.linkId}/submissions`, A().ownerToken);
    if (list.statusCode === 200) expect(list.body).not.toContain(intake.id);
    // The contributor still completes it.
    const submit = await intake.submit();
    expect(submit.statusCode, submit.body).toBeLessThan(300);
  });

  // --- UC-WEB-003 ----------------------------------------------------------

  it("a reload resumes the contributor's open intake session with its staged files; another browser does not", async () => {
    const intake = await intakeUpToParts();
    const ua = "intake-browser/1.0";
    // The session was opened without a UA in this harness; record one as the browser that opened it.
    await prisma.workflowIntakeSession.update({ where: { id: intake.sid }, data: { submitterUserAgent: ua } });
    const reload = await h.app.inject({
      method: "GET",
      url: `/v1/external-intake/${intake.token}`,
      headers: { "user-agent": ua, "x-proovra-intake-session": intake.sid },
    });
    expect(reload.statusCode, reload.body).toBe(200);
    const body = reload.json() as { resumed: boolean; session: { id: string; consentAcceptedAtUtc: string | null }; parts: Array<{ partIndex: number; stored: boolean }> };
    expect(body.resumed).toBe(true);
    expect(body.session.id).toBe(intake.sid);
    expect(body.session.consentAcceptedAtUtc).not.toBeNull();
    expect(body.parts).toEqual([expect.objectContaining({ partIndex: 0, stored: true })]);
    expect(reload.body).not.toMatch(/storageKey|putUrl|X-Amz/);
    // Another browser presenting the same id gets a fresh session, not this one.
    const other = await h.app.inject({
      method: "GET",
      url: `/v1/external-intake/${intake.token}`,
      headers: { "user-agent": "other-browser/2.0", "x-proovra-intake-session": intake.sid },
    });
    expect(other.json().session.id).not.toBe(intake.sid);
    expect(other.json().resumed).toBe(false);
    expect(other.json().parts).toEqual([]);
  });

  // --- UC-WEB-001 -----------------------------------------------------------

  it("a web draft stays DRAFT until the record is sealed, and a retried finalize resumes the same record", async () => {
    const draft = await prisma.captureSession.create({
      data: { ownerUserId: A().ownerUserId, teamId: A().teamId, status: "DRAFT" },
      select: { id: true },
    });
    const first = await webUpload({ captureSessionId: draft.id });
    const afterCreate = await prisma.captureSession.findUniqueOrThrow({
      where: { id: draft.id },
      select: { status: true, finalizedEvidenceId: true },
    });
    expect(afterCreate.status).toBe("DRAFT");
    expect(afterCreate.finalizedEvidenceId).toBe(first.id);
    await webPart(first.id, 0);

    // A part upload failed; the user clicks Finish & Sign again.
    const retry = await call("POST", "/v1/evidence", A().ownerToken, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: A().teamId,
      captureSessionId: draft.id,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().id).toBe(first.id);
    expect(retry.json().resumed).toBe(true);
    expect((retry.json().parts as Array<{ partIndex: number }>).map((p) => p.partIndex)).toEqual([0]);

    await webPart(first.id, 1);
    const done = await call("POST", `/v1/evidence/${first.id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);
    const sealed = await prisma.captureSession.findUniqueOrThrow({
      where: { id: draft.id },
      select: { status: true, finalizedAtUtc: true },
    });
    expect(sealed.status).toBe("FINALIZED");
    expect(sealed.finalizedAtUtc).not.toBeNull();
  });
});
