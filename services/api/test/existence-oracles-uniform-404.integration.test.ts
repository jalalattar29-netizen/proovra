/**
 * ET-SEC-31 — a resource the caller may not see is answered exactly as a
 * missing one. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f four answers told an enumerating caller that an id exists:
 *   - the evidence list / library summary filtered by a foreign caseId: 403
 *     (missing: 404);
 *   - another user's capture draft: 403 (missing: 404);
 *   - public verify of a record that is not finalized: 409 with its status
 *     (missing: 404) — unauthenticated, keyed by the evidence id;
 *   - (evidence create with a foreign teamId answered the same 403 as a
 *     nonexistent one already; held here so it stays that way).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("existence oracles answer a uniform 404 (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const created: { evidence: string[]; cases: string[]; sessions: string[] } = { evidence: [], cases: [], sessions: [] };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await prisma?.captureSession.deleteMany({ where: { id: { in: created.sessions } } }).catch(() => undefined);
    await prisma?.case.deleteMany({ where: { id: { in: created.cases } } }).catch(() => undefined);
    await prisma?.evidence
      .updateMany({ where: { id: { in: created.evidence } }, data: { deletedAt: new Date() } })
      .catch(() => undefined);
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;
  const get = (url: string, token?: string) =>
    h.app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  /** Same status and the same error, whatever per-request ids the body carries. */
  function sameRefusal(a: { statusCode: number; json: () => unknown }, b: { statusCode: number; json: () => unknown }) {
    expect(a.statusCode).toBe(b.statusCode);
    const strip = (v: unknown) => JSON.stringify(v, (k, x) => (/request_?id|traceId/i.test(k) ? undefined : x));
    expect(strip(a.json())).toBe(strip(b.json()));
  }

  it("evidence list and library summary: a foreign case is answered as a missing one", async () => {
    const { id: foreignCase } = await prisma.case.create({
      data: { name: `sec31-${randomUUID().slice(0, 8)}`, teamId: B().teamId, ownerUserId: B().ownerUserId } as never,
      select: { id: true },
    });
    created.cases.push(foreignCase);
    for (const path of ["/v1/evidence", "/v1/evidence/library-summary"]) {
      const foreign = await get(`${path}?caseId=${foreignCase}`, A().ownerToken);
      const missing = await get(`${path}?caseId=${randomUUID()}`, A().ownerToken);
      expect(foreign.statusCode, `${path}: ${foreign.body}`).toBe(404);
      sameRefusal(foreign, missing);
    }
  });

  it("capture drafts: another user's draft is answered as a missing one", async () => {
    const { id } = await prisma.captureSession.create({
      data: { ownerUserId: A().memberUserId } as never,
      select: { id: true },
    });
    created.sessions.push(id);
    const foreign = await get(`/v1/capture/sessions/${id}`, A().ownerToken);
    const missing = await get(`/v1/capture/sessions/${randomUUID()}`, A().ownerToken);
    expect(foreign.statusCode, foreign.body).toBe(404);
    sameRefusal(foreign, missing);
  });

  it("public verify: a record that is not finalized is answered as a missing one, with no status", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Not finalized",
        type: "PHOTO",
        status: "UPLOADED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: A().ownerUserId,
      } as never,
      select: { id: true },
    });
    created.evidence.push(id);
    const unfinalized = await get(`/public/verify/${id}`);
    const missing = await get(`/public/verify/${randomUUID()}`);
    expect(unfinalized.statusCode, unfinalized.body).toBe(404);
    expect(unfinalized.body).not.toContain("UPLOADED");
    sameRefusal(unfinalized, missing);
  });

  it("evidence create: a foreign workspace id is answered as a nonexistent one", async () => {
    const post = (teamId: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: { authorization: `Bearer ${A().ownerToken}` },
        payload: { type: "PHOTO", teamId, mimeType: "image/jpeg" },
      });
    const foreign = await post(B().teamId);
    const missing = await post(randomUUID());
    expect(foreign.statusCode, foreign.body).toBeGreaterThanOrEqual(400);
    sameRefusal(foreign, missing);
  });
});
