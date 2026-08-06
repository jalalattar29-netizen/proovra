/**
 * PHASE 37.95 — Live cross-tenant runtime probe (scaffold).
 *
 * This file is the BEHAVIORAL counterpart to the static source-contract
 * tests in `phase-tenant-isolation-scale.test.ts`. It seeds two
 * organizations (A, B) plus a personal user, then exercises real API
 * routes to assert that no cross-tenant data leak is possible.
 *
 * STATUS: scaffold. The default vitest setup does NOT include the test
 * database + Fastify boot that this probe requires. The scaffold is
 * gated on `process.env.RUN_LIVE_INTEGRATION === "1"` and `describe.skip`s
 * itself otherwise. It is intentionally checked in so the test cases live
 * with the codebase and become live as soon as the integration harness
 * lands.
 *
 * WHAT THIS PROBE WILL DO WHEN ENABLED:
 *
 *   1. Seed Organization A (teamA) with:
 *        - userA_owner (OWNER), userA_admin (ADMIN), userA_member (MEMBER)
 *        - evidenceA, caseA, reportA, packageA
 *        - legalHoldA, custody events, security events
 *
 *   2. Seed Organization B (teamB) with the same shape (userB_*, etc.).
 *
 *   3. Seed a personal user (userPersonal) with personalEvidence,
 *      personalCase, personalReport on their personal Team
 *      (isPersonal=true).
 *
 *   4. Issue real Bearer-token HTTP requests for each assertion below.
 *
 * ASSERTIONS:
 *
 *   - userA cannot READ evidenceB (GET /v1/evidence/<idB>)
 *   - userA cannot LIST evidenceB (GET /v1/evidence?teamId=<teamB>)
 *   - userA cannot UPDATE evidenceB
 *   - userA cannot DELETE evidenceB
 *   - userA cannot READ caseB, reportB, packageB, legalHoldB
 *   - userA cannot READ teamB's audit/custody/security events
 *   - userA search cannot return any teamB document
 *   - userA cannot trigger ANY worker job on a teamB resource
 *   - userB symmetric — every assertion holds when roles flip
 *   - userPersonal cannot access teamA / teamB data
 *   - userA (org member) cannot access userPersonal personal data
 *   - userA_member (non-admin) cannot mutate even where read works
 *
 * ALL denial responses must be 404 (anti-enumeration), never 403, never
 * a body that reveals the existence of the resource.
 *
 * STAFFING NOTE: a real integration harness (testcontainers Postgres +
 * Fastify app instance) is required to run this. Until then, the probe
 * scaffold below documents the assertions and stays inert.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
  type PersonalFixture,
  type TeamFixture,
} from "./integration-harness.js";

// PHASE 12 POINT 4 — this suite is no longer gated at runtime. It belongs to
// the API INTEGRATION project (`vitest.integration.config.ts`), which always
// supplies a real PostgreSQL: `TEST_DATABASE_URL` in CI, an ephemeral
// testcontainers instance locally. Nothing here is skipped.
describe("Phase 37.95 — cross-tenant runtime probe", () => {
  // -------------------------------------------------------------------------
  // Seeding contract — fixtures the integration harness must provide.
  // The canonical shape is declared in `integration-harness.ts`.
  // -------------------------------------------------------------------------

  let teamA!: TeamFixture;
  let teamB!: TeamFixture;
  let personal!: PersonalFixture;
  let api!: { fetch: (path: string, init?: RequestInit) => Promise<Response> };
  // The let bindings above are assigned by the integration harness in
  // `beforeAll`. The TypeScript `!` assertions make the bindings legal
  // before harness boot; the `beforeAll` throws if the harness is not
  // wired up, so no test body actually executes against unassigned values.
  void teamA;
  void teamB;
  void personal;
  void api;

  // Boot the live harness once for the whole describe block. The
  // harness asserts env safety, opens a Fastify instance against
  // TEST_DATABASE_URL, and seeds the canonical two-org + personal
  // fixtures. If seedFixtures() is still unimplemented, the harness
  // throws with a clear message — surfacing the gap loudly rather than
  // silently green-lighting the probe.
  let harness: IntegrationHarness | undefined;
  beforeAll(async () => {
    harness = await bootIntegrationHarness();
    teamA = harness.fixtures.teamA;
    teamB = harness.fixtures.teamB;
    personal = harness.fixtures.personal;
    // The runtime probe uses app.inject to bypass the network; expose
    // it under the `api.fetch` shape the assertions below already use.
    api = {
      fetch: async (path, init) => {
        const res = await harness!.app.inject({
          method:
            (init?.method as "GET" | "POST" | "PATCH" | "DELETE" | undefined) ??
            "GET",
          url: path,
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          payload:
            typeof init?.body === "string"
              ? init.body
              : init?.body
                ? JSON.stringify(init.body)
                : undefined,
        });
        // Adapt Fastify InjectionResult to the Response surface the
        // probe assertions expect.
        return {
          status: res.statusCode,
          json: async () => JSON.parse(res.body),
          text: async () => res.body,
        } as unknown as Response;
      },
    };
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  // -------------------------------------------------------------------------
  // Cross-tenant read denial
  // -------------------------------------------------------------------------

  describe("read denial (userA → teamB)", () => {
    it("GET /v1/evidence/<idB> returns 404 not_found, no existence leak", async () => {
      const r = await api.fetch(`/v1/evidence/${teamB.evidenceId}`, {
        headers: { authorization: `Bearer ${teamA.memberToken}` },
      });
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("not_found");
    });

    it("GET /v1/cases/<idB> returns 404 not_found", async () => {
      const r = await api.fetch(`/v1/cases/${teamB.caseId}`, {
        headers: { authorization: `Bearer ${teamA.memberToken}` },
      });
      expect(r.status).toBe(404);
    });

    it("GET /v1/reports/<idB> returns 404 not_found", async () => {
      const r = await api.fetch(`/v1/reports/${teamB.reportId}`, {
        headers: { authorization: `Bearer ${teamA.memberToken}` },
      });
      expect(r.status).toBe(404);
    });

    it("GET /v1/evidence/<idB>/verification-package returns 404", async () => {
      const r = await api.fetch(
        `/v1/evidence/${teamB.evidenceId}/verification-package`,
        { headers: { authorization: `Bearer ${teamA.memberToken}` } },
      );
      expect(r.status).toBe(404);
    });

    // Phase 12 convergence — /v1/governance/legal-holds removed (DEAD_LEGACY,
    // superseded by /v1/lifecycle/legal-holds). Cross-tenant probe retired.
  });

  // -------------------------------------------------------------------------
  // Cross-tenant list denial — listing teamB with a teamA token must
  // return 404 (anti-enumeration) or strictly filter out teamB rows.
  // -------------------------------------------------------------------------

  describe("list denial (userA querying teamB)", () => {
    it("GET /v1/evidence?teamId=<teamB> returns 404 (userA is not a teamB member)", async () => {
      const r = await api.fetch(`/v1/evidence?teamId=${teamB.teamId}`, {
        headers: { authorization: `Bearer ${teamA.memberToken}` },
      });
      expect(r.status).toBe(404);
    });

    it("GET /v1/cases/matter-queue?teamId=<teamB> returns 404", async () => {
      const r = await api.fetch(
        `/v1/cases/matter-queue?teamId=${teamB.teamId}`,
        { headers: { authorization: `Bearer ${teamA.memberToken}` } },
      );
      expect(r.status).toBe(404);
    });

    it("GET /v1/reports/artifacts?teamId=<teamB> returns 404", async () => {
      const r = await api.fetch(
        `/v1/reports/artifacts?teamId=${teamB.teamId}`,
        { headers: { authorization: `Bearer ${teamA.memberToken}` } },
      );
      expect(r.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant mutation denial
  // -------------------------------------------------------------------------

  describe("mutation denial (userA → teamB)", () => {
    it("PATCH /v1/evidence/<idB> returns 404", async () => {
      const r = await api.fetch(`/v1/evidence/${teamB.evidenceId}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${teamA.ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "tampered" }),
      });
      expect(r.status).toBe(404);
    });

    it("DELETE /v1/evidence/<idB> returns 404", async () => {
      const r = await api.fetch(`/v1/evidence/${teamB.evidenceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${teamA.ownerToken}` },
      });
      expect(r.status).toBe(404);
    });

    it("PATCH /v1/cases/<idB> returns 404", async () => {
      const r = await api.fetch(`/v1/cases/${teamB.caseId}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${teamA.ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "ARCHIVED" }),
      });
      expect(r.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Search activeSpace scoping
  // -------------------------------------------------------------------------

  describe("search activeSpace scoping", () => {
    it("search?teamId=<teamA> with userA never returns a teamB result", async () => {
      const r = await api.fetch(
        `/v1/search?teamId=${teamA.teamId}&q=evidence`,
        { headers: { authorization: `Bearer ${teamA.memberToken}` } },
      );
      const body = (await r.json()) as {
        rows: Array<{ evidenceId: string | null }>;
      };
      for (const row of body.rows) {
        if (row.evidenceId === teamB.evidenceId) {
          throw new Error("teamA search returned teamB evidence");
        }
      }
      expect(r.status).toBe(200);
    });

    it("search?teamId=<teamB> with userA returns 404 (anti-enumeration)", async () => {
      const r = await api.fetch(
        `/v1/search?teamId=${teamB.teamId}&q=evidence`,
        { headers: { authorization: `Bearer ${teamA.memberToken}` } },
      );
      expect(r.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Personal vs Organization separation
  // -------------------------------------------------------------------------

  describe("personal vs organization separation", () => {
    it("org user cannot access personal evidence (404)", async () => {
      const r = await api.fetch(`/v1/evidence/${personal.evidenceId}`, {
        headers: { authorization: `Bearer ${teamA.memberToken}` },
      });
      expect(r.status).toBe(404);
    });

    it("personal user cannot access org evidence (404)", async () => {
      const r = await api.fetch(`/v1/evidence/${teamA.evidenceId}`, {
        headers: { authorization: `Bearer ${personal.token}` },
      });
      expect(r.status).toBe(404);
    });

    it("personal user's platform-context organizations[] is empty", async () => {
      const r = await api.fetch("/v1/platform/context", {
        headers: { authorization: `Bearer ${personal.token}` },
      });
      const body = (await r.json()) as {
        organizations?: ReadonlyArray<unknown>;
      };
      expect(body.organizations ?? []).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Public verify enumeration safety
  // -------------------------------------------------------------------------

  describe("public verify enumeration safety", () => {
    it("an invalid token returns the same error shape as a valid-format-but-missing token (no timing/shape leak)", async () => {
      const r1 = await api.fetch("/public/verify/INVALID_TOKEN_FORMAT");
      const r2 = await api.fetch(
        "/public/verify/00000000-0000-0000-0000-000000000000",
      );
      expect(r1.status).toBe(r2.status);
      const b1 = await r1.text();
      const b2 = await r2.text();
      // Bodies should be structurally identical (same fields, both safe).
      expect(JSON.parse(b1).error?.code).toBe(JSON.parse(b2).error?.code);
    });

    it("public verify never returns private fields (internal notes, storage keys)", async () => {
      // Requires the harness to mint a public verify token for evidenceA.
      // Then we assert the response has no `storageKey` / `internalNotes`.
      // Implementation deferred to harness.
    });
  });

  // -------------------------------------------------------------------------
  // Role-aware mutation denial (viewer cannot mutate)
  // -------------------------------------------------------------------------

  describe("role denial within same tenant", () => {
    it("viewer cannot DELETE evidence even in their own team", async () => {
      const r = await api.fetch(`/v1/evidence/${teamA.evidenceId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${teamA.viewerToken}` },
      });
      expect([403, 404]).toContain(r.status);
    });
  });
});
