/**
 * PLATFORM ADMIN — DRILL-DOWN AND SEARCH RESOLUTION, live PostgreSQL 16.
 *
 * ADM-010 / ADM-011 / ADM-017 / ADM-018 / ADM-019 / ADM-027 / ADM-028 / ADM-029.
 *
 * THE PROPERTY UNDER TEST
 * ---------------------------------------------------------------------------
 * Every aggregate the console shows must lead to the records it is over, and
 * every link it emits must resolve to a surface that honours the identity in
 * the link. Those are two different failures and both were present: counts with
 * no roster behind them, and rosters that ignored the parameter they were sent.
 *
 * A `?search=` deep link that lands on an unfiltered page 1 is not a working
 * link — it is a link that looks like it worked. So the search assertions here
 * do not stop at "the href is well-formed"; they follow it and assert the
 * destination returns the intended record.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  bootstrapPersonalSpace,
  seedOrganizationTenant,
  seedOwnedWorkspace,
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

describe("PLATFORM ADMIN — drill-down and search (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let admin: SeededUser;

  let proUser: SeededUser;
  let workspaceId: string;
  let customerOrgId: string;
  let tsaFailedEvidenceId: string;
  let healthyEvidenceId: string;
  let incidentId: string;

  async function get(url: string) {
    const res = await harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    return { statusCode: res.statusCode, json: () => JSON.parse(res.body) };
  }

  async function post(url: string, payload: unknown) {
    const res = await harness.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: payload as Record<string, unknown>,
    });
    return { statusCode: res.statusCode, json: () => JSON.parse(res.body) };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `adm-dd-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          {
            sub: userId,
            provider: "EMAIL",
            email,
            authMethod: "PASSWORD",
            authAt: Math.floor(Date.now() / 1000),
          },
          secret,
          60 * 60,
        ),
    };

    // `seedUser` already registers the session for the token it mints, so the
    // grant is the only thing left to add.
    admin = await seedUser(deps, "dd-admin");
    await prisma.user.update({
      where: { id: admin.userId },
      data: { platformRole: "admin" },
    });

    // A PRO account with a personal space — the population "list PRO users"
    // must be able to name.
    const pro = await seedPersonalTenant(deps, "PRO");
    proUser = pro.owner;
    await prisma.subscription.create({
      data: {
        userId: proUser.userId,
        provider: "STRIPE",
        providerSubId: `dd-pro-${randomUUID()}`,
        status: "ACTIVE",
        plan: "PRO",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });

    const org = await seedOrganizationTenant(deps, { contractStatus: "ACTIVE" });
    customerOrgId = org.organizationId;

    const wsOwner = await seedUser(deps, "dd-ws-owner");
    await bootstrapPersonalSpace(deps, wsOwner.userId);
    const ws = await seedOwnedWorkspace(deps, {
      ownerUserId: wsOwner.userId,
      name: `dd-workspace-${deps.tag}`,
      billingPlan: "TEAM",
      billingStatus: "ACTIVE",
    });
    workspaceId = ws.teamId;

    const evidenceBase = {
      ownerUserId: wsOwner.userId,
      teamId: workspaceId,
      organizationId: ws.organizationId,
      type: "DOCUMENT" as const,
    };
    tsaFailedEvidenceId = (
      await prisma.evidence.create({
        data: {
          ...evidenceBase,
          status: "SIGNED",
          tsaStatus: "FAILED",
          title: `dd-tsa-failed-${randomUUID().slice(0, 8)}`,
        },
        select: { id: true },
      })
    ).id;
    healthyEvidenceId = (
      await prisma.evidence.create({
        data: {
          ...evidenceBase,
          status: "SIGNED",
          tsaStatus: "CONFIRMED",
          title: `dd-healthy-${randomUUID().slice(0, 8)}`,
        },
        select: { id: true },
      })
    ).id;

    incidentId = (
      await prisma.operationalIncident.create({
        data: {
          teamId: workspaceId,
          scope: "WORKSPACE",
          category: "REPORT",
          severity: "HIGH",
          status: "OPEN",
          title: "dd incident",
          safeSummary: "seeded for drill-down proof",
          fingerprint: `dd-${randomUUID()}`,
          firstSeenAtUtc: new Date(),
          lastSeenAtUtc: new Date(),
        },
        select: { id: true },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  // =========================================================================
  // ADM-027 / ADM-028 — the two directories that did not exist.
  // =========================================================================

  describe("ADM-027 — the workspace directory answers 'which workspaces?'", () => {
    it("lists the workspace with its kind, lifecycle, owner and seat count", async () => {
      const res = await get(`/v1/admin/workspaces?search=dd-workspace&limit=50`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const row = body.items.find((i: { id: string }) => i.id === workspaceId);
      expect(row, "the seeded workspace must be findable").toBeTruthy();
      expect(row.kind).toBe("OWNED");
      expect(row.lifecycle).toBe("LIVE");
      expect(row.owner?.email).toBeTruthy();
      expect(typeof row.seatsUsed).toBe("number");
    });

    it("workspace detail resolves the CANONICAL commercial context", async () => {
      const res = await get(`/v1/admin/workspaces/${workspaceId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The composed verdict, not a re-derivation of Team.billingPlan.
      expect(body.commercial, body.commercialUnavailableReason ?? "").toBeTruthy();
      expect(typeof body.commercial.plan).toBe("string");
      expect(body.commercial.seats).toMatchObject({
        consumed: expect.any(Number),
        limit: expect.any(Number),
      });
      // The stored projection is shown ALONGSIDE, never instead.
      expect(body.raw.billingPlan).toBe("TEAM");
    });

    it("never exposes a full provider subscription reference", async () => {
      const sub = await prisma.subscription.create({
        data: {
          userId: proUser.userId,
          teamId: workspaceId,
          provider: "STRIPE",
          providerSubId: `dd-secret-ref-${randomUUID()}`,
          status: "ACTIVE",
          plan: "TEAM",
        },
        select: { providerSubId: true },
      });
      const res = await get(`/v1/admin/workspaces/${workspaceId}`);
      expect(res.statusCode).toBe(200);
      const raw = JSON.stringify(res.json());
      expect(raw).not.toContain(sub.providerSubId);
      expect(raw).toContain("…");
    });

    it("filters by lifecycle, kind and customer", async () => {
      const closed = await get(`/v1/admin/workspaces?lifecycle=CLOSED&limit=100`);
      expect(closed.statusCode).toBe(200);
      for (const row of closed.json().items) {
        expect(row.lifecycle).toBe("CLOSED");
      }

      const personal = await get(
        `/v1/admin/workspaces?kind=PERSONAL&lifecycle=LIVE&limit=100`,
      );
      for (const row of personal.json().items) {
        expect(row.kind).toBe("PERSONAL");
      }
    });
  });

  describe("ADM-028 — PRO customers can be enumerated by identity", () => {
    it("?tier=PRO returns the PRO account with its email and subscription", async () => {
      const res = await get(`/v1/admin/users?tier=PRO&pageSize=100`);
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .items.find((i: { id: string }) => i.id === proUser.userId);
      expect(row, "a PRO user must be enumerable by tier").toBeTruthy();
      expect(row.email).toBe(proUser.email);
      expect(row.accountTier).toBe("PRO");
      expect(row.hasLiveSubscription).toBe(true);
      expect(
        row.subscriptions.some(
          (s: { plan: string; status: string }) =>
            s.plan === "PRO" && s.status === "ACTIVE",
        ),
      ).toBe(true);
    });

    it("ADM-016 — surfaces pending cancellation rather than plain ACTIVE", async () => {
      const res = await get(`/v1/admin/users?pendingCancellation=true&pageSize=100`);
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .items.find((i: { id: string }) => i.id === proUser.userId);
      expect(row, "a winding-down subscriber must be findable").toBeTruthy();
      // The derived flag must agree with the FILTER that returned this row.
      // An earlier draft picked a single "primary" subscription, so a user with
      // a winding-down PRO subscription AND a live TEAM one could be returned by
      // ?pendingCancellation=true while displaying cancelAtPeriodEnd: false.
      expect(row.pendingCancellation).toBe(true);
      const winding = row.subscriptions.filter(
        (s: { cancelAtPeriodEnd: boolean; status: string }) =>
          s.status === "ACTIVE" && s.cancelAtPeriodEnd,
      );
      expect(winding.length).toBeGreaterThan(0);
      expect(winding[0].currentPeriodEnd).toBeTruthy();
    });

    it("user detail carries the canonical commercial verdict and workspaces", async () => {
      const res = await get(`/v1/admin/users/${proUser.userId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.commercial, body.commercialUnavailableReason ?? "").toBeTruthy();
      expect(body.workspaces.length).toBeGreaterThan(0);
      expect(body.personalWorkspaceId).toBeTruthy();
      expect(body.lifecycleRequests).toBeTruthy();
    });

    it("never returns password or MFA secret material", async () => {
      const res = await get(`/v1/admin/users/${proUser.userId}`);
      const raw = JSON.stringify(res.json());
      for (const forbidden of [
        "passwordHash",
        "password_hash",
        "secretCiphertext",
        "recoveryCode",
        "tokenHash",
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it("ADM-028 — membership states are labelled as memberships, not account status", async () => {
      const res = await get(`/v1/admin/users/${proUser.userId}`);
      const body = res.json();
      expect(body.memberships).toMatchObject({
        active: expect.any(Number),
        suspended: expect.any(Number),
        revoked: expect.any(Number),
      });
      // The misleading account-level claims must be gone entirely.
      expect(body.suspended).toBeUndefined();
      expect(body.deactivated).toBeUndefined();
    });
  });

  // =========================================================================
  // ADM-029 / ADM-019 — evidence drill-down.
  // =========================================================================

  describe("ADM-029 — a failure count reaches its records", () => {
    it("returns exactly the TSA-failed records, with workspace attribution", async () => {
      const res = await get(
        `/v1/admin/evidence-health/records?signal=TSA_FAILED&limit=200`,
      );
      expect(res.statusCode).toBe(200);
      const ids = res.json().items.map((i: { id: string }) => i.id);
      expect(ids).toContain(tsaFailedEvidenceId);
      expect(ids).not.toContain(healthyEvidenceId);

      const row = res
        .json()
        .items.find((i: { id: string }) => i.id === tsaFailedEvidenceId);
      expect(row.workspace?.id).toBe(workspaceId);
      expect(row.ownerEmail).toBeTruthy();
    });

    it("never returns evidence content or cryptographic material", async () => {
      const res = await get(
        `/v1/admin/evidence-health/records?signal=TSA_FAILED&limit=200`,
      );
      const raw = JSON.stringify(res.json());
      for (const forbidden of [
        "storageKey",
        "storageBucket",
        "fileSha256",
        "signatureBase64",
        "fingerprintCanonicalJson",
        "internalNotes",
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    });

    it("the health snapshot publishes a drill-down href for every signal", async () => {
      const res = await get(`/v1/admin/evidence-health`);
      expect(res.statusCode).toBe(200);
      const drill = res.json().drillDown;
      expect(Object.keys(drill).length).toBeGreaterThan(0);
      for (const entry of Object.values(drill) as Array<{ href: string }>) {
        expect(entry.href).toMatch(/^\/admin\/evidence-ops\/records\?signal=/);
      }
    });

    it("refuses an unknown signal rather than returning every record", async () => {
      const res = await get(`/v1/admin/evidence-health/records?signal=NOT_A_SIGNAL`);
      expect(res.statusCode).toBe(400);
    });

    it("refuses a query with neither a signal nor a record id", async () => {
      const res = await get(`/v1/admin/evidence-health/records`);
      expect(res.statusCode).toBe(400);
    });
  });

  // =========================================================================
  // ADM-017 / ADM-018 / ADM-019 — every search href RESOLVES.
  // =========================================================================

  describe("search hrefs resolve to the entity they name", () => {
    /** Map an admin PAGE path to the API route that page loads. */
    function apiFor(href: string): string | null {
      const [path, query] = href.split("?");
      const userDetail = /^\/admin\/users\/([0-9a-f-]{36})$/.exec(path!);
      if (userDetail) return `/v1/admin/users/${userDetail[1]}`;
      const wsDetail = /^\/admin\/workspaces\/([0-9a-f-]{36})$/.exec(path!);
      if (wsDetail) return `/v1/admin/workspaces/${wsDetail[1]}`;
      const custDetail = /^\/admin\/customers\/([0-9a-f-]{36})$/.exec(path!);
      if (custDetail) return `/v1/admin/customers/${custDetail[1]}`;
      if (path === "/admin/evidence-ops/records") {
        return `/v1/admin/evidence-health/records?${query}`;
      }
      return null;
    }

    it("a user hit resolves to that exact user", async () => {
      const res = await get(
        `/v1/admin/search?q=${encodeURIComponent(proUser.email)}&types=user`,
      );
      expect(res.statusCode).toBe(200);
      const hit = res
        .json()
        .groups.find((g: { type: string }) => g.type === "user")?.results?.[0];
      expect(hit, "search must find the seeded user").toBeTruthy();

      const api = apiFor(hit.href);
      expect(api, `unresolvable href: ${hit.href}`).toBeTruthy();
      const followed = await get(api!);
      expect(followed.statusCode).toBe(200);
      expect(followed.json().id).toBe(proUser.userId);
    });

    it("a workspace hit resolves to that exact workspace", async () => {
      const res = await get(
        `/v1/admin/search?q=${encodeURIComponent("dd-workspace")}&types=team`,
      );
      const hit = res
        .json()
        .groups.find((g: { type: string }) => g.type === "team")?.results?.[0];
      expect(hit, "search must find the seeded workspace").toBeTruthy();

      const api = apiFor(hit.href);
      expect(api, `unresolvable href: ${hit.href}`).toBeTruthy();
      const followed = await get(api!);
      expect(followed.statusCode).toBe(200);
      expect(followed.json().id).toBe(hit.id);
    });

    it("an evidence hit KEEPS its id and the destination returns that record", async () => {
      const evidence = await prisma.evidence.findUniqueOrThrow({
        where: { id: tsaFailedEvidenceId },
        select: { title: true },
      });
      const res = await get(
        `/v1/admin/search?q=${encodeURIComponent(evidence.title!)}&types=evidence`,
      );
      const hit = res
        .json()
        .groups.find((g: { type: string }) => g.type === "evidence")?.results?.[0];
      expect(hit, "search must find the seeded evidence").toBeTruthy();
      // The identity must be IN the href — this is the whole finding.
      expect(hit.href).toContain(tsaFailedEvidenceId);

      const followed = await get(apiFor(hit.href)!);
      expect(followed.statusCode).toBe(200);
      const ids = followed.json().items.map((i: { id: string }) => i.id);
      expect(ids).toEqual([tsaFailedEvidenceId]);
    });

    it("emits no inert ?search= deep links", async () => {
      const res = await get(`/v1/admin/search?q=${encodeURIComponent("dd-")}`);
      /*
       * The contract is asserted BEFORE it is walked.
       *
       * This block used to iterate `res.json().groups` directly, so any
       * non-success answer surfaced as "groups is not iterable" — a
       * destructuring error that says nothing about the HTTP problem behind
       * it. A search endpoint that refuses, or drifts its response shape, must
       * fail here as the status and body it actually returned.
       */
      expect(
        res.statusCode,
        `admin search must succeed; body was ${JSON.stringify(res.json()).slice(0, 300)}`,
      ).toBe(200);
      expect(
        Array.isArray(res.json().groups),
        `admin search must return a groups array; got keys ${JSON.stringify(Object.keys(res.json()))}`,
      ).toBe(true);
      for (const group of res.json().groups) {
        for (const result of group.results) {
          expect(
            result.href,
            `${group.type} still emits a roster search link: ${result.href}`,
          ).not.toMatch(/\?search=/);
        }
      }
    });

    it("the users roster HONOURS ?search= when one is supplied", async () => {
      // The other half of ADM-017: the destination must consume the parameter.
      const res = await get(
        `/v1/admin/users?search=${encodeURIComponent(proUser.email)}`,
      );
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: { email: string }) => i.email === proUser.email)).toBe(
        true,
      );
    });

    // CUSTOMER != ORGANIZATION ROW. `seedOwnedWorkspace` creates a SYSTEM
    // organization as the 1:1 bootstrap container behind the workspace, and
    // names it after the workspace. Searching that name must therefore find
    // the WORKSPACE and never an "organization", because the organization
    // result links to `/admin/customers/:id` — a CUSTOMER-scoped surface on
    // which a SYSTEM container id is a 404.
    it("organization search returns CUSTOMERs only, never SYSTEM containers", async () => {
      const res = await get(
        `/v1/admin/search?q=${encodeURIComponent("dd-workspace")}&types=organization`,
      );
      expect(res.statusCode).toBe(200);
      const group = res
        .json()
        .groups.find((g: { type: string }) => g.type === "organization");
      const results = group?.results ?? [];
      expect(
        results,
        "a SYSTEM bootstrap container was presented as a customer",
      ).toHaveLength(0);
    });

    it("organization search still finds a real CUSTOMER, and the href resolves", async () => {
      const customer = await prisma.organization.findUniqueOrThrow({
        where: { id: customerOrgId },
        select: { name: true },
      });
      const res = await get(
        `/v1/admin/search?q=${encodeURIComponent(customer.name)}&types=organization`,
      );
      const group = res
        .json()
        .groups.find((g: { type: string }) => g.type === "organization");
      const hit = (group?.results ?? []).find(
        (r: { id: string }) => r.id === customerOrgId,
      );
      expect(hit, "CUSTOMER search must not have been over-filtered").toBeTruthy();

      // No terminal mystery results: the link an operator clicks must open.
      const followed = await get(hit.href.replace("/admin/", "/v1/admin/"));
      expect(followed.statusCode, `dead search href: ${hit.href}`).toBe(200);
    });
  });

  // =========================================================================
  // ADM-010 / ADM-011 — incident attribution and platform-scope action.
  // =========================================================================

  describe("ADM-010 — incidents carry their tenant", () => {
    it("the platform feed names the affected workspace and customer", async () => {
      const res = await get(`/v1/admin/incidents?limit=500`);
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .items.find((i: { id: string }) => i.id === incidentId);
      expect(row, "the seeded incident must appear").toBeTruthy();
      expect(row.teamId).toBe(workspaceId);
      expect(row.affected?.workspaceId).toBe(workspaceId);
      expect(row.affected?.workspaceName).toBeTruthy();
    });

    it("can be narrowed to one affected tenant", async () => {
      const res = await get(`/v1/admin/incidents?teamId=${workspaceId}&limit=500`);
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: { teamId: string }) => i.teamId === workspaceId)).toBe(
        true,
      );
    });

    it("only names a CUSTOMER organization as the customer", async () => {
      const res = await get(`/v1/admin/incidents?teamId=${workspaceId}&limit=50`);
      const row = res.json().items[0];
      // This workspace hangs off a SYSTEM container, which is not a customer.
      expect(row.affected.customer).toBeNull();
    });
  });

  describe("ADM-011 — a platform admin can act on a cross-tenant incident", () => {
    it("acknowledges an incident it is not a member of", async () => {
      const res = await post(`/v1/admin/incidents/${incidentId}/acknowledge`, {});
      expect(res.statusCode, res.json && JSON.stringify(res.json())).toBe(200);

      const row = await prisma.operationalIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: { status: true, acknowledgedByUserId: true },
      });
      expect(row.status).toBe("ACKNOWLEDGED");
      expect(row.acknowledgedByUserId).toBe(admin.userId);
    });

    it("assigns and unassigns through the same canonical mutator", async () => {
      const assigned = await post(`/v1/admin/incidents/${incidentId}/assign`, {
        assigneeUserId: admin.userId,
      });
      expect(assigned.statusCode).toBe(200);
      expect(
        (
          await prisma.operationalIncident.findUniqueOrThrow({
            where: { id: incidentId },
            select: { assignedOperatorUserId: true },
          })
        ).assignedOperatorUserId,
      ).toBe(admin.userId);

      const unassigned = await post(`/v1/admin/incidents/${incidentId}/assign`, {
        assigneeUserId: null,
      });
      expect(unassigned.statusCode).toBe(200);
      expect(
        (
          await prisma.operationalIncident.findUniqueOrThrow({
            where: { id: incidentId },
            select: { assignedOperatorUserId: true },
          })
        ).assignedOperatorUserId,
      ).toBeNull();
    });

    it("writes a platform audit row for the action", async () => {
      const audits = await prisma.adminAuditLog.count({
        where: {
          action: { in: ["admin.incident_acknowledge", "admin.incident_assign"] },
          resourceId: incidentId,
        },
      });
      expect(audits).toBeGreaterThan(0);
    });

    it("404s on an unknown incident rather than inventing one", async () => {
      const res = await post(`/v1/admin/incidents/${randomUUID()}/resolve`, {
        note: "x",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // ADM-030 — billing attention rows identify who is affected.
  // =========================================================================

  describe("ADM-030 — billing attention rows carry a customer", () => {
    it("pending-cancellation rows name the user behind them", async () => {
      const res = await get(`/v1/admin/billing/detail`);
      expect(res.statusCode).toBe(200);
      const rows = res.json().attention.pendingCancellation;
      expect(rows.length).toBeGreaterThan(0);
      const mine = rows.find(
        (r: { userId: string }) => r.userId === proUser.userId,
      );
      expect(mine, "the winding-down subscriber must be listed").toBeTruthy();
      expect(mine.userEmail).toBe(proUser.email);
      expect(mine.cancelAtPeriodEnd).toBe(true);
    });

    it("reports reconciliation honestly — no fabricated last-run", async () => {
      // ADM-032. There is ONE billing read route; the standalone
      // `/v1/admin/billing/reconciliation` endpoint was removed rather than
      // left as a second, consumer-less authority over the same figures.
      const res = await get(`/v1/admin/billing/detail`);
      expect(res.statusCode).toBe(200);
      const rec = res.json().reconciliation;
      expect(rec.providerAgreement.note).toMatch(/persists no run row/i);
      expect(rec.providerAgreement).toHaveProperty("subscriptionsNeverConfirmed");
    });
  });
});
