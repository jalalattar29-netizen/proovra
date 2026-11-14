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
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("F-25 / F-17 — export lifecycle recovery and closure visibility (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let exports: typeof import("../src/services/identity/account-data-export.service.js");
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  let runtime: typeof import("@proovra/shared-runtime");
  const PASSWORD = "Export-Owner-Pass-1";
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
});
