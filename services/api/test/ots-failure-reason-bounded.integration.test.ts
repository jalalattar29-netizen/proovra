/**
 * ET-OTS-04 — a stored OTS failure reason never reaches a reader as text.
 * Live PostgreSQL 16, the real public Verify route.
 *
 * On a40ca76f a stamp-call failure was persisted as the raw command output
 * ("Command failed: ots stamp -c <calendar> /tmp/ots-…/fingerprint-<id>.json …")
 * and served verbatim on public Verify, the custody timeline, the inbox and the
 * report. Rows written before the worker fix keep that text, so every reader
 * projects through boundedOtsFailureCode.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { boundedOtsFailureCode } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";

const RAW = "Command failed: ots stamp -c https://a.pool.opentimestamps.org /tmp/ots-Xy12/fingerprint-secret.json\nTimed out";

describe("OTS failure reason is bounded on every reader (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const keyId = `ots04-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("the projection maps codes through and anything else to OTS_PROCESSING_FAILED", () => {
    expect(boundedOtsFailureCode(RAW)).toBe("OTS_PROCESSING_FAILED");
    expect(boundedOtsFailureCode("MALFORMED_PROOF")).toBe("MALFORMED_PROOF");
    expect(boundedOtsFailureCode("OTS_GLOBAL_BUDGET_EXHAUSTED")).toBe("OTS_GLOBAL_BUDGET_EXHAUSTED");
    expect(boundedOtsFailureCode(null)).toBeNull();
  });

  it("public Verify of a record carrying a raw historical reason returns the bounded code only", async () => {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: { title: "OTS-04 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        signedAtUtc: new Date(),
        otsStatus: "FAILED",
        otsFailureReason: RAW,
      } as never,
    });
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, row.id)}`, remoteAddress: "81.2.69.170" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("Command failed");
    expect(res.body).not.toContain("/tmp/ots-");
    expect(res.body).not.toContain("fingerprint-secret");
    // Wherever the payload carries the field, it carries a bounded code.
    const seen: unknown[] = [];
    JSON.parse(res.body, (k, v) => {
      if (k === "otsFailureReason") seen.push(v);
      return v;
    });
    for (const v of seen) expect([null, "OTS_PROCESSING_FAILED"]).toContain(v);
  });

  it("the member review workspace carries the bounded code, not the stored command text", async () => {
    const { teamId, ownerToken } = h.fixtures.teamA;
    const id = (await prisma.evidence.findFirstOrThrow({ where: { teamId, title: "OTS-04 fixture" }, select: { id: true } })).id;
    const res = await h.app.inject({ method: "GET", url: `/v1/evidence/${id}/review-workspace`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("Command failed");
    expect(res.body).not.toContain("fingerprint-secret");
    const seen: unknown[] = [];
    JSON.parse(res.body, (k, v) => {
      if (k === "otsFailureReason") seen.push(v);
      return v;
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const v of seen) expect(v).toBe("OTS_PROCESSING_FAILED");
  });

  it("no API reader returns otsFailureReason unprojected", () => {
    for (const rel of ["../src/routes/evidence.routes.ts", "../src/routes/me-inbox.routes.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src, rel).not.toMatch(/(otsFailureReason|failureReason):\s*(e|evidence|ev)\.otsFailureReason( \?\? null)?,/);
      expect(src, rel).not.toMatch(/Unrecoverable failure recorded: \$\{safe\}/);
    }
  });
});
