/**
 * RETIRED ROUTES (2026-09-16) — every tombstone, booted for real.
 *
 * Owner decisions and proven-obsolete routes retired to TYPED 410 TOMBSTONES,
 * following the convention in collaboration-completion.routes.ts
 * (`notificationsRetired`): the registration is kept so a stale client gets a
 * precise answer instead of a 404, authentication is kept, and the handler does
 * no work — it reads and writes no domain data.
 *
 * For every retired route this suite proves, through the REAL route modules
 * and `app.inject`:
 *
 *   - an authenticated caller gets 410 with the exact stable code, a message
 *     inside `error`, and the `canonical` pointer;
 *   - an unauthenticated caller gets 401 (the `requireAuth` preHandler is
 *     still wired — the double below refuses a request with no bearer token);
 *   - no database access of any kind is attempted: `prisma` is a recording
 *     proxy, and the log stays empty whatever the body, params or query.
 *
 * House style: only the process edges (db, auth) are doubles.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ dbCalls: [] as string[] }));

vi.mock("../src/db.js", () => {
  // Every property access yields another recording proxy; every CALL is
  // logged. A tombstone must leave the log empty.
  const deep = (path: string): unknown =>
    new Proxy(function () {}, {
      get(_t, p) {
        if (p === "then" || typeof p === "symbol") return undefined;
        return deep(`${path}.${String(p)}`);
      },
      apply() {
        H.dbCalls.push(path);
        return deep(`${path}()`);
      },
    });
  return {
    prisma: deep("prisma"),
    closeDatabasePool: async () => ({}),
  };
});

// Legal acceptance reads the database; it is a process edge like auth.
vi.mock("../src/middleware/require-legal-acceptance.js", () => ({
  requireLegalAcceptance: async () => undefined,
}));

vi.mock("../src/middleware/auth.js", () => {
  const requireAuth = async (
    req: { headers: Record<string, string | undefined> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    }
  };
  return { requireAuth, requireAuthAndLegal: requireAuth };
});

import { aiSearchRoutes } from "../src/routes/ai-search.routes.js";
import { billingRoutes } from "../src/routes/billing.routes.js";
import { collaborationCompletionRoutes } from "../src/routes/collaboration-completion.routes.js";
import { collaborationRoutes } from "../src/routes/collaboration.routes.js";
import { intelligenceRoutes } from "../src/routes/intelligence.routes.js";
import { reviewerWorkspaceRoutes } from "../src/routes/reviewer-workspace.routes.js";
import { searchRoutes } from "../src/routes/search.routes.js";
import { trustAndGovernanceRoutes } from "../src/routes/trust-and-governance.routes.js";
import { workflowRoutes } from "../src/routes/workflow.routes.js";

const ID = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Case = {
  method: Method;
  url: string;
  code: string;
  canonical: string;
  payload?: Record<string, unknown>;
};

const CASES: Case[] = [
  // 1. Owner decision — contributor thread access.
  {
    method: "POST",
    url: `/v1/collaboration/threads/${ID}/contributors`,
    code: "COLLABORATION_THREAD_CONTRIBUTORS_RETIRED",
    canonical: "/v1/external-review/invitations",
    payload: { teamId: TEAM, intakeSessionId: SESSION, contributorLabel: "x" },
  },
  {
    method: "DELETE",
    url: `/v1/collaboration/threads/${ID}/contributors/${SESSION}?teamId=${TEAM}`,
    code: "COLLABORATION_THREAD_CONTRIBUTORS_RETIRED",
    canonical: "/v1/external-review/invitations",
  },
  // 2. Owner decision — thread subscriptions.
  {
    method: "POST",
    url: `/v1/collaboration/threads/${ID}/subscribe?teamId=${TEAM}`,
    code: "COLLABORATION_THREAD_SUBSCRIPTIONS_RETIRED",
    canonical: "/v1/me/inbox",
  },
  {
    method: "DELETE",
    url: `/v1/collaboration/threads/${ID}/subscribe?teamId=${TEAM}`,
    code: "COLLABORATION_THREAD_SUBSCRIPTIONS_RETIRED",
    canonical: "/v1/me/inbox",
  },
  // 3. Owner decision — workspace workflow-template authoring.
  {
    method: "POST",
    url: "/v1/workflow/templates",
    code: "WORKFLOW_TEMPLATE_AUTHORING_RETIRED",
    canonical: "/v1/workflow/templates",
    payload: { teamId: TEAM, slug: "x", name: "x" },
  },
  {
    method: "PATCH",
    url: `/v1/workflow/templates/${ID}`,
    code: "WORKFLOW_TEMPLATE_AUTHORING_RETIRED",
    canonical: "/v1/workflow/templates",
    payload: { name: "Renamed" },
  },
  {
    method: "POST",
    url: `/v1/workflow/templates/${ID}/archive`,
    code: "WORKFLOW_TEMPLATE_AUTHORING_RETIRED",
    canonical: "/v1/workflow/templates",
  },
  // 4. Owner decisions — similarity reconcile, trust article review flag.
  {
    method: "POST",
    url: `/v1/intelligence/evidence/${ID}/reconcile-similarity`,
    code: "SIMILARITY_RECONCILE_RETIRED",
    canonical: "/v1/graph/duplicates",
    payload: { teamId: TEAM },
  },
  {
    method: "POST",
    url: `/v1/trust/articles/${ID}/review`,
    code: "TRUST_ARTICLE_REVIEW_FLAG_RETIRED",
    canonical: "/v1/trust/drift/stale",
    payload: { reason: "x" },
  },
  // 5. Obsolete — natural-language search.
  {
    method: "POST",
    url: "/v1/ai/search/nl",
    code: "NL_SEARCH_RETIRED",
    canonical: "/v1/search",
    payload: { teamId: TEAM, query: "show evidence with tsa pending" },
  },
  // 6. Obsolete — collaboration-team guests and access review.
  {
    method: "GET",
    url: `/v1/collaboration-teams/${ID}/guests`,
    code: "COLLABORATION_TEAM_GUESTS_RETIRED",
    canonical: "/v1/external-review/invitations",
  },
  {
    method: "POST",
    url: `/v1/collaboration-teams/${ID}/guests/invite`,
    code: "COLLABORATION_TEAM_GUESTS_RETIRED",
    canonical: "/v1/external-review/invitations",
    payload: { email: "guest@example.com" },
  },
  {
    method: "PATCH",
    url: `/v1/collaboration-teams/${ID}/guests/${SESSION}/revoke`,
    code: "COLLABORATION_TEAM_GUESTS_RETIRED",
    canonical: "/v1/external-review/invitations",
  },
  {
    method: "GET",
    url: `/v1/collaboration-teams/${ID}/access-review`,
    code: "COLLABORATION_TEAM_ACCESS_REVIEW_RETIRED",
    canonical: "/v1/teams/{workspaceId}/access-review",
  },
  {
    method: "POST",
    url: `/v1/collaboration-teams/${ID}/access-review`,
    code: "COLLABORATION_TEAM_ACCESS_REVIEW_RETIRED",
    canonical: "/v1/teams/{workspaceId}/access-review",
    payload: {},
  },
  {
    method: "PATCH",
    url: `/v1/collaboration-teams/${ID}/access-review/items/${SESSION}`,
    code: "COLLABORATION_TEAM_ACCESS_REVIEW_RETIRED",
    canonical: "/v1/teams/{workspaceId}/access-review",
    payload: { decision: "REMOVE" },
  },
  {
    method: "POST",
    url: `/v1/collaboration-teams/${ID}/access-review/${SESSION}/complete`,
    code: "COLLABORATION_TEAM_ACCESS_REVIEW_RETIRED",
    canonical: "/v1/teams/{workspaceId}/access-review",
  },
  // 3b. Owner decision — custom coding-schema publish.
  {
    method: "POST",
    url: `/v1/coding/schemas/${ID}/publish?teamId=${TEAM}`,
    code: "CODING_SCHEMA_PUBLISH_RETIRED",
    canonical: "/v1/coding/schemas/seed-defaults",
  },
  // 8. Security (D4, 2026-09-17) — the raw subscription read.
  {
    method: "GET",
    url: "/v1/billing/subscription",
    code: "BILLING_SUBSCRIPTION_READ_RETIRED",
    canonical: "/v1/billing/accounts",
  },
  // 7. Obsolete — workflow-instance reindex.
  {
    method: "POST",
    url: `/v1/search/reindex/workflow/${ID}`,
    code: "WORKFLOW_INSTANCE_REINDEX_RETIRED",
    canonical: "/v1/search/reindex/evidence/:id",
    payload: { teamId: TEAM },
  },
];

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  // The server's own ZodError→400 mapping is irrelevant here: a tombstone
  // must never parse its input, so any 400/500 is a failure.
  for (const routes of [
    aiSearchRoutes,
    billingRoutes,
    collaborationCompletionRoutes,
    collaborationRoutes,
    intelligenceRoutes,
    reviewerWorkspaceRoutes,
    searchRoutes,
    trustAndGovernanceRoutes,
    workflowRoutes,
  ]) {
    await app.register(routes);
  }
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  H.dbCalls.length = 0;
});

const send = (c: Case, authenticated: boolean, payload = c.payload) =>
  app.inject({
    method: c.method,
    url: c.url,
    headers: {
      ...(authenticated ? { authorization: "Bearer test-token" } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });

describe("retired routes (2026-09-16) — typed 410 tombstones", () => {
  // CONTROL: the recorder is live. A route that was NOT retired (the
  // template list) reaches the database double, so an empty log below means
  // "nothing was attempted", not "nothing could be observed".
  it("control — a live sibling route does reach the database double", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/workflow/templates",
      headers: { authorization: "Bearer test-token" },
    });
    expect(H.dbCalls.length).toBeGreaterThan(0);
  });

  it("covers the twenty retired registrations", () => {
    expect(CASES).toHaveLength(20);
    expect(new Set(CASES.map((c) => `${c.method} ${c.url}`)).size).toBe(20);
  });

  for (const c of CASES) {
    describe(`${c.method} ${c.url.split("?")[0]}`, () => {
      it(`authenticated → 410 ${c.code}, and no database access`, async () => {
        const res = await send(c, true);
        expect(res.statusCode, res.body).toBe(410);
        const body = res.json() as {
          error: { code: string; message: string };
          canonical: string;
        };
        expect(body.error.code).toBe(c.code);
        expect(typeof body.error.message).toBe("string");
        expect(body.error.message.length).toBeGreaterThan(20);
        expect(body.canonical).toBe(c.canonical);
        expect(H.dbCalls).toEqual([]);
      });

      it("authenticated with a garbage body → the same 410 (input is never parsed)", async () => {
        const res = await send(c, true, { teamId: "not-a-uuid", junk: true });
        expect(res.statusCode, res.body).toBe(410);
        expect((res.json() as { error: { code: string } }).error.code).toBe(c.code);
        expect(H.dbCalls).toEqual([]);
      });

      it("unauthenticated → 401, and no database access", async () => {
        const res = await send(c, false);
        expect(res.statusCode, res.body).toBe(401);
        expect(H.dbCalls).toEqual([]);
      });
    });
  }
});
