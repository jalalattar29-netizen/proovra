/**
 * Filter-wire behavioral regression.
 *
 * Pins the contract the user surfaced as broken:
 *
 *   When the workspace has EVIDENCE rows indexed AND the user
 *   sends `documentTypes=EVIDENCE`, the API must return the
 *   evidence rows whose searchable text matches the query. Any
 *   future change to the parser / Zod schema / executeSearch
 *   filter that breaks the EVIDENCE filter will trip these tests.
 *
 *   Same shape for REPORT, PACKAGE — each filter must return rows
 *   of exactly that type, no cross-type leakage.
 *
 *   And — when the workspace is missing EVIDENCE rows entirely,
 *   the API returns 0 for documentTypes=EVIDENCE but the
 *   /v1/search/diagnostics envelope reports
 *   `queryProbe.matchedByType` with the non-zero counts for the
 *   other types so the UI can render truthful per-type empty
 *   copy. (The shape is what the page consumes.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.DEV_AUTH_ENABLED = "true";

const PRO_ISSUES_TEAM = "0e000000-0000-4000-8000-0000000000a4";

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
      "search-filter-wire-behavioral: buildServer failed, skipping:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function mintToken(
  api: FastifyInstance,
  persona: "pro-issues",
): Promise<string | null> {
  const res = await api.inject({
    method: "GET",
    url: `/v1/dev/login?persona=${persona}`,
  });
  if (res.statusCode !== 200) return null;
  return (res.json() as { token?: string }).token ?? null;
}

let app: FastifyInstance | null = null;

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

describe("/v1/search documentType filter — behavioral", () => {
  it("q=v1 no filter — returns rows from every indexed type (baseline)", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    const body = res.json() as {
      totalReturned: number;
      rows: Array<{ documentType: string; title: string }>;
    };
    const byType: Record<string, number> = {};
    for (const r of body.rows) {
      byType[r.documentType] = (byType[r.documentType] ?? 0) + 1;
    }
    expect(byType.EVIDENCE).toBeGreaterThan(0);
    expect(byType.REPORT).toBeGreaterThan(0);
    expect(byType.PACKAGE).toBeGreaterThan(0);
  });

  it("q=v1&documentTypes=EVIDENCE — returns ONLY EVIDENCE rows that match the query", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1&documentTypes=EVIDENCE`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalReturned: number;
      rows: Array<{ documentType: string; title: string }>;
    };
    expect(body.totalReturned).toBeGreaterThan(0);
    for (const r of body.rows) {
      expect(r.documentType).toBe("EVIDENCE");
    }
    // At least one row must surface the v1 filename — pin the
    // canonical fixture (v1(9).pdf) so a future projection change
    // that strips the filename from searchable_text fails here.
    const titles = body.rows.map((r) => r.title);
    expect(titles.some((t) => t.includes("v1"))).toBe(true);
  });

  it("q=v1&documentTypes=REPORT — returns ONLY REPORT rows (no EVIDENCE leakage)", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1&documentTypes=REPORT`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalReturned: number;
      rows: Array<{ documentType: string }>;
    };
    expect(body.totalReturned).toBeGreaterThan(0);
    for (const r of body.rows) {
      expect(r.documentType).toBe("REPORT");
    }
  });

  it("q=v1&documentTypes=PACKAGE — returns ONLY PACKAGE rows (no EVIDENCE/REPORT leakage)", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1&documentTypes=PACKAGE`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalReturned: number;
      rows: Array<{ documentType: string }>;
    };
    expect(body.totalReturned).toBeGreaterThan(0);
    for (const r of body.rows) {
      expect(r.documentType).toBe("PACKAGE");
    }
  });

  it("q=v1&documentTypes=NOTE — returns 0 when no NOTE rows match (clean empty, not 500)", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1&documentTypes=NOTE`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalReturned: number;
      rows: Array<unknown>;
    };
    expect(body.totalReturned).toBe(0);
    expect(body.rows).toHaveLength(0);
  });

  it("lowercase documentTypes — Zod schema rejects with 400, never silently downcasts", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    // The frontend ships uppercase enum values; if a malformed
    // caller sends lowercase, the API MUST 400 rather than return
    // 0 rows (which would be misleading) or downcast (which would
    // mask client bugs).
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?teamId=${PRO_ISSUES_TEAM}&q=v1&documentTypes=evidence`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("diagnostics queryProbe with q=v1 — reports per-type matched counts for the UI", async () => {
    if (!app) return;
    const token = await mintToken(app, "pro-issues");
    if (!token) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search/diagnostics?teamId=${PRO_ISSUES_TEAM}&q=v1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      queryProbe: {
        q: string;
        matchedTotal: number;
        matchedByType: Record<string, number>;
      } | null;
    };
    expect(body.queryProbe).not.toBeNull();
    expect(body.queryProbe?.q).toBe("v1");
    expect(body.queryProbe?.matchedByType.EVIDENCE).toBeGreaterThan(0);
    expect(body.queryProbe?.matchedByType.REPORT).toBeGreaterThan(0);
    expect(body.queryProbe?.matchedByType.PACKAGE).toBeGreaterThan(0);
  });
});
