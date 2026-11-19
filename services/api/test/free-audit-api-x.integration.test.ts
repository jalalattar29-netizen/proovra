/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — API-X: the SERVER halves of the client lanes'
 * cross-lane requests (live PostgreSQL + Redis + MinIO).
 *
 * Every assertion is a behaviour through the real HTTP routes, with a
 * positive control on the same rows where a refusal is asserted.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapTeamRoleToCanonical, roleHasPermission, type Permission } from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps } from "./point7/product-fixtures.js";
import { createReviewerShareLink, shareLinkFor } from "./helpers/verify-share.js";

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("free-audit 0ea0 — API-X cross-lane completions (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let grant: typeof import("../src/services/packaging/entitlement.service.js")["upsertEntitlementGrant"];
  let originalBilling: Record<string, unknown> | null = null;
  let ip = 1;
  const A = () => h.fixtures.teamA;

  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: unknown): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `192.0.2.${(ip++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;
  const can = (role: string, permission: Permission) =>
    roleHasPermission(mapTeamRoleToCanonical(role as never), permission);

  async function signedEvidenceIn(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: {
        title: `api-x ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
      } as never,
      select: { id: true },
    });
  }

  beforeAll(async () => {
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    fx = await import("./point7/product-fixtures.js");
    ({ upsertEntitlementGrant: grant } = await import("../src/services/packaging/entitlement.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `apix-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    originalBilling = (await prisma.team.findUniqueOrThrow({
      where: { id: A().teamId },
      select: { billingPlan: true, billingStatus: true },
    })) as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: A().teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: A().teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 300_000);

  // ---------------------------------------------------------------------------
  // B5A-F-03 — the caller's per-record capabilities on the record detail.
  // ---------------------------------------------------------------------------
  it("B5A-F-03 — GET /v1/evidence/:id and the review workspace project actorCapabilities from the role matrix", async () => {
    const ev = await signedEvidenceIn(A().teamId, A().ownerUserId);
    const cases: Array<[string, string]> = [
      ["VIEWER", A().viewerToken],
      ["MEMBER", A().memberToken],
      ["OWNER", A().ownerToken],
    ];
    for (const [role, token] of cases) {
      const expected = {
        updateMetadata: can(role, "evidence.update_metadata"),
        archive: can(role, "evidence.archive"),
        delete: can(role, "evidence.delete"),
        restoreFromTrash: can(role, "evidence.restore_from_trash"),
        // PRO-E2-09: the projection also states the original-download gate's answer.
        downloadOriginal: can(role, "evidence.download_original"),
      };
      const detail = await call("GET", `/v1/evidence/${ev.id}`, token);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(json(detail).evidence.actorCapabilities, role).toEqual(expected);
      const ws = await call("GET", `/v1/evidence/${ev.id}/review-workspace`, token);
      expect(ws.statusCode, ws.body).toBe(200);
      expect(json(ws).evidence.actorCapabilities, role).toEqual(expected);
    }
    // A Viewer is read-only (A2-14); the owner holds every operation.
    const viewer = json(await call("GET", `/v1/evidence/${ev.id}`, A().viewerToken)).evidence.actorCapabilities;
    expect(Object.values(viewer).every((v) => v === false)).toBe(true);
    const owner = json(await call("GET", `/v1/evidence/${ev.id}`, A().ownerToken)).evidence.actorCapabilities;
    expect(owner.updateMetadata && owner.archive && owner.delete).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // B3C-F-005 — Rename/Delete from the destructive gate's own role input.
  // ---------------------------------------------------------------------------
  it("B3C-F-005 — a MEMBER case creator is not offered Rename/Delete the gate refuses; an ADMIN is", async () => {
    const created = await prisma.case.create({
      data: { name: `api-x ${randomUUID().slice(0, 6)}`, ownerUserId: A().memberUserId, teamId: A().teamId },
      select: { id: true },
    });
    const asMember = await call("GET", `/v1/cases/${created.id}/matter-workspace`, A().memberToken);
    expect(asMember.statusCode, asMember.body).toBe(200);
    const viewerCaps = json(asMember).viewer;
    expect(viewerCaps.canRename).toBe(false);
    expect(viewerCaps.canDelete).toBe(false);
    // …and the gate agrees: the creator's rename is refused.
    const rename = await call("PATCH", `/v1/cases/${created.id}`, A().memberToken, { name: "renamed by member" });
    expect(rename.statusCode, rename.body).toBeGreaterThanOrEqual(400);

    const asAdmin = await call("GET", `/v1/cases/${created.id}/matter-workspace`, A().adminToken);
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    expect(json(asAdmin).viewer.canRename).toBe(true);
    expect(json(asAdmin).viewer.canDelete).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // B5B-F-102 — packageAccess on the Reports rows.
  // ---------------------------------------------------------------------------
  it("B5B-F-102 — /v1/reports/artifacts and /v1/reports rows carry packageAccess from the role matrix", async () => {
    const ev = await signedEvidenceIn(A().teamId, A().ownerUserId);
    for (const [role, token] of [
      ["VIEWER", A().viewerToken],
      ["OWNER", A().ownerToken],
    ] as const) {
      const pkg = can(role, "evidence.download_package");
      const expected = { fullForensic: pkg && can(role, "evidence.download_original"), externalDisclosure: pkg };
      const aggregator = await call("GET", `/v1/reports/artifacts?teamId=${A().teamId}&limit=100`, token);
      expect(aggregator.statusCode, aggregator.body).toBe(200);
      const row = (json(aggregator).sections.artifacts.items as Array<Record<string, any>>).find((i) => i.evidenceId === ev.id);
      expect(row, role).toBeTruthy();
      expect(row!.packageAccess, role).toEqual(expected);

      const list = await call("GET", `/v1/reports?teamId=${A().teamId}&limit=100`, token);
      expect(list.statusCode, list.body).toBe(200);
      const item = (json(list).items as Array<Record<string, any>>).find((i) => i.evidenceId === ev.id);
      expect(item, role).toBeTruthy();
      expect(item!.packageAccess, role).toEqual(expected);
    }
  });

  // ---------------------------------------------------------------------------
  // R1-F-01 — a decision is made once, on a live request.
  // ---------------------------------------------------------------------------
  it("R1-F-01 — a decided response cannot be re-decided, nor a response of a closed request; an open one can", async () => {
    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: A().teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: `api-x ${randomUUID().slice(0, 6)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    const response = await prisma.evidenceRequestResponse.create({
      data: { evidenceRequestId: request.id, submittedByExternalLabel: "contributor" },
      select: { id: true },
    });
    const url = `/v1/evidence-requests/${request.id}/responses/${response.id}/review`;

    const accept = await call("POST", url, A().ownerToken, { status: "ACCEPTED" });
    expect(accept.statusCode, accept.body).toBe(200);

    const flip = await call("POST", url, A().ownerToken, { status: "REJECTED", reviewerNote: "changed my mind" });
    expect(flip.statusCode, flip.body).toBe(409);
    expect(json(flip).error.code).toBe("response_already_reviewed");
    const row = await prisma.evidenceRequestResponse.findUniqueOrThrow({ where: { id: response.id }, select: { status: true } });
    expect(row.status).toBe("ACCEPTED");

    // A RECEIVED response of a CANCELLED request takes no verdict.
    const second = await prisma.evidenceRequestResponse.create({
      data: { evidenceRequestId: request.id, submittedByExternalLabel: "contributor" },
      select: { id: true },
    });
    await prisma.evidenceRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } as never });
    const onClosed = await call(
      "POST",
      `/v1/evidence-requests/${request.id}/responses/${second.id}/review`,
      A().ownerToken,
      { status: "ACCEPTED" },
    );
    expect(onClosed.statusCode, onClosed.body).toBe(409);
    expect(json(onClosed).error.code).toBe("request_terminal");
    expect(
      (await prisma.evidenceRequestResponse.findUniqueOrThrow({ where: { id: second.id }, select: { status: true } })).status,
    ).toBe("RECEIVED");
  });

  // R1-F-01 (residual pass 2026-11-17) — "Needs additional context" now routes
  // to request-more from the web panel; the server keeps the same one-decision
  // rule there: a decided response mints no follow-up link and keeps its verdict.
  it("R1-F-01 — request-more on an already decided response is refused and mints no link", async () => {
    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: A().teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: `api-x more ${randomUUID().slice(0, 6)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    const response = await prisma.evidenceRequestResponse.create({
      data: { evidenceRequestId: request.id, submittedByExternalLabel: "contributor", status: "ACCEPTED" } as never,
      select: { id: true },
    });
    const linksBefore = await prisma.workflowIntakeLink.count({ where: { teamId: A().teamId } });
    const saved = {
      enabled: process.env.WORKFLOW_INTAKE_LINKS_ENABLED,
      secret: process.env.WORKFLOW_INTAKE_TOKEN_SECRET,
    };
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET = saved.secret ?? "api-x-throwaway-intake-hmac-0123456789abcdef";
    let more: Awaited<ReturnType<typeof call>>;
    try {
      more = await call(
        "POST",
        `/v1/evidence-requests/${request.id}/responses/${response.id}/request-more`,
        A().ownerToken,
        { reviewerNote: "need the second page", notifyContributor: false },
      );
    } finally {
      if (saved.enabled === undefined) delete process.env.WORKFLOW_INTAKE_LINKS_ENABLED;
      else process.env.WORKFLOW_INTAKE_LINKS_ENABLED = saved.enabled;
      if (saved.secret === undefined) delete process.env.WORKFLOW_INTAKE_TOKEN_SECRET;
      else process.env.WORKFLOW_INTAKE_TOKEN_SECRET = saved.secret;
    }
    expect(more.statusCode, more.body).toBe(409);
    expect(json(more).error.code).toBe("response_already_reviewed");
    expect(await prisma.workflowIntakeLink.count({ where: { teamId: A().teamId } })).toBe(linksBefore);
    const row = await prisma.evidenceRequestResponse.findUniqueOrThrow({
      where: { id: response.id },
      select: { status: true, reviewerNote: true },
    });
    expect(row.status).toBe("ACCEPTED");
    expect(row.reviewerNote).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // B2A-F-07 — the deep-link resolver opens cases and evidence requests.
  // ---------------------------------------------------------------------------
  it("B2A-F-07 — case, investigation and evidence-request links resolve to their workspace; review is an explicit unsupported type", async () => {
    const theCase = await call("POST", "/v1/deep-link/resolve", A().memberToken, { resourceType: "cases", resourceId: A().caseId });
    expect(theCase.statusCode, theCase.body).toBe(200);
    expect(json(theCase).workspaceId).toBe(A().teamId);
    const investigation = await call("POST", "/v1/deep-link/resolve", A().memberToken, {
      resourceType: "investigation",
      resourceId: A().caseId,
    });
    expect(investigation.statusCode, investigation.body).toBe(200);

    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: A().teamId,
        requestType: "DOCUMENT",
        status: "OPEN",
        priority: "NORMAL",
        title: `api-x ${randomUUID().slice(0, 6)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    const req = await call("POST", "/v1/deep-link/resolve", A().memberToken, { resourceType: "evidence-requests", resourceId: request.id });
    expect(req.statusCode, req.body).toBe(200);
    expect(json(req).workspaceId).toBe(A().teamId);

    // A non-member is still concealed.
    const outsider = await call("POST", "/v1/deep-link/resolve", h.fixtures.teamB.ownerToken, { resourceType: "cases", resourceId: A().caseId });
    expect(outsider.statusCode).toBe(404);

    // No id-bearing page: an explicit, type-only answer.
    const review = await call("POST", "/v1/deep-link/resolve", A().memberToken, { resourceType: "review", resourceId: randomUUID() });
    expect(review.statusCode, review.body).toBe(422);
    expect(json(review).error.code).toBe("DEEP_LINK_TYPE_UNSUPPORTED");
  });

  // ---------------------------------------------------------------------------
  // B4-F-101 — the session owner releases their own slot after demotion.
  // ---------------------------------------------------------------------------
  it("B4-F-101 — a member demoted to VIEWER can still discard their own capture session; nobody else can", async () => {
    const open = await call("POST", "/v1/capture/direct-sessions", A().memberToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: A().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = json(open).session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, A().memberToken, {
      type: "AUDIO",
      mimeType: "audio/mp4",
      deviceTimeIso: new Date().toISOString(),
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = json(reserve).evidence.evidenceId as string;

    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
      data: { role: "VIEWER" },
    });
    try {
      // Someone else (who may capture) cannot release it: same 404 as unknown.
      const other = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, A().adminToken, {});
      expect(other.statusCode, other.body).toBe(404);
      // The demoted owner may not START a capture …
      const reopen = await call("POST", "/v1/capture/direct-sessions", A().memberToken, {
        mode: "PROOVRA_MOBILE_APP",
        teamId: A().teamId,
        deviceId: null,
      });
      expect(reopen.statusCode).toBeGreaterThanOrEqual(400);
      // … but releases the one they hold.
      const discard = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, A().memberToken, {});
      expect(discard.statusCode, discard.body).toBe(200);
      expect(json(discard).result).toMatchObject({ discarded: true, releasedEvidenceId: evidenceId });
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } },
        data: { role: "MEMBER" },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // B4-F-300 — the resumable door's per-file contract and early refusal.
  // ---------------------------------------------------------------------------
  it("B4-F-300 — session create takes the per-file contract; the bridge stores it with the C-06 binding and a basename", async () => {
    const teamId = A().teamId;
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "VIDEO", mimeType: "video/webm", teamId });
    expect(created.statusCode, created.body).toBe(201);
    const evidenceId = json(created).id as string;
    const bytes = randomBytes(2048);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const clientSignals = { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED", captureTimeUtc: new Date().toISOString() };
    const contract = {
      privateRole: "primary",
      privateNote: "front door",
      checklistStepId: "step-1",
      sourceLabel: "camera",
      clientSignals,
    };
    const open = await call("POST", "/v1/uploads/sessions", A().ownerToken, {
      teamId,
      evidenceId,
      expectedPartCount: 1,
      expectedTotalBytes: bytes.length,
      expectedSha256: sha,
      targetPartIndex: 0,
      originalFileName: "folder/sub/clip.webm",
      expectedMimeType: "video/webm",
      ...contract,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sid = json(open).session.id as string;
    const base = `/v1/uploads/sessions/${sid}`;
    expect((await call("POST", `${base}/multipart/initiate`, A().ownerToken, { teamId })).statusCode).toBe(200);
    const presign = await call("POST", `${base}/parts/0/presign`, A().ownerToken, { teamId, sizeBytes: bytes.length });
    expect(presign.statusCode, presign.body).toBe(200);
    const put = await fetch(json(presign).uploadUrl as string, { method: "PUT", body: bytes });
    expect(put.status).toBe(200);
    const uploaded = await call("POST", `${base}/parts/0/uploaded`, A().ownerToken, {
      teamId,
      partEtag: put.headers.get("etag"),
      partSizeBytes: bytes.length,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const done = await call("POST", `${base}/multipart/complete`, A().ownerToken, { teamId, verifyHash: true, ...contract });
    expect(done.statusCode, done.body).toBe(200);

    const part = await prisma.evidencePart.findFirstOrThrow({
      where: { evidenceId, partIndex: 0 },
      select: { originalFileName: true, privateRole: true, privateNote: true, checklistStepId: true, sourceLabel: true, clientSignals: true },
    });
    expect(part.originalFileName).toBe("clip.webm");
    expect(part).toMatchObject({ privateRole: "primary", privateNote: "front door", checklistStepId: "step-1", sourceLabel: "camera" });
    const signals = part.clientSignals as Record<string, unknown>;
    expect(signals.audioNotCapturedReason).toBe("MICROPHONE_PERMISSION_DENIED");
    expect(signals.boundSha256Base64).toBe(Buffer.from(sha, "hex").toString("base64"));
    expect(signals.boundSizeBytes).toBe(bytes.length);
  });

  it("B4-F-300 — an older client's body (no contract) still bridges; a declared size past the storage limit is refused before a byte moves", async () => {
    const teamId = A().teamId;
    const created = await call("POST", "/v1/evidence", A().ownerToken, { type: "DOCUMENT", mimeType: "application/octet-stream", teamId });
    const evidenceId = json(created).id as string;
    const legacy = await call("POST", "/v1/uploads/sessions", A().ownerToken, {
      teamId,
      evidenceId,
      expectedPartCount: 1,
      targetPartIndex: 0,
      originalFileName: "legacy.bin",
      expectedMimeType: "application/octet-stream",
    });
    expect(legacy.statusCode, legacy.body).toBe(201);

    const free = await fx.seedPersonalTenant(deps, "FREE");
    const own = await call("POST", "/v1/evidence", free.owner.token, {
      type: "DOCUMENT",
      mimeType: "application/octet-stream",
      teamId: free.personalTeamId,
    });
    expect(own.statusCode, own.body).toBe(201);
    const ownId = json(own).id as string;
    const big = await call("POST", "/v1/uploads/sessions", free.owner.token, {
      teamId: free.personalTeamId,
      evidenceId: ownId,
      expectedPartCount: 1,
      expectedTotalBytes: 260 * 1024 * 1024,
      targetPartIndex: 0,
      originalFileName: "big.bin",
      expectedMimeType: "application/octet-stream",
    });
    expect(big.statusCode, big.body).toBe(409);
    expect(json(big).code).toBe("STORAGE_LIMIT_REACHED");
    expect(json(big).billingWall.reason).toBe("upload_session_blocked");
    const sessions = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "evidence_upload_sessions" WHERE "evidence_id" = $1::uuid`,
      ownId,
    )) as Array<{ n: number }>;
    expect(sessions[0]!.n).toBe(0);
    // Positive control: a size that fits opens a session.
    const small = await call("POST", "/v1/uploads/sessions", free.owner.token, {
      teamId: free.personalTeamId,
      evidenceId: ownId,
      expectedPartCount: 1,
      expectedTotalBytes: 1024,
      targetPartIndex: 0,
      originalFileName: "small.bin",
      expectedMimeType: "application/octet-stream",
    });
    expect(small.statusCode, small.body).toBe(201);
  });

  // ---------------------------------------------------------------------------
  // B4-F-206 — public Verify states "no audio recorded" per file (generic).
  // ---------------------------------------------------------------------------
  it("B4-F-206 — public Verify lists a video part without audio by index, in the generic wording", async () => {
    const ev = await signedEvidenceIn(A().teamId, A().ownerUserId);
    await prisma.evidencePart.createMany({
      data: [
        {
          evidenceId: ev.id,
          partIndex: 0,
          storageBucket: "b",
          storageKey: `evidence/${ev.id}/parts/000-clip.webm`,
          mimeType: "video/webm",
          sha256: "a".repeat(64),
          clientSignals: { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" },
        },
        {
          evidenceId: ev.id,
          partIndex: 1,
          storageBucket: "b",
          storageKey: `evidence/${ev.id}/parts/001-photo.jpg`,
          mimeType: "image/jpeg",
          sha256: "b".repeat(64),
          clientSignals: { captureTimeUtc: new Date().toISOString() },
        },
      ] as never,
    });
    // A genuinely sealed record (Verify answers only a recorded seal).
    const keyId = `apix-${randomUUID().slice(0, 8)}`;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await prisma.signingKey.create({
      data: { keyId, version: 1, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim() },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const canonical = JSON.stringify({ v: 1, evidenceId: ev.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonical).digest("hex");
    await prisma.evidence.update({
      where: { id: ev.id },
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
    const res = await h.app.inject({ method: "GET", url: `/public/verify/${await shareLinkFor(prisma, ev.id)}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res as unknown as Res);
    const artifacts = body.evidenceContent?.artifacts;
    expect(artifacts?.audioNotRecorded).toEqual([
      { partIndex: 0, statement: "No audio was recorded with this video (stated by the capture client)." },
    ]);
    // Minimal disclosure: the device's permission state is not published.
    expect(res.body).not.toContain("MICROPHONE_PERMISSION_DENIED");
    expect(res.body).not.toContain("microphone permission");
    // A verification-only (BASIC) link shows no per-file content facts at all.
    const basic = await h.app.inject({
      method: "GET",
      url: `/public/verify/${await createReviewerShareLink(prisma, ev.id, { projection: "BASIC" })}`,
    });
    expect(basic.statusCode, basic.body).toBe(200);
    expect(basic.body).not.toContain("No audio was recorded");
  });

  // ---------------------------------------------------------------------------
  // B5B-F-205 — planFeatures.redactionIncluded from FEATURE_REDACTION.
  // ---------------------------------------------------------------------------
  it("B5B-F-205 — planFeatures.redactionIncluded follows FEATURE_REDACTION (resolveEntitlement)", async () => {
    const t = await fx.seedPersonalTenant(deps, "FREE");
    const before = await call("GET", "/v1/platform/context", t.owner.token);
    expect(before.statusCode, before.body).toBe(200);
    expect(json(before).planFeatures.redactionIncluded).toBe(false);
    await grant({
      prisma: prisma as never,
      teamId: t.personalTeamId,
      key: "FEATURE_REDACTION",
      value: true,
      kind: "FEATURE",
      source: "CUSTOM",
      grantedByUserId: t.owner.userId,
    });
    const after = await call("GET", "/v1/platform/context", t.owner.token);
    expect(json(after).planFeatures.redactionIncluded).toBe(true);
  });
});
