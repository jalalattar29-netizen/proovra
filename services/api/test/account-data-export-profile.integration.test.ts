/**
 * B-22 — the personal data export carries every profile field the person wrote.
 *
 * `PATCH /v1/users/me` lets a person set a bio and an avatar URL, and
 * `GET /v1/users/me` reads them back (users.routes.ts pickMe), but the export
 * package's profile selected neither — the person's own words were missing from
 * "your data". Through the real routes (request, lifecycle processor, download)
 * against a disposable PostgreSQL 16.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedUser, type FixtureDeps } from "./point7/product-fixtures.js";

type Json = Record<string, unknown>;

describe("B-22 — the data export includes bio and avatar URL (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let exportsSvc: typeof import("../src/services/identity/account-data-export.service.js");
  let hashPassword: (typeof import("../src/services/email-password-auth.service.js"))["hashPassword"];
  const PASSWORD = "Export-Profile-Pass-1";

  const call = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      remoteAddress: "192.0.2.77",
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
  const proof = { stepUp: { method: "password", currentPassword: PASSWORD } };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    exportsSvc = await import("../src/services/identity/account-data-export.service.js");
    ({ hashPassword } = await import("../src/services/email-password-auth.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `b22-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt({ sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, secret, 3600),
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("a bio and avatar URL set through PATCH /v1/users/me are in the downloaded package's profile", async () => {
    const u = await seedUser(deps, "profile");
    await prisma.user.update({ where: { id: u.userId }, data: { passwordHash: await hashPassword(PASSWORD) } });

    const bio = "Claims investigator, Northgate.";
    const avatarUrl = "https://cdn.example.test/avatars/b22.png";
    const patched = await call("PATCH", "/v1/users/me", u.token, { bio, avatarUrl });
    expect(patched.statusCode, patched.body).toBe(200);

    const requested = await call("POST", "/v1/identity/data-export", u.token, proof);
    expect(requested.statusCode, requested.body).toBe(201);
    const id = ((JSON.parse(requested.body) as Json).request as { id: string }).id;
    await exportsSvc.processAccountDataExports(new Date());
    const row = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("READY");

    const dl = await call("POST", `/v1/identity/data-export/${id}/download`, u.token, proof);
    expect(dl.statusCode, dl.body).toBe(200);
    const pkg = JSON.parse(dl.body) as { profile: Json };
    expect(pkg.profile.bio).toBe(bio);
    expect(pkg.profile.avatarUrl).toBe(avatarUrl);
    // The data boundary is unchanged: nothing secret rides along.
    expect(Object.keys(pkg.profile)).not.toContain("passwordHash");
  });
});
