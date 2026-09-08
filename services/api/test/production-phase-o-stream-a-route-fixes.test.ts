/**
 * Phase O Stage 3 — Stream A route fixes regression pins.
 *
 * Four production Sentry issues were converted from leaked ZodError /
 * undefined-delegate 500s into bounded 400/200 responses:
 *
 *   NODE-W  → GET /v1/ops/metrics            (ZodError teamId undefined)
 *   NODE-1G → GET /v1/reviewer-ops/queue     (ZodError teamId undefined / limit > 100)
 *   NODE-11 → GET /v1/reviewer-ops/console   (Cannot read 'groupBy' of undefined)
 *   NODE-1D → GET /v1/orgs/:id/members       (Invalid UUID ZodError)
 *
 * Style: source-contract (file-text). Matches the existing
 * `production-subscription-gate-stale-row.test.ts` and other
 * `production-*.test.ts` files. NO DB I/O. Pins the exact code
 * shape so a future refactor that re-introduces the ZodError /
 * undefined-delegate failure mode fails CI.
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

const OPS_ROUTES = readApi("src/routes/ops.routes.ts");
const REVIEWER_OPS_ROUTES = readApi("src/routes/reviewer-ops.routes.ts");
const REVIEWER_CONSOLE_ROUTES = readApi(
  "src/routes/reviewer-console.routes.ts",
);
const ORGANIZATIONS_ROUTES = readApi("src/routes/organizations.routes.ts");

/*
 * Sentry NODE-W — SUPERSEDED, and by a stronger fix.
 *
 * WHAT NODE-W WAS
 * ---------------------------------------------------------------------------
 * `GET /v1/ops/metrics` ran `TeamIdQuery.parse(req.query)`. An operator who
 * called it without `?teamId=` — which every operator dashboard did, because
 * the payload never used the parameter — raised a ZodError that the central
 * error handler served as a 500 and Sentry captured. The Phase-O fix resolved
 * the caller's `currentWorkspaceId` first, ran `safeParse` on the RESOLVED
 * object, and returned a bounded 400 WORKSPACE_CONTEXT_REQUIRED when there was
 * no workspace to resolve. The four assertions below pinned exactly that.
 *
 * WHY THEY ARE NOT PINNED ANY MORE
 * ---------------------------------------------------------------------------
 * The bounded 400 was an improvement on a 500 and still the wrong answer.
 * `/v1/ops/metrics` projects the PROCESS-GLOBAL metric registry; the workspace
 * id never filtered anything, and after `1afd5e0f` moved the gate to
 * `requirePlatformAdmin` it did not authorize anything either. It was a
 * parameter with no remaining job, and it had a cost: a platform admin with no
 * `currentWorkspaceId` was refused a platform-wide read with "Select a
 * workspace to view operational metrics."
 *
 * ADM-P3-006 removed the parameter instead of handling it. The route is now a
 * deprecated alias registered against the canonical
 * `/v1/admin/platform/metrics` handler, which reads no query at all.
 *
 * THIS IS NOT A RELAXED ASSERTION. The original defect was "an absent teamId
 * produces an unhandled throw". The replacement below asserts something the
 * original could not: the handler cannot throw on the query, because it never
 * touches it. `expect(...).not.toMatch` on the parse call is the same defect
 * closed at its root, and the executed proof — a platform admin receiving 200
 * with no `?teamId=` — is in `test/deprecated-aliases.integration.test.ts`.
 */
describe("Sentry NODE-W /v1/ops/metrics — the query parameter is gone", () => {
  /** The alias registration, isolated so neighbouring routes cannot satisfy it. */
  const METRICS_ALIAS = (() => {
    const start = OPS_ROUTES.indexOf('"/v1/ops/metrics"');
    expect(start, "the /v1/ops/metrics registration is missing").toBeGreaterThan(
      -1,
    );
    return OPS_ROUTES.slice(start, start + 400);
  })();

  it("registers the canonical platform handler, not a second implementation", () => {
    expect(METRICS_ALIAS).toContain("platformMetricsHandler");
    expect(METRICS_ALIAS).toContain("requirePlatformAdmin");
  });

  it("neither parses nor resolves a workspace", () => {
    // The three things the old handler did, none of which can be reached now.
    expect(METRICS_ALIAS).not.toMatch(/TeamIdQuery\./);
    expect(METRICS_ALIAS).not.toMatch(/currentWorkspaceId/);
    expect(METRICS_ALIAS).not.toMatch(/requireOpsActor/);
  });

  it("no longer refuses a platform read for want of a workspace", () => {
    // The bounded 400 was correct for a route that needed a workspace. This
    // one never did, so the message must be gone from the file entirely — a
    // stray copy would mean a second handler had grown back.
    expect(OPS_ROUTES).not.toContain(
      "Select a workspace to view operational metrics",
    );
  });

  it("the canonical handler it delegates to reads no query", () => {
    const telemetry = readApi(
      "src/routes/admin-platform-telemetry.routes.ts",
    );
    const handler = telemetry.slice(
      telemetry.indexOf("export const platformMetricsHandler"),
    );
    const body = handler.slice(0, handler.indexOf("\n};"));
    expect(body).not.toMatch(/req\.query/);
    expect(body).toContain("snapshotMetrics()");
  });
});

