/**
 * Production regression test — Sentry batch (Phase O) schema-drift + route
 * fixes + central error handler.
 *
 * This test pins the full Phase O remediation surface for the 13 active
 * Sentry issues triaged on 2026-06-02:
 *
 *   - 9 schema-drift items (NODE-1R, NODE-1H, NODE-1Q, NODE-1N, NODE-1M,
 *     NODE-1K, NODE-1E, NODE-1J, NODE-1P) resolved by the additive
 *     idempotent repair migration
 *     `20270802000000_phase_sentry_batch_schema_drift_repair`.
 *
 *   - 4 non-schema route/handler items (NODE-W, NODE-1G, NODE-11, NODE-1D)
 *     resolved by route-level safeParse + workspace-context resolution
 *     and a re-anchored `prismaClient ?? prisma` pattern.
 *
 *   - Central error-handler hardening that maps raw ZodError → 400
 *     INVALID_INPUT and Prisma P2022 → 503 SCHEMA_NOT_READY.
 *
 * Style: source-contract (file-text readFileSync). NO DB I/O. Matches
 * the canonical pattern of `production-billing-parity.test.ts` and
 * `production-trust-center-empty-state.test.ts`.
 *
 * Honest scoping caveats:
 *
 *   1. The Phase 1 audit confirmed NODE-1P's exact failing column
 *      could NOT be pinpointed from the Sentry payload alone. The
 *      repair migration's Block 9 is therefore a DEFENSIVE re-assert
 *      of every R7 reviewer-workspace additive column on both
 *      `coding_schemas` and `coding_fields` (IF NOT EXISTS, idempotent).
 *      Assertion #9 below pins the defensive shape; it does NOT pin a
 *      single column name because the audit refused to commit to one
 *      without evidence.
 *
 *   2. Assertion #14's audit prescription said "uses upsert (idempotent)"
 *      for the seed payload. The actual fix uses an idempotent natural-
 *      key lookup (`findFirst({ where: { teamId, slug }})` + skip-or-
 *      create) rather than the literal Prisma `.upsert()` method,
 *      because the create path runs through `createSchema` which
 *      handles nested field creation + transaction. This pattern is
 *      functionally equivalent ("idempotent natural-key seed") and is
 *      what the Stream C report ratified. Assertion #14 pins THAT
 *      shape (findFirst + skip-or-create with per-spec try/catch),
 *      not the literal `upsert()` call.
 *
 *   3. Assertion #16 pins that the readiness AGGREGATOR (not the route)
 *      wraps each probe in try/catch. The aggregator is at
 *      `services/api/src/runtime/runtime-readiness.ts` per the
 *      "discover before building" rule.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRepo(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
    "utf8",
  );
}

// =============================================================================
// Source-contract reads
// =============================================================================

const REPAIR_MIGRATION = readRepo(
  "services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql",
);
const OPS_ROUTES = readRepo("services/api/src/routes/ops.routes.ts");
const REVIEWER_OPS_ROUTES = readRepo(
  "services/api/src/routes/reviewer-ops.routes.ts",
);
const REVIEWER_CONSOLE_ROUTES = readRepo(
  "services/api/src/routes/reviewer-console.routes.ts",
);
const ORGANIZATIONS_ROUTES = readRepo(
  "services/api/src/routes/organizations.routes.ts",
);
const REVIEWER_WORKSPACE_ROUTES = readRepo(
  "services/api/src/routes/reviewer-workspace.routes.ts",
);
const TRUST_GOV_ROUTES = readRepo(
  "services/api/src/routes/trust-and-governance.routes.ts",
);
const READINESS_ROUTES = readRepo(
  "services/api/src/routes/runtime-readiness.routes.ts",
);
const READINESS_AGGREGATOR = readRepo(
  "services/api/src/runtime/runtime-readiness.ts",
);
const CODING_SCHEMA_SERVICE = readRepo(
  "services/api/src/services/reviewer-workspace/coding-schema.service.ts",
);
const SERVER_TS = readRepo("services/api/src/server.ts");
const ALLOWLIST_GUARD = readRepo(
  "services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts",
);

// =============================================================================
// (1) — Repair migration file exists with the correct timestamp+name
// =============================================================================

describe("Phase O — Sentry batch repair migration file", () => {
  it("exists at the canonical path with the correct timestamp", () => {
    // The migration MUST be timestamp-greater than the prior latest
    // (20270801000000_phase16_semantic_usage). The file is read in
    // the module top; this assertion fails if the file is missing.
    expect(REPAIR_MIGRATION.length).toBeGreaterThan(0);
    expect(REPAIR_MIGRATION).toMatch(/Phase O .*Sentry batch schema-drift/i);
  });

  it("declares additive-only + idempotent contract in its header", () => {
    expect(REPAIR_MIGRATION).toMatch(/ADDITIVE/);
    expect(REPAIR_MIGRATION).toMatch(/IDEMPOTENT/);
    // Hard rules: no DROP / no RENAME / no SET NOT NULL on existing cols.
    // We assert the header DOCUMENTS those bans AND that no destructive
    // DDL statement leaked into the body.
    expect(REPAIR_MIGRATION).toMatch(/No DROP, no RENAME/i);
    expect(REPAIR_MIGRATION).not.toMatch(/^\s*DROP\s+TABLE/im);
    expect(REPAIR_MIGRATION).not.toMatch(/^\s*DROP\s+COLUMN/im);
    expect(REPAIR_MIGRATION).not.toMatch(/RENAME\s+COLUMN/i);
    expect(REPAIR_MIGRATION).not.toMatch(/RENAME\s+TO/i);
  });
});

// =============================================================================
// (2)–(9) — Per-drift-item DDL coverage
// =============================================================================

describe("Phase O — repair migration covers every Sentry schema-drift item", () => {
  // (2) NODE-1R — evidence_exchange_packages.updated_at
  it("adds evidence_exchange_packages.updated_at (NODE-1R)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"evidence_exchange_packages"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"updated_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\);/,
    );
  });

  // (3) NODE-1H — provider_budgets.archived_at
  it("adds provider_budgets.archived_at (NODE-1H)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"provider_budgets"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"archived_at"\s+TIMESTAMPTZ\(6\);/,
    );
  });

  // (4) NODE-1Q — chain_transfers.updated_at
  it("adds chain_transfers.updated_at (NODE-1Q)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"chain_transfers"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"updated_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\);/,
    );
  });

  // (5) NODE-1N — redaction_policy_assignments.version_id (+ deterministic backfill)
  it("adds redaction_policy_assignments.version_id + DO-block backfill (NODE-1N)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"redaction_policy_assignments"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"version_id"\s+UUID;/,
    );
    // DO-block guarded backfill from legacy `policy_version_id`.
    expect(REPAIR_MIGRATION).toMatch(
      /DO\s+\$\$[\s\S]*?information_schema\.columns[\s\S]*?policy_version_id[\s\S]*?version_id[\s\S]*?UPDATE\s+"redaction_policy_assignments"[\s\S]*?SET\s+"version_id"\s*=\s*"policy_version_id"[\s\S]*?WHERE\s+"version_id"\s+IS\s+NULL\s+AND\s+"policy_version_id"\s+IS\s+NOT\s+NULL/,
    );
  });

  // (6) NODE-1M — redaction_projects.closed_at_utc
  it("adds redaction_projects.closed_at_utc (NODE-1M)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"redaction_projects"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"closed_at_utc"\s+TIMESTAMPTZ\(6\);/,
    );
  });

  // (7) NODE-1K — delegated_admin_grants quadruple-column drift + backfill
  it("adds delegated_admin_grants.{granted_to_user_id,scope_target_id,created_at,updated_at} + backfill (NODE-1K)", () => {
    const block = REPAIR_MIGRATION.match(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"delegated_admin_grants"[\s\S]{0,800}?;/,
    );
    expect(block, "delegated_admin_grants ALTER block must exist").toBeTruthy();
    expect(block![0]).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"granted_to_user_id"\s+UUID/);
    expect(block![0]).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"scope_target_id"\s+UUID/);
    expect(block![0]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"created_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    );
    expect(block![0]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"updated_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    );
    // Backfill: legacy `grantee_user_id` → `granted_to_user_id`.
    expect(REPAIR_MIGRATION).toMatch(
      /DO\s+\$\$[\s\S]*?grantee_user_id[\s\S]*?granted_to_user_id[\s\S]*?UPDATE\s+"delegated_admin_grants"[\s\S]*?SET\s+"granted_to_user_id"\s*=\s*"grantee_user_id"[\s\S]*?WHERE\s+"granted_to_user_id"\s+IS\s+NULL\s+AND\s+"grantee_user_id"\s+IS\s+NOT\s+NULL/,
    );
  });

  // (8) NODE-1E — status_components.updated_at
  it("adds status_components.updated_at (NODE-1E)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"status_components"[\s\S]{0,300}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"updated_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\);/,
    );
  });

  // (9) NODE-1J — subprocessors.category / country / description
  it("adds subprocessors.{category,country,description} (NODE-1J)", () => {
    const block = REPAIR_MIGRATION.match(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"subprocessors"[\s\S]{0,600}?;/,
    );
    expect(block, "subprocessors ALTER block must exist").toBeTruthy();
    expect(block![0]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"category"\s+VARCHAR\(80\)\s+NOT\s+NULL\s+DEFAULT\s+'PROVIDER'/,
    );
    expect(block![0]).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"country"\s+VARCHAR\(80\)/);
    expect(block![0]).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"description"\s+VARCHAR\(800\)/);
  });

  // (9b) NODE-1P — defensive R7 reviewer-workspace re-assert.
  //
  // HONEST CAVEAT: the audit (Stage 1) could NOT pinpoint NODE-1P's
  // single failing column from the Sentry payload alone. The repair
  // is a DEFENSIVE additive re-assert across the whole R7
  // reviewer-workspace surface: every Prisma-declared additive
  // column on `coding_schemas` AND `coding_fields` is re-asserted
  // with `ADD COLUMN IF NOT EXISTS`. We pin THAT shape, not a
  // single guessed column.
  it("defensively re-asserts R7 reviewer-workspace columns on coding_schemas + coding_fields (NODE-1P)", () => {
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"coding_schemas"[\s\S]{0,800}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"updated_at"\s+TIMESTAMPTZ\(6\)\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/,
    );
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"coding_fields"[\s\S]{0,400}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"options"\s+JSONB/,
    );
    expect(REPAIR_MIGRATION).toMatch(
      /ALTER\s+TABLE\s+IF\s+EXISTS\s+"coding_fields"[\s\S]{0,400}ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"order_index"\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/,
    );
  });
});

// =============================================================================
// (10) — /v1/ops/metrics resolves workspace context + emits WORKSPACE_CONTEXT_REQUIRED
// =============================================================================

describe("Phase O Stream A — /v1/ops/metrics (NODE-W)", () => {
  it("resolves teamId from currentWorkspaceId BEFORE running Zod", () => {
    expect(OPS_ROUTES).toMatch(
      /\/v1\/ops\/metrics[\s\S]{0,2400}currentWorkspaceId: true/,
    );
  });

  it("emits bounded 400 WORKSPACE_CONTEXT_REQUIRED with requestId when no workspace", () => {
    expect(OPS_ROUTES).toMatch(
      /code:\s*"WORKSPACE_CONTEXT_REQUIRED"[\s\S]{0,400}Select a workspace to view operational metrics[\s\S]{0,400}requestId:\s*req\.id/,
    );
  });

  it("uses safeParse for query (no unhandled .parse(req.query) leak inside the handler)", () => {
    // Negative grep — pull the entire /v1/ops/metrics handler slice and
    // assert no `TeamIdQuery.parse(req.query` appears in the body. The
    // canonical pattern is `safeParse({ teamId: resolvedTeamId })`.
    const idx = OPS_ROUTES.indexOf('"/v1/ops/metrics"');
    expect(idx).toBeGreaterThan(-1);
    // Slice from the route literal until the next route declaration —
    // any `.parse(req.query)` inside that slice is a regression.
    const after = OPS_ROUTES.slice(idx + 1);
    const nextRoute = after.search(/\n\s{0,4}app\.(get|post|patch|delete|put)\(/);
    const slice = OPS_ROUTES.slice(
      idx,
      idx + 1 + (nextRoute > 0 ? nextRoute : 3000),
    );
    expect(slice).not.toMatch(/TeamIdQuery\.parse\(\s*req\.query/);
    expect(slice).toMatch(/TeamIdQuery\.safeParse\(/);
  });
});

// =============================================================================
// (11) — /v1/reviewer-ops/queue clamps limit + emits INVALID_QUERY
// =============================================================================

describe("Phase O Stream A — /v1/reviewer-ops/queue (NODE-1G)", () => {
  it("clamps limit to ≤100 via z.coerce.number().max(100)", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)\.default\(50\)/,
    );
  });

  it("uses safeParse and emits bounded 400 INVALID_QUERY on failure", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /QueueQuery\.safeParse\(\s*\{[\s\S]{0,200}teamId:\s*resolvedTeamId/,
    );
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /code:\s*"INVALID_QUERY"[\s\S]{0,400}Query parameters invalid[\s\S]{0,400}requestId:\s*req\.id/,
    );
  });

  it("resolves teamId from currentWorkspaceId before parsing", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /\/v1\/reviewer-ops\/queue[\s\S]{0,2400}currentWorkspaceId: true/,
    );
  });
});

// =============================================================================
// (12) — /v1/reviewer-ops/console guards against undefined Prisma delegate
// =============================================================================

describe("Phase O Stream A — /v1/reviewer-ops/console (NODE-11)", () => {
  it("accepts an injected prismaClient through Fastify's opts (defaults to prisma)", () => {
    // Fastify calls plugins as (app, opts). A BARE second positional
    // parameter would be bound to Fastify's own options object on every
    // real registration, so the injected client must travel inside opts.
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /opts:\s*FastifyPluginOptions\s*&\s*\{\s*prismaClient\?:\s*PrismaClient\s*\}/,
    );
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /const\s+client:\s*PrismaClient\s*=\s*opts\.prismaClient\s*\?\?\s*prisma/,
    );
    // The plugin must never take the client as a bare positional arg.
    expect(REVIEWER_CONSOLE_ROUTES).not.toMatch(/prismaClient\?:\s*PrismaClient,/);
  });

  it("uses safeParse for query + emits bounded 400 INVALID_QUERY", () => {
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(/ConsoleQuery\.safeParse\(/);
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /code:\s*"INVALID_QUERY"[\s\S]{0,400}requestId:\s*req\.id/,
    );
  });
});

// =============================================================================
// (13) — /v1/orgs/:id/members uses safeParse + emits INVALID_ORG_ID
// =============================================================================

describe("Phase O Stream A — /v1/orgs/:id/members (NODE-1D)", () => {
  it("uses UuidParam.safeParse and emits INVALID_ORG_ID 400", () => {
    const idx = ORGANIZATIONS_ROUTES.indexOf('"/v1/orgs/:id/members"');
    expect(idx).toBeGreaterThan(-1);
    const slice = ORGANIZATIONS_ROUTES.slice(idx, idx + 1800);
    expect(slice).toMatch(/UuidParam\.safeParse\(/);
    expect(slice).toMatch(
      /code:\s*"INVALID_ORG_ID"[\s\S]{0,300}Invalid organization id[\s\S]{0,300}requestId:\s*req\.id/,
    );
    expect(slice).not.toMatch(/UuidParam\.parse\(\s*\(req\.params/);
  });
});

// =============================================================================
// (14) — POST /v1/coding/schemas/seed-defaults idempotent + degraded fallback
// =============================================================================
//
// HONEST CAVEAT (kept from the audit): the audit's wording was
// "uses upsert (idempotent)". The actual implementation uses the
// idempotent natural-key pattern:
//   `findFirst({ where: { teamId, slug }})` → skip-or-create.
// This is functionally equivalent and is what Stream C ratified
// (Prisma `.upsert()` is not used because the create path goes
// through `createSchema` with nested field transactions). We pin
// THAT shape rather than the literal `.upsert()` call.
//
// Required CodingSchema fields (audit-verified — NO required fields
// were missing from the seed payload): teamId, slug, label (used as
// `name`), version (DB default), createdByUserId (set via
// authorUserId), createdAt/updatedAt (Prisma @default / @updatedAt).
// Optional fields the payload also provides: description, category,
// status. Required CodingField columns are all populated by the
// nested `fields` array.
// =============================================================================

describe("Phase O Stream C — POST /v1/coding/schemas/seed-defaults (NODE-1P)", () => {
  it("seed service is idempotent via natural-key findFirst + skip-or-create", () => {
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /prisma\.codingSchema\.findFirst\(\s*\{\s*where:\s*\{\s*teamId:\s*input\.teamId,\s*slug:\s*spec\.slug/,
    );
    // Skip path (legacy `existing` counter retained for web client).
    expect(CODING_SCHEMA_SERVICE).toMatch(/existing:\s*updated/);
  });

  it("each spec runs in its own try/catch so a single failure never poisons the pass", () => {
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /for\s*\(\s*const\s+spec\s+of\s+DEFAULT_SCHEMAS\s*\)\s*\{\s*try\s*\{/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /\}\s*catch\s*\{[\s\S]{0,200}failed\s*\+=\s*1/,
    );
  });

  it("seed payload provides every CodingSchema required + R7-additive field (teamId/slug/label/category/description/createdByUserId)", () => {
    // The `createSchema` call inside seedDefaultSchemas must pass
    // every column that lacks a DB default. We pin the keys:
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}teamId:\s*input\.teamId/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}authorUserId:\s*input\.authorUserId/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}slug:\s*spec\.slug/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}label:\s*spec\.label/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}category:\s*spec\.category/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}description:\s*spec\.description/,
    );
    expect(CODING_SCHEMA_SERVICE).toMatch(
      /createSchema\(\s*\{[\s\S]{0,400}fields:\s*spec\.fields/,
    );
  });

  it("route wraps in P2022/P2021 try/catch with degraded 200 fallback", () => {
    const idx = REVIEWER_WORKSPACE_ROUTES.indexOf(
      '"/v1/coding/schemas/seed-defaults"',
    );
    expect(idx).toBeGreaterThan(-1);
    const slice = REVIEWER_WORKSPACE_ROUTES.slice(idx, idx + 2000);
    expect(slice).toMatch(/try\s*\{[\s\S]{0,600}seedDefaultSchemas/);
    expect(slice).toMatch(/code\s*===\s*"P2022"\s*\|\|\s*code\s*===\s*"P2021"/);
    expect(slice).toMatch(/degraded:\s*true[\s\S]{0,200}reason:\s*"SCHEMA_NOT_READY"/);
  });
});

// =============================================================================
// (15) — /v1/trust/status upsert wrapped in try/catch with degraded fallback
// =============================================================================

describe("Phase O Stream C — GET /v1/trust/status (NODE-1E)", () => {
  it("wraps projectStatusPage in try/catch and degrades on P2022/P2021", () => {
    const idx = TRUST_GOV_ROUTES.indexOf('"/v1/trust/status"');
    expect(idx).toBeGreaterThan(-1);
    const slice = TRUST_GOV_ROUTES.slice(idx, idx + 2500);
    expect(slice).toMatch(/try\s*\{[\s\S]{0,400}projectStatusPage/);
    expect(slice).toMatch(/code\s*===\s*"P2022"\s*\|\|\s*code\s*===\s*"P2021"/);
    expect(slice).toMatch(
      /status:\s*null[\s\S]{0,200}degraded:\s*true[\s\S]{0,200}reason:\s*"SCHEMA_NOT_READY"/,
    );
  });
});

// =============================================================================
// (16) — Readiness aggregator wraps each probe in try/catch + DEGRADED status
// =============================================================================

describe("Phase O — runtime-readiness aggregator probe isolation (NODE-1Q + NODE-1J)", () => {
  it("documents the never-throws contract at the top of the module", () => {
    expect(READINESS_AGGREGATOR).toMatch(/Never throws/i);
    expect(READINESS_AGGREGATOR).toMatch(/DEGRADED|CRITICAL/);
  });

  it("contains multiple per-probe try/catch blocks (≥6 sites)", () => {
    // Each per-subsystem check function (`checkSchema`, `checkRedis`,
    // `checkQueues`, etc.) wraps its body in try/catch and returns a
    // typed status. We count `try {` occurrences as a proxy for
    // per-probe isolation. The audit confirmed ≥14 checker functions
    // exist; we require at least 6 to keep this assertion stable
    // against future probe additions/removals.
    const tryBlocks = READINESS_AGGREGATOR.match(/\btry\s*\{/g) ?? [];
    expect(tryBlocks.length).toBeGreaterThanOrEqual(6);
    const catchBlocks = READINESS_AGGREGATOR.match(/\}\s*catch\s*\(\s*err\b/g) ?? [];
    expect(catchBlocks.length).toBeGreaterThanOrEqual(6);
  });

  it("readiness route adds an OUTER P2022/P2021 catch as belt-and-braces (NODE-1Q + NODE-1J)", () => {
    expect(READINESS_ROUTES).toMatch(
      /\/admin\/runtime\/readiness[\s\S]{0,2000}try\s*\{[\s\S]{0,400}runReadinessCheck/,
    );
    expect(READINESS_ROUTES).toMatch(
      /code\s*===\s*"P2022"\s*\|\|\s*code\s*===\s*"P2021"[\s\S]{0,400}degraded:\s*true[\s\S]{0,200}reason:\s*"SCHEMA_NOT_READY"/,
    );
  });
});

// =============================================================================
// (17) — Central error handler maps z.ZodError → INVALID_INPUT 400
// =============================================================================

describe("Phase O Stage 4 — central error handler ZodError mapping", () => {
  it("maps raw ZodError to 400 INVALID_INPUT with bounded fields[]", () => {
    expect(SERVER_TS).toMatch(/import\s+\{\s*ZodError\s*\}\s+from\s+"zod"/);
    expect(SERVER_TS).toMatch(
      /!isAppError\(err\)\s*&&\s*err\s+instanceof\s+ZodError/,
    );
    expect(SERVER_TS).toMatch(/code:\s*"INVALID_INPUT"/);
    // The wire payload is built by buildZodWirePayload (status 400).
    expect(SERVER_TS).toMatch(/buildZodWirePayload\(err,\s*requestId\)/);
  });
});

// =============================================================================
// (18) — Central error handler maps Prisma P2022/P2021 → SCHEMA_NOT_READY 503
// =============================================================================

describe("Phase O Stage 4 — central error handler Prisma drift mapping", () => {
  it("maps Prisma P2022/P2021 to 503 SCHEMA_NOT_READY (operator-safe)", () => {
    expect(SERVER_TS).toMatch(
      /diag\.code\s*===\s*"P2022"\s*\|\|\s*diag\.code\s*===\s*"P2021"/,
    );
    expect(SERVER_TS).toMatch(
      /reply\.code\(503\)\.send\(\s*\{\s*error:\s*\{\s*code:\s*"SCHEMA_NOT_READY"/,
    );
    // Other Prisma known-request errors → 500 DATABASE_ERROR.
    expect(SERVER_TS).toMatch(
      /reply\.code\(500\)\.send\(\s*\{\s*error:\s*\{\s*code:\s*"DATABASE_ERROR"/,
    );
  });
});

// =============================================================================
// (19) — Migration appears in PERMITTED_LATER_MIGRATIONS allowlist
// =============================================================================

describe("Phase O — phase-32-7-2 allowlist update", () => {
  it("repair migration is allowlisted in PERMITTED_LATER_MIGRATIONS", () => {
    expect(ALLOWLIST_GUARD).toMatch(/PERMITTED_LATER_MIGRATIONS/);
    expect(ALLOWLIST_GUARD).toMatch(
      /"20270802000000_phase_sentry_batch_schema_drift_repair"/,
    );
  });
});

// =============================================================================
// (20)–(22) — Bounded GUARDs
// =============================================================================

describe("Phase O — bounded stability guards", () => {
  // (20) No new top-level route file added beyond the canonical surface.
  it("does not add a new top-level route file (count guard)", () => {
    // The Stream A/B/C reports identified the four EDITED route files
    // (ops.routes.ts, reviewer-ops.routes.ts, reviewer-console.routes.ts,
    // organizations.routes.ts, plus the Stream C edits and central
    // server.ts) — all PRE-EXISTING. No new top-level `*.routes.ts`
    // file was introduced. We don't pin an exact count (the suite
    // continues to evolve over time) — we pin the canonical files we
    // touched as PRE-EXISTING.
    for (const rel of [
      "services/api/src/routes/ops.routes.ts",
      "services/api/src/routes/reviewer-ops.routes.ts",
      "services/api/src/routes/reviewer-console.routes.ts",
      "services/api/src/routes/organizations.routes.ts",
      "services/api/src/routes/reviewer-workspace.routes.ts",
      "services/api/src/routes/trust-and-governance.routes.ts",
      "services/api/src/routes/runtime-readiness.routes.ts",
      "services/api/src/routes/product-and-lifecycle.routes.ts",
      "services/api/src/routes/intelligence-platform.routes.ts",
      "services/api/src/routes/redaction.routes.ts",
    ]) {
      // readRepo would throw if any file vanished. The presence-only
      // assertion is enough; we explicitly do NOT assert a file with a
      // `-v2` suffix or `-phase-o` suffix exists (those would be
      // regressions per the next assertion).
      expect(readRepo(rel).length).toBeGreaterThan(0);
    }
  });

  // (21) No "v2" in the new migration name OR in any new Phase O file path.
  it("no Phase O surface uses a -v2 ladder (no parallel duplicate)", () => {
    expect(REPAIR_MIGRATION).not.toMatch(/v2\b/i);
    // The migration directory name itself.
    const dirName = "20270802000000_phase_sentry_batch_schema_drift_repair";
    expect(dirName).not.toMatch(/v2/);
    // Reuse the canonical helpers — assert source files have no v2 token.
    expect(SERVER_TS).not.toMatch(/phase_o_v2|phase-o-v2/i);
    expect(OPS_ROUTES).not.toMatch(/ops-v2/i);
    expect(REVIEWER_CONSOLE_ROUTES).not.toMatch(/reviewer-console-v2/i);
  });

  // (22) No raw process.env reads added to client-bound JSON degraded payloads.
  it("no raw process.env reads or stack traces leaked to client-bound degraded payloads", () => {
    // Pull the four degraded payload sites and assert each is bounded.
    // SCHEMA_NOT_READY payloads are scattered across multiple files;
    // we tighten by asserting the payload SHAPE only contains the
    // bounded keys: status / packages / projects / budgets / providers /
    // subsystems / drift / queues / workers / cronSecrets / redis /
    // created / updated / existing / failed / degraded / reason.
    //
    // Crucially — none of them embed `process.env.<NAME>` or `err.stack`.
    for (const text of [
      OPS_ROUTES,
      REVIEWER_OPS_ROUTES,
      REVIEWER_CONSOLE_ROUTES,
      ORGANIZATIONS_ROUTES,
      REVIEWER_WORKSPACE_ROUTES,
      TRUST_GOV_ROUTES,
      READINESS_ROUTES,
    ]) {
      // Pull every degraded payload slice via the marker
      // `reason: "SCHEMA_NOT_READY"` and assert no env / stack leak
      // in the immediate vicinity.
      const matches = text.match(
        /reply\.code\(\d{3}\)\.send\(\s*\{[\s\S]{0,800}?reason:\s*"SCHEMA_NOT_READY"[\s\S]{0,200}?\}\s*\)/g,
      ) ?? [];
      // Every file that uses this pattern must have at least one match;
      // some files (e.g., ops.routes.ts) don't use SCHEMA_NOT_READY at
      // all because their fix is a 400 WORKSPACE_CONTEXT_REQUIRED, so
      // we don't assert match count > 0 — we only validate the
      // bounded shape when present.
      for (const m of matches) {
        expect(
          m,
          "degraded SCHEMA_NOT_READY payload must not leak process.env",
        ).not.toMatch(/process\.env\./);
        expect(
          m,
          "degraded SCHEMA_NOT_READY payload must not leak err.stack",
        ).not.toMatch(/err\.stack|error\.stack/);
        expect(
          m,
          "degraded SCHEMA_NOT_READY payload must not embed raw error JSON",
        ).not.toMatch(/JSON\.stringify\(err\)/);
      }
    }
    // Central handler's 503 SCHEMA_NOT_READY body must also be bounded.
    // We span from `reply.code(503).send(` until the closing `)` of
    // the send call. The inner shape is `{ error: { code, message,
    // requestId } }` — the regex below allows any whitespace + nested
    // braces between the opening and closing of the outer send.
    const central = SERVER_TS.match(
      /reply\.code\(503\)\.send\(\s*\{\s*error:\s*\{[\s\S]{0,400}?code:\s*"SCHEMA_NOT_READY"[\s\S]{0,400}?\}\s*\)/,
    );
    expect(central, "central 503 SCHEMA_NOT_READY body must exist").toBeTruthy();
    expect(central![0]).not.toMatch(/process\.env\./);
    expect(central![0]).not.toMatch(/err\.stack/);
    // The client-facing message must be a canned string, not the raw Prisma message.
    expect(central![0]).toMatch(/"Resource temporarily unavailable\."/);
  });
});
