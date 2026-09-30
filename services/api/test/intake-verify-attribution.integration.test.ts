/**
 * ET-INT-12 — public Verify names a secure-intake submission's submitter the
 * way the report and package do: a contributor ROLE, never the link creator's
 * account. Live PostgreSQL 16, the real public route.
 *
 * On a40ca76f createEvidence stamped the record with the link CREATOR's email,
 * sign-in provider and identity level, and Verify (with no intake branch)
 * presented them as the submitter's, while the report printed "Remote
 * Contributor via Secure Intake Link".
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { INTAKE_SUBMITTED_BY_LABEL } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
// ET-PKG-07 — a record's id is not a public link: requests go through a share
// link (the record is published and the link minted on first use).
import { shareLinkFor } from "./helpers/verify-share.js";

describe("ET-INT-12 — intake attribution on public Verify (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const keyId = `int12-${randomUUID().slice(0, 8)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    // RICH public Verify (overview + custody timeline) is served to entitled workspaces.
    const A = h.fixtures.teamA;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    const orgId = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId!;
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgId, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function signedRecord(acquisitionMode: string | null) {
    const { teamId } = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const row = await prisma.evidence.create({
      data: {
        title: "INT-12 fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId: team.ownerUserId,
        acquisitionMode,
        acquisitionModeSource: acquisitionMode ? "RECORDED_AT_CREATION" : null,
        // What createEvidence stamps: the link CREATOR's account facts.
        submittedByEmail: "creator@workspace.example",
        submittedByAuthProvider: "GOOGLE",
        identityLevelSnapshot: "OAUTH_BACKED_IDENTITY",
      } as never,
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
    // The identity snapshot createEvidence records: the link CREATOR's facts.
    const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
    await appendCustodyEvent({
      evidenceId: row.id,
      eventType: "IDENTITY_SNAPSHOT_RECORDED" as never,
      payload: { identityLevelSnapshot: "OAUTH_BACKED_IDENTITY", submittedByEmail: "creator@workspace.example", submittedByAuthProvider: "GOOGLE" },
    });
    return row.id;
  }
  const verify = async (id: string) =>
    h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, id)}`, remoteAddress: `198.51.100.${1 + Math.floor(Math.random() * 250)}` });

  it("an intake record shows the contributor role, not the creator's provider or identity level", async () => {
    const res = await verify(await signedRecord("SECURE_INTAKE_LINK"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tier).toBe("RICH");
    const summaries: string[] = [];
    JSON.parse(res.body, (k, v) => {
      if (k === "payloadSummary" && typeof v === "string" && v.startsWith("Identity snapshot")) summaries.push(v);
      return v;
    });
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) expect(s).toBe(`Identity snapshot recorded • Submitted by: ${INTAKE_SUBMITTED_BY_LABEL}`);
    const seen: Record<string, unknown[]> = { submittedByAuthProvider: [], identityLevel: [], identityLevelCode: [] };
    JSON.parse(res.body, (k, v) => {
      if (k in seen) seen[k]!.push(v);
      return v;
    });
    expect(seen.submittedByAuthProvider!.length).toBeGreaterThan(0);
    for (const v of seen.submittedByAuthProvider!) expect(v).toBe(INTAKE_SUBMITTED_BY_LABEL);
    for (const v of seen.identityLevel!) expect(v).toBeNull();
    for (const v of seen.identityLevelCode!) expect(v).toBeNull();
    expect(res.body).not.toContain("OAuth-backed identity");
    expect(res.body).not.toContain("creator@");
  });

  it("an ordinary upload keeps its account attribution", async () => {
    const res = await verify(await signedRecord("PROOVRA_WEB_UPLOAD"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().tier).toBe("RICH");
    expect(res.body).toContain("OAuth-backed identity");
    expect(res.body).not.toContain(INTAKE_SUBMITTED_BY_LABEL);
  });
});
