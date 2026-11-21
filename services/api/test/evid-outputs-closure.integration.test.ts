/**
 * Closure evidence (WS-OUT rows) — behavioural proofs against a disposable
 * PostgreSQL, through the real services and routes:
 *
 *   PRO-BL2-07  custody records on an exchange package follow its state: a
 *               delivery, a download authorisation and a chain-transfer
 *               completion are refused for a package that is not READY /
 *               DELIVERED (and a transfer for a package that does not cover it)
 *   PRO-O1-04   a REPORT / PACKAGE verification link is neither revoked nor
 *               rotated through the reviewer-share controls; an owner share is
 *   PRO-O1C-03  an anonymous Public Verify original release stores a masked
 *               address / user-agent on the custody chain; an authenticated
 *               release keeps the actor's values
 *   PRO-O1Z-03  exchange sign-url never mints a link to an unserved host: with no
 *               operator host the stored ZIP is presigned; with no stored ZIP
 *               nothing is minted (DOWNLOAD_UNAVAILABLE)
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("closure evidence — WS-OUT rows (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let exchange: typeof import("../src/services/exchange/evidence-exchange.service.js");
  let transfers: typeof import("../src/services/exchange/chain-transfer.service.js");
  let gate: typeof import("../src/services/evidence/artifact-download-gate.service.js");
  let runtime: typeof import("@proovra/shared-runtime");
  let clearRates: () => Promise<unknown>;
  const keyId = `evidout-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    exchange = await import("../src/services/exchange/evidence-exchange.service.js");
    transfers = await import("../src/services/exchange/chain-transfer.service.js");
    gate = await import("../src/services/evidence/artifact-download-gate.service.js");
    runtime = await import("@proovra/shared-runtime");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 300_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function signedRecord(): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "evid closure record",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        signedAtUtc: new Date(),
      } as never,
      select: { id: true },
    });
    const fileSha256 = sha(randomUUID());
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = sha(canonical);
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonical,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId,
        signingKeyVersion: 1,
        verificationRef: runtime.generateVerificationRef(),
        verificationRefIssuedAtUtc: new Date(),
      } as never,
    });
    return row.id;
  }

  async function pkg(state: string, evidenceIds: string[], extra: Record<string, unknown> = {}) {
    return prisma.evidenceExchangePackage.create({
      data: {
        teamId: A().teamId,
        kind: "EXCHANGE",
        state,
        evidenceIds,
        createdByUserId: A().ownerUserId,
        ...extra,
      } as never,
      select: { id: true },
    });
  }

  // ===========================================================================
  // PRO-BL2-07
  // ===========================================================================
  describe("PRO-BL2-07: custody records follow the package state", () => {
    it("refused: no delivery is recorded for a REVOKED, EXPIRED, DRAFT or BUILDING package", async () => {
      for (const state of ["REVOKED", "EXPIRED", "DRAFT", "BUILDING"]) {
        const p = await pkg(state, [randomUUID()]);
        const r = await exchange.recordPackageDelivery({ teamId: A().teamId, packageId: p.id, channel: "SIGNED_URL" });
        expect(r, state).toEqual({ ok: false, denial: "PACKAGE_NOT_READY" });
        expect(await prisma.evidenceExchangePackageDelivery.count({ where: { packageId: p.id } }), state).toBe(0);
      }
    });

    it("allowed: a READY package records its delivery and becomes DELIVERED", async () => {
      const p = await pkg("READY", [randomUUID()]);
      const r = await exchange.recordPackageDelivery({ teamId: A().teamId, packageId: p.id, channel: "SIGNED_URL" });
      expect(r.ok).toBe(true);
      expect((await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: p.id } })).state).toBe("DELIVERED");
    });

    it("refused: a download is not authorised once the package was revoked after delivery; authorised while it is releasable", async () => {
      const id = await signedRecord();
      const p = await pkg("READY", [id]);
      const delivered = await exchange.recordPackageDelivery({ teamId: A().teamId, packageId: p.id, channel: "SIGNED_URL" });
      expect(delivered.ok).toBe(true);
      const allowed = await exchange.recordPackageDownload({ teamId: A().teamId, deliveryId: delivered.deliveryId! });
      expect(allowed.ok).toBe(true);

      const p2 = await pkg("READY", [id]);
      const d2 = await exchange.recordPackageDelivery({ teamId: A().teamId, packageId: p2.id, channel: "SIGNED_URL" });
      await prisma.evidenceExchangePackage.update({ where: { id: p2.id }, data: { state: "REVOKED", revokedAtUtc: new Date() } });
      const refused = await exchange.recordPackageDownload({ teamId: A().teamId, deliveryId: d2.deliveryId! });
      expect(refused).toEqual({ ok: false, denial: "PACKAGE_NOT_READY" });
      expect(
        (await prisma.evidenceExchangePackageDelivery.findUniqueOrThrow({ where: { id: d2.deliveryId! } })).downloadAuthorizedAtUtc,
      ).toBeNull();
    });

    it("chain transfer: refused with a BUILDING package or one that does not carry every moved record; completed with a READY package that does", async () => {
      const moved = await signedRecord();
      const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } })).organizationId!;
      const transfer = await prisma.chainTransfer.create({
        data: {
          teamId: A().teamId,
          fromOrganizationId: orgId,
          toOrganizationSlug: "recipient",
          evidenceIds: [moved],
          state: "ACCEPTED",
          initiatedByUserId: A().ownerUserId,
        },
      });
      const building = await pkg("BUILDING", [moved]);
      const other = await pkg("READY", [await signedRecord()]);
      const good = await pkg("READY", [moved]);
      const complete = (packageId: string) =>
        transfers.completeChainTransfer({ teamId: A().teamId, transferId: transfer.id, packageId, actorUserId: A().ownerUserId } as never);

      expect(await complete(building.id)).toEqual({ ok: false, denial: "PACKAGE_NOT_READY" });
      expect(await complete(other.id)).toEqual({ ok: false, denial: "PACKAGE_NOT_READY" });
      expect(await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).toMatchObject({ state: "ACCEPTED", packageId: null });
      const done = await complete(good.id);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).toMatchObject({ state: "COMPLETED", packageId: good.id });
    });
  });

  // ===========================================================================
  // PRO-O1-04
  // ===========================================================================
  describe("PRO-O1-04: artifact verification links are not managed through reviewer-share controls", () => {
    const api = (url: string) =>
      h.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${A().ownerToken}` } });
    const verify = (token: string) =>
      h.app.inject({ method: "GET", url: `/public/verify/${token}`, remoteAddress: `198.18.2.${1 + Math.floor(Math.random() * 250)}` });

    for (const purpose of ["REPORT", "PACKAGE"] as const) {
      it(`refused: a ${purpose} link answers 404 to revoke and rotate, and the printed link keeps working`, async () => {
        const id = await signedRecord();
        const minted = await prisma.$transaction((tx) =>
          runtime.mintVerificationShareTokenTx(tx as never, {
            evidenceId: id,
            teamId: A().teamId,
            purpose,
            ...(purpose === "REPORT" ? { reportVersion: 1 } : {}),
            audience: `${purpose} version 1`,
          } as never),
        );
        const linkId = (await prisma.verificationShareToken.findFirstOrThrow({ where: { evidenceId: id, purpose } })).id;

        const revoked = await api(`/v1/evidence/${id}/verify-links/${linkId}/revoke`);
        expect(revoked.statusCode, revoked.body).toBe(404);
        expect(revoked.json().code).toBe("VERIFICATION_LINK_NOT_FOUND");
        const rotated = await api(`/v1/evidence/${id}/verify-links/${linkId}/rotate`);
        expect(rotated.statusCode, rotated.body).toBe(404);

        const row = await prisma.verificationShareToken.findUniqueOrThrow({ where: { id: linkId } });
        expect(row.revokedAtUtc).toBeNull();
        expect(await prisma.verificationShareToken.count({ where: { evidenceId: id } })).toBe(1);
        expect((await verify(minted.token)).statusCode).toBe(200);
      });
    }

    it("allowed: an owner share is revoked through the same control", async () => {
      const id = await signedRecord();
      const created = await h.app.inject({
        method: "POST",
        url: `/v1/evidence/${id}/verify-links`,
        headers: { authorization: `Bearer ${A().ownerToken}`, "content-type": "application/json" },
        payload: { audience: "Opposing counsel", expiresInDays: 30 },
      });
      expect(created.statusCode, created.body).toBe(201);
      const linkId = created.json().link.id as string;
      const revoked = await api(`/v1/evidence/${id}/verify-links/${linkId}/revoke`);
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json()).toMatchObject({ changed: true, link: { state: "REVOKED" } });
    });
  });

  // ===========================================================================
  // PRO-O1C-03
  // ===========================================================================
  describe("PRO-O1C-03: an anonymous viewer's address is not stored raw on the custody chain", () => {
    const RAW_IP = "203.0.113.77";
    const RAW_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36 evid-fingerprint-xyz";
    const lastRow = (evidenceId: string) =>
      prisma.custodyEvent.findFirstOrThrow({
        where: { evidenceId },
        orderBy: { sequence: "desc" },
        select: { eventType: true, ip: true, userAgent: true },
      });

    it("refused: a public_verify release stores neither the raw IP nor the raw user-agent", async () => {
      const id = await signedRecord();
      await gate.recordOriginalRelease({
        evidenceId: id,
        actorUserId: null,
        channel: "public_verify",
        originalUrlsIssued: 1,
        ip: RAW_IP,
        userAgent: RAW_UA,
        coalesceKey: randomUUID(),
      });
      const row = await lastRow(id);
      expect(String(row.eventType)).toBe("VERIFY_VIEWED");
      expect(row.ip).not.toBe(RAW_IP);
      expect(row.ip ?? "").not.toContain("203.0.113.77");
      expect(row.userAgent ?? "").not.toContain("evid-fingerprint-xyz");
      expect(row.userAgent).not.toBe(RAW_UA);
    });

    it("control: an authenticated download keeps the actor's address and user-agent", async () => {
      const id = await signedRecord();
      await gate.recordOriginalRelease({
        evidenceId: id,
        actorUserId: A().ownerUserId,
        channel: "original",
        originalUrlsIssued: 1,
        ip: RAW_IP,
        userAgent: RAW_UA,
      });
      const row = await lastRow(id);
      expect(String(row.eventType)).toBe("DOWNLOAD_AUTHORIZED");
      expect(row.ip).toBe(RAW_IP);
      expect(row.userAgent).toBe(RAW_UA);
    });
  });

  // ===========================================================================
  // PRO-O1Z-03
  // ===========================================================================
  describe("PRO-O1Z-03: exchange sign-url mints only a link that resolves", () => {
    it("refused: with no operator host and no stored ZIP nothing is minted (DOWNLOAD_UNAVAILABLE)", async () => {
      const previous = process.env.EXCHANGE_DOWNLOAD_BASE_URL;
      delete process.env.EXCHANGE_DOWNLOAD_BASE_URL;
      try {
        const id = await signedRecord();
        const p = await pkg("READY", [id], { packageSha256: "d".repeat(64) });
        const r = await exchange.generateSignedUrl({ teamId: A().teamId, packageId: p.id, ttlSeconds: 3600, actorUserId: A().ownerUserId });
        expect(r).toEqual({ ok: false, denial: "DOWNLOAD_UNAVAILABLE" });
        expect((await prisma.evidenceExchangePackage.findUniqueOrThrow({ where: { id: p.id } })).signedUrl).toBeNull();
      } finally {
        if (previous !== undefined) process.env.EXCHANGE_DOWNLOAD_BASE_URL = previous;
      }
    });

    it("allowed: with no operator host the stored ZIP itself is presigned, never a download.proovra.local link", async () => {
      const previous = process.env.EXCHANGE_DOWNLOAD_BASE_URL;
      delete process.env.EXCHANGE_DOWNLOAD_BASE_URL;
      try {
        const id = await signedRecord();
        const storageKey = `exchange/${A().teamId}/${randomUUID()}.zip`;
        const p = await pkg("READY", [id], { packageSha256: "e".repeat(64), storageKey });
        const r = await exchange.generateSignedUrl({ teamId: A().teamId, packageId: p.id, ttlSeconds: 3600, actorUserId: A().ownerUserId });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const url = new URL((r as { signedUrl: string }).signedUrl);
        expect(url.hostname).not.toBe("download.proovra.local");
        expect(decodeURIComponent(url.pathname)).toContain(storageKey);
        expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
      } finally {
        if (previous !== undefined) process.env.EXCHANGE_DOWNLOAD_BASE_URL = previous;
      }
    });

    it("control: an operator-configured host keeps the signed-token contract", async () => {
      const previous = process.env.EXCHANGE_DOWNLOAD_BASE_URL;
      process.env.EXCHANGE_DOWNLOAD_BASE_URL = "https://downloads.operator.example/exchange/";
      try {
        const id = await signedRecord();
        const p = await pkg("READY", [id], { packageSha256: "f".repeat(64) });
        const r = await exchange.generateSignedUrl({ teamId: A().teamId, packageId: p.id, ttlSeconds: 3600, actorUserId: A().ownerUserId });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const url = new URL((r as { signedUrl: string }).signedUrl);
        expect(url.hostname).toBe("downloads.operator.example");
        expect(url.pathname).toBe(`/exchange/${p.id}`);
        expect(url.searchParams.get("token")).toBeTruthy();
      } finally {
        if (previous === undefined) delete process.env.EXCHANGE_DOWNLOAD_BASE_URL;
        else process.env.EXCHANGE_DOWNLOAD_BASE_URL = previous;
      }
    });
  });
});
