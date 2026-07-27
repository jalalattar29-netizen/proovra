/**
 * PHASE 5 §8 (2026-07-22) — org-invite acceptance idempotency +
 * concurrency + token preservation through auth redirects.
 *
 * Behavioral (canonical service, proxy prisma):
 *   * fresh accept: guarded claim happens BEFORE any grant; grants +
 *     ORG_MEMBER_ACCEPTED audit written exactly once;
 *   * same-user retry of a consumed invite → 200-shaped idempotent
 *     replay with ZERO writes;
 *   * different user on a consumed invite → already_accepted + audited;
 *   * concurrent race loser (claim count 0) → replay (same user) /
 *     already_accepted (different user), never a double-grant;
 *   * email mismatch / expired / revoked / not_found unchanged.
 *
 * Source contracts: route delegates to the service and surfaces
 * idempotentReplay; BOTH web invite-accept pages preserve the token
 * through the auth redirect via /login?next= (there is no /signin).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { model: string; method: string; args: unknown[] };

const H = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown[] }[],
  userEmail: "invitee@acme.com" as string | null,
  invite: null as Record<string, unknown> | null,
  claimCount: 1,
  orgStatus: "ACTIVE" as string,
  winnerAcceptedBy: null as string | null,
  team: { organizationId: "org-1", isPersonal: false } as Record<
    string,
    unknown
  > | null,
}));

function makeTx() {
  return new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_t2, method: string) {
              return async (...args: unknown[]) => {
                H.calls.push({ model, method, args });
                if (model === "user" && method === "findUnique")
                  return { email: H.userEmail };
                if (model === "organization" && method === "findUnique")
                  return { status: H.orgStatus };
                if (model === "organizationInvite" && method === "findUnique") {
                  const where = (args[0] as { where: Record<string, unknown> })
                    .where;
                  if (where.tokenHash) return H.invite;
                  // post-claim re-read of the race winner
                  return { acceptedByUserId: H.winnerAcceptedBy };
                }
                if (model === "organizationInvite" && method === "updateMany")
                  return { count: H.claimCount };
                if (model === "team" && method === "findUnique") return H.team;
                if (method === "findFirst" || method === "findUnique")
                  return null;
                if (method === "findMany") return [];
                if (method === "updateMany") return { count: 1 };
                if (method === "create" || method === "upsert")
                  return { id: "row-1" };
                return {};
              };
            },
          },
        );
      },
    },
  );
}

vi.mock("../src/db.js", () => {
  const base = makeTx();
  return {
    prisma: new Proxy(base as object, {
      get(t, prop: string) {
        if (prop === "$transaction") {
          return async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx());
        }
        return (t as Record<string, unknown>)[prop];
      },
    }),
  };
});

vi.mock("../src/services/enterprise-provisioning.service.js", () => ({
  completeEnterpriseProvisioningOnOwnerAccept: async () => null,
}));

import { acceptOrganizationInvite } from "../src/services/organization/org-invite-acceptance.service.js";

const FRESH_INVITE = {
  id: "inv-1",
  organizationId: "org-1",
  role: "ORG_MEMBER",
  email: "invitee@acme.com",
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  acceptedByUserId: null,
  revokedAt: null,
  workspaceAssignments: [{ teamId: "11111111-1111-4111-8111-111111111111", role: "MEMBER" }],
};

beforeEach(() => {
  H.calls = [];
  H.userEmail = "invitee@acme.com";
  H.invite = { ...FRESH_INVITE };
  H.claimCount = 1;
  H.orgStatus = "ACTIVE";
  H.winnerAcceptedBy = null;
  H.team = { organizationId: "org-1", isPersonal: false };
});

const writes = () =>
  H.calls.filter((c) =>
    /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(
      c.method,
    ),
  );

describe("Phase 5 §8 — fresh accept (winner path)", () => {
  it("claims BEFORE granting; grants + audit written exactly once", async () => {
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toMatchObject({
      kind: "ok",
      organizationId: "org-1",
      role: "ORG_MEMBER",
      assignedWorkspaceIds: ["11111111-1111-4111-8111-111111111111"],
      idempotentReplay: false,
    });

    const claimIdx = H.calls.findIndex(
      (c) => c.model === "organizationInvite" && c.method === "updateMany",
    );
    const firstGrantIdx = H.calls.findIndex(
      (c) => c.model === "organizationMembership" && c.method === "create",
    );
    expect(claimIdx).toBeGreaterThan(-1);
    expect(firstGrantIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(firstGrantIdx);

    // The claim is guarded on the un-consumed state.
    const claim = H.calls[claimIdx].args[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where).toMatchObject({ id: "inv-1", acceptedAt: null });
    expect(claim.data.acceptedByUserId).toBe("u1");

    const audits = H.calls.filter(
      (c) => c.model === "organizationAuditEvent" && c.method === "create",
    );
    expect(audits.length).toBe(1);
    expect(
      (audits[0].args[0] as { data: { eventType: string } }).data.eventType,
    ).toBe("ORG_MEMBER_ACCEPTED");
  });
});

describe("Phase 5 §8 — idempotent same-user replay", () => {
  it("consumed-by-me invite replays with ZERO writes", async () => {
    H.invite = {
      ...FRESH_INVITE,
      acceptedAt: new Date(),
      acceptedByUserId: "u1",
    };
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toMatchObject({
      kind: "ok",
      organizationId: "org-1",
      assignedWorkspaceIds: ["11111111-1111-4111-8111-111111111111"],
      idempotentReplay: true,
    });
    expect(writes()).toEqual([]);
  });

  it("replay survives post-acceptance expiry (accepted-before-expired ordering)", async () => {
    H.invite = {
      ...FRESH_INVITE,
      acceptedAt: new Date(),
      acceptedByUserId: "u1",
      expiresAt: new Date(Date.now() - 1000),
    };
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toMatchObject({ kind: "ok", idempotentReplay: true });
  });

  it("a DIFFERENT user on a consumed invite is rejected and audited", async () => {
    H.invite = {
      ...FRESH_INVITE,
      acceptedAt: new Date(),
      acceptedByUserId: "someone-else",
    };
    H.userEmail = null; // guest — email check skipped, possession-only
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toEqual({ kind: "already_accepted" });
    const audits = H.calls.filter(
      (c) => c.model === "organizationAuditEvent" && c.method === "create",
    );
    expect(
      (audits[0].args[0] as { data: { metadata: { reason: string } } }).data
        .metadata.reason,
    ).toBe("already_accepted");
  });
});

describe("Phase 5 §8 — concurrent-accept race", () => {
  it("race loser (same user won elsewhere) lands on the replay path, never double-grants", async () => {
    H.claimCount = 0;
    H.winnerAcceptedBy = "u1";
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toMatchObject({ kind: "ok", idempotentReplay: true });
    // No grant writes on the loser path — only the failed claim.
    expect(
      H.calls.some(
        (c) =>
          (c.model === "organizationMembership" ||
            c.model === "teamMember" ||
            c.model === "membershipGrant") &&
          c.method !== "findFirst" &&
          c.method !== "findUnique",
      ),
    ).toBe(false);
  });

  it("race loser (different user won) → already_accepted", async () => {
    H.claimCount = 0;
    H.winnerAcceptedBy = "someone-else";
    const result = await acceptOrganizationInvite({
      tokenHash: "hash-1",
      userId: "u1",
    });
    expect(result).toEqual({ kind: "already_accepted" });
  });
});

describe("Phase 5 §8 — unchanged rejection matrix", () => {
  it("not_found / revoked / expired / email_mismatch", async () => {
    H.invite = null;
    expect(
      await acceptOrganizationInvite({ tokenHash: "h", userId: "u1" }),
    ).toEqual({ kind: "not_found" });

    H.invite = { ...FRESH_INVITE, revokedAt: new Date() };
    expect(
      await acceptOrganizationInvite({ tokenHash: "h", userId: "u1" }),
    ).toEqual({ kind: "revoked" });

    H.invite = { ...FRESH_INVITE, expiresAt: new Date(Date.now() - 1000) };
    expect(
      await acceptOrganizationInvite({ tokenHash: "h", userId: "u1" }),
    ).toEqual({ kind: "expired" });

    H.invite = { ...FRESH_INVITE };
    H.userEmail = "other@acme.com";
    expect(
      await acceptOrganizationInvite({ tokenHash: "h", userId: "u1" }),
    ).toEqual({ kind: "email_mismatch" });
    // Email mismatch never attempts the claim.
    expect(
      H.calls.some(
        (c) => c.model === "organizationInvite" && c.method === "updateMany",
      ),
    ).toBe(false);
  });

  it("§8.1 archived/suspended target org denies acceptance with zero writes", async () => {
    for (const status of ["SUSPENDED", "ARCHIVED"]) {
      H.calls = [];
      H.invite = { ...FRESH_INVITE };
      H.orgStatus = status;
      expect(
        await acceptOrganizationInvite({ tokenHash: "h", userId: "u1" }),
      ).toEqual({ kind: "org_unavailable" });
      expect(writes()).toEqual([]);
    }
  });
});

describe("Phase 5 §8 — route + web token-preservation source contracts", () => {
  const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const WEB = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "apps",
    "web",
  );

  it("route delegates to the canonical service and surfaces idempotentReplay", () => {
    const src = readFileSync(
      join(API_SRC, "routes", "organizations.routes.ts"),
      "utf8",
    );
    expect(src).toContain("acceptOrganizationInvite({");
    expect(src).toContain("tokenHash: hashInviteToken(token)");
    expect(src).toContain("idempotentReplay");
    // The accept transaction body no longer lives in the route.
    expect(src).not.toContain('data: { acceptedAt: new Date(), acceptedByUserId: userId }');
  });

  it("org-invite accept page preserves the token through /login?next=", () => {
    const src = readFileSync(
      join(WEB, "app", "(app)", "org-invites", "[token]", "accept", "page.tsx"),
      "utf8",
    );
    expect(src).toContain("/login?next=");
    expect(src).toContain("/org-invites/${encodeURIComponent(token)}/accept");
  });

  it("collaboration invite accept page uses /login (there is NO /signin route)", () => {
    const src = readFileSync(
      join(
        WEB,
        "app",
        "(app)",
        "collaboration-teams",
        "invites",
        "[token]",
        "accept",
        "page.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("/login?next=");
    expect(src).not.toContain("/signin?next=");
  });

  it("login honours next/returnUrl and hands it to the OAuth callback", () => {
    const login = readFileSync(join(WEB, "app", "login", "page.tsx"), "utf8");
    expect(login).toContain('searchParams.get("next")');
    expect(login).toContain("proovra-return-url");
    const callback = readFileSync(
      join(WEB, "app", "auth", "callback", "ui", "page.tsx"),
      "utf8",
    );
    expect(callback).toContain('sessionStorage.getItem("proovra-return-url")');
  });
});
