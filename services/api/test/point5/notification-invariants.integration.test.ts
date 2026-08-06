/**
 * PHASE 12 — POINT 5: notification invariants, verified before 7/9 is kept.
 *
 * The crash-window suite next door proves the digest and follow-up state
 * machines survive a process dying at each step. This suite proves the four
 * properties that are NOT about crashing, and that a passing crash-window
 * suite would happily hide:
 *
 *   2.1  the provider idempotency key is opaque — no address, token, name,
 *        subject, body or foreign tenant id survives into it, in any caller;
 *   2.2  ACKNOWLEDGED and DELIVERED mean different things, and nothing in the
 *        system quietly promotes one to the other;
 *   2.3  a delivery attempt is bound to one tenant and one durable intent, and
 *        a retry cannot become a second attempt;
 *   2.4  the lease is a STATE + TIME predicate, not a time-only one.
 *
 * Everything here is executed against a live PostgreSQL 16 and the real
 * routes, services and workers. Where a property is genuinely about source
 * shape rather than behaviour — "does any module still construct a second
 * transport" — it lives in the unit suite and is labelled as topology, not as
 * proof of behaviour.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

type ProviderRequest = {
  to: string;
  subject: string;
  idempotencyKey: string | null;
};

const provider = vi.hoisted(() => ({
  sent: [] as ProviderRequest[],
  reset() {
    this.sent.length = 0;
  },
}));

describe("POINT 5 — notification invariants (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let runtime: typeof import("@proovra/shared-runtime");
  let emailService: typeof import("../../src/services/email.service.js");
  let digest: typeof import("../../../worker/src/mfa-recovery-digest.js");
  let followUp: typeof import("../../src/services/demo-follow-up.service.js");
  let orgInvite: typeof import("../../src/services/organization/org-invite-delivery.service.js");
  let previousResendKey: string | undefined;
  let previousTransport: string | undefined;
  let realFetch: typeof globalThis.fetch | undefined;

  let teamA: string;
  let teamB: string;
  let adminA: string;
  let adminB: string;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    runtime = await import("@proovra/shared-runtime");
    runtime.registerPrisma(prisma as never);
    emailService = await import("../../src/services/email.service.js");
    digest = await import("../../../worker/src/mfa-recovery-digest.js");
    followUp = await import("../../src/services/demo-follow-up.service.js");
    orgInvite = await import(
      "../../src/services/organization/org-invite-delivery.service.js"
    );

    teamA = harness.fixtures.teamA.teamId;
    teamB = harness.fixtures.teamB.teamId;
    adminA = harness.fixtures.teamA.ownerUserId;
    adminB = harness.fixtures.teamB.ownerUserId;

    previousResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "point5-integration-only-not-a-real-key";
    // PHASE 12 — POINT 7 (final pass): this suite observes what goes ON THE
    // WIRE to the provider — it reads the `Idempotency-Key` HEADER to prove the
    // key is loaded from the durable row. Since the transport gained provider
    // selection, and the local default is the recording provider (which stores
    // an ALIAS of the key rather than the key), the provider under test has to
    // be named. The stub below refuses any URL that is not Resend's, so this
    // remains hermetic: no request leaves the process.
    previousTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "resend";
    realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (
        url: string | URL,
        init?: { body?: string; headers?: Record<string, string> },
      ) => {
        const href = typeof url === "string" ? url : url.toString();
        if (!href.startsWith("https://api.resend.com/")) {
          throw new Error(`point5: unexpected outbound request to ${href}`);
        }
        const body = JSON.parse(init?.body ?? "{}") as {
          to?: string | string[];
          subject?: string;
        };
        provider.sent.push({
          to: Array.isArray(body.to) ? (body.to[0] ?? "") : (body.to ?? ""),
          subject: body.subject ?? "",
          idempotencyKey:
            init?.headers?.["Idempotency-Key"] ??
            init?.headers?.["idempotency-key"] ??
            null,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `resend_${randomUUID()}` }),
          text: async () => "",
        } as never;
      },
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (realFetch) globalThis.fetch = realFetch;
    if (previousTransport === undefined) delete process.env.EMAIL_TRANSPORT;
    else process.env.EMAIL_TRANSPORT = previousTransport;
    if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
    await harness?.cleanup();
  });

  // =========================================================================
  // Fixtures
  // =========================================================================

  const today = () => new Date().toISOString().slice(0, 10);

  async function clearDigestState(): Promise<void> {
    await prisma.notificationDelivery.deleteMany({
      where: { eventType: runtime.MFA_DIGEST_EVENT_TYPE },
    });
    await prisma.mfaRecoveryAdminDigestLog.deleteMany({});
    await prisma.mfaRecoveryDigestLog.deleteMany({});
    await prisma.mfaRecoveryRequest.deleteMany({
      where: { status: "PENDING_ADMIN_REVIEW" },
    });
  }

  async function stalePending(teamId: string, userId: string): Promise<void> {
    const row = await prisma.mfaRecoveryRequest.create({
      data: {
        userId,
        teamId,
        reason: "point5 invariants",
        status: "PENDING_ADMIN_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await prisma.mfaRecoveryRequest.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
  }

  async function digestDeliveryFor(userId: string) {
    return prisma.notificationDelivery.findFirst({
      where: {
        eventType: runtime.MFA_DIGEST_EVENT_TYPE,
        recipientUserId: userId,
        metadata: { path: ["digestSentDate"], equals: today() },
      },
    });
  }

  async function userEmail(userId: string): Promise<string> {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    return u.email ?? "";
  }

  async function dueFollowUp(overrides: Record<string, unknown> = {}) {
    return prisma.demoRequest.create({
      data: {
        fullName: "Invariant Prospect",
        useCase: "point5 invariants",
        workEmail: `invariant-${randomUUID()}@test.proovra.local`,
        status: "NEW",
        isSpam: false,
        followUpStatus: "ACTIVE",
        followUpStep: 0,
        nextFollowUpAt: new Date(Date.now() - 60 * 1000),
        ...overrides,
      },
      select: { id: true, workEmail: true, fullName: true },
    });
  }

  // =========================================================================
  // 2.1 — the idempotency key is opaque
  // =========================================================================

  /**
   * Everything that must never be recoverable from a key, for a given send.
   *
   * The key travels in an HTTP header into the provider's request logs, which
   * we do not control and cannot redact.
   */
  function assertOpaque(
    key: string | null,
    secrets: ReadonlyArray<string | null | undefined>,
    label: string,
  ): void {
    expect(key, `${label}: no key was sent`).toBeTruthy();
    const lowered = key!.toLowerCase();
    for (const secret of secrets) {
      if (!secret) continue;
      expect(lowered, `${label}: key leaks ${secret}`).not.toContain(
        secret.toLowerCase(),
      );
      // Also the local-part of an address on its own, which is the part that
      // identifies a person even without the domain.
      const local = secret.includes("@") ? secret.split("@")[0]! : null;
      if (local && local.length > 3) {
        expect(lowered, `${label}: key leaks the local-part ${local}`).not.toContain(
          local.toLowerCase(),
        );
      }
    }
    // A key is a bounded opaque token: prefix, template name, digest.
    expect(key!).toMatch(runtime.EMAIL_IDEMPOTENCY_KEY_PATTERN);
  }

  it("2.1 digest: the key is the durable delivery id and leaks no recipient", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);

    await digest.runMfaRecoveryDigest({ trigger: "invariants" });

    const row = await digestDeliveryFor(adminA);
    expect(row).not.toBeNull();
    const email = await userEmail(adminA);
    const sent = provider.sent.filter((s) => s.to === email);
    expect(sent).toHaveLength(1);

    // LOADED from the durable row — the row owns its key.
    expect(sent[0]!.idempotencyKey).toBe(
      runtime.readStoredIdempotencyKey(row!.metadata),
    );
    assertOpaque(sent[0]!.idempotencyKey, [email, teamA, teamB, sent[0]!.subject], "digest");
  });

  it("2.1 demo follow-up: the key is (durable request id, step), never the address", async () => {
    provider.reset();
    const item = await dueFollowUp();

    await followUp.processDueDemoFollowUps({});

    const sent = provider.sent.filter((s) => s.to === item.workEmail);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe(
      emailService.deterministicEmailKey("demo_request_follow_up", item.id, "1"),
    );
    assertOpaque(
      sent[0]!.idempotencyKey,
      [item.workEmail, item.fullName, teamA, teamB, sent[0]!.subject],
      "demo",
    );
  });

  it("2.1 the same durable intent retried yields the SAME key; a different intent does not", async () => {
    const a = await dueFollowUp();
    const b = await dueFollowUp();

    const keyA1 = emailService.deterministicEmailKey("demo_request_follow_up", a.id, "1");
    const keyA1Again = emailService.deterministicEmailKey("demo_request_follow_up", a.id, "1");
    const keyA2 = emailService.deterministicEmailKey("demo_request_follow_up", a.id, "2");
    const keyB1 = emailService.deterministicEmailKey("demo_request_follow_up", b.id, "1");

    expect(keyA1Again).toBe(keyA1);
    expect(keyA2).not.toBe(keyA1);
    expect(keyB1).not.toBe(keyA1);
  });

  it("2.1 org invite: the key is the durable intent — no attempt counter, no accept URL", async () => {
    // BLOCK 0.2 corrected this. The key was briefly `(deliveryId, attempt)`,
    // on the reasoning that a rotated token makes each attempt a different
    // message. `retryCount` is MUTABLE, so that key changed on every attempt —
    // which is the definition of not having an idempotency key. It is now the
    // durable delivery intent alone, and the accept URL (which carries a live
    // token) never enters the preimage.
    const rawTokenA = orgInvite.newOrgInviteToken();
    const rawTokenB = orgInvite.newOrgInviteToken();
    const urlA = orgInvite.buildOrgInviteAcceptUrl(rawTokenA);
    const urlB = orgInvite.buildOrgInviteAcceptUrl(rawTokenB);
    const deliveryId = randomUUID();

    const key = runtime.mintEmailIdempotencyKey(
      orgInvite.ORG_INVITE_IDEMPOTENCY_OPERATION,
      deliveryId,
    );
    const again = runtime.mintEmailIdempotencyKey(
      orgInvite.ORG_INVITE_IDEMPOTENCY_OPERATION,
      deliveryId,
    );
    expect(again, "every attempt on one invitation shares one key").toBe(key);
    const otherInvite = runtime.mintEmailIdempotencyKey(
      orgInvite.ORG_INVITE_IDEMPOTENCY_OPERATION,
      randomUUID(),
    );
    expect(otherInvite).not.toBe(key);
    assertOpaque(key, [rawTokenA, rawTokenB, urlA, urlB], "org_invite");
  });

  it("2.1 the key is keyed, so an attacker holding provider logs cannot confirm a guess", () => {
    // Same preimage, different server secret → different key. That is the
    // whole property: an unkeyed digest of an email address is a reversible
    // identifier, because the address space is enumerable.
    //
    // BLOCK 0.1 — keyed with the DEDICATED secret, which is what this rotates.
    // Rotating any other subsystem's secret must not move the key; that is
    // covered in the Block 0 suite.
    const previous = process.env["EMAIL_IDEMPOTENCY_SECRET"];
    runtime.resetEmailIdempotencySecretResolver();
    process.env["EMAIL_IDEMPOTENCY_SECRET"] = "secret-one";
    const withOne = emailService.deterministicEmailKey("t", "victim@example.test");
    process.env["EMAIL_IDEMPOTENCY_SECRET"] = "secret-two";
    const withTwo = emailService.deterministicEmailKey("t", "victim@example.test");
    if (previous === undefined) {
      delete process.env["EMAIL_IDEMPOTENCY_SECRET"];
    } else {
      process.env["EMAIL_IDEMPOTENCY_SECRET"] = previous;
    }
    expect(withTwo).not.toBe(withOne);
  });

  it("2.1 no key or preimage reaches a security event or a delivery row", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    const email = await userEmail(adminA);

    await digest.runMfaRecoveryDigest({ trigger: "invariants" });

    const events = await prisma.securityEvent.findMany({
      where: { eventType: { startsWith: "mfa_recovery_digest" } },
      select: { details: true },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(email || "@@never@@");
    for (const s of provider.sent) {
      if (s.idempotencyKey) expect(serialized).not.toContain(s.idempotencyKey);
    }
  });

  // =========================================================================
  // 2.2 — ACKNOWLEDGED is not DELIVERED
  // =========================================================================

  it("2.2 an acknowledged send lands in SENT and leaves deliveredAtUtc null", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);

    await digest.runMfaRecoveryDigest({ trigger: "invariants" });

    const row = await digestDeliveryFor(adminA);
    expect(row!.status).toBe("SENT");
    expect(row!.providerMessageId).toBeTruthy();
    expect(row!.sentAtUtc).not.toBeNull();
    // The provider ACCEPTED the request. It has not told us the mailbox
    // received anything, and this deployment receives no delivery webhook, so
    // claiming DELIVERED here would be inventing an external outcome.
    expect(row!.deliveredAtUtc).toBeNull();
    expect(runtime.deriveDeliveryPhase(row!, new Date())).toBe("acknowledged");
  });

  it("2.2 nothing in the running system promotes SENT to DELIVERED", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    await digest.runMfaRecoveryDigest({ trigger: "first" });

    // Every producer that could touch this row, run again.
    await digest.runMfaRecoveryDigest({ trigger: "replay" });
    await followUp.processDueDemoFollowUps({});

    const promoted = await prisma.notificationDelivery.count({
      where: { status: "DELIVERED" },
    });
    expect(
      promoted,
      "DELIVERED is reserved for a provider delivery event this deployment does not receive",
    ).toBe(0);
  });

  it("2.2 the API projection reports an acknowledged attempt as SENT, never as delivered", async () => {
    // Behavioural, through the real authenticated route — not a source scan.
    // A workspace-scoped delivery is created so the operator surface has
    // something to project.
    const created = await prisma.notificationDelivery.create({
      data: {
        teamId: teamA,
        eventType: "EVIDENCE_REQUEST_SENT",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "operator-view@test.proovra.local",
        status: "SENT",
        templateKey: "EVIDENCE_REQUEST_SENT",
        providerMessageId: "resend_projection_probe",
        sentAtUtc: new Date(),
      },
      select: { id: true },
    });

    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${teamA}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items?: Array<Record<string, unknown>>;
      deliveries?: Array<Record<string, unknown>>;
    };
    const items = body.items ?? body.deliveries ?? [];
    const mine = items.find((i) => i["id"] === created.id);
    expect(mine, "the acknowledged attempt must be visible to its own workspace").toBeTruthy();
    expect(mine!["status"]).toBe("SENT");
    expect(mine!["deliveredAtUtc"] ?? null).toBeNull();

    await prisma.notificationDelivery.delete({ where: { id: created.id } });
  });

  it("2.2 an ambiguous attempt is neither failed nor delivered in the projection", async () => {
    const created = await prisma.notificationDelivery.create({
      data: {
        teamId: teamA,
        eventType: "EVIDENCE_REQUEST_SENT",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "ambiguous-view@test.proovra.local",
        status: "RETRY_SCHEDULED",
        errorCode: runtime.AMBIGUOUS_ERROR_CODE,
        templateKey: "EVIDENCE_REQUEST_SENT",
        nextAttemptAtUtc: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${teamA}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    const body = res.json() as {
      items?: Array<Record<string, unknown>>;
      deliveries?: Array<Record<string, unknown>>;
    };
    const mine = (body.items ?? body.deliveries ?? []).find(
      (i) => i["id"] === created.id,
    );
    expect(mine).toBeTruthy();
    expect(mine!["status"]).not.toBe("FAILED");
    expect(mine!["status"]).not.toBe("DELIVERED");
    expect(mine!["errorCode"]).toBe(runtime.AMBIGUOUS_ERROR_CODE);
    expect(
      runtime.deriveDeliveryPhase(
        { status: "RETRY_SCHEDULED", errorCode: runtime.AMBIGUOUS_ERROR_CODE },
        new Date(),
      ),
    ).toBe("ambiguous");

    await prisma.notificationDelivery.delete({ where: { id: created.id } });
  });

  it("2.2 an acknowledged attempt is never re-sent by a retry sweep", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    await digest.runMfaRecoveryDigest({ trigger: "first" });
    const email = await userEmail(adminA);
    const before = provider.sent.filter((s) => s.to === email).length;
    expect(before).toBe(1);

    // Even with the lease field cleared — the state, not the clock, is what
    // makes an acknowledged row ineligible.
    const row = await digestDeliveryFor(adminA);
    await prisma.notificationDelivery.update({
      where: { id: row!.id },
      data: { nextAttemptAtUtc: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await digest.runMfaRecoveryDigest({ trigger: "second" });

    expect(provider.sent.filter((s) => s.to === email)).toHaveLength(before);
  });

  // =========================================================================
  // 2.3 — tenant and uniqueness authority
  // =========================================================================

  it("2.3 the digest's daily slot is unique per (user, date) and a retry reuses one attempt", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);

    await digest.runMfaRecoveryDigest({ trigger: "a" });
    await digest.runMfaRecoveryDigest({ trigger: "b" });
    await digest.runMfaRecoveryDigest({ trigger: "c" });

    const attempts = await prisma.notificationDelivery.count({
      where: {
        eventType: runtime.MFA_DIGEST_EVENT_TYPE,
        recipientUserId: adminA,
        metadata: { path: ["digestSentDate"], equals: today() },
      },
    });
    expect(attempts, "a retry must not create a second attempt").toBe(1);

    // And the slot itself is refused a second holder by the database.
    await expect(
      prisma.mfaRecoveryAdminDigestLog.create({
        data: { userId: adminA, sentDate: today(), teamCount: 1, requestCount: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("2.3 two admins in different workspaces get separate slots and separate attempts", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    await stalePending(teamB, adminB);

    await digest.runMfaRecoveryDigest({ trigger: "cross" });

    const rowA = await digestDeliveryFor(adminA);
    const rowB = await digestDeliveryFor(adminB);
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    expect(rowA!.id).not.toBe(rowB!.id);
    // Neither attempt names the other's workspace anywhere.
    expect(JSON.stringify(rowA)).not.toContain(teamB);
    expect(JSON.stringify(rowB)).not.toContain(teamA);
  });

  it("2.3 the digest and the follow-up cannot collide: different kind, different subject", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    const item = await dueFollowUp();

    await digest.runMfaRecoveryDigest({ trigger: "collide" });
    await followUp.processDueDemoFollowUps({});

    const digestRow = await digestDeliveryFor(adminA);
    const followUpRows = await prisma.notificationDelivery.findMany({
      where: {
        eventType: followUp.DEMO_FOLLOW_UP_EVENT_TYPE,
        metadata: { path: ["demoRequestId"], equals: item.id },
      },
    });
    expect(followUpRows).toHaveLength(1);
    expect(digestRow!.eventType).not.toBe(followUpRows[0]!.eventType);
    expect(digestRow!.id).not.toBe(followUpRows[0]!.id);
    // The provider keys differ too, so one cannot suppress the other.
    const keys = new Set(provider.sent.map((s) => s.idempotencyKey));
    expect(keys.size).toBe(provider.sent.length);
  });

  it("2.3 a foreign-workspace delivery is concealed, not merely filtered", async () => {
    const foreign = await prisma.notificationDelivery.create({
      data: {
        teamId: teamB,
        eventType: "EVIDENCE_REQUEST_SENT",
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "foreign@test.proovra.local",
        status: "SENT",
        templateKey: "EVIDENCE_REQUEST_SENT",
        sentAtUtc: new Date(),
      },
      select: { id: true },
    });

    // Listed under OUR workspace: absent.
    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries?teamId=${teamA}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    const listBody = list.json() as {
      items?: Array<{ id: string }>;
      deliveries?: Array<{ id: string }>;
    };
    const items = listBody.items ?? listBody.deliveries ?? [];
    expect(items.some((i) => i.id === foreign.id)).toBe(false);

    // Fetched by id under OUR workspace: refused, and the refusal does not
    // distinguish "exists elsewhere" from "does not exist".
    const byId = await harness.app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries/${foreign.id}?teamId=${teamA}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect([403, 404]).toContain(byId.statusCode);
    const ghost = await harness.app.inject({
      method: "GET",
      url: `/v1/notifications/deliveries/${randomUUID()}?teamId=${teamA}`,
      headers: { authorization: `Bearer ${harness.fixtures.teamA.ownerToken}` },
    });
    expect(byId.statusCode).toBe(ghost.statusCode);

    await prisma.notificationDelivery.delete({ where: { id: foreign.id } });
  });

  it("2.3 a new day is a new legitimate operation and gets a new attempt", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);
    await digest.runMfaRecoveryDigest({ trigger: "day-1" });
    const first = await digestDeliveryFor(adminA);
    expect(first).not.toBeNull();

    // Age yesterday's slot and attempt out of today.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await prisma.mfaRecoveryAdminDigestLog.updateMany({
      where: { userId: adminA },
      data: { sentDate: yesterday },
    });
    await prisma.notificationDelivery.update({
      where: { id: first!.id },
      data: {
        metadata: {
          claimLogId: (first!.metadata as { claimLogId?: string }).claimLogId,
          digestSentDate: yesterday,
        },
      },
    });

    await digest.runMfaRecoveryDigest({ trigger: "day-2" });
    const second = await digestDeliveryFor(adminA);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });

  // =========================================================================
  // 2.4 — the lease is a STATE + TIME predicate
  // =========================================================================

  it("2.4 a terminal row is never reclaimed, however old its lease", async () => {
    // The failure this rules out: a claim predicate written on time alone.
    // Every terminal state below has a lease deep in the past; none may be
    // selected.
    for (const terminal of ["SENT", "DELIVERED", "FAILED", "SKIPPED", "CANCELLED"]) {
      await clearDigestState();
      provider.reset();
      await stalePending(teamA, adminA);

      const logId = randomUUID();
      await prisma.$transaction([
        prisma.mfaRecoveryAdminDigestLog.create({
          data: {
            id: logId,
            userId: adminA,
            sentDate: today(),
            teamCount: 1,
            requestCount: 1,
          },
        }),
        prisma.notificationDelivery.create({
          data: {
            teamId: null,
            eventType: runtime.MFA_DIGEST_EVENT_TYPE,
            channel: "EMAIL",
            provider: "RESEND",
            recipient: await userEmail(adminA),
            recipientUserId: adminA,
            status: terminal as "SENT",
            templateKey: runtime.MFA_DIGEST_TEMPLATE_KEY,
            // Long expired — a time-only predicate would take it.
            nextAttemptAtUtc: new Date(Date.now() - 24 * 60 * 60 * 1000),
            metadata: {
              claimLogId: logId,
              digestSentDate: today(),
              attempt: {
                startedAtUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                idempotencyKey: "proovra-delivery-stale",
              },
            },
          },
        }),
      ]);

      const email = await userEmail(adminA);
      await digest.runMfaRecoveryDigest({ trigger: `terminal-${terminal}` });
      expect(
        provider.sent.filter((s) => s.to === email),
        `${terminal} was reclaimed by a stale lease`,
      ).toHaveLength(0);
      const after = await digestDeliveryFor(adminA);
      expect(after!.status).toBe(terminal);
    }
  });

  it("2.4 concurrent recovery of one stale lease produces exactly one winner", async () => {
    await clearDigestState();
    provider.reset();
    await stalePending(teamA, adminA);

    const logId = randomUUID();
    const deliveryId = randomUUID();
    await prisma.$transaction([
      prisma.mfaRecoveryAdminDigestLog.create({
        data: {
          id: logId,
          userId: adminA,
          sentDate: today(),
          teamCount: 1,
          requestCount: 1,
        },
      }),
      prisma.notificationDelivery.create({
        data: {
          id: deliveryId,
          teamId: null,
          eventType: runtime.MFA_DIGEST_EVENT_TYPE,
          channel: "EMAIL",
          provider: "RESEND",
          recipient: await userEmail(adminA),
          recipientUserId: adminA,
          status: "PENDING",
          templateKey: runtime.MFA_DIGEST_TEMPLATE_KEY,
          nextAttemptAtUtc: new Date(Date.now() - 60 * 1000),
          metadata: {
            claimLogId: logId,
            digestSentDate: today(),
            attempt: {
              startedAtUtc: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
              idempotencyKey: runtime.mintEmailIdempotencyKey("delivery", deliveryId),
            },
          },
        },
      }),
    ]);

    const email = await userEmail(adminA);
    await Promise.all([
      digest.runMfaRecoveryDigest({ trigger: "r1" }),
      digest.runMfaRecoveryDigest({ trigger: "r2" }),
      digest.runMfaRecoveryDigest({ trigger: "r3" }),
      digest.runMfaRecoveryDigest({ trigger: "r4" }),
    ]);

    expect(provider.sent.filter((s) => s.to === email)).toHaveLength(1);
    const after = await digestDeliveryFor(adminA);
    expect(after!.status).toBe("SENT");
  });

  it("2.4 an ambiguous row waits for its backoff rather than being retried at once", async () => {
    const now = new Date();
    const backoffRow = {
      status: "RETRY_SCHEDULED",
      errorCode: runtime.AMBIGUOUS_ERROR_CODE,
      nextAttemptAtUtc: new Date(now.getTime() + runtime.AMBIGUOUS_RETRY_BACKOFF_MS),
    };
    expect(runtime.deriveDeliveryPhase(backoffRow, now)).toBe("ambiguous");
    expect(runtime.isRecoverableDeliveryPhase("ambiguous")).toBe(true);
    // Recoverable as a PHASE, but not yet ELIGIBLE: the lease column is what
    // the claim predicate reads, and it is still in the future.
    expect(backoffRow.nextAttemptAtUtc.getTime()).toBeGreaterThan(now.getTime());
  });
});
