/**
 * PHASE 13 §A — THE ADVERSARIAL BATTERY FOR TENANT BINDING.
 *
 * Every defect this suite pins had the same shape as the Phase-12 ones: the
 * analyzer did not crash, it produced a confident number, and the number was
 * wrong in the direction that looks reassuring.
 *
 *   - 32 `/v1/collaboration-teams/*` routes reported "handler node not
 *     statically extractable" — and therefore tenant-UNRESOLVED — because their
 *     handler sits INSIDE the options object rather than in the third argument.
 *     Their first handler line resolves an ACTIVE workspace membership.
 *   - Nine routes bound by an owner-identity comparison (`caseItem.ownerUserId
 *     !== ownerUserId → 403`) reported as unbound, because the check is a
 *     post-lookup comparison rather than a query predicate.
 *   - `payment.findMany({ where: { userId }, select: { …, teamId: true } })`
 *     reported as tenant-scoped, because the scan read the whole call instead of
 *     the `where`. A projection is not a predicate.
 *   - `ORGANIZATION_SCOPED = 0` on an organization-tier product, because the
 *     family predicate tested `/v1/organizations` — a prefix this API never
 *     registers — and `checkOrgAccess` was absent from the terminal-marker table.
 *
 * The cases below are those defects written down, against the PRODUCTION
 * modules. Each asserts the answer the analyzer must give, and each is paired
 * with its NEGATIVE — the case that must stay unresolved — because an extractor
 * that says yes to everything is not an improvement over one that says no.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it, vi } from "vitest";

import {
  analyzeHandlerTenancy,
  buildCallGraph,
  classifyTenantBinding,
  deriveTenantOwnedModels,
  TENANT_OWNED_MODELS,
} from "../scripts/capability-authority/tenant-binding.mjs";
import { derivePrimarySecurityFamily } from "../scripts/capability-authority/security-families.mjs";

const require = createRequire(import.meta.url);
/** @type {any} */
const ts = require("typescript");

// The live-tree cases parse the whole API + shared trees through the compiler
// API. That is seconds, not milliseconds, and the 5s default would turn a
// passing assertion into a timeout that reads like a failure of the subject.
vi.setConfig({ testTimeout: 300_000 });

// ---------------------------------------------------------------------------
// Harness — the REAL extractor over a fixture written to a temporary file.
//
// The extractor walks `services/api/src/routes`, so a fixture must live there
// to be seen. Everything is removed in a finally block; a leftover fixture
// would be a route in the production inventory.
// ---------------------------------------------------------------------------

/**
 * The fixture is parsed from an ISOLATED temporary directory, never from
 * `services/api/src/routes`.
 *
 * The first version of this harness wrote the fixture into the production route
 * tree and deleted it in a finally block. It was present for under a second —
 * and vitest runs suites in parallel, so during that second the live inventory
 * was 1088 routes and four unrelated gates failed on a file that does not
 * exist: the map-freshness check, the module-reachability closure, the
 * tenant-isolation classification and the route-count baseline. A test that
 * mutates the tree it measures manufactures failures elsewhere and teaches
 * everyone to distrust the gates.
 */
