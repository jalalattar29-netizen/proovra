/**
 * ET-PKG-09 — anonymous public Verify views keep no personal data, and the
 * VERIFY_VIEWED custody debounce is atomic. Live PostgreSQL 16, the real route.
 *
 * On a40ca76f every view stored the viewer's full IP and user agent (no
 * retention, no reader), and the debounce decided from the value read at the
 * top of the handler, so concurrent first views each appended VERIFY_VIEWED.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";

describe("public Verify view privacy + atomic debounce (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const keyId = `pkg09-${randomUUID().slice(0, 8)}`;
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

  async function signedRecord() {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: { title: "PKG-09 fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
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
      } as never,
    });
    return row.id;
  }

  it("concurrent first views append ONE VERIFY_VIEWED; each view row holds only the masked network, no user agent", async () => {
    const id = await signedRecord();
    const ips = ["81.2.69.160", "81.2.69.161", "81.2.69.162", "81.2.69.163", "81.2.69.164"];
    const responses = await Promise.all(
      ips.map(async (ip) =>
        h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}`, remoteAddress: ip, headers: { "user-agent": "Mozilla/5.0 (fingerprint-me)" } }),
      ),
    );
    for (const r of responses) expect(r.statusCode, r.body).toBe(200);

    await expect.poll(() => prisma.verificationView.count({ where: { evidenceId: id } }), { timeout: 10_000 }).toBe(5);
    await expect.poll(() => prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "VERIFY_VIEWED" } }), { timeout: 10_000 }).toBe(1);
    // Settle: the fire-and-forget writers are done; no late second append.
    await new Promise((r) => setTimeout(r, 750));
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "VERIFY_VIEWED" } })).toBe(1);

    const rows = await prisma.verificationView.findMany({ where: { evidenceId: id }, select: { ipAddress: true, userAgent: true } });
    for (const row of rows) expect(row).toEqual({ ipAddress: "81.2.x.x", userAgent: null });
  });

  it("the backfill anonymizes historical rows (IPv4, mapped IPv4, IPv6, junk) and is idempotent", async () => {
    const id = await signedRecord();
    const raw = [
      ["203.0.113.9", "UA-1"],
      ["::ffff:81.2.69.160", "UA-2"],
      ["2001:db8:85a3::8a2e:370:7334", "UA-3"],
      ["::1", "UA-4"],
      ["not-an-ip", null],
    ] as const;
    for (const [ip, ua] of raw) {
      await prisma.verificationView.create({
        data: { evidenceId: id, viewerType: "PUBLIC", accessMode: "public_verify", ipAddress: ip, userAgent: ua } as never,
      });
    }
    const sql = readFileSync(new URL("../prisma/migrations/20280811000000_verification_views_anonymize/migration.sql", import.meta.url), "utf8");
    const statements = sql
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBe(2);
    const run = async () => {
      for (const s of statements) await prisma.$executeRawUnsafe(s);
    };
    await run();
    const after = async () =>
      (await prisma.verificationView.findMany({ where: { evidenceId: id }, select: { ipAddress: true, userAgent: true } }))
        .map((r) => `${r.ipAddress}|${r.userAgent}`)
        .sort();
    const once = await after();
    expect(once).toEqual(["2001:db8:…|null", "203.0.x.x|null", "81.2.x.x|null", "null|null", "null|null"].sort());
    await run();
    expect(await after()).toEqual(once);
  });
});
