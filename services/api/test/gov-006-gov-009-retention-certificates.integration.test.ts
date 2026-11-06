/**
 * GOV-006 and GOV-009, on the real database, the real worker reconciler and the
 * real service functions.
 *
 * GOV-006: a denied or cancelled retention review came back within one tick and
 * any open review blocked every download. GOV-009: the request certificate counted
 * what was asked for rather than what was verified, could be lost after deletion,
 * and "immutable" had nothing behind it in the database.
 *
 * FIXTURES (labelled): records and legacy request rows are seeded directly in the
 * posture a case needs. The request path's routes are proven by gov-001.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("retention decisions stick, certificates tell the truth (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let reconciler: typeof import("../../worker/src/governance/retention-reconciliation.worker.js");
  let reviews: typeof import("../src/services/governance-lifecycle/destruction-review.service.js");
  let exportGate: typeof import("../src/services/governance-lifecycle/export-governance.service.js");
  let requests: typeof import("../src/services/lifecycle/destruction-governance.service.js");

  const A = () => h.fixtures.teamA;

  async function record(over: Record<string, unknown> = {}) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { organizationId: true },
    });
    return prisma.evidence.create({
      data: {
        title: "gov-006 record",
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        ...over,
      } as never,
      select: { id: true },
    });
  }

  const tick = () => reconciler.runRetentionReconciliation({ trigger: "test", teamId: A().teamId });

  const trashed = () => {
    const past = new Date(Date.now() - 86_400_000);
    return { lifecycleState: "TRASHED", deletedAt: past, deleteScheduledForUtc: past };
  };

  async function approvedRequest(evidenceIds: string[]) {
    return (
      await prisma.destructionRequest.create({
        data: {
          teamId: A().teamId,
          state: "APPROVED",
          evidenceIds,
          reason: "gov-009 fixture",
          requestedByUserId: A().ownerUserId,
          approverUserIds: [{ userId: A().adminUserId, approvedAtUtc: new Date().toISOString() }],
        },
        select: { id: true },
      })
    ).id;
  }

  const execute = (requestId: string) =>
    requests.executeDestruction({ teamId: A().teamId, requestId, executorUserId: A().ownerUserId });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    reconciler = await import("../../worker/src/governance/retention-reconciliation.worker.js");
    reviews = await import("../src/services/governance-lifecycle/destruction-review.service.js");
    exportGate = await import("../src/services/governance-lifecycle/export-governance.service.js");
    requests = await import("../src/services/lifecycle/destruction-governance.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("GOV-006", () => {
    const expired = () => ({ retentionUntilUtc: new Date(Date.now() - 86_400_000) });

    it("expiry alone does not take a record's downloads away", async () => {
      const ev = await record(expired());
      await tick();
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } });
      expect(row.activeDestructionReviewId).not.toBeNull();
      const verdict = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: ev.id });
      expect(verdict.outcome).toBe("ALLOWED");
    });

    it.each(["DENIED", "CANCELLED"])("%s stands across ticks: no new review, downloads allowed", async (decision) => {
      const ev = await record(expired());
      await tick();
      const open = await prisma.destructionReview.findFirstOrThrow({ where: { evidenceId: ev.id } });
      await reviews.transitionDestructionReview({
        teamId: A().teamId,
        id: open.id,
        actorUserId: A().ownerUserId,
        nextStatus: "UNDER_REVIEW",
      });
      await reviews.transitionDestructionReview({
        teamId: A().teamId,
        id: open.id,
        actorUserId: A().adminUserId,
        nextStatus: decision as "DENIED",
        decisionNote: "this record stays",
      });
      await tick();
      await tick();
      expect(await prisma.destructionReview.count({ where: { evidenceId: ev.id } })).toBe(1);
      const verdict = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: ev.id });
      expect(verdict.outcome).toBe("ALLOWED");
    });

    it("the decision does not outlive the expiry it answered", async () => {
      const ev = await record(expired());
      await tick();
      const open = await prisma.destructionReview.findFirstOrThrow({ where: { evidenceId: ev.id } });
      await reviews.transitionDestructionReview({
        teamId: A().teamId,
        id: open.id,
        actorUserId: A().ownerUserId,
        nextStatus: "CANCELLED",
      });
      // Retention extended later, and that later date has now passed too.
      await prisma.evidence.update({
        where: { id: ev.id },
        data: { retentionUntilUtc: new Date(Date.now() + 2_000) },
      });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await tick();
      expect(await prisma.destructionReview.count({ where: { evidenceId: ev.id } })).toBe(2);
    });

    it("a deferred review wakes on its date, and one still in the future stays deferred", async () => {
      const due = await record();
      const later = await record();
      const seed = (evidenceId: string, deferredUntilUtc: Date) =>
        prisma.destructionReview.create({
          data: { teamId: A().teamId, evidenceId, status: "DEFERRED", reason: "manual_review", deferredUntilUtc },
          select: { id: true },
        });
      const dueReview = await seed(due.id, new Date(Date.now() - 60_000));
      const laterReview = await seed(later.id, new Date(Date.now() + 86_400_000));
      await tick();
      expect((await prisma.destructionReview.findUniqueOrThrow({ where: { id: dueReview.id } })).status).toBe("PENDING");
      expect((await prisma.destructionReview.findUniqueOrThrow({ where: { id: laterReview.id } })).status).toBe("DEFERRED");
    });

    it("a trash-sweep review a person declined does not come back on the next tick", async () => {
      const trash = await import("../../worker/src/governance/trash-grace-reconciler.js");
      const storage = {
        listObjectVersions: async () => [],
        deleteObjectVersion: async () => ({ ok: true }),
        listKeysUnderPrefix: async () => [],
      };
      const tick = () =>
        trash.runTrashGraceReconciliation({ storage: storage as never, trigger: "test" } as never);
      const ev = await record(trashed());
      await tick();
      const open = await prisma.destructionReview.findFirstOrThrow({ where: { evidenceId: ev.id } });
      expect(open.reason, "the canonical vocabulary").toBe("retention_expired");
      await reviews.transitionDestructionReview({
        teamId: A().teamId,
        id: open.id,
        actorUserId: A().ownerUserId,
        nextStatus: "CANCELLED",
      });
      await tick();
      await tick();
      expect(await prisma.destructionReview.count({ where: { evidenceId: ev.id } })).toBe(1);
    });

    it("an APPROVED review still gates downloads: a person has decided", async () => {
      const ev = await record(trashed());
      await prisma.evidence.update({ where: { id: ev.id }, data: { lifecycleState: "ACTIVE", deletedAt: null, deleteScheduledForUtc: null } });
      await prisma.destructionReview.create({
        data: { teamId: A().teamId, evidenceId: ev.id, status: "APPROVED", reason: "manual_review" },
      });
      const verdict = await exportGate.checkExportEligibility({ teamId: A().teamId, evidenceId: ev.id });
      expect(verdict.outcome).toBe("BLOCKED_BY_REVIEW_GATE");
    });
  });

  describe("GOV-009", () => {
    it("GOV-009: an export snapshot cannot be edited or deleted, and a new one is still written", async () => {
      const snap = await prisma.governanceExportSnapshot.create({
        data: {
          teamId: A().teamId,
          snapshotKind: "AUDIT_EXPORT",
          lifecycleState: "ACTIVE",
          exportEligibilityOutcome: "ALLOWED",
          exportEligibilityReason: "test",
          snapshotHash: "a".repeat(64),
          snapshotPayload: {},
        },
        select: { id: true },
      });
      await expect(
        prisma.governanceExportSnapshot.update({ where: { id: snap.id }, data: { exportEligibilityOutcome: "BLOCKED" } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.governanceExportSnapshot.delete({ where: { id: snap.id } })).rejects.toThrow(/append-only/);
      const kept = await prisma.governanceExportSnapshot.findUniqueOrThrow({ where: { id: snap.id } });
      expect(kept.exportEligibilityOutcome).toBe("ALLOWED");
    });

    it("a legacy request naming an id nothing resolves is refused, not certified over nothing", async () => {
      const id = await approvedRequest([randomUUID()]);
      await expect(execute(id)).rejects.toMatchObject({ publicCode: "DESTRUCTION_EVIDENCE_NOT_FOUND" });
      expect(await prisma.destructionCertificate.count({ where: { requestId: id } })).toBe(0);
    });

    it("the certificate counts verified records and lists an already destroyed one as an exception", async () => {
      const own = await record(trashed());
      const earlier = await record({
        lifecycleState: "DESTROYED",
        destroyedAtUtc: new Date(Date.now() - 86_400_000),
      });
      const id = await approvedRequest([own.id, earlier.id]);
      await execute(id);
      const cert = await prisma.destructionCertificate.findUniqueOrThrow({ where: { requestId: id } });
      expect(cert.evidenceCount).toBe(1);
      const body = JSON.parse(cert.certificateBody!) as {
        evidenceCount: number;
        requestedEvidenceCount: number;
        verifiedEvidenceIds: string[];
        exceptions: Array<{ evidenceId: string; reason: string }>;
      };
      expect(body.requestedEvidenceCount).toBe(2);
      expect(body.verifiedEvidenceIds).toEqual([own.id]);
      expect(body.exceptions).toEqual([{ evidenceId: earlier.id, reason: "ALREADY_DESTROYED_BEFORE_THIS_REQUEST" }]);
    });

    it("the artifact is served from the row and its hash recomputes from the body it carries", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      await execute(id);
      const artifact = await requests.getDestructionCertificateArtifact({ teamId: A().teamId, requestId: id });
      if (!artifact.ok) throw new Error(artifact.denial);
      const { canonicalJsonValue } = await import("@proovra/shared/custody-hash");
      const { createHash } = await import("node:crypto");
      const parsed = JSON.parse(artifact.bytes.toString("utf8")) as {
        certificateBody: unknown;
        certificateHash: string;
      };
      expect(createHash("sha256").update(canonicalJsonValue(parsed.certificateBody), "utf8").digest("hex")).toBe(
        parsed.certificateHash,
      );
    });

    it("a repeat of a finished request answers with the same certificate", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      const first = await execute(id);
      const second = await execute(id);
      expect(second.certificateId).toBe(first.certificateId);
      expect(await prisma.destructionCertificate.count({ where: { requestId: id } })).toBe(1);
    });

    it("a request stranded COMPLETED by a crash is certified on the next call", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      await execute(id);
      const cert = await prisma.destructionCertificate.findUniqueOrThrow({ where: { requestId: id } });
      const fresh = await record(trashed());
      const strandedId = await approvedRequest([fresh.id]);
      await prisma.destructionRequest.update({
        where: { id: strandedId },
        data: { state: "COMPLETED", executedAtUtc: new Date() },
      });
      const res = await execute(strandedId);
      expect(res.certificateId).not.toBe(cert.id);
      const stranded = await prisma.destructionRequest.findUniqueOrThrow({ where: { id: strandedId } });
      expect(stranded.state).toBe("CERTIFIED");
      // Nothing was verified for this request, and the certificate says so.
      const row = await prisma.destructionCertificate.findUniqueOrThrow({ where: { requestId: strandedId } });
      expect(row.evidenceCount).toBe(0);
      expect(JSON.parse(row.certificateBody!).exceptions).toEqual([{ evidenceId: fresh.id, reason: "NOT_DESTROYED" }]);
    });

    it("a request left EXECUTING past its lease can be resumed; a live one cannot", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      await prisma.destructionRequest.update({
        where: { id },
        data: { state: "EXECUTING", executionStartedAtUtc: new Date() },
      });
      await expect(execute(id)).rejects.toMatchObject({ publicCode: "DESTRUCTION_REQUEST_EXECUTING" });
      await prisma.destructionRequest.update({
        where: { id },
        data: { executionStartedAtUtc: new Date(Date.now() - 31 * 60 * 1000) },
      });
      await execute(id);
      expect((await prisma.destructionRequest.findUniqueOrThrow({ where: { id } })).state).toBe("CERTIFIED");
    });

    it("two concurrent executes produce one winner and one certificate", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      const results = await Promise.allSettled([execute(id), execute(id)]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect(await prisma.destructionCertificate.count({ where: { requestId: id } })).toBe(1);
      expect(
        await prisma.custodyEvent.count({ where: { evidenceId: own.id, eventType: "EVIDENCE_PURGED" } }),
      ).toBe(1);
    });

    it("with no signing secret in production, execution refuses before anything is deleted", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      const saved = {
        node: process.env.NODE_ENV,
        cert: process.env.DESTRUCTION_CERT_SIGNING_SECRET,
        hook: process.env.WEBHOOK_SIGNING_SECRET,
      };
      delete process.env.DESTRUCTION_CERT_SIGNING_SECRET;
      delete process.env.WEBHOOK_SIGNING_SECRET;
      process.env.NODE_ENV = "production";
      try {
        await expect(execute(id)).rejects.toMatchObject({
          publicCode: "DESTRUCTION_CERTIFICATE_SIGNING_UNAVAILABLE",
        });
      } finally {
        process.env.NODE_ENV = saved.node;
        if (saved.cert !== undefined) process.env.DESTRUCTION_CERT_SIGNING_SECRET = saved.cert;
        if (saved.hook !== undefined) process.env.WEBHOOK_SIGNING_SECRET = saved.hook;
      }
      const row = await prisma.evidence.findUniqueOrThrow({
        where: { id: own.id },
        select: { lifecycleState: true, destroyedAtUtc: true },
      });
      expect(row).toEqual({ lifecycleState: "TRASHED", destroyedAtUtc: null });
      expect((await prisma.destructionRequest.findUniqueOrThrow({ where: { id } })).state).toBe("APPROVED");
    });

    it("GOV-009: the certificate carries an Ed25519 signature anyone can verify with the published key", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      await execute(id);
      const artifact = await requests.getDestructionCertificateArtifact({ teamId: A().teamId, requestId: id });
      if (!artifact.ok) throw new Error(artifact.denial);
      const parsed = JSON.parse(artifact.bytes.toString("utf8")) as {
        certificateHash: string;
        signatureEd25519: {
          algorithm: string;
          purpose: string;
          keyId: string;
          keyVersion: number;
          publicKeySha256: string;
          publicKeyPem: string;
          signatureBase64: string;
        };
      };
      const sig = parsed.signatureEd25519;
      expect(sig).toMatchObject({ algorithm: "Ed25519", purpose: "DESTRUCTION_CERTIFICATE" });
      const { createPublicKey, verify, createHash } = await import("node:crypto");
      const key = createPublicKey(sig.publicKeyPem);
      const message = Buffer.from(parsed.certificateHash, "hex");
      expect(verify(null, message, key, Buffer.from(sig.signatureBase64, "base64"))).toBe(true);
      // A different hash does not verify.
      expect(verify(null, Buffer.from("00".repeat(32), "hex"), key, Buffer.from(sig.signatureBase64, "base64"))).toBe(false);
      // The key is PROOVRA's registered key for this purpose, by fingerprint.
      const registered = await prisma.signingKey.findUniqueOrThrow({
        where: { keyId_version_purpose: { keyId: sig.keyId, version: sig.keyVersion, purpose: "DESTRUCTION_CERTIFICATE" } },
        select: { publicKeyPem: true, revokedAt: true },
      });
      const spki = (pem: string) =>
        createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");
      expect(spki(registered.publicKeyPem)).toBe(sig.publicKeySha256);
      expect(registered.revokedAt).toBeNull();
    });

    it("GOV-009: without a usable Ed25519 signer, execution refuses before anything is deleted", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      const saved = { path: process.env.SIGNING_PRIVATE_KEY_PATH, pem: process.env.SIGNING_PRIVATE_KEY_PEM };
      process.env.SIGNING_PRIVATE_KEY_PATH = "C:/nonexistent/rem3-no-key.pem";
      delete process.env.SIGNING_PRIVATE_KEY_PEM;
      try {
        await expect(execute(id)).rejects.toMatchObject({ publicCode: "DESTRUCTION_CERTIFICATE_SIGNING_UNAVAILABLE" });
      } finally {
        if (saved.path === undefined) delete process.env.SIGNING_PRIVATE_KEY_PATH;
        else process.env.SIGNING_PRIVATE_KEY_PATH = saved.path;
        if (saved.pem !== undefined) process.env.SIGNING_PRIVATE_KEY_PEM = saved.pem;
      }
      expect(
        await prisma.evidence.findUniqueOrThrow({ where: { id: own.id }, select: { lifecycleState: true, destroyedAtUtc: true } }),
      ).toEqual({ lifecycleState: "TRASHED", destroyedAtUtc: null });
      expect((await prisma.destructionRequest.findUniqueOrThrow({ where: { id } })).state).toBe("APPROVED");
    });

    it("GOV-009: a legal hold is released, never deleted", async () => {
      const own = await record();
      const hold = await prisma.evidenceLegalHold.create({
        data: { teamId: A().teamId, scope: "EVIDENCE", evidenceId: own.id, status: "ACTIVE", title: "gov-009 hold", placedByUserId: A().ownerUserId },
        select: { id: true },
      });
      await expect(prisma.evidenceLegalHold.delete({ where: { id: hold.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM evidence_legal_holds WHERE id = ${hold.id}::uuid`).rejects.toThrow(/append-only/);
      // Release is a state change and stays allowed.
      await prisma.evidenceLegalHold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAtUtc: new Date(), releasedByUserId: A().ownerUserId },
      });
      expect((await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("RELEASED");
    });

    it("the database itself refuses to rewrite a certificate or delete a governance row", async () => {
      const own = await record(trashed());
      const id = await approvedRequest([own.id]);
      await execute(id);
      await expect(
        prisma.$executeRaw`UPDATE destruction_certificates SET evidence_count = 99 WHERE request_id = ${id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRaw`DELETE FROM destruction_certificates WHERE request_id = ${id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRaw`DELETE FROM destruction_requests WHERE id = ${id}::uuid`,
      ).rejects.toThrow(/append-only/);
    });
  });
});
