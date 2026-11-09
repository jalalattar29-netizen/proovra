/**
 * IDENT-019 — a quarantined session keeps reads; original downloads and report
 * regeneration are refused. Live PostgreSQL, real HTTP.
 *
 * evidence.routes.ts also serves anonymous public Verify and stays isolated
 * from the session-runtime services (Phase 26.75), so these refusals come from
 * the services the routes already use: the artifact download gate (originals,
 * part URLs, presigned URLs in a record view) and the record operation-access
 * engine (report / package regeneration).
 *
 * Every refusal has its authorized control: the same person, the same record,
 * a clean session, allowed. And public Verify is unchanged throughout.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("IDENT-019 — original downloads and report regeneration (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let hashSessionId: (typeof import("../src/services/identity-security/session-revocation.service.js"))["hashSessionId"];
  let clearRates: () => Promise<unknown>;
  let sessionRowId: string;
  const created: string[] = [];

  const A = () => h.fixtures.teamA;
  const sidOf = (t: string) =>
    (JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8")) as { sid?: string }).sid;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ hashSessionId } = await import("../src/services/identity-security/session-revocation.service.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    await prisma.workspaceGovernancePolicy.deleteMany({ where: { teamId: A().teamId } });
    // The row a real sign-in writes for the owner's token (session inventory).
    const sid = sidOf(A().ownerToken);
    expect(sid, "the production signer mints a sid").toBeTruthy();
    const row = await prisma.authenticatedSession.create({
      data: {
        userId: A().ownerUserId,
        teamId: null,
        sessionIdHash: hashSessionId(sid!),
        expiresAtUtc: new Date(Date.now() + 60 * 60 * 1000),
      },
      select: { id: true },
    });
    sessionRowId = row.id;
  }, 180_000);

  afterAll(async () => {
    if (sessionRowId) await prisma?.authenticatedSession.delete({ where: { id: sessionRowId } }).catch(() => undefined);
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  beforeEach(async () => {
    await clearRates();
    await setQuarantine(false);
  });

  async function setQuarantine(on: boolean) {
    await prisma.authenticatedSession.update({
      where: { id: sessionRowId },
      data: on
        ? { quarantinedAtUtc: new Date(), quarantineReleaseAtUtc: new Date(Date.now() + 60 * 60 * 1000) }
        : { quarantinedAtUtc: null, quarantineReleaseAtUtc: null },
    });
  }

  async function signedRecord(parts: number) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `ident019 ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "REPORTED",
        lifecycleState: "ACTIVE",
        mimeType: "image/jpeg",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
        sizeBytes: 5_000n,
        storageBucket: "ident019-bucket",
        storageKey: `originals/${randomUUID()}.jpg`,
      } as never,
      select: { id: true },
    });
    created.push(ev.id);
    for (let i = 0; i < parts; i++) {
      await prisma.evidencePart.create({
        data: { evidenceId: ev.id, partIndex: i, storageBucket: "ident019-bucket", storageKey: `parts/${ev.id}/${i}.jpg`, mimeType: "image/jpeg" } as never,
      });
    }
    await prisma.report.create({
      data: { evidenceId: ev.id, version: 1, storageBucket: "b", storageKey: `reports/${ev.id}/v1.pdf`, generatedAtUtc: new Date(), sizeBytes: 1_000n },
    });
    await prisma.verificationPackage.create({
      data: { evidenceId: ev.id, version: 1, storageBucket: "b", storageKey: `verification/${ev.id}/v1.zip`, generatedAtUtc: new Date(), sizeBytes: 9_000n, reportVersion: 1 },
    });
    return ev.id;
  }

  const get = (url: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${A().ownerToken}` } });
  const errorCode = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
  const blockedFacts = async (id: string) =>
    (
      await prisma.custodyEvent.findMany({
        where: { evidenceId: id, eventType: "EXPORT_BLOCKED_BY_POLICY" as never },
        select: { payload: true },
      })
    ).map((e) => e.payload as Record<string, unknown>);
  const issuedFacts = (id: string) =>
    prisma.custodyEvent.count({ where: { evidenceId: id, eventType: { in: ["DOWNLOAD_AUTHORIZED", "EVIDENCE_DOWNLOADED"] as never } } });

  const newVersion = async (id: string) => {
    const st = await get(`/v1/evidence/${id}/artifacts/status`);
    const revision =
      st.statusCode === 200
        ? (st.json() as { outputs?: { offer?: { revision?: string } | null } }).outputs?.offer?.revision
        : undefined;
    return h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/reports/regenerate`,
      headers: { authorization: `Bearer ${A().ownerToken}`, "idempotency-key": `i19-${randomUUID()}` },
      payload: { intent: "NEW_VERSION", reason: "Document the later anchor", ...(revision ? { offerRevision: revision } : {}) },
    });
  };
  const requests = (id: string) => prisma.reportGenerationRequest.count({ where: { evidenceId: id } });

  it("/original: a clean session gets the link; the quarantined session is refused 403 and nothing is released", async () => {
    const control = await signedRecord(1);
    const ok = await get(`/v1/evidence/${control}/original`);
    expect(ok.statusCode, ok.body).toBe(200);

    const id = await signedRecord(1);
    await setQuarantine(true);
    const res = await get(`/v1/evidence/${id}/original`);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorCode(res)).toBe("session_quarantined");
    expect(res.body).not.toMatch(/https?:\/\//);
    expect(await issuedFacts(id)).toBe(0);
    expect(await blockedFacts(id)).toEqual([
      expect.objectContaining({ action: "download_original", reason: "session_quarantined", actorUserId: A().ownerUserId }),
    ]);
  });

  it("reads keep working: the record and its parts are served to the quarantined session, without original URLs", async () => {
    const id = await signedRecord(2);
    const cleanParts = await get(`/v1/evidence/${id}/parts`);
    expect((cleanParts.json().parts as Array<{ url?: string | null }>).filter((p) => p.url)).toHaveLength(2);

    await setQuarantine(true);
    const parts = await get(`/v1/evidence/${id}/parts`);
    expect(parts.statusCode, parts.body).toBe(200);
    const listed = parts.json().parts as Array<{ url?: string | null }>;
    expect(listed).toHaveLength(2);
    expect(listed.filter((p) => p.url)).toHaveLength(0);

    const view = await get(`/v1/evidence/${id}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(JSON.stringify(view.json())).not.toMatch(/"viewUrl":"[^"]+"/);
    expect(view.json().originalReleaseAllowed ?? view.json().evidence?.originalReleaseAllowed ?? false).toBe(false);
  });

  it("report regeneration: accepted on a clean session; refused 403 session_quarantined with no request created", async () => {
    const control = await signedRecord(0);
    const accepted = await newVersion(control);
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(await requests(control)).toBe(1);

    const id = await signedRecord(0);
    await setQuarantine(true);
    const res = await newVersion(id);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorCode(res)).toBe("session_quarantined");
    expect(await requests(id)).toBe(0);
    await expect
      .poll(() =>
        prisma.adminAuditLog.findFirst({
          where: { action: "evidence.report.regenerate_requested", resourceId: id },
          orderBy: { createdAt: "desc" },
          select: { metadata: true },
        }),
      )
      .toMatchObject({ metadata: { reason: "session_quarantined" } });
  });

  it("a stranger is answered by policy, never told about the session (404, no quarantine refusal)", async () => {
    const id = await signedRecord(1);
    await setQuarantine(true);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${id}/original`,
      headers: { authorization: `Bearer ${h.fixtures.teamB.ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("session_quarantined");
  });

  it("anonymous public Verify is unchanged while the owner's session is quarantined", async () => {
    const id = await signedRecord(0);
    const verify = () => h.app.inject({ method: "GET", url: `/public/verify/${id}` });
    const clean = await verify();
    await setQuarantine(true);
    const res = await verify();
    expect(res.statusCode).toBe(clean.statusCode);
    expect(res.body).not.toContain("session_quarantined");
  });
});
