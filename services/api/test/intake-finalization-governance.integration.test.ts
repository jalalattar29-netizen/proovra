/**
 * EXTERNAL INTAKE OBEYS THE FINALIZATION GOVERNANCE GATE (2026-09-29, audit
 * D3) — live PostgreSQL 16, the real submit service, a recording object store.
 *
 * `submitExternalIntake` is the one finalizer of a contributor's submission
 * (the public route calls it and maps the refusal to INTAKE_NOT_ACCEPTING_
 * EVIDENCE without disclosing the policy). Pinned here:
 *   * a receiving workspace whose policy forbids public Verify refuses the
 *     submission: nothing is signed, nothing is published, public Verify
 *     serves nothing, and the refusal is on the record's custody chain;
 *   * a workspace that requires publication approval finalizes the record
 *     SIGNED but NOT_PUBLISHED, and public Verify does not serve it.
 */
import { createHash, randomUUID } from "node:crypto";
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
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "application/pdf",
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

describe("external intake — finalization governance (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const bucket = "intake-fixture-bucket";

  beforeAll(async () => {
    // The submission mints a real link (ET-INT-09), so the intake feature is on.
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "remediation-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function withPolicy(data: Record<string, unknown>, fn: () => Promise<void>) {
    const teamId = h.fixtures.teamA.teamId;
    const existing = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    if (existing) await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: data as never });
    else await prisma.workspaceGovernancePolicy.create({ data: { teamId, ...data } as never });
    try {
      await fn();
    } finally {
      await prisma.workspaceGovernancePolicy.update({
        where: { teamId },
        data: { allowPublicVerify: true, requirePublicationApproval: false } as never,
      });
    }
  }

  /** A contributor's submission, ready to submit: one uploaded part. */
  async function submission() {
    const { teamA } = h.fixtures;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: "intake submission",
        type: "DOCUMENT",
        status: "CREATED",
        teamId: teamA.teamId,
        organizationId: team.organizationId,
        ownerUserId: teamA.ownerUserId,
        mimeType: "application/pdf",
        // UC-ARCH-005 — what every real intake record carries: the finalizer
        // seals an intake record only through its bound intake session.
        acquisitionMode: "SECURE_INTAKE_LINK",
        acquisitionModeSource: "RECORDED_AT_CREATION",
      } as never,
      select: { id: true },
    });
    const key = `evidence/${ev.id}/parts/000-original.pdf`;
    const bytes = Buffer.from(`%PDF intake ${randomUUID()}`);
    objects.set(`${bucket}/${key}`, bytes);
    await prisma.evidencePart.create({
      data: {
        evidenceId: ev.id,
        partIndex: 0,
        storageBucket: bucket,
        storageKey: key,
        mimeType: "application/pdf",
        sizeBytes: BigInt(bytes.length),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      } as never,
    });
    // The link is a REAL row (ET-INT-09: a submission consumes one of the
    // link's uses, reserved before finalization); the session is a plain OPEN
    // consented value, as before.
    const { createWorkflowIntakeLink } = await import("../src/services/workflow-intake-link.service.js");
    const minted = await createWorkflowIntakeLink(
      {
        teamId: teamA.teamId,
        workflowTemplateSlug: "general-evidence-record",
        intakeMode: "EXTERNAL_REUSABLE",
        recipientLabel: "governance",
        maxUses: 5,
        expiresAtUtc: new Date(Date.now() + 3_600_000),
      } as never,
      { actorUserId: teamA.ownerUserId },
    );
    const link = { ...minted.link, locationPolicy: "NONE", workflowTemplateSnapshot: {} } as never;
    // A REAL session row bound to the record (UC-ARCH-005: the finalizer
    // refuses an intake record whose session it cannot find), left in CREATED
    // so the SUBMITTED transition after finalization is refused by the state
    // machine — exactly the ET-INT-13 post-commit failure.
    const row = await prisma.workflowIntakeSession.create({
      data: {
        intakeLinkId: (minted.link as { id: string }).id,
        evidenceId: ev.id,
        status: "CREATED",
        expiresAtUtc: new Date(Date.now() + 3600_000),
      } as never,
      select: { id: true },
    });
    const session = {
      // The in-memory value the route would hold; its DB row stays CREATED.
      id: row.id,
      status: "OPEN",
      expiresAtUtc: new Date(Date.now() + 3600_000),
      consentAcceptedAtUtc: new Date(),
      evidenceId: ev.id,
    } as never;
    return { evidenceId: ev.id, link, session, linkId: (minted.link as { id: string }).id };
  }

  const publicVerify = (id: string) => h.app.inject({ method: "GET", url: `/public/verify/${id}` });

  it("a workspace whose policy forbids public Verify refuses the submission: nothing signed, published or served", async () => {
    const { submitExternalIntake, ExternalIntakeOrchestrationError } = await import(
      "../src/services/external-intake-orchestration.service.js"
    );
    await withPolicy({ allowPublicVerify: false }, async () => {
      const s = await submission();
      const err = await submitExternalIntake({ link: s.link, session: s.session }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ExternalIntakeOrchestrationError);
      expect((err as { code: string }).code).toBe("finalization_blocked_by_policy");
      // ET-INT-13 — an anonymous contributor retrying the refused submit does
      // not grow the chain: the refusal is recorded once while it is unchanged.
      for (let i = 0; i < 3; i += 1) {
        await submitExternalIntake({ link: s.link, session: s.session }).catch(() => null);
      }

      const ev = await prisma.evidence.findUniqueOrThrow({
        where: { id: s.evidenceId },
        select: { status: true, signedAtUtc: true, signatureBase64: true, publicVerifyState: true },
      });
      expect(ev.status).not.toBe("SIGNED");
      expect(ev.signedAtUtc).toBeNull();
      expect(ev.signatureBase64).toBeNull();
      expect(ev.publicVerifyState).not.toBe("PUBLISHED");
      expect((await publicVerify(s.evidenceId)).statusCode).toBe(404);
      expect(
        await prisma.custodyEvent.count({ where: { evidenceId: s.evidenceId, eventType: "EXPORT_BLOCKED_BY_POLICY" } }),
      ).toBe(1);
    });
  });

  it("a workspace requiring publication approval finalizes the submission SIGNED but NOT_PUBLISHED; public Verify does not serve it", async () => {
    const { submitExternalIntake } = await import("../src/services/external-intake-orchestration.service.js");
    await withPolicy({ requirePublicationApproval: true }, async () => {
      const s = await submission();
      // ET-INT-13 — the SUBMITTED transition fails on this harness's session
      // value AFTER the record was finalized; the submission still succeeds.
      await expect(submitExternalIntake({ link: s.link, session: s.session })).resolves.toBeTruthy();
      // A retry finalizes nothing again and consumes no second use.
      await expect(submitExternalIntake({ link: s.link, session: s.session })).resolves.toBeTruthy();
      expect(await prisma.custodyEvent.count({ where: { evidenceId: s.evidenceId, eventType: "SIGNATURE_APPLIED" } })).toBe(1);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: s.evidenceId, eventType: "EXTERNAL_INTAKE_SUBMITTED" } })).toBe(1);
      expect((await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: s.linkId }, select: { usedCount: true } })).usedCount).toBe(1);
      const ev = await prisma.evidence.findUniqueOrThrow({
        where: { id: s.evidenceId },
        select: { status: true, publicVerifyState: true },
      });
      expect(ev.status).toBe("SIGNED");
      expect(ev.publicVerifyState).toBe("NOT_PUBLISHED");
      expect((await publicVerify(s.evidenceId)).statusCode).toBe(404);
    });
  });
});
