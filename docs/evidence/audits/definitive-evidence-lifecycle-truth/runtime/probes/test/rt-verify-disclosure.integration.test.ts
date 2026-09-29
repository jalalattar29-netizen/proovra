/**
 * RUNTIME PROBE RT-VERIFY — audit-only. Live disposable PostgreSQL 16 (loopback),
 * real Fastify inject, the product's own integration harness and outbound guard.
 *
 * CUSTODY-01: the unauthenticated public Verify answer prints raw payload
 * fields for custody event types it has no summary for. We place and release a
 * REAL evidence legal hold through the production service (title + INTERNAL
 * release note), then read /public/verify/:id with no credentials.
 *
 * VERIFY-STATES: for the same kind of signed record, TSA FAILED and OTS PENDING
 * must never be rendered as verified/anchored. Recorded, not assumed.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../../services/api/test/integration-harness.js";

const RESULTS = path.resolve(__dirname, "..", "..", "results");
const record = (name: string, data: unknown) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
};

describe("RT-VERIFY (audit probe)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../../../../../../services/api/src/db.js"))["prisma"];
  const keyId = `et-verify-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../../../../../../../services/api/test/integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../../../../../../services/api/src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function signedRecord(extra: Record<string, unknown> = {}) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const row = await prisma.evidence.create({
      data: { title: "et verify fixture", type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    });
    const canonical = JSON.stringify({ v: 1, evidenceId: row.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: row.id },
      data: {
        fileSha256, fingerprintCanonicalJson: canonical, fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), privateKey).toString("base64"),
        signingKeyId: keyId, signingKeyVersion: 1, signedAtUtc: new Date(),
        mimeType: "image/png", storageBucket: process.env.S3_BUCKET ?? "fixture-bucket",
        storageKey: `evidence/${row.id}/original.png`, sizeBytes: 10n,
        ...extra,
      } as never,
    });
    return { id: row.id, teamId, ownerUserId: team.ownerUserId };
  }

  it("CUSTODY-01: legal-hold title and INTERNAL release note reach the anonymous Verify answer", async () => {
    const { placeCanonicalLegalHold, releaseCanonicalLegalHold } = await import(
      "../../../../../../../services/api/src/services/governance/legal-hold.service.js"
    );
    const ev = await signedRecord();
    const TITLE = `ET-CONFIDENTIAL-MATTER-${randomUUID().slice(0, 6)} v. Acme`;
    const NOTE = `ET-INTERNAL-ONLY settlement discussed with counsel ${randomUUID().slice(0, 6)}`;
    const hold = await placeCanonicalLegalHold({ teamId: ev.teamId, scope: "EVIDENCE", evidenceId: ev.id, actorUserId: ev.ownerUserId, title: TITLE, reason: "et probe" });
    await releaseCanonicalLegalHold({ teamId: ev.teamId, holdId: hold.id, actorUserId: ev.ownerUserId, releaseNote: NOTE });

    const custody = await prisma.custodyEvent.findMany({ where: { evidenceId: ev.id }, orderBy: { sequence: "asc" }, select: { eventType: true } });
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${ev.id}` });
    const body = res.body;
    const out = {
      probe: "RT-VERIFY/CUSTODY-01",
      request: `GET /public/verify/${ev.id} (no Authorization header)`,
      status: res.statusCode,
      custodyEventTypes: custody.map((c) => c.eventType),
      titleDisclosed: body.includes(TITLE),
      internalReleaseNoteDisclosed: body.includes(NOTE),
      actorIdDisclosed: body.includes(ev.ownerUserId),
      excerpts: (body.match(/"payloadSummary":"[^"]*(legalHold|title|releaseNote)[^"]*"/g) ?? []).slice(0, 4),
    };
    record("rt-verify-custody01", out);
    expect(res.statusCode, body.slice(0, 400)).toBe(200);
    // The audit RECORDS the outcome; this assertion documents the defect.
    expect(out.titleDisclosed || out.internalReleaseNoteDisclosed).toBe(true);
  });

  it("VERIFY-STATES: TSA FAILED + OTS PENDING are not rendered as verified/anchored", async () => {
    const ev = await signedRecord({ tsaStatus: "FAILED", tsaFailureReason: "provider unavailable", otsStatus: "PENDING" });
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${ev.id}` });
    const j = res.json();
    const flat = JSON.stringify(j);
    const out = {
      probe: "RT-VERIFY/STATES",
      status: res.statusCode,
      tier: j.tier ?? null,
      tsaFields: Object.fromEntries(Object.entries(j).filter(([k]) => /tsa|timestamp/i.test(k))),
      otsFields: Object.fromEntries(Object.entries(j).filter(([k]) => /ots|anchor/i.test(k))),
      containsFullyAnchored: /fully anchored/i.test(flat),
      tsaReportedStamped: /"tsaStatus":"STAMPED"/.test(flat),
      otsReportedAnchored: /"otsStatus":"ANCHORED"/.test(flat),
      unknownVerifiedClaims: (flat.match(/[^"]{0,60}(verified|consistent)[^"]{0,60}/gi) ?? []).slice(0, 8),
    };
    record("rt-verify-states", out);
    expect(res.statusCode).toBe(200);
    expect(out.tsaReportedStamped).toBe(false);
    expect(out.otsReportedAnchored).toBe(false);
  });

  it("SEC-10: after the signature is tampered, the headline still says Core Integrity Verified (snapshot wins over live)", async () => {
    const ev = await signedRecord({ verificationStatus: "RECORDED_INTEGRITY_VERIFIED" });
    // 1. Genuine record: read the LIVE trust decision the route computes.
    const before = (await h.app.inject({ method: "GET", url: `/public/verify/${ev.id}` })).json();
    const findDecision = (o: unknown): unknown => {
      if (!o || typeof o !== "object") return null;
      const r = o as Record<string, unknown>;
      if (Array.isArray(r.signals) && typeof r === "object") return r;
      for (const v of Object.values(r)) { const f = findDecision(v); if (f) return f; }
      return null;
    };
    const liveDecision = findDecision(before);
    // 2. Persist it exactly as the report worker does (reports.trust_decision_snapshot).
    await prisma.report.create({
      data: { evidenceId: ev.id, version: 1, storageBucket: "fixture-bucket", storageKey: `reports/${ev.id}/v1.pdf`, generatedAtUtc: new Date(), trustDecisionSnapshot: liveDecision as never } as never,
    });
    // 3. Tamper: replace the signature with a valid-looking signature over OTHER bytes.
    await prisma.evidence.update({ where: { id: ev.id }, data: { signatureBase64: sign(null, Buffer.from("00".repeat(32), "hex"), privateKey).toString("base64") } as never });
    const after = (await h.app.inject({ method: "GET", url: `/public/verify/${ev.id}` })).json();
    const flat = JSON.stringify(after);
    const pick = (re: RegExp) => (flat.match(re) ?? [null])[0];
    const out = {
      probe: "RT-VERIFY/SEC-10",
      liveDecisionCoreSignalBefore: (liveDecision as { signals?: Array<{ key: string; status: string }> } | null)?.signals?.find((s) => s.key === "core_integrity")?.status ?? null,
      headlineBefore: before.integrityHeadline ?? before.overview?.integrityHeadline ?? pick.call(null, /"integrity(Headline|Status)":"[^"]*"/),
      headlineAfterTamper: after.integrityHeadline ?? after.overview?.integrityHeadline ?? pick(/"integrity(Headline|Status)":"[^"]*"/),
      signatureValidAfter: pick(/"signatureValid":(true|false)/),
      overallIntegrityAfter: pick(/"overallIntegrity":(true|false)/),
      trustDecisionSourceAfter: pick(/"source":"(REPORT_SNAPSHOT|VERIFICATION_PACKAGE_SNAPSHOT|LIVE_SHARED_FALLBACK)"/),
      coreIntegrityVerifiedTextAfter: /Core Integrity Verified/.test(flat),
    };
    record("rt-verify-sec10", out);
    expect(out.signatureValidAfter).toContain("false");
  });

  it("anti-enumeration: unknown id and malformed id answer the same way", async () => {
    const a = await h.app.inject({ method: "GET", url: `/public/verify/${randomUUID()}` });
    const b = await h.app.inject({ method: "GET", url: `/public/verify/not-a-uuid` });
    record("rt-verify-enumeration", { probe: "RT-VERIFY/ENUM", unknown: a.statusCode, malformed: b.statusCode, cacheControlUnknown: a.headers["cache-control"] ?? null });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
  });
});
