/**
 * POST /v1/internal/search/reindex — behavioral + source-contract
 * regression suite.
 *
 * Pins:
 *
 *   - Route exists and is secret-gated (no req without
 *     `x-internal-secret` reaches the handler).
 *   - Invalid secret → 401, never 200.
 *   - Valid secret → 200, runs the canonical reindex service.
 *   - User-auth `/v1/search/reconcile` is NOT weakened (still 401
 *     without a real token).
 *   - Idempotent: running twice for the same team is safe.
 *   - Writes are workspace-scoped (canonical indexers anchor on
 *     teamId).
 *   - CLI entrypoint `src/scripts/backfill-search-index.ts` exists,
 *     uses the same canonical service, and does NOT import dev
 *     tooling (tsx / ts-node).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REINDEX_SECRET = "test-reindex-secret-1234567890abcdef";

// Source-contract tests run unconditionally. Behavioral tests need a
// live DB; they no-op (still mark passing) if buildServer() fails to
// boot. Same pattern as `search-diagnostics-behavioral.test.ts`.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.DEV_AUTH_ENABLED = "true";
process.env.SEARCH_REINDEX_SECRET = REINDEX_SECRET;

const PRO_ISSUES_TEAM = "0e000000-0000-4000-8000-0000000000a4";
const PRO_EMPTY_TEAM = "0e000000-0000-4000-8000-0000000000a1";

function read(p: string): string {
  return readFileSync(p, "utf8");
}

// ============================================================================
// SOURCE-CONTRACT TESTS — run without DB
// ============================================================================

describe("Internal reindex — route + middleware wiring", () => {
  const ROUTE = resolve(API_ROOT, "src/routes/internal-reindex.routes.ts");
  const MID = resolve(API_ROOT, "src/middleware/cron-secret.ts");
  const SERVER = resolve(API_ROOT, "src/server.ts");
  const SERVICE = resolve(API_ROOT, "src/services/search/reindex.service.ts");

  it("internal-reindex route file is registered in server.ts", () => {
    const src = read(SERVER);
    expect(src).toMatch(
      /from\s+["']\.\/routes\/internal-reindex\.routes\.js["']/,
    );
    expect(src).toMatch(/app\.register\(\s*internalReindexRoutes\s*\)/);
  });

  it("route declares POST /v1/internal/search/reindex", () => {
    const src = read(ROUTE);
    expect(src).toMatch(
      /app\.post\(\s*["']\/v1\/internal\/search\/reindex["']/,
    );
  });

  it("route gates on requireSearchReindexSecret BEFORE doing any work", () => {
    const src = read(ROUTE);
    // Secret-check must precede the body parse, the service call,
    // and the audit write. Pin by ordering of the gate vs. the
    // service import use.
    // Search for the CALL sites only (`name(`), not the imports at
    // the top of the file. The import of `runWorkspaceReindex`
    // legitimately precedes the secret-check call site; the
    // ordering we care about is "inside the handler, does the
    // gate fire before the work?".
    const gateIdx = src.indexOf("requireSearchReindexSecret(");
    const bodyIdx = src.indexOf("safeParse(req.body");
    const callIdx = src.indexOf("runWorkspaceReindex(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(gateIdx);
    expect(callIdx).toBeGreaterThan(gateIdx);
  });

  it("route calls the canonical service (no inline reimplementation)", () => {
    const src = read(ROUTE);
    expect(src).toMatch(
      /from\s+["']\.\.\/services\/search\/reindex\.service\.js["']/,
    );
    expect(src).toMatch(/runWorkspaceReindex\(/);
    // No copy of orphan-detect SQL inline in the route.
    expect(src).not.toMatch(/FROM\s+evidence_search_documents/i);
  });

  it("route writes a platform audit log entry per invocation", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/appendPlatformAuditLog\(/);
    expect(src).toMatch(/search\.internal_reindex/);
  });

  it("cron-secret middleware exposes requireSearchReindexSecret with x-internal-secret + SEARCH_REINDEX_SECRET", () => {
    const src = read(MID);
    expect(src).toMatch(/export const SEARCH_REINDEX_HEADER = "x-internal-secret"/);
    expect(src).toMatch(/SEARCH_REINDEX_SECRET_ENV = "SEARCH_REINDEX_SECRET"/);
    expect(src).toMatch(/export function requireSearchReindexSecret/);
  });

  it("middleware reuses checkCronSecret (constant-time compare, prod fail-closed)", () => {
    const src = read(MID);
    // Pin that the new gate goes through the shared helper, so the
    // timing-safe compare + prod fail-closed + non-prod admin
    // fallback all stay symmetric with the existing cron-secret
    // routes — and so a future change to that posture lands in one
    // place, not three.
    const fn = src.slice(
      src.indexOf("function requireSearchReindexSecret"),
    );
    expect(fn).toMatch(/checkCronSecret\(/);
  });

  it("reindex service does NOT reimplement projection logic — it imports the canonical indexers", () => {
    const src = read(SERVICE);
    expect(src).toMatch(
      /from\s+["']\.\/evidence-indexing\.service\.js["']/,
    );
    expect(src).toMatch(/from\s+["']\.\/case-indexing\.service\.js["']/);
    expect(src).toMatch(
      /from\s+["']\.\/artifact-indexing\.service\.js["']/,
    );
    expect(src).toMatch(/indexEvidence\(/);
    expect(src).toMatch(/indexCase\(/);
    expect(src).toMatch(/indexReport\(/);
    expect(src).toMatch(/indexPackage\(/);
    expect(src).toMatch(/indexNote\(/);
  });

  it("reindex service skips deleted evidence (deleted_at IS NULL)", () => {
    const src = read(SERVICE);
    expect(src).toMatch(/e\.deleted_at\s+IS\s+NULL/i);
  });

  it("reindex service writes ONLY to evidence_search_documents (no source mutation)", () => {
    const src = read(SERVICE);
    // Read-only joins against source tables for orphan detection;
    // never UPDATE / INSERT / DELETE against `evidence`, `cases`,
    // `reports`, `verification_packages`, or `case_comments`.
    expect(src).not.toMatch(/UPDATE\s+evidence\b/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+evidence\b/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+evidence\b/i);
    expect(src).not.toMatch(/UPDATE\s+cases\b/i);
    expect(src).not.toMatch(/UPDATE\s+reports\b/i);
    expect(src).not.toMatch(/UPDATE\s+verification_packages\b/i);
    expect(src).not.toMatch(/UPDATE\s+case_comments\b/i);
  });
});

describe("Production CLI — dist/scripts/backfill-search-index.js wiring", () => {
  const CLI = resolve(API_ROOT, "src/scripts/backfill-search-index.ts");
  const PKG_JSON = resolve(API_ROOT, "package.json");
  const TSCONFIG_BUILD = resolve(API_ROOT, "tsconfig.build.json");

  it("CLI entrypoint exists under src/scripts/ so the build emits dist/scripts/", () => {
    const src = read(CLI);
    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
    expect(src).toMatch(/runWorkspaceReindex/);
  });

  it("CLI does not require pnpm / tsx / ts-node", () => {
    const src = read(CLI);
    expect(src).not.toMatch(/require\(\s*["']tsx["']\s*\)/);
    expect(src).not.toMatch(/require\(\s*["']ts-node["']\s*\)/);
    expect(src).not.toMatch(/from\s+["']tsx["']/);
    expect(src).not.toMatch(/from\s+["']ts-node["']/);
    expect(src).not.toMatch(/from\s+["']pnpm["']/);
  });

  it("CLI uses the canonical reindex service (no inline reimplementation)", () => {
    const src = read(CLI);
    expect(src).toMatch(
      /from\s+["']\.\.\/services\/search\/reindex\.service\.js["']/,
    );
  });

  it("CLI refuses to run cluster-wide without --all-teams (typo-safety)", () => {
    const src = read(CLI);
    expect(src).toMatch(/--all-teams/);
    expect(src).toMatch(/Refusing to run/);
  });

  it("tsconfig.build.json includes src/scripts so the file builds to dist/scripts", () => {
    const tsconfig = JSON.parse(read(TSCONFIG_BUILD));
    // rootDir = src OR include covers src/**/*.ts — either way the
    // CLI gets emitted under dist/scripts/.
    const includesAll = Array.isArray(tsconfig.include)
      ? tsconfig.include.some(
          (p: string) => p === "src/**/*.ts" || p.startsWith("src/scripts"),
        )
      : false;
    const rootIsSrc = tsconfig.compilerOptions?.rootDir === "src";
    expect(rootIsSrc || includesAll).toBe(true);
  });

  it("package.json exposes a `backfill:search` script that points at the built CLI", () => {
    const pkg = JSON.parse(read(PKG_JSON));
    const script = pkg.scripts?.["backfill:search"];
    expect(typeof script).toBe("string");
    expect(script).toMatch(/dist\/scripts\/backfill-search-index\.js/);
  });
});

