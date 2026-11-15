/**
 * F-25 / F-17 — the personal data export cannot be blocked forever by a stalled
 * job, and account closure tells the person what stays public.
 *
 * Real routes (`harness.app.inject`) and the real lifecycle processor against a
 * disposable PostgreSQL 16.
 *
 * F-25
 *   - a PROCESSING claim older than the stale window blocks a new request only
 *     until the lifecycle tick reaps it (FAILED / generation_stalled); the new
 *     request then completes and downloads, and the bytes downloaded are the
 *     bytes whose SHA-256 the row shows
 *   - a PROCESSING claim inside the window is live work and is left alone
 *   - concurrent requests make exactly one request row
 *   - a READY package past its expiry no longer blocks a new request
 *   - another account cannot download the package
 * F-17
 *   - the closure preview names the records whose public verification page
 *     stays online, and stops naming a record once its page is withdrawn
 *   - before closure the canonical pvr_ page and an owner share link both
 *     resolve; after closure the owner link is dead (410) and the pvr_ page
 *     still resolves — the approved publication policy, now stated up front
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, seedPersonalTenant, seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("F-25 / F-17 — export lifecycle recovery and closure visibility (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let exports: typeof import("../src/services/identity/account-data-export.service.js");
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let runtime: typeof import("@proovra/shared-runtime");
  let s3: (typeof import("../src/storage.js"))["s3"];
  let orgClosure: typeof import("../src/services/organization/org-closure.service.js");
  const PASSWORD = "Export-Owner-Pass-1";
  // D-07 — genuinely sealed fixture records (the public page answers 409 NOT_SEALED otherwise).
  const sealKeyId = `d07-seal-${randomUUID().slice(0, 8)}`;
  const sealKeys = generateKeyPairSync("ed25519");
  let ipCounter = 1;

  const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      remoteAddress: `192.0.2.${(ipCounter++ % 250) + 1}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const json = (r: { body: string }) => JSON.parse(r.body) as Json;
  const proof = { stepUp: { method: "password", currentPassword: PASSWORD } };

  async function owner(label: string) {
    const u = await seedUser(deps, label);
    await prisma.user.update({ where: { id: u.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return u;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    exports = await import("../src/services/identity/account-data-export.service.js");
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    runtime = await import("@proovra/shared-runtime");
    ({ s3 } = await import("../src/storage.js"));
    orgClosure = await import("../src/services/organization/org-closure.service.js");
    await prisma.signingKey.create({
      data: {
        keyId: sealKeyId,
        version: 1,
        publicKeyPem: sealKeys.publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
      },
    });
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `f25-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ===========================================================================
  // F-25
  // ===========================================================================

  it("a stalled PROCESSING claim is reaped by the tick; a new request then completes and downloads the exact bytes", async () => {
    const u = await owner("stalled");
    const stuck = await prisma.accountDataExportRequest.create({
      data: { userId: u.userId, status: "PROCESSING", startedAtUtc: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      select: { id: true },
    });

    const blocked = await call("POST", "/v1/identity/data-export", u.token, proof);
    expect(blocked.statusCode).toBe(409);
    expect((json(blocked).error as Json).code).toBe("export_request_active");

    const tick = await exports.processAccountDataExports(new Date());
    expect(tick.stalled).toBeGreaterThanOrEqual(1);
    const reaped = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(reaped.status).toBe("FAILED");
    expect(reaped.failureCode).toBe("generation_stalled");

    const fresh = await call("POST", "/v1/identity/data-export", u.token, proof);
    expect(fresh.statusCode, fresh.body).toBe(201);
    const id = (json(fresh).request as { id: string }).id;
    await exports.processAccountDataExports(new Date());
    const ready = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(ready.status).toBe("READY");

    const dl = await call("POST", `/v1/identity/data-export/${id}/download`, u.token, proof);
    expect(dl.statusCode, dl.body).toBe(200);
    const digest = createHash("sha256").update(dl.body, "utf8").digest("hex");
    expect(digest).toBe(ready.packageSha256);
    expect(dl.headers["x-package-sha256"]).toBe(ready.packageSha256);
    // The reaped row is history, not a second package.
    expect(await prisma.accountDataExportRequest.count({ where: { userId: u.userId, status: "READY" } })).toBe(1);

    // Strictly the owner's.
    const other = await owner("stalled-other");
    const foreign = await call("POST", `/v1/identity/data-export/${id}/download`, other.token, proof);
    expect(foreign.statusCode).toBe(404);
  });

  it("a PROCESSING claim inside the stale window is live work and is left alone", async () => {
    const u = await owner("live");
    const live = await prisma.accountDataExportRequest.create({
      data: { userId: u.userId, status: "PROCESSING", startedAtUtc: new Date(Date.now() - 60 * 1000) },
      select: { id: true },
    });
    await exports.processAccountDataExports(new Date());
    expect((await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("PROCESSING");
    expect((await call("POST", "/v1/identity/data-export", u.token, proof)).statusCode).toBe(409);
  });

  it("concurrent requests make exactly one request row", async () => {
    const u = await owner("concurrent");
    const results = await Promise.all([
      call("POST", "/v1/identity/data-export", u.token, proof),
      call("POST", "/v1/identity/data-export", u.token, proof),
      call("POST", "/v1/identity/data-export", u.token, proof),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409]);
    expect(await prisma.accountDataExportRequest.count({ where: { userId: u.userId } })).toBe(1);
  });

  it("a READY package past its expiry no longer blocks a new request", async () => {
    const u = await owner("expired-ready");
    await prisma.accountDataExportRequest.create({
      data: {
        userId: u.userId,
        status: "READY",
        packageJson: "{}",
        packageSha256: createHash("sha256").update("{}").digest("hex"),
        completedAtUtc: new Date(Date.now() - 8 * 86_400_000),
        expiresAtUtc: new Date(Date.now() - 86_400_000),
      },
    });
    const res = await call("POST", "/v1/identity/data-export", u.token, proof);
    expect(res.statusCode, res.body).toBe(201);
  });

  // ===========================================================================
  // F-17
  // ===========================================================================

  it("closure preview names what stays public; owner link dies at closure, the pvr_ page stays (policy)", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const team = await prisma.team.findUniqueOrThrow({ where: { id: t.personalTeamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `Signed ${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: t.personalTeamId,
        organizationId: team.organizationId,
        ownerUserId: t.owner.userId,
      },
      select: { id: true },
    });
    const { ref, ownerToken } = await prisma.$transaction(async (tx) => {
      const r = await runtime.ensureVerificationRefTx(tx as never, ev.id);
      const minted = await runtime.mintVerificationShareTokenTx(tx as never, {
        evidenceId: ev.id,
        teamId: t.personalTeamId,
        purpose: "OWNER_SHARE",
        createdByUserId: t.owner.userId,
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
      } as never);
      return { ref: r.ref!, ownerToken: minted.token as string };
    });

    const preview = async () => {
      const res = await call("GET", "/v1/identity/account-closure", t.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      return (json(res).consequences as Array<{ code: string; count: number; message: string }>) ?? [];
    };
    const kept = (await preview()).find((c) => c.code === "PUBLIC_VERIFICATION_REMAINS");
    expect(kept?.count).toBe(1);
    expect(kept?.message).toMatch(/Withdraw page/);
    // D-07 — the server consequence (shown by web and native) states the minimal disclosure.
    expect(kept?.message).toMatch(/only the verification result, never your files/);

    // A withdrawn page is not "online" — the preview stops naming it.
    await prisma.evidence.update({ where: { id: ev.id }, data: { verificationAccessState: "WITHDRAWN" } });
    expect((await preview()).some((c) => c.code === "PUBLIC_VERIFICATION_REMAINS")).toBe(false);
    await prisma.evidence.update({ where: { id: ev.id }, data: { verificationAccessState: "AVAILABLE" } });

    const verify = (identifier: string) => harness.app.inject({ method: "GET", url: `/public/verify/${identifier}` });
    const resolves = async (identifier: string) => {
      const r = await verify(identifier);
      return r.statusCode !== 404 && r.statusCode !== 410;
    };
    expect(await resolves(ref)).toBe(true);
    expect(await resolves(ownerToken)).toBe(true);

    await accountClosure.executeAccountClosure(t.owner.userId);

    expect((await verify(ownerToken)).statusCode).toBe(410);
    expect(await resolves(ref)).toBe(true);
  });

  // ===========================================================================
  // D-07 (round 3, product decision 2026-11-15) — public Verify after closure.
  // An already-public page keeps its canonical URL and QR with the minimal
  // projection; private and withdrawn records never become public; the closed
  // account's credentials read nothing and act on nothing; issued bytes and the
  // historic QR link are unchanged. Personal closure AND the organization
  // ownership controls.
  // ===========================================================================

  /** An issued record: report bytes in MinIO, pvr_, the QR link a report printed, an owner share. */
  async function issuedRecord(input: { teamId: string; ownerUserId: string; withdrawn?: boolean; withRef?: boolean }) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: input.teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: {
        title: `D07 ${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "REPORTED",
        teamId: input.teamId,
        organizationId: team.organizationId,
        ownerUserId: input.ownerUserId,
        signedAtUtc: new Date(),
        lat: 51.5007,
        lng: -0.1246,
        showRecordedLocation: false,
        ...(input.withdrawn ? { verificationAccessState: "WITHDRAWN", verificationAccessReason: "PRIVACY_REQUEST" } : {}),
      } as never,
      select: { id: true },
    });
    const fileSha256 = createHash("sha256").update(randomUUID()).digest("hex");
    const canonicalJson = JSON.stringify({ v: 1, evidenceId: ev.id, sha256: fileSha256 });
    const fingerprintHash = createHash("sha256").update(canonicalJson).digest("hex");
    await prisma.evidence.update({
      where: { id: ev.id },
      data: {
        fileSha256,
        fingerprintCanonicalJson: canonicalJson,
        fingerprintHash,
        signatureBase64: sign(null, Buffer.from(fingerprintHash, "hex"), sealKeys.privateKey).toString("base64"),
        signingKeyId: sealKeyId,
        signingKeyVersion: 1,
        mimeType: "image/png",
        storageBucket: process.env.S3_BUCKET as string,
        storageKey: `evidence/${ev.id}/original.png`,
        sizeBytes: 10n,
      } as never,
    });
    const bytes = randomBytes(2048);
    const key = `reports/${ev.id}/v1-d07.pdf`;
    const bucket = process.env.S3_BUCKET as string;
    const put = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
    await prisma.report.create({
      data: {
        evidenceId: ev.id,
        version: 1,
        storageBucket: bucket,
        storageKey: key,
        s3VersionId: put.VersionId ?? null,
        pdfSha256,
        generatedAtUtc: new Date(),
        sizeBytes: BigInt(bytes.length),
      } as never,
    });
    const links = await prisma.$transaction(async (tx) => {
      const ref = input.withRef === false ? null : (await runtime.ensureVerificationRefTx(tx as never, ev.id)).ref!;
      if (!ref) return { ref: null, qrToken: null, ownerToken: null };
      const qr = await runtime.mintVerificationShareTokenTx(tx as never, {
        evidenceId: ev.id,
        teamId: input.teamId,
        purpose: "REPORT",
        reportVersion: 1,
      } as never);
      const owner = await runtime.mintVerificationShareTokenTx(tx as never, {
        evidenceId: ev.id,
        teamId: input.teamId,
        purpose: "OWNER_SHARE",
        createdByUserId: input.ownerUserId,
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
      } as never);
      return { ref, qrToken: qr.token as string, ownerToken: owner.token as string };
    });
    return { id: ev.id, key, bucket, pdfSha256, ...links };
  }

  const publicVerify = (identifier: string) =>
    harness.app.inject({ method: "GET", url: `/public/verify/${identifier}`, remoteAddress: `198.51.100.${(ipCounter++ % 250) + 1}` });

  /** The minimal projection: no files, no storage, no private metadata, no owner contact. */
  function expectMinimalProjection(body: string, ctx: { id: string; key: string; email: string }) {
    expect(body).not.toContain("X-Amz-Signature");
    expect(body).not.toContain(ctx.key);
    expect(body).not.toContain("storageKey");
    expect(body).not.toContain(ctx.email);
    expect(body).not.toContain("51.5007");
    expect(body).not.toContain("-0.1246");
  }

  async function storedReportFacts(evidenceId: string) {
    const r = await prisma.report.findFirstOrThrow({
      where: { evidenceId, version: 1 },
      select: { id: true, storageKey: true, s3VersionId: true, pdfSha256: true, sizeBytes: true },
    });
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET as string, Key: r.storageKey! }));
    const bytes = Buffer.from(await obj.Body!.transformToByteArray());
    return { ...r, sizeBytes: String(r.sizeBytes), objectSha256: createHash("sha256").update(bytes).digest("hex") };
  }

  it("D-07 personal closure: public page and historic QR stay with minimal disclosure; withdrawn/private stay closed; closed credentials read and do nothing; bytes unchanged", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const pub = await issuedRecord({ teamId: t.personalTeamId, ownerUserId: t.owner.userId });
    const withdrawn = await issuedRecord({ teamId: t.personalTeamId, ownerUserId: t.owner.userId, withdrawn: true });
    const priv = await issuedRecord({ teamId: t.personalTeamId, ownerUserId: t.owner.userId, withRef: false });

    // Before closure: the owner reads the issued report; every public answer is as published.
    const before = await call("GET", `/v1/evidence/${pub.id}/report/latest`, t.owner.token);
    expect(before.statusCode, before.body).toBe(200);
    const pubBefore = await publicVerify(pub.ref!);
    expect(pubBefore.statusCode, pubBefore.body).toBe(200);
    const factsBefore = await storedReportFacts(pub.id);

    await accountClosure.executeAccountClosure(t.owner.userId);
    const closedUser = await prisma.user.findUniqueOrThrow({ where: { id: t.owner.userId }, select: { providerUserId: true } });
    expect(closedUser.providerUserId).toBe(`closed:${t.owner.userId}`);

    // 1. The canonical pvr_ URL and the QR link the issued report printed still verify, minimally.
    for (const identifier of [pub.ref!, pub.qrToken!]) {
      const res = await publicVerify(identifier);
      expect(res.statusCode, `${identifier}: ${res.body}`).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expectMinimalProjection(res.body, { id: pub.id, key: pub.key, email: t.owner.email });
      // Same canonical identity (what the printed QR resolves to), verification-only disclosure.
      expect(res.json().recordFacts?.verificationReference).toBe(pub.ref);
      expect(res.json().link).toMatchObject({ kind: "CANONICAL" });
      expect(res.body).toContain("Disclosure: Verification only");
    }
    // The owner's recipient link is a grant closure revokes.
    expect((await publicVerify(pub.ownerToken!)).statusCode).toBe(410);

    // 2. Withdrawn stays withdrawn (every identifier); private never becomes public.
    for (const identifier of [withdrawn.ref!, withdrawn.qrToken!]) {
      const res = await publicVerify(identifier);
      expect(res.statusCode, res.body).toBe(410);
      expect(res.json().canonicalVerification?.status).toBe("WITHDRAWN");
      expectMinimalProjection(res.body, { id: withdrawn.id, key: withdrawn.key, email: t.owner.email });
    }
    expect((await publicVerify(priv.id)).statusCode).toBe(404);
    const states = await prisma.evidence.findMany({
      where: { id: { in: [pub.id, withdrawn.id, priv.id] } },
      select: { id: true, verificationAccessState: true, verificationRef: true },
    });
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get(withdrawn.id)!.verificationAccessState).toBe("WITHDRAWN");
    expect(byId.get(priv.id)!.verificationRef).toBeNull();
    expect(byId.get(pub.id)!.verificationRef).toBe(pub.ref);

    // 3. The closed account's credentials read no file and perform no action.
    for (const [method, url, payload] of [
      ["GET", `/v1/evidence/${pub.id}/report/latest`, undefined],
      ["GET", `/v1/evidence/${pub.id}/reports/1`, undefined],
      ["GET", `/v1/evidence/${pub.id}/original`, undefined],
      ["GET", `/v1/evidence/${pub.id}/verification-package`, undefined],
      ["POST", `/v1/evidence/${pub.id}/verification-access/withdraw`, { reason: "PRIVACY_REQUEST", ...proof }],
      ["POST", `/v1/evidence/${withdrawn.id}/verification-access/reinstate`, proof],
      ["POST", `/v1/evidence/${pub.id}/reports/regenerate`, {}],
    ] as const) {
      const res = await call(method, url, t.owner.token, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(401);
    }
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: pub.id }, select: { verificationAccessState: true } })).verificationAccessState).toBe("AVAILABLE");
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: withdrawn.id }, select: { verificationAccessState: true } })).verificationAccessState).toBe("WITHDRAWN");
    expect(await prisma.reportGenerationRequest.count({ where: { evidenceId: pub.id } })).toBe(0);

    // 4. Issued bytes, their digest and the stored object are unchanged.
    expect(await storedReportFacts(pub.id)).toEqual(factsBefore);
    expect(factsBefore.objectSha256).toBe(pub.pdfSha256);
  }, 60_000);

  it("D-07 organization ownership: an org owner with members cannot close; org closure keeps public pages and the QR, revokes grants and member access", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const pub = await issuedRecord({ teamId: org.workspaceId, ownerUserId: org.owner.userId });
    const withdrawn = await issuedRecord({ teamId: org.workspaceId, ownerUserId: org.owner.userId, withdrawn: true });
    await prisma.user.update({ where: { id: org.owner.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });

    // Ownership control: the owner of an organization with other members is refused.
    const preview = await call("GET", "/v1/identity/account-closure", org.owner.token);
    expect(preview.statusCode, preview.body).toBe(200);
    const codes = ((json(preview).blockers as Array<{ code: string }>) ?? []).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED", "ORGANIZATION_OFFBOARDING_REQUIRED"]));
    const refused = await call("POST", "/v1/identity/account-closure", org.owner.token, {
      confirmation: "close my account",
      ...proof,
    });
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(json(refused))).toContain("closure_blocked");
    expect(
      await prisma.accountClosureRequest.count({
        where: { userId: org.owner.userId, status: { in: ["COOLING_OFF", "SCHEDULED", "PROCESSING", "COMPLETED"] } },
      }),
    ).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { status: true } })).status).toBe("ACTIVE");

    const member = org.members[0]!;
    const memberRead = await call("GET", `/v1/evidence/${pub.id}/report/latest`, member.token);
    expect(memberRead.statusCode, memberRead.body).toBe(200);
    const factsBefore = await storedReportFacts(pub.id);

    // Organization closure — the org's own ownership control.
    const { executeOrganizationClosure } = orgClosure;
    await executeOrganizationClosure({ organizationId: org.organizationId, requestedByUserId: org.owner.userId });

    for (const identifier of [pub.ref!, pub.qrToken!]) {
      const res = await publicVerify(identifier);
      expect(res.statusCode, res.body).toBe(200);
      expectMinimalProjection(res.body, { id: pub.id, key: pub.key, email: org.owner.email });
    }
    expect((await publicVerify(pub.ownerToken!)).statusCode).toBe(410);
    for (const identifier of [withdrawn.ref!, withdrawn.qrToken!]) {
      expect((await publicVerify(identifier)).statusCode).toBe(410);
    }

    // A member who read the report before reads nothing once the org is closed.
    const memberAfter = await call("GET", `/v1/evidence/${pub.id}/report/latest`, member.token);
    expect([401, 403, 404], memberAfter.body).toContain(memberAfter.statusCode);
    expect(await storedReportFacts(pub.id)).toEqual(factsBefore);
  }, 60_000);
});
