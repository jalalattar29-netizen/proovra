/**
 * Phase 2 — Enterprise activation & provisioning keystone.
 *
 * Locks WORKSTREAM A:
 *
 *   1. grantEnterprisePlanToOrg flips EVERY workspace (Team) of an org to
 *      ENTERPRISE with the resolved seat count, ACTIVE billing status, and
 *      a recomputed overSeatLimit; writes an org + platform audit row.
 *   2. provisionEnterpriseCustomer (existing owner) creates an Organization,
 *      an ENTERPRISE workspace owned by the user, an ORG_OWNER membership,
 *      and sets org.billingOwnerUserId.
 *   3. provisionEnterpriseCustomer (missing owner) creates an Organization
 *      and a canonical ORG_OWNER invite (hashed token, 7-day expiry, no
 *      workspace) and returns the raw token once.
 *   4. The admin routes are gated by requirePlatformAdmin — a non-admin
 *      gets 403 and never reaches provisioning.
 *   5. Audit rows are written for every mutation.
 *   6. getPlanCapabilities("ENTERPRISE").enterpriseFeatures.ssoScim === true
 *      (setting billingPlan=ENTERPRISE auto-unlocks enterprise features).
 *   7. The line-59 platform-context defect is fixed additively
 *      (ENTERPRISE_PLAN_KEYS contains both TEAM and ENTERPRISE).
 *
 * House style: mocked audit modules + an injectable in-memory prisma
 * double + a source-contract scan. No live database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";

import {
  asPrismaDouble,
  rec,
  str,
  type DelegateArgs,
  type JsonRecord,
} from "./support/prisma-double.js";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT imports.
// ---------------------------------------------------------------------------

const { emitOrgAuditEventMock, appendPlatformAuditLogMock, sendEmailMock } =
  vi.hoisted(() => ({
    emitOrgAuditEventMock: vi.fn(async () => undefined),
    appendPlatformAuditLogMock: vi.fn(async () => undefined),
    // Macro-Wave A2 — email TRANSPORT mock (the delivery chain writers stay
    // real). Default: provider accepts the send.
    sendEmailMock: vi.fn<
      (input: { to: string; subject: string; html: string; text: string }) => Promise<
        | { ok: true; providerMessageId: string }
        | { ok: false; errorCode: string; errorMessage: string }
      >
    >(async () => ({ ok: true as const, providerMessageId: "msg-1" })),
  }));
vi.mock("../src/services/organization/org-audit.service.js", () => ({
  emitOrgAuditEvent: emitOrgAuditEventMock,
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));
// Macro-Wave A2 — mock ONLY the email transport module (render helpers are
// trivially faked; the durable outbox + rotation writers under proof are
// the REAL org-invite-delivery.service implementation).
vi.mock("../src/services/email.service.js", () => ({
  sendCustomEmailViaResend: sendEmailMock,
  deterministicEmailKey: (templateKey: string, ...parts: string[]) =>
    [templateKey, ...parts].join(":"),
  renderEmailShell: (input: { bodyHtml: string }) => `<html>${input.bodyHtml}</html>`,
  escapeEmailHtml: (s: string) => s,
  getEmailBrandName: () => "PROOVRA",
  getEmailFromHeader: () => "PROOVRA <no-reply@proovra.test>",
  getEmailWebBaseUrl: () => "https://app.proovra.test",
}));

// The service only needs `prisma` for its default client — every test
// injects an explicit client, so this stub is never actually used.
vi.mock("../src/db.js", () => ({ prisma: {} }));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import {
  EnterpriseProvisioningError,
  grantEnterprisePlanToOrg,
  provisionEnterpriseCustomer,
} from "../src/services/enterprise-provisioning.service.js";
import { getPlanCapabilities } from "../src/services/plan-catalog.service.js";

// ---------------------------------------------------------------------------
// In-memory prisma double.
// ---------------------------------------------------------------------------

type Team = {
  id: string;
  organizationId: string | null;
  ownerUserId: string;
  billingOwnerUserId: string | null;
  name: string;
  billingPlan: string;
  billingStatus: string;
  includedSeats: number;
  overSeatLimit: boolean;
  memberCount: number;
};

type Org = {
  id: string;
  name: string;
  status: string;
  billingOwnerUserId: string | null;
  pendingEnterpriseSeats: number | null;
};

/**
 * The NotificationDelivery columns the durable-outbox runtime writes and reads
 * back. Declared explicitly (rather than an index signature of any) so a column
 * the delivery service starts reading cannot silently resolve to undefined.
 */
