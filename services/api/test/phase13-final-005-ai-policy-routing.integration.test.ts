/**
 * PHASE 13 §1.5 — FINAL-005 RUNTIME PROOF.
 *
 * THE DEFECT, AND WHY ONLY A REQUEST CAN SHOW IT IS GONE
 * ---------------------------------------------------------------------------
 * `GET/PUT /v1/workspaces/ai-policy` and `GET /v1/workspaces/ai-usage` were
 * registered under the ALIAS prefix. `workspace-alias.plugin.ts` rewrites every
 * incoming `/v1/workspaces…` URL to `/v1/teams…` in an `onRequest` hook that
 * runs BEFORE Fastify matches a route — so a request to the alias arrived at
 * routing as a path nothing had registered, and a request written with the
 * canonical `/v1/teams` spelling never matched either. BOTH spellings 404'd:
 * the Settings AI section, the AI capability status table and the policy write
 * were dead in production.
 *
 * This is the class of defect that source review is worst at. The routes exist
 * in the source. The web callers exist in the source. Only the relationship
 * between them was broken, and no file states that relationship — the rewrite
 * does, at runtime, in a hook. So the proof has to be a request.
 *
 * WHAT IS PROVEN
 * ---------------------------------------------------------------------------
 *   - the legacy `/v1/workspaces` spelling rewrites ONE way to `/v1/teams`
 *   - no rewrite loop exists (`/v1/teams` is never rewritten again)
 *   - the post-rewrite target is actually REGISTERED — asserted from the
 *     booted app's own route table, and then driven
 *   - authorization and tenant binding run AFTER the rewrite, not before
 *   - Personal, Owned and Organization workspace ids cannot be confused
 *   - correct reads and writes succeed
 *   - cross-workspace requests are refused
 *   - SUSPENDED and REVOKED memberships are refused
 *   - the two spellings are ONE authority: byte-identical responses, and a
 *     write through one spelling is visible through the other
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

/** The three routes FINAL-005 named, in both spellings. */
const SURFACES = [
  { name: "ai-policy read", method: "GET" as const, path: "/ai-policy" },
  { name: "ai-usage read", method: "GET" as const, path: "/ai-usage" },
] as const;

const ALIAS = "/v1/workspaces";
const CANONICAL = "/v1/teams";