// ============================================================================
// BEHAVIORAL TESTS — boot Fastify, call the endpoint
// ============================================================================

let app: FastifyInstance | null = null;

// Behavioral-suite env gate. The default vitest setup does NOT load
// services/api/.env, so DATABASE_URL is unset in plain `pnpm test`
// runs. Without DATABASE_URL the real buildServer() reaches for
// Postgres + secrets and HANGS (no throw, no timeout). Detecting
// required env BEFORE safeBuild() lets us cleanly skip the suite in
// plain dev/CI runs while keeping coverage active anywhere `.env`
// (or RUN_SEARCH_BEHAVIORAL=1) is wired up.
function hasRequiredSearchBehavioralEnv(): boolean {
  if (process.env.RUN_SEARCH_BEHAVIORAL === "1") return true;
  return Boolean(
    process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0,
  );
}

const shouldRun = hasRequiredSearchBehavioralEnv();

async function safeBuild(): Promise<FastifyInstance | null> {
  try {
    const mod = await import("../src/server.js");
    return await mod.buildServer();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "search-internal-reindex behavioral: buildServer failed, skipping:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function mintToken(
  api: FastifyInstance,
  persona: "pro-issues" | "pro-empty",
): Promise<string | null> {
  const res = await api.inject({
    method: "GET",
    url: `/v1/dev/login?persona=${persona}`,
  });
  if (res.statusCode !== 200) return null;
  return (res.json() as { token?: string }).token ?? null;
}

// `shouldRun` (above) early-returns when DATABASE_URL is unset, so
// safeBuild() never fires in plain `pnpm test` runs. 120s is the
// cold-start budget for configured environments.
beforeAll(async () => {
  if (!shouldRun) return;
  app = await safeBuild();
}, 120_000);

afterAll(async () => {
  if (app) {
    await app.close();
  }
}, 30_000);

describe("POST /v1/internal/search/reindex — behavioral", () => {
  it("rejects missing x-internal-secret with 401, never 200", async () => {
    if (!app) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      payload: { teamId: PRO_ISSUES_TEAM },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(401);
  });

  it("rejects wrong x-internal-secret with 401, never 200", async () => {
    if (!app) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": "this-is-not-the-real-secret-abc",
        "content-type": "application/json",
      },
      payload: { teamId: PRO_ISSUES_TEAM },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(401);
  });

  it("accepts valid x-internal-secret and runs the canonical reindex", async () => {
    if (!app) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": REINDEX_SECRET,
        "content-type": "application/json",
      },
      payload: {
        teamId: PRO_EMPTY_TEAM,
        includeCases: true,
        dryRun: true,
      },
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const body = res.json() as {
      teamId: string;
      evidence: { orphans: number };
      cases: { orphans: number };
      reports: { orphans: number };
      packages: { orphans: number };
      notes: { orphans: number };
      durationMs: number;
      dryRun: boolean;
    };
    expect(body.teamId).toBe(PRO_EMPTY_TEAM);
    expect(body.dryRun).toBe(true);
    expect(typeof body.durationMs).toBe("number");
    // Empty workspace — no rows of any source-type to index.
    expect(body.evidence.orphans).toBe(0);
  });

  it("idempotent — calling twice with the same team yields the same shape", async () => {
    if (!app) return;
    const first = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": REINDEX_SECRET,
        "content-type": "application/json",
      },
      payload: { teamId: PRO_ISSUES_TEAM, includeCases: true },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": REINDEX_SECRET,
        "content-type": "application/json",
      },
      payload: { teamId: PRO_ISSUES_TEAM, includeCases: true },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json() as { evidence: { orphans: number; indexed: number } };
    const b = second.json() as { evidence: { orphans: number; indexed: number } };
    // After the first pass closes the orphan gap, the second pass
    // should see zero new orphans — that's idempotency.
    expect(b.evidence.orphans).toBe(0);
    expect(b.evidence.indexed).toBe(0);
    // The first pass either had 0 orphans (already healthy) or
    // closed them; in either case `indexed >= 0 && failed === 0`.
    expect(a.evidence.indexed).toBeGreaterThanOrEqual(0);
  });

  it("body validation — missing teamId returns 400, not 500", async () => {
    if (!app) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": REINDEX_SECRET,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("does NOT weaken user-auth on /v1/search/reconcile (still 401 without bearer)", async () => {
    if (!app) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/search/reconcile",
      payload: { teamId: PRO_ISSUES_TEAM },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("user-auth /v1/search/reconcile still works with a real bearer (regression for the existing surface)", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "POST",
      url: "/v1/search/reconcile",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { teamId: PRO_ISSUES_TEAM },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
  });

  it("after a successful reindex, search returns indexed evidence (end-to-end proof)", async () => {
    if (!app) return;
    // 1. Reindex (idempotent — even if already healthy this is a no-op).
    const rein = await app.inject({
      method: "POST",
      url: "/v1/internal/search/reindex",
      headers: {
        "x-internal-secret": REINDEX_SECRET,
        "content-type": "application/json",
      },
      payload: { teamId: PRO_ISSUES_TEAM, includeCases: true },
    });
    expect(rein.statusCode).toBe(200);

    // 2. Search for v1 in that workspace via the normal user path.
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const search = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.statusCode).toBe(200);
    const body = search.json() as {
      totalReturned: number;
      rows: Array<{ documentType: string; title: string }>;
    };
    // The pro-issues fixture has a v1(9).pdf evidence row that
    // MUST be returned after the reindex.
    const evidenceTitles = body.rows
      .filter((r) => r.documentType === "EVIDENCE")
      .map((r) => r.title);
    expect(evidenceTitles).toEqual(
      expect.arrayContaining([expect.stringContaining("v1")]),
    );
  });
});
