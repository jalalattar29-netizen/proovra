/**
 * PRO-072 (UI-01) — an organization invitation states what it grants BEFORE
 * it is accepted (live PostgreSQL, real route, real acceptance service).
 *
 * The acceptance page said "This does NOT grant you access to workspace
 * evidence, cases, or reviewer queues" while accepting wrote the invitation's
 * workspace assignments, up to workspace ADMIN. POST /v1/org-invites/lookup is
 * the read the page now uses. This proves:
 *
 *   - it lists exactly the workspaces and roles acceptance then grants (the
 *     positive control accepts the same invitation and reads the memberships);
 *   - an assignment into another organization's workspace or a personal space
 *     is not listed, because acceptance would not grant it;
 *   - it discloses no ids and masks the address; a spent, revoked or expired
 *     invitation names nothing; an unknown or malformed token is one 404;
 *   - it writes nothing (the invitation stays unclaimed).
 */
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("POST /v1/org-invites/lookup (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let accept: typeof import("../src/services/organization/org-invite-acceptance.service.js")["acceptOrganizationInvite"];

  const tag = randomUUID().slice(0, 8);
  let ownerId = "";
  let orgA = "";
  let orgB = "";
  let wsA = "";
  let wsB = "";
  let personal = "";
  let invitee = "";
  const inviteeEmail = `invitee-${tag}@example.test`;
  const tokens = {
    granting: `tok-grant-${randomUUID()}`,
    governanceOnly: `tok-gov-${randomUUID()}`,
    revoked: `tok-rev-${randomUUID()}`,
    accepted: `tok-acc-${randomUUID()}`,
    expired: `tok-exp-${randomUUID()}`,
    suspendedOrg: `tok-sus-${randomUUID()}`,
  };

  async function invite(token: string, data: Record<string, unknown>) {
    await prisma.organizationInvite.create({
      data: {
        organizationId: orgA,
        email: inviteeEmail,
        role: "ORG_MEMBER",
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: ownerId,
        ...data,
      } as never,
    });
  }

  const lookup = (body: unknown) =>
    h.app.inject({ method: "POST", url: "/v1/org-invites/lookup", payload: body as Record<string, unknown> });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    ({ acceptOrganizationInvite: accept } = await import(
      "../src/services/organization/org-invite-acceptance.service.js"
    ));

    ownerId = randomUUID();
    await prisma.user.create({
      data: { id: ownerId, email: `owner-${tag}@example.test`, provider: "EMAIL", providerUserId: `owner-${ownerId}` },
    });
    invitee = randomUUID();
    await prisma.user.create({
      data: { id: invitee, email: inviteeEmail, provider: "EMAIL", providerUserId: invitee, emailVerifiedAt: new Date() },
    });

    orgA = randomUUID();
    orgB = randomUUID();
    await prisma.organization.create({ data: { id: orgA, name: `Lookup Org A ${tag}`, status: "ACTIVE", kind: "CUSTOMER" } as never });
    await prisma.organization.create({ data: { id: orgB, name: `Lookup Org B ${tag}`, status: "ACTIVE", kind: "CUSTOMER" } as never });

    const team = async (id: string, name: string, organizationId: string, isPersonal: boolean) => {
      await prisma.team.create({
        data: {
          id,
          name,
          ownerUserId: ownerId,
          organizationId,
          isPersonal,
          billingPlan: "ENTERPRISE",
          billingStatus: "ACTIVE",
          workspaceKind: isPersonal ? "PERSONAL" : "ORGANIZATION",
        } as never,
      });
      await prisma.teamMember.create({ data: { teamId: id, userId: ownerId, role: "OWNER", status: "ACTIVE" } });
    };
    wsA = randomUUID();
    wsB = randomUUID();
    personal = randomUUID();
    await team(wsA, `Claims Review ${tag}`, orgA, false);
    await team(wsB, `Other Org Workspace ${tag}`, orgB, false);
    await team(personal, `Personal ${tag}`, orgA, true);
    await prisma.enterpriseContract.create({ data: { organizationId: orgA, status: "ACTIVE", seatCount: 50 } as never });

    await invite(tokens.granting, {
      workspaceAssignments: [
        { teamId: wsA, role: "ADMIN" },
        { teamId: wsB, role: "MEMBER" },
        { teamId: personal, role: "VIEWER" },
      ],
    });
    await invite(tokens.governanceOnly, {});
    await invite(tokens.revoked, { revokedAt: new Date(), workspaceAssignments: [{ teamId: wsA, role: "ADMIN" }] });
    await invite(tokens.accepted, { acceptedAt: new Date(), acceptedByUserId: ownerId });
    await invite(tokens.expired, { expiresAt: new Date(Date.now() - 1000) });
    const suspended = randomUUID();
    await prisma.organization.create({ data: { id: suspended, name: `Suspended ${tag}`, status: "SUSPENDED", kind: "CUSTOMER" } as never });
    await prisma.organizationInvite.create({
      data: {
        organizationId: suspended,
        email: inviteeEmail,
        role: "ORG_MEMBER",
        tokenHash: hash(tokens.suspendedOrg),
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: ownerId,
      } as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("a pending invitation lists its organization role and exactly the grantable workspaces", async () => {
    const res = await lookup({ token: tokens.granting });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as {
      state: string;
      context: { organizationName: string; role: string; invitedEmailMasked: string; workspaces: Array<{ workspaceName: string; role: string }> };
    };
    expect(body.state).toBe("PENDING");
    expect(body.context.organizationName).toBe(`Lookup Org A ${tag}`);
    expect(body.context.role).toBe("ORG_MEMBER");
    expect(body.context.workspaces).toEqual([{ workspaceName: `Claims Review ${tag}`, role: "ADMIN" }]);
    expect(body.context.invitedEmailMasked).not.toBe(inviteeEmail);
    expect(body.context.invitedEmailMasked.endsWith("@example.test")).toBe(true);
    // No ids leave the server.
    const raw = res.body;
    for (const id of [orgA, orgB, wsA, wsB, personal, ownerId, invitee]) expect(raw).not.toContain(id);
    // A read: the invitation is still unclaimed.
    const row = await prisma.organizationInvite.findUniqueOrThrow({ where: { tokenHash: hash(tokens.granting) } });
    expect(row.acceptedAt).toBeNull();
  });

  it("positive control: accepting grants exactly what the lookup listed", async () => {
    const before = await lookup({ token: tokens.granting });
    const listed = (before.json() as { context: { workspaces: Array<{ role: string }> } }).context.workspaces;

    const result = await accept({ tokenHash: hash(tokens.granting), userId: invitee });
    expect(result.kind).toBe("ok");
    const memberships = await prisma.teamMember.findMany({
      where: { userId: invitee, status: "ACTIVE" },
      select: { teamId: true, role: true },
    });
    expect(memberships).toEqual([{ teamId: wsA, role: "ADMIN" }]);
    expect(listed.map((w) => w.role)).toEqual(memberships.map((m) => m.role));

    // Spent now: the lookup no longer names anything.
    const after = await lookup({ token: tokens.granting });
    expect(after.json()).toEqual({ state: "ACCEPTED", context: null });
  });

  it("a governance-only invitation lists no workspaces", async () => {
    const res = await lookup({ token: tokens.governanceOnly });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { context: { workspaces: unknown[] } }).context.workspaces).toEqual([]);
  });

  it("revoked, accepted, expired and a non-ACTIVE organization name nothing", async () => {
    expect((await lookup({ token: tokens.revoked })).json()).toEqual({ state: "REVOKED", context: null });
    expect((await lookup({ token: tokens.accepted })).json()).toEqual({ state: "ACCEPTED", context: null });
    expect((await lookup({ token: tokens.expired })).json()).toEqual({ state: "EXPIRED", context: null });
    expect((await lookup({ token: tokens.suspendedOrg })).json()).toEqual({ state: "NOT_ACCEPTING_MEMBERS", context: null });
  });

  it("an unknown token and a malformed body get the same opaque 404", async () => {
    const unknown = await lookup({ token: `tok-${randomUUID()}` });
    const malformed = await lookup({ nope: true });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    const code = (r: typeof unknown) => (r.json() as { error: { code: string; message: string } }).error;
    expect(code(unknown).code).toBe("INVITE_NOT_FOUND");
    expect(code(malformed).code).toBe(code(unknown).code);
    expect(code(malformed).message).toBe(code(unknown).message);
  });
});
