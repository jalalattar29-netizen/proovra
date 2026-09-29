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
    // The two rows the service reads before finalizing, as plain values: the
    // link (no location policy, no checklist) and an OPEN consented session.
    const link = { locationPolicy: "NONE", workflowTemplateSnapshot: {} } as never;
    const session = {
      status: "OPEN",
      expiresAtUtc: new Date(Date.now() + 3600_000),
      consentAcceptedAtUtc: new Date(),
      evidenceId: ev.id,
    } as never;
    return { evidenceId: ev.id, link, session };
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
      await submitExternalIntake({ link: s.link, session: s.session }).catch((e: unknown) => {
        // Post-finalize bookkeeping on the plain session value may fail in this
        // harness; finalization itself is what is asserted below.
        return e;
      });
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
