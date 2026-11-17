/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — B3B-F-102 remainder (live PostgreSQL + Redis + MinIO).
 *
 * POST /v1/workflow/intake-links with an `idempotencyKey` is idempotent per
 * (workspace, actor, key): a retry with the same payload answers the ORIGINAL
 * link (200, replayed) with no new link and no second provider attempt, and
 * never re-reveals the one-time token; a retry with a different payload is
 * refused 409 IDEMPOTENCY_KEY_REUSED. Another actor's identical key is a
 * different request. A create without a key behaves as before (a new link
 * every time).
 *
 * A provider attempt is counted as a `communication_messages` row for the
 * link: the send helpers insert that row BEFORE the provider call, so a row
 * that does not exist is a provider call that never happened.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string };
type Prisma = (typeof import("../src/db.js"))["prisma"];

const HOUR = 60 * 60 * 1000;

describe("free-audit 0ea0 — B3B-F-102 intake-link create idempotency (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let intake: typeof import("../src/services/workflow-intake-link.service.js");
  let keyed: typeof import("../src/services/intake-link-create-idempotency.service.js");
  let clearRates: () => Promise<unknown>;
  let ip = 1;
  const A = () => h.fixtures.teamA;

  const call = (method: "POST", url: string, token: string, payload: unknown): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: payload as never,
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;

  async function member(label: string, role: "ADMIN" | "MEMBER"): Promise<SeededUser> {
    const u = await fx.seedUser(deps, label);
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: u.userId, role, status: "ACTIVE" } });
    return u;
  }

  const body = (label: string, extra: Record<string, unknown> = {}) => ({
    teamId: A().teamId,
    workflowTemplateSlug: "general-evidence-record",
    intakeMode: "EXTERNAL_REUSABLE",
    recipientLabel: label,
    recipientEmail: `${label}@test.proovra.local`,
    deliveryMethod: "EMAIL",
    intakeUrlBase: "https://app.example.test",
    maxUses: 5,
    expiresAtUtc: new Date(Date.now() + 24 * HOUR).toISOString(),
    ...extra,
  });
  const create = (token: string, payload: unknown) => call("POST", "/v1/workflow/intake-links", token, payload);
  const linksLabelled = (label: string) => prisma.workflowIntakeLink.findMany({ where: { teamId: A().teamId, recipientLabel: label }, select: { id: true } });
  const attempts = (linkId: string) => prisma.communicationMessage.count({ where: { relatedIntakeLinkId: linkId } });

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.EVIDENCE_REQUESTS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET =
      process.env.WORKFLOW_INTAKE_TOKEN_SECRET ?? "lane-e-throwaway-intake-hmac-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    intake = await import("../src/services/workflow-intake-link.service.js");
    keyed = await import("../src/services/intake-link-create-idempotency.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    deps = {
      prisma: prisma as never,
      tag: `lane-e-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a sequential retry with the same key and payload answers the original link: no new link, no second provider attempt, no token", async () => {
    await clearRates();
    const label = `idem-seq-${randomUUID().slice(0, 8)}`;
    const key = `create:${randomUUID()}`;
    const first = await create(A().ownerToken, body(label, { idempotencyKey: key }));
    expect(first.statusCode, first.body).toBe(201);
    const original = json(first);
    expect(typeof original.rawToken).toBe("string");
    // The client recomputes "now + 24h" on retry; a few seconds later is the same request.
    const retry = await create(
      A().ownerToken,
      body(label, { idempotencyKey: key, expiresAtUtc: new Date(Date.now() + 24 * HOUR + 3_000).toISOString() }),
    );
    expect(retry.statusCode, retry.body).toBe(200);
    const replay = json(retry);
    expect(replay.replayed).toBe(true);
    expect(replay.link.id).toBe(original.link.id);
    expect(replay.rawToken).toBeNull();
    expect(replay.tokenRevealed).toBe(false);
    expect(retry.body).not.toContain(original.rawToken);
    expect(replay.delivery.method).toBe("EMAIL");
    expect(replay.delivery.status).toBe(original.delivery.status);
    expect(await linksLabelled(label)).toHaveLength(1);
    expect(await attempts(original.link.id)).toBe(1);
  });

  it("concurrent retries with one key make one link and at most one provider attempt", async () => {
    await clearRates();
    const label = `idem-con-${randomUUID().slice(0, 8)}`;
    const payload = body(label, { idempotencyKey: `create:${randomUUID()}` });
    const results = await Promise.all([create(A().ownerToken, payload), create(A().ownerToken, payload), create(A().ownerToken, payload)]);
    for (const r of results) expect([200, 201], r.body).toContain(r.statusCode);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const ids = new Set(results.map((r) => json(r).link.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => typeof json(r).rawToken === "string")).toHaveLength(1);
    const links = await linksLabelled(label);
    expect(links).toHaveLength(1);
    expect(await attempts(links[0].id)).toBe(1);
  });

  it("the same key with a different payload is refused 409 IDEMPOTENCY_KEY_REUSED and creates nothing", async () => {
    await clearRates();
    const label = `idem-mis-${randomUUID().slice(0, 8)}`;
    const key = `create:${randomUUID()}`;
    const first = await create(A().ownerToken, body(label, { idempotencyKey: key }));
    expect(first.statusCode, first.body).toBe(201);
    const changed = await create(A().ownerToken, body(label, { idempotencyKey: key, recipientEmail: `other-${label}@test.proovra.local` }));
    expect(changed.statusCode, changed.body).toBe(409);
    expect(json(changed).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(changed.body).not.toContain(json(first).rawToken);
    // A materially different expiry (a week, not a recomputed "now") is a different request too.
    const later = await create(
      A().ownerToken,
      body(label, { idempotencyKey: key, expiresAtUtc: new Date(Date.now() + 7 * 24 * HOUR).toISOString() }),
    );
    expect(later.statusCode, later.body).toBe(409);
    expect(await linksLabelled(label)).toHaveLength(1);
    expect(await attempts(json(first).link.id)).toBe(1);
  });

  it("another actor's identical key is a different request (no cross-actor replay)", async () => {
    await clearRates();
    const colleague = await member("idem-colleague", "ADMIN");
    const label = `idem-act-${randomUUID().slice(0, 8)}`;
    const key = `create:${randomUUID()}`;
    const mine = await create(A().ownerToken, body(label, { idempotencyKey: key }));
    const theirs = await create(colleague.token, body(label, { idempotencyKey: key }));
    expect(mine.statusCode, mine.body).toBe(201);
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(json(theirs).link.id).not.toBe(json(mine).link.id);
    expect(typeof json(theirs).rawToken).toBe("string");
    expect(await linksLabelled(label)).toHaveLength(2);
  });

  it("a crash after the link committed but before the send: the retry answers the link, sends nothing, and says delivery is unconfirmed", async () => {
    await clearRates();
    const label = `idem-crash-${randomUUID().slice(0, 8)}`;
    const key = `create:${randomUUID()}`;
    const payload = body(label, { idempotencyKey: key });
    const scope = keyed.prepareKeyedIntakeCreate({
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
      idempotencyKey: key,
      payload,
    });
    // The local commit of the first request (link + marker), then the process dies.
    const outcome = await keyed.runKeyedIntakeCreate(prisma as never, scope, {
      requestedExpiresAt: new Date(payload.expiresAtUtc),
      create: (tx) =>
        intake.createWorkflowIntakeLink(
          {
            teamId: A().teamId,
            workflowTemplateSlug: "general-evidence-record",
            intakeMode: "EXTERNAL_REUSABLE",
            recipientLabel: label,
            recipientEmail: payload.recipientEmail,
            maxUses: 5,
            expiresAtUtc: new Date(payload.expiresAtUtc),
          } as never,
          { actorUserId: A().ownerUserId, deferSearchIndex: true },
          tx as never,
        ),
      auditMetadata: { deliveryMethod: "EMAIL" },
    });
    expect(outcome.kind).toBe("created");
    const retry = await create(A().ownerToken, payload);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(json(retry).replayed).toBe(true);
    expect(json(retry).rawToken).toBeNull();
    expect(json(retry).delivery).toMatchObject({ method: "EMAIL", status: "unconfirmed" });
    const links = await linksLabelled(label);
    expect(links).toHaveLength(1);
    expect(await attempts(links[0].id)).toBe(0);
  });

  it("a provider effect whose local tag was lost is never repeated by a retry", async () => {
    await clearRates();
    const label = `idem-tag-${randomUUID().slice(0, 8)}`;
    const payload = body(label, { idempotencyKey: `create:${randomUUID()}` });
    const first = await create(A().ownerToken, payload);
    expect(first.statusCode, first.body).toBe(201);
    const linkId = json(first).link.id as string;
    // The provider was called (the row exists) but the idempotency tag never committed.
    await prisma.communicationMessage.updateMany({ where: { relatedIntakeLinkId: linkId }, data: { deliveryIdempotencyKey: null } });
    const retry = await create(A().ownerToken, payload);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(json(retry).delivery.status).toBe("unconfirmed");
    expect(await attempts(linkId)).toBe(1);
  });

  it("legacy: a create without a key is unchanged — a new link each time", async () => {
    await clearRates();
    const label = `idem-legacy-${randomUUID().slice(0, 8)}`;
    const a = await create(A().ownerToken, body(label, { deliveryMethod: "MANUAL", intakeUrlBase: undefined }));
    const b = await create(A().ownerToken, body(label, { deliveryMethod: "MANUAL", intakeUrlBase: undefined }));
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(json(a).link.id).not.toBe(json(b).link.id);
    expect(json(b).replayed).toBeUndefined();
    expect(typeof json(b).rawToken).toBe("string");
    expect(await linksLabelled(label)).toHaveLength(2);
  });

  it("a MANUAL keyed retry replays too (no second link), delivery skipped", async () => {
    await clearRates();
    const label = `idem-man-${randomUUID().slice(0, 8)}`;
    const payload = body(label, { deliveryMethod: "MANUAL", intakeUrlBase: undefined, recipientEmail: null, idempotencyKey: `create:${randomUUID()}` });
    const first = await create(A().ownerToken, payload);
    const retry = await create(A().ownerToken, payload);
    expect(first.statusCode, first.body).toBe(201);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(json(retry).delivery).toMatchObject({ method: "MANUAL", status: "skipped" });
    expect(await linksLabelled(label)).toHaveLength(1);
  });
});