describe("Phase O Stream A — Sentry NODE-1G /v1/reviewer-ops/queue", () => {
  it("resolves teamId from currentWorkspaceId before parsing", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /\/v1\/reviewer-ops\/queue[\s\S]{0,2400}currentWorkspaceId: true/,
    );
  });

  it("returns bounded 400 WORKSPACE_CONTEXT_REQUIRED when no workspace", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /code: "WORKSPACE_CONTEXT_REQUIRED"[\s\S]{0,400}Select a workspace to view the reviewer queue/,
    );
  });

  it("uses safeParse and surfaces INVALID_QUERY on failure", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /QueueQuery\.safeParse/,
    );
    expect(REVIEWER_OPS_ROUTES).toMatch(/code: "INVALID_QUERY"/);
  });

  it("preserves the limit cap at 100 with default 50", () => {
    expect(REVIEWER_OPS_ROUTES).toMatch(
      /\.max\(100\)\.optional\(\)\.default\(50\)/,
    );
  });
});

describe("Phase O Stream A — Sentry NODE-11 /v1/reviewer-ops/console", () => {
  it("takes the injected prismaClient through Fastify's opts, not a bare positional arg", () => {
    // Fastify calls plugins as (app, opts). A bare second positional
    // parameter is bound to Fastify's options object on every real
    // registration, which silently makes `client` a plain `{}`.
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /opts:\s*FastifyPluginOptions\s*&\s*\{\s*prismaClient\?:\s*PrismaClient\s*\}/,
    );
    expect(REVIEWER_CONSOLE_ROUTES).not.toMatch(/prismaClient\?: PrismaClient,/);
  });

  it("re-anchors every service call to a local `client` constant", () => {
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /const client: PrismaClient = opts\.prismaClient \?\? prisma;/,
    );
    // No remaining bare `prismaClient,` references inside the handler.
    expect(REVIEWER_CONSOLE_ROUTES).not.toMatch(/^\s+prismaClient,$/m);
  });

  it("uses safeParse on the query schema with bounded 400 on failure", () => {
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(/ConsoleQuery\.safeParse/);
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /code: "INVALID_QUERY"[\s\S]{0,400}requestId: req\.id/,
    );
  });

  it("wraps the SLA composition defensively (degraded on undefined shape)", () => {
    // The post-Promise.all SLA composition must NOT throw when
    // `dashboardSection.value` is a partially-shaped object missing
    // `counts`. We guard it inside its own try and degrade honestly.
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /let slaSnapshot:[\s\S]{0,400}let slaStatus: SectionStatus/,
    );
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /reviewer_console\.section_failed/,
    );
  });
});

describe("Phase O Stream A — Sentry NODE-1D /v1/orgs/:id/members", () => {
  it("uses UuidParam.safeParse (never .parse) on :id", () => {
    expect(ORGANIZATIONS_ROUTES).toMatch(
      /\/v1\/orgs\/:id\/members[\s\S]{0,1400}UuidParam\.safeParse\(\s*\(req\.params as \{ id: string \}\)\.id,?\s*\)/,
    );
  });

  it("returns bounded 400 INVALID_ORG_ID on invalid UUID", () => {
    expect(ORGANIZATIONS_ROUTES).toMatch(
      /code: "INVALID_ORG_ID"[\s\S]{0,400}Invalid organization id\./,
    );
  });

  it("emits requestId on the bounded error response", () => {
    expect(ORGANIZATIONS_ROUTES).toMatch(
      /code: "INVALID_ORG_ID"[\s\S]{0,400}requestId: req\.id/,
    );
  });
});
