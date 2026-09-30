/**
 * ET-SEC-19 — a package's signed download URL is never persisted, and the
 * package list (an evidence.read projection) never carries one.
 *
 * On a40ca76f `generateSignedUrl` — reached only through generate_package +
 * step-up — stored the bearer URL on the package row, and the list route,
 * which any evidence.read member may call, serialized it: a VIEWER could read
 * a 7-day package token minted by an admin.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("exchange signed URL is not stored or listed (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.EXCHANGE_DOWNLOAD_BASE_URL = "https://download.proovra.local/exchange/";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("a minted URL is returned to its minter only: not on the row, not in a viewer's list", async () => {
    const A = h.fixtures.teamA;
    const pkg = await prisma.evidenceExchangePackage.create({
      data: {
        teamId: A.teamId,
        kind: "DISCLOSURE",
        evidenceIds: [A.evidenceId],
        state: "READY",
        packageSha256: "a".repeat(64),
        storageKey: `exchange-packages/${A.teamId}/${randomUUID()}.zip`,
        createdByUserId: A.ownerUserId,
      },
      select: { id: true },
    });
    const { generateSignedUrl } = await import("../src/services/exchange/evidence-exchange.service.js");
    const minted = await generateSignedUrl({ teamId: A.teamId, packageId: pkg.id, ttlSeconds: 3600 });
    expect(minted.ok).toBe(true);
    const token = (minted as { signedUrl: string }).signedUrl.split("token=")[1]!;
    expect(token.length).toBeGreaterThan(10);

    // The list resolves the caller's current workspace.
    await prisma.user.update({ where: { id: A.viewerUserId }, data: { currentWorkspaceId: A.teamId } });
    const list = await h.app.inject({
      method: "GET",
      url: `/v1/exchange/packages?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.viewerToken}` },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain(pkg.id);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain("token=");

    const row = await prisma.evidenceExchangePackage.findUniqueOrThrow({
      where: { id: pkg.id },
      select: { signedUrl: true, signedUrlExpiresAtUtc: true },
    });
    expect(row.signedUrl).toBeNull();
    expect(row.signedUrlExpiresAtUtc).toBeInstanceOf(Date);
  });
});
