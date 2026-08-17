/**
 * PHASE 12B — Evidence Operations production-entry matrix.
 *
 * ONE table-driven matrix over the Evidence Operations HTTP operations that
 * left the MISSING set in this pass (Cluster 10 = 7 reads, Cluster 14 = the
 * membership revoke). For each operation it proves the SAME five things, so a
 * future edit cannot quietly demote one of them:
 *
 *   1. ENTRY EXISTS — the route is registered in the API, and a real product
 *      surface calls it through the canonical `apiFetch` client. A route with
 *      no caller is the wiring defect this pass exists to close, so "wired"
 *      means a named page, not a test.
 *   2. SERVER-DERIVED CONTEXT — the handler takes its workspace/Organization
 *      from the server (`resolveWorkspace` / a `teamId` it authorizes), never
 *      from a client-declared Organization.
 *   3. CANONICAL AUTHORIZATION — the handler passes through `authorizeOrFail`
 *      (ACTIVE membership + parent-Organization lifecycle + access expiry +
 *      capability + audit + anti-enumeration) or the equivalent
 *      `requireMember` wrapper that composes it.
 *   4. HONEST CLIENT STATES — the consuming surface distinguishes loading,
 *      empty, DENIAL and error, and drops responses that land after a
 *      workspace switch (tenant generation guard). A page that renders a
 *      denial identically to "nothing here" is not wired; it is lying.
 *   5. READ-ONLY MEANS READ-ONLY — the read dashboards expose no control that
 *      mutates evidence, and the one mutation in the set is step-up gated.
 *
 * Source-text + registry assertions only: this matrix pins the WIRING
 * contract. The behavioral proof for the mutation path (step-up, replay,
 * expiry, wrong-purpose/user/target, zero-mutation-on-denial) lives in
 * `phase-12b-legal-hold-convergence.test.ts`, and the retention/destruction
 * authorities have their own behavioral suites.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO, assertCanonicalFactsFresh, registeredRoutePaths } from "./_canonical-facts";

const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

/**
 * Every route path registered by the API, for the "entry exists" leg.
 *
 * PHASE 0 §9 — from the canonical AST inventory. The regex it replaces read
 * only the top level of `src/routes/` and could not resolve a path held in a
 * constant, so "the entry exists" could be answered NO for an operation that
 * does exist.
 */
assertCanonicalFactsFresh();
const registeredRoutes = registeredRoutePaths();

type Operation = {
  method: "GET" | "POST";
  route: string;
  cluster: 10 | 14;
  /** API file that registers it. */
  registeringFile: string;
  /** Product surface that consumes it. */
  consumer: string;
  /** Literal the consumer passes to `apiFetch` (path prefix is enough). */
  clientPath: string;
  /** Capability the handler authorizes on. */
  capability: string;
  /** Step-up purpose, when the operation mutates. */
  stepUpPurpose?: string;
};

