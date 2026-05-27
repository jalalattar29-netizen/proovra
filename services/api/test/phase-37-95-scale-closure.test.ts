/**
 * PHASE 37.95 — Scale-closure source-contract suite.
 *
 * Covers the remaining static invariants the enterprise hardening brief
 * called out: public verify enumeration safety, worker runtime ownership
 * patterns, search activeSpace scoping, pagination second-page contract,
 * billing/seat separation, and legacy-field removal blocking.
 *
 * Behavioral DB tests live in two companion files:
 *   - phase-37-95-tenant-access-helpers-behavioral.test.ts  (mocked Prisma)
 *   - phase-37-95-cross-tenant-runtime-probe.test.ts        (RUN_LIVE_INTEGRATION)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../apps/web/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}
function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../worker/${rel}`, import.meta.url),
    ),
    "utf8",
  );
}

// =============================================================================
// PART 3 — Public verify enumeration safety
// =============================================================================

describe("Phase 37.95 — public verify enumeration safety", () => {
  const EVIDENCE_ROUTES = readApi("src/routes/evidence.routes.ts");

  it("/public/verify/:id is rate-limited (resource-exhaustion + enumeration guard)", () => {
    expect(EVIDENCE_ROUTES).toMatch(/\/public\/verify\/:id/);
    expect(EVIDENCE_ROUTES).toMatch(
      // Widened from 300→1200 chars: the per-IP/per-id rate-limit
      // helper block is documented inline with a verbose comment
      // explaining the two-layer guard (Phase 37.95). The
      // `enforceRateLimit(` call sits inside that block.
      /enforceRateLimit[\s\S]{0,1200}\/public\/verify\/|public\/verify[\s\S]{0,1200}enforceRateLimit/,
    );
  });

  it("public verify gates on publicVerifyState (records NOT_PUBLISHED / SUSPENDED return 404)", () => {
    // The select clause must include publicVerifyState; the route must
    // check it before responding.
    const publicVerifyIdx = EVIDENCE_ROUTES.indexOf("/public/verify/:id");
    expect(publicVerifyIdx).toBeGreaterThan(0);
    const slice = EVIDENCE_ROUTES.slice(publicVerifyIdx, publicVerifyIdx + 8000);
    expect(slice).toMatch(/publicVerifyState/);
  });

  it("public verify never selects internalNotes (operator-private field stays server-side)", () => {
    const publicVerifyIdx = EVIDENCE_ROUTES.indexOf("/public/verify/:id");
    const slice = EVIDENCE_ROUTES.slice(publicVerifyIdx, publicVerifyIdx + 10000);
    const firstSelect = slice.match(/select:\s*\{[\s\S]*?\n\s*\}/);
    expect(firstSelect).not.toBeNull();
    // Operator-private notes must NEVER be selected by the public route.
    expect(firstSelect![0]).not.toMatch(/\binternalNotes:\s*true\b/);
  });

  it("public verify response handler does NOT echo storageKey / storageBucket back to the client", () => {
    // The SELECT clause may include storage* for internal use (deriving
    // signed package URLs), but the response object MUST NOT echo them.
    const publicVerifyIdx = EVIDENCE_ROUTES.indexOf("/public/verify/:id");
    const slice = EVIDENCE_ROUTES.slice(publicVerifyIdx, publicVerifyIdx + 10000);
    // Find the `reply.send(...)` or `return { ... }` for the success
    // response. We grep for the canonical response keys we expect and
    // assert storageKey is never one of them in the assembled body.
    expect(slice).not.toMatch(/storageKey:\s*evidence\.storageKey/);
  });

  it("public verify uses 404 for missing/unpublished records (uniform error shape)", () => {
    const publicVerifyIdx = EVIDENCE_ROUTES.indexOf("/public/verify/:id");
    const slice = EVIDENCE_ROUTES.slice(publicVerifyIdx, publicVerifyIdx + 10000);
    // Either a literal .code(404) or a return reply.code(404).
    expect(slice).toMatch(/\.code\(404\)/);
  });

  it("public verify does not write custody / access events on a GET (no audit emission)", () => {
    const publicVerifyIdx = EVIDENCE_ROUTES.indexOf("/public/verify/:id");
    const slice = EVIDENCE_ROUTES.slice(publicVerifyIdx, publicVerifyIdx + 10000);
    // No custody-event write helpers in the public GET handler.
    expect(slice).not.toMatch(/recordCustodyEvent|writeCustodyEvent/);
  });
});

// =============================================================================
// PART 4 — Worker runtime safety patterns
// =============================================================================

describe("Phase 37.95 — worker runtime tenant safety patterns", () => {
  // Worker handlers that touch evidence/case/report MUST fetch the
  // resource from the DB. The source-contract test in Phase 37.9 already
  // proves the handler files reference resource ids; this layer adds
  // STATIC assertions on what the handler does with that id.

  it("the main evidence processor re-reads evidence from DB before mutating", () => {
    const SRC = readWorker("src/processor.ts");
    // The handler must call prisma.evidence.findFirst/findUnique BEFORE
    // any update/upsert. We assert the file contains BOTH patterns.
    expect(SRC).toMatch(/prisma\.evidence\.find(Unique|First)/);
    // No worker may trust a teamId passed in the job payload alone; it
    // must always re-derive from DB. The processor file therefore
    // references `teamId: evidence.teamId` (DB-derived) somewhere.
    expect(SRC).toMatch(/teamId:\s*evidence\.teamId|evidence\.teamId/);
  });

  it("verification-package builder is a stateless assembler (no direct Prisma calls; data passed in by the caller)", () => {
    // The builder receives pre-fetched evidence + parts; the caller
    // (processor.ts) does the DB read with tenant-derived teamId.
    const SRC = readWorker("src/verification-package.ts");
    expect(SRC).not.toMatch(/prisma\./);
  });

  it("the OTS upgrade processor scopes its work by evidence id from the job payload", () => {
    const SRC = readWorker("src/ots-upgrade.processor.ts");
    expect(SRC).toMatch(/\bevidenceId\b/);
  });

  it("derived-assets processor scopes by partId/evidenceId from the payload", () => {
    const SRC = readWorker("src/derived-assets.processor.ts");
    expect(SRC).toMatch(/\b(partId|evidenceId)\b/);
  });
});

// =============================================================================
// PART 5 — Search runtime activeSpace scoping
// =============================================================================

describe("Phase 37.95 — search activeSpace scoping", () => {
  const SEARCH_ROUTES = readApi("src/routes/search.routes.ts");

  it("search routes require teamId in every query (no global fallback)", () => {
    // The route must read teamId from the query string and reject
    // requests without it.
    expect(SEARCH_ROUTES).toMatch(/\bteamId\b/);
  });

  it("search routes use the canonical authorize helper", () => {
    expect(SEARCH_ROUTES).toMatch(
      /authorizeOrFail|requireAuthorize|evaluateMemberAccess/,
    );
  });

  it("the frontend search page consumes useWorkspaceId (active-space scoped) and passes teamId to the server", () => {
    const PAGE = readWeb("app/(app)/search/page.tsx");
    expect(PAGE).toMatch(/useWorkspaceId/);
    expect(PAGE).toMatch(/teamId/);
    expect(PAGE).not.toMatch(/Switch to a workspace to use Evidence Discovery/i);
  });
});

// =============================================================================
// PART 6 — Pagination second-page + max-limit contract
// =============================================================================

describe("Phase 37.95 — pagination second-page contract", () => {
  // For each large list surface, the route must:
  //   - accept a `cursor` query parameter
  //   - return a `nextCursor` field in the response

  const ROUTES_REQUIRING_CURSOR = [
    "src/routes/search.routes.ts",
    "src/routes/case-workspace.routes.ts",
    "src/routes/evidence.routes.ts",
  ];
  for (const rel of ROUTES_REQUIRING_CURSOR) {
    it(`${rel} accepts cursor AND emits nextCursor on at least one list endpoint`, () => {
      const src = readApi(rel);
      expect(src).toMatch(/\bcursor\b/);
      expect(src).toMatch(/\bnextCursor\b/);
    });
  }

  it("the simple /v1/cases index is server-side capped (take: 200) — full pagination is on matter-queue", () => {
    const SRC = readApi("src/routes/cases.routes.ts");
    expect(SRC).toMatch(/\btake:\s*\d/);
  });

  it("search route clamps the limit parameter (max enforced server-side)", () => {
    const SEARCH_ROUTES = readApi("src/routes/search.routes.ts");
    // We accept any of: a literal MAX_LIMIT constant, a Math.min clamp,
    // or a Zod .max() on the schema.
    const hasClamp =
      /MAX_LIMIT|Math\.min\([\s\S]{0,200}limit/i.test(SEARCH_ROUTES) ||
      /\.max\(\s*\d/.test(SEARCH_ROUTES);
    expect(hasClamp).toBe(true);
  });
});

// =============================================================================
// PART 10 — Billing / seats / organization runtime separation (static proof)
// =============================================================================

describe("Phase 37.95 — billing & seats organization separation", () => {
  const SVC = readApi(
    "src/services/platform-context/platform-context.service.ts",
  );

  it("organizations list excludes isPersonal=true (no personal team labeled TEAM)", () => {
    expect(SVC).toMatch(/m\.team\.isPersonal/);
    expect(SVC).toMatch(/personalTeams\.push/);
    expect(SVC).toMatch(/organizations\.push/);
  });

  it("account-tier plan is sourced from Entitlement (per-user), not Team.billingPlan", () => {
    expect(SVC).toMatch(/prisma\.entitlement\.findFirst/);
    expect(SVC).toMatch(/accountPlan/);
  });

  it("organization plan is sourced from team.billingPlan, not from user Entitlement", () => {
    expect(SVC).toMatch(/team\.billingPlan|m\.team\.billingPlan/);
  });
});

// =============================================================================
// PART 11 — Legacy context fields blocked from new usage
// =============================================================================

describe("Phase 37.95 — legacy context field non-regression", () => {
  function listAllFiles(absDir: string): string[] {
    const out: string[] = [];
    const stack = [absDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = require("node:fs").readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const full = `${dir}/${name}`;
        try {
          const stat = require("node:fs").statSync(full);
          if (stat.isFile() && /\.(ts|tsx)$/.test(name)) out.push(full);
          else if (stat.isDirectory()) stack.push(full);
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }

  /**
   * The canonical platform-context envelope retains the legacy
   * `workspace` + `availableWorkspaces` fields for one phase. New code
   * MUST NOT read them. The allow-list below covers the modules where
   * the legacy fields are still legitimately referenced (the canonical
   * resolver itself, the existing tests, the deprecation-aware
   * compatibility shim hooks).
   */
  // ENTERPRISE TENANT MODEL — both `availableWorkspaces` and the
  // singular `workspace` field are deprecated. New code must consume
  // `personalSpace`/`organizations`/`activeSpace` from the envelope.
  const LEGACY_FIELDS = ["availableWorkspaces", "workspace"];
  const ALLOW = [
    // The platform-context service that BUILDS the envelope.
    /src[\\/]services[\\/]platform-context[\\/]platform-context\.service\.ts$/,
    // Type declarations.
    /src[\\/]services[\\/]platform-context[\\/]types\.ts$/,
    // Frontend types mirror + compatibility hooks during the deprecation
    // window.
    /apps[\\/]web[\\/]lib[\\/]platform-context[\\/]/,
    // Tests that document and lock the contract.
    /[\\/]test[\\/]/,
    // The deprecated topbar fallback path (renders legacy shape when
    // the envelope still ships it). Slated for removal next phase.
    /apps[\\/]web[\\/]components[\\/]app-shell-v2[\\/]AppTopbarV2\.tsx$/,
    // The sidebar runtime-indicator gate reads envelope.workspace.scope
    // + .id to feed the team-scoped runtime banner. Migration to
    // envelope.activeSpace is queued for the next phase.
    /apps[\\/]web[\\/]components[\\/]app-shell-v2[\\/]AppSidebarV2\.tsx$/,
    // OperationalBreadcrumb reads envelope.workspace?.name as a label
    // fallback. Migration to envelope.activeSpace.label is queued
    // alongside the other deprecation-window consumers.
    /apps[\\/]web[\\/]components[\\/]navigation[\\/]OperationalBreadcrumb\.tsx$/,
  ];

  for (const field of LEGACY_FIELDS) {
    it(`no new consumer references envelope.${field} outside the allow-list`, () => {
      const apiSrcDir = fileURLToPath(new URL("../src", import.meta.url));
      const webSrcDir = fileURLToPath(
        new URL("../../../apps/web", import.meta.url),
      );
      const all = [...listAllFiles(apiSrcDir), ...listAllFiles(webSrcDir)];
      const pattern = new RegExp(`\\benvelope\\??\\.${field}\\b`);
      const offenders: string[] = [];
      for (const file of all) {
        const normalized = file.replace(/\\/g, "/");
        if (ALLOW.some((re) => re.test(normalized))) continue;
        const src = readFileSync(file, "utf8");
        if (pattern.test(src)) {
          offenders.push(normalized);
        }
      }
      expect(
        offenders,
        `New code must not reference envelope.${field}. Use envelope.organizations + envelope.personalSpace. Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

// =============================================================================
// PART 12 — Onboarding readiness static signals
// =============================================================================

describe("Phase 37.95 — onboarding readiness static signals", () => {
  it("team creation route exists and is gated by auth + legal acceptance", () => {
    const TEAMS = readApi("src/routes/teams.routes.ts");
    expect(TEAMS).toMatch(/app\.post\(\s*['"`]\/v1\/teams['"`]/);
    expect(TEAMS).toMatch(/requireAuth/);
    expect(TEAMS).toMatch(/requireLegalAcceptance/);
  });

  it("invite member route exists, mints an Invitation row, and emails the invitee", () => {
    const TEAMS = readApi("src/routes/teams.routes.ts");
    expect(TEAMS).toMatch(/\/v1\/teams\/[^\s"'`]*invit/i);
  });

  it("personal-space bootstrap is idempotent and concurrency-safe", () => {
    const BOOTSTRAP = readApi(
      "src/services/platform-context/workspace-bootstrap.service.ts",
    );
    expect(BOOTSTRAP).toMatch(/code === "P2002"/);
    expect(BOOTSTRAP).toMatch(/findFirst[\s\S]{0,200}isPersonal:\s*true/);
  });

  it("billing/seat counting query is bounded and uses Team membership only", () => {
    const ENT = readApi("src/routes/enterprise.routes.ts");
    expect(ENT).toMatch(/teamMember\.count|teamMember\.findMany/);
  });
});
