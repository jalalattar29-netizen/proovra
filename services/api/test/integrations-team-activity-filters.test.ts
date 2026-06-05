/**
 * PHASE 2 — GET /v1/teams/:id/activity optional filters contract.
 *
 * The Integrations page (frontend) reuses the canonical TeamActivity feed
 * to surface a collapsed, lazy-loaded Activity panel scoped to one API
 * credential or webhook endpoint. To narrow the existing 50-row feed
 * without inventing a new route or aggregate, this route gained optional
 * filters: targetType, targetId, eventType, limit.
 *
 * These tests pin:
 *   1. Filters are wired in services/api/src/routes/teams.routes.ts
 *      (handler reads req.query and threads targetType/targetId/eventType
 *      into the prisma.teamActivity.findMany `where`).
 *   2. The zod schema enforces bounded inputs (UUID targetId, string-
 *      length caps, integer limit 1..100).
 *   3. Auth + team scope are preserved (handler still calls
 *      getActorMembership and returns 403 on non-member).
 *   4. The route does NOT add new query support that returns secrets.
 *      Response projection in the source still excludes keyHash, raw
 *      secret material, and request bodies.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readApi(rel: string): string {
  return readFileSync(join(repoRoot, "services/api", rel), "utf8");
}

// ===========================================================================
// Re-declare the in-handler zod schema so we can exercise its bounds in
// isolation. Keep this in sync with teams.routes.ts.
// ===========================================================================

const ActivityQuery = z.object({
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.string().uuid().optional(),
  eventType: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// 1. Source-contract — filters are wired in the handler
// ---------------------------------------------------------------------------

describe("Phase 2 — /v1/teams/:id/activity filter wiring (source contract)", () => {
  const routes = readApi("src/routes/teams.routes.ts");

  it("preserves the existing route path (singular /activity)", () => {
    expect(routes).toContain('"/v1/teams/:id/activity"');
  });

  it("preserves auth + team-scope checks (requireAuthAndLegal + getActorMembership)", () => {
    // Pull the handler block out so we don't accidentally match other routes.
    const start = routes.indexOf('"/v1/teams/:id/activity"');
    expect(start).toBeGreaterThan(-1);
    const end = routes.indexOf("app.post(", start);
    const handler = routes.slice(start, end > -1 ? end : start + 4000);
    expect(handler).toContain("preHandler: requireAuthAndLegal");
    expect(handler).toContain("getActorMembership(teamId, userId)");
    expect(handler).toMatch(/return reply\.code\(403\)\.send\(\{\s*message:\s*['"]Forbidden['"]/);
  });

  it("declares the optional filter zod schema with bounded inputs", () => {
    const start = routes.indexOf('"/v1/teams/:id/activity"');
    const end = routes.indexOf("app.post(", start);
    const handler = routes.slice(start, end > -1 ? end : start + 4000);
    expect(handler).toMatch(/targetType:\s*z\.string\(\)\.min\(1\)\.max\(64\)\.optional\(\)/);
    expect(handler).toMatch(/targetId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(handler).toMatch(/eventType:\s*z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/);
    expect(handler).toMatch(/limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
  });

  it("threads the parsed filters into the prisma.teamActivity.findMany `where`", () => {
    const start = routes.indexOf('"/v1/teams/:id/activity"');
    const end = routes.indexOf("app.post(", start);
    const handler = routes.slice(start, end > -1 ? end : start + 4000);
    expect(handler).toContain("where.targetType = targetType");
    expect(handler).toContain("where.targetId = targetId");
    expect(handler).toContain("where.eventType = eventType");
    // limit applied to take, with default 50 preserved.
    expect(handler).toMatch(/take:\s*limit\s*\?\?\s*50/);
  });

  it("did NOT add a new route — only extended the existing GET handler", () => {
    // Exactly one app.get for the activity path.
    const matches = routes.match(/app\.get\(\s*"\/v1\/teams\/:id\/activity"/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Zod bounds — pure logic
// ---------------------------------------------------------------------------

describe("Phase 2 — ActivityQuery zod schema bounds", () => {
  it("accepts an empty query (everything optional)", () => {
    const r = ActivityQuery.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.targetType).toBeUndefined();
      expect(r.data.targetId).toBeUndefined();
      expect(r.data.eventType).toBeUndefined();
      expect(r.data.limit).toBeUndefined();
    }
  });

  it("accepts targetType='api_credential' (matches emitter union)", () => {
    const r = ActivityQuery.safeParse({ targetType: "api_credential" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.targetType).toBe("api_credential");
  });

  it("accepts targetType='webhook_endpoint' (matches emitter union)", () => {
    const r = ActivityQuery.safeParse({ targetType: "webhook_endpoint" });
    expect(r.success).toBe(true);
  });

  it("rejects targetType longer than 64 chars", () => {
    const r = ActivityQuery.safeParse({ targetType: "a".repeat(65) });
    expect(r.success).toBe(false);
  });

  it("rejects targetId that is not a UUID", () => {
    const r = ActivityQuery.safeParse({ targetId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("accepts a valid UUID for targetId", () => {
    const r = ActivityQuery.safeParse({
      targetId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an exact-match eventType like integration.api_key.created", () => {
    const r = ActivityQuery.safeParse({ eventType: "integration.api_key.created" });
    expect(r.success).toBe(true);
  });

  it("rejects eventType longer than 128 chars", () => {
    const r = ActivityQuery.safeParse({ eventType: "x".repeat(129) });
    expect(r.success).toBe(false);
  });

  it("coerces a numeric-string limit into a bounded integer", () => {
    const r = ActivityQuery.safeParse({ limit: "25" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(25);
  });

  it("caps limit at 100", () => {
    const r = ActivityQuery.safeParse({ limit: 101 });
    expect(r.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const r = ActivityQuery.safeParse({ limit: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const r = ActivityQuery.safeParse({ limit: 12.5 });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Where-builder simulation — mirrors handler logic
// ---------------------------------------------------------------------------

type ParsedFilters = z.infer<typeof ActivityQuery>;

function buildWhere(teamId: string, filters: ParsedFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { teamId };
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  if (filters.eventType) where.eventType = filters.eventType;
  return where;
}

describe("Phase 2 — where-builder narrows by combined filters", () => {
  const teamId = "33333333-3333-4333-8333-333333333333";

  it("narrows by targetType + targetId", () => {
    const credId = "22222222-2222-4222-8222-222222222222";
    const where = buildWhere(teamId, {
      targetType: "api_credential",
      targetId: credId,
    });
    expect(where).toEqual({
      teamId,
      targetType: "api_credential",
      targetId: credId,
    });
  });

  it("narrows by eventType alone", () => {
    const where = buildWhere(teamId, {
      eventType: "integration.webhook.secret_rotated",
    });
    expect(where).toEqual({
      teamId,
      eventType: "integration.webhook.secret_rotated",
    });
  });

  it("falls back to teamId-only when nothing is provided", () => {
    const where = buildWhere(teamId, {});
    expect(where).toEqual({ teamId });
  });

  it("does NOT bypass the teamId scope no matter what (defensive)", () => {
    const where = buildWhere(teamId, {
      targetType: "api_credential",
      eventType: "integration.api_key.created",
    });
    expect(where.teamId).toBe(teamId);
  });
});

// ---------------------------------------------------------------------------
// 4. Response-shape privacy — handler still strips secrets
// ---------------------------------------------------------------------------

describe("Phase 2 — response projection still hides secrets", () => {
  const routes = readApi("src/routes/teams.routes.ts");
  const start = routes.indexOf('"/v1/teams/:id/activity"');
  const end = routes.indexOf("app.post(", start);
  const handler = routes.slice(start, end > -1 ? end : start + 4000);

  it("response builder exposes only the safe fields", () => {
    // The enriched row spec lists exactly these keys.
    expect(handler).toContain("id: activity.id");
    expect(handler).toContain("eventType: activity.eventType");
    expect(handler).toContain("targetType: activity.targetType");
    expect(handler).toContain("targetId: activity.targetId");
    expect(handler).toContain("metadata: activity.metadata");
    expect(handler).toContain("createdAt: activity.createdAt");
  });

  it("handler does NOT read or echo any secret-bearing column", () => {
    // None of these strings should ever appear inside the activity handler.
    for (const banned of [
      "keyHash",
      "secretHash",
      "signingSecret",
      "previousKeyHash",
      "previousSecretHash",
      "rawKey",
      "Authorization",
      "Bearer",
    ]) {
      expect(handler).not.toContain(banned);
    }
  });
});
