/**
 * D62 — POST /v1/intelligence/evidence/:evidenceId/run/bytes analysed whatever
 * the caller sent, against a disposable PostgreSQL + Redis through the REAL
 * route.
 *
 * The route ran a provider on caller-supplied `bytesBase64` (or an arbitrary
 * `url`) and recorded the results AGAINST THE EVIDENCE without proving the
 * bytes were the stored evidence — a provenance break: anyone holding
 * `intelligence.run` could attach analysis of any file to any record. The
 * bytes must now hash to a sha256 the platform recorded for that evidence
 * (the original file, or one of its parts); otherwise the route answers a
 * bounded 409 and nothing reaches a provider. A URL is never forwarded.
 *
 * No provider is contacted: the provider registry is given a recording
 * adapter, so "reached the provider" is an observable fact.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const PROVIDER = "AZURE_DOCUMENT_INTELLIGENCE";
const GOOD = Buffer.from("the stored evidence bytes — D62");
const PART = Buffer.from("the second part of a multipart record — D62");
const FORGED = Buffer.from("some other file entirely");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("D62 intelligence run/bytes provenance (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const adapterCalls: Array<{ bytes: Uint8Array | null | undefined; url: string | null | undefined }> = [];

  let singleFile: string;
  let multipart: string;
  let unhashed: string;
  let foreign: string;

  const run = (evidenceId: string, body: Record<string, unknown>, token = h.fixtures.teamA.ownerToken) =>
    h.app.inject({
      method: "POST",
      url: `/v1/intelligence/evidence/${evidenceId}/run/bytes`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { provider: PROVIDER, operation: "OCR_IMAGE", contentType: "image/png", ...body },
    });
  const b64 = (b: Buffer) => b.toString("base64");

  async function makeEvidence(teamId: string, ownerUserId: string, data: Record<string, unknown>) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: {
          title: `d62-${randomUUID()}`,
          type: "PHOTO",
          status: "REPORTED" as never,
          lifecycleState: "ACTIVE" as never,
          teamId,
          organizationId: team.organizationId,
          ownerUserId,
          ...data,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    const { teamA, teamB } = h.fixtures;
    await prisma.user.update({ where: { id: teamA.ownerUserId }, data: { currentWorkspaceId: teamA.teamId } });
    await prisma.user.update({ where: { id: teamB.ownerUserId }, data: { currentWorkspaceId: teamB.teamId } });
    await prisma.workspaceAiPolicy.upsert({
      where: { teamId: teamA.teamId },
      create: {
        teamId: teamA.teamId,
        aiEnabled: true,
        contentIntelligenceEnabled: true,
        rawContentProcessingAllowed: true,
        ocrAllowed: true,
      },
      update: { aiEnabled: true, contentIntelligenceEnabled: true, rawContentProcessingAllowed: true, ocrAllowed: true },
    });

    // The recording adapter replaces the real one in the SAME registry the
    // route's orchestrator reads.
    const { registerAdapter } = await import("../src/services/intelligence/providers/provider-adapter.js");
    const usage = { provider: PROVIDER, operation: "OCR_IMAGE", unit: "PAGE", units: 1, estimatedCostUsdMicros: 0 };
    registerAdapter({
      provider: PROVIDER,
      supportedOperations: ["OCR_IMAGE", "OCR_DOCUMENT"],
      probe: () => ({ provider: PROVIDER, state: "BOUND" }),
      ocrImage: async (src: { bytes?: Uint8Array | null; url?: string | null }) => {
        adapterCalls.push({ bytes: src.bytes, url: src.url });
        return { ok: true, records: [], entities: [], usage, extractedText: null };
      },
    } as never);

    singleFile = await makeEvidence(teamA.teamId, teamA.ownerUserId, {
      fileSha256: sha(GOOD),
      hashSemantics: "single_file",
    });
    multipart = await makeEvidence(teamA.teamId, teamA.ownerUserId, {
      fileSha256: sha(Buffer.from("composite, not the hash of any bytes")),
      hashSemantics: "multipart_composite",
    });
    await prisma.evidencePart.create({
      data: { evidenceId: multipart, partIndex: 0, sha256: sha(PART), storageBucket: "d62-test", storageKey: `d62/${multipart}/0`, mimeType: "image/png" } as never,
    });
    unhashed = await makeEvidence(teamA.teamId, teamA.ownerUserId, {});
    foreign = await makeEvidence(teamB.teamId, teamB.ownerUserId, {
      fileSha256: sha(GOOD),
      hashSemantics: "single_file",
    });
  });

  afterAll(async () => {
    if (prisma) {
      const ids = [singleFile, multipart, unhashed, foreign].filter(Boolean);
      await prisma.mediaIntelligenceRecord.deleteMany({ where: { evidenceId: { in: ids } } }).catch(() => undefined);
      await prisma.evidencePart.deleteMany({ where: { evidenceId: { in: ids } } }).catch(() => undefined);
      await prisma.evidence.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  beforeEach(() => {
    adapterCalls.length = 0;
  });

  it("refuses bytes that are not the stored evidence, and analyses nothing", async () => {
    const res = await run(singleFile, { bytesBase64: b64(FORGED) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("EVIDENCE_BYTES_MISMATCH");
    expect(adapterCalls).toHaveLength(0);
  });

  it("refuses a URL, which it cannot prove, and never forwards it", async () => {
    const res = await run(singleFile, { url: "https://attacker.example/forged.png" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("EVIDENCE_BYTES_UNVERIFIED");
    expect(adapterCalls).toHaveLength(0);
  });

  it("refuses when the platform holds no hash to check the bytes against", async () => {
    const res = await run(unhashed, { bytesBase64: b64(GOOD) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("EVIDENCE_BYTES_UNVERIFIED");
    expect(adapterCalls).toHaveLength(0);
  });

  it("never treats a multipart composite as the hash of the bytes", async () => {
    const res = await run(multipart, { bytesBase64: b64(Buffer.from("composite, not the hash of any bytes")) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("EVIDENCE_BYTES_MISMATCH");
    expect(adapterCalls).toHaveLength(0);
  });

  it("analyses the stored evidence bytes, and only those, with no URL", async () => {
    const res = await run(singleFile, { bytesBase64: b64(GOOD), url: "https://attacker.example/forged.png" });
    expect(res.statusCode, res.body).toBe(200);
    expect(adapterCalls).toHaveLength(1);
    expect(Buffer.from(adapterCalls[0].bytes as Uint8Array).equals(GOOD)).toBe(true);
    expect(adapterCalls[0].url).toBeNull();
  });

  it("analyses a part of a multipart record by that part's hash", async () => {
    const res = await run(multipart, { bytesBase64: b64(PART) });
    expect(res.statusCode, res.body).toBe(200);
    expect(adapterCalls).toHaveLength(1);
  });

  it("answers another workspace's evidence exactly like a missing one", async () => {
    const other = await run(foreign, { bytesBase64: b64(GOOD) });
    const missing = await run(randomUUID(), { bytesBase64: b64(GOOD) });
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
    expect(adapterCalls).toHaveLength(0);
  });
});
