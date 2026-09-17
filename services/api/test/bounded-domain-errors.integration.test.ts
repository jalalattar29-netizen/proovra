/**
 * BATCH C — NO USER INPUT, UNKNOWN ID OR MISSING PROVIDER BECOMES A FALSE 500.
 *
 * THE DEFECTS, FROM THE MUTATION SWEEP
 * ---------------------------------------------------------------------------
 *   PV-DEFECT-001  POST /v1/evidence/:id/relationships with source == target
 *                  threw a bare Error → 500 INTERNAL_SERVER_ERROR + a critical
 *                  operational.alert for an operator's typo.
 *   PV-DEFECT-002  POST /v1/external-review/invitations/bulk/revoke wrote its
 *                  first activity row under a random batch id that the table's
 *                  foreign key can never resolve → P2003 → 500 DATABASE_ERROR
 *                  on EVERY call, known ids or not.
 *   PV-DEFECT-003  credits checkout with no provider configured → requireSecret
 *                  threw → 500 + critical alert, where integrations already
 *                  answers a bounded 503.
 *   WCC-NEW-002    and even that bounded integrations 503 paged critical,
 *                  because the response hook paged on every status >= 500.
 *
 * WHAT IS ASSERTED, AGAINST LIVE POSTGRESQL AND THE REAL SERVER
 * ---------------------------------------------------------------------------
 * The exact status and code; that nothing was written that should not have
 * been; that no secret NAME reaches the wire; and — read from the server's
 * own log stream — that no `operational.alert` was raised for the request,
 * while a configuration regression still raises a warning-level
 * `operational.signal`.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const requireHere = createRequire(import.meta.url);
const pino = requireHere(
  requireHere.resolve("pino", { paths: [requireHere.resolve("fastify")] }),
) as { symbols: { streamSym: symbol } };

type LogLine = { msg?: string; url?: string; statusCode?: number; severity?: string; errorCode?: string };

describe("bounded domain errors (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const logLines: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));

    // Read the server's OWN log stream. Every request logger is a child of
    // app.log and writes through this one stream object.
    const stream = (harness.app.log as unknown as Record<symbol, { write: (c: string) => unknown }>)[
      pino.symbols.streamSym
    ];
    const original = stream.write.bind(stream);
    stream.write = (chunk: string) => {
      logLines.push(String(chunk));
      return original(chunk);
    };
  }, 300_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  }, 120_000);

  /** Inject, and return the response with the log lines written for its URL. */
  async function call(opts: {
    method: "GET" | "POST";
    url: string;
    token: string;
    body?: unknown;
  }) {
    const from = logLines.length;
    const res = await harness.app.inject({
      method: opts.method,
      url: opts.url,
      headers: { authorization: `Bearer ${opts.token}` },
      ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
    });
    const path = opts.url.split("?")[0];
    const lines = logLines
      .slice(from)
      .flatMap((chunk) => chunk.split("\n"))
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogLine;
        } catch {
          return null;
        }
      })
      .filter((l): l is LogLine => l !== null && typeof l.url === "string" && l.url.startsWith(path));
    return { res, lines };
  }

  const alerts = (lines: LogLine[]) => lines.filter((l) => l.msg === "operational.alert");
  const signals = (lines: LogLine[]) => lines.filter((l) => l.msg === "operational.signal");

  // -------------------------------------------------------------------------
  // PV-DEFECT-001
  // -------------------------------------------------------------------------
  it("a self-referencing relationship is a 400 domain refusal: nothing written, nothing paged", async () => {
    const t = harness.fixtures.teamA;
    const before = await prisma.evidenceRelationship.count({ where: { sourceEvidenceId: t.evidenceId } });
    const { res, lines } = await call({
      method: "POST",
      url: `/v1/evidence/${t.evidenceId}/relationships`,
      token: t.ownerToken,
      body: { targetEvidenceId: t.evidenceId, relationshipType: "RELATED" },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "EVIDENCE_RELATIONSHIP_SELF_LINK" } });
    expect(await prisma.evidenceRelationship.count({ where: { sourceEvidenceId: t.evidenceId } })).toBe(before);
    expect(alerts(lines)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // PV-DEFECT-003
  // -------------------------------------------------------------------------
  for (const provider of ["stripe", "paypal"] as const) {
    it(`credits checkout with ${provider} unconfigured is a bounded 503: no secret name, no page, one signal`, async () => {
      const { res, lines } = await call({
        method: "POST",
        url: `/v1/billing/credits/checkout/${provider}`,
        token: harness.fixtures.personal.token,
        body: {},
      });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: "PAYMENTS_UNAVAILABLE" } });
      // The customer learns payments are unavailable — never which setting.
      expect(res.body).not.toMatch(/STRIPE_|PAYPAL_|secret|not configured/i);
      expect(alerts(lines)).toEqual([]);
      // In an environment that should take payments this IS a regression:
      // it reaches ops, at warning level.
      expect(signals(lines).map((s) => [s.severity, s.errorCode])).toEqual([
        ["warning", "PAYMENTS_UNAVAILABLE"],
      ]);
    });
  }

  // -------------------------------------------------------------------------
  // WCC-NEW-002 — a deliberate disabled state is logged, not paged.
  // -------------------------------------------------------------------------
  it("integrations switched off answers its bounded 503 without paging or signalling", async () => {
    const t = harness.fixtures.teamA;
    const { res, lines } = await call({
      method: "GET",
      url: `/v1/integrations/api-keys?teamId=${t.teamId}`,
      token: t.ownerToken,
    });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "INTEGRATIONS_DISABLED", reason: "feature_flag_off" } });
    expect(alerts(lines)).toEqual([]);
    expect(signals(lines)).toEqual([]);
    expect(lines.some((l) => l.msg === "request.completed.bounded_unavailable")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PV-DEFECT-002
  // -------------------------------------------------------------------------
  it("bulk revoke resolves every id first: revoked, already revoked and unknown each reported, nothing false written", async () => {
    const a = harness.fixtures.teamA;
    const b = harness.fixtures.teamB;
    const invitations = await import("../src/services/external-review/portal-invitation.service.js");
    const issue = async (teamId: string, invitedByUserId: string, evidenceId: string) => {
      const res = await invitations.issueInvitation({
        teamId,
        invitedByUserId,
        reviewerEmail: `reviewer-${randomUUID().slice(0, 8)}@example.test`,
        role: "EXTERNAL_REVIEWER",
        scope: { kind: "EVIDENCE", evidenceId },
        expiresAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      return (res as { grantId: string }).grantId;
    };
    const live = await issue(a.teamId, a.ownerUserId, a.evidenceId);
    const alreadyRevoked = await issue(a.teamId, a.ownerUserId, a.evidenceId);
    const otherWorkspace = await issue(b.teamId, b.ownerUserId, b.evidenceId);
    const unknown = randomUUID();
    const pre = await invitations.revokeInvitation({
      teamId: a.teamId,
      grantId: alreadyRevoked,
      revokedByUserId: a.ownerUserId,
    });
    expect(pre.ok).toBe(true);

    // The route authorizes the CURRENT workspace.
    await prisma.user.update({ where: { id: a.ownerUserId }, data: { currentWorkspaceId: a.teamId } as never });

    const { res } = await call({
      method: "POST",
      url: "/v1/external-review/invitations/bulk/revoke",
      token: a.ownerToken,
      body: { grantIds: [live, alreadyRevoked, unknown, otherWorkspace], reason: "integration proof" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { bulkBatchId: string; rows: Array<{ grantId: string; outcome: string }> };
    expect(body.rows.map((r) => [r.grantId, r.outcome])).toEqual([
      [live, "REVOKED"],
      [alreadyRevoked, "ALREADY_REVOKED"],
      [unknown, "NOT_FOUND"],
      // Another workspace's invitation is indistinguishable from none at all.
      [otherWorkspace, "NOT_FOUND"],
    ]);

    // The durable effect, and only that.
    const states = await prisma.externalReviewGrant.findMany({
      where: { id: { in: [live, otherWorkspace] } },
      select: { id: true, state: true },
    });
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
      [live]: "REVOKED",
      [otherWorkspace]: "INVITED",
    });
    // No activity row under an id that is not an invitation of this workspace,
    // and no batch surrogate rows at all.
    expect(
      await prisma.externalReviewActivity.count({
        where: { OR: [{ grantId: { in: [unknown, otherWorkspace] }, teamId: a.teamId }, { code: { startsWith: "BULK_REVOKE" } }] },
      }),
    ).toBe(0);
    // The batch is recorded once, in the tenant audit, with its true counts.
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "external_review.invitations.bulk_revoked", resourceId: body.bulkBatchId },
    });
    expect(audit, "the batch must be recorded in the tenant audit").not.toBeNull();
    expect(audit?.workspaceId).toBe(a.teamId);
    expect(JSON.stringify(audit)).toMatch(/"revokedCount":1/);
    expect(JSON.stringify(audit)).toMatch(/"notFoundCount":2/);
  });
});
