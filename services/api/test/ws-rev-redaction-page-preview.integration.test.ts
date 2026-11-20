/**
 * PRO-R3-04 — the PDF redaction editor's page preview, end to end.
 * Live PostgreSQL 16, Redis and an object-store bucket this suite creates;
 * real HTTP, the real worker processor run in-process.
 *
 * At the base the editor drew regions on a blank frame: no route, no job and
 * no renderer produced the page. Here:
 *
 *   GET /v1/redaction/projects/:id/preview/pages/:n
 *
 *   - the owner's first ask commits ONE RedactionPagePreview row QUEUED and
 *     answers PENDING; asking again makes no second row;
 *   - after the RenderRedactionPagePreview job is processed the same read
 *     answers READY with a presigned URL of the PREVIEW object (a PNG), never
 *     the original's key, and no bucket or key field;
 *   - a VIEWER (no region-authoring capability) is refused and queues nothing;
 *   - another workspace is refused and queues nothing;
 *   - a workspace without the redaction entitlement cannot queue a render;
 *   - a page past the cap is refused; a page past the end of the document is
 *     UNAVAILABLE with its reason; a project that is not a PDF is refused;
 *   - stored preview bytes are in the derived-storage meter.
 */
import { createHash, randomUUID } from "node:crypto";

import { CreateBucketCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_NAMES, getWorkEntryOrThrow } from "@proovra/shared";
import { sumDerivedAssetStorageBytes } from "@proovra/shared-runtime";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = typeof import("../src/db.js")["prisma"];

const TAG = randomUUID().slice(0, 8);
const BUCKET = `wsrev-preview-${TAG}`;
const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RENDER_REDACTION_PAGE_PREVIEW);

