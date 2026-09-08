/**
 * GET /v1/ops/health — A MISSING `teamId` IS A REFUSAL, NOT A CRASH.
 *
 * =============================================================================
 * THE DEFECT — MEASURED, NOT ASSUMED
 * =============================================================================
 * The handler opened with `TeamIdQuery.parse(req.query ?? {})`. `TeamIdQuery`
 * requires a uuid, so an operator calling without `?teamId=` — or with a
 * malformed one — raised a ZodError.
 *
 * IT WAS NOT A 500, and this file was written believing it was. Running these
 * cases against the unfixed handler is what settled it: the central error
 * handler already catches a raw ZodError and answers a bounded 400
 * `INVALID_INPUT` with a request id and a truncated field summary
 * (`buildZodWirePayload`, server.ts). That fallback is deliberate and is
 * itself tested.
 *
 * What was actually wrong is narrower. The Phase-O pass moved three sibling
 * routes off that generic fallback and onto a route-specific refusal —
 * `/v1/ops/metrics`, `/v1/reviewer-ops/queue` and `/v1/reviewer-ops/console`
 * all answer `INVALID_QUERY` with an operator-facing sentence — and did not
 * reach this one. So a caller here was handed the VALIDATOR'S vocabulary
 * ("teamId — Invalid input: expected string, received undefined") where the
 * siblings hand back an instruction. An operator reading a health endpoint
 * mid-incident is the last person who should have to translate a schema error.
 *
 * =============================================================================
 * WHAT THIS FIX IS NOT
 * =============================================================================
 * It is NOT an authorization change. `requireOpsActor(req, reply, teamId)` runs
 * exactly as before, on exactly the same value, and the route's scope is
 * untouched: it still answers only for a workspace the caller is an active
 * member of with `operations.view`. The only thing that changed is what a
 * request carrying no usable workspace id is TOLD.
 *
 * So the cases below come in two halves, and the second half is the more
 * important one: the refusals that must still happen, unchanged.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedPersonalTenant,
  seedUser,
  type FixtureDeps,
  type SeededUser,
} from "./point7/product-fixtures.js";

const HEALTH = "/v1/ops/health";

describe("GET /v1/ops/health query validation (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let member: SeededUser;
  let outsider: SeededUser;
  let memberWorkspaceId: string;
  let otherWorkspaceId: string;

  async function get(url: string, token?: string) {
    return harness.app.inject({
      method: "GET",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    const { prisma } = await import("../src/db.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `opshealth-${Date.now().toString(36)}`,
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

    const own = await seedPersonalTenant(deps, "PRO");
    member = own.owner;
    memberWorkspaceId = own.personalTeamId;

    const other = await seedPersonalTenant(deps, "PRO");
    otherWorkspaceId = other.personalTeamId;

    outsider = await seedUser(deps, "opshealth-outsider");
  });

  // ==========================================================================
  // The defect: a bad or absent parameter is a bounded 400.
  // ==========================================================================

  describe("a request that names no usable workspace gets THIS route's refusal", () => {
    it("omitting teamId answers 400 INVALID_QUERY, not the generic fallback", async () => {
      // Measured before the fix: 400 INVALID_INPUT, the central ZodError
      // fallback. The status was already right; the answer was generic.
      const res = await get(HEALTH, member.token);
      expect(res.statusCode).toBe(400);
      expect(
        res.json().error.code,
        "the route still falls through to the central ZodError fallback",
      ).toBe("INVALID_QUERY");
    });

    it("a malformed teamId answers 400 INVALID_QUERY, not the generic fallback", async () => {
      const res = await get(`${HEALTH}?teamId=not-a-uuid`, member.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_QUERY");
    });

    it("tells the operator what to do, in words, not in schema terms", async () => {
      // The substance of the change. "expected string, received undefined"
      // describes the validator; naming the parameter describes the fix.
      const message = String((await get(HEALTH, member.token)).json().error.message);
      expect(message).toContain("teamId");
      expect(message).not.toMatch(/expected|received|Invalid input:/);
    });

    it("the refusal carries a requestId, so an operator can be traced", async () => {
      // The whole point of a bounded error over a leaked ZodError: the caller
      // gets something they can quote, and the log line it belongs to exists.
      const res = await get(HEALTH, member.token);
      expect(typeof res.json().error.requestId).toBe("string");
      expect(res.json().error.requestId.length).toBeGreaterThan(0);
    });

    it("carries no Zod field summary at all", async () => {
      /*
       * NOT a leak claim. The central fallback's field summary is bounded on
       * purpose — path, issue code and message, each truncated — and other
       * routes rely on it. The point here is that a route with ONE required
       * parameter has nothing to enumerate: naming the parameter in a sentence
       * says everything the summary would, without handing the caller a
       * description of the schema. Measured before the fix, this body carried
       * `"code":"invalid_type"` and the path `teamId`.
       */
      const body = JSON.stringify(await get(HEALTH, member.token).then((r) => r.json()));
      for (const artefact of ["invalid_type", "invalid_format", "fields"]) {
        expect(
          body,
          `the refusal still carries the validator artefact "${artefact}"`,
        ).not.toContain(artefact);
      }
    });
  });

  // ==========================================================================
  // What must NOT have changed. Authorization and scope are untouched.
  // ==========================================================================

  describe("authorization and scope are exactly as before", () => {
    it("an active member with their own workspace still gets 200", async () => {
      // The fix must not have narrowed the route into uselessness — the
      // ordinary success path is the control for every refusal above.
      const res = await get(
        `${HEALTH}?teamId=${encodeURIComponent(memberWorkspaceId)}`,
        member.token,
      );
      expect(res.statusCode, "the ordinary operator path stopped working").toBe(
        200,
      );
    });

    it("an anonymous caller is still refused before any parsing happens", async () => {
      // `requireAuth` is a preHandler and runs first. A 400 here would mean
      // the validation had been hoisted above authentication, which would tell
      // an unauthenticated caller whether a parameter shape was acceptable.
      const res = await get(HEALTH);
      expect(res.statusCode).toBe(401);
      const withParam = await get(
        `${HEALTH}?teamId=${encodeURIComponent(memberWorkspaceId)}`,
      );
      expect(withParam.statusCode).toBe(401);
    });

    it("a caller who is not a member of the named workspace is still refused", async () => {
      // The authorization gate this fix must not have touched. Whatever
      // `requireOpsActor` answered before, it answers now — the assertion is
      // that it is not 200, because distinguishing 403 from 404 here is the
      // anti-enumeration decision that gate owns, not this route's.
      const res = await get(
        `${HEALTH}?teamId=${encodeURIComponent(otherWorkspaceId)}`,
        member.token,
      );
      expect(
        res.statusCode,
        "a non-member read another workspace's operational health",
      ).not.toBe(200);
    });

    it("a workspace-less authenticated caller is refused, not admitted", async () => {
      // An account with no seeded workspace at all. It must not be able to
      // reach the payload by omitting the parameter — which is precisely the
      // shape the bounded 400 must not accidentally open.
      const res = await get(HEALTH, outsider.token);
      expect(res.statusCode).not.toBe(200);
    });
  });
});
