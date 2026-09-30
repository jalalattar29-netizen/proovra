/**
 * UC-4 DERIVED review — byte release, generations and personal records.
 * Live PostgreSQL 16, real HTTP through the API (object store in memory).
 *
 *   UC-DER-002  derived bytes (keyframes, proxy, reconstruction JSON) leave only
 *               through THE byte-release gate: VIEWER refused, OWNER allowed,
 *               trashed refused, legal hold refused (custody recorded).
 *   UC-DER-009  bytes URLs are versioned by the derived digest, so a
 *               regenerated derivative is never served from a stale cache.
 *   UC-DER-001  Generate / Retry / Regenerate create a NEW run of a NEW
 *               generation that the worker can claim; the prior run is kept;
 *               the API never answers "queued" when nothing will run.
 *   UC-DER-010  a Personal record stored with team_id NULL works through its
 *               owner's personal workspace.
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
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
  };
});

const BUCKET = "der-test-bucket";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("UC-4 derived review — release, generations, personal (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const A = h.fixtures.teamA;
    for (const u of [A.ownerUserId, A.viewerUserId, A.adminUserId, A.memberUserId]) {
      await prisma.user.update({ where: { id: u }, data: { currentWorkspaceId: A.teamId } });
    }
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  /** A team-A screen record with one ORIGINAL part, a keyframe and a descriptor. */
  async function screenRecord(opts: { teamId?: string | null; ownerUserId?: string } = {}) {
    const A = h.fixtures.teamA;
    const teamId = opts.teamId === undefined ? A.teamId : opts.teamId;
    const orgTeam = await prisma.team.findUniqueOrThrow({
      where: { id: teamId ?? h.fixtures.personal.teamId },
      select: { organizationId: true },
    });
    const { id: evidenceId } = await prisma.evidence.create({
      data: {
        title: "DER fixture",
        type: "VIDEO",
        status: "SIGNED",
        teamId,
        organizationId: orgTeam.organizationId,
        ownerUserId: opts.ownerUserId ?? A.ownerUserId,
      } as never,
      select: { id: true },
    });
    const original = Buffer.from(`original-${randomUUID()}`);
    const { id: partId } = await prisma.evidencePart.create({
      data: {
        evidenceId,
        partIndex: 0,
        storageBucket: BUCKET,
        storageKey: `originals/${evidenceId}/0`,
        sha256: sha(original),
        mimeType: "video/mp4",
        artifactClass: "ORIGINAL",
      },
      select: { id: true },
    });
    return { evidenceId, partId };
  }

  async function derivedRow(input: {
    teamId: string;
    evidenceId: string;
    partId: string;
    kind: string;
    variant: string;
    bytes: Buffer;
    contentType: string;
  }) {
    const key = `derived-assets/${input.evidenceId}/${input.partId}/${input.kind}-${sha(input.bytes).slice(0, 16)}`;
    objects.set(`${BUCKET}/${key}`, input.bytes);
    const row = await prisma.evidencePartDerivedAsset.create({
      data: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        evidencePartId: input.partId,
        assetKind: input.kind,
        status: "COMPLETED",
        derivedSha256: sha(input.bytes),
        sizeBytes: input.bytes.length,
        contentType: input.contentType,
        storageBucket: BUCKET,
        storageKey: key,
        variantKey: input.variant,
        generatedAtUtc: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  }

  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, token: string, payload: unknown) =>
    h.app.inject({ method: "POST", url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });

  // ===========================================================================
  // UC-DER-002 / UC-DER-009 — derived bytes through the byte-release gate
  // ===========================================================================
  describe("derived bytes are released only through the byte-release gate", () => {
    it("OWNER gets the bytes; VIEWER (no download capability) is refused and sees no bytes URL", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, partId } = await screenRecord();
      const kf = Buffer.from("keyframe-webp-bytes");
      const assetId = await derivedRow({
        teamId: A.teamId, evidenceId, partId, kind: "video_keyframe", variant: "kf-0000", bytes: kf, contentType: "image/webp",
      });
      const bytesPath = `/v1/evidence/${evidenceId}/derived-assets/${assetId}/bytes?teamId=${A.teamId}`;

      const owner = await get(bytesPath, A.ownerToken);
      expect(owner.statusCode, owner.body).toBe(200);
      expect(owner.rawPayload.equals(kf)).toBe(true);

      const viewer = await get(bytesPath, A.viewerToken);
      expect([403, 404]).toContain(viewer.statusCode);
      expect(viewer.rawPayload.includes(kf)).toBe(false);

      // The listing gives the viewer no URL to try; the owner's is versioned.
      const viewerList = await get(`/v1/evidence/${evidenceId}/derived-assets?teamId=${A.teamId}`, A.viewerToken);
      expect(viewerList.statusCode).toBe(200);
      expect(viewerList.json().assets.every((a: { bytesUrl: string | null }) => a.bytesUrl === null)).toBe(true);
      const ownerList = await get(`/v1/evidence/${evidenceId}/derived-assets?teamId=${A.teamId}`, A.ownerToken);
      const url: string = ownerList.json().assets.find((a: { id: string }) => a.id === assetId).bytesUrl;
      expect(url).toContain(`v=${sha(kf).slice(0, 16)}`);
    });

    it("the reconstruction JSON (every OCR line) is refused to a VIEWER", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, partId } = await screenRecord();
      const json = Buffer.from(JSON.stringify({ observations: [{ text: "secret line" }] }));
      const assetId = await derivedRow({
        teamId: A.teamId, evidenceId, partId, kind: "screen_reconstruction", variant: "recon-v1", bytes: json, contentType: "application/json",
      });
      const res = await get(`/v1/evidence/${evidenceId}/derived-assets/${assetId}/bytes?teamId=${A.teamId}`, A.viewerToken);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("secret line");
    });

    it("a trashed record's derived bytes are refused, even to the OWNER", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, partId } = await screenRecord();
      const assetId = await derivedRow({
        teamId: A.teamId, evidenceId, partId, kind: "low_res_proxy", variant: "default", bytes: Buffer.from("proxy"), contentType: "video/webm",
      });
      await prisma.evidence.update({ where: { id: evidenceId }, data: { deletedAt: new Date(), lifecycleState: "TRASHED" } as never });
      const res = await get(`/v1/evidence/${evidenceId}/derived-assets/${assetId}/bytes?teamId=${A.teamId}`, A.ownerToken);
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("proxy");
    });

    it("a record under an active legal hold releases no derived bytes, and the refusal is on custody", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, partId } = await screenRecord();
      const assetId = await derivedRow({
        teamId: A.teamId, evidenceId, partId, kind: "video_frame", variant: "default", bytes: Buffer.from("frame"), contentType: "image/webp",
      });
      await prisma.evidenceLegalHold.create({
        data: {
          teamId: A.teamId, evidenceId, scope: "EVIDENCE", status: "ACTIVE",
          title: "DER hold", reason: "der-002 test", placedByUserId: A.ownerUserId,
        } as never,
      });
      const res = await get(`/v1/evidence/${evidenceId}/derived-assets/${assetId}/bytes?teamId=${A.teamId}`, A.ownerToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(await prisma.custodyEvent.count({ where: { evidenceId, eventType: "EXPORT_BLOCKED_BY_POLICY" } })).toBe(1);
    });

    it("DER-009: a regenerated derivative gets a NEW bytes URL (digest-versioned), so no stale cache", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId, partId } = await screenRecord();
      const assetId = await derivedRow({
        teamId: A.teamId, evidenceId, partId, kind: "image_thumbnail", variant: "default", bytes: Buffer.from("thumb-v1"), contentType: "image/webp",
      });
      const listUrl = `/v1/evidence/${evidenceId}/derived-assets?teamId=${A.teamId}`;
      const before: string = (await get(listUrl, A.ownerToken)).json().assets[0].bytesUrl;
      const v2 = Buffer.from("thumb-v2");
      await prisma.evidencePartDerivedAsset.update({ where: { id: assetId }, data: { derivedSha256: sha(v2) } });
      const after: string = (await get(listUrl, A.ownerToken)).json().assets[0].bytesUrl;
      expect(after).not.toBe(before);
      // A stale-versioned URL is never answered as immutable.
      await prisma.evidencePartDerivedAsset.update({ where: { id: assetId }, data: { derivedSha256: sha(Buffer.from("thumb-v1")) } });
      const stale = await get(after, A.ownerToken);
      expect(stale.headers["cache-control"]).not.toMatch(/immutable/);
    });

    it("the Derived Review projection (reconstructed OCR text) is withheld from a VIEWER with an honest reason", async () => {
      const A = h.fixtures.teamA;
      const { evidenceId } = await screenRecord();
      const res = await get(`/v1/evidence/${evidenceId}/derived-review?teamId=${A.teamId}`, A.viewerToken);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.projection).toBeNull();
      expect(body.release).toMatchObject({ allowed: false });
    });
  });

  // ===========================================================================
  // UC-DER-001 — generations
  // ===========================================================================
  describe("Generate / Retry / Regenerate create a new, claimable generation", () => {
    const runsOf = (evidenceId: string) =>
      prisma.mediaIntelligenceRun.findMany({
        where: { evidenceId, kind: "reconstruct_screen" },
        orderBy: { createdAtUtc: "asc" },
        select: { id: true, status: true, idempotencyKey: true, attemptCount: true },
      });
    const generate = (evidenceId: string, regenerate?: boolean) =>
      post(`/v1/evidence/${evidenceId}/derived-review/generate`, h.fixtures.teamA.ownerToken, {
        teamId: h.fixtures.teamA.teamId,
        ...(regenerate === undefined ? {} : { regenerate }),
      });

    it("first Generate → generation 1 PENDING; while in flight a second request is 409, not a phantom 'queued'", async () => {
      const { evidenceId } = await screenRecord();
      const res = await generate(evidenceId);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toMatchObject({ queued: true, generation: 1 });
      const runs = await runsOf(evidenceId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "PENDING", idempotencyKey: `reconstruct_screen:${evidenceId}` });
      expect((await generate(evidenceId, true)).statusCode).toBe(409);
    });

    it("Regenerate after COMPLETED → a NEW generation-2 run PENDING; the completed run is untouched", async () => {
      const { evidenceId } = await screenRecord();
      await generate(evidenceId);
      const [first] = await runsOf(evidenceId);
      await prisma.mediaIntelligenceRun.update({ where: { id: first!.id }, data: { status: "COMPLETED", attemptCount: 1 } });

      const res = await generate(evidenceId, true);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toMatchObject({ queued: true, generation: 2 });
      const runs = await runsOf(evidenceId);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ id: first!.id, status: "COMPLETED" });
      expect(runs[1]).toMatchObject({ status: "PENDING", attemptCount: 0, idempotencyKey: `reconstruct_screen:${evidenceId}:g2` });
      // The worker's claim ACCEPTS the new run (it refused the reused one).
      const { markRunProcessing } = await import("@proovra/shared-runtime/media-intelligence");
      expect((await markRunProcessing(runs[1]!.id, h.fixtures.teamA.teamId, prisma as never)).ok).toBe(true);
    });

    it("a COMPLETED review is not re-run by a plain Generate (honest answer, no phantom queue)", async () => {
      const { evidenceId } = await screenRecord();
      await generate(evidenceId);
      const [first] = await runsOf(evidenceId);
      await prisma.mediaIntelligenceRun.update({ where: { id: first!.id }, data: { status: "COMPLETED" } });
      const res = await generate(evidenceId, false);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ queued: false, reason: "already_generated" });
      expect(await runsOf(evidenceId)).toHaveLength(1);
    });

    it("Retry after FAILED at the attempt ceiling, and after DISMISSED, each run a fresh generation", async () => {
      const { evidenceId } = await screenRecord();
      await generate(evidenceId);
      const [first] = await runsOf(evidenceId);
      await prisma.mediaIntelligenceRun.update({ where: { id: first!.id }, data: { status: "FAILED", attemptCount: 5 } });
      const retry = await generate(evidenceId);
      expect(retry.statusCode, retry.body).toBe(202);
      let runs = await runsOf(evidenceId);
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ status: "PENDING", attemptCount: 0 });

      await prisma.mediaIntelligenceRun.update({ where: { id: runs[1]!.id }, data: { status: "DISMISSED" } });
      const again = await generate(evidenceId, true);
      expect(again.statusCode, again.body).toBe(202);
      runs = await runsOf(evidenceId);
      expect(runs).toHaveLength(3);
      expect(runs[2]!.idempotencyKey).toBe(`reconstruct_screen:${evidenceId}:g3`);
      // Every earlier run is preserved as history.
      expect(runs.map((r) => r.status)).toEqual(["FAILED", "DISMISSED", "PENDING"]);
    });

    it("the request is recorded on the record's custody chain with its generation", async () => {
      const { evidenceId } = await screenRecord();
      await generate(evidenceId);
      const ev = await prisma.custodyEvent.findFirst({
        where: { evidenceId, eventType: "MEDIA_INTELLIGENCE_REFRESH_REQUESTED" },
        select: { payload: true },
      });
      expect(ev?.payload).toMatchObject({ kind: "reconstruct_screen", generation: 1 });
    });
  });

  // ===========================================================================
  // UC-DER-010 — Personal (NULL-team) records
  // ===========================================================================
  describe("a Personal record stored with team_id NULL", () => {
    it("its owner can generate and read the Derived Review through the personal workspace", async () => {
      const P = h.fixtures.personal;
      await prisma.user.update({ where: { id: P.userId }, data: { currentWorkspaceId: P.teamId } });
      const { evidenceId } = await screenRecord({ teamId: null, ownerUserId: P.userId });
      const gen = await post(`/v1/evidence/${evidenceId}/derived-review/generate`, P.token, { teamId: P.teamId });
      expect(gen.statusCode, gen.body).toBe(202);
      const run = await prisma.mediaIntelligenceRun.findFirstOrThrow({ where: { evidenceId }, select: { teamId: true } });
      expect(run.teamId).toBe(P.teamId);
      const read = await get(`/v1/evidence/${evidenceId}/derived-review?teamId=${P.teamId}`, P.token);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().status.status).toBe("PENDING");
    });

    it("another workspace's member cannot reach it (anti-enumeration 404)", async () => {
      const P = h.fixtures.personal;
      const A = h.fixtures.teamA;
      const { evidenceId } = await screenRecord({ teamId: null, ownerUserId: P.userId });
      const res = await get(`/v1/evidence/${evidenceId}/derived-review?teamId=${A.teamId}`, A.ownerToken);
      expect(res.statusCode).toBe(404);
    });
  });
});