/** A well-formed PDF of `fills.length` A4 pages, each painted in one colour. */
function pdfOf(fills: ReadonlyArray<readonly [number, number, number]>): Buffer {
  const objects: string[] = [];
  const kids = fills.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${fills.length} >>`);
  fills.forEach(([r, g, b], i) => {
    const stream = `${r} ${g} ${b} rg 0 0 595 842 re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("PRO-R3-04 redaction page preview (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let s3: S3Client;
  let processor: typeof import("../../worker/src/redaction/redaction-page-preview.processor.js");
  const PDF = pdfOf([
    [1, 0, 0],
    [0, 0, 1],
  ]);
  const created: string[] = [];

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    processor = await import("../../worker/src/redaction/redaction-page-preview.processor.js");
    ({ s3 } = await import("../../worker/src/storage.js"));
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    await upsertEntitlementGrant({
      prisma: prisma as never,
      teamId: A().teamId,
      key: "FEATURE_REDACTION",
      kind: "FEATURE",
      value: true,
      source: "CUSTOM",
      grantedByUserId: A().ownerUserId,
    } as never);
  }, 600_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  async function project(team: { teamId: string; ownerUserId: string }, artifactKind: "PDF" | "IMAGE" = "PDF") {
    const key = `wsrev/${TAG}/${randomUUID()}.pdf`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: PDF, ContentType: "application/pdf" }));
    const org = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `WS-REV preview ${TAG}`,
        type: "DOCUMENT",
        status: "SIGNED",
        mimeType: "application/pdf",
        teamId: team.teamId,
        organizationId: org.organizationId,
        ownerUserId: team.ownerUserId,
        storageBucket: BUCKET,
        storageKey: key,
        fileSha256: createHash("sha256").update(PDF).digest("hex"),
        sizeBytes: BigInt(PDF.length),
      } as never,
      select: { id: true },
    });
    created.push(evidence.id);
    const row = await prisma.redactionProject.create({
      data: { teamId: team.teamId, evidenceId: evidence.id, artifactKind, createdByUserId: team.ownerUserId } as never,
      select: { id: true },
    });
    return { projectId: row.id, evidenceId: evidence.id, originalKey: key };
  }

  const read = (token: string, teamId: string, projectId: string, page: number | string) =>
    h.app.inject({
      method: "GET",
      url: `/v1/redaction/projects/${projectId}/preview/pages/${page}`,
      headers: { authorization: `Bearer ${token}`, "x-proovra-workspace-id": teamId },
    });
  const rows = (projectId: string) =>
    prisma.redactionPagePreview.findMany({ where: { projectId }, orderBy: { pageIndex: "asc" } });
  const runJob = (previewId: string) =>
    processor.processRedactionPagePreviewJob({
      id: `rpp-${previewId}`,
      name: ENTRY.workName,
      attemptsMade: 0,
      data: { commandId: previewId, traceId: "wsrev", schemaVersion: ENTRY.schemaVersion },
    } as never);

  it("the owner gets PENDING, then READY with the rendered page once the job is processed", async () => {
    const p = await project(A());
    const meterBefore = await sumDerivedAssetStorageBytes(prisma as never, { teamId: A().teamId });

    const first = await read(A().ownerToken, A().teamId, p.projectId, 1);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ state: "PENDING" });
    expect(first.headers["cache-control"]).toBe("no-store");
    let stored = await rows(p.projectId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ teamId: A().teamId, evidenceId: p.evidenceId, pageIndex: 1, state: "QUEUED", storageKey: null });

    // Asking again while it is queued makes no second row and no second answer.
    const again = await read(A().ownerToken, A().teamId, p.projectId, 1);
    expect(again.json()).toEqual({ state: "PENDING" });
    expect(await rows(p.projectId)).toHaveLength(1);

    await runJob(stored[0]!.id);
    stored = await rows(p.projectId);
    expect(stored[0]).toMatchObject({ state: "READY", width: 1190, height: 1684, failureReason: null });
    expect(stored[0]!.storageKey).toMatch(new RegExp(`^redactions/${A().teamId}/previews/${p.projectId}/page-1-[0-9a-f]{16}\\.png$`));

    const ready = await read(A().ownerToken, A().teamId, p.projectId, 1);
    expect(ready.statusCode, ready.body).toBe(200);
    const body = ready.json() as { state: string; url: string; width: number; height: number; expiresAtUtc: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAtUtc", "height", "state", "url", "width"]);
    expect(body).toMatchObject({ state: "READY", width: 1190, height: 1684 });
    // The URL addresses the PREVIEW object, never the original.
    expect(body.url).toContain("/previews/");
    expect(body.url).not.toContain(p.originalKey);
    const bytes = Buffer.from(await (await fetch(body.url)).arrayBuffer());
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(bytes.length).toBe(Number(stored[0]!.byteSize));

    // The stored page is a derived object of the workspace, and it is metered.
    const meterAfter = await sumDerivedAssetStorageBytes(prisma as never, { teamId: A().teamId });
    expect(meterAfter - meterBefore).toBe(stored[0]!.byteSize);
  }, 180_000);

  it("a VIEWER is refused and queues nothing", async () => {
    const p = await project(A());
    const res = await read(A().viewerToken, A().teamId, p.projectId, 0);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain("url");
    expect(await rows(p.projectId)).toHaveLength(0);
    // …also for a page that is already READY for others.
    await read(A().ownerToken, A().teamId, p.projectId, 0);
    await runJob((await rows(p.projectId))[0]!.id);
    const ready = await read(A().viewerToken, A().teamId, p.projectId, 0);
    expect(ready.statusCode).toBe(403);
    expect(ready.body).not.toContain("previews");
  }, 180_000);

  it("another workspace is refused, in its own workspace and when it names this one, and queues nothing", async () => {
    const p = await project(A());
    await read(A().ownerToken, A().teamId, p.projectId, 0);
    await runJob((await rows(p.projectId))[0]!.id);

    const fromOwn = await read(B().ownerToken, B().teamId, p.projectId, 0);
    expect(fromOwn.statusCode, fromOwn.body).toBe(404);
    const naming = await read(B().ownerToken, A().teamId, p.projectId, 0);
    expect([403, 404]).toContain(naming.statusCode);
    for (const res of [fromOwn, naming]) expect(res.body).not.toContain("previews");
    // Nothing was queued on B's behalf, for the READY page or a new one.
    const other = await read(B().ownerToken, B().teamId, p.projectId, 1);
    expect(other.statusCode).toBe(404);
    expect(await prisma.redactionPagePreview.count({ where: { teamId: B().teamId } })).toBe(0);
    expect(await rows(p.projectId)).toHaveLength(1);
  }, 180_000);

  it("a workspace without the redaction entitlement cannot queue a render", async () => {
    const p = await project(B());
    const res = await read(B().ownerToken, B().teamId, p.projectId, 0);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED" });
    expect(await rows(p.projectId)).toHaveLength(0);
  }, 120_000);

  it("caveat 4: every look re-checks authority, the unredacted image is not cacheable, each link is a custody fact, and trash ends access", async () => {
    const p = await project(A());
    await read(A().ownerToken, A().teamId, p.projectId, 0);
    await runJob((await rows(p.projectId))[0]!.id);
    const viewed = async () =>
      (
        await prisma.custodyEvent.findMany({
          where: { evidenceId: p.evidenceId, eventType: "EVIDENCE_VIEWED" },
          select: { payload: true },
        })
      ).filter((e) => (e.payload as { channel?: string } | null)?.channel === "redaction_page_preview");

    // A MEMBER who authors regions sees the page; the link is recorded.
    const asMember = await read(A().memberToken, A().teamId, p.projectId, 0);
    expect(asMember.statusCode, asMember.body).toBe(200);
    const { url } = asMember.json() as { url: string };
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const events = await viewed();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      artifact: "derived",
      accessMode: "derived_view_url_issued",
      accessedByUserId: A().memberUserId,
      redactionProjectId: p.projectId,
      pageIndex: 0,
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain("previews/");

    // Demoted to VIEWER: the next look is refused and no link is issued.
    const membership = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: A().teamId, userId: A().memberUserId },
      select: { id: true, role: true },
    });
    await prisma.teamMember.update({ where: { id: membership.id }, data: { role: "VIEWER" } as never });
    try {
      const demoted = await read(A().memberToken, A().teamId, p.projectId, 0);
      expect(demoted.statusCode, demoted.body).toBe(403);
      expect(demoted.body).not.toContain("previews");
    } finally {
      await prisma.teamMember.update({ where: { id: membership.id }, data: { role: membership.role } as never });
    }

    // Trash ends ordinary access to the record and to its rendered pages.
    await prisma.evidence.update({ where: { id: p.evidenceId }, data: { lifecycleState: "TRASHED" } as never });
    const trashed = await read(A().ownerToken, A().teamId, p.projectId, 0);
    expect(trashed.statusCode, trashed.body).toBe(404);
    expect(trashed.json()).toEqual({ denial: "PROJECT_NOT_FOUND" });
    // …and a page not yet rendered is not queued for a trashed record.
    expect((await read(A().ownerToken, A().teamId, p.projectId, 1)).statusCode).toBe(404);
    expect(await rows(p.projectId)).toHaveLength(1);
    await prisma.evidence.update({ where: { id: p.evidenceId }, data: { lifecycleState: "ACTIVE" } as never });
    expect((await read(A().ownerToken, A().teamId, p.projectId, 0)).statusCode).toBe(200);
    expect(await viewed()).toHaveLength(2);
  }, 180_000);

  it("a page past the cap is refused; a page past the end is UNAVAILABLE; a non-PDF project is refused", async () => {
    const p = await project(A());
    for (const page of [200, 9999, "x", "-1"]) {
      const res = await read(A().ownerToken, A().teamId, p.projectId, page);
      expect(res.statusCode, `${page}: ${res.body}`).toBe(400);
    }
    expect(await rows(p.projectId)).toHaveLength(0);

    // The document has two pages: index 5 is queued, fails in the worker by name.
    expect((await read(A().ownerToken, A().teamId, p.projectId, 5)).json()).toEqual({ state: "PENDING" });
    await runJob((await rows(p.projectId))[0]!.id);
    const gone = await read(A().ownerToken, A().teamId, p.projectId, 5);
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ state: "UNAVAILABLE", reason: "page_out_of_range" });
    expect((await rows(p.projectId))[0]).toMatchObject({ state: "FAILED", storageKey: null });

    const image = await project(A(), "IMAGE");
    const refused = await read(A().ownerToken, A().teamId, image.projectId, 0);
    expect(refused.statusCode).toBe(409);
    expect(await rows(image.projectId)).toHaveLength(0);
  }, 180_000);
});