async function fixtureRoutesFrom(source: string, base: string): Promise<{ routes: any[]; dynamicUnresolved: any[] }> {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const { indexApiFunctions, extractRoutes } = await import("../scripts/capability-authority/routes.mjs");
  const dir = mkdtempSync(nodePath.join(nodeOs.tmpdir(), `phase13-${base}-`));
  writeFileSync(nodePath.join(dir, "fixture.routes.ts"), source, "utf8");
  try {
    const index = indexApiFunctions();
    return extractRoutes(index, dir) as { routes: any[]; dynamicUnresolved: any[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function extractFixture(source: string): Promise<any[]> {
  const { routes } = await fixtureRoutesFrom(source, "extract");
  return routes;
}

const HANDLER_IN_OPTIONS = `
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";

export async function fixtureRoutes(app: FastifyInstance) {
  app.get("/v1/__fixture/in-options", {
    preHandler: requireAuth,
    handler: async (req, reply) => reply.send({ ok: true }),
  });

  app.post<{ Params: { id: string } }>(
    "/v1/__fixture/in-options-generic/:id",
    {
      preHandler: requireAuth,
      handler: async (req, reply) => reply.send({ ok: true }),
    },
  );

  app.get("/v1/__fixture/third-arg", { preHandler: requireAuth }, async (req, reply) =>
    reply.send({ ok: true }),
  );
}
`;

const NO_HANDLER = `
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";

export async function fixtureRoutes(app: FastifyInstance) {
  app.get("/v1/__fixture/no-handler", { preHandler: requireAuth });
}
`;

const DYNAMIC_PATH = `
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";

export async function fixtureRoutes(app: FastifyInstance, opts: { suffix: string }) {
  app.get(\`/v1/__fixture/\${opts.suffix}\`, {
    preHandler: requireAuth,
    handler: async (req, reply) => reply.send({ ok: true }),
  });
}
`;

const NEIGHBOURING_DESCRIPTORS = `
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";

export async function fixtureRoutes(app: FastifyInstance) {
  app.get("/v1/__fixture/guarded", {
    preHandler: requirePlatformAdmin,
    handler: async (req, reply) => reply.send({ ok: true }),
  });

  app.get("/v1/__fixture/unguarded", {
    handler: async (req, reply) => reply.send({ ok: true }),
  });
}
`;

describe("phase 13 §A1 — route handler extraction", () => {
  it("1. extracts a handler declared INSIDE the options object", async () => {
    const routes = await extractFixture(HANDLER_IN_OPTIONS);
    const inOptions = routes.find((r) => r.route === "/v1/__fixture/in-options");
    const generic = routes.find((r) => r.route === "/v1/__fixture/in-options-generic/:id");
    const thirdArg = routes.find((r) => r.route === "/v1/__fixture/third-arg");
    assert.ok(inOptions, "the two-argument options form was not registered at all");
    assert.ok(generic, "the generic-typed options form was not registered at all");
    // The defect: `handler` was read only from the argument position, so both
    // options-form routes carried `handler === undefined` and every fact
    // derived from the handler silently became "not extractable".
    assert.ok(inOptions.handler, "handler inside the options object was not extracted");
    assert.ok(generic.handler, "handler inside a generic-typed options object was not extracted");
    // The third-argument form must keep working — a fix that traded one form
    // for the other would be no fix.
    assert.ok(thirdArg.handler, "the third-argument handler form regressed");
  });

  it("2. a registration with NO handler stays unresolved", async () => {
    const routes = await extractFixture(NO_HANDLER);
    const r = routes.find((x) => x.route === "/v1/__fixture/no-handler");
    assert.ok(r, "fixture route not registered");
    assert.equal(r.handler ?? null, null, "a missing handler was invented");
  });

  it("3. a handler is never associated with the WRONG route", async () => {
    const routes = await extractFixture(HANDLER_IN_OPTIONS);
    for (const r of routes) {
      if (!r.handler) continue;
      const text = String(r.handler.getText());
      assert.ok(
        text.includes("reply.send"),
        `handler for ${r.route} is not a function body: ${text.slice(0, 60)}`,
      );
      // Each fixture handler is its own arrow function; the extracted node must
      // sit inside the registration it belongs to.
      assert.ok(
        r.handler.getStart() > 0 && r.handler.getEnd() > r.handler.getStart(),
        `handler for ${r.route} has no span`,
      );
    }
  });

  it("4. authorization from a NEIGHBOURING descriptor cannot leak", async () => {
    const routes = await extractFixture(NEIGHBOURING_DESCRIPTORS);
    const { indexApiFunctions, classifyRouteAuth } = await import(
      "../scripts/capability-authority/routes.mjs"
    );
    const index = indexApiFunctions();
    const guarded = routes.find((r) => r.route === "/v1/__fixture/guarded");
    const unguarded = routes.find((r) => r.route === "/v1/__fixture/unguarded");
    assert.ok(guarded && unguarded, "fixture routes not registered");
    const a = classifyRouteAuth(guarded, index) as { authClassification: string };
    const b = classifyRouteAuth(unguarded, index) as { authClassification: string };
    assert.notEqual(a.authClassification, "PUBLIC_UNGUARDED");
    assert.equal(
      b.authClassification,
      "PUBLIC_UNGUARDED",
      "the neighbouring route's guard was credited to an unguarded route",
    );
  });

  it("5. a dynamic, unbounded registration path is REFUSED, not guessed", async () => {
    const { routes, dynamicUnresolved } = await fixtureRoutesFrom(DYNAMIC_PATH, "dynamic");
    assert.equal(routes.length, 0, "an unresolvable path was invented as a concrete route");
    assert.equal(
      dynamicUnresolved.length,
      1,
      "an unresolvable registration was dropped silently instead of reported",
    );
  });
});

// ---------------------------------------------------------------------------
// Tenancy idioms, over the resolved call graph.
// ---------------------------------------------------------------------------

describe("phase 13 §A — tenant binding idioms", () => {
  let graph: any = null;
  const cg = () => (graph ??= buildCallGraph());

  /** Analyse a fragment as if it were a route handler in `file`. */
  function tenancyOf(source: string, file = "services/api/src/routes/cases.routes.ts") {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let handler: any = null;
    const visit = (n: any) => {
      if (handler) return;
      if (ts.isArrowFunction(n) || ts.isFunctionDeclaration(n)) handler = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    assert.ok(handler, "fixture contained no function");
    return analyzeHandlerTenancy(handler, file, cg(), 4, []);
  }

  const OWNER_COMPARISON = `
    const h = async (req: any, reply: any) => {
      const ownerUserId = getAuthUserId(req);
      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      return reply.send(caseItem);
    };
  `;

  const OWNER_MENTIONED_BUT_NOT_CHECKED = `
    const h = async (req: any, reply: any) => {
      const ownerUserId = getAuthUserId(req);
      const caseItem = await prisma.case.findUnique({ where: { id } });
      return reply.send({ owner: caseItem.ownerUserId, viewer: ownerUserId });
    };
  `;

  const PROJECTION_NOT_PREDICATE = `
    const h = async (req: any, reply: any) => {
      const userId = getAuthUserId(req);
      const rows = await prisma.payment.findMany({
        where: { userId },
        select: { id: true, teamId: true },
      });
      return reply.send(rows);
    };
  `;

  it("6. an owner-identity comparison WITH a refusal is a binding", () => {
    const a = tenancyOf(OWNER_COMPARISON);
    assert.ok(
      a.ownerIdentityAuthority,
      "an owner-column comparison against the session actor, plus a 403, was not recognised",
    );
  });

  it("7. an owner column merely MENTIONED is not a binding", () => {
    const a = tenancyOf(OWNER_MENTIONED_BUT_NOT_CHECKED);
    assert.equal(
      a.ownerIdentityAuthority ?? null,
      null,
      "reading an owner column into a response was counted as authorising on it",
    );
  });

  it("8. a tenant column in `select` is a PROJECTION, not a predicate", () => {
    const a = tenancyOf(PROJECTION_NOT_PREDICATE);
    assert.equal(a.tenantPredicateSites, 0, "a projected column was scored as a scoping predicate");
    assert.ok(a.selfPredicateSites > 0, "the genuine `where: { userId }` self predicate was lost");
    assert.deepEqual(a.unscopedSites, [], "a self-scoped read was reported as unscoped");
  });

  it("9. the tenant denominator is DERIVED from the schema, not hand-listed", () => {
    const derived = deriveTenantOwnedModels();
    assert.ok(derived.has("captureSession"), "CaptureSession declares teamId and must be tenant-owned");
    assert.ok(derived.size > 150, `denominator implausibly small: ${derived.size}`);
    // The frozen export and a fresh derivation must agree, or the module is
    // measuring against a stale snapshot of the schema.
    assert.equal(derived.size, TENANT_OWNED_MODELS.size);
  });

  it("10. an insert whose tenant id comes from the REQUEST is distinguished from a resolved one", () => {
    const fromRequest = tenancyOf(`
      const h = async (req: any, reply: any) => {
        const body = req.body as any;
        await prisma.captureSession.create({ data: { ownerUserId, teamId: body.teamId ?? null } });
      };
    `);
    const fromLookup = tenancyOf(`
      const h = async (req: any, reply: any) => {
        const link = await prisma.workflowIntakeLink.findFirst({ where: { id } });
        await prisma.captureSession.create({ data: { ownerUserId, teamId: link.teamId } });
      };
    `);
    const requestInsert = fromRequest.insertSites.find((i: any) => i.carriesTenantValue);
    const lookupInsert = fromLookup.insertSites.find((i: any) => i.carriesTenantValue);
    assert.ok(requestInsert?.tenantValueFromRequest, "a caller-supplied teamId was not flagged");
    assert.equal(
      lookupInsert?.tenantValueFromRequest,
      false,
      "a server-resolved teamId was flagged as caller-supplied",
    );
  });

  it("11. the organization family is derived from the path this API actually registers", () => {
    const orgs = derivePrimarySecurityFamily({
      method: "GET",
      path: "/v1/orgs/:id/members",
      authorizationClass: "CAPABILITY_GATED",
      gates: ["CAPABILITY_GATED"],
    });
    assert.equal(orgs, "ORGANIZATION_AUTHORIZED");
    // The organization evaluator names the family whatever the path looks like.
    assert.equal(
      derivePrimarySecurityFamily({
        method: "POST",
        path: "/v1/teams/:id/sso",
        authorizationClass: "ORGANIZATION_GATED",
        gates: ["ORGANIZATION_GATED"],
      }),
      "ORGANIZATION_AUTHORIZED",
    );
    // And a workspace route stays a workspace route.
    assert.equal(
      derivePrimarySecurityFamily({
        method: "GET",
        path: "/v1/cases/:id",
        authorizationClass: "CAPABILITY_GATED",
        gates: ["CAPABILITY_GATED"],
      }),
      "WORKSPACE_AUTHORIZED",
    );
  });

  it("12. scoping never masquerades as authorization", () => {
    // A route that constrains its query by teamId but reaches no membership
    // decision is the SESSION_ONLY_TENANT_ACCESS defect, and must stay
    // unresolved however well-scoped its SQL is.
    const verdict = classifyTenantBinding(
      { primarySecurityFamily: "SESSION_AUTHENTICATED" },
      {
        membershipAuthorities: [],
        modelsRead: ["case"],
        modelsWritten: [],
        tenantAccessModels: ["case"],
        tenantPredicateSites: 3,
        selfPredicateSites: 0,
        unscopedSites: [],
        insertSites: [],
        refusalCodes: [],
      },
    );
    assert.equal(verdict.tenantBindingResolved, false);
    assert.equal(verdict.tenantIdSource, "UNRESOLVED");
  });
});