const OPERATIONS: Operation[] = [
  {
    method: "GET",
    route: "/v1/governance/retention-candidates",
    cluster: 10,
    registeringFile: "services/api/src/routes/governance.routes.ts",
    consumer: "apps/web/app/(app)/governance/retention/page.tsx",
    clientPath: "/v1/governance/retention-candidates",
    capability: "governance.retention.manage",
  },
  {
    method: "GET",
    route: "/v1/governance/retention-policies/effective",
    cluster: 10,
    registeringFile: "services/api/src/routes/governance-lifecycle.routes.ts",
    consumer: "apps/web/app/(app)/governance/retention/page.tsx",
    clientPath: "/v1/governance/retention-policies/effective",
    capability: "governance.policy.read",
  },
  {
    method: "GET",
    route: "/v1/governance/destruction-executions",
    cluster: 10,
    registeringFile: "services/api/src/routes/governance-operations.routes.ts",
    consumer: "apps/web/app/(app)/governance/destruction/page.tsx",
    clientPath: "/v1/governance/destruction-executions",
    capability: "governance.policy.read",
  },
  {
    method: "GET",
    route: "/v1/governance/reconciliation-runs",
    cluster: 10,
    registeringFile: "services/api/src/routes/governance-operations.routes.ts",
    consumer: "apps/web/app/(app)/governance/destruction/page.tsx",
    clientPath: "/v1/governance/reconciliation-runs",
    capability: "governance.policy.read",
  },
  {
    method: "GET",
    route: "/v1/governance/policies/effective",
    cluster: 10,
    registeringFile: "services/api/src/routes/trust-and-governance.routes.ts",
    consumer: "apps/web/app/(app)/governance-platform/policies/page.tsx",
    clientPath: "/v1/governance/policies/effective",
    capability: "governance.policy.read",
  },
  {
    method: "GET",
    route: "/v1/governance/access-reviews/escalated",
    cluster: 10,
    registeringFile: "services/api/src/routes/trust-and-governance.routes.ts",
    consumer: "apps/web/app/(app)/governance-platform/access-reviews/page.tsx",
    clientPath: "/v1/governance/access-reviews/escalated",
    capability: "governance.policy.read",
  },
  {
    method: "GET",
    route: "/v1/governance/me/department-scope",
    cluster: 10,
    registeringFile: "services/api/src/routes/trust-and-governance.routes.ts",
    consumer: "apps/web/app/(app)/governance-platform/departments/page.tsx",
    clientPath: "/v1/governance/me/department-scope",
    capability: "governance.policy.read",
  },
  {
    method: "POST",
    route: "/v1/governance/departments/memberships/:id/revoke",
    cluster: 14,
    registeringFile: "services/api/src/routes/trust-and-governance.routes.ts",
    consumer: "apps/web/app/(app)/governance-platform/departments/page.tsx",
    clientPath: "/v1/governance/departments/memberships/",
    capability: "governance.policy.manage",
    stepUpPurpose: "DEPARTMENT_MEMBERSHIP_REVOKE",
  },
];

/** The read-only consoles: none may host an evidence-mutating control. */
const READ_ONLY_CONSOLES = [
  "apps/web/app/(app)/governance-platform/policies/page.tsx",
  "apps/web/app/(app)/governance-platform/access-reviews/page.tsx",
];

const sourceCache = new Map<string, string>();
function src(rel: string): string {
  const cached = sourceCache.get(rel);
  if (cached !== undefined) return cached;
  const abs = resolve(REPO, rel);
  expect(existsSync(abs), `${rel} must exist`).toBe(true);
  const text = read(abs);
  sourceCache.set(rel, text);
  return text;
}

/**
 * The source of ONE route's handler: from its path literal to the next
 * `app.<verb>(` registration. A fixed-size window would spill into the
 * neighbouring handler and let another route's guards satisfy this one's
 * assertions (or its query parsing trip them), so the boundary is the next
 * registration, not a character count.
 */
