/**
 * PRO-O1Z-02 (RG-18) — the exchange package answers the workspace's
 * package-download policy, like every other package release.
 *
 * At the base the exchange sign-url and the download authorisation asked the
 * capability and the step-up but never `enforceSensitiveAction
 * ("download_package")`: a workspace that had switched package downloads off
 * still released its records through an exchange link. The real service and
 * the real governance gate run here; only the database is a double.
 */
import { describe, expect, it } from "vitest";

import {
  generateSignedUrl,
  recordPackageDownload,
} from "../src/services/exchange/evidence-exchange.service.js";

type World = {
  /** null = the workspace has no policy row (defaults: downloads allowed). */
  allowPackageDownload: boolean | null;
  membership: { role: string; status: string } | null;
  writes: string[];
};

function makePrisma(w: World) {
  return {
    evidenceExchangePackage: {
      findFirst: async () => ({
        id: "pkg-1",
        state: "READY",
        packageSha256: "a".repeat(64),
        evidenceIds: [],
        storageKey: "exchange/pkg-1.zip",
      }),
      update: async () => {
        w.writes.push("package.update");
        return {};
      },
    },
    evidenceExchangePackageDelivery: {
      findFirst: async () => ({ id: "del-1", packageId: "pkg-1", downloadAuthorizedAtUtc: null }),
      update: async () => {
        w.writes.push("delivery.update");
        return {};
      },
    },
    teamMember: { findUnique: async () => w.membership },
    workspaceGovernancePolicy: {
      findUnique: async () =>
        w.allowPackageDownload === null ? null : { allowPackageDownload: w.allowPackageDownload },
    },
    evidence: { findMany: async () => [] },
    lifecycleWebhookEndpoint: { findMany: async () => [] },
  };
}

const world = (over: Partial<World> = {}): World => ({
  allowPackageDownload: null,
  membership: { role: "OWNER", status: "ACTIVE" },
  writes: [],
  ...over,
});

const mint = (w: World, actorUserId: string | undefined = "user-1") =>
  generateSignedUrl({
    prisma: makePrisma(w) as never,
    teamId: "team-1",
    packageId: "pkg-1",
    ttlSeconds: 600,
    baseUrl: "https://download.example.test/exchange/",
    actorUserId,
  });

describe("exchange sign-url obeys the workspace package-download policy (PRO-O1Z-02)", () => {
  it("mints for a member the policy allows", async () => {
    const w = world();
    const res = await mint(w);
    expect(res.ok).toBe(true);
  });

  it("refuses, and mints nothing, when the workspace switched package downloads off", async () => {
    const w = world({ allowPackageDownload: false });
    const res = await mint(w);
    expect(res).toEqual({
      ok: false,
      denial: "POLICY_BLOCKED",
      code: "PACKAGE_BLOCKED_BY_POLICY",
      reason: "package_disabled_by_policy",
    });
    expect(w.writes).toEqual([]);
  });

  it("refuses a caller who is not an active member of the workspace", async () => {
    for (const membership of [null, { role: "OWNER", status: "SUSPENDED" }]) {
      const w = world({ membership });
      const res = await mint(w);
      expect(res).toMatchObject({ ok: false, denial: "POLICY_BLOCKED", code: "PACKAGE_BLOCKED_BY_POLICY" });
      expect(w.writes).toEqual([]);
    }
  });
});

describe("exchange download authorisation obeys the same policy (PRO-O1Z-02)", () => {
  const authorise = (w: World) =>
    recordPackageDownload({
      prisma: makePrisma(w) as never,
      teamId: "team-1",
      deliveryId: "del-1",
      actorUserId: "user-1",
    });

  it("records the authorisation for a member the policy allows", async () => {
    const w = world();
    expect(await authorise(w)).toEqual({ ok: true });
    expect(w.writes).toEqual(["delivery.update"]);
  });

  it("records nothing when package downloads are switched off", async () => {
    const w = world({ allowPackageDownload: false });
    expect(await authorise(w)).toMatchObject({
      ok: false,
      denial: "POLICY_BLOCKED",
      code: "PACKAGE_BLOCKED_BY_POLICY",
    });
    expect(w.writes).toEqual([]);
  });
});
