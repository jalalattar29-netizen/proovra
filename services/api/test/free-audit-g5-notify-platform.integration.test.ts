/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies and mocked payloads of many shapes. */
/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G5-NOTIFY-PLATFORM (live PostgreSQL + Redis).
 *
 * Notifications and email, background delivery, and the platform edges of
 * the API (sign-out under load, the lead limiter, the contract headers).
 * Every refusal has a positive control on the same rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import type { FixtureDeps, SeededUser } from "./point7/product-fixtures.js";

type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
type Prisma = (typeof import("../src/db.js"))["prisma"];

const WEB_ORIGIN = "http://127.0.0.1:3007";
const PASSWORD = "G5-Notify-Platform-Pass-123";
const FORWARDING_KEY = "g5-forwarding-key-0123456789abcdef";

describe("free-audit 0ea0 — API-G5-NOTIFY-PLATFORM (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fx: typeof import("./point7/product-fixtures.js");
  let deps: FixtureDeps;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let summaryCache: typeof import("../src/services/notifications/operations-summary-cache.js");
  let notifications: typeof import("../src/services/notifications/index.js");
  let digest: typeof import("../src/services/notifications/digest-scheduler.js");
  let verification: typeof import("../src/services/email-verification.service.js");
  let emailService: typeof import("../src/services/email.service.js");
  let clearRates: () => Promise<unknown>;
  let ip = 1;
  const A = () => h.fixtures.teamA;
  const B = () => h.fixtures.teamB;

  const call = (
    method: "GET" | "POST" | "PUT",
    url: string,
    token: string | null,
    payload?: unknown,
    extra: Record<string, string> = {},
    remoteAddress?: string,
  ): Promise<Res> =>
    h.app.inject({
      method,
      url,
      remoteAddress: remoteAddress ?? `198.51.100.${(ip++ % 250) + 1}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    }) as unknown as Promise<Res>;
  const json = (r: Res) => JSON.parse(r.body) as Record<string, any>;

  async function memberOf(label: string, teams: Array<{ teamId: string; role: "ADMIN" | "MEMBER" }>): Promise<SeededUser> {
    const u = await fx.seedUser(deps, label);
    for (const t of teams) {
      await prisma.teamMember.create({ data: { teamId: t.teamId, userId: u.userId, role: t.role, status: "ACTIVE" } });
    }
    return u;
  }

  async function pendingReviewItem(teamId: string, requestedByUserId: string): Promise<string> {
    const row = await prisma.evidenceRequest.create({
      data: {
        teamId,
        requestType: "DOCUMENT",
        status: "RESPONSE_RECEIVED",
        priority: "NORMAL",
        title: `G5 intake ${randomUUID().slice(0, 8)}`,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        requestedByUserId,
        assignedReviewerUserId: null,
      },
      select: { id: true },
    });
    return `intake_submission_pending_review:${row.id}`;
  }

  const readAt = async (userId: string, itemKey: string) =>
    (await prisma.inboxItemState.findUnique({ where: { userId_itemKey: { userId, itemKey } }, select: { readAt: true } }))?.readAt ?? null;

  beforeAll(async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    process.env.CONTACT_SALES_FORWARDING_KEY = FORWARDING_KEY;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    fx = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    summaryCache = await import("../src/services/notifications/operations-summary-cache.js");
    notifications = await import("../src/services/notifications/index.js");
    digest = await import("../src/services/notifications/digest-scheduler.js");
    verification = await import("../src/services/email-verification.service.js");
    emailService = await import("../src/services/email.service.js");
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    deps = {
      prisma: prisma as never,
      tag: `g5-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  // -------------------------------------------------------------------------
  // B2B-F-01 — mark-all-read reaches exactly the scope the client shows.
  // -------------------------------------------------------------------------
  it("B2B-F-01 — mark-all-read with workspaceId marks only that workspace; a non-member scope is 403; {} keeps the account-wide read", async () => {
    const dual = await memberOf("dual", [
      { teamId: A().teamId, role: "ADMIN" },
      { teamId: B().teamId, role: "ADMIN" },
    ]);
    const inA = await pendingReviewItem(A().teamId, dual.userId);
    const inB = await pendingReviewItem(B().teamId, dual.userId);
    await summaryCache.invalidateOperationsSummary(dual.userId);

    // The bell's badge for A counts A's item and not B's.
    const badgeA = json(await call("GET", `/v1/me/inbox/summary?workspaceId=${A().teamId}`, dual.token));
    expect(badgeA.unread).toBeGreaterThanOrEqual(1);

    const scoped = await call("POST", "/v1/me/inbox/mark-all-read", dual.token, { workspaceId: A().teamId });
    expect(scoped.statusCode).toBe(200);
    expect(json(scoped).workspaceId).toBe(A().teamId);
    // The badge excludes guidance; the bulk read may also read guidance shown in the list.
    expect(json(scoped).markedRead).toBeGreaterThanOrEqual(badgeA.unread);
    expect(await readAt(dual.userId, inA)).toBeInstanceOf(Date);
    expect(await readAt(dual.userId, inB)).toBeNull();
    expect(json(await call("GET", `/v1/me/inbox/summary?workspaceId=${A().teamId}`, dual.token)).unread).toBe(0);
    expect(json(await call("GET", `/v1/me/inbox/summary?workspaceId=${B().teamId}`, dual.token)).unread).toBeGreaterThanOrEqual(1);

    // A scope the caller does not belong to is refused (same as the summary).
    expect((await call("POST", "/v1/me/inbox/mark-all-read", dual.token, { workspaceId: randomUUID() })).statusCode).toBe(403);
    expect((await call("POST", "/v1/me/inbox/mark-all-read", dual.token, { workspaceId: "not-a-uuid" })).statusCode).toBe(400);
    expect(await readAt(dual.userId, inB)).toBeNull();

    // Older clients send {}: the account-wide read is kept (version skew).
    const legacy = await call("POST", "/v1/me/inbox/mark-all-read", dual.token, {});
    expect(legacy.statusCode).toBe(200);
    expect(json(legacy).workspaceId).toBeNull();
    expect(await readAt(dual.userId, inB)).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // B2B-F-02 / B2B-F-11 — governance email is the member's choice; the badge
  // cache is dropped on a preference write.
  // -------------------------------------------------------------------------
  it("B2B-F-02 — organization workspace without policy: GOVERNANCE_UPDATE EMAIL can be switched off; IN_APP stays locked; an org mandatoryEmail row locks EMAIL (GET agrees)", async () => {
    const member = await memberOf("gov", [{ teamId: A().teamId, role: "MEMBER" }]);
    const put = (channel: "EMAIL" | "IN_APP", enabled: boolean) =>
      call("PUT", "/v1/me/notification-preferences", member.token, {
        teamId: A().teamId,
        preferenceType: "GOVERNANCE_UPDATE",
        channel,
        enabled,
      });
    expect((await put("EMAIL", true)).statusCode).toBe(200);
    const off = await put("EMAIL", false);
    expect(off.statusCode, off.body).toBe(200);
    expect((await put("IN_APP", false)).statusCode).toBe(403);
    const getOpen = json(await call("GET", `/v1/me/notification-preferences?teamId=${A().teamId}`, member.token));
    expect(getOpen.emailLockedTypes).not.toContain("GOVERNANCE_UPDATE");
    expect(getOpen.lockedTypes).toContain("GOVERNANCE_UPDATE");

    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const policy = await prisma.organizationNotificationPolicy.create({
      data: {
        organizationId: team.organizationId!,
        category: "GOVERNANCE_UPDATE",
        mandatoryEmail: true,
        createdByUserId: A().ownerUserId,
      },
      select: { id: true },
    });
    try {
      expect((await put("EMAIL", false)).statusCode).toBe(403);
      const getLocked = json(await call("GET", `/v1/me/notification-preferences?teamId=${A().teamId}`, member.token));
      expect(getLocked.emailLockedTypes).toContain("GOVERNANCE_UPDATE");
    } finally {
      await prisma.organizationNotificationPolicy.delete({ where: { id: policy.id } });
    }
  });

  it("B2B-F-11 — a successful preference write drops the cached bell summary (every scope)", async () => {
    const member = await memberOf("cache", [{ teamId: A().teamId, role: "MEMBER" }]);
    expect((await call("GET", `/v1/me/inbox/summary?workspaceId=${A().teamId}`, member.token)).statusCode).toBe(200);
    expect(await summaryCache.getCachedOperationsSummary(member.userId, A().teamId)).not.toBeNull();
    const res = await call("PUT", "/v1/me/notification-preferences", member.token, {
      teamId: A().teamId,
      preferenceType: "MENTION",
      channel: "IN_APP",
      enabled: false,
    });
    expect(res.statusCode).toBe(200);
    expect(await summaryCache.getCachedOperationsSummary(member.userId, A().teamId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // B2B-F-10 — SYSTEM containers are not customer organizations.
  // -------------------------------------------------------------------------
  it("B2B-F-10 — a bootstrapped account (SYSTEM container only) sees the no-organization guidance", async () => {
    const p = h.fixtures.personal;
    const system = await prisma.organizationMembership.count({
      where: { userId: p.userId, status: "ACTIVE", organization: { kind: "SYSTEM" } },
    });
    const customer = await prisma.organizationMembership.count({
      where: { userId: p.userId, status: "ACTIVE", organization: { kind: "CUSTOMER" } },
    });
    expect(system).toBeGreaterThan(0);
    expect(customer).toBe(0);
    await summaryCache.invalidateOperationsSummary(p.userId);
    const res = await call("GET", "/v1/me/inbox?filter=all", p.token);
    expect(res.statusCode).toBe(200);
    const keys = (json(res).items as Array<{ itemKey?: string; id?: string }>).map((i) => i.itemKey ?? i.id);
    expect(keys.some((k) => String(k).includes("onboarding:no_organizations"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B2B-F-06 — retries re-ask preference and access; SKIPPED resend is terminal.
  // -------------------------------------------------------------------------
  it("B2B-F-06 — a retry after the member turned email off, or lost access, is CANCELLED (no send, no failure webhook); lifecycle notices stay exempt; Resend on a template-less SKIPPED row is skipped_terminal", async () => {
    const optedOut = await memberOf("optout", [{ teamId: A().teamId, role: "MEMBER" }]);
    await prisma.workspaceNotificationPreference.create({
      data: { userId: optedOut.userId, teamId: A().teamId, preferenceType: "REVIEWER_ASSIGNMENT", channel: "EMAIL", enabled: false },
    });
    const outsider = await fx.seedUser(deps, "removed");
    const ctx = { kind: "ReviewAssigned", data: { workspaceName: "A", requestTitle: "R", reviewerName: null, requestUrl: null } };
    const due = new Date(Date.now() - 60_000);
    const row = (eventType: string, user: SeededUser, extra: Record<string, unknown> = {}) =>
      prisma.notificationDelivery.create({
        data: {
          teamId: A().teamId,
          eventType,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: user.email,
          recipientUserId: user.userId,
          status: "RETRY_SCHEDULED",
          templateKey: eventType,
          templateContextJson: ctx as never,
          retryCount: 1,
          nextAttemptAtUtc: due,
          ...extra,
        },
        select: { id: true },
      });
    const prefOff = await row("REVIEW_REQUEST_ASSIGNED", optedOut);
    const accessLost = await row("DISCUSSION_MENTION_RECEIVED", outsider);
    const lifecycle = await row("WORKSPACE_ACCESS_REMOVED", outsider, {
      templateContextJson: { kind: "MembershipLifecycle", data: { workspaceName: "A", roleLabel: null, actionUrl: null } } as never,
    });

    const summary = await notifications.processDueNotificationRetries({ batchSize: 500 });
    expect(summary.cancelled).toBeGreaterThanOrEqual(2);
    const status = (id: string) =>
      prisma.notificationDelivery.findUniqueOrThrow({ where: { id }, select: { status: true, errorCode: true, sentAtUtc: true } });
    expect(await status(prefOff.id)).toMatchObject({ status: "CANCELLED", errorCode: "recipient_preference_off", sentAtUtc: null });
    expect(await status(accessLost.id)).toMatchObject({ status: "CANCELLED", errorCode: "recipient_access_lost", sentAtUtc: null });
    expect((await status(lifecycle.id)).status).not.toBe("CANCELLED");

    const skipped = await prisma.notificationDelivery.create({
      data: {
        teamId: A().teamId,
        eventType: "REVIEW_REQUEST_ASSIGNED",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: optedOut.email,
        recipientUserId: optedOut.userId,
        status: "SKIPPED",
        templateKey: "REVIEW_REQUEST_ASSIGNED",
        errorCode: "recipient_preference_off",
      },
      select: { id: true },
    });
    const resend = await notifications.resendNotificationDelivery({
      id: skipped.id,
      teamId: A().teamId,
      actorUserId: A().ownerUserId,
    });
    expect(resend.outcome).toBe("skipped_terminal");
    expect(await status(skipped.id)).toMatchObject({ status: "SKIPPED", errorCode: "recipient_preference_off" });
  });

  // -------------------------------------------------------------------------
  // B2B-F-07 — not-due groups no longer consume the run cap.
  // -------------------------------------------------------------------------
  it("B2B-F-07 — with maxGroups smaller than the population, due groups are served first and a backlog drains across runs", async () => {
    const users = [] as SeededUser[];
    for (let i = 0; i < 3; i++) users.push(await memberOf(`digest${i}`, [{ teamId: A().teamId, role: "MEMBER" }]));
    // u0 was just sent a digest (not due); its preference row is written first.
    const now = new Date();
    for (const u of users) {
      await prisma.workspaceNotificationPreference.create({
        data: { userId: u.userId, teamId: A().teamId, preferenceType: "MENTION", channel: "EMAIL", enabled: true, frequency: "HOURLY" },
      });
    }
    await prisma.notificationScheduleSetting.create({
      data: { userId: users[0]!.userId, teamId: A().teamId, lastHourlyDigestAt: now },
    });
    const watermark = async (u: SeededUser) =>
      (await prisma.notificationScheduleSetting.findUnique({
        where: { userId_teamId: { userId: u.userId, teamId: A().teamId } },
        select: { lastHourlyDigestAt: true },
      }))?.lastHourlyDigestAt ?? null;

    const first = await digest.runDigestScheduler({ now, maxGroups: 1 });
    const second = await digest.runDigestScheduler({ now, maxGroups: 1 });
    expect(first.skippedNotDue).toBeGreaterThanOrEqual(1);
    expect(first.groupsConsidered).toBe(1);
    expect(second.groupsConsidered).toBe(1);
    // Both due recipients were reached in two runs of one group each.
    expect(await watermark(users[1]!)).toBeInstanceOf(Date);
    expect(await watermark(users[2]!)).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // B8-F-302 — a rate-limited verification email is retried by the sweep.
  // -------------------------------------------------------------------------
  it("B8-F-302 — a 429 on the sign-up verification email is put on the outbox and delivered by the retry sweep", async () => {
    const email = `g5-verify-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "G5", lastName: "Verify", provider: "EMAIL", providerUserId: email, emailVerifiedAt: null },
      select: { id: true },
    });
    const service = emailService.getEmailService();
    const spy = vi
      .spyOn(service, "sendEmailVerificationEmail")
      .mockResolvedValueOnce({ kind: "retryable", errorCode: "rate_limited", httpStatus: 429 } as never)
      .mockResolvedValueOnce({ kind: "acknowledged", providerMessageId: "g5-msg", httpStatus: 200 } as never);
    try {
      const first = await verification.dispatchVerificationEmail({ userId: user.id, toEmail: email });
      expect(first).toMatchObject({ delivered: false, delivery: "failed", retryable: true });
      const outbox = await prisma.notificationDelivery.findFirstOrThrow({
        where: { eventType: verification.VERIFICATION_EMAIL_EVENT, recipientUserId: user.id },
        select: { id: true, status: true, provider: true, metadata: true, templateContextJson: true },
      });
      expect(outbox).toMatchObject({ status: "RETRY_SCHEDULED", provider: "INTERNAL", templateContextJson: null });
      expect(JSON.stringify(outbox.metadata)).not.toMatch(/token/i);
      await prisma.notificationDelivery.update({ where: { id: outbox.id }, data: { nextAttemptAtUtc: new Date(Date.now() - 1000) } });

      const sweep = await call("POST", "/v1/notifications/process-retries", null, {}, {
        "x-cron-secret": process.env.NOTIFICATION_CRON_SECRET ?? "",
      });
      const swept =
        sweep.statusCode === 200 && json(sweep).verificationEmails
          ? json(sweep).verificationEmails
          : await verification.processDueVerificationEmailRetries();
      expect(swept.sent).toBe(1);
      expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: outbox.id }, select: { status: true } })).status).toBe("SENT");
      expect(await prisma.emailVerificationToken.count({ where: { userId: user.id, usedAt: null } })).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // B2A-F-16 (cross-lane completion) — forwarded IP only with the proxy key.
  // -------------------------------------------------------------------------
  it("B2A-F-16 — contact-sales: with the proxy key each forwarded visitor has its own bucket; without it, a rotated X-Forwarded-For cannot pick a bucket", async () => {
    await clearRates();
    const lead = { name: "G5 Lead", email: "lead@example.test", company: "Example", message: "Hello there, a real enquiry." };
    const peer = "192.0.2.50";
    const withKey: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await call("POST", "/v1/contact-sales", null, lead, { "x-forwarded-for": `203.0.113.${i + 10}`, "x-internal-key": FORWARDING_KEY }, peer);
      withKey.push(r.statusCode);
    }
    expect(withKey).not.toContain(429);
    await clearRates();
    const spoofed: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await call("POST", "/v1/contact-sales", null, lead, { "x-forwarded-for": `203.0.113.${i + 100}` }, peer);
      spoofed.push(r.statusCode);
    }
    expect(spoofed.slice(-1)).toEqual([429]);
    await clearRates();
  });

  // -------------------------------------------------------------------------
  // B8-F-401 / B8-F-402 — the derived contract headers are served.
  // -------------------------------------------------------------------------
  it("B8-F-401/402 — every response carries the route epoch and the minimum client contract (additive to x-proovra-contract)", async () => {
    const { PRESENTATION_CONTRACT_ROUTE_EPOCH, PRESENTATION_CONTRACT_MIN_CLIENT, PRESENTATION_CONTRACT_VERSION } = await import("@proovra/shared");
    const res = await call("GET", "/healthz", null);
    expect(res.headers["x-proovra-contract"]).toBe(String(PRESENTATION_CONTRACT_VERSION));
    expect(res.headers["x-proovra-route-epoch"]).toBe(String(PRESENTATION_CONTRACT_ROUTE_EPOCH));
    expect(res.headers["x-proovra-min-client-contract"]).toBe(String(PRESENTATION_CONTRACT_MIN_CLIENT));
  });

  // -------------------------------------------------------------------------
  // B8-F-001 (cross-lane completion) — LAST: it stubs the revocation store once.
  // -------------------------------------------------------------------------
  it("B8-F-001 — a 503 logout_incomplete keeps the session cookie, so the retry still names the session and ends it", async () => {
    const { hashPassword } = await import("../src/services/email-password-auth.service.js");
    const email = `g5-logout-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "G5", lastName: "Logout", provider: "EMAIL", providerUserId: email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
      select: { id: true },
    });
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "g5-fixture",
      })),
    });
    const login = await call("POST", "/v1/auth/email/login", null, { email, password: PASSWORD }, { "x-web-client": "1", origin: WEB_ORIGIN });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = ([] as string[])
      .concat((login.headers["set-cookie"] as string[] | string | undefined) ?? [])
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("proovra_session=") && c.length > "proovra_session=".length)!;
    expect(cookie).toBeTruthy();
    const logout = () =>
      call("POST", "/v1/auth/logout", null, undefined, { cookie, origin: WEB_ORIGIN, "x-web-client": "1" });
    const clearsSession = (r: Res) =>
      ([] as string[]).concat((r.headers["set-cookie"] as string[] | string | undefined) ?? []).some((c) => /^proovra_session=;/.test(c));

    const delegate = prisma.revokedSession;
    const original = delegate.create;
    let outage = true;
    const spy = vi.spyOn(delegate, "create").mockImplementation(((args: never) => {
      if (outage) {
        outage = false;
        return Promise.reject(new Error("simulated revocation store outage"));
      }
      return original.call(delegate, args);
    }) as never);
    const failed = await logout();
    expect(failed.statusCode).toBe(503);
    expect(json(failed)).toEqual({ ok: false, error: { code: "logout_incomplete" } });
    expect(clearsSession(failed)).toBe(false);

    const retried = await logout();
    spy.mockRestore();
    expect(retried.statusCode, retried.body).toBe(200);
    expect(clearsSession(retried)).toBe(true);
    expect(await prisma.revokedSession.count({ where: { userId: user.id } })).toBe(1);
    const me = await call("GET", "/v1/auth/me", null, undefined, { cookie });
    expect(me.statusCode).toBe(401);
  });
});