function handlerBody(registeringFile: string, route: string): string {
  const text = src(registeringFile);
  const at = text.indexOf(`"${route}"`);
  expect(at, `${route} not declared in ${registeringFile}`).toBeGreaterThan(-1);
  const rest = text.slice(at);
  const next = rest.search(/\n\s*app\.(?:get|post|patch|put|delete)[<(]/);
  return next > 0 ? rest.slice(0, next) : rest;
}

// ---------------------------------------------------------------------------
// 1 — ENTRY EXISTS
// ---------------------------------------------------------------------------

describe("PHASE 12B — Evidence Operations entry matrix: entry exists", () => {
  it("covers exactly the operations this pass wired (7 read + 1 mutation)", () => {
    expect(OPERATIONS.filter((o) => o.cluster === 10)).toHaveLength(7);
    expect(OPERATIONS.filter((o) => o.cluster === 14)).toHaveLength(1);
    const keys = OPERATIONS.map((o) => `${o.method} ${o.route}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const op of OPERATIONS) {
    const key = `${op.method} ${op.route}`;

    it(`${key} — is registered and declared by the expected file`, () => {
      expect(registeredRoutes.has(op.route), `${op.route} is not registered`).toBe(
        true,
      );
      expect(src(op.registeringFile)).toContain(`"${op.route}"`);
    });

    it(`${key} — has a real product consumer that calls it via apiFetch`, () => {
      const page = src(op.consumer);
      expect(page).toContain(op.clientPath);
      // The canonical client, not a bare fetch.
      expect(page).toMatch(/from "[^"]*lib\/api"/);
      expect(page).toMatch(/apiFetch\(/);
      // No bypass of the canonical client on this surface.
      expect(page).not.toMatch(/\bwindow\.fetch\(/);
      expect(page).not.toMatch(/^\s*await fetch\(/m);
    });
  }
});

// ---------------------------------------------------------------------------
// 2 + 3 — SERVER-DERIVED CONTEXT and CANONICAL AUTHORIZATION
// ---------------------------------------------------------------------------

describe("PHASE 12B — Evidence Operations entry matrix: server context + authorization", () => {
  for (const op of OPERATIONS) {
    const key = `${op.method} ${op.route}`;

    it(`${key} — authorizes on ${op.capability} through the canonical helper`, () => {
      const body = handlerBody(op.registeringFile, op.route);
      expect(body).toContain(op.capability);
      // authorizeOrFail directly, or the `requireMember` wrapper that composes
      // it in the governance route files.
      expect(
        /authorizeOrFail\(/.test(body) || /requireMember\(/.test(body),
        `${key} must route through the canonical authorization helper`,
      ).toBe(true);
    });

    it(`${key} — takes its workspace from the server, never from the client`, () => {
      const body = handlerBody(op.registeringFile, op.route);
      // Either the session-resolved workspace, or a teamId that is authorized
      // before use (the `requireMember(req, reply, query.teamId, …)` rail).
      expect(
        /resolveWorkspace\(req, reply\)/.test(body) ||
          /requireMember\(req, reply, query\.teamId/.test(body),
        `${key} must derive the workspace server-side`,
      ).toBe(true);
      // A client-declared Organization must never be trusted as the scope of
      // an Evidence Operations read.
      expect(
        /organizationId: (?:q|query|body)\.organizationId/.test(body),
        `${key} must not scope on a client-supplied organizationId`,
      ).toBe(false);
    });
  }

  it("the departments write path derives the Organization server-side", () => {
    const routes = src("services/api/src/routes/trust-and-governance.routes.ts");
    // The create-department body no longer REQUIRES an Organization from the
    // client; the workspace row supplies it and a supplied value can only
    // cause a rejection.
    expect(routes).toMatch(/organizationId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(routes).toMatch(/organizationId: workspace\.organizationId/);
  });
});

// ---------------------------------------------------------------------------
// 4 — HONEST CLIENT STATES
// ---------------------------------------------------------------------------

describe("PHASE 12B — Evidence Operations entry matrix: honest client states", () => {
  const consumers = Array.from(new Set(OPERATIONS.map((o) => o.consumer)));

  for (const consumer of consumers) {
    it(`${consumer} — separates loading / empty / denial / error`, () => {
      const page = src(consumer);
      // Loading and empty are structured components, not bare strings.
      expect(page).toMatch(/loading=\{/);
      expect(page).toMatch(/<EmptyState/);
      // A denial is rendered as its own state, distinguishable from empty.
      expect(page).toMatch(/denied/);
      // Errors go through the ONE sanctioned display path.
      expect(page).toMatch(/toSafeUserError\(/);
      // …and never by passing a raw backend message straight through.
      expect(page).not.toMatch(/setError\(\s*err\.message\s*\)/);
      expect(page).not.toMatch(/\{\s*(?:err|error)\.message\s*\}/);
    });

    it(`${consumer} — drops responses that land after a workspace switch`, () => {
      const page = src(consumer);
      expect(page).toMatch(/useTenantGuard\(\)/);
      // The generation is captured BEFORE the await and checked after.
      expect(page).toMatch(/const captured = stamp\(\)/);
      expect(page).toMatch(/if \(isStale\(captured\)\) return/);
    });
  }
});

// ---------------------------------------------------------------------------
// 5 — READ-ONLY MEANS READ-ONLY (and the one mutation is gated)
// ---------------------------------------------------------------------------

describe("PHASE 12B — Evidence Operations entry matrix: read-only discipline", () => {
  for (const console_ of READ_ONLY_CONSOLES) {
    it(`${console_} — hosts no evidence-destroying control`, () => {
      const page = src(console_);
      for (const forbidden of [
        "/destruction-reviews/",
        "/retention-candidates/",
        "reconcile-retention",
        "destroy",
      ]) {
        expect(
          page.includes(forbidden),
          `${console_} must not reach ${forbidden}`,
        ).toBe(false);
      }
      expect(page).not.toMatch(/method: "DELETE"/);
    });
  }

  it("the retention + destruction consoles never decide retention client-side", () => {
    for (const page_ of [
      "apps/web/app/(app)/governance/retention/page.tsx",
      "apps/web/app/(app)/governance/destruction/page.tsx",
    ]) {
      const page = src(page_);
      // No local horizon arithmetic — the engine owns the decision, the page
      // renders `reason` / `source` / `conflicts` as given.
      expect(page).not.toMatch(/Date\.now\(\)\s*[-+]/);
      expect(page).not.toMatch(/retentionDays\s*\*\s*(?:24|86400)/);
      expect(page).not.toMatch(/isDestructible|canDestroy|isExpired\s*=/);
    }
  });

  it("the only mutation in the set is step-up gated on both sides", () => {
    const mutations = OPERATIONS.filter((o) => o.stepUpPurpose);
    expect(mutations).toHaveLength(1);
    const op = mutations[0]!;
    const body = handlerBody(op.registeringFile, op.route);
    expect(body).toContain(`purpose: "${op.stepUpPurpose}"`);
    // The gate precedes the write, inside the SAME handler.
    expect(body.indexOf(`purpose: "${op.stepUpPurpose}"`)).toBeLessThan(
      body.indexOf("revokeDepartmentMembership({"),
    );
    // The console routes the request through the step-up runner and confirms
    // before it sends.
    const page = src(op.consumer);
    expect(page).toMatch(/stepUp\.runStepUpAction\(/);
    expect(page).toMatch(/<StepUpModal control=\{stepUp\} \/>/);
    expect(page).toMatch(/await confirm\(\{/);
    // …and declares the state it observed, so a stale row is refused.
    expect(page).toMatch(/expectedState: membership\.state/);
  });

  it("membership grant/revoke enforce isolation + idempotency in ONE transaction", () => {
    const service = src(
      "services/api/src/services/governance/department-membership.service.ts",
    );
    // Cross-Organization isolation: the subject must be an ACTIVE member here.
    expect(service).toMatch(/teamMember\.findFirst/);
    expect(service).toMatch(/USER_NOT_A_MEMBER/);
    // Stale-state rejection.
    expect(service).toMatch(/STALE_STATE/);
    // Idempotent re-grant performs no write.
    expect(service).toMatch(/unchanged: true/);
    // Zero partial mutation — read-compare-write is transactional on both paths.
    expect((service.match(/\$transaction\(/g) ?? []).length).toBe(2);
  });

  it("both membership mutations emit a canonical governance audit event", () => {
    const routes = src("services/api/src/routes/trust-and-governance.routes.ts");
    expect(routes).toMatch(/code: "DEPARTMENT_MEMBERSHIP_GRANTED"/);
    expect(routes).toMatch(/code: "DEPARTMENT_MEMBERSHIP_REVOKED"/);
    expect(routes).toMatch(/targetType: "DEPARTMENT_MEMBERSHIP"/);
  });
});

// ---------------------------------------------------------------------------
// Registry conservation — the matrix and the tracker agree.
// ---------------------------------------------------------------------------

describe("PHASE 12B — Evidence Operations entry matrix: registry agreement", () => {
  type RegistryEntry = {
    method: string;
    route: string;
    finalState: string;
    proofSuite: string;
    targetSurface: string;
  };
  const registry = JSON.parse(
    read(
      resolve(
        REPO,
        "docs/architecture/route-classification/wiring-registry.json",
      ),
    ),
  ) as RegistryEntry[];
  const sliceE = new Set(
    (
      JSON.parse(
        read(
          resolve(REPO, "docs/architecture/route-classification/slice-e.json"),
        ),
      ) as Array<{ route: string }>
    ).map((e) => e.route),
  );

  for (const op of OPERATIONS) {
    const key = `${op.method} ${op.route}`;
    it(`${key} — is recorded WIRED_PRODUCT and has left the MISSING slice`, () => {
      const entry = registry.find(
        (e) => e.method === op.method && e.route === op.route,
      );
      expect(entry, `${key} absent from the wiring registry`).toBeTruthy();
      expect(entry!.finalState).toBe("WIRED_PRODUCT");
      expect(entry!.targetSurface).toContain(op.consumer);
      expect(sliceE.has(op.route), `${key} still in slice-e`).toBe(false);
    });
  }

  it("no Evidence Operations entry from this pass remains MISSING", () => {
    const stillMissing = OPERATIONS.filter((op) =>
      registry.some(
        (e) =>
          e.method === op.method &&
          e.route === op.route &&
          e.finalState === "MISSING",
      ),
    ).map((op) => `${op.method} ${op.route}`);
    expect(stillMissing, stillMissing.join("\n")).toEqual([]);
  });
});
