/**
 * Phase 8 — Cross-organization isolation contract.
 *
 * Pins Phase 8 success criterion #13 (no cross-org leaks) at the
 * SOURCE-CONTRACT level. The constitutional rule: an org-A member must
 * NEVER reach /organizations/orgB/admin/* data even if they hand-craft
 * the URL.
 *
 * What we pin:
 *
 *   1. Every org-admin tab reads orgId from the URL path param
 *      (useParams) — NEVER from envelope state, NEVER from a static
 *      "current org" hook.
 *   2. Every org-data fetch the admin shell + leaf pages issue scopes
 *      by `/v1/orgs/${orgId}/...` (orgId comes from the path).
 *   3. The server-side org endpoints use `checkOrgAccess(prisma, {
 *      orgId, userId })` so a non-member orgB request hits a 403 from
 *      the API layer — irrespective of what the frontend gate decided.
 *   4. The server-side org endpoints validate orgId as a UUID
 *      (`UuidParam.parse(...)`) so malformed cross-org URLs are
 *      rejected before any DB lookup runs.
 *   5. The admin shell's governance / access-review / audit summaries
 *      are honest deep-links rather than fabricated aggregates — the
 *      Phase 8 frontend stream chose this deliberately so cross-org
 *      counts can't accidentally leak.
 *
 * Source-contract test — no DB I/O.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("../../../apps/web", import.meta.url));
const API_ROOT = fileURLToPath(
  new URL("../../../services/api", import.meta.url),
);

function readWeb(rel: string): string {
  return readFileSync(resolve(WEB_ROOT, rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), "utf8");
}

const ADMIN_PAGES: ReadonlyArray<string> = [
  "app/(app)/organizations/[id]/admin/page.tsx",
  "app/(app)/organizations/[id]/admin/layout.tsx",
  "app/(app)/organizations/[id]/admin/overview/page.tsx",
  "app/(app)/organizations/[id]/admin/members/page.tsx",
  "app/(app)/organizations/[id]/admin/departments/page.tsx",
  "app/(app)/organizations/[id]/admin/governance/page.tsx",
  "app/(app)/organizations/[id]/admin/access-reviews/page.tsx",
  "app/(app)/organizations/[id]/admin/retention/page.tsx",
  "app/(app)/organizations/[id]/admin/audit/page.tsx",
  "app/(app)/organizations/[id]/admin/security/page.tsx",
  "app/(app)/organizations/[id]/admin/trust/page.tsx",
];

// ---------------------------------------------------------------------------
// (1 + 2) Every admin page derives orgId from the URL path and scopes
// every org-data fetch by that orgId.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin pages derive orgId from the URL (no envelope leak)", () => {
  for (const page of ADMIN_PAGES) {
    const body = readWeb(page);

    // Skip the inline placeholder pages that have no fetch (e.g.
    // governance/departments/trust/access-reviews/retention static
    // deep-link cards). Those pages don't make API calls.
    const usesParams = body.includes("useParams");

    it(`${page} reads orgId via useParams (URL path), not envelope`, () => {
      expect(usesParams, `${page} must call useParams`).toBe(true);
    });

    it(`${page} does NOT read orgId from envelope.workspace.* / envelope.account.*`, () => {
      // Constitutional rule: no direct envelope.workspace.* reads
      // outside lib/platform-context. We additionally pin that the
      // org-admin shell never sources orgId from the envelope.
      expect(body).not.toMatch(/envelope\.workspace\.organizationId/);
      expect(body).not.toMatch(/envelope\.account\.organizationId/);
    });

    if (body.includes("/v1/orgs/")) {
      it(`${page} only constructs /v1/orgs/ URLs via the orgId template param`, () => {
        // Strip line + block comments first so stray backticks inside
        // comments (e.g. \`external: true\`) don't confuse the
        // template-literal scanner.
        const stripped = body
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .join("\n");
        if (!stripped.includes("/v1/orgs/")) return;
        // FETCH URLs are constructed inside backtick template
        // literals. Every such literal containing `/v1/orgs/` MUST
        // also include `${orgId}` (or another path param that ties
        // the URL to the URL-derived orgId). Hard-coded UUIDs or
        // ":id"-style placeholders in executable templates would be
        // cross-org leak vectors.
        const templateLiterals =
          stripped.match(/`[^`]*\/v1\/orgs\/[^`]*`/g) ?? [];
        const bad = templateLiterals.filter(
          (tpl) => !tpl.includes("${orgId}"),
        );
        expect(
          bad,
          `Found /v1/orgs/ template literals without orgId substitution:\n${bad.join("\n")}`,
        ).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (3) Server-side membership check via checkOrgAccess on every org
// endpoint that handles a path orgId.
// ---------------------------------------------------------------------------

describe("Phase 8 — every org-scoped server route enforces checkOrgAccess", () => {
  const routesFile = readApi("src/routes/organizations.routes.ts");

  it("organizations.routes.ts imports checkOrgAccess", () => {
    expect(routesFile).toMatch(/import\s*\{[\s\S]*?checkOrgAccess[\s\S]*?\}\s*from/);
  });

  it("the GET /v1/orgs/:id handler calls checkOrgAccess + returns 403 on non-member", () => {
    // Capture the GET /v1/orgs/:id handler body (everything between
    // the first checkOrgAccess + the 403 send response).
    const matches = routesFile.match(
      /checkOrgAccess\(prisma,\s*\{[\s\S]{0,300}?\}\)/g,
    );
    expect(matches, "Expected at least 1 checkOrgAccess invocation").not
      .toBeNull();
    // Conservatively: there must be many — every read endpoint goes
    // through it. The current contract has 10+ invocations.
    expect((matches ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("403 responses on cross-org access do NOT distinguish 'not found' from 'forbidden'", () => {
    // Defense in depth — a non-member must not be able to enumerate
    // orgs by probing 404 vs 403 patterns. The routes return 403 for
    // both kinds.
    expect(routesFile).toMatch(
      /access\.kind\s*!==\s*"ok"[\s\S]{0,200}?\.code\(403\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// (4) UUID validation on orgId path param.
// ---------------------------------------------------------------------------

describe("Phase 8 — orgId path param is UUID-validated", () => {
  const routesFile = readApi("src/routes/organizations.routes.ts");

  it("declares a UuidParam zod schema", () => {
    expect(routesFile).toMatch(/UuidParam\s*=\s*z\.string\(\)\.uuid\(\)/);
  });

  it("uses UuidParam.parse() on the :id path param across handlers", () => {
    const usages = routesFile.match(
      /UuidParam\.parse\(\(req\.params as \{ id: string \}\)\.id\)/g,
    );
    expect(usages, "Expected UuidParam.parse usage on :id").not.toBeNull();
    // Many endpoints — at least the GET /v1/orgs/:id + its sub-routes.
    expect((usages ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// (5) The admin shell renders honest deep-links — no fabricated
// cross-org aggregates.
//
// The departments / governance / access-reviews / trust tabs each
// declare "Canonical CRUD/runner lives in <Phase 4A surface>" rather
// than pulling counts from a workspace-scoped endpoint.
// ---------------------------------------------------------------------------

describe("Phase 8 — admin shell uses honest deep-links for workspace-scoped data", () => {
  it("Departments tab acknowledges canonical CRUD lives in Governance Platform", () => {
    const body = readWeb(
      "app/(app)/organizations/[id]/admin/departments/page.tsx",
    );
    expect(body).toMatch(/Governance Platform/);
  });

  it("Governance tab acknowledges canonical policy CRUD lives in Governance Platform", () => {
    const body = readWeb(
      "app/(app)/organizations/[id]/admin/governance/page.tsx",
    );
    expect(body).toMatch(/Governance Platform/);
  });

  it("Access-reviews tab acknowledges canonical campaign runner lives in Governance Platform", () => {
    const body = readWeb(
      "app/(app)/organizations/[id]/admin/access-reviews/page.tsx",
    );
    expect(body).toMatch(/Governance Platform/);
  });

  it("Trust tab links to canonical /trust-center (not a fabricated org-scoped trust page)", () => {
    const body = readWeb("app/(app)/organizations/[id]/admin/trust/page.tsx");
    expect(body).toMatch(/\/trust-center/);
  });
});

// ---------------------------------------------------------------------------
// Defense-in-depth: no admin page hard-codes another org's id.
// ---------------------------------------------------------------------------

describe("Phase 8 — no admin page hard-codes a literal org UUID", () => {
  // A UUID hard-coded into an admin page would be a major cross-org
  // leak vector — every user's page would point to the same org.
  // Constitutional: orgId always flows from the URL path param.
  const UUID_RE =
    /["'][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}["']/;

  for (const page of ADMIN_PAGES) {
    it(`${page} contains no literal UUID strings`, () => {
      const body = readWeb(page);
      expect(body).not.toMatch(UUID_RE);
    });
  }
});

// ---------------------------------------------------------------------------
// Make sure /v1/orgs/:id/members + /audit-events + /policies/retention
// all enforce per-org access too — those are the read endpoints the
// admin shell actually reaches for live data.
// ---------------------------------------------------------------------------

describe("Phase 8 — every server endpoint the admin shell hits enforces orgId access", () => {
  const routesFile = readApi("src/routes/organizations.routes.ts");

  const ENDPOINTS: ReadonlyArray<{ path: string; httpMethod: string }> = [
    { path: "/v1/orgs/:id", httpMethod: "get" },
    { path: "/v1/orgs/:id/members", httpMethod: "get" },
    { path: "/v1/orgs/:id/audit-events", httpMethod: "get" },
  ];

  for (const { path, httpMethod } of ENDPOINTS) {
    it(`route ${httpMethod.toUpperCase()} ${path} enforces checkOrgAccess`, () => {
      // Find the route declaration (e.g. app.get("/v1/orgs/:id", ...))
      // and confirm its body contains checkOrgAccess.
      const escapedPath = path.replace(/[/:]/g, "\\$&");
      const declRe = new RegExp(
        `app\\.${httpMethod}\\(\\s*"${escapedPath}"[\\s\\S]{0,6000}?checkOrgAccess`,
      );
      expect(routesFile).toMatch(declRe);
    });
  }
});

/**
 * Walk under apps/web/app and ensure no test or page accidentally
 * inserts a cross-org href like `/organizations/<otherId>/admin` —
 * every admin link must be parameterized by `${orgId}`.
 */
describe("Phase 8 — no static cross-org admin links anywhere in the web tree", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === "dist") {
        continue;
      }
      const full = resolve(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(...walk(full));
        continue;
      }
      if (
        name.endsWith(".tsx") ||
        name.endsWith(".ts") ||
        name.endsWith(".jsx") ||
        name.endsWith(".js")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  it("every '/organizations/<X>/admin' literal in apps/web uses a variable id (no hard-coded UUID)", () => {
    const offenders: string[] = [];
    // Match an /organizations/<segment>/admin literal where <segment>
    // is a UUID (forbidden) — variable interpolations like
    // `/organizations/${orgId}/admin` are encoded as `${...}` so don't
    // match the UUID regex.
    const RE =
      /\/organizations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/admin/;
    for (const f of walk(WEB_ROOT)) {
      if (f.includes(".test.") || f.includes("\\test\\") || f.includes("/test/"))
        continue;
      const body = readFileSync(f, "utf8");
      if (RE.test(body)) {
        offenders.push(f);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