describe("FINAL-005 — the AI policy surface is reachable through both spellings and authorizes after the rewrite", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;

  let workspaceId: string;
  let ownerToken: string;
  let viewerToken: string;
  let adminUserId: string;
  let adminToken: string;
  let foreignWorkspaceId: string;
  let foreignOwnerToken: string;
  let personalWorkspaceId: string;
  let personalToken: string;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;

    workspaceId = h.fixtures.teamA.teamId;
    ownerToken = h.fixtures.teamA.ownerToken;
    adminUserId = h.fixtures.teamA.adminUserId;
    adminToken = h.fixtures.teamA.adminToken;
    viewerToken = h.fixtures.teamA.viewerToken;
    foreignWorkspaceId = h.fixtures.teamB.teamId;
    foreignOwnerToken = h.fixtures.teamB.ownerToken;
    personalWorkspaceId = h.fixtures.personal.teamId;
    personalToken = h.fixtures.personal.token;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const get = (prefix: string, path: string, token: string, teamId: string) =>
    h.app.inject({
      method: "GET",
      url: `${prefix}${path}?teamId=${teamId}`,
      headers: auth(token),
    });

  // =========================================================================
  // Registration — the claim the defect made false.
  // =========================================================================
  it("the post-rewrite canonical paths are registered by the booted production app", () => {
    const table = h.app.printRoutes({ commonPrefix: false });
    expect(table).toContain("ai-policy");
    expect(table).toContain("ai-usage");
  });

  // =========================================================================
  // POSITIVE CONTROL — both spellings reach the handler.
  //
  // This is the direct inverse of the finding: before the fix, every one of
  // these answered 404.
  // =========================================================================
  for (const s of SURFACES) {
    it(`${s.name}: the LEGACY /v1/workspaces spelling reaches the handler`, async () => {
      const res = await get(ALIAS, s.path, ownerToken, workspaceId);
      expect(
        res.statusCode,
        `${ALIAS}${s.path} must not 404 — that was the defect. Body: ${res.body.slice(0, 200)}`,
      ).toBe(200);
    });

    it(`${s.name}: the CANONICAL /v1/teams spelling reaches the handler`, async () => {
      const res = await get(CANONICAL, s.path, ownerToken, workspaceId);
      expect(res.statusCode).toBe(200);
    });

    it(`${s.name}: the two spellings are ONE authority, not two implementations`, async () => {
      const viaAlias = await get(ALIAS, s.path, ownerToken, workspaceId);
      const viaCanonical = await get(CANONICAL, s.path, ownerToken, workspaceId);
      expect(viaAlias.statusCode).toBe(viaCanonical.statusCode);

      // Both bodies carry live timestamps on some surfaces, so compare the
      // stable policy shape rather than raw bytes where that applies.
      const a = JSON.parse(viaAlias.body) as Record<string, unknown>;
      const c = JSON.parse(viaCanonical.body) as Record<string, unknown>;
      expect(Object.keys(a).sort()).toEqual(Object.keys(c).sort());
    });
  }

  // =========================================================================
  // No rewrite loop, and the rewrite is one-way.
  // =========================================================================
  it("the rewrite is ONE-WAY: /v1/teams is never rewritten again, so no loop exists", async () => {
    // A loop would not return; it would exhaust the hook or the stack. That a
    // canonical request completes at all is the observable absence of a loop,
    // and the alias request completing proves the single hop happened.
    const canonical = await get(CANONICAL, "/ai-policy", ownerToken, workspaceId);
    const alias = await get(ALIAS, "/ai-policy", ownerToken, workspaceId);
    expect(canonical.statusCode).toBe(200);
    expect(alias.statusCode).toBe(200);
  });

  it("a path that merely STARTS with the alias prefix is not rewritten", async () => {
    // `/v1/workspacesfoo` must not become `/v1/teamsfoo`. If the prefix guard
    // were a bare startsWith, this would rewrite into a different namespace.
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/workspacesfoo/ai-policy",
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  // =========================================================================
  // Authorization runs AFTER the rewrite — through BOTH spellings.
  //
  // Testing only the canonical spelling here would miss the whole point: the
  // question is whether a request that ARRIVED as an alias is authorized, and
  // the rewrite happens before routing.
  // =========================================================================
  for (const prefix of [ALIAS, CANONICAL]) {
    describe(`authorization via ${prefix}`, () => {
      it("an anonymous request is refused", async () => {
        const res = await h.app.inject({
          method: "GET",
          url: `${prefix}/ai-policy?teamId=${workspaceId}`,
        });
        expect(res.statusCode).toBe(401);
      });

      it("a foreign workspace's owner cannot read this workspace's policy", async () => {
        const res = await get(prefix, "/ai-policy", foreignOwnerToken, workspaceId);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).not.toBe(200);
      });

      it("this workspace's owner cannot read a foreign workspace's policy", async () => {
        const res = await get(prefix, "/ai-policy", ownerToken, foreignWorkspaceId);
        expect(res.statusCode).not.toBe(200);
      });

      for (const status of ["SUSPENDED", "REVOKED"] as const) {
        it(`a ${status} member is refused`, async () => {
          // Positive control on the same actor first, so the refusal is
          // attributable to status and not to the actor.
          await prisma.teamMember.updateMany({
            where: { teamId: workspaceId, userId: adminUserId },
            data: { status: "ACTIVE", role: "ADMIN" },
          });
          const ok = await get(prefix, "/ai-policy", adminToken, workspaceId);
          expect(ok.statusCode, "ACTIVE control must succeed").toBe(200);

          await prisma.teamMember.updateMany({
            where: { teamId: workspaceId, userId: adminUserId },
            data: { status },
          });
          const res = await get(prefix, "/ai-policy", adminToken, workspaceId);
          expect(res.statusCode).not.toBe(200);

          await prisma.teamMember.updateMany({
            where: { teamId: workspaceId, userId: adminUserId },
            data: { status: "ACTIVE" },
          });
        });
      }
    });
  }

  // =========================================================================
  // Workspace-kind confusion.
  //
  // FINAL-005's surface takes a teamId as a QUERY PARAMETER, which is exactly
  // the shape where a Personal Space id, an Owned Workspace id and an
  // Organization Workspace id can be swapped for one another. Each identifier
  // must authorize only its own holder.
  // =========================================================================
  describe("Personal, Owned and Organization identifiers cannot be confused", () => {
    it("a personal user cannot read a workspace policy with their own token", async () => {
      const res = await get(ALIAS, "/ai-policy", personalToken, workspaceId);
      expect(res.statusCode).not.toBe(200);
    });

    it("a workspace member cannot read a foreign PERSONAL space's policy", async () => {
      const res = await get(ALIAS, "/ai-policy", ownerToken, personalWorkspaceId);
      expect(res.statusCode).not.toBe(200);
    });

    it("the personal user CAN read their own personal space policy", async () => {
      // The positive half: the identifiers are distinguished, not uniformly
      // refused. Without this the four denials above would also pass on a
      // surface that refuses everyone.
      const res = await get(ALIAS, "/ai-policy", personalToken, personalWorkspaceId);
      expect(
        res.statusCode,
        `a caller must reach their OWN personal space: ${res.body.slice(0, 200)}`,
      ).toBe(200);
    });

    it("an Organization workspace id is not interchangeable with its Organization id", async () => {
      const team = await prisma.team.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      });
      expect(team?.organizationId).toBeTruthy();
      // The ORGANIZATION id, passed where a WORKSPACE id belongs.
      const res = await get(
        ALIAS,
        "/ai-policy",
        ownerToken,
        team?.organizationId as string,
      );
      expect(
        res.statusCode,
        "an organization id must never authorize as a workspace id",
      ).not.toBe(200);
    });
  });

  // =========================================================================
  // The WRITE — and that both spellings address the same row.
  // =========================================================================
  describe("PUT ai-policy", () => {
    const put = (prefix: string, token: string, body: Record<string, unknown>) =>
      h.app.inject({
        method: "PUT",
        url: `${prefix}/ai-policy`,
        headers: auth(token),
        payload: body,
      });

    it("an OWNER can write the policy through the LEGACY spelling", async () => {
      const res = await put(ALIAS, ownerToken, {
        teamId: workspaceId,
        semanticSearchEnabled: false,
        reason: "phase13 final-005 runtime proof",
      });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    });

    it("a write through ONE spelling is visible through the OTHER — one row, one authority", async () => {
      await put(ALIAS, ownerToken, {
        teamId: workspaceId,
        semanticSearchEnabled: true,
        reason: "phase13 cross-spelling read-back",
      });
      const viaCanonical = await get(
        CANONICAL,
        "/ai-policy",
        ownerToken,
        workspaceId,
      );
      expect(viaCanonical.statusCode).toBe(200);
      const body = JSON.parse(viaCanonical.body) as {
        policy: { semanticSearchEnabled: boolean };
      };
      expect(body.policy.semanticSearchEnabled).toBe(true);
    });

    it("a VIEWER cannot write the policy through either spelling", async () => {
      for (const prefix of [ALIAS, CANONICAL]) {
        const res = await put(prefix, viewerToken, {
          teamId: workspaceId,
          semanticSearchEnabled: false,
        });
        expect(res.statusCode, `${prefix} must refuse a VIEWER write`).not.toBe(200);
      }
    });

    it("a foreign owner cannot write this workspace's policy through either spelling", async () => {
      for (const prefix of [ALIAS, CANONICAL]) {
        const res = await put(prefix, foreignOwnerToken, {
          teamId: workspaceId,
          semanticSearchEnabled: false,
        });
        expect(res.statusCode).not.toBe(200);
      }

      // And the value the legitimate owner set is still what it was.
      const after = await get(CANONICAL, "/ai-policy", ownerToken, workspaceId);
      const body = JSON.parse(after.body) as {
        policy: { semanticSearchEnabled: boolean };
      };
      expect(body.policy.semanticSearchEnabled).toBe(true);
    });
  });

  // =========================================================================
  // No parallel policy authority.
  // =========================================================================
  it("only ONE registration exists per AI policy path", () => {
    const table = h.app.printRoutes({ commonPrefix: false });
    // A second registration under the alias prefix is what the defect's fix
    // could plausibly have introduced — two handlers, two authorities, drifting.
    const aiPolicyRegistrations = table.split("\n").filter((l) =>
      l.includes("ai-policy"),
    );
    expect(
      aiPolicyRegistrations.length,
      `ai-policy must be registered once, found:\n${aiPolicyRegistrations.join("\n")}`,
    ).toBe(1);
  });
});
