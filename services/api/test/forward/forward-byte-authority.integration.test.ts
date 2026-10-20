/**
 * PHASE 6 — ORIGINAL BYTE AUTHORITY AND DOWNLOAD POLICY (2026-10-20), on the
 * real stack: live PostgreSQL 16, real MinIO (versioned bucket), the real
 * route and the real download gate.
 *
 *   AUD-08  A single-file record's original link was presigned for the KEY,
 *           not the sealed version: any later PUT at the key (an upload URL is
 *           valid for 600 s after it is issued, sealing included) became the
 *           bytes served beside the sealed digest. Multipart parts were already
 *           pinned. The proof: PUT different bytes at the key after sealing,
 *           follow the link the record page hands out, and receive the SEALED
 *           bytes.
 *
 *   AUD-06  The FULL_FORENSIC package embeds the originals, but the gate only
 *           evaluated the workspace's `download_package` policy: a workspace
 *           that set `allowOriginalDownload = false` still released originals
 *           inside the package. The FULL package now answers the original-
 *           download policy too; the EXTERNAL_DISCLOSURE package (no originals)
 *           is unaffected.
 */
import { createHash, randomUUID } from "node:crypto";

import { CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("PHASE 6 — original byte authority and download policy (live PostgreSQL 16, MinIO)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let s3: (typeof import("../../src/storage.js"))["s3"];
  const created: string[] = [];
  // Its OWN versioned bucket on the disposable MinIO: the shared test bucket
  // stays unversioned, which other suites rely on (TRUST-008).
  const BUCKET = `aud08-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    ({ s3 } = await import("../../src/storage.js"));
    // The bucket must keep versions for a sealed version to exist at all
    // (Production's evidence bucket is versioned).
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: "Enabled" } }));
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  async function put(key: string, body: Buffer): Promise<string> {
    const res = await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "text/plain" }));
    expect(res.VersionId, "the bucket keeps versions").toBeTruthy();
    return res.VersionId!;
  }

  /** A sealed single-file record in team A, its bytes stored at a recorded version. */
  async function sealedSingleFile() {
    const { teamId, ownerUserId } = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const key = `evidence/${randomUUID()}/original.txt`;
    const sealed = Buffer.from(`sealed original ${randomUUID()}`);
    const versionId = await put(key, sealed);
    const row = await prisma.evidence.create({
      data: {
        title: "AUD-08 fixture",
        type: "DOCUMENT",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        storageBucket: BUCKET,
        storageKey: key,
        storageVersionId: versionId,
        mimeType: "text/plain",
        sizeBytes: BigInt(sealed.length),
        fileSha256: sha(sealed),
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    created.push(row.id);
    return { id: row.id, key, sealed, versionId };
  }

  /** Every presigned URL in an answer that addresses `key`. */
  function urlsFor(body: unknown, key: string): string[] {
    const found: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        if (/^https?:\/\//.test(v) && v.includes(key.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/"))) found.push(v);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(body);
    return found;
  }

  it("AUD-08: a PUT at the key after sealing never becomes the bytes the record's original link serves", async () => {
    const ev = await sealedSingleFile();
    // An upload URL issued before sealing is still valid: a later write lands.
    const later = Buffer.from("REPLACED AFTER SEALING");
    const laterVersion = await put(ev.key, later);
    expect(laterVersion).not.toBe(ev.versionId);

    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/evidence/${ev.id}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const links = urlsFor(res.json(), ev.key);
    expect(links.length, "the record page hands out an original link").toBeGreaterThan(0);
    for (const link of links) {
      const fetched = Buffer.from(await (await fetch(link)).arrayBuffer());
      expect(fetched.toString("utf8"), link).toBe(ev.sealed.toString("utf8"));
      expect(sha(fetched)).toBe(sha(ev.sealed));
      expect(new URL(link).searchParams.get("versionId")).toBe(ev.versionId);
    }
  });

  it("AUD-06: with original download disabled by workspace policy, the FULL package is refused and the EXTERNAL package is not", async () => {
    const ev = await sealedSingleFile();
    const { teamId, ownerUserId } = harness.fixtures.teamA;
    const { evaluateArtifactDownload } = await import("../../src/services/evidence/artifact-download-gate.service.js");
    const readAccess = async () => undefined;
    const before = await prisma.workspaceGovernancePolicy.findUnique({ where: { teamId } });
    try {
      await prisma.workspaceGovernancePolicy.upsert({
        where: { teamId },
        create: { teamId, allowOriginalDownload: false } as never,
        update: { allowOriginalDownload: false },
      });
      const full = await evaluateArtifactDownload({ evidenceId: ev.id, actorUserId: ownerUserId, kind: "package", readAccess });
      expect(full.allowed).toBe(false);
      if (!full.allowed) {
        expect(full.statusCode).toBe(403);
        expect(full.body).toMatchObject({ code: "FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS", reason: "original_download_disabled_by_policy" });
        expect(String(full.body.message)).toMatch(/external disclosure package is available instead/);
      }
      const original = await evaluateArtifactDownload({ evidenceId: ev.id, actorUserId: ownerUserId, kind: "original", readAccess });
      expect(original.allowed).toBe(false);
      const external = await evaluateArtifactDownload({ evidenceId: ev.id, actorUserId: ownerUserId, kind: "package_external", readAccess });
      expect(external.allowed, JSON.stringify(external)).toBe(true);

      // The policy allowing originals again releases the FULL package.
      await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { allowOriginalDownload: true } });
      const allowed = await evaluateArtifactDownload({ evidenceId: ev.id, actorUserId: ownerUserId, kind: "package", readAccess });
      expect(allowed.allowed, JSON.stringify(allowed)).toBe(true);
    } finally {
      if (before) {
        await prisma.workspaceGovernancePolicy.update({ where: { teamId }, data: { allowOriginalDownload: before.allowOriginalDownload } });
      } else {
        await prisma.workspaceGovernancePolicy.delete({ where: { teamId } }).catch(() => undefined);
      }
    }
  });

  /*
   * AUD-14 (2026-10-20) — the owner review workspace sends THE canonical TSA
   * proof status (the web and mobile Integrity rows state it): a provider
   * outage is NOT_OBTAINED, a kept token with no recorded cause is
   * RECORDED_NOT_VALIDATED, and neither reads as a failure.
   */
  it("AUD-14: the review workspace states the canonical TSA proof status for each stored FAILED", async () => {
    const proofOf = async (data: Record<string, unknown>) => {
      const ev = await sealedSingleFile();
      await prisma.evidence.update({ where: { id: ev.id }, data: data as never });
      const res = await harness.app.inject({
        method: "GET",
        url: `/v1/evidence/${ev.id}/review-workspace`,
        headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const find = (v: unknown): unknown => {
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (o.tsa && typeof o.tsa === "object" && "proofStatus" in (o.tsa as object)) return (o.tsa as Record<string, unknown>).proofStatus;
          for (const x of Object.values(o)) {
            const r = find(x);
            if (r !== undefined) return r;
          }
        }
        return undefined;
      };
      return find(res.json());
    };
    expect(await proofOf({ tsaStatus: "FAILED", tsaTokenBase64: null, tsaFailureCode: "tsa_provider_unreachable" })).toBe("NOT_OBTAINED");
    expect(await proofOf({ tsaStatus: "FAILED", tsaTokenBase64: "dG9rZW4=", tsaFailureCode: null })).toBe("RECORDED_NOT_VALIDATED");
    expect(await proofOf({ tsaStatus: "FAILED", tsaTokenBase64: "dG9rZW4=", tsaFailureCode: "tsa_message_imprint_mismatch" })).toBe("FAILED");
  });

  /*
   * AUD-21 (2026-10-20) — a client-declared device time is sanitised like
   * intake before it is recorded (and later signed into the fingerprint):
   * unparseable or far-future values are not recorded.
   */
  /*
   * AUD-57 (2026-10-20) — the current web-upload writer never stores
   * coordinates without their source. (Production holds one PROOVRA_WEB_UPLOAD
   * row with coordinates and a null source; the writer below cannot produce
   * it — its creation date is a post-deploy read-only check.)
   */
  it("AUD-57: a web upload with coordinates records their source", async () => {
    const teamId = harness.fixtures.teamA.teamId;
    const before = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { billingPlan: true, billingStatus: true } });
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    try {
      const res = await harness.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
        payload: JSON.stringify({ type: "PHOTO", mimeType: "image/jpeg", teamId, gps: { lat: 52.52, lng: 13.405, accuracyMeters: 10 } }),
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const id = res.json().id as string;
      created.push(id);
      const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { lat: true, locationSource: true, acquisitionMode: true } });
      expect(row.acquisitionMode).toBe("PROOVRA_WEB_UPLOAD");
      expect(row.lat).not.toBeNull();
      expect(row.locationSource).toBe("CAPTURE_BROWSER_GEOLOCATION");
    } finally {
      await prisma.team.update({ where: { id: teamId }, data: before as never });
    }
  });

  it("AUD-21: createEvidence records a sanitised device time, and nothing for an impossible one", async () => {
    const create = async (deviceTimeIso: string) => {
      const res = await harness.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}`, "content-type": "application/json" },
        payload: JSON.stringify({ type: "PHOTO", mimeType: "image/jpeg", teamId: harness.fixtures.teamA.teamId, deviceTimeIso }),
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const id = res.json().id as string;
      created.push(id);
      return (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { deviceTimeIso: true } })).deviceTimeIso;
    };
    const teamId = harness.fixtures.teamA.teamId;
    const before = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { billingPlan: true, billingStatus: true } });
    await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    try {
      expect(await create("2026-10-01T09:15:04+02:00")).toBe("2026-10-01T07:15:04.000Z");
      expect(await create("not a time")).toBeNull();
      expect(await create("2999-01-01T00:00:00Z")).toBeNull();
    } finally {
      await prisma.team.update({ where: { id: teamId }, data: before as never });
    }
  });
});