type DeliveryRow = {
  id: string;
  status: string;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  nextAttemptAtUtc: Date | null;
  metadata: JsonRecord | null;
} & JsonRecord;

function makeClient(seed: {
  orgs?: (Omit<Org, "pendingEnterpriseSeats"> & {
    pendingEnterpriseSeats?: number | null;
  })[];
  teams?: Team[];
  users?: { id: string; email: string }[];
}) {
  const orgs = new Map<string, Org>(
    (seed.orgs ?? []).map((o) => [
      o.id,
      { ...o, pendingEnterpriseSeats: o.pendingEnterpriseSeats ?? null },
    ]),
  );
  const teams = new Map<string, Team>((seed.teams ?? []).map((t) => [t.id, t]));
  const users = seed.users ?? [];
  const memberships: { organizationId: string; userId: string; role: string }[] =
    [];
  const invites: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    token: string | null;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: Date;
  }[] = [];
  // Macro-Wave A2 — durable delivery outbox rows (NotificationDelivery).
  const deliveries: DeliveryRow[] = [];

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const tx = {
    organization: {
      findUnique: vi.fn(async ({ where }: DelegateArgs) => orgs.get(String(rec(where).id)) ?? null),
      // (P1 domain remediation 2026-07-21) — grantEnterprisePlanToOrg now
      // also promotes the org to kind: "CUSTOMER"; the fake supports the
      // update so the existing behavioral assertions keep running.
      update: vi.fn(async ({ where, data }: DelegateArgs) => {
        const org = orgs.get(String(rec(where).id));
        if (org) Object.assign(org, rec(data));
        return org ?? {};
      }),
      create: vi.fn(async ({ data }: DelegateArgs) => {
        const d = rec(data);
        const org: Org = {
          id: nextId("org"),
          name: String(d.name),
          status: String(d.status),
          billingOwnerUserId: str(d.billingOwnerUserId),
          pendingEnterpriseSeats: typeof d.pendingEnterpriseSeats === "number" ? d.pendingEnterpriseSeats : null,
        };
        orgs.set(org.id, org);
        return { id: org.id };
      }),
    },
    team: {
      findMany: vi.fn(async ({ where }: DelegateArgs) => {
        const rows = [...teams.values()].filter(
          (t) => t.organizationId === str(rec(where).organizationId),
        );
        return rows.map((t) => ({
          id: t.id,
          _count: { members: t.memberCount },
        }));
      }),
      update: vi.fn(async ({ where, data }: DelegateArgs) => {
        const t = teams.get(String(rec(where).id))!;
        Object.assign(t, rec(data));
        return t;
      }),
      create: vi.fn(async ({ data }: DelegateArgs) => {
        const d = rec(data);
        const t: Team = {
          id: nextId("team"),
          organizationId: str(d.organizationId),
          ownerUserId: String(d.ownerUserId),
          billingOwnerUserId: str(d.billingOwnerUserId),
          name: String(d.name),
          billingPlan: String(d.billingPlan),
          billingStatus: String(d.billingStatus),
          includedSeats: Number(d.includedSeats),
          overSeatLimit: d.overSeatLimit === true,
          memberCount: rec(d.members).create ? 1 : 0,
        };
        teams.set(t.id, t);
        return { id: t.id };
      }),
    },
    organizationMembership: {
      // PHASE 3: the canonical orchestrator checks for an existing
      // membership before creating (idempotent grant).
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: DelegateArgs) => {
        const d = rec(data);
        memberships.push({
          organizationId: String(d.organizationId),
          userId: String(d.userId),
          role: String(d.role),
        });
        return { id: nextId("mem") };
      }),
    },
    organizationInvite: {
      create: vi.fn(async ({ data }: DelegateArgs) => {
        const d = rec(data);
        const invite = {
          id: nextId("inv"),
          organizationId: String(d.organizationId),
          email: String(d.email),
          role: String(d.role),
          token: str(d.token),
          tokenHash: String(d.tokenHash),
          invitedByUserId: String(d.invitedByUserId),
          expiresAt: d.expiresAt instanceof Date ? d.expiresAt : new Date(String(d.expiresAt)),
        };
        invites.push(invite);
        return { id: invite.id };
      }),
      // PHASE 12 POINT 5 — the delivery producer now reads the invite it is
      // creating an intent for, inside the same transaction, so the intent can
      // carry a bounded CONTENT FINGERPRINT over (inviteId, tokenHash,
      // expiry). That is what lets a rotation be recognised as new content and
      // given its own provider idempotency key instead of reusing the old one.
      findUnique: vi.fn(async ({ where }: DelegateArgs & { where?: JsonRecord }) => {
        const id = String(rec(where).id ?? "");
        const found = invites.find((i) => i.id === id);
        return found
          ? { tokenHash: found.tokenHash, expiresAt: found.expiresAt }
          : null;
      }),
    },
    // PHASE 10 §Step-1 — CUSTOMER-org creators now provision the baseline
    // OrganizationSecurityPolicy (org-keyed, idempotent) and the enterprise
    // contract transactionally. The fake supports both so provisioning runs.
    organizationSecurityPolicy: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: DelegateArgs) => ({ id: nextId("osp"), ...rec(data) })),
    },
    enterpriseContract: {
      upsert: vi.fn(async ({ create }: DelegateArgs & { create?: JsonRecord }) => ({ id: nextId("ec"), ...rec(create) })),
    },
    // Macro-Wave A2 — durable invite-delivery outbox rows. The delivery
    // service creates the row in the SAME tx as the invite and the inline
    // first attempt reads/updates it after commit.
    notificationDelivery: {
      create: vi.fn(async ({ data }: DelegateArgs) => {
        const row: DeliveryRow = {
          id: nextId("del"),
          status: "PENDING",
          retryCount: 0,
          errorCode: null,
          errorMessage: null,
          providerMessageId: null,
          sentAtUtc: null,
          failedAtUtc: null,
          nextAttemptAtUtc: null,
          metadata: null,
          ...rec(data),
        };
        deliveries.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async ({ where }: DelegateArgs) =>
        deliveries.find((d) => d.id === str(rec(where).id)) ?? null,
      ),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: DelegateArgs) => {
        const row = deliveries.find((d) => d.id === str(rec(where).id));
        if (!row) throw new Error("delivery_not_found");
        Object.assign(row, rec(data));
        return { ...row };
      }),
    },
  };

  const client = asPrismaDouble<PrismaClient>({
    ...tx,
    user: {
      findFirst: vi.fn(async ({ where }: DelegateArgs) => {
        const u = users.find((x) => x.email === str(rec(where).email));
        return u ? { id: u.id } : null;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  });

  return { client, orgs, teams, memberships, invites, deliveries };
}

beforeEach(() => {
  emitOrgAuditEventMock.mockClear();
  appendPlatformAuditLogMock.mockClear();
  sendEmailMock.mockClear();
  sendEmailMock.mockImplementation(async () => ({
    ok: true as const,
    providerMessageId: "msg-1",
  }));
});

// ---------------------------------------------------------------------------
// grantEnterprisePlanToOrg
// ---------------------------------------------------------------------------

describe("grantEnterprisePlanToOrg", () => {
  it("flips every workspace to ENTERPRISE, applies seats + ACTIVE, recomputes overSeatLimit", async () => {
    const { client, teams } = makeClient({
      orgs: [{ id: "org-a", name: "Acme", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [
        {
          id: "t1",
          organizationId: "org-a",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS1",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 3,
        },
        {
          id: "t2",
          organizationId: "org-a",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS2",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 10,
        },
      ],
    });

    const res = await grantEnterprisePlanToOrg(
      { orgId: "org-a", plan: "ENTERPRISE", seats: 5, actorUserId: "admin-1" },
      client,
    );

    expect(res).toEqual({
      organizationId: "org-a",
      plan: "ENTERPRISE",
      seats: 5,
      workspacesUpdated: 2,
    });

    for (const t of teams.values()) {
      expect(t.billingPlan).toBe("ENTERPRISE");
      expect(t.billingStatus).toBe("ACTIVE");
      expect(t.includedSeats).toBe(5);
    }
    // t1 has 3 members (<=5 → within limit); t2 has 10 (>5 → over limit).
    expect(teams.get("t1")!.overSeatLimit).toBe(false);
    expect(teams.get("t2")!.overSeatLimit).toBe(true);
  });

  it("defaults seats to the plan catalog includedSeats when omitted", async () => {
    const { client, teams } = makeClient({
      orgs: [{ id: "org-b", name: "B", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [
        {
          id: "t1",
          organizationId: "org-b",
          ownerUserId: "u1",
          billingOwnerUserId: "u1",
          name: "WS",
          billingPlan: "FREE",
          billingStatus: "INACTIVE",
          includedSeats: 0,
          overSeatLimit: false,
          memberCount: 1,
        },
      ],
    });

    const res = await grantEnterprisePlanToOrg(
      { orgId: "org-b", actorUserId: "admin-1" },
      client,
    );

    const expectedSeats = getPlanCapabilities("ENTERPRISE").includedSeats;
    expect(res.seats).toBe(expectedSeats);
    expect(teams.get("t1")!.includedSeats).toBe(expectedSeats);
  });

  it("writes an org audit row AND a platform audit row", async () => {
    const { client } = makeClient({
      orgs: [{ id: "org-c", name: "C", status: "ACTIVE", billingOwnerUserId: null }],
      teams: [],
    });

    await grantEnterprisePlanToOrg(
      { orgId: "org-c", plan: "ENTERPRISE", seats: 5, actorUserId: "admin-1" },
      client,
    );

    expect(emitOrgAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-c",
        eventType: "ORG_PLAN_GRANTED",
        actorUserId: "admin-1",
      }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORG_PLAN_GRANTED",
        userId: "admin-1",
        resourceId: "org-c",
      }),
    );
  });

  it("throws ORG_NOT_FOUND for an unknown org", async () => {
    const { client } = makeClient({ orgs: [], teams: [] });
    await expect(
      grantEnterprisePlanToOrg(
        { orgId: "missing", plan: "ENTERPRISE", actorUserId: "admin-1" },
        client,
      ),
    ).rejects.toBeInstanceOf(EnterpriseProvisioningError);
    // No audit rows when the org does not exist.
    expect(appendPlatformAuditLogMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// provisionEnterpriseCustomer — existing owner
// ---------------------------------------------------------------------------

describe("provisionEnterpriseCustomer — existing owner", () => {
  it("creates an org, an ENTERPRISE workspace owned by the user, and an ORG_OWNER membership", async () => {
    const { client, orgs, teams, memberships } = makeClient({
      users: [{ id: "user-9", email: "owner@acme.test" }],
    });

    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Acme Inc",
        ownerEmail: "owner@acme.test",
        seats: 25,
        actorUserId: "admin-1",
      },
      client,
    );

    expect(res).toMatchObject({
      provisioned: true,
      ownerUserId: "user-9",
    });
    if (!res.provisioned) throw new Error("expected provisioned");

    const org = orgs.get(res.organizationId)!;
    expect(org.billingOwnerUserId).toBe("user-9");

    const ws = teams.get(res.workspaceId)!;
    expect(ws.ownerUserId).toBe("user-9");
    expect(ws.billingPlan).toBe("ENTERPRISE");
    expect(ws.billingStatus).toBe("ACTIVE");
    expect(ws.includedSeats).toBe(25);

    expect(memberships).toContainEqual(
      expect.objectContaining({ userId: "user-9", role: "ORG_OWNER" }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTERPRISE_PROVISIONED" }),
    );
  });

  it("uses workspaceName when supplied, else the org name", async () => {
    const { client, teams } = makeClient({
      users: [{ id: "user-9", email: "owner@acme.test" }],
    });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Acme Inc",
        ownerEmail: "owner@acme.test",
        workspaceName: "Acme HQ",
        actorUserId: "admin-1",
      },
      client,
    );
    if (!res.provisioned) throw new Error("expected provisioned");
    expect(teams.get(res.workspaceId)!.name).toBe("Acme HQ");
  });
});

// ---------------------------------------------------------------------------
// provisionEnterpriseCustomer — missing owner
// ---------------------------------------------------------------------------

describe("provisionEnterpriseCustomer — missing owner", () => {
  it("creates an org + ORG_OWNER invite (hashed token, no workspace) and returns the raw token once", async () => {
    const { client, orgs, teams, invites } = makeClient({ users: [] });

    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );

    expect(res).toMatchObject({ provisioned: false, pendingOwner: true });
    if (res.provisioned) throw new Error("expected pending owner");

    // Raw token returned once; invite URL points at the CANONICAL org-invite
    // accept route (the exact path delivery emails contain and the web app
    // serves at app/(app)/org-invites/[token]/accept). The old `/invite/…`
    // path belonged to the TEAM invite journey and could never accept an
    // OrganizationInvite.
    expect(res.ownerInviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.inviteUrl).toBe(`/org-invites/${res.ownerInviteToken}/accept`);

    // No workspace created (Team.ownerUserId is required).
    expect(teams.size).toBe(0);

    const org = orgs.get(res.organizationId)!;
    expect(org.billingOwnerUserId).toBeNull();

    // Phase 2 Blocker 1 — the brand-new-owner branch persists the resolved
    // enterprise seats on the org so the ORG_OWNER accept can complete
    // provisioning. Default seats = plan-catalog ENTERPRISE includedSeats.
    expect(org.pendingEnterpriseSeats).toBe(
      getPlanCapabilities("ENTERPRISE").includedSeats,
    );

    expect(invites).toHaveLength(1);
    const invite = invites[0]!;
    expect(invite.email).toBe("new-owner@beta.test");
    expect(invite.role).toBe("ORG_OWNER");
    // Raw token is never persisted — only the SHA-256 hash.
    expect(invite.token).toBeNull();
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.tokenHash).not.toBe(res.ownerInviteToken);
    // ~7-day expiry.
    const days = (invite.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("persists the explicit provisioned seat count as pendingEnterpriseSeats", async () => {
    const { client, orgs } = makeClient({ users: [] });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Gamma Co",
        ownerEmail: "new-owner@gamma.test",
        seats: 42,
        actorUserId: "admin-1",
      },
      client,
    );
    if (res.provisioned) throw new Error("expected pending owner");
    expect(orgs.get(res.organizationId)!.pendingEnterpriseSeats).toBe(42);
  });

  it("audits an ENTERPRISE_PROVISIONED event for the pending-owner path", async () => {
    const { client } = makeClient({ users: [] });
    await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );
    expect(emitOrgAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "ENTERPRISE_PROVISIONED" }),
    );
    expect(appendPlatformAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ENTERPRISE_PROVISIONED",
        metadata: expect.objectContaining({ provisioned: false }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Macro-Wave A2 — durable owner-invite delivery chain.
  // -------------------------------------------------------------------------

  it("commits a durable PENDING delivery outbox row WITH the invite and sends the email inline (SENT); zero raw-token leakage into durable rows or audit", async () => {
    const { client, invites, deliveries } = makeClient({ users: [] });

    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );
    if (res.provisioned) throw new Error("expected pending owner");

    // One outbox row, created against the SAME tx as the invite, bound to
    // the invite by id — metadata carries ONLY safe ids.
    expect(deliveries).toHaveLength(1);
    const row = deliveries[0]!;
    expect(row.eventType).toBe("org_invite_delivery");
    expect(row.recipient).toBe("new-owner@beta.test");
    expect(row.metadata).toMatchObject({
      inviteId: invites[0]!.id,
      organizationId: res.organizationId,
    });
    // POINT 5 — safe ids, the minted provider idempotency key, and the
    // bounded content identity, and NOTHING ELSE. The guarantee this protects
    // is that no token and no accept URL is in the row, which an exact key set
    // asserts directly.
    //
    // `contentVersion` + `contentFingerprint` arrived with the rotation
    // contract: a rotation is new content and must get a new intent under a
    // new key, so the intent has to record WHICH content it is for. The
    // fingerprint is a digest over the STORED HASH, never the token — the
    // assertion below states that as a value check rather than leaving it to
    // the key name.
    expect(Object.keys(row.metadata as object).sort()).toEqual([
      "contentFingerprint",
      "contentVersion",
      "idempotencyKey",
      "inviteId",
      "organizationId",
    ]);
    const md = row.metadata as Record<string, unknown>;
    expect(md.contentVersion).toBe(1);
    expect(md.contentFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(md.contentFingerprint).not.toBe(invites[0]!.tokenHash);

    // Inline first attempt succeeded → SENT, one provider call, and the
    // accept URL handed to the transport contains the raw token (in memory
    // only) at the canonical accept path.
    expect(row.status).toBe("SENT");
    expect(row.retryCount).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArg = sendEmailMock.mock.calls[0]![0] as { to: string; text: string };
    expect(emailArg.to).toBe("new-owner@beta.test");
    expect(emailArg.text).toContain(
      `/org-invites/${res.ownerInviteToken}/accept`,
    );
    expect(res.ownerInviteDelivery).toMatchObject({
      status: "SENT",
      attempts: 1,
    });

    // ZERO raw-token leakage: the raw token appears in NO durable delivery
    // row and NO audit metadata (org audit + platform audit).
    const rawToken = res.ownerInviteToken;
    expect(JSON.stringify(deliveries)).not.toContain(rawToken);
    expect(JSON.stringify(emitOrgAuditEventMock.mock.calls)).not.toContain(
      rawToken,
    );
    expect(JSON.stringify(appendPlatformAuditLogMock.mock.calls)).not.toContain(
      rawToken,
    );
  });

  it("a transient send failure leaves the row PENDING (observable, scheduled for the rotation sweep) — the invite itself still commits", async () => {
    sendEmailMock.mockImplementation(async () => ({
      ok: false as const,
      errorCode: "rate_limit",
      errorMessage: "429 too many requests",
    }));
    const { client, invites, deliveries } = makeClient({ users: [] });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );
    if (res.provisioned) throw new Error("expected pending owner");

    expect(invites).toHaveLength(1);
    const row = deliveries[0]!;
    expect(row.status).toBe("PENDING");
    expect(row.retryCount).toBe(1);
    expect(row.errorCode).toBe("rate_limit");
    expect(row.nextAttemptAtUtc).toBeInstanceOf(Date);
    expect(res.ownerInviteDelivery).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
    expect(res.ownerInviteDelivery!.lastError).toContain("rate_limit");
  });

  it("a structural send failure (provider not configured) is an honest observable FAILED — never a silent success", async () => {
    sendEmailMock.mockImplementation(async () => ({
      ok: false as const,
      errorCode: "not_configured",
      errorMessage: "RESEND_API_KEY missing",
    }));
    const { client, deliveries } = makeClient({ users: [] });
    const res = await provisionEnterpriseCustomer(
      {
        organizationName: "Beta LLC",
        ownerEmail: "new-owner@beta.test",
        actorUserId: "admin-1",
      },
      client,
    );
    if (res.provisioned) throw new Error("expected pending owner");
    expect(deliveries[0]!.status).toBe("FAILED");
    expect(res.ownerInviteDelivery).toMatchObject({ status: "FAILED" });
  });

  it("SOURCE — the idempotency snapshot redacts BOTH one-time secrets (ownerInviteToken AND the token-embedding inviteUrl)", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../src/services/enterprise-provisioning.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/delete rest\.ownerInviteToken;/);
    expect(src).toMatch(/delete rest\.inviteUrl;/);
    expect(src).toMatch(/ownerInviteToken: null,\s*\r?\n\s*inviteUrl: null/);
  });
});

// ---------------------------------------------------------------------------
// Enterprise features + platform-context defect fix (source-contract).
// ---------------------------------------------------------------------------

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("enterprise capability + gate wiring", () => {
  it("getPlanCapabilities('ENTERPRISE').enterpriseFeatures.ssoScim === true", () => {
    expect(getPlanCapabilities("ENTERPRISE").enterpriseFeatures.ssoScim).toBe(
      true,
    );
  });

  it("the enterprise plan key set is ENTERPRISE-only (TEAM is NOT enterprise — locked model)", () => {
    // PHASE 0 (2026-08-22) — same invariant, new home. The plan-key set
    // moved from platform-context.service.ts into the canonical enterprise
    // authority, where it is now only the bounded LEGACY fallback for an
    // ORGANIZATION workspace with no EnterpriseContract row.
    const src = readSource(
      "../src/services/platform-context/enterprise-authority.ts",
    );
    const match = src.match(
      /LEGACY_ENTERPRISE_PLAN_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(match).not.toBeNull();
    const body = match![1]!;
    expect(body).toContain('"ENTERPRISE"');
    // Locked model: TEAM is a subscription plan inside a PERSONAL workspace,
    // NOT an enterprise workspace type. It must never be an enterprise key.
    expect(body).not.toContain('"TEAM"');
  });

  it("admin-provisioning routes are gated by requirePlatformAdmin AND step-up on both endpoints", () => {
    const src = readSource("../src/routes/admin-provisioning.routes.ts");
    expect(src).toContain('preHandler: requirePlatformAdmin');
    expect(src).toContain("requireStepUpForSensitiveAction");
    expect(src).toContain('"/v1/admin/orgs/:id/plan"');
    expect(src).toContain('"/v1/admin/enterprise/provision"');
    // One step-up gate per endpoint: plan grant, provision, and the
    // PHASE 4 §7.6 shared suspend/resume handler (one loop body).
    const gateCount = (src.match(/requireStepUpForSensitiveAction\(/g) ?? [])
      .length;
    expect(gateCount).toBe(3);
  });

  it("the new route is registered in server.ts", () => {
    const src = readSource("../src/server.ts");
    expect(src).toContain("adminProvisioningRoutes");
    expect(src).toContain("await app.register(adminProvisioningRoutes)");
  });
});

// ---------------------------------------------------------------------------
// Route gate — non-platform-admin is rejected before provisioning runs.
// ---------------------------------------------------------------------------

describe("admin-provisioning route gate", () => {
  it("requirePlatformAdmin replies 403 for a non-admin caller", async () => {
    vi.resetModules();

    // requireAuth: succeed and stamp a user, without touching JWT/session.
    vi.doMock("../src/middleware/auth.js", () => ({
      // Stamp the SAME session shape production stamps — `provider` is
      // required, and the previous `any` hid that this double omitted it.
      requireAuth: vi.fn(async (req: FastifyRequest) => {
        req.user = { sub: "not-an-admin", provider: "EMAIL" };
      }),
    }));
    // isPlatformAdmin: deny.
    vi.doMock("../src/services/platform-admin.service.js", () => ({
      isPlatformAdmin: vi.fn(async () => false),
    }));

    const Fastify = (await import("fastify")).default;
    const { adminProvisioningRoutes } = await import(
      "../src/routes/admin-provisioning.routes.js"
    );

    const app = Fastify();
    await app.register(adminProvisioningRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/enterprise/provision",
      payload: {
        teamId: "00000000-0000-4000-8000-000000000000",
        organizationName: "X",
        ownerEmail: "x@x.test",
      },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
    vi.resetModules();
  });
});
