/**
 * FINAL-VERIFY-7 / LEGACY-A..D — the read-only legacy-bucket inventory and the
 * R2 candidate-object locator, on live PostgreSQL 16 and local MinIO (standing
 * in for Cloudflare R2: same S3 API, path-style).
 *
 * Proves:
 *   - records referencing the bucket are classified A (soft-deleted) / B (live,
 *     team-bound) / C (live, team-less), sealed vs unsealed, with their parts,
 *     reports and legal holds; the capture reaper's retried set is exactly the
 *     unsealed, soft-deleted, lifecycle-ACTIVE, unstamped rows; other buckets
 *     are not listed;
 *   - the locator HEADs the exact stored key, compares size, streams SHA-256
 *     against the recorded hash and reports MATCH / SHA mismatch / size
 *     mismatch / not found / no recorded hash — and writes nothing;
 *   - the credentials never appear in the output; write-like flags, a
 *     non-https remote endpoint and missing credentials are refused.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runLegacyBucketInventoryCli } from "../src/scripts/legacy-bucket-inventory.js";
import { resolveLegacyEndpoint, runLegacyBucketObjectLocatorCli } from "../src/scripts/legacy-bucket-object-locator.js";
import type { IntegrationHarness } from "./integration-harness.js";

describe("legacy bucket inventory + R2 object locator (live PostgreSQL 16, local S3)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const tag = randomUUID().slice(0, 8);
  const bucket = `legacy-loc-${tag}`;
  const ids = { reaper: "", deletedReported: "", liveTeam: "", liveTeamless: "", other: "", part0: "", part1: "", report: "", multipart: "" };
  const original = randomBytes(4_000);
  const partGood = randomBytes(3_000);
  const partWrong = randomBytes(2_000);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  let s3: S3Client;
  const creds = () => ({ key: process.env.S3_ACCESS_KEY!, secret: process.env.S3_SECRET_KEY! });

  async function evidence(over: Record<string, unknown>): Promise<string> {
    const A = harness.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: `legacy ${tag}`,
        type: "PHOTO",
        status: "REPORTED" as never,
        lifecycleState: "ACTIVE" as never,
        teamId: A.teamId,
        organizationId: team.organizationId,
        ownerUserId: A.ownerUserId,
        sizeBytes: 4_000n,
        storageBucket: bucket,
        createdAt: new Date("2026-03-01T00:00:00Z"),
        ...over,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function inventory(argv: string[]) {
    let out = "";
    let err = "";
    const code = await runLegacyBucketInventoryCli({ argv, client: prisma, out: (s) => (out += s), err: (s) => (err += s) });
    return { code, err, json: code === 0 ? JSON.parse(out) : null, out };
  }
  async function locate(argv: string[], env: Record<string, string | undefined>) {
    let out = "";
    let err = "";
    const code = await runLegacyBucketObjectLocatorCli({ argv, env, client: prisma, out: (s) => (out += s), err: (s) => (err += s) });
    return { code, err, out, json: code === 0 ? JSON.parse(out) : null };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: creds().key, secretAccessKey: creds().secret },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const del = new Date("2026-03-05T00:00:00Z");
    ids.reaper = await evidence({ status: "UPLOADING", deletedAt: del, storageKey: `evidence/r-${tag}/original` });
    ids.deletedReported = await evidence({ status: "REPORTED", deletedAt: del, storageKey: `evidence/d-${tag}/original` });
    ids.liveTeam = await evidence({ status: "REPORTED", storageKey: `evidence/l-${tag}/original`, fileSha256: sha(original), hashSemantics: "single_file", sizeBytes: BigInt(original.length) });
    ids.liveTeamless = await evidence({ status: "SIGNED", teamId: null, organizationId: null, storageKey: `evidence/t-${tag}/original`, fileSha256: "0".repeat(64), sizeBytes: 10n });
    ids.multipart = await evidence({ status: "SIGNED", storageKey: null, hashSemantics: "multipart_composite", fileSha256: "1".repeat(64) });
    ids.other = await evidence({ storageBucket: "proovra-evidence-prod-eu", storageKey: `evidence/o-${tag}/original` });

    ids.part0 = (await prisma.evidencePart.create({
      data: { evidenceId: ids.multipart, partIndex: 0, storageBucket: bucket, storageKey: `evidence/m-${tag}/parts/0`, sizeBytes: BigInt(partGood.length), sha256: sha(partGood) },
      select: { id: true },
    })).id;
    ids.part1 = (await prisma.evidencePart.create({
      data: { evidenceId: ids.multipart, partIndex: 1, storageBucket: bucket, storageKey: `evidence/m-${tag}/parts/1`, sizeBytes: BigInt(partWrong.length), sha256: sha(randomBytes(2_000)) },
      select: { id: true },
    })).id;
    ids.report = (await prisma.report.create({
      data: { evidenceId: ids.liveTeam, version: 1, storageBucket: bucket, storageKey: `reports/l-${tag}/v1.pdf`, generatedAtUtc: new Date("2026-03-02T00:00:00Z"), sizeBytes: 999n, pdfSha256: "2".repeat(64) } as never,
      select: { id: true },
    })).id;
    await prisma.evidenceLegalHold.create({
      data: { teamId: harness.fixtures.teamA.teamId, evidenceId: ids.liveTeam, title: "hold", placedByUserId: harness.fixtures.teamA.ownerUserId } as never,
    });

    // The objects in the "legacy" store: one exact original, one exact part,
    // one part with the right size but other bytes; the report is missing;
    // the team-less original has a different size.
    const put = (Key: string, Body: Buffer) => s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body }));
    await put(`evidence/l-${tag}/original`, original);
    await put(`evidence/m-${tag}/parts/0`, partGood);
    await put(`evidence/m-${tag}/parts/1`, partWrong);
    await put(`evidence/t-${tag}/original`, randomBytes(11));
    await put(`evidence/r-${tag}/original`, randomBytes(4_000));
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("classifies every record referencing the bucket and names the capture reaper's retried set", async () => {
    const r = await inventory([`--bucket=${bucket}`, "--objects"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json.readOnly).toBe(true);
    const byId = Object.fromEntries(r.json.records.map((x: { evidenceId: string }) => [x.evidenceId, x]));
    expect(Object.keys(byId).sort()).toEqual([ids.reaper, ids.deletedReported, ids.liveTeam, ids.liveTeamless, ids.multipart].sort());
    expect(byId[ids.other]).toBeUndefined();
    expect(byId[ids.reaper]).toMatchObject({ class: "A_SOFT_DELETED", sealed: false, captureReaperRetries: true });
    expect(byId[ids.deletedReported]).toMatchObject({ class: "A_SOFT_DELETED", sealed: true, captureReaperRetries: false });
    expect(byId[ids.liveTeam]).toMatchObject({ class: "B_LIVE_TEAM", sealed: true, reportsInLegacyBucket: 1, activeLegalHolds: 1 });
    expect(byId[ids.liveTeamless]).toMatchObject({ class: "C_LIVE_TEAMLESS", teamId: null });
    expect(byId[ids.multipart]).toMatchObject({ class: "B_LIVE_TEAM", ownObjectInLegacyBucket: false, partsInLegacyBucket: 2 });
    expect(r.json.summary.captureReaperRetriesIds).toEqual([ids.reaper]);
    expect(r.json.summary.byClass).toEqual({ A_SOFT_DELETED: 2, B_LIVE_TEAM: 2, C_LIVE_TEAMLESS: 1 });
    expect(r.json.expectedObjectsByTable).toEqual({ evidence: 4, evidence_parts: 2, reports: 1 });
    expect(r.out).not.toContain(`legacy ${tag}`); // no titles
    const s = await inventory([`--bucket=${bucket}`, "--summary"]);
    expect(s.json.records).toBeUndefined();
    expect((await inventory(["--repoint"])).code).toBe(2);
    expect((await inventory(["--whatever"])).code).toBe(2);
  });

  it("the locator HEADs each exact key, compares size and SHA-256, and prints no credential", async () => {
    const before = await prisma.evidence.findMany({ where: { storageBucket: bucket }, orderBy: { id: "asc" } });
    const env = { LEGACY_S3_ENDPOINT: process.env.S3_ENDPOINT, LEGACY_R2_ACCESS_KEY_ID: creds().key, LEGACY_R2_SECRET_ACCESS_KEY: creds().secret };
    const r = await locate([`--bucket=${bucket}`], env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain(creds().secret);
    expect(r.out).not.toContain(creds().key);
    const byRow = Object.fromEntries(r.json.rows.map((x: { rowId: string; outcome: string }) => [x.rowId, x.outcome]));
    expect(byRow[ids.liveTeam]).toBe("MATCH_SHA256");
    expect(byRow[ids.part0]).toBe("MATCH_SHA256");
    expect(byRow[ids.part1]).toBe("SIZE_MATCH_SHA256_MISMATCH");
    expect(byRow[ids.report]).toBe("NOT_FOUND");
    expect(byRow[ids.liveTeamless]).toBe("SIZE_MISMATCH");
    expect(byRow[ids.reaper]).toBe("SIZE_MATCH_NO_DB_SHA256");
    expect(byRow[ids.deletedReported]).toBe("NOT_FOUND");
    // --no-hash stops at size.
    const n = await locate([`--bucket=${bucket}`, "--no-hash"], env);
    expect(Object.fromEntries(n.json.rows.map((x: { rowId: string; outcome: string }) => [x.rowId, x.outcome]))[ids.liveTeam]).toBe("SIZE_MATCH_HASH_SKIPPED");
    // Nothing was written.
    expect(await prisma.evidence.findMany({ where: { storageBucket: bucket }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("refuses write-like flags, a plain-http remote endpoint and missing credentials", async () => {
    const env = { LEGACY_S3_ENDPOINT: process.env.S3_ENDPOINT, LEGACY_R2_ACCESS_KEY_ID: "k", LEGACY_R2_SECRET_ACCESS_KEY: "s" };
    expect((await locate(["--copy"], env)).code).toBe(2);
    expect((await locate(["--repoint"], env)).code).toBe(2);
    const noCreds = await locate([], { LEGACY_R2_ACCOUNT_ID: "e".repeat(32) });
    expect(noCreds.code).toBe(2);
    expect(noCreds.err).toContain("LEGACY_R2_ACCESS_KEY_ID");
    expect(() => resolveLegacyEndpoint({ LEGACY_S3_ENDPOINT: "http://storage.example.com" })).toThrow(/https/);
    expect(() => resolveLegacyEndpoint({ LEGACY_R2_ACCOUNT_ID: "nope" })).toThrow(/account id/);
    expect(resolveLegacyEndpoint({ LEGACY_R2_ACCOUNT_ID: "e88f77cf7e249641cf34b548e99e3fbc" })).toBe("https://e88f77cf7e249641cf34b548e99e3fbc.r2.cloudflarestorage.com");
  });
});
