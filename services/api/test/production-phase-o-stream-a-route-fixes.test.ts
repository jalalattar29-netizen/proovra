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

describe("Phase O Stream A — Sentry NODE-W /v1/ops/metrics", () => {
  it("resolves teamId from currentWorkspaceId before parsing", () => {
    // The handler must look up the active workspace from the user
    // record when the query lacks teamId, BEFORE running Zod.
    expect(OPS_ROUTES).toMatch(
      /\/v1\/ops\/metrics[\s\S]{0,2400}currentWorkspaceId: true/,
    );
  });

  it("returns bounded 400 WORKSPACE_CONTEXT_REQUIRED when no workspace", () => {
    expect(OPS_ROUTES).toMatch(
      /code: "WORKSPACE_CONTEXT_REQUIRED"[\s\S]{0,400}Select a workspace to view operational metrics/,
    );
  });

  it("uses safeParse (never .parse) for the resolved object", () => {
    expect(OPS_ROUTES).toMatch(
      /\/v1\/ops\/metrics[\s\S]{0,2800}TeamIdQuery\.safeParse/,
    );
  });

  it("emits requestId on the bounded error response", () => {
    expect(OPS_ROUTES).toMatch(
      /code: "WORKSPACE_CONTEXT_REQUIRED"[\s\S]{0,400}requestId: req\.id/,
    );
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
  it("declares the prismaClient parameter as optional", () => {
    // Signature must tolerate undefined explicitly so a Fastify
    // wrapper or a test shim that passes `undefined` does not bind
    // every Prisma delegate call to undefined.
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /prismaClient\?: PrismaClient,/,
    );
  });

  it("re-anchors every service call to a local `client` constant", () => {
    expect(REVIEWER_CONSOLE_ROUTES).toMatch(
      /const client: PrismaClient = prismaClient \?\? prisma;/,
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
